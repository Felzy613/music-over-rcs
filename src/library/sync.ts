import type { Catalog } from '../catalog.ts';
import { tracksOf, type FeedItem, type MusicTable, type Post } from '../sources/music-table.ts';

export interface SyncResult {
  /** Posts this machine had never seen before. */
  fresh: Post[];
  /** How many posts were read. */
  seen: number;
  /** How many songs were added to the catalog or refreshed in it. */
  songs: number;
}

/** Posts per request. 50 is about 270 KB with everything in it, and covers about a month of posts. */
export const PAGE_SIZE = 50;

/**
 * Brings the catalog up to date with music-table.com. It reads posts newest first (one request per 50, files,
 * pictures and view counts included) and the RSS feed (only for category names, which the list leaves out), records
 * every post, and adds every MP3 as a song. A new song is then found in the catalog, without searching the site.
 */
export async function syncSite(deps: {
  musicTable: Pick<MusicTable, 'listPosts' | 'feed' | 'trackUrl'>;
  /** Only the posts in this category (an id). */
  categoryId?: string;
  catalog: Pick<Catalog, 'savePost' | 'add'>;
  /** How many pages of 50 to read. One covers about a month of posts. */
  pages?: number;
  /** Where to start, in posts from the newest. */
  offset?: number;
  /** Category names are only in the feed, which lists the newest posts; a scan of older pages skips it. */
  feed?: boolean;
  /** The feed, when it was just read anyway. */
  feedItems?: FeedItem[];
  now?: () => Date;
}): Promise<SyncResult & { more: boolean }> {
  const now = deps.now ?? (() => new Date());
  const categories = new Map<string, string>();
  if (deps.feed !== false) {
    try {
      for (const item of deps.feedItems ?? (await deps.musicTable.feed())) categories.set(item.slug, item.category);
    } catch {
      // Without the feed the posts still sync; they only miss their category's name.
    }
  }

  const fresh: Post[] = [];
  let seen = 0;
  let songs = 0;
  let more = true;
  for (let page = 0; page < Math.max(1, deps.pages ?? 1) && more; page += 1) {
    const posts = await deps.musicTable.listPosts((deps.offset ?? 0) + page * PAGE_SIZE, PAGE_SIZE, deps.categoryId);
    for (const post of posts) {
      seen += 1;
      const { isNew } = deps.catalog.savePost(
        {
          slug: post.slug,
          title: post.title,
          category: categories.get(post.slug) ?? '',
          publishedAt: post.publishedAt ?? now().toISOString(),
          views: post.views ?? 0,
          cover: post.cover,
          audioFiles: post.files.length,
          categoryIds: post.categoryIds,
        },
        now(),
      );
      if (isNew) fresh.push(post);
      for (const track of tracksOf(deps.musicTable, post)) {
        deps.catalog.add(track);
        songs += 1;
      }
    }
    more = posts.length === PAGE_SIZE;
  }
  return { fresh, seen, songs, more };
}
