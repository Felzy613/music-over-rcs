import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import type { AudioCheck } from '../audio-check.ts';
import type { DownloadedAudio } from '../audio-fetch.ts';
import type { CachedAudio, Catalog, SitePost } from '../catalog.ts';
import type { Track } from '../types.ts';

type CacheIndex = Pick<Catalog, 'cachedAudio' | 'saveCachedAudio' | 'touchCachedAudio' | 'listCachedAudio' | 'forgetCachedAudio'>;

export interface AudioCacheOptions {
  /** The folder on this Mac that songs are downloaded into. */
  dir: string;
  /**
   * A folder (on an external drive, say) that the songs are moved into whenever it's there (`archive`), so they
   * don't fill this Mac. The folder it goes in must exist; it is made inside it.
   */
  archiveDir?: string | undefined;
  /** Where the list of kept files lives (the catalog database). */
  index: CacheIndex;
  /** The most the songs on this Mac may take, in bytes. No limit when left out. */
  maxBytes?: number | undefined;
  /** The most songs on this Mac. No limit when left out. */
  maxFiles?: number | undefined;
  /** A song isn't kept when this Mac's disk would have less free than this, in bytes (it's still sent). */
  minFreeBytes?: number | undefined;
  now?: () => Date;
}

/** Whether the archive folder can be used: there, its drive not connected, or macOS not letting the bot in. */
export type ArchiveState = 'ok' | 'offline' | 'denied';

const EXTENSION: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/flac': 'flac' };

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;
/** How a path is compared with another: Mac disks ignore case. */
const pathKey = (path: string): string => path.normalize('NFC').toLowerCase();

/**
 * Song files kept on disk, so a song that's asked for often (or is likely to be) is sent without downloading it
 * first. Songs are downloaded into a folder on this Mac; with an archive folder set, they move there whenever it's
 * there, under their own names ("Artist — Title.mp3"), and are read from there. While its drive isn't connected,
 * the songs on it are downloaded again when asked for, and kept on this Mac until it's back.
 *
 * Every song stays, unless limits are set (`maxBytes`, `maxFiles`, for the songs on this Mac); then, when full, the
 * files used least recently go first. Nothing in the archive is ever deleted.
 */
export class AudioCache {
  readonly dir: string;
  readonly archiveDir: string | undefined;
  readonly maxBytes: number;
  readonly maxFiles: number;
  #index: CacheIndex;
  #now: () => Date;
  #minFreeBytes: number;

  constructor(options: AudioCacheOptions) {
    this.dir = options.dir;
    this.archiveDir = options.archiveDir;
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
    this.#minFreeBytes = options.minFreeBytes ?? 0;
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

  /** Where a kept song's file is: a name in the folder on this Mac, or a full path once it's in the archive. */
  pathOf(entry: CachedAudio): string {
    return isAbsolute(entry.file) ? entry.file : join(this.dir, entry.file);
  }

  /** The song from disk, or nothing when it isn't kept, its file went missing, or its drive isn't connected. */
  async get(url: string): Promise<DownloadedAudio | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const entry = this.#index.cachedAudio(url);
      if (!entry) return undefined;
      const path = this.pathOf(entry);
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch {
        // Moved to the archive just now: read it from there.
        if (this.#index.cachedAudio(url)?.file !== entry.file) continue;
        // On a drive that isn't connected: it's kept for when it is, and downloaded meanwhile.
        if (!existsSync(dirname(path))) return undefined;
        this.#index.forgetCachedAudio(url);
        return undefined;
      }
      if (data.byteLength === 0) {
        this.#index.forgetCachedAudio(url);
        return undefined;
      }
      // Another size means the file was changed where it's kept (its tags edited in a music app, say). It's still
      // the song, so it's sent as it is now.
      if (data.byteLength !== entry.bytes) this.#index.saveCachedAudio({ ...entry, bytes: data.byteLength });
      this.#index.touchCachedAudio(url, this.#now());
      return { data: new Blob([new Uint8Array(data)], { type: entry.mimeType }), fileName: entry.fileName, mimeType: entry.mimeType, bytes: data.byteLength };
    }
    return undefined;
  }

