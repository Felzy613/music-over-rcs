import { tooBig, type AudioCheck } from '../audio-check.ts';
import { AudioFetchError, type DownloadedAudio } from '../audio-fetch.ts';
import { SourceError, type TrackSource } from '../bot.ts';
import type { NewTrack } from '../catalog.ts';
import { parseQuery } from '../query.ts';
import type { Track } from '../types.ts';
import { canBeCorrected, correct, fewestMatches, fit, pick, titleWords } from './relevance.ts';
import { splitTitle } from './titles.ts';

export { splitTitle };

// music-table.com is a Wix blog. A release's post carries the MP3 as a "Download MP3" file the site hosts itself.
// This client does what the site's own pages do: search, read the post, ask for that file's download link. It only
// ever uses those site-hosted files; the YouTube players embedded in the same posts are ignored.

export const MUSIC_TABLE_URL = 'https://www.music-table.com';

/** The Wix Blog app's id; the site hands out a visitor token for it, which its own API calls carry. */
const BLOG_APP_ID = '14bcded7-0066-7c35-14d7-466cb3f09103';
/** The Wix Site Search app: the quick search behind the site's search box, which answers in about 150 ms. */
const SEARCH_APP_ID = '1484cb44-49cd-5b39-9681-75188ab429de';
const SUGGEST_PATH = '/_api/search-services-sitesearch/v1/suggest/federated';
const SUGGEST_LIMIT = 20;
/** Node type of an attached file in the blog API's rich content (10 is the number the API uses; "FILE" in other formats). */
const FILE_NODE_TYPE = 10;
const AUDIO_NAME = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
/** Where the site stores uploaded files. It hands out these links itself; anything else is refused. */
const FILE_HOSTS = ['wixmp.com', 'wixstatic.com', 'usrfiles.com'];

const MAX_QUERY_CHARS = 100;
const MAX_POSTS_PER_LOOKUP = 5;
const MAX_FILES_PER_POST = 12;
const LIST_PATH = '/_api/communities-blog-node-api/_api/posts';
const IMAGE_HOST = 'https://static.wixstatic.com/media';

/** The site's picture for a post, cropped to 640×360 and served as a JPEG (about 40 KB instead of 1.5 MB). */
export function coverUrl(imageId: string): string | undefined {
  return /^[\w~.-]+$/.test(imageId) ? `${IMAGE_HOST}/${imageId}/v1/fill/w_640,h_360,al_c,q_80/cover.jpg` : undefined;
}

const POST_CACHE_SIZE = 200;
const SEARCH_CACHE_SIZE = 100;

/** A problem whose message is fit to show to the user. */
export class MusicTableError extends SourceError {
  constructor(message: string) {
    super(message);
    this.name = 'MusicTableError';
  }
}

export interface SearchHit {
  slug: string;
  title: string;
  url: string;
  /** How well the site's quick search thinks it matches (higher is better). Absent from the slower search page. */
  score?: number;
}

export interface AudioFile {
  name: string;
  /** Where the file is stored; the site signs a download link from this. */
  path: string;
  size: number;
  mimeType: string;
}

export interface Post {
  id: string;
  slug: string;
  title: string;
  url: string;
  /** The audio files attached to the post, in page order. Empty for posts that only embed videos. */
  files: AudioFile[];
  /** The post's picture (the single's or album's art), sized for a chat. */
  cover?: string | undefined;
  /** How many times the post has been viewed on the site. */
  views?: number | undefined;
  /** ISO time it was first published. */
  publishedAt?: string | undefined;
  /** The site's categories it's in (ids; names come from the feed and the category pages). */
  categoryIds?: string[] | undefined;
}

/** One entry of the site's RSS feed: the newest posts, with the category names the API doesn't give. */
export interface FeedItem {
  slug: string;
  title: string;
  category: string;
  publishedAt: string;
}

/** One thing the client did (or skipped, because it already knew), for the simulator's "behind the scenes" view. */
export interface SiteEvent {
  kind: 'token' | 'search' | 'post' | 'link' | 'list' | 'feed' | 'category';
  /** What it was about: the words searched for, or the post. */
  detail: string;
  ms: number;
  /** Answered from memory, without asking the site. */
  cached: boolean;
  status?: number;
  /** A few words on the outcome, such as "10 results". */
  note?: string;
}

