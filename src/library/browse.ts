import type { Catalog, ListedEntry, ListedRelease, ListedTrack, NewRelease } from '../catalog.ts';
import { releaseKey } from '../ranking.ts';
import { splitTitle } from '../sources/titles.ts';
import type { NewReleases } from '../sources/zemer-releases.ts';
import type { Categories } from './categories.ts';

/** A list the user can page through with "more": what it is, and how far it got. */
export interface ListPage {
  kind: 'trending' | 'new' | 'artist' | 'category';
  /** The artist's id, for an artist's songs. */
  artistId?: number | undefined;
  /** The category's slug, for a category's songs. */
  category?: string | undefined;
  /** How many songs have been shown so far. */
  shown: number;
  /** The list's heading, kept for the pages after the first. */
  title?: string | undefined;
}

/** What the bot needs to answer "trending", "new", an artist's name, and "more". */
export interface Browse {
  trending(limit: number, offset: number): ListedTrack[];
  /** The newest releases, newest first: music-table.com's, and Zemer's where there is a feed (the same song once, Zemer's). */
  newest(limit: number, offset: number): ListedEntry[];
  /** Where "new" looks, for its heading: "music-table.com", or "Zemer and music-table.com". */
  newOn?: string;
  /** Brings what "new" lists up to date before it is asked for (Zemer's feed is asked again after a few minutes). Never rejects. */
  refreshNew?(): Promise<void>;
  /** The artist the words name, if they name one, with the number of songs they're on. */
  artist(tokens: string[]): { id: number; name: string; songs: number } | undefined;
  artistSongs(artistId: number, limit: number, offset: number): ListedTrack[];
  /** How many releases an artist has (singles, and albums counted once). */
  artistReleases(artistId: number): number;
  artistName(artistId: number): string | undefined;
  /** A category's releases, most viewed first (may read the category from the site first). */
  category?(slug: string, limit: number, offset: number): Promise<ListedTrack[]>;
  /** The same from the catalog alone. */
  categoryLocal?(slug: string, limit: number, offset: number): ListedTrack[];
  /** The list being paged through in the chat, kept between messages (and restarts). */
  page(): ListPage | undefined;
  setPage(page: ListPage | undefined): void;
}

const PAGE_KEY = 'chat.list';
/** More than a page is read from each side of "new", since a song both have is dropped from one of them. */
const NEW_SLACK = 30;
/** Zemer's feed is read again for "new" when the last time was longer ago than this. */
const NEW_MAX_AGE_MS = 15 * 60_000;
/** "new" waits this long at most for that: a slow feed is read on in the background, and the list is what is there now. */
const NEW_WAIT_MS = 4_000;

const listedRelease = (release: NewRelease): ListedRelease => ({
  releaseId: release.id,
  title: release.title,
  artist: release.artist,
  songs: release.songs,
  releasedAt: release.releasedAt,
  ...(release.cover ? { cover: release.cover } : {}),
});

/** What tells a release or music-table.com's entry apart from the others of its kind: a single's song, or an album's title, and its artist. */
const entryKey = (entry: ListedEntry): string => {
  if ('releaseId' in entry) return releaseKey(entry.songs === 1 ? 'single' : 'album', entry);
  return entry.album ? releaseKey('album', { title: splitTitle(entry.album.title).title || entry.album.title, artist: entry.artist }) : releaseKey('single', entry);
};
const releasedAt = (entry: ListedEntry): number => Date.parse(entry.releasedAt ?? '') || 0;

/**
 * Browsing over the catalog: lists from the site's posts (trending, new) and from the artists in the songs' credits.
 * With Zemer's new releases, "new" lists them among the site's, newest first.
 */
export function catalogBrowse(catalog: Catalog, now: () => Date = () => new Date(), categories?: Categories, releases?: NewReleases, newWaitMs = NEW_WAIT_MS): Browse {
  const browse: Browse = {
    ...(categories
      ? {
          category: (slug: string, limit: number, offset: number) => categories.songs(slug, limit, offset),
          categoryLocal: (slug: string, limit: number, offset: number) => categories.localSongs(slug, limit, offset),
        }
      : {}),
    trending: (limit, offset) => catalog.trendingSongs(now(), limit, offset),
    newest(limit, offset) {
      if (!releases) return catalog.newestSongs(limit, offset);
      const read = offset + limit + NEW_SLACK;
      const zemer = releases.list().slice(0, read).map(listedRelease);
      // A song both have is listed once, as Zemer's.
      const theirs = new Set(zemer.map(entryKey));
      const site = catalog.newestSongs(read, 0).filter((entry) => !theirs.has(entryKey(entry)));
      return [...zemer, ...site].sort((a, b) => releasedAt(b) - releasedAt(a)).slice(offset, offset + limit);
    },
    newOn: releases ? 'Zemer and music-table.com' : 'music-table.com',
    ...(releases
      ? {
          refreshNew: async () => {
            let timer: NodeJS.Timeout | undefined;
            const patience = new Promise<void>((resolve) => {
              timer = setTimeout(resolve, newWaitMs);
            });
            await Promise.race([releases.sync(NEW_MAX_AGE_MS), patience]);
            clearTimeout(timer);
          },
        }
      : {}),
    artist: (tokens) => catalog.findArtist(tokens),
    artistSongs: (artistId, limit, offset) => catalog.artistSongs(artistId, limit, offset),
    artistReleases: (artistId) => catalog.artistReleases(artistId),
    artistName: (artistId) => catalog.artistName(artistId),
    page() {
      try {
        const value = JSON.parse(catalog.getState(PAGE_KEY) || 'null') as ListPage | null;
        return value && typeof value.shown === 'number' ? value : undefined;
      } catch {
        return undefined;
      }
    },
    setPage(page) {
      catalog.setState(PAGE_KEY, page ? JSON.stringify(page) : '');
    },
  };
  return browse;
}
