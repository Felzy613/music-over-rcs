import type { Catalog, ListedTrack } from '../catalog.ts';
import type { MusicTable } from '../sources/music-table.ts';
import { syncSite } from './sync.ts';

export { CATEGORIES, categoryFor, type CategoryInfo } from './category-list.ts';

const DAY_MS = 24 * 60 * 60_000;
/** When a category was last read from the site. A new name: the site's old category ids (before its rebuild) are not used. */
const listedKey = (slug: string) => `category.${slug}.listed_at`;

/**
 * Category lists from the site. The site lists a category by its own name ("chanukah"), and its lists say which
 * categories each release is in, which the catalog keeps. A category is read from the site at most once a day (all of
 * it the first time, a few hundred releases at most; after that its two newest pages); the list itself comes from the
 * catalog, most viewed first.
 */
export class Categories {
  #musicTable: Pick<MusicTable, 'listReleases' | 'getPost' | 'trackUrl'>;
  #catalog: Catalog;
  #now: () => Date;

  constructor(deps: { musicTable: Pick<MusicTable, 'listReleases' | 'getPost' | 'trackUrl'>; catalog: Catalog; now?: () => Date }) {
    this.#musicTable = deps.musicTable;
    this.#catalog = deps.catalog;
    this.#now = deps.now ?? (() => new Date());
  }

  /** What the catalog files a category's releases under: the site's own name for it. */
  async id(slug: string): Promise<string | undefined> {
    return this.knownId(slug);
  }

  knownId(slug: string): string | undefined {
    return /^[a-z0-9-]+$/.test(slug) ? slug : undefined;
  }

  /** A category's releases, most viewed first; reads the category from the site first if that's more than a day old. */
  async songs(slug: string, limit: number, offset = 0): Promise<ListedTrack[]> {
    const id = this.knownId(slug);
    if (!id) return [];
    const listed = Date.parse(this.#catalog.getState(listedKey(slug)) ?? '');
    if (Number.isNaN(listed) || this.#now().getTime() - listed > DAY_MS) {
      // The first time, the whole category (the catalog's releases don't know their categories yet); after that, its
      // newest, which keeps the view counts fresh and catches anything the regular sync missed.
      const pages = Number.isNaN(listed) ? 10 : 2;
      await syncSite({ musicTable: this.#musicTable, catalog: this.#catalog, category: id, pages, now: this.#now });
      this.#catalog.setState(listedKey(slug), this.#now().toISOString());
    }
    return this.#catalog.categorySongs(id, limit, offset);
  }

  /** The list from the catalog alone, for "more" and "all" after the first page. */
  localSongs(slug: string, limit: number, offset = 0): ListedTrack[] {
    const id = this.knownId(slug);
    return id ? this.#catalog.categorySongs(id, limit, offset) : [];
  }
}
