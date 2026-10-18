import { SourceError, type Album, type AlbumSource, type ArtistPage, type ArtistRef, type Finder, type Findings, type FoundSong, type TrackSource } from '../bot.ts';
import type { NewTrack, TrackAlbum } from '../catalog.ts';
import { parseQuery, tokenize } from '../query.ts';
import type { Track } from '../types.ts';
import { TURNED_AWAY, YouTubeMusicError, type YouTubeMusic } from './youtube-music.ts';
import type { ZemerWhitelist } from './zemer-whitelist.ts';

// Zemer's own catalog (search.zemer.io), what the Zemer app searches since it stopped searching YouTube Music itself
// (ZemerSearchClient.kt in github.com/ZemerTeam/zemer-app). It holds only what Zemer's artist list allows, already
// sorted into songs, albums, singles and artists, and it reads Latin spellings of Hebrew names ("elazar lipa'le" finds
// "אלעזר ליפא׳לע"). YouTube Music's own search does neither: "lipa" brings Dua Lipa there, and nothing passes the list.
//
// Every request says what to leave out, because the server leaves in whatever isn't said: allowFemale=0 (no female
// singers, as the owner wants), blockVideos=0 and kidZone=0 (as the app sends them). A song's id is its YouTube video
// id, so the audio still comes from YouTube Music (`YouTubeMusic`, through the relay on the cloud host) and songs are
// stored with the same addresses YouTube Music's are. Everything the server sends is checked against Zemer's artist
// list here as well, and each song again when it is sent (`youTubeGate`): the owner requires both.

export const ZEMER_SEARCH_URL = 'https://search.zemer.io';

/** What one search asks for of each kind; the app asks for 8 to 100. */
const PER_KIND = 20;
/** How long an artist's or an album's page is kept, so "more" (or the album after its song) doesn't ask again. */
const PAGE_TTL_MS = 10 * 60_000;
const PAGES_KEPT = 30;
/** How long a song's cover is waited for (its album's, when it has none of its own) before the video's picture is used. */
const COVER_WAIT_MS = 2_500;

/** The picture YouTube shows with a video: for a song, its cover with bars around it. */
const videoPicture = (videoId: string): string => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
const ID = /^[\w-]{4,64}$/;
const VIDEO_ID = /^[\w-]{11}$/;
/** Marks that steer how text runs (left to right, right to left) or join words without showing: Hebrew titles carry them. */
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;

/** A problem whose message is fit to show to the user. */
export class ZemerError extends SourceError {
  constructor(message: string) {
    super(message);
    this.name = 'ZemerError';
  }
}

export interface ZemerSong {
  videoId: string;
  title: string;
  artist: string;
  /** The credited artist's channel id; the search sends it, an album's page doesn't. */
  artistId?: string;
  seconds?: number;
  plays?: number;
  album?: { id: string; title: string };
  cover?: string;
  /** Its place on the album, on an album's page. */
  number?: number;
}

/** An album, an EP or a single: anything with a page of songs. */
export interface ZemerRelease {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  year?: number;
  /** When it came out (ISO), more exact than the year. */
  released?: string;
  cover?: string;
  songs?: number;
  single: boolean;
}

export interface ZemerArtist {
  id: string;
  name: string;
}

export interface ZemerResults {
  artists: ZemerArtist[];
  songs: ZemerSong[];
  /** Songs that are videos on YouTube (a music video, or "official audio" with a picture). */
  videos: ZemerSong[];
  albums: ZemerRelease[];
  singles: ZemerRelease[];
}

export interface ZemerArtistPage {
  artist: ZemerArtist;
  songs: ZemerSong[];
  albums: ZemerRelease[];
  singles: ZemerRelease[];
}

export interface ZemerAlbumPage {
  album: ZemerRelease;
  songs: ZemerSong[];
}

export interface ZemerSearchOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Hears what went wrong, so the host's log shows it. */
  log?: (line: string) => void;
  now?: () => number;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined);
