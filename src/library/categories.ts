import type { Catalog, ListedTrack } from '../catalog.ts';
import type { MusicTable } from '../sources/music-table.ts';
import { syncSite } from './sync.ts';

export { CATEGORIES, categoryFor, type CategoryInfo } from './category-list.ts';

const DAY_MS = 24 * 60 * 60_000;
const idKey = (slug: string) => `category.${slug}.id`;
const freshKey = (slug: string) => `category.${slug}.synced_at`;

/**
 * Category lists from the site. The site lists posts by category id, but names its categories only on their pages, so
 * the id is learned once: from a few of the posts on the category's page, the id they all share (the rarest one, if
 * they share more than one, since "Singles" is on almost everything). A category's posts are read from the site at
 * most once a day (all of them the first time, a few hundred at most; after that its hundred newest); the list itself
 * comes from the catalog.
 */
export class Categories {
  #musicTable: Pick<MusicTable, 'listPosts' | 'feed' | 'trackUrl' | 'categoryPageSlugs' | 'getPost'>;
  #catalog: Catalog;
  #now: () => Date;

  constructor(deps: { musicTable: Pick<MusicTable, 'listPosts' | 'feed' | 'trackUrl' | 'categoryPageSlugs' | 'getPost'>; catalog: Catalog; now?: () => Date }) {
    this.#musicTable = deps.musicTable;
    this.#catalog = deps.catalog;
    this.#now = deps.now ?? (() => new Date());
  }

  /** The site's id for a category, learned once and remembered. */
  async id(slug: string): Promise<string | undefined> {
    const known = this.#catalog.getState(idKey(slug));
    if (known) return known;
    const slugs = (await this.#musicTable.categoryPageSlugs(slug)).slice(0, 4);
    const counts = new Map<string, number>();
    for (const post of slugs) {
      for (const id of (await this.#musicTable.getPost(post)).categoryIds ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const shared = [...counts].filter(([, n]) => n === slugs.length && n > 0).map(([id]) => id);
    if (shared.length === 0) return undefined;
    let id = shared[0]!;
    if (shared.length > 1) {
      // They share more than one: the other is a broad one like "Singles", which most new posts have. The rarest
      // among the site's newest posts is the category asked for.
      const recent = new Map<string, number>();
      for (const post of await this.#musicTable.listPosts(0, 50)) for (const one of post.categoryIds ?? []) recent.set(one, (recent.get(one) ?? 0) + 1);
      id = shared.sort((a, b) => (recent.get(a) ?? 0) - (recent.get(b) ?? 0) || this.#catalog.categoryPosts(a) - this.#catalog.categoryPosts(b))[0]!;
    }
    this.#catalog.setState(idKey(slug), id);
    return id;
  }

  /** The id if it's been learned already (no request). */
  knownId(slug: string): string | undefined {
    return this.#catalog.getState(idKey(slug));
  }

  /** A category's releases, most viewed first; reads the category from the site first if that's more than a day old. */
  async songs(slug: string, limit: number, offset = 0): Promise<ListedTrack[]> {
    const id = await this.id(slug);
    if (!id) return [];
    const synced = Date.parse(this.#catalog.getState(freshKey(slug)) ?? '');
    if (Number.isNaN(synced) || this.#now().getTime() - synced > DAY_MS) {
      // The first time, the whole category (the catalog's posts don't know their categories yet); after that, the
      // hundred newest, which keeps the view counts fresh and catches anything the regular sync missed.
      const pages = Number.isNaN(synced) ? 20 : 2;
      await syncSite({ musicTable: this.#musicTable, catalog: this.#catalog, categoryId: id, pages, feed: false, now: this.#now });
      this.#catalog.setState(freshKey(slug), this.#now().toISOString());
    }
    return this.#catalog.categorySongs(id, limit, offset);
  }

  /** The list from the catalog alone, for "more" and "all" after the first page. */
  localSongs(slug: string, limit: number, offset = 0): ListedTrack[] {
    const id = this.knownId(slug);
    return id ? this.#catalog.categorySongs(id, limit, offset) : [];
  }
}
