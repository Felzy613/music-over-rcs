import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, rmdir, stat, statfs, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import type { AudioCheck } from '../audio-check.ts';
import type { DownloadedAudio } from '../audio-fetch.ts';
import type { CachedAudio, Catalog, SitePost } from '../catalog.ts';
import type { Track } from '../types.ts';
import { audioTypeOf, hasCover, writeTags, type CoverPicture, type SongTags } from './id3.ts';
import { hasMp4Cover, writeMp4Tags } from './mp4.ts';
import { cleanName, extensionOf } from './naming.ts';

type CacheIndex = Pick<Catalog, 'cachedAudio' | 'saveCachedAudio' | 'touchCachedAudio' | 'listCachedAudio' | 'forgetCachedAudio'>;

export interface AudioCacheOptions {
  /** The folder on this Mac that songs are downloaded into. */
  dir: string;
  /**
   * A folder (on an external drive, say) that the songs are moved into whenever it's there (`organize`), so they
   * don't fill this Mac. The folder it goes in must exist; it is made inside it.
   */
  archiveDir?: string | undefined;
  /** Where the list of kept files lives (the catalog database). */
  index: CacheIndex;
  /**
   * Where a song goes inside either folder, sorted and named like a music library: "Artist/Album/01 Title.mp3". When
   * left out, a song goes in no folder, under the name it was downloaded with.
   */
  placeOf?: ((url: string, audio: { fileName: string; mimeType: string }) => string) | undefined;
  /** The tags written into each MP3 and M4A kept (artist, album, number, title), so music apps show it right. None when left out. */
  tagsOf?: ((url: string, audio: { fileName: string; mimeType: string }) => SongTags | undefined) | undefined;
  /** Gets a cover, for a song that has none. */
  fetchCover?: ((url: string) => Promise<CoverPicture | undefined>) | undefined;
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

/** What a round of `organize` did. */
export interface Organized {
  state: ArchiveState | undefined;
  /** Songs moved from this Mac to the drive. */
  moved: number;
  /** Songs moved into their place within the folder they were in (kept before songs were sorted, or renamed since). */
  sorted: number;
  /** Songs whose tags were written (kept before songs were tagged, or their names changed since). */
  tagged: number;
  failed: number;
  error?: string;
}

/** Song types that have ID3 tags. */
const MP3 = /mpeg|mp3|mpg/i;

/** How a song's tags are written, by its type: ID3 in an MP3, iTunes-style in an M4A. */
interface Tagger {
  write(data: Uint8Array, tags: SongTags, cover?: CoverPicture): Uint8Array | undefined;
  hasCover(data: Uint8Array): boolean;
}
const taggerFor = (mimeType: string): Tagger | undefined =>
  MP3.test(mimeType) ? { write: writeTags, hasCover } : /mp4|m4a/i.test(mimeType) ? { write: writeMp4Tags, hasCover: hasMp4Cover } : undefined;

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | null)?.code;
/** How a path is compared with another: Mac disks ignore case. */
const pathKey = (path: string): string => path.normalize('NFC').toLowerCase();
/** Whether a path is inside a folder (not the folder itself). */
const isInside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/**
 * Song files kept on disk, so a song that's asked for often (or is likely to be) is sent without downloading it
 * first. They're sorted like a music library ("Artist/Album/01 Title.mp3", see `placeOf`). Songs are downloaded into
 * a folder on this Mac; with an archive folder set, they move there whenever it's there, into the same places, and
 * are read from there. While its drive isn't connected, the songs on it are downloaded again when asked for, and kept
 * on this Mac until it's back.
 *
 * Every song stays, unless limits are set (`maxBytes`, `maxFiles`, for the songs on this Mac); then, when full, the
 * files used least recently go first. Nothing in the archive is ever deleted or written over, except a song's own
 * earlier copy.
 */
export class AudioCache {
  readonly dir: string;
  readonly archiveDir: string | undefined;
  readonly maxBytes: number;
  readonly maxFiles: number;
  #index: CacheIndex;
  #now: () => Date;
  #minFreeBytes: number;
  #placeOf: AudioCacheOptions['placeOf'];
  #tagsOf: AudioCacheOptions['tagsOf'];
  #fetchCover: AudioCacheOptions['fetchCover'];
  /** Songs being moved right now, so a read that misses the file waits for the move instead of giving up. */
  #moving = new Map<string, Promise<void>>();

  constructor(options: AudioCacheOptions) {
    this.dir = options.dir;
    this.archiveDir = options.archiveDir;
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    this.maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
    this.#minFreeBytes = options.minFreeBytes ?? 0;
    this.#index = options.index;
    this.#placeOf = options.placeOf;
    this.#tagsOf = options.tagsOf;
    this.#fetchCover = options.fetchCover;
    this.#now = options.now ?? (() => new Date());
  }