export interface MusicTableOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  /**
   * The pace requests to the site are held to, on average: one every this many milliseconds. Be gentle: it is
   * somebody's small site. Up to `burst` requests may go out at once before the pace applies, which is what lets a
   * lookup read several posts together. 0 turns the pacing off.
   */
  minIntervalMs?: number;
  burst?: number;
  timeoutMs?: number;
  tokenTtlMs?: number;
  postTtlMs?: number;
  searchTtlMs?: number;
  linkTtlMs?: number;
  /** Decides which download links to trust. The default accepts the site's own file hosts over https. */
  trustedFileUrl?: (url: URL) => boolean;
  /** Hears about each request, and each answer given from memory. A failing listener never affects the lookup. */
  onEvent?: (event: SiteEvent) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = /^#x/i.test(body) ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Reads the result links out of the search page. Each result appears twice (picture and title), so this keeps the first. */
export function parseSearchResults(page: string, baseUrl: string): SearchHit[] {
  const origin = new URL(baseUrl).origin;
  const hits = new Map<string, SearchHit>();
  for (const tag of page.match(/<a\b[^>]*>/g) ?? []) {
    const href = /\bhref="([^"]*)"/.exec(tag)?.[1];
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href), origin);
    } catch {
      continue;
    }
    const slug = /^\/post\/([^/?#\s]+)\/?$/.exec(url.pathname)?.[1];
    if (!slug || url.origin !== origin) continue;
    const title = decodeEntities(/\btitle="([^"]*)"/.exec(tag)?.[1] ?? '').trim();
    const seen = hits.get(slug);
    if (!seen) hits.set(slug, { slug, title, url: `${origin}/post/${slug}` });
    else if (!seen.title && title) seen.title = title;
  }
  return [...hits.values()];
}

/** Reads the blog posts out of a quick-search answer, keeping the order and scores the site gave. */
export function parseSuggest(body: unknown, origin: string): SearchHit[] {
  const groups = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(groups)) throw new MusicTableError("music-table.com's quick search sent something I couldn't read");
  const hits: SearchHit[] = [];
  for (const group of groups) {
    const g = (group ?? {}) as { documentType?: unknown; documents?: unknown };
    if (g.documentType !== 'public/blog/posts' || !Array.isArray(g.documents)) continue;
    for (const doc of g.documents) {
      const d = (doc ?? {}) as { url?: unknown; title?: unknown; _score?: unknown };
      const slug = typeof d.url === 'string' ? /^\/post\/([^/?#\s]+)\/?$/.exec(d.url)?.[1] : undefined;
      if (!slug) continue;
      hits.push({
        slug,
        title: typeof d.title === 'string' ? d.title.trim() : '',
        url: `${origin}/post/${slug}`,
        ...(typeof d._score === 'number' ? { score: d._score } : {}),
      });
    }
  }
  return hits;
}

function parsePost(body: unknown, slug: string, origin: string): Post {
  const raw = (body ?? {}) as {
    id?: unknown;
    title?: unknown;
    richContent?: { nodes?: unknown };
    coverImage?: { src?: { id?: unknown } | null };
    viewCount?: unknown;
    firstPublishedDate?: unknown;
    categoryIds?: unknown;
  };
  if (typeof raw.id !== 'string' || !raw.id) throw new MusicTableError("music-table.com sent a post I couldn't read");
  const files: AudioFile[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: unknown; fileData?: unknown; nodes?: unknown };
    if ((n.type === FILE_NODE_TYPE || n.type === 'FILE') && n.fileData && typeof n.fileData === 'object') {
      const f = n.fileData as { name?: unknown; path?: unknown; size?: unknown; mimeType?: unknown };
      const name = typeof f.name === 'string' ? f.name : '';
      const path = typeof f.path === 'string' ? f.path : '';
      const mimeType = typeof f.mimeType === 'string' ? f.mimeType : '';
      if (path && (mimeType.startsWith('audio/') || AUDIO_NAME.test(name)) && files.length < MAX_FILES_PER_POST) {
        files.push({ name, path, size: Number(f.size) || 0, mimeType: audioTypeOf(name, mimeType) });
      }
    }
    if (Array.isArray(n.nodes)) n.nodes.forEach(visit);
  };
  if (Array.isArray(raw.richContent?.nodes)) raw.richContent.nodes.forEach(visit);
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : slug;
  const imageId = raw.coverImage?.src?.id;
  const cover = typeof imageId === 'string' ? coverUrl(imageId) : undefined;
  const views = Number(raw.viewCount);
  const published = typeof raw.firstPublishedDate === 'string' ? new Date(raw.firstPublishedDate) : undefined;
  return {
    id: raw.id,
    slug,
    title,
    url: `${origin}/post/${slug}`,
    files,
    ...(cover ? { cover } : {}),
    ...(Number.isFinite(views) && views >= 0 ? { views } : {}),
    ...(published && !Number.isNaN(published.getTime()) ? { publishedAt: published.toISOString() } : {}),
    ...(Array.isArray(raw.categoryIds) ? { categoryIds: raw.categoryIds.filter((id): id is string => typeof id === 'string' && /^[0-9a-f]{24}$/.test(id)) } : {}),
  };
}

