import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudioCheck } from '../audio-check.ts';
import type { DownloadedAudio } from '../audio-fetch.ts';
import type { CachedAudio, Catalog, SitePost } from '../catalog.ts';
import type { Track } from '../types.ts';

type CacheIndex = Pick<Catalog, 'cachedAudio' | 'saveCachedAudio' | 'touchCachedAudio' | 'listCachedAudio' | 'forgetCachedAudio'>;

export interface AudioCacheOptions {
  /** The folder the files are kept in. */
  dir: string;
  /** Where the list of kept files lives (the catalog database). */
  index: CacheIndex;
  /** The most the folder may hold, in bytes. */
  maxBytes: number;
  /** The most files it may hold. */
  maxFiles?: number;
  now?: () => Date;
}

const EXTENSION: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/flac': 'flac' };

/**
 * Song files kept on this Mac, so a song that's asked for often (or is likely to be) is sent without downloading
 * it first. It holds at most `maxBytes` and `maxFiles`; when full, the files used least recently go first.
 */
export class AudioCache {
  readonly dir: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  #index: CacheIndex;
  #now: () => Date;

  constructor(options: AudioCacheOptions) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes;
    this.maxFiles = options.maxFiles ?? 50;
    this.#index = options.index;
    this.#now = options.now ?? (() => new Date());
  }

  has(url: string): boolean {
    return this.#index.cachedAudio(url) !== undefined;
  }

  /** What is known about a kept song, without reading the file. */
  peek(url: string): CachedAudio | undefined {
    return this.#index.cachedAudio(url);
  }

  /** The song from disk, or nothing when it isn't kept here (or its file went missing). */
  async get(url: string): Promise<DownloadedAudio | undefined> {
    const entry = this.#index.cachedAudio(url);
    if (!entry) return undefined;
    let data: Buffer;
    try {
      data = await readFile(join(this.dir, entry.file));
    } catch {
      this.#index.forgetCachedAudio(url);
      return undefined;
    }
    if (data.byteLength !== entry.bytes) {
      // A half-written or changed file is not to be trusted.
      this.#index.forgetCachedAudio(url);
      await rm(join(this.dir, entry.file), { force: true });
      return undefined;
    }
    this.#index.touchCachedAudio(url, this.#now());
    return { data: new Blob([new Uint8Array(data)], { type: entry.mimeType }), fileName: entry.fileName, mimeType: entry.mimeType, bytes: entry.bytes };
  }

  /** Keeps a downloaded song, then trims the folder to its limits. Songs in `keep` are never the ones removed. */
  async put(url: string, audio: DownloadedAudio, keep: ReadonlySet<string> = new Set()): Promise<void> {
    if (audio.bytes > this.maxBytes) return;
    await mkdir(this.dir, { recursive: true });
    const file = `${createHash('sha256').update(url).digest('hex').slice(0, 24)}.${EXTENSION[audio.mimeType] ?? 'audio'}`;
    const path = join(this.dir, file);
    // Written beside its final name, then renamed, so a crash never leaves a half file under the real name.
    await writeFile(`${path}.part`, new Uint8Array(await audio.data.arrayBuffer()));
    await rename(`${path}.part`, path);
    const at = this.#now().toISOString();
    this.#index.saveCachedAudio({ url, file, fileName: audio.fileName, mimeType: audio.mimeType, bytes: audio.bytes, fetchedAt: at, usedAt: at });
    await this.trim(new Set([...keep, url]));
  }

  /** Removes the least recently used files until the folder is within its limits, sparing those in `keep`. */
  async trim(keep: ReadonlySet<string> = new Set()): Promise<CachedAudio[]> {
    const entries = this.#index.listCachedAudio(); // least recently used first
    let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    let files = entries.length;
    const removed: CachedAudio[] = [];
    for (const entry of entries) {
      if (bytes <= this.maxBytes && files <= this.maxFiles) break;
      if (keep.has(entry.url)) continue;
      this.#index.forgetCachedAudio(entry.url);
      await rm(join(this.dir, entry.file), { force: true });
      bytes -= entry.bytes;
      files -= 1;
      removed.push(entry);
    }
    return removed;
  }

  stats(): { files: number; bytes: number } {
    const entries = this.#index.listCachedAudio();
    return { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
  }
}

