import { tooBig, type AudioCheck } from '../audio-check.ts';
import { AudioFetchError, fetchAudio, type DownloadedAudio } from '../audio-fetch.ts';
import { SourceError, type TrackSource } from '../bot.ts';
import type { NewTrack } from '../catalog.ts';
import { parseQuery } from '../query.ts';
import type { Track } from '../types.ts';
import type { Verdict, ZemerWhitelist } from './zemer-whitelist.ts';

// YouTube Music through its InnerTube API, the way the Zemer app does it (github.com/ZemerTeam/zemer-app, itself built
// on Metrolist). Search is WEB_REMIX's `search` with the songs filter. Playing is `player` as the VISIONOS client, which
// is the first fallback Zemer tries (YTPlayerUtils.kt): its audio links come ready to use, with no signature to solve
// and no PoToken to mint. Zemer's other stream paths (WEB_REMIX, WEB_CREATOR, TVHTML5_SIMPLY) need a JavaScript player
// to decipher links and a BotGuard PoToken to get past the first megabyte, so they are not ported here.
//
// The client versions below are the ones Zemer lists. YouTube retires them one at a time (visionOS 0.1 went on
// 2026-10-07 while 1.02 kept working), so when every one of them is refused, look at `VISIONOS` in Zemer's
// innertube/.../models/YouTubeClient.kt for the current ones.
//
// A song is stored in the catalog as `https://music.youtube.com/watch?v=<id>`, never as a stream link: those expire
// and are tied to this connection, so a fresh one is asked for each time a song is checked or sent.

export const YOUTUBE_MUSIC_URL = 'https://music.youtube.com';

const API_PATH = '/youtubei/v1/';
/** Zemer's SearchFilter.FILTER_SONG: only songs, not videos, albums or playlists. */
const SONG_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
const VIDEO_ID = /^[\w-]{11}$/;
/** Where YouTube serves its media from. A link anywhere else is refused. */
const MEDIA_HOSTS = ['googlevideo.com'];
const MAX_STREAMS_KEPT = 100;
const SEPARATOR = ' • ';

interface InnerTubeClient {
  name: string;
  version: string;
  /** The number the X-YouTube-Client-Name header carries (not the name). */
  id: string;
  userAgent: string;
  os?: { name: string; version: string; make: string; model: string };
}

const WEB_REMIX: InnerTubeClient = {
  name: 'WEB_REMIX',
  version: '1.20260707.12.00',
  id: '67',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
};

const visionOs = (version: string): InnerTubeClient => ({
  name: 'VISIONOS',
  version,
  id: '101',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  os: { name: 'visionOS', version: '26.5.23O471', make: 'Apple', model: 'RealityDevice17,1' },
});

/** In the order Zemer tries them. */
const STREAM_CLIENTS = ['1.02', '1.03', '1.01'].map(visionOs);

/** A problem whose message is fit to show to the user. */
export class YouTubeMusicError extends SourceError {
  constructor(message: string) {
    super(message);
    this.name = 'YouTubeMusicError';
  }
}

/** A song in a search's results. */
export interface YouTubeHit {
  videoId: string;
  title: string;
  /** The credit as YouTube Music writes it: "A, B & C". */
  artist: string;
  /** The channel ids of the credited artists (the ones that link to an artist), which is what Zemer's list is keyed by. */
  artistIds: string[];
  album?: string;
  durationSeconds?: number;
  cover?: string;
}

/** Where a song's audio can be downloaded from right now. */
export interface YouTubeStream {
  url: string;
  /** "audio/mp4" */
  type: string;
  bytes: number;
  durationMs?: number;
  /** Sent with the download: the link only works for the client that was given it. */
  userAgent: string;
  expiresAt: number;
}

export interface YouTubeMusicOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** How long a resolved stream link is reused, so checking a song and then sending it asks YouTube once. */
  streamTtlMs?: number;
  now?: () => number;
}

type Path = Array<string | number>;