/** Reads the site's RSS feed (`/blog-feed.xml`): its newest posts, each with its category's name. */
export function parseFeed(xml: string): FeedItem[] {
  const text = (item: string, tag: string): string => {
    const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(item);
    const inner = match?.[1]?.trim() ?? '';
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
    return decodeEntities(cdata ? cdata[1]! : inner).trim();
  };
  const items: FeedItem[] = [];
  for (const chunk of xml.split(/<item\b[^>]*>/).slice(1)) {
    const item = chunk.split('</item>')[0] ?? '';
    const slug = /\/post\/([^/?#\s<]+)/.exec(text(item, 'link'))?.[1];
    const published = new Date(text(item, 'pubDate'));
    if (!slug || Number.isNaN(published.getTime())) continue;
    let decodedSlug = slug;
    try {
      decodedSlug = decodeURIComponent(slug);
    } catch {
      // keep it as it came
    }
    items.push({ slug: decodedSlug, title: text(item, 'title'), category: text(item, 'category'), publishedAt: published.toISOString() });
  }
  return items;
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

/** The type to use for a file the site stored: what it says if that is audio, otherwise what the file name says. */
function audioTypeOf(name: string, mimeType: string): string {
  if (mimeType.startsWith('audio/')) return mimeType;
  return TYPE_BY_EXTENSION[/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''] ?? 'audio/mpeg';
}

const defaultTrusted = (url: URL): boolean =>
  url.protocol === 'https:' && FILE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));

export class MusicTable {
  readonly baseUrl: string;
  #origin: string;
  #fetch: typeof fetch;
  #userAgent: string;
  #minInterval: number;
  #burst: number;
  #timeout: number;
  #tokenTtl: number;
  #postTtl: number;
  #searchTtl: number;
  #linkTtl: number;
  #trusted: (url: URL) => boolean;
  #onEvent: ((event: SiteEvent) => void) | undefined;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  #session: { blog: string; search: string | undefined; at: number } | undefined;
  #posts = new Map<string, { at: number; post: Post }>();
  #searches = new Map<string, { at: number; hits: SearchHit[] }>();
  #links = new Map<string, { at: number; url: string }>();
  #flights = new Map<string, Promise<unknown>>();
  #queue: Promise<unknown> = Promise.resolve();
  #allowance: number;
  #refilled: number;

  constructor(options: MusicTableOptions = {}) {
    this.baseUrl = (options.baseUrl ?? MUSIC_TABLE_URL).replace(/\/+$/, '');
    this.#origin = new URL(this.baseUrl).origin;
    this.#fetch = options.fetch ?? fetch;
    this.#userAgent = options.userAgent ?? 'music-over-rcs/0.1 (personal, single-user project)';
    this.#minInterval = options.minIntervalMs ?? 100;
    this.#burst = Math.max(1, options.burst ?? 5);
    this.#timeout = options.timeoutMs ?? 20_000;
    this.#tokenTtl = options.tokenTtlMs ?? 20 * 60_000;
    this.#postTtl = options.postTtlMs ?? 5 * 60_000;
    this.#searchTtl = options.searchTtlMs ?? 10 * 60_000;
    this.#linkTtl = options.linkTtlMs ?? 60_000;
    this.#trusted = options.trustedFileUrl ?? defaultTrusted;
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#allowance = this.#burst;
    this.#refilled = this.#now();
  }

  /** The address stored in the catalog for a post's nth audio file. It resolves to a download link when it is played. */
  trackUrl(post: Pick<Post, 'slug'>, index: number): string {
    return `${this.#origin}/post/${post.slug}#${index}`;
  }

  /** Recognizes the addresses `trackUrl` makes. Anything else is not ours. */
  parseTrackUrl(raw: string): { slug: string; index: number } | undefined {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return undefined;
    }
    if (url.origin !== this.#origin) return undefined;
    const slug = /^\/post\/([^/?#\s]+)\/?$/.exec(url.pathname)?.[1];
    const index = url.hash ? Number(url.hash.slice(1)) : 0;
    return slug && Number.isInteger(index) && index >= 0 && index < MAX_FILES_PER_POST ? { slug, index } : undefined;
  }

  #emit(event: SiteEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // a broken listener must not break a lookup
    }
  }

  /** Runs `run` once for a key, however many callers ask for the same thing while it is in progress. */
  #once<T>(key: string, run: () => Promise<T>): Promise<T> {
    const running = this.#flights.get(key) as Promise<T> | undefined;
    if (running) return running;
    const flight = run().finally(() => this.#flights.delete(key));
    this.#flights.set(key, flight);
    return flight;
  }

  #refill(): void {
    const now = this.#now();
    this.#allowance = Math.min(this.#burst, this.#allowance + (now - this.#refilled) / this.#minInterval);
    this.#refilled = now;
  }

  /**
   * Holds the starts of requests to the configured pace: a small burst may go at once, then one per interval.
   * Requests may overlap once started, which is how several posts are read at the same time.
   */
  async #paced<T>(run: () => Promise<T>): Promise<T> {
    const turn = this.#queue.then(async () => {
      if (this.#minInterval <= 0) return;
      this.#refill();
      if (this.#allowance < 1) {
        await this.#sleep(Math.ceil((1 - this.#allowance) * this.#minInterval));
        this.#refill();
      }
      this.#allowance = Math.max(0, this.#allowance - 1);
    });
    this.#queue = turn.catch(() => {});
    await turn;
    return run();
  }

  async #send(url: string, init: RequestInit = {}): Promise<Response> {
    return this.#paced(async () => {
      try {
        const headers = { 'user-agent': this.#userAgent, ...(init.headers as Record<string, string> | undefined) };
        return await this.#fetch(url, { ...init, headers, signal: AbortSignal.timeout(this.#timeout) });
      } catch {
        throw new MusicTableError("music-table.com didn't answer (network error or timeout)");
      }
    });
  }

  /** The visitor session: one token for each of the site's apps we talk to. Fetched once, renewed when it ages or is refused. */
  async #visitor(refresh: boolean): Promise<{ blog: string; search: string | undefined }> {
    if (!refresh && this.#session && this.#now() - this.#session.at < this.#tokenTtl) return this.#session;
    return this.#once('session', async () => {
      const started = this.#now();
      const res = await this.#send(`${this.baseUrl}/_api/v1/access-tokens`, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new MusicTableError(`music-table.com wouldn't start a session (HTTP ${res.status})`);
      }
      let blog: unknown;
      let search: unknown;
      try {
        const body = (await res.json()) as { apps?: Record<string, { instance?: unknown }> };
        blog = body.apps?.[BLOG_APP_ID]?.instance;
        search = body.apps?.[SEARCH_APP_ID]?.instance;
      } catch {
        blog = undefined;
      }
      if (typeof blog !== 'string' || !blog) {
        throw new MusicTableError("music-table.com didn't hand out a session, so the site may have changed");
      }
      const session = { blog, search: typeof search === 'string' && search ? search : undefined, at: this.#now() };
      this.#session = session;
      this.#emit({ kind: 'token', detail: 'visitor session', ms: this.#now() - started, cached: false, status: res.status });
      return session;
    });
  }

  /** Gets the visitor token ahead of the first request, so that request doesn't wait for it. Never throws. */
  async warm(): Promise<void> {
    try {
      await this.#visitor(false);
    } catch {
      // the first real request will try again, and report the problem
    }
  }

  /** A call to one of the site's APIs with its visitor token. A rejected token is replaced once and the call repeated. */
  async #api(path: string, init: RequestInit = {}, app: 'blog' | 'search' = 'blog'): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const session = await this.#visitor(attempt > 0);
      const token = app === 'search' ? session.search : session.blog;
      if (!token) throw new MusicTableError("music-table.com didn't hand out a session for its search");
      const res = await this.#send(`${this.baseUrl}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers as Record<string, string> | undefined), authorization: token },
      });
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      return res;
    }
  }

  /**
   * The site's search, best match first: up to 20 results. It uses the quick search behind the site's search box,
   * which is much faster than the search page, and falls back to the page if the quick search fails.
   */
  async search(query: string, limit = SUGGEST_LIMIT): Promise<SearchHit[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
    if (!q) return [];
    const key = `quick:${q.toLowerCase()}`;
    const cached = this.#searches.get(key);
    if (cached && this.#now() - cached.at < this.#searchTtl) {
      this.#emit({ kind: 'search', detail: q, ms: 0, cached: true, note: `${cached.hits.length} results` });
      return cached.hits.slice(0, limit);
    }
    return this.#once(`search:${key}`, async () => {
      const started = this.#now();
      let hits: SearchHit[];
      let how = 'quick search';
      try {
        hits = await this.#quickSearch(q);
      } catch (err) {
        if (!(err instanceof MusicTableError)) throw err;
        hits = await this.#fetchSearchPage(q);
        how = 'search page, the quick search failed';
      }
      this.#remember(key, hits);
      this.#emit({ kind: 'search', detail: q, ms: this.#now() - started, cached: false, note: `${hits.length} results (${how})` });
      return hits.slice(0, limit);
    });
  }

  /** The site's search page: slower (it is a whole page), but it forgives typos, so it is used to find the right spelling. */
  async searchPage(query: string, limit = 12): Promise<SearchHit[]> {
    const q = query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_CHARS);
    if (!q) return [];
    const key = `page:${q.toLowerCase()}`;
    const cached = this.#searches.get(key);
    if (cached && this.#now() - cached.at < this.#searchTtl) {
      this.#emit({ kind: 'search', detail: q, ms: 0, cached: true, note: `${cached.hits.length} results (search page)` });
      return cached.hits.slice(0, limit);
    }
    return this.#once(`search:${key}`, async () => {
      const started = this.#now();
      const hits = await this.#fetchSearchPage(q);
      this.#remember(key, hits);
      this.#emit({ kind: 'search', detail: q, ms: this.#now() - started, cached: false, note: `${hits.length} results (search page)` });
      return hits.slice(0, limit);
    });
  }

  #remember(key: string, hits: SearchHit[]): void {
    if (this.#searches.size >= SEARCH_CACHE_SIZE) this.#searches.delete(this.#searches.keys().next().value!);
    this.#searches.set(key, { at: this.#now(), hits });
  }

  async #quickSearch(q: string): Promise<SearchHit[]> {
    const res = await this.#api(
      SUGGEST_PATH,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: q, limit: SUGGEST_LIMIT, includeSeoHidden: false, language: 'en', properties: [] }),
      },
      'search',
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new MusicTableError(`music-table.com's quick search answered HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new MusicTableError("music-table.com's quick search sent something I couldn't read");
    }
    return parseSuggest(body, this.#origin);
  }

  async #fetchSearchPage(q: string): Promise<SearchHit[]> {
    const res = await this.#send(`${this.baseUrl}/search?q=${encodeURIComponent(q)}`, { headers: { accept: 'text/html' } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new MusicTableError(`music-table.com's search answered HTTP ${res.status}`);
    }
    return parseSearchResults(await res.text(), this.baseUrl);
  }

  /** A post and the audio files attached to it. */
  async getPost(slug: string): Promise<Post> {
    if (!/^[^/?#\s]+$/.test(slug)) throw new MusicTableError("that isn't a music-table.com post");
    const cached = this.#posts.get(slug);
    if (cached && this.#now() - cached.at < this.#postTtl) {
      this.#emit({ kind: 'post', detail: slug, ms: 0, cached: true, note: filesNote(cached.post) });
      return cached.post;
    }
    return this.#once(`post:${slug}`, async () => {
      const started = this.#now();
      const res = await this.#api(`/_api/communities-blog-node-api/_api/posts/${slug}?fieldsets=content`);
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        throw new MusicTableError('that post is gone from music-table.com');
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new MusicTableError(`music-table.com answered HTTP ${res.status}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new MusicTableError("music-table.com sent a post I couldn't read");
      }
      const post = parsePost(body, slug, this.#origin);
      this.#rememberPost(post);
      this.#emit({ kind: 'post', detail: slug, ms: this.#now() - started, cached: false, status: res.status, note: filesNote(post) });
      return post;
    });
  }

  #rememberPost(post: Post): void {
    this.#posts.delete(post.slug);
    if (this.#posts.size >= POST_CACHE_SIZE) this.#posts.delete(this.#posts.keys().next().value!);
    this.#posts.set(post.slug, { at: this.#now(), post });
  }

  /**
   * The newest posts, `size` at a time from `offset`, each read in full (files, picture, views) in the same request.
   * This is how the catalog is kept up to date. Posts read this way are remembered like any other.
   */
  async listPosts(offset = 0, size = 20, categoryId?: string): Promise<Post[]> {
    const started = this.#now();
    const only = categoryId && /^[0-9a-f]{24}$/.test(categoryId) ? `&categoryIds=${categoryId}` : '';
    const res = await this.#api(`${LIST_PATH}?offset=${Math.max(0, Math.floor(offset))}&size=${Math.min(50, Math.max(1, Math.floor(size)))}&fieldsets=content${only}`);
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new MusicTableError(`music-table.com's post list answered HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new MusicTableError("music-table.com sent a post list I couldn't read");
    }
    const raw = Array.isArray(body) ? body : (body as { posts?: unknown } | null)?.posts;
    if (!Array.isArray(raw)) throw new MusicTableError("music-table.com sent a post list I couldn't read");
    const posts: Post[] = [];
    for (const item of raw) {
      const slug = (item as { slug?: unknown } | null)?.slug;
      if (typeof slug !== 'string' || !/^[^/?#\s]+$/.test(slug)) continue;
      try {
        posts.push(parsePost(item, slug, this.#origin));
      } catch {
        // one odd post shouldn't hide the rest
      }
    }
    for (const post of posts) this.#rememberPost(post);
    const withMusic = posts.filter((post) => post.files.length > 0).length;
    this.#emit({ kind: 'list', detail: `${posts.length} posts`, ms: this.#now() - started, cached: false, status: res.status, note: `${withMusic} with MP3s` });
    return posts;
  }

  /**
   * The posts a category's page shows (its newest two dozen), by their addresses. Only used to learn which id the
   * site gives a category, once; the post list does the rest.
   */
  async categoryPageSlugs(slug: string): Promise<string[]> {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new MusicTableError("that isn't a category on music-table.com");
    const started = this.#now();
    const res = await this.#send(`${this.baseUrl}/new-music/categories/${slug}`, { headers: { accept: 'text/html' } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      // No such category on the site (now): an empty list, not trouble.
      if (res.status === 404) return [];
      throw new MusicTableError(`music-table.com's ${slug} page answered HTTP ${res.status}`);
    }
    const slugs = [...new Set((await res.text()).match(/\/post\/[a-z0-9-]+/g) ?? [])].map((path) => path.slice('/post/'.length));
    this.#emit({ kind: 'category', detail: slug, ms: this.#now() - started, cached: false, status: res.status, note: `${slugs.length} posts` });
    return slugs;
  }

  /** The site's RSS feed: its newest posts, with category names ("Singles", "Videos"…). */
  async feed(): Promise<FeedItem[]> {
    const started = this.#now();
    const res = await this.#send(`${this.baseUrl}/blog-feed.xml`, { headers: { accept: 'application/rss+xml, application/xml, text/xml' } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new MusicTableError(`music-table.com's feed answered HTTP ${res.status}`);
    }
    const items = parseFeed(await res.text());
    this.#emit({ kind: 'feed', detail: `${items.length} posts`, ms: this.#now() - started, cached: false, status: res.status });
    return items;
  }

  /** Asks the site for a time-limited download link to one of a post's files, the way its Download button does. */
  async #sign(post: Post, file: AudioFile): Promise<string> {
    const started = this.#now();
    const res = await this.#api('/_api/communities-blog-node-api/v2/files/download-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ postId: post.id, filePath: file.path }),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new MusicTableError(`music-table.com wouldn't give out the download link (HTTP ${res.status})`);
    }
    let link: unknown;
    try {
      link = ((await res.json()) as { url?: unknown }).url;
    } catch {
      link = undefined;
    }
    let url: URL | undefined;
    try {
      url = typeof link === 'string' ? new URL(link) : undefined;
    } catch {
      url = undefined;
    }
    if (!url) throw new MusicTableError("music-table.com sent a download link I couldn't read");
    if (!this.#trusted(url)) throw new MusicTableError('music-table.com pointed me at a download host I do not trust');
    this.#emit({ kind: 'link', detail: post.slug, ms: this.#now() - started, cached: false, status: res.status, note: 'download link signed' });
    return url.href;
  }

  async #fileFor(ref: { slug: string; index: number }): Promise<{ post: Post; file: AudioFile }> {
    const post = await this.getPost(ref.slug);
    const file = post.files[ref.index];
    if (!file) {
      throw new MusicTableError(
        post.files.length === 0 ? `"${post.title}" has no MP3 to download on music-table.com` : 'that file is no longer on the post',
      );
    }
    return { post, file };
  }

  /** A signed link to the file: the one made a moment ago when there is one, otherwise a new one. */
  async #linkFor(ref: { slug: string; index: number }, known?: { post: Post; file: AudioFile }): Promise<string> {
    const key = `${ref.slug}#${ref.index}`;
    const cached = this.#links.get(key);
    if (cached && this.#now() - cached.at < this.#linkTtl) {
      this.#emit({ kind: 'link', detail: ref.slug, ms: 0, cached: true, note: 'download link reused' });
      return cached.url;
    }
    const { post, file } = known ?? (await this.#fileFor(ref));
    const url = await this.#sign(post, file);
    this.#links.set(key, { at: this.#now(), url });
    return url;
  }

  /** Turns a catalog address made by `trackUrl` into a direct, signed link to the MP3. Other URLs pass through unchanged. */
  async resolveUrl(raw: string): Promise<string> {
    const ref = this.parseTrackUrl(raw);
    return ref ? this.#linkFor(ref) : raw;
  }

  /**
   * What a catalog address points at, without downloading it: a signed link, and the file's type and size as the
   * post states them. Other URLs are not ours and give nothing.
   */
  async inspect(raw: string): Promise<{ link: string; type: string; bytes: number } | undefined> {
    const ref = this.parseTrackUrl(raw);
    if (!ref) return undefined;
    const known = await this.#fileFor(ref);
    return { link: await this.#linkFor(ref, known), type: known.file.mimeType, bytes: known.file.size };
  }
}

const filesNote = (post: Post): string => (post.files.length === 0 ? 'no MP3 (video or news)' : `${post.files.length} MP3`);

/** The tracks a post offers, named the way the catalog stores them. */
export function tracksOf(table: Pick<MusicTable, 'trackUrl'>, post: Post): NewTrack[] {
  const { artist, title } = splitTitle(post.title);
  return post.files.map((file, index) => {
    let name = title;
    if (post.files.length > 1) {
      const base = file.name.replace(AUDIO_NAME, '').trim();
      name = splitTitle(base).artist.toLowerCase() === artist.toLowerCase() && artist ? splitTitle(base).title : base || title;
    }
    return {
      title: name,
      artist,
      url: table.trackUrl(post, index),
      post: post.slug,
      ...(post.cover ? { cover: post.cover } : {}),
      ...(post.publishedAt ? { releasedAt: post.publishedAt } : {}),
    };
  });
}

/**
 * The site's search matches any single word, so a stray word drags in unrelated posts. This keeps the posts that fit
 * the whole request: every word has to appear in the title (typos allowed), except that a request of three or more
 * words may miss one (a typo too big to forgive, or a word like "mp3").
 */
export function isRelevant(hit: Pick<SearchHit, 'slug' | 'title'>, wanted: string[]): boolean {
  return wanted.length > 0 && fit(hit, wanted).matched >= fewestMatches(wanted);
}

export interface LookupDeps {
  musicTable: MusicTable;
  catalog: { add(track: NewTrack): Track };
  /** Hears what the lookup decided, in plain words. The simulator and the command line show these. */
  onNote?: (note: string) => void;
}

const unique = <T>(items: T[]): T[] => [...new Set(items)];

function unionBySlug(hits: SearchHit[]): SearchHit[] {
  const seen = new Map<string, SearchHit>();
  for (const hit of hits) if (!seen.has(hit.slug)) seen.set(hit.slug, hit);
  return [...seen.values()];
}

/** A search that may fail without failing the whole lookup. */
async function quietly(run: () => Promise<SearchHit[]>): Promise<SearchHit[]> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof MusicTableError) return [];
    throw err;
  }
}