  /**
   * Keeps a downloaded song in the folder on this Mac (from where `archive` moves it), then trims that folder to its
   * limits, if any. Songs in `keep` are never the ones removed. When this Mac's disk is nearly full, it isn't kept.
   */
  async put(url: string, audio: DownloadedAudio, keep: ReadonlySet<string> = new Set()): Promise<void> {
    if (audio.bytes > this.maxBytes) return;
    await mkdir(this.dir, { recursive: true });
    if (this.#minFreeBytes > 0 && (await freeBytes(this.dir)) - audio.bytes < this.#minFreeBytes) return;
    const file = `${createHash('sha256').update(url).digest('hex').slice(0, 24)}.${EXTENSION[audio.mimeType] ?? 'audio'}`;
    const path = join(this.dir, file);
    // Written beside its final name, then renamed, so a crash never leaves a half file under the real name.
    await writeFile(`${path}.part`, new Uint8Array(await audio.data.arrayBuffer()));
    await rename(`${path}.part`, path);
    const at = this.#now().toISOString();
    this.#index.saveCachedAudio({ url, file, fileName: audio.fileName, mimeType: audio.mimeType, bytes: audio.bytes, fetchedAt: at, usedAt: at });
    await this.trim(new Set([...keep, url]));
  }

  /**
   * Removes the songs on this Mac used least recently until it's within the limits, sparing those in `keep`. Songs
   * in the archive don't count, and are never removed.
   */
  async trim(keep: ReadonlySet<string> = new Set()): Promise<CachedAudio[]> {
    const entries = this.#index.listCachedAudio().filter((entry) => !isAbsolute(entry.file)); // least recently used first
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

  /**
   * Whether the archive folder can be used now. It's made when missing, but only inside a folder that's there, so
   * nothing is ever made where an unplugged drive would be. Nothing when there's no archive.
   */
  async archiveState(): Promise<ArchiveState | undefined> {
    const dir = this.archiveDir;
    if (!dir) return undefined;
    try {
      return (await stat(dir)).isDirectory() ? 'ok' : 'offline';
    } catch (err) {
      if (errorCode(err) === 'EPERM' || errorCode(err) === 'EACCES') return 'denied';
      if (errorCode(err) !== 'ENOENT') return 'offline';
    }
    try {
      await mkdir(dir);
      return 'ok';
    } catch (err) {
      return errorCode(err) === 'EPERM' || errorCode(err) === 'EACCES' ? 'denied' : 'offline';
    }
  }

  /**
   * Moves the songs on this Mac into the archive, when it's there. Each is copied under its own name ("Artist —
   * Title.mp3"; "(2)" when another kept song has that name), checked, recorded at its new place, and only then
   * removed here. A song that can't be moved stays here and is tried again next time.
   */
  async archive(): Promise<{ state: ArchiveState | undefined; moved: number; failed: number; error?: string }> {
    const state = await this.archiveState();
    if (state !== 'ok') return { state, moved: 0, failed: 0 };
    const archiveDir = this.archiveDir!;
    const entries = this.#index.listCachedAudio();
    const taken = new Set(entries.filter((entry) => isAbsolute(entry.file)).map((entry) => pathKey(entry.file)));
    let moved = 0;
    let failed = 0;
    let error: string | undefined;
    for (const entry of entries) {
      if (isAbsolute(entry.file)) continue;
      const from = join(this.dir, entry.file);
      const to = archiveName(archiveDir, entry.fileName, taken);
      try {
        await copyFile(from, `${to}.part`);
        const [copied, original] = await Promise.all([stat(`${to}.part`), stat(from)]);
        if (copied.size !== original.size) throw new Error(`the copy has ${copied.size} bytes, not ${original.size}`);
        await rename(`${to}.part`, to);
        const now = this.#index.cachedAudio(entry.url);
        if (!now || isAbsolute(now.file)) {
          // Forgotten (or moved by someone else) meanwhile: the copy isn't needed.
          if (!now || pathKey(now.file) !== pathKey(to)) await rm(to, { force: true });
          continue;
        }
        this.#index.saveCachedAudio({ ...now, file: to, bytes: copied.size });
        taken.add(pathKey(to));
        await rm(from, { force: true });
        moved += 1;
      } catch (err) {
        failed += 1;
        error = err instanceof Error ? err.message : String(err);
        await rm(`${to}.part`, { force: true }).catch(() => {});
        // The drive went away mid-way: the rest wait for next time.
        if ((await this.archiveState()) !== 'ok') break;
      }
    }
    return { state: 'ok', moved, failed, ...(error ? { error } : {}) };
  }

  stats(): { files: number; bytes: number } {
    const entries = this.#index.listCachedAudio();
    return { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
  }

  /** The songs on this Mac, and those in the archive. */
  where(): { here: { files: number; bytes: number }; archived: { files: number; bytes: number } } {
    const here = { files: 0, bytes: 0 };
    const archived = { files: 0, bytes: 0 };
    for (const entry of this.#index.listCachedAudio()) {
      const into = isAbsolute(entry.file) ? archived : here;
      into.files += 1;
      into.bytes += entry.bytes;
    }
    return { here, archived };
  }
}

/** A name in the archive for a song: its own, or with "(2)", "(3)"… when another kept song has it. */
function archiveName(dir: string, fileName: string, taken: ReadonlySet<string>): string {
  const extension = extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length) || 'track';
  for (let n = 1; ; n += 1) {
    const path = join(dir, n === 1 ? `${stem}${extension}` : `${stem} (${n})${extension}`);
    // A name no kept song uses is free. A file there by that name is an earlier copy of the same song (one asked
    // for again while the drive was away), which this one replaces.
    if (!taken.has(pathKey(path))) return path;
  }
}

/** Free space on the disk a folder is on, in bytes (unlimited if it can't be told). */
async function freeBytes(dir: string): Promise<number> {
  try {
    const disk = await statfs(dir);
    return disk.bavail * disk.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
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
