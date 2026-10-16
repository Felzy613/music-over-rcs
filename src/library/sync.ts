import type { Catalog } from '../catalog.ts';
import { LIST_PAGE_SIZE, tracksOf, MusicTableError, type MusicTable, type Post } from '../sources/music-table.ts';

export interface SyncResult {
  /** Releases this machine had never seen before. */
  fresh: Post[];
  /** How many releases were listed. */
  seen: number;
  /** How many songs were added to the catalog. */
  songs: number;
}

/** Releases per page of the site's lists. */
export const PAGE_SIZE = LIST_PAGE_SIZE;

/** The name the catalog keeps for a release's kind, from the site's categories ("singles" is "Singles"). */
export function categoryName(categories: string[]): string {
  if (categories.includes('weddings')) return 'Weddings & Events';
  if (categories.includes('videos')) return 'Videos';
  if (categories.includes('singles')) return 'Singles';
  const first = categories[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

/**
 * Brings the catalog up to date with music-table.com. It reads the site's list of releases, newest first (48 a page,
 * with each release's categories, views and date), records every release, and reads the page of each release it has
 * never seen to add its MP3s as songs. A release already in the catalog only has its views and categories refreshed,
 * so a sync costs one request a page plus one per new release. A new song is then found in the catalog, without
 * searching the site.
 */
export async function syncSite(deps: {
  musicTable: Pick<MusicTable, 'listReleases' | 'getPost' | 'trackUrl'>;
  /** Only the releases in this category of the site ("chanukah"). */
  category?: string | undefined;
  catalog: Pick<Catalog, 'savePost' | 'add' | 'sitePost'>;
  /** How many pages of 48 to read. One covers about two weeks of releases. */
  pages?: number;
  /** Where to start, in releases from the newest (a multiple of the page size). */
  offset?: number;
  now?: () => Date;
}): Promise<SyncResult & { more: boolean }> {
  const now = deps.now ?? (() => new Date());
  const fresh: Post[] = [];
  let seen = 0;
  let songs = 0;
  let more = true;
  const first = Math.floor(Math.max(0, deps.offset ?? 0) / PAGE_SIZE) + 1;
  for (let page = first; page < first + Math.max(1, deps.pages ?? 1) && more; page += 1) {
    const list = await deps.musicTable.listReleases(page, { category: deps.category });
    for (const release of list.releases) {
      seen += 1;
      const known = deps.catalog.sitePost(release.slug);
      let post: Post | undefined;
      if (!known) {
        try {
          post = await deps.musicTable.getPost(release.slug);
        } catch (err) {
          // A release whose page won't open now is left for the next sync rather than recorded without its songs.
          if (err instanceof MusicTableError) continue;
          throw err;
        }
      }
      const { isNew } = deps.catalog.savePost(
        {
          slug: release.slug,
          title: post?.title ?? release.title,
          category: categoryName(release.categories),
          publishedAt: release.publishedAt ?? post?.publishedAt ?? known?.publishedAt ?? now().toISOString(),
          views: release.views ?? post?.views ?? 0,
          cover: release.cover ?? post?.cover,
          audioFiles: post ? (post.forSale ? 0 : post.files.length) : (known?.audioFiles ?? 0),
          categoryIds: release.categories,
        },
        now(),
      );
      if (isNew && post) {
        fresh.push(post);
        for (const track of tracksOf(deps.musicTable, post)) {
          deps.catalog.add(track);
          songs += 1;
        }
      }
    }
    more = list.page < list.pages && list.releases.length > 0;
  }
  return { fresh, seen, songs, more };
}