/**
 * Looks songs up on music-table.com when the catalog has none, and stores what it finds in the catalog.
 * Next time the same search is answered from the catalog without touching the site.
 *
 * It searches, keeps the results that fit the whole request, and reads only those posts: one when a title matches
 * exactly, up to five otherwise, all at once. The site's quick search is exact about spelling, so when no title
 * has every word it tries, in turn:
 *   - the request with each word left out (three or more words), which survives a typo or a stray word;
 *   - the closest spelling the site uses for each word ("wiess" becomes "weiss"), learned by searching each word
 *     alone, and, when even that gives nothing, from the slower search page, which forgives typos.
 */
export function createMusicTableSource(deps: LookupDeps): TrackSource {
  const table = deps.musicTable;
  const note = (text: string): void => {
    try {
      deps.onNote?.(text);
    } catch {
      // a broken listener must not break a lookup
    }
  };
  const describe = (picked: { hits: unknown[]; exact: boolean; complete: boolean }): string =>
    picked.hits.length === 0
      ? 'none fit'
      : `${picked.hits.length} fit${picked.exact ? ' (exact title)' : picked.complete ? '' : ' (missing a word)'}`;

  return {
    name: 'music-table.com',
    async lookup(query, limit) {
      const wanted = parseQuery(query);
      if (wanted.length === 0) return [];
      // Search the words that matter, not the raw message: "play" and "by" are not in any title.
      let listed = await table.search(wanted.join(' '));
      let chosen = pick(listed, wanted);
      note(`the site listed ${listed.length}; ${describe(chosen)}`);

      if (!chosen.complete && wanted.length >= 3) {
        const words = unique(wanted);
        const variants = unique(words.map((_, i) => words.filter((__, j) => j !== i).join(' ')));
        note(`no title has every word, so trying the request with each word left out`);
        const more = (await Promise.all(variants.map((variant) => quietly(() => table.search(variant))))).flat();
        listed = unionBySlug([...listed, ...more]);
        const widened = pick(listed, wanted);
        if (widened.hits.length > 0) {
          chosen = widened;
          note(`${describe(widened)} once words are left out`);
        }
      }

      if (!chosen.complete) {
        // The results so far may already show how the site spells a word that was typed wrong ("dovid" next to
        // "David"). Failing that, a word they already use can't be the typo, so look the others up alone: what the
        // site lists for the words that do exist shows how it spells the one that doesn't.
        let fixed = correct(wanted, listed);
        if (!fixed) {
          const known = unique(listed.flatMap(titleWords));
          const absent = unique(wanted).filter((token) => token.length >= 3 && !known.some((word) => word.startsWith(token)));
          const own = new Map<string, SearchHit[]>(); // what the site lists for a word on its own
          const near: SearchHit[] = []; // what it lists for the beginning of a word it doesn't know
          const alone = await Promise.all(
            absent.slice(0, 4).map(async (token) => {
              // A one-word request was just searched; asking again would only be answered from memory.
              const direct = wanted.length === 1 ? listed : await quietly(() => table.search(token));
              own.set(token, direct);
              if (direct.length > 0 || token.length < 4) return direct;
              // The quick search matches the beginnings of words, so a typo near the end of a word still finds it by its start.
              for (let length = token.length - 1; length >= Math.max(3, token.length - 3); length -= 1) {
                const found = await quietly(() => table.search(token.slice(0, length)));
                if (found.length > 0) {
                  near.push(...found);
                  return found;
                }
              }
              return direct;
            }),
          );
          fixed = correct(wanted, [...listed, ...near], own);
          if (!fixed && listed.length === 0 && alone.every((hits) => hits.length === 0) && absent.some(canBeCorrected)) {
            // The quick search knows none of the words. The search page forgives typos, so ask it which words are close.
            // That page is slow, so it is only worth asking when a word could be a typo: short words and other
            // alphabets (a Hebrew word will not be a misspelling of the site's Latin-letter titles) are not.
            fixed = correct(wanted, await quietly(() => table.searchPage(wanted.join(' '))));
          }
        }
        if (fixed) {
          note(`checking the spelling: trying "${fixed.join(' ')}"`);
          const again = pick(await table.search(fixed.join(' ')), fixed);
          if (again.complete) {
            chosen = again;
            note(`${describe(again)} with the corrected words`);
          }
        }
      }

      const candidates = chosen.hits.slice(0, MAX_POSTS_PER_LOOKUP);
      if (candidates.length > 0) note(`reading ${candidates.length} post${candidates.length === 1 ? '' : 's'}`);
      const posts = await Promise.all(
        candidates.map(async (hit) => {
          try {
            return await table.getPost(hit.slug);
          } catch (err) {
            if (err instanceof MusicTableError) return undefined; // one unreadable post shouldn't hide the rest
            throw err;
          }
        }),
      );
      const found: Track[] = [];
      for (const post of posts) {
        if (post) for (const track of tracksOf(table, post)) found.push(deps.catalog.add(track));
      }
      return found.slice(0, limit);
    },
  };
}