  has(url: string): boolean {
    return this.#index.cachedAudio(url) !== undefined;
  }

  /** What is known about a kept song, without reading the file. */
  peek(url: string): CachedAudio | undefined {
    return this.#index.cachedAudio(url);
  }

  /** Where a kept song's file is: a path in the folder on this Mac, or a full path once it's in the archive. */
  pathOf(entry: CachedAudio): string {
    return isAbsolute(entry.file) ? entry.file : join(this.dir, entry.file);
  }

  /** The song from disk, or nothing when it isn't kept, its file went missing, or its drive isn't connected. */
  async get(url: string): Promise<DownloadedAudio | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const entry = this.#index.cachedAudio(url);
      if (!entry) return undefined;
      const path = this.pathOf(entry);
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch {
        // Being moved, or moved just now: read it from its new place.
        const moving = this.#moving.get(url);
        if (moving) await moving;
        if (moving || this.#index.cachedAudio(url)?.file !== entry.file) continue;
        // On a drive that isn't connected: it's kept for when it is, and downloaded meanwhile.
        if (!existsSync(this.#rootOf(path))) return undefined;
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
   * Keeps a downloaded song in the folder on this Mac, in its place and with its tags written (from where `organize`
   * moves it to the drive), then trims that folder to its limits, if any. Songs in `keep` are never the ones removed.
   * When this Mac's disk is nearly full, it isn't kept. Gives back the song as kept, tags and all, to be sent.
   */
  async put(url: string, downloaded: DownloadedAudio, keep: ReadonlySet<string> = new Set()): Promise<DownloadedAudio> {
    const { audio, tags } = await this.#tagged(url, downloaded);
    if (audio.bytes > this.maxBytes) return audio;
    await mkdir(this.dir, { recursive: true });
    if (this.#minFreeBytes > 0 && (await freeBytes(this.dir)) - audio.bytes < this.#minFreeBytes) return audio;
    const entries = this.#index.listCachedAudio();
    const before = entries.find((entry) => entry.url === url);
    const path = this.#freePath(this.dir, this.#place(url, audio), url, usedPaths(this, entries), []);
    await mkdir(dirname(path), { recursive: true });
    // Written beside its final name, then renamed, so a crash never leaves a half file under the real name.
    await writeFile(`${path}.part`, new Uint8Array(await audio.data.arrayBuffer()));
    await rename(`${path}.part`, path);
    const at = this.#now().toISOString();
    // A copy kept before on the drive (away just now) is replaced when this one moves there.
    const replaces = before ? (isAbsolute(before.file) ? before.file : before.replaces) : undefined;
    this.#index.saveCachedAudio({
      url,
      file: relative(this.dir, path),
      fileName: audio.fileName,
      mimeType: audio.mimeType,
      bytes: audio.bytes,
      fetchedAt: at,
      usedAt: at,
      ...(replaces ? { replaces } : {}),
      ...(tags ? { tags } : {}),
    });
    if (before && !isAbsolute(before.file) && pathKey(this.pathOf(before)) !== pathKey(path)) await removeFile(this.pathOf(before), this.dir);
    await this.trim(new Set([...keep, url]));
    return audio;
  }

  /**
   * The song with its tags written, and the record of them. The record is left out when a cover is still to be added
   * (that needs a download, so `organize` does it, not the request waiting for the song).
   */
  async #tagged(url: string, downloaded: DownloadedAudio): Promise<{ audio: DownloadedAudio; tags?: string }> {
    if (!taggerFor(downloaded.mimeType)) return { audio: downloaded };
    const data = new Uint8Array(await downloaded.data.arrayBuffer());
    // Called an MP3 but really an M4A, say: kept, tagged and sent as what it is.
    const retyped = asItIs(downloaded, data);
    const audio = retyped === downloaded ? downloaded : { ...retyped, data: new Blob([data], { type: retyped.mimeType }) };
    const tagger = taggerFor(audio.mimeType);
    const tags = tagger && this.#tagsOf?.(url, audio);
    if (!tagger || !tags) return { audio };
    const written = tagger.write(data, tags);
    if (!written) return { audio, tags: JSON.stringify(tags) }; // a file whose tags can't be written: left as it is, now and later
    return {
      audio: { ...audio, data: new Blob([written], { type: audio.mimeType }), bytes: written.byteLength },
      ...(tags.cover && !tagger.hasCover(written) ? {} : { tags: JSON.stringify(tags) }),
    };
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
      await removeFile(this.pathOf(entry), this.dir);
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
   * Writes the tags into a kept song's file when they aren't the ones it should have: it was kept before songs were
   * tagged, its cover was still to be added, or its name changed since. Tags you edit yourself are left alone until
   * then. Gives whether the file was written.
   */
  async #retag(entry: CachedAudio, path: string, tags: SongTags, record: string): Promise<boolean> {
    const data = new Uint8Array(await readFile(path));
    // Called an MP3 but really an M4A, say: typed as what it is (so it's renamed to match), and tagged that way.
    const tagger = taggerFor(asItIs(entry, data).mimeType);
    let cover: CoverPicture | undefined;
    if (tagger && tags.cover && this.#fetchCover && !tagger.hasCover(data)) cover = await this.#fetchCover(tags.cover).catch(() => undefined);
    const written = tagger?.write(data, tags, cover);
    const now = this.#index.cachedAudio(entry.url);
    if (!now || now.file !== entry.file) return false; // moved or forgotten meanwhile: next time
    if (!written) {
      this.#index.saveCachedAudio({ ...asItIs(now, data), tags: record });
      return false;
    }
    // Written beside it, then renamed over it: a reader sees the old file or the new one, never half of one.
    await writeFile(`${path}.part`, written);
    await rename(`${path}.part`, path);
    this.#index.saveCachedAudio({ ...asItIs(now, data), bytes: written.byteLength, tags: record });
    return true;
  }

  /**
   * Puts every kept song in its place, with its tags. The songs on this Mac move into the archive, when it's there: each is copied,
   * checked, recorded at its new place, and only then removed here. A song that isn't in its place yet (kept before
   * songs were sorted, or its name changed since) moves there within the folder it's in. "(2)" is added when another
   * song has the name. A song that can't be moved stays where it is and is tried again next time.
   */
  async organize(): Promise<Organized> {
    const state = await this.archiveState();
    const archiveDir = state === 'ok' ? this.archiveDir : undefined;
    const result: Organized = { state, moved: 0, sorted: 0, tagged: 0, failed: 0 };
    const failed = async (err: unknown, onDrive: boolean): Promise<boolean> => {
      result.failed += 1;
      result.error = err instanceof Error ? err.message : String(err);
      // The drive went away mid-way: the rest wait for next time.
      return onDrive && (await this.archiveState()) !== 'ok';
    };

    for (const entry of this.#tagsOf ? this.#index.listCachedAudio() : []) {
      const tags = taggerFor(entry.mimeType) ? this.#tagsOf!(entry.url, entry) : undefined;
      const record = tags && JSON.stringify(tags);
      const path = this.pathOf(entry);
      const onDrive = isAbsolute(entry.file);
      if (!tags || !record || entry.tags === record || (onDrive && !(archiveDir && isInside(archiveDir, path)))) continue;
      try {
        if (await this.#retag(entry, path, tags, record)) result.tagged += 1;
      } catch (err) {
        if (errorCode(err) === 'ENOENT') continue; // gone: forgotten when it's next asked for
        await rm(`${path}.part`, { force: true }).catch(() => {});
        if (await failed(err, onDrive)) return result;
      }
    }

    const entries = this.#index.listCachedAudio();
    const used = usedPaths(this, entries);
    for (const entry of entries) {
      const from = this.pathOf(entry);
      const onDrive = isAbsolute(entry.file);
      // A song on the drive is sorted only while the drive is there, and only in the archive folder set now.
      if (onDrive && !(archiveDir && isInside(archiveDir, from))) continue;
      const root = archiveDir ?? this.dir;
      const place = this.#place(entry.url, entry);
      const toDrive = !onDrive && !!archiveDir;
      if (!toDrive && inPlace(root, from, place)) continue;
      const to = this.#freePath(root, place, entry.url, used, toDrive ? [entry.replaces] : [from]);
      let done: () => void = () => {};
      this.#moving.set(entry.url, new Promise<void>((resolve) => (done = resolve)));
      try {
        await mkdir(dirname(to), { recursive: true });
        if (toDrive) {
          await copyFile(from, `${to}.part`);
          const [copied, original] = await Promise.all([stat(`${to}.part`), stat(from)]);
          if (copied.size !== original.size) throw new Error(`the copy has ${copied.size} bytes, not ${original.size}`);
          await rename(`${to}.part`, to);
          const now = this.#index.cachedAudio(entry.url);
          if (!now || now.file !== entry.file) {
            // Forgotten or kept again meanwhile: this copy isn't the one wanted.
            if (pathKey(now ? this.pathOf(now) : '') !== pathKey(to)) await removeFile(to, root);
            continue;
          }
          this.#index.saveCachedAudio({ ...now, file: to, bytes: copied.size, replaces: undefined });
          await removeFile(from, this.dir);
          // The earlier copy it replaces, when that was under another name, isn't needed: one copy of a song is kept.
          if (entry.replaces && pathKey(entry.replaces) !== pathKey(to) && !used.has(pathKey(entry.replaces)) && isInside(archiveDir!, entry.replaces)) {
            await removeFile(entry.replaces, archiveDir!);
          }
          result.moved += 1;
        } else {
          // Within one disk a move is a rename: nothing is copied, and the file is never missing.
          await rename(from, to);
          this.#index.saveCachedAudio({ ...entry, file: onDrive ? to : relative(this.dir, to) });
          await pruneEmpty(dirname(from), root);
          result.sorted += 1;
        }
        used.delete(pathKey(from));
        used.set(pathKey(to), entry.url);
      } catch (err) {
        if (toDrive) await rm(`${to}.part`, { force: true }).catch(() => {});
        if (await failed(err, !!archiveDir)) break;
      } finally {
        this.#moving.delete(entry.url);
        done();
      }
    }
    return result;
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

  /** A song's place inside either folder: "Artist/Album/01 Title.mp3", each part a tidy name. */
  #place(url: string, audio: { fileName: string; mimeType: string }): string {
    const parts = (this.#placeOf?.(url, audio) ?? audio.fileName)
      .split(/[\\/]+/)
      .map((part) => cleanName(part))
      .filter(Boolean);
    return parts.length > 0 ? parts.join('/') : `${createHash('sha256').update(url).digest('hex').slice(0, 24)}${extensionOf(audio)}`;
  }

  /**
   * A free path for a song in a folder: its place, or with "(2)", "(3)"… when another kept song is there. On the drive
   * a file that isn't kept here (yours, say) is never written over either; only the paths in `own` may be.
   */
  #freePath(root: string, place: string, url: string, used: ReadonlyMap<string, string>, own: Array<string | undefined>): string {
    const mine = new Set(own.filter((path): path is string => !!path).map(pathKey));
    const extension = extname(place);
    const stem = place.slice(0, place.length - extension.length);
    for (let n = 1; ; n += 1) {
      const path = join(root, n === 1 ? place : `${stem} (${n})${extension}`);
      const key = pathKey(path);
      const owner = used.get(key);
      if (owner !== undefined && owner !== url) continue;
      if (root !== this.dir && !mine.has(key) && owner === undefined && existsSync(path)) continue;
      return path;
    }
  }

  /** The folder whose absence means a song's drive isn't connected: the archive folder, or the one the file is in. */
  #rootOf(path: string): string {
    return this.archiveDir && isInside(this.archiveDir, path) ? this.archiveDir : dirname(path);
  }
}

/** A song called an MP3 that's really something else (an M4A, say), typed and named as what it is. */
function asItIs<T extends { fileName: string; mimeType: string }>(audio: T, data: Uint8Array): T {
  const actual = audioTypeOf(data);
  if (!actual || MP3.test(actual) || !MP3.test(audio.mimeType)) return audio;
  return { ...audio, mimeType: actual, fileName: `${audio.fileName.replace(/\.[a-z0-9]{2,5}$/i, '')}${extensionOf({ fileName: '', mimeType: actual })}` };
}

/** Which kept song each path belongs to. */
function usedPaths(cache: AudioCache, entries: CachedAudio[]): Map<string, string> {
  return new Map(entries.map((entry) => [pathKey(cache.pathOf(entry)), entry.url]));
}

/** Whether a file is at its place already, or at its place with "(2)", "(3)"… (another song had the name). */
function inPlace(root: string, path: string, place: string): boolean {
  const here = pathKey(relative(root, path));
  const wanted = pathKey(place);
  if (here === wanted) return true;
  const extension = extname(wanted);
  const stem = wanted.slice(0, wanted.length - extension.length);
  return here.startsWith(`${stem} (`) && here.endsWith(`)${extension}`) && /^\d+$/.test(here.slice(stem.length + 2, here.length - extension.length - 1));
}

/** Removes a file, then the folders that leaves empty, up to (not including) `root`. */
async function removeFile(path: string, root: string): Promise<void> {
  await rm(path, { force: true });
  await pruneEmpty(dirname(path), root);
}

/** Removes a folder if it's empty, then its parents while they are, up to (not including) `root`. Nothing else. */
async function pruneEmpty(dir: string, root: string): Promise<void> {
  for (let current = dir; isInside(root, current); current = dirname(current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
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
      return await cache.put(url, audio);
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