function at(value: unknown, ...path: Path): unknown {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function seconds(text: string): number | undefined {
  if (!/^\d+(?::\d{2}){1,2}$/.test(text)) return undefined;
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** YouTube Music serves 120-pixel covers; the same picture is there at a larger size by changing the address. */
function largerCover(url: string): string {
  return url.replace(/=w\d+-h\d+(?=[^/]*$)/, '=w544-h544');
}

/** One row of a songs search: the title, then "artists • album • 5:41". */
function parseSong(item: unknown): YouTubeHit | undefined {
  const videoId =
    str(at(item, 'playlistItemData', 'videoId')) ??
    str(at(item, 'overlay', 'musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer', 'playNavigationEndpoint', 'watchEndpoint', 'videoId'));
  if (!videoId || !VIDEO_ID.test(videoId)) return undefined;

  const columns = list(at(item, 'flexColumns')).map((column) =>
    list(at(column, 'musicResponsiveListItemFlexColumnRenderer', 'text', 'runs')).map((run) => ({
      text: str(at(run, 'text')) ?? '',
      page: str(at(run, 'navigationEndpoint', 'browseEndpoint', 'browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType')),
      id: str(at(run, 'navigationEndpoint', 'browseEndpoint', 'browseId')),
    })),
  );
  const title = (columns[0] ?? []).map((run) => run.text).join('').trim();
  if (!title) return undefined;

  const groups: Array<Array<{ text: string; page: string | undefined; id: string | undefined }>> = [[]];
  for (const run of columns[1] ?? []) {
    if (run.text === SEPARATOR) groups.push([]);
    else groups[groups.length - 1]!.push(run);
  }
  const written = groups.map((group) => group.map((run) => run.text).join('').trim());
  // Search results that mix kinds lead with "Song" or "Video"; the songs filter doesn't.
  if (/^(?:song|video)$/i.test(written[0] ?? '')) {
    groups.shift();
    written.shift();
  }
  const artist = written[0] && seconds(written[0]) === undefined ? written[0] : '';
  const artistIds = artist ? [...new Set((groups[0] ?? []).flatMap((run) => (run.id && run.page !== 'MUSIC_PAGE_TYPE_ALBUM' ? [run.id] : [])))] : [];
  const album = groups.flat().find((run) => run.page === 'MUSIC_PAGE_TYPE_ALBUM')?.text;
  const durationSeconds = written.map(seconds).findLast((value) => value !== undefined);
  const thumbnails = list(at(item, 'thumbnail', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails'));
  const cover = str(at(thumbnails[thumbnails.length - 1], 'url'));

  return {
    videoId,
    title,
    artist,
    artistIds,
    ...(album ? { album } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(cover ? { cover: largerCover(cover) } : {}),
  };
}

export function parseSearch(response: unknown): YouTubeHit[] {
  const sections = list(at(response, 'contents', 'tabbedSearchResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents'));
  const seen = new Set<string>();
  const hits: YouTubeHit[] = [];
  for (const section of sections) {
    const rows = [...list(at(section, 'musicShelfRenderer', 'contents')), ...list(at(section, 'itemSectionRenderer', 'contents'))];
    for (const row of rows) {
      const hit = parseSong(at(row, 'musicResponsiveListItemRenderer'));
      if (hit && !seen.has(hit.videoId)) {
        seen.add(hit.videoId);
        hits.push(hit);
      }
    }
  }
  return hits;
}

export class YouTubeMusic {
  readonly baseUrl: string;
  #origin: string;
  #fetch: typeof fetch;
  #timeout: number;
  #streamTtl: number;
  #now: () => number;
  #mediaHosts: string[];
  #visitor: string | undefined;
  #visitorFlight: Promise<string> | undefined;
  #streams = new Map<string, YouTubeStream>();
  #flights = new Map<string, Promise<YouTubeStream>>();

  constructor(options: YouTubeMusicOptions = {}) {
    this.baseUrl = (options.baseUrl ?? YOUTUBE_MUSIC_URL).replace(/\/+$/, '');
    this.#origin = new URL(this.baseUrl).origin;
    this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.timeoutMs ?? 20_000;
    this.#streamTtl = options.streamTtlMs ?? 30 * 60_000;
    this.#now = options.now ?? Date.now;
    // Pointed somewhere else (the tests), the media comes from there too.
    this.#mediaHosts = this.#origin === YOUTUBE_MUSIC_URL ? MEDIA_HOSTS : [...MEDIA_HOSTS, new URL(this.#origin).hostname];
  }

  /** The address stored in the catalog for a song. It turns into a stream link when the song is played. */
  trackUrl(videoId: string): string {
    return `${this.#origin}/watch?v=${videoId}`;
  }

  /** Recognizes the addresses `trackUrl` makes. Anything else is not ours. */
  parseTrackUrl(raw: string): string | undefined {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    const id = url.searchParams.get('v');
    return url.origin === this.#origin && url.pathname === '/watch' && id !== null && VIDEO_ID.test(id) ? id : undefined;
  }

  async search(query: string): Promise<YouTubeHit[]> {
    // Zemer sends no visitor id with a search: a stale one can make YouTube answer with nothing at all.
    const response = await this.#post('search', WEB_REMIX, { query, params: SONG_FILTER });
    return parseSearch(response);
  }

  /** A link to download the song's audio from, as AAC (what Google Messages plays), asked for fresh if the last one is old. */
  stream(videoId: string): Promise<YouTubeStream> {
    const kept = this.#streams.get(videoId);
    if (kept && kept.expiresAt > this.#now()) return Promise.resolve(kept);
    const running = this.#flights.get(videoId);
    if (running) return running;
    const flight = this.#resolve(videoId).finally(() => this.#flights.delete(videoId));
    this.#flights.set(videoId, flight);
    return flight;
  }

  /** Type and size of a song's audio, without downloading it. Undefined for an address that isn't a YouTube Music song. */
  async inspect(url: string): Promise<{ type: string; bytes: number } | undefined> {
    const id = this.parseTrackUrl(url);
    if (!id) return undefined;
    const { type, bytes } = await this.stream(id);
    return { type, bytes };
  }

  /** Downloads a song's audio. A link that has stopped working (it is tied to the connection that asked) is replaced once. */
  async download(url: string, title?: string, options: { maxBytes?: number } = {}): Promise<DownloadedAudio> {
    const id = this.parseTrackUrl(url);
    if (!id) throw new YouTubeMusicError("that isn't a YouTube Music song");
    for (let attempt = 0; ; attempt += 1) {
      const stream = await this.stream(id);
      const withHeaders: typeof fetch = (input, init) => this.#fetch(input, { ...init, headers: { 'User-Agent': stream.userAgent, Range: 'bytes=0-' } });
      try {
        return await fetchAudio(stream.url, title, { fetch: withHeaders, ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) });
      } catch (err) {
        if (attempt > 0 || !(err instanceof AudioFetchError) || !/HTTP (?:403|410)/.test(err.message)) throw err;
        this.#streams.delete(id);
      }
    }
  }

  async #post(endpoint: string, client: InnerTubeClient, body: Record<string, unknown>, visitor?: string): Promise<unknown> {
    const context = {
      client: {
        clientName: client.name,
        clientVersion: client.version,
        hl: 'en',
        gl: 'US',
        ...(client.os ? { osName: client.os.name, osVersion: client.os.version, deviceMake: client.os.make, deviceModel: client.os.model } : {}),
        ...(visitor ? { visitorData: visitor } : {}),
      },
    };
    let res: Response;
    try {
      res = await this.#fetch(`${this.#origin}${API_PATH}${endpoint}?prettyPrint=false`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Format-Version': '1',
          'X-YouTube-Client-Name': client.id,
          'X-YouTube-Client-Version': client.version,
          'X-Origin': this.#origin,
          Referer: `${this.#origin}/`,
          'User-Agent': client.userAgent,
          ...(visitor ? { 'X-Goog-Visitor-Id': visitor } : {}),
        },
        body: JSON.stringify({ context, ...body }),
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch {
      throw new YouTubeMusicError("YouTube Music didn't answer (network error or timeout)");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new YouTubeMusicError(`YouTube Music answered HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new YouTubeMusicError("YouTube Music's answer wasn't readable");
    }
  }

  /** The anonymous session id the player wants (without one it asks to "confirm you're not a bot"). */
  #visitorId(refresh: boolean): Promise<string> {
    if (this.#visitor && !refresh) return Promise.resolve(this.#visitor);
    this.#visitorFlight ??= this.#post('visitor_id', WEB_REMIX, {})
      .then((response) => {
        const raw = str(at(response, 'responseContext', 'visitorData'));
        if (!raw) throw new YouTubeMusicError("YouTube Music didn't start a session");
        // It comes URL-encoded ("…%3D%3D"); the player wants it plain.
        this.#visitor = /%[0-9A-Fa-f]{2}/.test(raw) ? decodeURIComponent(raw) : raw;
        return this.#visitor;
      })
      .finally(() => {
        this.#visitorFlight = undefined;
      });
    return this.#visitorFlight;
  }

  async #resolve(videoId: string): Promise<YouTubeStream> {
    let problem = 'no client gave a link';
    for (let round = 0; round < 2; round += 1) {
      const visitor = await this.#visitorId(round > 0);
      let botCheck = false;
      for (const client of STREAM_CLIENTS) {
        let response: unknown;
        try {
          response = await this.#post('player', client, { videoId, contentCheckOk: true, racyCheckOk: true }, visitor);
        } catch (err) {
          if (!(err instanceof YouTubeMusicError)) throw err;
          problem = err.message; // a retired client version answers with an error; the next one may still work
          continue;
        }
        const status = str(at(response, 'playabilityStatus', 'status'));
        if (status !== 'OK') {
          const reason = str(at(response, 'playabilityStatus', 'reason')) ?? status ?? 'no reason given';
          problem = reason;
          if (/not a bot/i.test(reason)) botCheck = true;
          continue;
        }
        const stream = this.#pickAudio(response, client);
        if (stream) {
          this.#keep(videoId, stream);
          return stream;
        }
        problem = 'it has no AAC audio';
      }
      if (!botCheck) break; // the session id was refused; a new one is worth one more round
    }
    throw new YouTubeMusicError(`YouTube Music wouldn't give me that song (${problem})`);
  }

  /** The best AAC audio in a player response: the highest bitrate with a ready-to-use link, never an auto-dubbed track. */
  #pickAudio(response: unknown, client: InnerTubeClient): YouTubeStream | undefined {
    const formats = list(at(response, 'streamingData', 'adaptiveFormats'))
      .filter((format) => str(at(format, 'mimeType'))?.startsWith('audio/mp4') && at(format, 'audioTrack', 'isAutoDubbed') !== true)
      .filter((format) => {
        const link = str(at(format, 'url'));
        return link !== undefined && this.#trustedMedia(link);
      })
      .sort((a, b) => Number(at(b, 'bitrate') ?? 0) - Number(at(a, 'bitrate') ?? 0));
    const best = formats[0];
    const url = str(at(best, 'url'));
    const bytes = Number(str(at(best, 'contentLength')) ?? at(best, 'contentLength'));
    if (!best || !url || !Number.isFinite(bytes) || bytes <= 0) return undefined;
    const duration = Number(str(at(best, 'approxDurationMs')));
    const lifetime = Number(at(response, 'streamingData', 'expiresInSeconds')) * 1000;
    return {
      url,
      type: str(at(best, 'mimeType'))!.split(';')[0]!.trim().toLowerCase(),
      bytes,
      ...(Number.isFinite(duration) && duration > 0 ? { durationMs: duration } : {}),
      userAgent: client.userAgent,
      expiresAt: this.#now() + Math.min(this.#streamTtl, Number.isFinite(lifetime) && lifetime > 0 ? lifetime : this.#streamTtl),
    };
  }

  #trustedMedia(raw: string): boolean {
    try {
      const url = new URL(raw);
      const local = url.hostname === new URL(this.#origin).hostname;
      return (url.protocol === 'https:' || (local && url.protocol === 'http:')) && this.#mediaHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  }

  #keep(videoId: string, stream: YouTubeStream): void {
    this.#streams.delete(videoId);
    this.#streams.set(videoId, stream);
    while (this.#streams.size > MAX_STREAMS_KEPT) this.#streams.delete(this.#streams.keys().next().value!);
  }
}

export interface YouTubeLookupDeps {
  youTube: YouTubeMusic;
  catalog: { add(track: NewTrack): Track };
  /** Zemer's artist list, which every result is filtered through. Required: there is no unfiltered YouTube Music. */
  whitelist: ZemerWhitelist;
  /** Hears what the lookup decided, in plain words. The simulator shows these. */
  onNote?: (note: string) => void;
}

/**
 * Looks songs up on YouTube Music when the catalog has none, and stores what it finds in the catalog. YouTube Music
 * puts the best match first and forgives typos, so the first few results that pass Zemer's artist list are taken as
 * they come. The list is made current first; with no list at all there is no answer (and the next source is asked).
 */
export function createYouTubeMusicSource(deps: YouTubeLookupDeps): TrackSource {
  const note = (text: string): void => {
    try {
      deps.onNote?.(text);
    } catch {
      // a broken listener must not break a lookup
    }
  };
  return {
    name: 'YouTube Music',
    async lookup(query, limit) {
      const wanted = parseQuery(query);
      if (wanted.length === 0) return [];
      await deps.whitelist.ready();
      const hits = await deps.youTube.search(wanted.join(' '));
      const allowed = hits.filter((hit) => deps.whitelist.allows(hit.videoId, hit.artistIds));
      note(`YouTube Music listed ${hits.length} song${hits.length === 1 ? '' : 's'}; ${allowed.length} by artists on Zemer's list, none female`);
      return allowed.slice(0, limit).map((hit) =>
        deps.catalog.add({
          title: hit.title,
          artist: hit.artist,
          url: deps.youTube.trackUrl(hit.videoId),
          artistIds: hit.artistIds,
          ...(hit.cover ? { cover: hit.cover } : {}),
        }),
      );
    },
  };
}

/**
 * Makes the audio check and download understand catalog addresses that point at YouTube Music songs. A song is checked
 * from what the player says about it (type and size), so no separate request is made just to check it.
 */
export function resolvingYouTubeAudio(
  youTube: YouTubeMusic | undefined,
  io: {
    checkAudio(url: string): Promise<AudioCheck>;
    fetchAudio(url: string, title?: string): Promise<DownloadedAudio>;
  },
  options: { maxBytes?: number } = {},
) {
  if (!youTube) return io;
  return {
    async checkAudio(url: string): Promise<AudioCheck> {
      try {
        const info = await youTube.inspect(url);
        if (!info) return await io.checkAudio(url);
        if (options.maxBytes !== undefined && info.bytes > options.maxBytes) return { ok: false, reason: tooBig(info.bytes, options.maxBytes) };
        return { ok: true, type: info.type, bytes: info.bytes };
      } catch (err) {
        if (err instanceof SourceError) return { ok: false, reason: err.message };
        throw err;
      }
    },
    async fetchAudio(url: string, title?: string): Promise<DownloadedAudio> {
      if (!youTube.parseTrackUrl(url)) return io.fetchAudio(url, title);
      try {
        return await youTube.download(url, title, options);
      } catch (err) {
        if (err instanceof SourceError) throw new AudioFetchError(err.message);
        throw err;
      }
    },
  };
}

const REFUSALS: Record<Extract<Verdict, { ok: false }>['why'], string> = {
  blocked: "Zemer's list blocks that song",
  female: "it has a female singer, which I don't send",
  'not on the list': "its artist isn't on Zemer's artist list",
};

/**
 * Checks a YouTube Music song against Zemer's list as it stands now, when it is about to be sent, not only when it was
 * found: the list changes through the day, and a song stored yesterday may be blocked today. Resolves to why the song
 * must not go, or undefined when it can (and for any address that isn't a YouTube Music song). A song stored without its
 * artists' ids can't be checked and doesn't go.
 */
export function youTubeGate(deps: {
  youTube: YouTubeMusic;
  whitelist: ZemerWhitelist;
  catalog: { artistIdsOf(url: string): string[] | undefined };
}): (url: string) => Promise<string | undefined> {
  return async (url) => {
    const videoId = deps.youTube.parseTrackUrl(url);
    if (!videoId) return undefined;
    try {
      await deps.whitelist.ready();
    } catch (err) {
      if (err instanceof SourceError) return `${err.message}, so I can't check it`;
      throw err;
    }
    const ids = deps.catalog.artistIdsOf(url);
    if (!ids) return "it hasn't been checked against Zemer's artist list";
    const verdict = deps.whitelist.verdict(videoId, ids);
    return verdict.ok ? undefined : REFUSALS[verdict.why];
  };
}

/** The audio check with `youTubeGate` in front of it. With no gate (YouTube Music is off) the check is returned as it is. */
export function gatedAudioCheck(
  gate: ((url: string) => Promise<string | undefined>) | undefined,
  check: (url: string) => Promise<AudioCheck>,
): (url: string) => Promise<AudioCheck> {
  if (!gate) return check;
  return async (url) => {
    const reason = await gate(url);
    return reason === undefined ? check(url) : { ok: false, reason };
  };
}

/** YOUTUBE_MUSIC=off turns the source off; YOUTUBE_MUSIC_URL points it somewhere else (tests). */
export function youTubeMusicFromEnv(env: NodeJS.ProcessEnv = process.env, options: YouTubeMusicOptions = {}): YouTubeMusic | undefined {
  if (/^(off|false|no|0)$/i.test(env.YOUTUBE_MUSIC?.trim() ?? '')) return undefined;
  const baseUrl = env.YOUTUBE_MUSIC_URL?.trim();
  return new YouTubeMusic(baseUrl ? { ...options, baseUrl } : options);
}