/**
 * Makes the audio check and download understand catalog addresses that point at music-table.com posts. A site file
 * is checked from what its post says about it (type and size), so no separate request is made just to check it; the
 * download itself still verifies what arrives.
 */
export function resolvingAudio(
  musicTable: MusicTable | undefined,
  io: {
    checkAudio(url: string): Promise<AudioCheck>;
    fetchAudio(url: string, title?: string): Promise<DownloadedAudio>;
  },
  options: { maxBytes?: number } = {},
) {
  if (!musicTable) return io;
  return {
    async checkAudio(url: string): Promise<AudioCheck> {
      try {
        const info = await musicTable.inspect(url);
        if (!info) return await io.checkAudio(url);
        if (!info.type.startsWith('audio/')) return { ok: false, reason: `it isn't an audio file (the site says "${info.type}")` };
        if (options.maxBytes !== undefined && info.bytes > options.maxBytes) return { ok: false, reason: tooBig(info.bytes, options.maxBytes) };
        return info.bytes > 0 ? { ok: true, type: info.type, bytes: info.bytes } : { ok: true, type: info.type };
      } catch (err) {
        if (err instanceof SourceError) return { ok: false, reason: err.message };
        throw err;
      }
    },
    async fetchAudio(url: string, title?: string): Promise<DownloadedAudio> {
      try {
        return await io.fetchAudio(await musicTable.resolveUrl(url), title);
      } catch (err) {
        if (err instanceof SourceError) throw new AudioFetchError(err.message);
        throw err;
      }
    },
  };
}

/** MUSIC_TABLE=off turns the source off; MUSIC_TABLE_URL points it somewhere else (tests). */
export function musicTableFromEnv(env: NodeJS.ProcessEnv = process.env, options: MusicTableOptions = {}): MusicTable | undefined {
  if (/^(off|false|no|0)$/i.test(env.MUSIC_TABLE?.trim() ?? '')) return undefined;
  const baseUrl = env.MUSIC_TABLE_URL?.trim();
  return new MusicTable(baseUrl ? { ...options, baseUrl } : options);
}
