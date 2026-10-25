import { megabytes, tooBig, type AudioCheck } from '../audio-check.ts';
import { AudioFetchError, fetchAudio, fileNameFor, type DownloadedAudio } from '../audio-fetch.ts';
import { SourceError, type Album, type AlbumSource, type LookupOptions, type TrackSource } from '../bot.ts';
import type { NewTrack } from '../catalog.ts';
import { parseQuery } from '../query.ts';
import type { Track } from '../types.ts';
import { fitsAll, rankSongs } from './relevance.ts';
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
//
// YouTube turns many datacenter addresses away at the player ("Sign in to confirm you're not a bot"), the cloud host's
// among them. There a song comes through a relay (`YouTubeMusicOptions.relay`: the Cloudflare Worker beside the host,
// `src/cloud/youtube-relay.ts`), which asks the player and downloads the audio from an address YouTube does serve.
// Searches and album pages are still asked from here, since YouTube answers those.

export const YOUTUBE_MUSIC_URL = 'https://music.youtube.com';

const API_PATH = '/youtubei/v1/';
/** Zemer's SearchFilter.FILTER_SONG: only songs, not videos, albums or playlists. */
const SONG_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
/** Zemer's SearchFilter.FILTER_ALBUM: albums, EPs and singles (anything with an album page). */
const ALBUM_FILTER = 'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D';
const VIDEO_ID = /^[\w-]{11}$/;
/** What the address of an album looks like (the id of its page). */
const ALBUM_ID = /^MPREb_[\w-]{4,40}$/;
/** An album page names its songs a page at a time; this is more than any album has. */
const MAX_ALBUM_PAGES = 10;
/**
 * The media server serves the first megabyte of any link, and for roughly one link in fifteen turns down everything that
 * reaches further (those links want a token this client can't make; measured October 2026). Zemer checks each link for
 * that before using it, and so does `YouTubeMusic`. A song this size or smaller is wholly inside and needs no check.
 */
const FREE_WINDOW_BYTES = 1024 * 1024;
/** Sessions tried before giving up on a song (each with every client version). */
const MAX_ROUNDS = 3;
/**
 * YouTube turns many datacenter addresses away with "Sign in to confirm you're not a bot", whatever the client. When it
 * does that to this host, YouTube songs are left aside for this long (a search goes to music-table.com instead of
 * offering songs that can't be sent), then it is asked again.
 */
const TURNED_AWAY_MS = 15 * 60_000;
/**
 * Through a relay the bot check comes and goes within minutes (src/cloud/youtube-relay.ts), so when the relay is turned
 * away anyway, YouTube songs are left aside for only this long, twice as long each time after up to TURNED_AWAY_MS, and
 * the relay is asked for the short video at the end of each: the first time it comes through, YouTube songs are back.
 */
const RELAY_TURNED_AWAY_MS = 60_000;
/** What is said when YouTube turns this host away; it ends up in the chat ("I can't send …: <this>"). */
export const TURNED_AWAY = "YouTube Music is turning this server away for now (it asks to confirm it isn't a bot)";
/** A short, well-known video ("Me at the zoo", 19 s): asked for once at start to learn whether YouTube serves this host. */
const PROBE_VIDEO = 'jNQXAC9IVRw';
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

/** A song's audio, fetched by a relay. */
export interface RelayedSong {
  data: Uint8Array | Blob;
  /** "audio/mp4" */
  type: string;
  bytes: number;
  /** Where the time went (the relay's parts), for the host's `song:` line. */
  timing?: string | undefined;
}

/**
 * Fetches a song's audio (the best AAC stream, as `stream` picks it) from somewhere YouTube serves, refusing one over
 * `maxBytes`. It rejects with an error fit for the user; one with `turnedAway: true` means YouTube turned the relay
 * away with its bot check too.
 */
export type SongRelay = (videoId: string, options?: { maxBytes?: number }) => Promise<RelayedSong>;

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
  /**
   * How long YouTube songs are left aside once YouTube turns this host away with its bot check. Through a relay it is
   * the longest they are left aside (see RELAY_TURNED_AWAY_MS).
   */
  turnedAwayMs?: number;
  /** Runs the relay's next check later; by default a timer that doesn't keep the process running. */
  setTimer?: (run: () => void, ms: number) => void;
  /** Hears what went wrong (a search, an album page, a song's link), so the host's log shows it. */
  log?: (line: string) => void;
  /**
   * Fetches every song's audio somewhere else, for a host YouTube turns away (the cloud host). The player and the media
   * server are then never asked from here; searches and album pages still are.
   */
  relay?: SongRelay | undefined;
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

