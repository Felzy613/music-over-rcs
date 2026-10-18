import { randomBytes } from 'node:crypto';
import { s3FromEnv, type S3 } from './s3.ts';

// Getting a YouTube Music song by way of Cloudflare. YouTube asks the cloud host's datacenter address to "confirm you're
// not a bot" before it hands out a song's audio, but answers Cloudflare's network. The host can't call the Worker (every
// automated client is challenged on workers.dev), so the request goes through the bucket: this leaves yt/req/<key>.json,
// the Worker (told by R2 through the mors-yt queue; cloudflare/youtube.ts) downloads the song into yt/audio/<key> and
// leaves the outcome in yt/res/<key>.json, and this collects the audio and cleans up. Search, albums and the whitelist
// stay on the host; only the audio comes this way.

export interface RelayedAudio {
  data: Uint8Array;
  /** "audio/mp4" */
  type: string;
  bytes: number;
}

/**
 * Gets one song's audio by its YouTube video id. Rejects with a message fit to show the user, in lower case so it reads
 * after a colon; when YouTube's bot check met Cloudflare too (twice), the error carries `turnedAway: true`.
 */
export type YouTubeRelay = (videoId: string, options?: { maxBytes?: number }) => Promise<RelayedAudio>;

export interface YouTubeRelayOptions {
  /** How long to wait for the Worker's answer before giving up (default 90 s). */
  timeoutMs?: number;
  /** How soon to look for it first (default 750 ms); each later look waits half as long again, up to 3 s. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const REQUESTS = 'yt/req/';
const RESULTS = 'yt/res/';
const AUDIO = 'yt/audio/';

/** The Worker's answer when YouTube turned Cloudflare's address away too (now and then it does): worth one more try. */
class TurnedAway extends Error {}

export function createYouTubeRelay(bucket: Pick<S3, 'put' | 'get' | 'getBytes' | 'delete'>, options: YouTubeRelayOptions = {}): YouTubeRelay {
  const timeout = options.timeoutMs ?? 90_000;
  const pollMs = options.pollMs ?? 750;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const once = async (videoId: string, maxBytes: number | undefined): Promise<RelayedAudio> => {
    if (!/^[\w-]{11}$/.test(videoId)) throw new Error("that isn't a YouTube song");
    const name = `${videoId}-${randomBytes(4).toString('hex')}`;
    const keys = { request: `${REQUESTS}${name}.json`, result: `${RESULTS}${name}.json`, audio: `${AUDIO}${name}` };
    const started = now();
    let wait = pollMs;
    try {
      await bucket.put(keys.request, JSON.stringify({ videoId, ...(maxBytes !== undefined ? { maxBytes } : {}) }));
      for (;;) {
        const found = await bucket.get(keys.result);
        if (found) {
          let result: { ok?: unknown; type?: unknown; bytes?: unknown; error?: unknown; turnedAway?: unknown };
          try {
            result = JSON.parse(found.text) as typeof result;
          } catch {
            throw new Error('the Cloudflare side of YouTube Music sent an answer I could not read');
          }
          if (result.ok !== true) {
            const why = typeof result.error === 'string' && result.error ? result.error : 'YouTube Music would not give the song';
            throw result.turnedAway === true ? new TurnedAway(why) : new Error(why);
          }
          const audio = await bucket.getBytes(keys.audio);
          if (!audio) throw new Error('the song went missing on its way from YouTube Music');
          options.log?.(`YouTube Music: ${videoId} came by way of Cloudflare in ${((now() - started) / 1000).toFixed(1)} s (${audio.data.length} bytes)`);
          return { data: audio.data, type: typeof result.type === 'string' && result.type ? result.type : 'audio/mp4', bytes: audio.data.length };
        }
        if (now() - started >= timeout) throw new Error(`the relay gave no answer within ${Math.round(timeout / 1000)} seconds`);
        await sleep(wait);
        // An album's songs come one after another, so a slow answer is looked for less often (fewer reads of the bucket).
        wait = Math.min(Math.max(pollMs, 3000), Math.round(wait * 1.5));
      }
    } finally {
      // Whatever happened, nothing of this request stays in the bucket (the Worker sweeps anything missed after an hour).
      await Promise.all(Object.values(keys).map((key) => bucket.delete(key).catch(() => {})));
    }
  };
  return async (videoId, { maxBytes } = {}) => {
    try {
      return await once(videoId, maxBytes);
    } catch (err) {
      if (!(err instanceof TurnedAway)) throw err;
      // Cloudflare's addresses are usually let through; another request is often answered from another one.
      options.log?.(`YouTube Music turned Cloudflare away for ${videoId} once (${err.message}); asking again`);
      try {
        return await once(videoId, maxBytes);
      } catch (again) {
        // Marked, so the host leaves YouTube songs aside for a while and searches music-table.com instead.
        throw again instanceof TurnedAway ? Object.assign(new Error(again.message), { turnedAway: true as const }) : again;
      }
    }
  };
}

/**
 * The relay when YOUTUBE_RELAY=r2 and the bucket is set up (the R2_* settings), otherwise nothing. The cloud host turns
 * it on for its bot, since YouTube turns that host's address away.
 */
export function youTubeRelayFromEnv(env: NodeJS.ProcessEnv, options: YouTubeRelayOptions = {}): YouTubeRelay | undefined {
  if (!/^r2$/i.test(env.YOUTUBE_RELAY?.trim() ?? '')) return undefined;
  const bucket = s3FromEnv(env);
  return bucket ? createYouTubeRelay(bucket, options) : undefined;
}
