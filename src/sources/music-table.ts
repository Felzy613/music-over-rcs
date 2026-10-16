import { tooBig, type AudioCheck } from '../audio-check.ts';
import { AudioFetchError, type DownloadedAudio } from '../audio-fetch.ts';
import { SourceError, type TrackSource } from '../bot.ts';
import type { NewTrack } from '../catalog.ts';
import { parseQuery } from '../query.ts';
import type { Track } from '../types.ts';
import { canBeCorrected, correct, fewestMatches, fit, pick, titleWords } from './relevance.ts';
import { splitTitle } from './titles.ts';

export { splitTitle };

// music-table.com is a site of Jewish music releases (rebuilt on its own in October 2026; it had been a Wix blog). A
// release's page lists its MP3s, and the page's Download button asks /api/downloads for a short-lived link, which
// redirects to the file in the site's own storage. This client does what the site's pages do: search, read a release,
// list releases, ask for a file's link. It only ever uses those site-hosted files; the videos on the same pages are
// ignored, and releases the site sells are left alone.

export const MUSIC_TABLE_URL = 'https://www.music-table.com';
const SUGGEST_PATH = '/api/suggest';
const DOWNLOADS_PATH = '/api/downloads';
const LIST_PATH = '/new-music';
const FEED_PATH = '/feed.xml';
/** Releases per page of the site's lists. */
export const LIST_PAGE_SIZE = 48;
const AUDIO_NAME = /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const AUDIO_TYPE = /^(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const SLUG = /^[^/?#\s]+$/;

const MAX_QUERY_CHARS = 100;
const MAX_POSTS_PER_LOOKUP = 5;
/** The most files of one release that become songs (an album's tracks). */
const MAX_FILES_PER_POST = 40;

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
  /** "Artist - Title", the way the site's releases have always been named. */
  title: string;
  url: string;
  /** How well the search thinks it matches (higher is better), when it says. */
  score?: number;
}

export interface AudioFile {
  name: string;
  /** The site's id for the file. A download link is asked for by the file's place in the release, not by this. */
  path: string;
  size: number;
  mimeType: string;
}

export interface Post {
  id: string;
  slug: string;
  /** "Artist - Title". */
  title: string;
  url: string;
  /** The audio files of the release, in page order. Empty for releases that are only videos. */
  files: AudioFile[];
  /** The release's picture (the single's or album's art). */
  cover?: string | undefined;
  /** How many times the release has been viewed on the site. */
  views?: number | undefined;
  /** ISO time it was published. */
  publishedAt?: string | undefined;
  /** The site sells it rather than giving it away: its files can't be downloaded here. */
  forSale?: boolean | undefined;
}

/** A release as the site's lists show it: no files (its page has those), but its categories, views and date. */
export interface Release {
  slug: string;
  /** "Artist - Title". */
  title: string;
  url: string;
  cover?: string | undefined;
  views?: number | undefined;
  publishedAt?: string | undefined;
  /** The site's categories it's in: "singles", "videos", "weddings", "chanukah", "purim", "vocal"… */
  categories: string[];
  forSale?: boolean | undefined;
}

/** One page of a list: its releases, and which page of how many it is. */
export interface ReleaseList {
  releases: Release[];
  page: number;
  pages: number;
}

/** One entry of the site's RSS feed: its newest releases. */
export interface FeedItem {
  slug: string;
  title: string;
  /** The feed no longer names categories; kept empty for whoever still reads it. */
  category: string;
  publishedAt: string;
}

/** One thing the client did (or skipped, because it already knew), for the simulator's "behind the scenes" view. */
export interface SiteEvent {
  kind: 'token' | 'search' | 'post' | 'link' | 'list' | 'feed' | 'category';
  /** What it was about: the words searched for, or the release. */
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
   * lookup read several releases together. 0 turns the pacing off.
   */
  minIntervalMs?: number;
  burst?: number;
  timeoutMs?: number;
  postTtlMs?: number;
  searchTtlMs?: number;
  linkTtlMs?: number;
  /** Decides which download links to trust. The default accepts only the site's own address (which redirects to its storage). */
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

/**
 * The data a page carries for its scripts, joined into one text. The site's pages (Next.js) send it as a run of
 * `self.__next_f.push([1, "…"])` scripts, each a JSON string; releases, files and lists are plain JSON inside it.
 */
export function pageData(html: string): string {
  const parts: string[] = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      parts.push(JSON.parse(match[1]!) as string);
    } catch {
      // a chunk that isn't a plain string carries nothing we read
    }
  }
  return parts.join('');
}