/** An album in a search's results. */
export interface YouTubeAlbumHit {
  /** The album page's id ("MPREb_…"). */
  browseId: string;
  title: string;
  artist: string;
  artistIds: string[];
  year?: number;
  cover?: string;
}

export interface YouTubeAlbumTrack {
  videoId: string;
  /** Its place on the album, counting from 1. */
  number: number;
  title: string;
  /** Empty when the album page doesn't name the song's artists (it usually doesn't: they are the album's). */
  artist: string;
  artistIds: string[];
}

export interface YouTubeAlbumPage extends YouTubeAlbumHit {
  tracks: YouTubeAlbumTrack[];
}

interface Run {
  text: string;
  page: string | undefined;
  id: string | undefined;
}

function runsOf(runs: unknown): Run[] {
  return list(runs).map((run) => ({
    text: str(at(run, 'text')) ?? '',
    page: str(at(run, 'navigationEndpoint', 'browseEndpoint', 'browseEndpointContextSupportedConfigs', 'browseEndpointContextMusicConfig', 'pageType')),
    id: str(at(run, 'navigationEndpoint', 'browseEndpoint', 'browseId')),
  }));
}

const yearOf = (texts: string[]): number | undefined => {
  const year = texts.findLast((text) => /^\d{4}$/.test(text.trim()));
  return year ? Number(year) : undefined;
};

