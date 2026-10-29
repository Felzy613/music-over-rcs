import { dirname, join, resolve } from 'node:path';
import type { AudioCheck } from '../audio-check.ts';
import type { DownloadedAudio } from '../audio-fetch.ts';
import type { Catalog } from '../catalog.ts';
import type { MusicTable } from '../sources/music-table.ts';
import type { NewReleases } from '../sources/zemer-releases.ts';
import type { Reply, Track } from '../types.ts';
import { AudioCache, cachedCheck, cachedFetch, taggedFetch } from './audio-cache.ts';
import { catalogBrowse, type Browse } from './browse.ts';
import { Categories } from './categories.ts';
import { catalogFollows, type Follows } from './follows.ts';
import { createImageFetcher } from '../image-fetch.ts';
import type { CoverPicture } from './id3.ts';
import { createPictures, type Picture, type PreparedPicture } from './images.ts';
import { LibraryJobs, type DailyTime } from './jobs.ts';
import { catalogNaming, namedFetch } from './naming.ts';
import { SongArchive, type Drive } from '../archive/archiver.ts';

/** Songs aren't kept on this Mac when that would leave its disk with less free than this (they're still sent). */
const MIN_FREE_BYTES = 5 * 1024 ** 3;

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
  /** A folder (on an external drive, say) the kept songs move into whenever it's there. */
  archiveDir?: string | undefined;
  /** Told how that folder is doing: nothing when fine, or what's wrong. */
  onArchive?: (problem: string | undefined) => void;
  /** No alerts for new songs by followed artists in these hours. */
  quiet?: { from: DailyTime; to: DailyTime } | undefined;
  /** Told whether the site answers (for alerts on the Mac). */
  onSite?: (ok: boolean, problem?: string) => void;
  /** Zemer's new releases: "new" lists them with the site's, and the daily message and the alerts carry them. */
  releases?: NewReleases | undefined;
  /** Told when Zemer's feed has been failing for hours (with what is wrong) and when it works again (undefined). */
  onReleases?: (ok: boolean, problem?: string) => void;
  /** A cloud folder (OneDrive) every song sent is also saved to, in the background, sorted and tagged. */
  cloudFolder?: Drive | undefined;
  /** The most to save to it in a calendar month, in bytes (it shares the host's outbound traffic with the songs sent). Undefined for no limit. */
  cloudMonthlyBytes?: number | undefined;
  /** Where the host's memory stands, for holding back a song that would not fit (see SongArchive). Undefined for no limit. */
  cloudMemory?: (() => { limit: number; used: number } | undefined) | undefined;
  /** Whether a song or an album is on its way to the chat: a copy to the cloud folder waits until it isn't. */
  cloudBusy?: (() => boolean) | undefined;
  /** Told when saving to it starts failing (with what is wrong) and when it works again (undefined). */
  onCloudFolder?: ((problem: string | undefined, needsLogin: boolean) => void) | undefined;
  log: (line: string) => void;
}

/** What the chat routes need from the library: faster checks and downloads, pictures, and the background work. */
export interface Library {
  checkAudio(url: string): Promise<AudioCheck>;
  /** A song ready to send, tagged once `after` (its album being looked up) is done. */
  fetchAudio(url: string, title?: string, extra?: { after?: Promise<unknown> }): Promise<DownloadedAudio>;
  /** Album art ready to send: a song's card with its name drawn on, or the daily collage. */
  prepareImage(picture: Picture): Promise<PreparedPicture>;
  /** The background saving of sent songs to the cloud folder, when there is one. */
  archive: SongArchive | undefined;
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
  const naming = catalogNaming(catalog);
  const cache =
    options.prefetchMb > 0
      ? new AudioCache({
          dir: join(dirname(resolve(options.dbPath)), 'audio-cache'),
          archiveDir: options.archiveDir,
          index: catalog,
          placeOf: naming.placeOf,
          tagsOf: naming.tagsOf,
          fetchCover: coverFetcher(),
          maxBytes: limited ? options.prefetchMb * 1024 * 1024 : undefined,
          minFreeBytes: MIN_FREE_BYTES,
        })
      : undefined;
  const archive = options.cloudFolder
    ? new SongArchive({
        drive: options.cloudFolder,
        state: catalog,
        placeOf: naming.placeOf,
        monthlyBudgetBytes: options.cloudMonthlyBytes,
        memory: options.cloudMemory,
        busy: options.cloudBusy,
        onProblem: options.onCloudFolder,
        log,
      })
    : undefined;
  // Every song sent has its tags and cover written in, so it files itself properly in a music app on the phone.
  const named = taggedFetch(namedFetch(cache ? cachedFetch(cache, audio.fetchAudio, log) : audio.fetchAudio, naming.fileNameOf), {
    tagsOf: naming.tagsOf,
    fetchCover: coverFetcher(),
    log,
  });
  let jobs: LibraryJobs | undefined;
  const at = options.digestAt;
  const parts = [
    musicTable ? (at ? `daily new-music message at ${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}` : 'daily message off') : '',
    options.releases ? "Zemer's new releases in the lists, the daily message and the alerts" : '',
    cache ? (limited ? `up to ${options.prefetchMb} MB of songs kept ready` : 'songs kept ready, no size limit') : 'no songs kept ready',
    cache ? `sorted by artist and album${cache.archiveDir ? ` in ${cache.archiveDir} whenever it's there` : ''}` : '',
    archive ? (options.cloudFolder?.connected() ? 'songs sent are saved to OneDrive' : 'OneDrive is set up but not signed in') : '',
  ].filter(Boolean);

  return {
    checkAudio: cache ? cachedCheck(cache, audio.checkAudio) : audio.checkAudio,
    // A song fetched to be sent is also offered to the cloud folder; that happens in the background, after this returns.
    fetchAudio: archive
      ? async (url, title, extra) => {
          const song = await named(url, title, extra);
          archive.offer(url, song);
          return song;
        }
      : named,
    prepareImage: createPictures({ log }),
    archive,
    onPlay: (track) => catalog.recordPlay(track.id),
    browse: catalogBrowse(catalog, undefined, categories, options.releases),
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
        releases: options.releases,
        ...(options.onReleases ? { onReleases: options.onReleases } : {}),
        ...(options.onSite ? { onSite: options.onSite } : {}),
        ...(options.onArchive ? { onArchive: options.onArchive } : {}),
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

/** Gets a song's cover to put in its file. */
function coverFetcher(): (url: string) => Promise<CoverPicture | undefined> {
  const fetchImage = createImageFetcher({ remember: 8 });
  return async (url) => {
    const image = await fetchImage(url);
    return { data: new Uint8Array(await image.data.arrayBuffer()), mimeType: image.mimeType };
  };
}