const records = (value: unknown): Json[] =>
  Array.isArray(value)
    ? value.flatMap((item): Json[] => {
        const row = record(item);
        return row ? [row] : [];
      })
    : [];
const text = (value: unknown): string => (typeof value === 'string' ? clean(value) : '');
const count = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
const id = (value: unknown, pattern = ID): string | undefined => (typeof value === 'string' && pattern.test(value) ? value : undefined);
const https = (value: unknown): string | undefined => (typeof value === 'string' && /^https:\/\//.test(value) ? value : undefined);

/** A name or title without the invisible marks Hebrew text comes with, and with single spaces. */
export function clean(raw: string): string {
  return raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
}

function parseSong(row: Json): ZemerSong | undefined {
  const videoId = id(row.videoId, VIDEO_ID);
  const title = text(row.title);
  if (!videoId || !title) return undefined;
  const album = record(row.album);
  const albumId = id(album?.id);
  const albumTitle = text(album?.name);
  const artistId = id(row.artistId);
  const seconds = count(row.durationSec);
  const plays = count(row.playCount);
  const number = count(row.trackNumber);
  const cover = https(row.thumbnail);
  return {
    videoId,
    title,
    artist: text(row.artist),
    ...(artistId ? { artistId } : {}),
    ...(seconds ? { seconds } : {}),
    ...(plays !== undefined ? { plays } : {}),
    ...(albumId && albumTitle ? { album: { id: albumId, title: albumTitle } } : {}),
    ...(cover ? { cover } : {}),
    ...(number ? { number } : {}),
  };
}

function parseRelease(row: Json | undefined, single = false): ZemerRelease | undefined {
  const releaseId = id(row?.id);
  const title = text(row?.title);
  if (!row || !releaseId || !title) return undefined;
  const artistId = id(row.artistId);
  const year = count(row.year);
  const songs = count(row.trackCount);
  const cover = https(row.thumbnail);
  const released = typeof row.releaseDate === 'string' && !Number.isNaN(Date.parse(row.releaseDate)) ? row.releaseDate : undefined;
  return {
    id: releaseId,
    title,
    artist: text(row.artist),
    ...(artistId ? { artistId } : {}),
    ...(year ? { year } : {}),
    ...(released ? { released } : {}),
    ...(cover ? { cover } : {}),
    ...(songs ? { songs } : {}),
    single: single || row.type === 'single',
  };
}

function parseArtist(row: Json | undefined): ZemerArtist | undefined {
  const artistId = id(row?.id);
  const name = text(row?.name);
  return artistId && name ? { id: artistId, name } : undefined;
}

const songsIn = (value: unknown): ZemerSong[] => records(value).flatMap((row) => parseSong(row) ?? []);
const releasesIn = (value: unknown, single = false): ZemerRelease[] => records(value).flatMap((row) => parseRelease(row, single) ?? []);

export function parseResults(response: unknown): ZemerResults {
  const categories = record(record(response)?.categories);
  return {
    artists: records(categories?.artists).flatMap((row) => parseArtist(row) ?? []),
    songs: songsIn(categories?.songs),
    videos: songsIn(categories?.videos),
    albums: releasesIn(categories?.albums),
    singles: releasesIn(categories?.singles, true),
  };
}

export function parseArtistPage(response: unknown): ZemerArtistPage | undefined {
  const page = record(response);
  const artist = parseArtist(record(page?.artist));
  if (!page || !artist) return undefined;
  return {
    artist,
    // An artist's songs come without their credit: they are the artist's.
    songs: songsIn(page.songs).map((song) => ({ ...song, artist: song.artist || artist.name, artistId: song.artistId ?? artist.id })),
    albums: releasesIn(page.albums),
    singles: releasesIn(page.singles, true),
  };
}

export function parseAlbumPage(response: unknown): ZemerAlbumPage | undefined {
  const page = record(response);
  const album = parseRelease(record(page?.album));
  if (!page || !album) return undefined;
  const songs = songsIn(page.tracks).map((song, i) => ({ ...song, number: song.number ?? i + 1 }));
  return { album, songs };
}

/** The client for search.zemer.io. */
export class ZemerSearch {
  readonly baseUrl: string;
  #fetch: typeof fetch;
  #timeout: number;
  #log: (line: string) => void;
  #now: () => number;
  #artists = new Map<string, { at: number; page: ZemerArtistPage | undefined }>();
  #albums = new Map<string, { at: number; page: ZemerAlbumPage | undefined }>();

  constructor(options: ZemerSearchOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ZEMER_SEARCH_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.timeoutMs ?? 10_000;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? Date.now;
  }

  /** Artists, songs, videos, albums and singles that fit the words, each kind best first. */
  async search(query: string): Promise<ZemerResults> {
    return parseResults(await this.#get('/search', { q: query, k: String(PER_KIND) }, `searching "${query}"`));
  }

  /** Everything by one artist (the songs with how often they were played); undefined when Zemer doesn't have them. */
  artist(artistId: string): Promise<ZemerArtistPage | undefined> {
    return this.#kept(this.#artists, artistId, async () => {
      const response = await this.#get('/artist', { id: artistId }, `opening artist ${artistId}`, { notFound: true });
      return response === undefined ? undefined : parseArtistPage(response);
    });
  }

  /** An album's songs, in order; undefined when Zemer doesn't have it (or none of it may be sent). */
  album(albumId: string): Promise<ZemerAlbumPage | undefined> {
    return this.#kept(this.#albums, albumId, async () => {
      const response = await this.#get('/album', { id: albumId }, `opening album ${albumId}`, { notFound: true });
      return response === undefined ? undefined : parseAlbumPage(response);
    });
  }

  /** A page asked for in the last few minutes is not asked for again ("more", a song's cover and then its album). */
  async #kept<T>(pages: Map<string, { at: number; page: T | undefined }>, key: string, fetchPage: () => Promise<T | undefined>): Promise<T | undefined> {
    if (!ID.test(key)) return undefined;
    const kept = pages.get(key);
    if (kept && this.#now() - kept.at < PAGE_TTL_MS) return kept.page;
    const page = await fetchPage();
    pages.delete(key);
    pages.set(key, { at: this.#now(), page });
    while (pages.size > PAGES_KEPT) pages.delete(pages.keys().next().value!);
    return page;
  }

  /** Asks once, to learn (and log) whether Zemer's search answers this host at all. */
  async check(): Promise<{ ok: true } | { ok: false; problem: string }> {
    try {
      await this.search('shabbos');
      this.#log("Zemer's search answers");
      return { ok: true };
    } catch (err) {
      if (!(err instanceof ZemerError)) throw err;
      this.#log(`Zemer's search doesn't answer right now: ${err.message}`);
      return { ok: false, problem: err.message };
    }
  }

  async #get(path: string, params: Record<string, string>, what: string, options: { notFound?: boolean } = {}): Promise<unknown> {
    const query = new URLSearchParams({ ...params, allowFemale: '0', blockVideos: '0', kidZone: '0' });
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}?${query}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'music-over-rcs/0.1 (personal, single-user project)' },
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch {
      this.#log(`Zemer: ${what} failed: no answer`);
      throw new ZemerError("Zemer's search didn't answer (network error or timeout)");
    }
    if (res.status === 404 && options.notFound) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      this.#log(`Zemer: ${what} failed: HTTP ${res.status}`);
      throw new ZemerError(`Zemer's search answered HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      this.#log(`Zemer: ${what} failed: the answer wasn't JSON`);
      throw new ZemerError("Zemer's search answered with something unreadable");
    }
  }
}