/** The JSON object or array that starts at `at` in `text`, read up to its matching bracket; undefined if there is none. */
export function jsonAt(text: string, at: number): unknown {
  const open = text[at];
  if (open !== '{' && open !== '[') return undefined;
  let depth = 0;
  let inString = false;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i += 1;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(at, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** "Artist - Title", the form the rest of the bot splits apart again (`splitTitle`). */
const joinTitle = (artist: string, title: string): string => (artist && title ? `${artist} - ${title}` : title || artist);

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** An address the site gave (often a path on itself), made whole. Undefined for anything that isn't a web address. */
function siteAddress(value: unknown, origin: string): string | undefined {
  const text = str(value);
  if (!text) return undefined;
  try {
    const url = new URL(text, origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const isoTime = (value: unknown): string | undefined => {
  const text = str(value);
  const time = text ? new Date(text) : undefined;
  return time && !Number.isNaN(time.getTime()) ? time.toISOString() : undefined;
};

/** A release from one of the site's lists, or undefined when the entry isn't one. */
function toRelease(raw: unknown, origin: string): Release | undefined {
  const r = (raw ?? {}) as { slug?: unknown; title?: unknown; artist?: unknown; cover?: unknown; categories?: unknown; price?: unknown; views?: unknown; publishedAt?: unknown };
  const slug = str(r.slug);
  if (!slug || !SLUG.test(slug)) return undefined;
  const views = Number(r.views);
  const cover = siteAddress(r.cover, origin);
  const publishedAt = isoTime(r.publishedAt);
  return {
    slug,
    title: joinTitle(str(r.artist), str(r.title)) || slug,
    url: `${origin}/post/${slug}`,
    categories: Array.isArray(r.categories) ? r.categories.filter((c): c is string => typeof c === 'string' && /^[a-z0-9-]+$/.test(c)) : [],
    ...(cover ? { cover } : {}),
    ...(Number.isFinite(views) && views >= 0 ? { views } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(typeof r.price === 'number' && r.price > 0 ? { forSale: true } : {}),
  };
}

/** The releases a list page shows, and which page of how many it is. */
export function parseReleaseList(html: string, origin: string): ReleaseList {
  const data = pageData(html);
  const at = data.indexOf('"initial":[');
  const items = at < 0 ? undefined : jsonAt(data, at + '"initial":'.length);
  if (!Array.isArray(items)) throw new MusicTableError("music-table.com sent a list I couldn't read, so the site may have changed");
  const paging = /"page":(\d+),"pages":(\d+)/.exec(data.slice(at));
  const releases = items.map((item) => toRelease(item, origin)).filter((release): release is Release => release !== undefined);
  const page = Number(paging?.[1] ?? 1);
  return { releases, page, pages: Math.max(page, Number(paging?.[2] ?? page)) };
}

/** Reads the releases out of the search box's answer (`/api/suggest`), in the order the site gave. */
export function parseSuggest(body: unknown, origin: string): SearchHit[] {
  const releases = (body as { releases?: unknown } | null)?.releases;
  if (!Array.isArray(releases)) throw new MusicTableError("music-table.com's quick search sent something I couldn't read");
  const hits: SearchHit[] = [];
  for (const entry of releases) {
    const e = (entry ?? {}) as { key?: unknown; title?: unknown; subtitle?: unknown; href?: unknown };
    const fromHref = /\/post\/([^/?#\s]+)\/?$/.exec(str(e.href))?.[1];
    const slug = fromHref ?? str(e.key);
    if (!slug || !SLUG.test(slug)) continue;
    hits.push({ slug, title: joinTitle(str(e.subtitle), str(e.title)), url: `${origin}/post/${slug}` });
  }
  return hits;
}

/** Reads the releases out of the search page: from its data when it has them, and from its links for anything else. */
export function parseSearchResults(page: string, baseUrl: string): SearchHit[] {
  const origin = new URL(baseUrl).origin;
  const hits = new Map<string, SearchHit>();
  const unquote = (text: string | undefined): string => {
    try {
      return text ? (JSON.parse(`"${text}"`) as string).trim() : '';
    } catch {
      return '';
    }
  };
  for (const match of pageData(page).matchAll(/\{"slug":"([^"\\]+)","title":"((?:[^"\\]|\\.)*)"(?:,"artist":"((?:[^"\\]|\\.)*)")?/g)) {
    const slug = match[1]!;
    if (!SLUG.test(slug) || hits.has(slug)) continue;
    hits.set(slug, { slug, title: joinTitle(unquote(match[3]), unquote(match[2])), url: `${origin}/post/${slug}` });
  }
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

/**
 * A release's page: its name, artist, picture and files from the page's data, its date from the page's structured
 * data, its view count from what the page shows, and whether the site sells it.
 */
export function parsePostPage(html: string, slug: string, origin: string): Post {
  const data = pageData(html);
  const at = data.indexOf('{"release":{');
  const block = at < 0 ? undefined : (jsonAt(data, at) as { release?: unknown; files?: unknown } | undefined);
  const release = (block?.release ?? undefined) as { title?: unknown; artist?: unknown; cover?: unknown } | undefined;
  if (!block || !release) throw new MusicTableError("music-table.com sent a release page I couldn't read, so the site may have changed");
  const files: AudioFile[] = [];
  for (const raw of Array.isArray(block.files) ? block.files : []) {
    const f = (raw ?? {}) as { id?: unknown; name?: unknown; type?: unknown; sizeBytes?: unknown };
    const name = str(f.name);
    if (!name || !(AUDIO_NAME.test(name) || AUDIO_TYPE.test(str(f.type)))) continue;
    if (files.length >= MAX_FILES_PER_POST) break;
    files.push({ name, path: str(f.id), size: Number(f.sizeBytes) || 0, mimeType: audioTypeOf(AUDIO_NAME.test(name) ? name : `${name}.${str(f.type)}`, '') });
  }
  const linked = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap((match) => {
    try {
      const value = JSON.parse(match[1]!) as unknown;
      return Array.isArray(value) ? value : [value];
    } catch {
      return [];
    }
  }) as Array<{ url?: unknown; datePublished?: unknown; offers?: { price?: unknown } }>;
  const own = linked.find((entry) => typeof entry?.url === 'string' && entry.url.endsWith(`/post/${slug}`)) ?? linked[0];
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const priceCents = Number(new RegExp(`"slug":"${escaped}","priceCents":(\\d+)`).exec(data)?.[1] ?? 0);
  const price = Number(own?.offers?.price ?? 0);
  const views = Number(/"([\d,]+)"," ","views"/.exec(data)?.[1]?.replace(/,/g, ''));
  const cover = siteAddress(release.cover, origin);
  const publishedAt = isoTime(own?.datePublished);
  return {
    id: slug,
    slug,
    title: joinTitle(str(release.artist), str(release.title)) || slug,
    url: `${origin}/post/${slug}`,
    files,
    ...(cover ? { cover } : {}),
    ...(Number.isFinite(views) && views >= 0 ? { views } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(priceCents > 0 || price > 0 ? { forSale: true } : {}),
  };
}

/** Reads the site's RSS feed (`/feed.xml`): its newest releases. */
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

export class MusicTable {
  readonly baseUrl: string;
  #origin: string;
  #fetch: typeof fetch;
  #userAgent: string;
  #minInterval: number;
  #burst: number;
  #timeout: number;
  #postTtl: number;
  #searchTtl: number;
  #linkTtl: number;
  #trusted: (url: URL) => boolean;
  #onEvent: ((event: SiteEvent) => void) | undefined;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
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
    this.#postTtl = options.postTtlMs ?? 5 * 60_000;
    this.#searchTtl = options.searchTtlMs ?? 10 * 60_000;
    this.#linkTtl = options.linkTtlMs ?? 60_000;
    this.#trusted = options.trustedFileUrl ?? ((url) => url.origin === this.#origin);
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#allowance = this.#burst;
    this.#refilled = this.#now();
  }

  /** The address stored in the catalog for a release's nth audio file. It resolves to a download link when it is played. */
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
   * Requests may overlap once started, which is how several releases are read at the same time.
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

  /** A page of the site, as text; `what` names it in the error when the site refuses. */
  async #page(path: string, what: string): Promise<{ status: number; text: string }> {
    const res = await this.#send(`${this.baseUrl}${path}`, { headers: { accept: 'text/html' } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 404) throw new MusicTableError(`${what} isn't on music-table.com (any more)`);
      throw new MusicTableError(`music-table.com's ${what} answered HTTP ${res.status}`);
    }
    return { status: res.status, text: await res.text() };
  }

  /**
   * The site's search, best match first: up to 20 results. It uses the search box's quick answer (which also
   * corrects spelling), and falls back to the search page if that fails.
   */
  async search(query: string, limit = 20): Promise<SearchHit[]> {
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

  /** The site's search page: slower (it is a whole page), but it lists more, so it is used to find the right spelling. */
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
    const res = await this.#send(`${this.baseUrl}${SUGGEST_PATH}?q=${encodeURIComponent(q)}`, { headers: { accept: 'application/json' } });
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
    const { text } = await this.#page(`/search?q=${encodeURIComponent(q)}`, 'search');
    return parseSearchResults(text, this.baseUrl);
  }

  /** A release and its audio files. */
  async getPost(slug: string): Promise<Post> {
    if (!SLUG.test(slug)) throw new MusicTableError("that isn't a music-table.com release");
    const cached = this.#posts.get(slug);
    if (cached && this.#now() - cached.at < this.#postTtl) {
      this.#emit({ kind: 'post', detail: slug, ms: 0, cached: true, note: filesNote(cached.post) });
      return cached.post;
    }
    return this.#once(`post:${slug}`, async () => {
      const started = this.#now();
      const res = await this.#send(`${this.baseUrl}/post/${encodeURIComponent(slug)}`, { headers: { accept: 'text/html' } });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        throw new MusicTableError('that release is gone from music-table.com');
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new MusicTableError(`music-table.com answered HTTP ${res.status}`);
      }
      const post = parsePostPage(await res.text(), slug, this.#origin);
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
   * One page of the site's list of releases (48 a page), newest first, or most viewed first; all of them, or one
   * category's ("chanukah"). A list says which categories each release is in, its views and its date, but not its
   * files: `getPost` reads those.
   */
  async listReleases(page = 1, options: { category?: string | undefined; sort?: 'newest' | 'views' } = {}): Promise<ReleaseList> {
    const started = this.#now();
    const query = new URLSearchParams({ all: '1' });
    if (page > 1) query.set('page', String(Math.floor(page)));
    if (options.category) {
      if (!/^[a-z0-9-]+$/.test(options.category)) throw new MusicTableError("that isn't a category on music-table.com");
      query.set('category', options.category);
    }
    if (options.sort === 'views') query.set('sort', 'views');
    const { status, text } = await this.#page(`${LIST_PATH}?${query}`, options.category ? `${options.category} list` : 'list of releases');
    const list = parseReleaseList(text, this.#origin);
    this.#emit({
      kind: 'list',
      detail: `${options.category ?? 'all'} page ${list.page} of ${list.pages}`,
      ms: this.#now() - started,
      cached: false,
      status,
      note: `${list.releases.length} releases`,
    });
    return list;
  }

  /** The site's RSS feed: its newest releases. */
  async feed(): Promise<FeedItem[]> {
    const started = this.#now();
    const res = await this.#send(`${this.baseUrl}${FEED_PATH}`, { headers: { accept: 'application/rss+xml, application/xml, text/xml' } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new MusicTableError(`music-table.com's feed answered HTTP ${res.status}`);
    }
    const items = parseFeed(await res.text());
    this.#emit({ kind: 'feed', detail: `${items.length} posts`, ms: this.#now() - started, cached: false, status: res.status });
    return items;
  }

  /** Asks the site for a short-lived download link to one of a release's files, the way its Download button does. */
  async #sign(post: Post, index: number): Promise<string> {
    if (post.forSale) throw new MusicTableError(`"${post.title}" is sold on music-table.com, not given away, so I can't download it`);
    const started = this.#now();
    const res = await this.#send(`${this.baseUrl}${DOWNLOADS_PATH}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'release', slug: post.slug, index }),
    });
    let body: { url?: unknown; error?: unknown } = {};
    try {
      body = (await res.json()) as { url?: unknown; error?: unknown };
    } catch {
      // read below as no link
    }
    if (body.error === 'buy' || body.error === 'login') {
      throw new MusicTableError(`"${post.title}" is sold on music-table.com, not given away, so I can't download it`);
    }
    if (!res.ok) throw new MusicTableError(`music-table.com wouldn't give out the download link (HTTP ${res.status})`);
    const href = siteAddress(body.url, this.#origin);
    if (!href) throw new MusicTableError("music-table.com sent a download link I couldn't read");
    if (!this.#trusted(new URL(href))) throw new MusicTableError('music-table.com pointed me at a download host I do not trust');
    this.#emit({ kind: 'link', detail: post.slug, ms: this.#now() - started, cached: false, status: res.status, note: 'download link signed' });
    return href;
  }

  async #fileFor(ref: { slug: string; index: number }): Promise<{ post: Post; file: AudioFile }> {
    const post = await this.getPost(ref.slug);
    const file = post.files[ref.index];
    if (!file) {
      throw new MusicTableError(
        post.files.length === 0 ? `"${post.title}" has no MP3 to download on music-table.com` : 'that file is no longer on the release',
      );
    }
    return { post, file };
  }

  /** A download link to the file: the one made a moment ago when there is one, otherwise a new one. */
  async #linkFor(ref: { slug: string; index: number }, known?: { post: Post; file: AudioFile }): Promise<string> {
    const key = `${ref.slug}#${ref.index}`;
    const cached = this.#links.get(key);
    if (cached && this.#now() - cached.at < this.#linkTtl) {
      this.#emit({ kind: 'link', detail: ref.slug, ms: 0, cached: true, note: 'download link reused' });
      return cached.url;
    }
    const { post } = known ?? (await this.#fileFor(ref));
    const url = await this.#sign(post, ref.index);
    this.#links.set(key, { at: this.#now(), url });
    return url;
  }

  /** Turns a catalog address made by `trackUrl` into a download link for the file. Other URLs pass through unchanged. */
  async resolveUrl(raw: string): Promise<string> {
    const ref = this.parseTrackUrl(raw);
    return ref ? this.#linkFor(ref) : raw;
  }

  /**
   * What a catalog address points at, without downloading it: a download link, and the file's type and size as the
   * release states them. Other URLs are not ours and give nothing.
   */
  async inspect(raw: string): Promise<{ link: string; type: string; bytes: number } | undefined> {
    const ref = this.parseTrackUrl(raw);
    if (!ref) return undefined;
    const known = await this.#fileFor(ref);
    return { link: await this.#linkFor(ref, known), type: known.file.mimeType, bytes: known.file.size };
  }
}

const filesNote = (post: Post): string =>
  post.forSale ? 'for sale, not free' : post.files.length === 0 ? 'no MP3 (video or news)' : `${post.files.length} MP3`;

/** The tracks a post offers, named the way the catalog stores them. */
export function tracksOf(table: Pick<MusicTable, 'trackUrl'>, post: Post): NewTrack[] {
  // A release the site sells can't be downloaded here, so it isn't offered as a song.
  if (post.forSale) return [];
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