/** A check that trusts a kept file (it was checked and downloaded already), so a kept song needs no request at all. */
export function cachedCheck(cache: AudioCache, checkAudio: (url: string) => Promise<AudioCheck>): (url: string) => Promise<AudioCheck> {
  return async (url) => {
    const kept = cache.peek(url);
    return kept ? { ok: true, type: kept.mimeType, bytes: kept.bytes } : checkAudio(url);
  };
}

/**
 * A downloader that looks on disk first. A song that isn't kept is downloaded as usual and then kept, so asking
 * again is instant; the folder's limits decide what stays.
 */
export function cachedFetch(
  cache: AudioCache,
  fetchAudio: (url: string, title?: string) => Promise<DownloadedAudio>,
  log: (line: string) => void = () => {},
): (url: string, title?: string) => Promise<DownloadedAudio> {
  return async (url, title) => {
    const kept = await cache.get(url);
    if (kept) return kept;
    const audio = await fetchAudio(url, title);
    try {
      await cache.put(url, audio);
    } catch (err) {
      log(`could not keep ${audio.fileName} for next time: ${err instanceof Error ? err.message : String(err)}`);
    }
    return audio;
  };
}

export interface KeepSources {
  catalog: Pick<Catalog, 'mostPlayed' | 'popularPosts' | 'newestPosts' | 'byUrl'>;
  /** The catalog address of a post's first song. */
  songUrl(post: SitePost): string;
  now?: () => Date;
}

/**
 * The songs worth having on disk before anyone asks: the ones you play most, the newest releases, and the most
 * viewed songs on the site from the last month. At most `limit`, without repeats, in that order of importance.
 */
export function songsToKeep(sources: KeepSources, limit: number): Track[] {
  const now = sources.now?.() ?? new Date();
  const picked = new Map<string, Track>();
  const take = (track: Track | undefined): void => {
    if (track && picked.size < limit && !picked.has(track.url)) picked.set(track.url, track);
  };
  const firstSong = (post: SitePost): Track | undefined => sources.catalog.byUrl(sources.songUrl(post));

  for (const track of sources.catalog.mostPlayed(Math.ceil(limit / 2))) take(track);
  for (const post of sources.catalog.newestPosts(5)) take(firstSong(post));
  for (const post of sources.catalog.popularPosts(new Date(now.getTime() - 30 * 24 * 60 * 60_000), limit)) take(firstSong(post));
  return [...picked.values()];
}

/**
 * Downloads the songs to keep that aren't on disk yet, one at a time with a pause between them so the site never
 * sees a burst, then trims the folder (sparing these songs). Returns what it did.
 */
export async function prefetch(options: {
  cache: AudioCache;
  songs: Track[];
  fetchAudio: (url: string, title?: string) => Promise<DownloadedAudio>;
  describe: (track: Track) => string;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Checked before each download; returning true stops early (the bot is shutting down). */
  stopped?: () => boolean;
}): Promise<{ downloaded: number; alreadyKept: number; failed: number }> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? (() => {});
  const keep = new Set(options.songs.map((track) => track.url));
  let downloaded = 0;
  let alreadyKept = 0;
  let failed = 0;
  for (const track of options.songs) {
    if (options.stopped?.()) break;
    if (options.cache.has(track.url)) {
      alreadyKept += 1;
      continue;
    }
    if (downloaded + failed > 0) await sleep(options.pauseMs ?? 3000);
    try {
      const title = options.describe(track);
      await options.cache.put(track.url, await options.fetchAudio(track.url, title), keep);
      downloaded += 1;
      log(`kept ready: ${title}`);
    } catch (err) {
      failed += 1;
      log(`could not get ${options.describe(track)} ready: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await options.cache.trim(keep);
  return { downloaded, alreadyKept, failed };
}