/** ZEMER_SEARCH=off turns it off (searches then go to YouTube Music's own search); ZEMER_SEARCH_URL points it elsewhere (tests). */
export function zemerSearchFromEnv(env: NodeJS.ProcessEnv = process.env, options: ZemerSearchOptions = {}): ZemerSearch | undefined {
  if (/^(off|false|no|0)$/i.test(env.ZEMER_SEARCH?.trim() ?? '')) return undefined;
  const baseUrl = env.ZEMER_SEARCH_URL?.trim();
  return new ZemerSearch(baseUrl ? { ...options, baseUrl } : options);
}

/** "Lipa Schmeltzer - Leiby Forever (Official Music Video)" by Lipa Schmeltzer is "Leiby Forever". */
export function tidyVideoTitle(title: string, artist: string): string {
  let tidy = title
    .replace(/\s*[([](?:official\s+)?(?:music\s+)?(?:video|audio|lyric(?:s)?\s+video|visuali[sz]er|clip)[^)\]]*[)\]]/gi, '')
    .replace(/\s*[([]offi?c[ia]+l[^)\]]*[)\]]/gi, '')
    .replace(/\s*\|\s*official.*$/i, '')
    .trim();
  const name = tokenize(artist).join(' ');
  const lead = /^(.+?)\s+[-–—]\s+(.+)$/.exec(tidy);
  if (lead && name && tokenize(lead[1]!).join(' ') === name) tidy = lead[2]!.trim();
  return tidy || title;
}