/** The albums in a search made with the album filter: the title, then "Album • artists • 2020". */
export function parseAlbumSearch(response: unknown): YouTubeAlbumHit[] {
  const sections = list(at(response, 'contents', 'tabbedSearchResultsRenderer', 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents'));
  const seen = new Set<string>();
  const hits: YouTubeAlbumHit[] = [];
  for (const section of sections) {
    for (const row of list(at(section, 'musicShelfRenderer', 'contents'))) {
      const item = at(row, 'musicResponsiveListItemRenderer');
      const browseId = str(at(item, 'navigationEndpoint', 'browseEndpoint', 'browseId'));
      const columns = list(at(item, 'flexColumns')).map((column) => runsOf(at(column, 'musicResponsiveListItemFlexColumnRenderer', 'text', 'runs')));
      const title = (columns[0] ?? []).map((run) => run.text).join('').trim();
      if (!browseId || !ALBUM_ID.test(browseId) || !title || seen.has(browseId)) continue;
      const groups: Run[][] = [[]];
      for (const run of columns[1] ?? []) {
        if (run.text === SEPARATOR) groups.push([]);
        else groups[groups.length - 1]!.push(run);
      }
      const written = groups.map((group) => group.map((run) => run.text).join('').trim());
      // The first group says what kind of release it is ("Album", "EP", "Single"); the next is who made it.
      if (/^(?:album|ep|single)$/i.test(written[0] ?? '')) {
        groups.shift();
        written.shift();
      }
      const artist = written[0] && !/^\d{4}$/.test(written[0]) ? written[0] : '';
      const artistIds = artist ? [...new Set((groups[0] ?? []).flatMap((run) => (run.id && run.page !== 'MUSIC_PAGE_TYPE_ALBUM' ? [run.id] : [])))] : [];
      const year = yearOf(written);
      const thumbnails = list(at(item, 'thumbnail', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails'));
      const cover = str(at(thumbnails[thumbnails.length - 1], 'url'));
      seen.add(browseId);
      hits.push({ browseId, title, artist, artistIds, ...(year !== undefined ? { year } : {}), ...(cover ? { cover: largerCover(cover) } : {}) });
    }
  }
  return hits;
}

/** One song row of an album page; undefined for a row that can't be played (greyed out, or not a song). */
function parseAlbumTrack(row: unknown, position: number, albumArtistIds: string[]): YouTubeAlbumTrack | undefined {
  const item = at(row, 'musicResponsiveListItemRenderer');
  const videoId =
    str(at(item, 'playlistItemData', 'videoId')) ??
    str(at(item, 'overlay', 'musicItemThumbnailOverlayRenderer', 'content', 'musicPlayButtonRenderer', 'playNavigationEndpoint', 'watchEndpoint', 'videoId'));
  if (!videoId || !VIDEO_ID.test(videoId)) return undefined;
  const columns = list(at(item, 'flexColumns')).map((column) => runsOf(at(column, 'musicResponsiveListItemFlexColumnRenderer', 'text', 'runs')));
  const title = (columns[0] ?? []).map((run) => run.text).join('').trim();
  if (!title) return undefined;
  const credited = (columns[1] ?? []).filter((run) => run.page === 'MUSIC_PAGE_TYPE_ARTIST' || run.page === 'MUSIC_PAGE_TYPE_USER_CHANNEL');
  const numbered = Number(str(at(item, 'index', 'runs', 0, 'text')));
  return {
    videoId,
    number: Number.isInteger(numbered) && numbered > 0 ? numbered : position,
    title,
    artist: (columns[1] ?? []).map((run) => run.text).join('').trim(),
    // A song with no artists of its own is by the album's, as in Zemer.
    artistIds: credited.length > 0 ? [...new Set(credited.flatMap((run) => (run.id ? [run.id] : [])))] : albumArtistIds,
  };
}

/** The continuation token at the end of a list of rows, if there are more. */
const continuationOf = (rows: unknown[]): string | undefined =>
  rows.map((row) => str(at(row, 'continuationItemRenderer', 'continuationEndpoint', 'continuationCommand', 'token'))).find((token) => token !== undefined);

/** An album page: who made it, and its songs so far. `more` is where the rest is, when the page doesn't hold it all. */
export function parseAlbumPage(response: unknown, browseId: string): { album: YouTubeAlbumPage; more?: string } | undefined {
  const two = at(response, 'contents', 'twoColumnBrowseResultsRenderer');
  const header = at(two, 'tabs', 0, 'tabRenderer', 'content', 'sectionListRenderer', 'contents', 0, 'musicResponsiveHeaderRenderer');
  const title = list(at(header, 'title', 'runs')).map((run) => str(at(run, 'text')) ?? '').join('').trim();
  if (!title) return undefined;
  const credit = runsOf(at(header, 'straplineTextOne', 'runs'));
  const artistIds = [...new Set(credit.flatMap((run) => (run.id ? [run.id] : [])))];
  const year = yearOf(runsOf(at(header, 'subtitle', 'runs')).map((run) => run.text));
  const thumbnails = list(at(header, 'thumbnail', 'musicThumbnailRenderer', 'thumbnail', 'thumbnails'));
  const cover = str(at(thumbnails[thumbnails.length - 1], 'url'));
  const shelf = at(two, 'secondaryContents', 'sectionListRenderer', 'contents', 0);
  const rows = list(at(shelf, 'musicPlaylistShelfRenderer', 'contents') ?? at(shelf, 'musicShelfRenderer', 'contents'));
  const tracks = rows.flatMap((row, i) => parseAlbumTrack(row, i + 1, artistIds) ?? []);
  const more = continuationOf(rows);
  return {
    album: {
      browseId,
      title,
      artist: credit.map((run) => run.text).join('').trim(),
      artistIds,
      ...(year !== undefined ? { year } : {}),
      ...(cover ? { cover: largerCover(cover) } : {}),
      tracks,
    },
    ...(more ? { more } : {}),
  };
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

  #turnedAwayFor: number;
  #turnedAwayUntil = 0;
  /** How many times in a row the relay has been turned away (each leaves YouTube songs aside twice as long). */
  #relayStrikes = 0;
  #relayCheckDue = false;
  #setTimer: (run: () => void, ms: number) => void;
  #log: (line: string) => void;
  #relay: SongRelay | undefined;

  constructor(options: YouTubeMusicOptions = {}) {
    this.baseUrl = (options.baseUrl ?? YOUTUBE_MUSIC_URL).replace(/\/+$/, '');
    this.#origin = new URL(this.baseUrl).origin;
    this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.timeoutMs ?? 20_000;
    this.#streamTtl = options.streamTtlMs ?? 30 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#turnedAwayFor = options.turnedAwayMs ?? TURNED_AWAY_MS;
    this.#setTimer = options.setTimer ?? ((run, ms) => void setTimeout(run, ms).unref());
    this.#log = options.log ?? (() => {});
    this.#relay = options.relay;
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
    const response = await this.#logged(`searching "${query}"`, () => this.#post('search', WEB_REMIX, { query, params: SONG_FILTER }));
    return parseSearch(response);
  }

  /** Whether YouTube is turning this host away with its bot check right now (see TURNED_AWAY_MS). */
  get turnsThisHostAway(): boolean {
    return this.#now() < this.#turnedAwayUntil;
  }

  /**
   * Asks once for a short, well-known video's audio, to learn (and log) whether YouTube serves this host at all. On a
   * host it turns away, YouTube songs are then left aside from the start instead of after someone's request fails.
   * Through a relay this is also the check made at the end of each set-aside (RELAY_TURNED_AWAY_MS).
   */
  async checkStreams(): Promise<{ ok: true } | { ok: false; problem: string }> {
    const how = this.#relay ? 'through the relay' : 'from this host';
    try {
      if (this.#relay) await this.#fromRelay(this.#relay, PROBE_VIDEO, undefined, undefined, { check: true });
      else await this.stream(PROBE_VIDEO);
      this.#log(`YouTube Music: songs can be had ${how}`);
      return { ok: true };
    } catch (err) {
      if (!(err instanceof YouTubeMusicError)) throw err;
      this.#log(`YouTube Music: songs can't be had ${how} right now: ${err.message}`);
      return { ok: false, problem: err.message };
    }
  }

  /** Whether songs come through a relay (see `YouTubeMusicOptions.relay`). */
  get relayed(): boolean {
    return this.#relay !== undefined;
  }

  /** Runs a request to YouTube Music, logging why it failed before passing the failure on. */
  async #logged<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      this.#log(`YouTube Music: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /** Albums (and EPs and singles) matching a search, best match first. */
  async searchAlbums(query: string): Promise<YouTubeAlbumHit[]> {
    const response = await this.#logged(`searching albums "${query}"`, () => this.#post('search', WEB_REMIX, { query, params: ALBUM_FILTER }));
    return parseAlbumSearch(response);
  }

  /** An album's page: its title, artists, cover and every song on it, following the page's continuations. */
  async album(browseId: string): Promise<YouTubeAlbumPage> {
    if (!ALBUM_ID.test(browseId)) throw new YouTubeMusicError("that isn't an album I know");
    const first = parseAlbumPage(await this.#logged(`opening album ${browseId}`, () => this.#post('browse', WEB_REMIX, { browseId })), browseId);
    if (!first) {
      this.#log(`YouTube Music: album ${browseId} came back without a title or songs`);
      throw new YouTubeMusicError("YouTube Music didn't have that album");
    }
    const { album } = first;
    let more = first.more;
    for (let pages = 1; more && pages < MAX_ALBUM_PAGES; pages += 1) {
      const response = await this.#post('browse', WEB_REMIX, { continuation: more }, undefined, { continuation: more, ctoken: more });
      const rows = list(at(response, 'onResponseReceivedActions', 0, 'appendContinuationItemsAction', 'continuationItems'));
      const next = album.tracks.length;
      album.tracks.push(...rows.flatMap((row, i) => parseAlbumTrack(row, next + i + 1, album.artistIds) ?? []));
      more = continuationOf(rows);
    }
    return album;
  }

  /** A link to download the song's audio from, as AAC (what Google Messages plays), asked for fresh if the last one is old. */
  stream(videoId: string): Promise<YouTubeStream> {
    if (this.turnsThisHostAway) return Promise.reject(new YouTubeMusicError(TURNED_AWAY));
    const kept = this.#streams.get(videoId);
    if (kept && kept.expiresAt > this.#now()) return Promise.resolve(kept);
    const running = this.#flights.get(videoId);
    if (running) return running;
    const flight = this.#resolve(videoId).finally(() => this.#flights.delete(videoId));
    this.#flights.set(videoId, flight);
    return flight;
  }

  /**
   * Type and size of a song's audio, without downloading it. Undefined for an address that isn't a YouTube Music song.
   * Through a relay nobody is asked (the relay's only answer is the song itself), so the size is left out: it is known
   * once the song arrives, and the download holds it to the limit.
   */
  async inspect(url: string): Promise<{ type: string; bytes?: number } | undefined> {
    const id = this.parseTrackUrl(url);
    if (!id) return undefined;
    if (this.#relay) {
      if (this.turnsThisHostAway) throw new YouTubeMusicError(TURNED_AWAY);
      return { type: 'audio/mp4' };
    }
    const { type, bytes } = await this.stream(id);
    return { type, bytes };
  }

  /** Downloads a song's audio. A link that has stopped working (it is tied to the connection that asked) is replaced once. */
  async download(url: string, title?: string, options: { maxBytes?: number } = {}): Promise<DownloadedAudio> {
    const id = this.parseTrackUrl(url);
    if (!id) throw new YouTubeMusicError("that isn't a YouTube Music song");
    if (this.#relay) return this.#fromRelay(this.#relay, id, title, options.maxBytes);
    for (let attempt = 0; ; attempt += 1) {
      const stream = await this.stream(id);
      const withHeaders: typeof fetch = (input, init) => this.#fetch(input, { ...init, headers: { 'User-Agent': stream.userAgent, Range: 'bytes=0-' } });
      try {
        return await fetchAudio(stream.url, title, { fetch: withHeaders, ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) });
      } catch (err) {
        this.#log(`YouTube Music: downloading ${id} failed${attempt > 0 ? ' again' : ''}: ${err instanceof Error ? err.message : String(err)}`);
        if (attempt > 0 || !(err instanceof AudioFetchError) || !/HTTP (?:403|410)/.test(err.message)) throw err;
        this.#streams.delete(id);
      }
    }
  }

  /**
   * A song through the relay, held to the same rules as a download from here: audio, not empty, within the limit. A
   * `check` (the start-up check, or the one at the end of a set-aside) is asked even while YouTube songs are left aside.
   */
  async #fromRelay(relay: SongRelay, videoId: string, title?: string, maxBytes?: number, { check = false } = {}): Promise<DownloadedAudio> {
    if (this.turnsThisHostAway && !check) throw new YouTubeMusicError(TURNED_AWAY);
    const started = this.#now();
    let song: RelayedSong;
    try {
      song = await relay(videoId, maxBytes !== undefined ? { maxBytes } : {});
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#log(`YouTube Music: the relay couldn't get ${videoId}: ${message}`);
      if (err !== null && typeof err === 'object' && (err as { turnedAway?: unknown }).turnedAway === true) {
        this.#relayTurnedAway(check);
        throw new YouTubeMusicError(TURNED_AWAY);
      }
      // A bug, or a network failure nobody put into words, is in the log; the chat hears it plainly.
      const plain = err instanceof TypeError || err instanceof ReferenceError || !message;
      throw new YouTubeMusicError(plain ? "the relay couldn't get that song" : message);
    }
    const type = song.type.split(';')[0]!.trim().toLowerCase();
    const bytes = song.data instanceof Blob ? song.data.size : song.data.byteLength;
    const refuse = (reason: string): never => {
      this.#log(`YouTube Music: refused what the relay sent for ${videoId}: ${reason}`);
      throw new YouTubeMusicError(reason);
    };
    if (!type.startsWith('audio/')) refuse("what came back isn't audio");
    if (bytes === 0) refuse('the file is empty');
    if (maxBytes !== undefined && bytes > maxBytes) refuse(tooBig(bytes, maxBytes));
    const data =
      song.data instanceof Blob
        ? song.data.slice(0, bytes, type)
        : new Blob([song.data] as unknown as ConstructorParameters<typeof Blob>[0], { type });
    this.#log(`YouTube Music: ${videoId} came through the relay (${megabytes(bytes)} MB in ${Math.round((this.#now() - started) / 100) / 10} s)`);
    if (this.#relayStrikes > 0) {
      this.#relayStrikes = 0;
      this.#turnedAwayUntil = 0;
      this.#log('YouTube Music lets the relay through again; YouTube songs are back');
    }
    return { data, fileName: fileNameFor(title, new URL(this.trackUrl(videoId)), type), mimeType: type, bytes, ...(song.timing ? { timing: { via: song.timing } } : {}) };
  }

  /**
   * The relay met YouTube's bot check every time it asked: YouTube songs are left aside for a minute, twice as long each
   * time it happens again in a row (up to `turnedAwayMs`), and the relay is checked at the end of it.
   */
  #relayTurnedAway(check: boolean): void {
    // Songs asked for together meet the same bot check: that is one time, not several.
    if (this.turnsThisHostAway && !check) return;
    const ms = Math.min(this.#turnedAwayFor, RELAY_TURNED_AWAY_MS * 2 ** this.#relayStrikes);
    this.#relayStrikes += 1;
    this.#turnedAwayUntil = this.#now() + ms;
    const minutes = Math.round(ms / 60_000);
    this.#log(`YouTube Music turns the relay away too; YouTube songs are left aside for ${minutes} minute${minutes === 1 ? '' : 's'}, then the relay is checked again`);
    if (this.#relayCheckDue) return;
    this.#relayCheckDue = true;
    this.#setTimer(() => {
      this.#relayCheckDue = false;
      void this.checkStreams().catch(() => {});
    }, ms);
  }

  async #post(endpoint: string, client: InnerTubeClient, body: Record<string, unknown>, visitor?: string, query: Record<string, string> = {}): Promise<unknown> {
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
      res = await this.#fetch(`${this.#origin}${API_PATH}${endpoint}?${new URLSearchParams({ prettyPrint: 'false', ...query })}`, {
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
    let asked = 0;
    let deadLinks = 0;
    let botChecks = 0;
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const visitor = await this.#visitorId(round > 0);
      let botCheck = false;
      let refused = false;
      for (const client of STREAM_CLIENTS) {
        let response: unknown;
        asked += 1;
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
          if (/not a bot/i.test(reason)) {
            botCheck = true;
            botChecks += 1;
          }
          continue;
        }
        const stream = this.#pickAudio(response, client);
        if (stream && (await this.#acceptsWholeSong(stream))) {
          if (deadLinks > 0) this.#log(`YouTube Music: ${videoId} needed ${deadLinks + 1} links (${deadLinks} refused the whole song)`);
          this.#keep(videoId, stream);
          return stream;
        }
        if (stream) {
          problem = 'its link was refused';
          refused = true; // each ask gives a new link, and most are fine
          deadLinks += 1;
        } else {
          problem = 'it has no AAC audio';
        }
      }
      // A refused link is worth a fresh session and another round, up to MAX_ROUNDS; a refused session id, one more.
      if (!refused && !(botCheck && round < 1)) break;
    }
    this.#log(`YouTube Music: gave up on ${videoId} after ${asked} asks: ${problem}`);
    // Every ask met the bot check: YouTube is turning this host away, not refusing this one song.
    if (botChecks > 0 && botChecks === asked) {
      this.#turnedAwayUntil = this.#now() + this.#turnedAwayFor;
      this.#log(`YouTube Music turns this host away (it asks to confirm it isn't a bot); YouTube songs are left aside for ${Math.round(this.#turnedAwayFor / 60_000)} minutes`);
      throw new YouTubeMusicError(TURNED_AWAY);
    }
    throw new YouTubeMusicError(`YouTube Music wouldn't give me that song (${problem})`);
  }

  /**
   * Whether the media server will serve the whole song from this link. The request is the one the download will make
   * (the whole file), and only its status is read: a walled link answers 403 at once, and the body is dropped unread. A
   * smaller probe isn't a safe test, since a walled link serves small ranges (even past the first megabyte, up to about
   * two). A song within the first megabyte needs no check, and a check that can't be made (the network) lets the link
   * through: the download will say.
   */
  async #acceptsWholeSong(stream: YouTubeStream): Promise<boolean> {
    if (stream.bytes <= FREE_WINDOW_BYTES + 1) return true;
    try {
      const res = await this.#fetch(stream.url, {
        headers: { 'User-Agent': stream.userAgent, Range: 'bytes=0-' },
        signal: AbortSignal.timeout(this.#timeout),
      });
      await res.body?.cancel().catch(() => {});
      return res.ok;
    } catch {
      return true;
    }
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
    hint: "it only shows artists on Zemer's list",
    async lookup(query, limit, options?: LookupOptions) {
      const wanted = parseQuery(query);
      if (wanted.length === 0) return [];
      // Songs that can't be sent are not offered: "search" goes to music-table.com instead, "youtube" says why.
      if (deps.youTube.turnsThisHostAway) throw new YouTubeMusicError(TURNED_AWAY);
      await deps.whitelist.ready();
      const hits = await deps.youTube.search(wanted.join(' '));
      const allowed = hits.filter((hit) => deps.whitelist.allows(hit.videoId, hit.artistIds));
      note(`YouTube Music listed ${hits.length} song${hits.length === 1 ? '' : 's'}; ${allowed.length} by artists on Zemer's list, none female`);
      // YouTube Music answers any words with its twenty nearest songs. Asked first, with something else to fall back on,
      // only those that have every one of the words count, best first; asked alone, its own order is kept.
      const fitting = options?.relevant ? rankSongs(allowed.filter((hit) => fitsAll(hit, wanted)), wanted, limit) : allowed;
      if (options?.relevant) note(`${fitting.length} of those fit the words`);
      return fitting.slice(0, limit).map((hit) =>
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
 * from what the player says about it (type and size), so no separate request is made just to check it. Through a relay
 * the check gives no size (see `YouTubeMusic.inspect`), and an album's zips are then split as its songs arrive.
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
        if (info.bytes === undefined) return { ok: true, type: info.type };
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

/**
 * Albums from YouTube Music, held to the same list as its songs: an album is offered, and opened, only when one of its
 * artists is on Zemer's list and none is a woman; each song on it must pass as well (with the album's artists standing
 * in for a song that names none), and one that doesn't is left out. The songs that stay are kept in the catalog with
 * their artists' ids, so each is checked against the list again when it is sent.
 */
export function createYouTubeAlbumSource(deps: YouTubeLookupDeps): AlbumSource {
  const note = (text: string): void => {
    try {
      deps.onNote?.(text);
    } catch {
      // a broken listener must not break a lookup
    }
  };
  return {
    name: 'YouTube Music',
    hint: "it only shows artists on Zemer's list",
    async search(query, limit) {
      const wanted = parseQuery(query);
      if (wanted.length === 0) return [];
      if (deps.youTube.turnsThisHostAway) throw new YouTubeMusicError(TURNED_AWAY);
      await deps.whitelist.ready();
      const hits = await deps.youTube.searchAlbums(wanted.join(' '));
      const allowed = hits.filter((hit) => deps.whitelist.allows(hit.browseId, hit.artistIds));
      note(`YouTube Music listed ${hits.length} album${hits.length === 1 ? '' : 's'}; ${allowed.length} by artists on Zemer's list, none female`);
      return allowed.slice(0, limit).map((hit): Album => ({ id: hit.browseId, title: hit.title, artist: hit.artist, year: hit.year, cover: hit.cover }));
    },
    async open(id) {
      if (deps.youTube.turnsThisHostAway) throw new YouTubeMusicError(TURNED_AWAY);
      await deps.whitelist.ready();
      const page = await deps.youTube.album(id);
      const verdict = deps.whitelist.verdict(id, page.artistIds);
      if (!verdict.ok) throw new YouTubeMusicError(refusal(verdict.why, 'album'));
      const songs: Array<{ number: number; track: Track }> = [];
      for (const song of page.tracks) {
        if (!deps.whitelist.allows(song.videoId, song.artistIds)) continue;
        const track = deps.catalog.add({
          title: song.title,
          artist: song.artist || page.artist,
          url: deps.youTube.trackUrl(song.videoId),
          artistIds: song.artistIds,
          ...(page.cover ? { cover: page.cover } : {}),
        });
        songs.push({ number: song.number, track });
      }
      const leftOut = page.tracks.length - songs.length;
      note(`album "${page.title}": ${page.tracks.length} songs, ${songs.length} may be sent${leftOut > 0 ? `, ${leftOut} left out by Zemer's list` : ''}`);
      if (songs.length === 0) throw new YouTubeMusicError(page.tracks.length === 0 ? 'it has no songs I can get' : "none of its songs pass Zemer's list");
      return { album: { id, title: page.title, artist: page.artist, year: page.year, cover: page.cover }, songs, leftOut };
    },
  };
}

/** Why something was held back, in words for the chat; `what` is "song" or "album". */
const refusal = (why: Extract<Verdict, { ok: false }>['why'], what: string): string =>
  why === 'blocked' ? `Zemer's list blocks that ${what}` : why === 'female' ? "it has a female singer, which I don't send" : "its artist isn't on Zemer's artist list";

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
    return verdict.ok ? undefined : refusal(verdict.why, 'song');
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

/** YOUTUBE_MUSIC=off turns the source off; YOUTUBE_MUSIC_URL points it somewhere else (tests). A relay comes in `options`. */
export function youTubeMusicFromEnv(env: NodeJS.ProcessEnv = process.env, options: YouTubeMusicOptions = {}): YouTubeMusic | undefined {
  if (/^(off|false|no|0)$/i.test(env.YOUTUBE_MUSIC?.trim() ?? '')) return undefined;
  const baseUrl = env.YOUTUBE_MUSIC_URL?.trim();
  return new YouTubeMusic(baseUrl ? { ...options, baseUrl } : options);
}
