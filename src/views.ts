import type { ListPage } from './library/browse.ts';

// Where the chat is, the way a streaming app keeps it (2026-10-20): each menu, artist, album or list the bot shows is a
// view, kept with what it has shown so far. "songs more" goes on with the current view, a 👍 on a line of an older one
// goes back to it, and a restart loses nothing (the views are in the catalog, backed up with it). The lists themselves
// are not kept: paging asks the source again (its answers are kept a few minutes) and leaves out what was shown.

/** The kinds of line a menu has, as "artists more", "albums more" and "songs more" name them. */
export type Category = 'artists' | 'albums' | 'songs';
export const CATEGORIES: readonly Category[] = ['artists', 'albums', 'songs'];

/** What a view is of. */
export type ViewKey =
  /** A search's menu: `only` one kind ("album …"), Zemer alone ("zemer …"), or music-table.com's when Zemer had nothing. */
  | { kind: 'search'; query: string; only?: Category | undefined; zemerOnly?: boolean | undefined; from?: 'music-table' | undefined }
  | { kind: 'artist'; artistId: string; name?: string | undefined }
  | { kind: 'album'; albumId: string; title?: string | undefined }
  /** A music-table.com list (trending, new, a holiday, an artist's releases), paged ten at a time. */
  | { kind: 'list'; page: ListPage };

/** A line a view has shown: what it is, what a 👍 (or its number) on it does, and its chip's label. */
export interface ShownLine {
  kind: 'artist' | 'album' | 'song';
  /** What tells it apart in its list (a video id, an album id…), so paging never shows it twice. */
  id: string;
  /** What it does, without the view (`play:42`, `album:MPREb_…`). */
  postback: string;
  label: string;
  /** Its number: an album's place among the albums shown, a song's on its album. */
  number?: number | undefined;
}

export interface View {
  id: number;
  /** The view it was opened from (a menu, for an artist or an album opened from it). */
  parent?: number | undefined;
  key: ViewKey;
  /** Every line it has shown, in the order shown. */
  shown: ShownLine[];
  /** The kind the last "… more" asked for, which a bare "more" repeats. */
  lastMore?: Category | undefined;
}

/** Where the views are kept, and which one is current. */
export interface ViewStore {
  /** A new view (the current one is not changed). */
  open(key: ViewKey, parent?: number): View;
  get(id: number): View | undefined;
  save(view: View): void;
  current(): View | undefined;
  setCurrent(id: number | undefined): void;
}

/** Views kept in this process only (tests, and routes without a catalog). */
export function memoryViews(): ViewStore {
  const views = new Map<number, View>();
  let next = 1;
  let current: number | undefined;
  const copy = (view: View): View => structuredClone(view);
  return {
    open(key, parent) {
      const view: View = { id: next++, ...(parent !== undefined ? { parent } : {}), key, shown: [] };
      views.set(view.id, copy(view));
      return view;
    },
    get: (id) => {
      const view = views.get(id);
      return view && copy(view);
    },
    save: (view) => void views.set(view.id, copy(view)),
    current: () => (current === undefined ? undefined : views.get(current) && copy(views.get(current)!)),
    setCurrent(id) {
      current = id;
    },
  };
}

/** A postback with the view it was shown in: `play:42@41`. */
export const inView = (postback: string, view: number | undefined): string => (view === undefined ? postback : `${postback}@${view}`);

/** A postback and the view it names, if any: `play:42@41` is `play:42` in view 41. */
export function splitPostback(postback: string): { action: string; view?: number } {
  const match = /^(.*)@(\d{1,12})$/s.exec(postback);
  return match ? { action: match[1]!, view: Number(match[2]) } : { action: postback };
}
