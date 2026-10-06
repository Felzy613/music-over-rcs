import type { Catalog, ListedTrack } from '../catalog.ts';
import type { Track } from '../types.ts';
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
  newest(limit: number, offset: number): ListedTrack[];
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
  /** Every song shown in the current list so far, so their numbers keep working as more are shown. */
  shownSongs(page: ListPage): Track[];
}

const PAGE_KEY = 'chat.list';

/** Browsing over the catalog: lists from the site's posts (trending, new) and from the artists in the songs' credits. */
export function catalogBrowse(catalog: Catalog, now: () => Date = () => new Date(), categories?: Categories): Browse {
  const browse: Browse = {
    ...(categories
      ? {
          category: (slug: string, limit: number, offset: number) => categories.songs(slug, limit, offset),
          categoryLocal: (slug: string, limit: number, offset: number) => categories.localSongs(slug, limit, offset),
        }
      : {}),
    trending: (limit, offset) => catalog.trendingSongs(now(), limit, offset),
    newest: (limit, offset) => catalog.newestSongs(limit, offset),
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
    shownSongs(page) {
      if (page.kind === 'trending') return browse.trending(page.shown, 0);
      if (page.kind === 'new') return browse.newest(page.shown, 0);
      if (page.kind === 'category') return page.category ? (browse.categoryLocal?.(page.category, page.shown, 0) ?? []) : [];
      return page.artistId === undefined ? [] : browse.artistSongs(page.artistId, page.shown, 0);
    },
  };
  return browse;
}