export interface ZemerFinderDeps {
  zemer: ZemerSearch | undefined;
  /** Where a song's audio comes from: its address in the catalog is YouTube Music's. */
  youTube: YouTubeMusic;
  catalog: { add(track: NewTrack): Track; albumOf?(url: string): TrackAlbum | undefined };
  /** Zemer's artist list, which everything is checked against again here. Required: there is no unchecked Zemer. */
  whitelist: ZemerWhitelist;
  /** Asked when Zemer's search can't be reached (or is off): YouTube Music's own search, held to the same list. */
  fallback?: { songs?: TrackSource | undefined; albums?: AlbumSource | undefined } | undefined;
  /** Hears what the lookup decided, in plain words. The simulator shows these. */
  onNote?: (note: string) => void;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Zemer as the bot's first place to look: one search finds songs, albums and artists, an artist opens into all of their
 * songs (most played first) and albums (newest first), and an album into its songs. Whatever doesn't pass Zemer's
 * artist list (checked here too, by the artists' channel ids) is left out, and the songs that are shown are stored in
 * the catalog with those ids, so each is checked once more when it is sent.
 */
export function createZemerFinder(deps: ZemerFinderDeps): Finder & { albums: AlbumSource } {
  const { youTube, whitelist } = deps;
  const note = (line: string): void => {
    try {
      deps.onNote?.(line);
    } catch {
      // a broken listener must not break a lookup
    }
  };

  /** The channel ids a credit stands for: the one the server sent, or else the names on Zemer's list. */
  const idsOf = (song: { artist: string; artistId?: string | undefined }, fallbackIds: string[] = []): string[] => {
    if (song.artistId) return [song.artistId];
    const named = [...new Set(song.artist.split(/\s*(?:,|&|\bfeat\.?|\bft\.?)\s*/i).flatMap((name) => whitelist.idsNamed(name)))];
    return named.length > 0 ? named : fallbackIds;
  };
  /** How else the artists are written (their names in the other alphabet), for matching what was typed. */
  const akaOf = (ids: string[]): string | undefined => {
    const names = ids.flatMap((artistId) => whitelist.artist(artistId)?.altName ?? []);
    return names.length > 0 ? names.join(' ') : undefined;
  };

  /** An album's page, when it comes within a couple of seconds (kept a while, so sending the album next asks nothing new). */
  const albumPage = async (albumId: string): Promise<ZemerAlbumPage | undefined> => {
    let timer: NodeJS.Timeout | undefined;
    const page = deps.zemer?.album(albumId).catch(() => undefined);
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), COVER_WAIT_MS);
    });
    const found = await Promise.race([page, late]);
    clearTimeout(timer);
    return found;
  };

  /** What is known of a song's album from the release it came with, if any: a single is its own album, song 1 of 1. */
  const albumFrom = (song: ZemerSong, release: ZemerRelease | undefined): TrackAlbum | undefined => {
    if (!song.album) return undefined;
    const single = release?.single || release?.songs === 1;
    return {
      id: song.album.id,
      title: release?.title ?? song.album.title,
      ...(release?.artist ? { artist: release.artist } : {}),
      ...(release?.songs ? { songs: release.songs } : single ? { songs: 1 } : {}),
      ...(single ? { number: 1 } : {}),
      ...(release?.year ? { year: release.year } : {}),
    };
  };

  /**
   * A song found, to be stored in the catalog when it is shown: with its artists' ids, its album as far as it is known
   * (`album`, or what the release found with it says), and a picture (its own, its album's, or until its album's cover
   * is looked up when it is sent, the video's: the cover with bars around it).
   */
  const found = (song: ZemerSong, ids: string[], release: ZemerRelease | undefined, options: { video?: boolean; album?: TrackAlbum; cover?: string | undefined } = {}): FoundSong => {
    let kept: Track | undefined;
    const title = options.video ? tidyVideoTitle(song.title, song.artist) : song.title;
    const aka = akaOf(ids);
    return {
      title,
      artist: song.artist,
      ...(aka ? { aka } : {}),
      ...(song.album ? { album: song.album } : {}),
      ...(song.seconds ? { seconds: song.seconds } : {}),
      async keep() {
        const album = options.album ?? albumFrom(song, release);
        const cover = song.cover ?? release?.cover ?? options.cover ?? videoPicture(song.videoId);
        kept ??= deps.catalog.add({ title, artist: song.artist, url: youTube.trackUrl(song.videoId), artistIds: ids, cover, ...(album ? { album } : {}) });
        return kept;
      },
    };
  };
  const releasesIn = (...lists: ZemerRelease[][]): Map<string, ZemerRelease> => new Map(lists.flat().map((release) => [release.id, release]));

  const toAlbum = (release: ZemerRelease): Album => {
    const aka = akaOf(release.artistId ? [release.artistId] : []);
    return {
      id: release.id,
      title: release.title,
      artist: release.artist,
      year: release.year,
      cover: release.cover,
      ...(release.songs ? { songs: release.songs } : {}),
      ...(release.single ? { single: true } : {}),
      ...(aka ? { aka } : {}),
    };
  };

  const allowedRelease = (release: ZemerRelease): boolean => whitelist.allows(release.id, idsOf(release));

  /** The same song or album twice (an edition, a re-upload) is one: the one with more songs, or else the first. */
  const sameTitle = (title: string, artist: string): string => `${tokenize(title).join(' ')}|${tokenize(artist).join(' ')}`;
  function once<T extends { title: string; artist: string }>(items: T[], better: (a: T, b: T) => boolean = () => false): T[] {
    const kept = new Map<string, T>();
    for (const item of items) {
      const key = sameTitle(item.title, item.artist);
      const had = kept.get(key);
      if (!had || better(item, had)) kept.set(key, item);
    }
    return [...kept.values()];
  }

  async function fromYouTube(query: string, why: string): Promise<Findings> {
    const { songs, albums } = deps.fallback ?? {};
    if (!songs && !albums) throw new ZemerError(why);
    note(`${why}; asking YouTube Music's own search instead`);
    let tracks: Track[];
    let releases: Album[];
    try {
      [tracks, releases] = await Promise.all([
        songs ? songs.lookup(query, 10, { relevant: true }) : Promise.resolve([]),
        albums ? albums.search(query, 10).catch(() => []) : Promise.resolve([]),
      ]);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      throw new ZemerError(`${why}, and ${err.message}`);
    }
    return { songs: tracks.map((track): FoundSong => ({ title: track.title, artist: track.artist, keep: async () => track })), albums: releases, artists: [] };
  }

  async function open(albumId: string): ReturnType<AlbumSource['open']> {
    const fallback = deps.fallback?.albums;
    let page: ZemerAlbumPage | undefined;
    if (youTube.turnsThisHostAway) throw new YouTubeMusicError(TURNED_AWAY);
    try {
      await whitelist.ready();
      if (!deps.zemer) throw new ZemerError("Zemer's search is turned off");
      page = await deps.zemer.album(albumId);
    } catch (err) {
      if (!(err instanceof SourceError) || !fallback) throw err;
      note(`${err.message}; opening the album on YouTube Music instead`);
      return fallback.open(albumId);
    }
    if (!page) {
      if (fallback) return fallback.open(albumId);
      throw new ZemerError("Zemer doesn't have that album");
    }
    const albumIds = idsOf(page.album);
    const verdict = whitelist.verdict(albumId, albumIds);
    if (!verdict.ok) throw new ZemerError(verdict.why === 'blocked' ? "Zemer's list blocks that album" : verdict.why === 'female' ? "it has a female singer, which I don't send" : "its artist isn't on Zemer's artist list");
    const songs: Array<{ number: number; track: Track }> = [];
    for (const song of page.songs) {
      // A song credited to the album's artist (or to nobody) is the album artist's.
      const sameArtist = !song.artist || tokenize(song.artist).join(' ') === tokenize(page.album.artist).join(' ');
      const ids = sameArtist ? albumIds : idsOf(song, []);
      if (!whitelist.allows(song.videoId, ids)) continue;
      const number = song.number ?? songs.length + 1;
      const album: TrackAlbum = {
        id: albumId,
        title: page.album.title,
        artist: page.album.artist,
        number,
        songs: Math.max(page.album.songs ?? 0, page.songs.length),
        ...(page.album.year ? { year: page.album.year } : {}),
      };
      const track = await found({ ...song, artist: song.artist || page.album.artist }, ids, undefined, { album, cover: page.album.cover }).keep();
      songs.push({ number, track });
    }
    const leftOut = page.songs.length - songs.length;
    note(`album "${page.album.title}": ${plural(page.songs.length, 'song')}, ${songs.length} may be sent${leftOut > 0 ? `, ${leftOut} left out by Zemer's list` : ''}`);
    if (songs.length === 0) throw new ZemerError(page.songs.length === 0 ? 'it has no songs I can get' : "none of its songs pass Zemer's list");
    return { album: toAlbum(page.album), songs, leftOut };
  }

  return {
    name: 'Zemer',
    hint: "it only has artists on Zemer's list",
    async find(query) {
      const words = parseQuery(query);
      if (words.length === 0) return { songs: [], albums: [], artists: [] };
      // Songs that can't be sent are not offered: "search" goes to music-table.com instead, "zemer" says why.
      if (youTube.turnsThisHostAway) throw new YouTubeMusicError(TURNED_AWAY);
      await whitelist.ready();
      if (!deps.zemer) return fromYouTube(words.join(' '), "Zemer's search is turned off");
      let results: ZemerResults;
      try {
        results = await deps.zemer.search(words.join(' '));
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        return fromYouTube(words.join(' '), err.message);
      }
      const releases = releasesIn(results.albums, results.singles);
      const songs: FoundSong[] = [];
      const seen = new Set<string>();
      for (const [list, video] of [[results.songs, false], [results.videos, true]] as const) {
        for (const song of list) {
          const ids = idsOf(song);
          if (seen.has(song.videoId) || !whitelist.allows(song.videoId, ids)) continue;
          seen.add(song.videoId);
          songs.push(found(song, ids, song.album ? releases.get(song.album.id) : undefined, { video }));
        }
      }
      const albums = once([...results.albums, ...results.singles].filter(allowedRelease)).map(toAlbum);
      const artists = results.artists.flatMap((artist): ArtistRef[] => {
        if (!whitelist.allows(artist.id, [artist.id])) return [];
        const aka = akaOf([artist.id]);
        return [{ id: artist.id, name: artist.name, ...(aka ? { aka } : {}) }];
      });
      note(
        `Zemer found ${plural(results.songs.length + results.videos.length, 'song')}, ${plural(results.albums.length + results.singles.length, 'album')} and ${plural(results.artists.length, 'artist')}; ${songs.length}, ${albums.length} and ${artists.length} pass Zemer's list`,
      );
      return { songs: once(songs), albums, artists };
    },
    async artist(artistId): Promise<ArtistPage | undefined> {
      if (!deps.zemer) return undefined;
      if (youTube.turnsThisHostAway) throw new YouTubeMusicError(TURNED_AWAY);
      await whitelist.ready();
      const page = await deps.zemer.artist(artistId);
      if (!page || !whitelist.allows(artistId, [artistId])) return undefined;
      const aka = akaOf([artistId]);
      const releases = releasesIn(page.albums, page.singles);
      const songs = once(
        [...page.songs]
          .filter((song) => whitelist.allows(song.videoId, [song.artistId ?? artistId]))
          .sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0)),
      ).map((song) => found(song, [song.artistId ?? artistId], song.album ? releases.get(song.album.id) : undefined));
      // Newest first by the album's year: its release date is when it went up on YouTube, which for an old album is
      // years later. The date only orders albums of the same year.
      const year = (release: ZemerRelease): number => release.year ?? (release.released ? new Date(release.released).getUTCFullYear() : 0);
      const day = (release: ZemerRelease): number => (release.released ? Date.parse(release.released) : 0);
      const albums = once(page.albums.filter(allowedRelease), (a, b) => (a.songs ?? 0) > (b.songs ?? 0))
        .sort((a, b) => year(b) - year(a) || day(b) - day(a))
        .map(toAlbum);
      const singles = page.singles.filter(allowedRelease).length;
      note(`Zemer has ${plural(songs.length, 'song')}, ${plural(albums.length, 'album')} and ${plural(singles, 'single')} by ${page.artist.name}`);
      return { artist: { id: page.artist.id, name: page.artist.name, ...(aka ? { aka } : {}) }, songs, albums, singles };
    },
    async fillIn(track) {
      // A song's number on its album, and its album's cover when it has only the video's picture, come from the album's page.
      const known = deps.catalog.albumOf?.(track.url);
      const videoId = youTube.parseTrackUrl(track.url);
      if (!known?.id || !videoId) return undefined;
      if (known.number && track.cover && track.cover !== videoPicture(videoId)) return undefined;
      const page = await albumPage(known.id);
      if (!page) return undefined;
      const at = page.songs.findIndex((song) => song.videoId === videoId);
      const number = at >= 0 ? (page.songs[at]!.number ?? at + 1) : known.number;
      const album: TrackAlbum = {
        id: known.id,
        title: page.album.title,
        artist: page.album.artist,
        songs: Math.max(page.album.songs ?? 0, page.songs.length),
        ...(number ? { number } : {}),
        ...(page.album.year ? { year: page.album.year } : {}),
      };
      return deps.catalog.add({ title: track.title, artist: track.artist, url: track.url, ...(page.album.cover ? { cover: page.album.cover } : {}), album });
    },
    albums: {
      name: 'Zemer',
      hint: "it only has artists on Zemer's list",
      async search(query, limit) {
        const words = parseQuery(query);
        if (words.length === 0) return [];
        await whitelist.ready();
        try {
          if (!deps.zemer) throw new ZemerError("Zemer's search is turned off");
          const results = await deps.zemer.search(words.join(' '));
          return once([...results.albums, ...results.singles].filter(allowedRelease)).slice(0, limit).map(toAlbum);
        } catch (err) {
          if (!(err instanceof SourceError) || !deps.fallback?.albums) throw err;
          return deps.fallback.albums.search(query, limit);
        }
      },
      open,
    },
  };
}
