import { dirname, join, resolve } from 'node:path';
import type { AudioCheck } from '../audio-check.ts';
import type { DownloadedAudio } from '../audio-fetch.ts';
import type { Catalog } from '../catalog.ts';
import type { MusicTable } from '../sources/music-table.ts';
import type { Reply, Track } from '../types.ts';
import { AudioCache, cachedCheck, cachedFetch } from './audio-cache.ts';
import { catalogBrowse, type Browse } from './browse.ts';
import { Categories } from './categories.ts';
import { catalogFollows, type Follows } from './follows.ts';
import { createPictures, type Picture, type PreparedPicture } from './images.ts';
import { LibraryJobs, type DailyTime } from './jobs.ts';

export interface LibraryOptions {
  catalog: Catalog;
  musicTable: MusicTable | undefined;
  /** The plain check and download (music-table.com links already resolved). */
  audio: {
    checkAudio(url: string): Promise<AudioCheck>;
    fetchAudio(url: string, title?: string): Promise<DownloadedAudio>;
  };
  /** The catalog file; the kept songs go in an "audio-cache" folder beside it. */
  dbPath: string;
  digestAt: DailyTime | undefined;
  /** Disk space for songs kept ready, in MB: Infinity for no limit, 0 for none kept. */
  prefetchMb: number;
  /** No alerts for new songs by followed artists in these hours. */
  quiet?: { from: DailyTime; to: DailyTime } | undefined;
  /** Told whether the site answers (for alerts on the Mac). */
  onSite?: (ok: boolean, problem?: string) => void;
  log: (line: string) => void;
}

/** What the chat routes need from the library: faster checks and downloads, pictures, and the background work. */
export interface Library {
  checkAudio(url: string): Promise<AudioCheck>;
  fetchAudio(url: string, title?: string): Promise<DownloadedAudio>;
  /** Album art ready to send: a song's card with its name drawn on, or the daily collage. */
  prepareImage(picture: Picture): Promise<PreparedPicture>;
  onPlay(track: Track): void;
  /** Lists: trending, new, artists, holidays. */
  browse: Browse;
  /** Artists you follow. */
  follows: Follows;
  /** Starts the sync, the songs kept ready and the daily message, which goes out through `announce`. */
  start(announce: (replies: Reply[]) => Promise<void>): void;
  stop(): Promise<void>;
  jobs: LibraryJobs | undefined;
  /** A few words for the start-up line. */
  summary: string;
}

/** Puts the song files kept on disk, album art, play counts and the background jobs around the plain check and download. */
export function setUpLibrary(options: LibraryOptions): Library {
  const { catalog, musicTable, audio, log } = options;
  const categories = musicTable ? new Categories({ musicTable, catalog }) : undefined;
  const limited = Number.isFinite(options.prefetchMb);
  const cache =
    options.prefetchMb > 0
      ? new AudioCache({ dir: join(dirname(resolve(options.dbPath)), 'audio-cache'), index: catalog, maxBytes: limited ? options.prefetchMb * 1024 * 1024 : undefined })
      : undefined;
  let jobs: LibraryJobs | undefined;
  const at = options.digestAt;
  const parts = [
    musicTable ? (at ? `daily new-music message at ${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}` : 'daily message off') : '',
    cache ? (limited ? `up to ${options.prefetchMb} MB of songs kept ready` : 'songs kept ready, no size limit') : 'no songs kept ready',
  ].filter(Boolean);

  return {
    checkAudio: cache ? cachedCheck(cache, audio.checkAudio) : audio.checkAudio,
    fetchAudio: cache ? cachedFetch(cache, audio.fetchAudio, log) : audio.fetchAudio,
    prepareImage: createPictures({ log }),
    onPlay: (track) => catalog.recordPlay(track.id),
    browse: catalogBrowse(catalog, undefined, categories),
    follows: catalogFollows(catalog),
    start(announce) {
      if (!musicTable) return;
      jobs = new LibraryJobs({
        musicTable,
        catalog,
        announce,
        digestAt: at,
        cache,
        fetchAudio: audio.fetchAudio,
        log,
        categories,
        quiet: options.quiet,
        ...(options.onSite ? { onSite: options.onSite } : {}),
      });
      jobs.start();
    },
    async stop() {
      await jobs?.stop();
    },
    get jobs() {
      return jobs;
    },
    summary: parts.join(', '),
  };
}
