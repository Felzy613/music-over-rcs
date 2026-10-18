// YouTube Music asks a datacenter address like the cloud host's to "confirm you're not a bot" before it hands out a song's
// audio, but answers Cloudflare's own network normally (tried 2026-10-16: four songs, all whole). So the host gets a song
// through the bucket: it leaves yt/req/<key>.json; R2 tells this Worker (an event notification on that prefix, delivered
// through the mors-yt queue); the Worker asks YouTube Music's player for the song the way the bot does, downloads the
// audio into yt/audio/<key>, and leaves the outcome in yt/res/<key>.json for the host to read and clean up. Search,
// albums and Zemer's artist list stay on the host: only the song's audio comes this way.

/** Where requests, results and audio live in the bucket. */
export const RELAY_REQUESTS = 'yt/req/';
export const RELAY_RESULTS = 'yt/res/';
export const RELAY_AUDIO = 'yt/audio/';
/** Anything of the relay's older than this is removed by the five-minute job (the host normally cleans up at once). */
export const RELAY_MAX_AGE_MS = 60 * 60_000;

export interface RelayRequest {
  videoId: string;
  /** The largest file the host will take; a bigger one is refused before it is downloaded. */
  maxBytes?: number;
}

export type RelayResult = { ok: true; type: string; bytes: number } | { ok: false; error: string; turnedAway?: true };

/** The part of the R2 binding the relay uses. */
export interface RelayBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string | ReadableStream | ArrayBuffer): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit?: number }): Promise<{ objects: Array<{ key: string; uploaded?: Date }> }>;
}

const ORIGIN = 'https://music.youtube.com';
const API = `${ORIGIN}/youtubei/v1/`;

interface Client {
  name: string;
  version: string;
  id: string;
  userAgent: string;
  os?: { osName: string; osVersion: string; deviceMake: string; deviceModel: string };
}

/** Only for the anonymous session id the player wants. Kept in step with src/sources/youtube-music.ts. */
const WEB_REMIX: Client = {
  name: 'WEB_REMIX',
  version: '1.20260707.12.00',
  id: '67',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
};

const visionOs = (version: string): Client => ({
  name: 'VISIONOS',
  version,
  id: '101',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  os: { osName: 'visionOS', osVersion: '26.5.23O471', deviceMake: 'Apple', deviceModel: 'RealityDevice17,1' },
});

/** In the order Zemer (and the bot) try them. */
const STREAM_CLIENTS = ['1.02', '1.03', '1.01'].map(visionOs);

const VIDEO_ID = /^[\w-]{11}$/;

async function post(doFetch: typeof fetch, endpoint: string, client: Client, body: Record<string, unknown>, visitor?: string): Promise<unknown> {
  const context = { client: { clientName: client.name, clientVersion: client.version, hl: 'en', gl: 'US', ...(client.os ?? {}), ...(visitor ? { visitorData: visitor } : {}) } };
  const res = await doFetch(`${API}${endpoint}?prettyPrint=false`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Format-Version': '1',
      'X-YouTube-Client-Name': client.id,
      'X-YouTube-Client-Version': client.version,
      'X-Origin': ORIGIN,
      Referer: `${ORIGIN}/`,
      'User-Agent': client.userAgent,
      ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}),
    },
    body: JSON.stringify({ context, ...body }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`YouTube Music answered HTTP ${res.status}`);
  }
  return res.json();
}

/** The anonymous session id the player wants (without one it always asks to sign in). */
async function visitorId(doFetch: typeof fetch): Promise<string> {
  const response = (await post(doFetch, 'visitor_id', WEB_REMIX, {})) as { responseContext?: { visitorData?: unknown } };
  const raw = typeof response?.responseContext?.visitorData === 'string' ? response.responseContext.visitorData : '';
  if (!raw) throw new Error("YouTube Music didn't start a session");
  return /%[0-9A-Fa-f]{2}/.test(raw) ? decodeURIComponent(raw) : raw;
}

interface Format {
  url?: string;
  mimeType?: string;
  itag?: number;
  bitrate?: number;
  contentLength?: string;
  audioTrack?: { isAutoDubbed?: boolean };
}

/** The song's AAC audio (itag 140 when there is one, otherwise the best AAC), never an automatically dubbed track. */
function pickAudio(formats: Format[]): Format | undefined {
  const aac = formats.filter((f) => typeof f.url === 'string' && String(f.mimeType).startsWith('audio/mp4') && !f.audioTrack?.isAutoDubbed);
  return aac.find((f) => f.itag === 140) ?? aac.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
}

/** Streams a download into the bucket when its length is known (the Workers runtime needs that), otherwise reads it whole first. */
function storable(res: Response, length: number): ReadableStream | Promise<ArrayBuffer> {
  const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  return Fixed && res.body && length > 0 ? res.body.pipeThrough(new Fixed(length)) : res.arrayBuffer();
}

/**
 * Gets one song's audio from YouTube Music into the bucket at `audioKey`, the way the bot would on a friendlier network:
 * a session, then the player as each VISIONOS client in turn, then the audio. A link that refuses the whole song (about one
 * in fifteen will only serve its first megabyte or two) is dropped for the next client's, and after a round of refusals
 * once more with a new session. A song over `maxBytes` is refused before anything is downloaded.
 */
export async function relaySong(request: RelayRequest, deps: { fetch: typeof fetch; bucket: Pick<RelayBucket, 'put'>; audioKey: string }): Promise<RelayResult> {
  if (!VIDEO_ID.test(request.videoId)) return { ok: false, error: "that isn't a YouTube song" };
  // Called on its own, never as `deps.fetch(…)`: the Workers runtime refuses a fetch called with another object as `this`.
  const doFetch = deps.fetch;
  let problem = 'no client gave a link';
  let turnedAway = false;
  for (let round = 0; round < 2; round += 1) {
    const visitor = await visitorId(doFetch);
    let refused = false;
    for (const client of STREAM_CLIENTS) {
      const answer = (await post(doFetch, 'player', client, { videoId: request.videoId, contentCheckOk: true, racyCheckOk: true }, visitor)) as {
        playabilityStatus?: { status?: string; reason?: string };
        streamingData?: { adaptiveFormats?: Format[] };
      };
      const status = answer?.playabilityStatus?.status;
      if (status !== 'OK') {
        problem = answer?.playabilityStatus?.reason || status || 'no reason given';
        if (/not a bot/i.test(problem)) turnedAway = true;
        continue;
      }
      const format = pickAudio(answer.streamingData?.adaptiveFormats ?? []);
      if (!format?.url) {
        problem = 'YouTube Music gave no audio for it';
        continue;
      }
      const length = Number(format.contentLength) || 0;
      if (request.maxBytes !== undefined && length > request.maxBytes) {
        return { ok: false, error: `it is too big to send (${(length / 1_048_576).toFixed(1)} MB, the limit is ${(request.maxBytes / 1_048_576).toFixed(0)} MB)` };
      }
      const res = await doFetch(format.url, { headers: { 'User-Agent': client.userAgent, Range: 'bytes=0-' } });
      if (res.status === 403 || res.status === 410) {
        await res.body?.cancel().catch(() => {});
        problem = `YouTube refused the song's link (HTTP ${res.status})`;
        refused = true;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        problem = `YouTube answered HTTP ${res.status} for the song`;
        continue;
      }
      const type = (res.headers.get('content-type') ?? 'audio/mp4').split(';')[0]!.trim();
      const size = Number(res.headers.get('content-length')) || length;
      if (request.maxBytes !== undefined && size > request.maxBytes) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, error: `it is too big to send (${(size / 1_048_576).toFixed(1)} MB, the limit is ${(request.maxBytes / 1_048_576).toFixed(0)} MB)` };
      }
      await deps.bucket.put(deps.audioKey, await storable(res, size));
      return { ok: true, type, bytes: size };
    }
    // A new session only helps with refused links; a bot check or a missing song won't change with one.
    if (!refused) break;
  }
  return turnedAway ? { ok: false, error: problem, turnedAway: true } : { ok: false, error: problem };
}

/** The part of a key after its folder, without .json: what ties a request, its result and its audio together. */
const nameOf = (key: string): string => key.slice(RELAY_REQUESTS.length).replace(/\.json$/, '');

/**
 * Answers one request the host left in yt/req/: reads it, removes it, gets the song, and leaves the outcome in yt/res/.
 * Never throws; whatever goes wrong becomes the outcome, so the host is never left waiting on a failure.
 */
export async function handleRelayRequest(key: string, deps: { bucket: RelayBucket; fetch: typeof fetch; log?: (line: string) => void }): Promise<RelayResult | undefined> {
  if (!key.startsWith(RELAY_REQUESTS) || !key.endsWith('.json')) return undefined;
  const name = nameOf(key);
  if (!/^[\w-]{1,80}$/.test(name)) return undefined;
  const object = await deps.bucket.get(key);
  if (!object) return undefined; // answered already (a repeated notification)
  let result: RelayResult;
  try {
    const request = JSON.parse(await object.text()) as Partial<RelayRequest>;
    await deps.bucket.delete(key);
    result = await relaySong(
      { videoId: String(request.videoId ?? ''), ...(typeof request.maxBytes === 'number' && request.maxBytes > 0 ? { maxBytes: request.maxBytes } : {}) },
      { fetch: deps.fetch, bucket: deps.bucket, audioKey: `${RELAY_AUDIO}${name}` },
    );
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!result.ok) deps.log?.(`YouTube relay: ${name}: ${result.error}`);
  await deps.bucket.put(`${RELAY_RESULTS}${name}.json`, JSON.stringify(result));
  return result;
}

/** Removes what the relay left behind for over an hour (a host that stopped waiting, say). Returns how many. */
export async function sweepRelay(bucket: Pick<RelayBucket, 'list' | 'delete'>, now: number = Date.now()): Promise<number> {
  let removed = 0;
  for (const prefix of [RELAY_REQUESTS, RELAY_RESULTS, RELAY_AUDIO]) {
    const { objects } = await bucket.list({ prefix, limit: 500 });
    for (const object of objects) {
      if (object.uploaded && now - object.uploaded.getTime() > RELAY_MAX_AGE_MS) {
        await bucket.delete(object.key);
        removed += 1;
      }
    }
  }
  return removed;
}
