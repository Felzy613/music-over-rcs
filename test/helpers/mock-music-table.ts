import { editDistance } from '../../src/sources/relevance.ts';
import { listen, readText, type Listening } from './servers.ts';

export interface MockFile {
  name: string;
  mimeType?: string;
  data?: Buffer;
}

export interface MockPost {
  slug: string;
  /** "Artist - Title", as the site's releases are named. */
  title: string;
  files?: MockFile[];
  /** A video-only release (no files) says nothing more than having no files; kept so older tests read the same. */
  video?: boolean;
  /** Listed by the search but gone when its page is read. */
  gone?: boolean;
  /** When it was published (ISO). Releases are listed newest first, in the order given. */
  publishedAt?: string;
  views?: number;
  /** Its kind as the bot names it: "Singles", "Videos" or "Weddings & Events" (the site's "singles", "videos", "weddings"). */
  category?: string;
  /** Its picture, served at /media/covers/<coverId>. */
  coverId?: string;
  /** Other categories of the site it's in ("chanukah", "vocal"). */
  categoryPages?: string[];
  /** The site sells it (its price in cents); its files can't be downloaded. */
  price?: number;
}

export interface MockMusicTable extends Listening {
  /** How many download links were handed out. */
  signed: number;
  /** The words of every search, quick or page, in the order they arrived. */
  searches: string[];
  /** Which kind each of those searches was. */
  searchKinds: ('quick' | 'page')[];
  postReads: string[];
  /** Every request for a file's bytes (HEAD or GET), as "METHOD /path", so tests can tell checking from downloading. */
  fileRequests: string[];
  /** How many times a list page and the feed were read. */
  listReads: number;
  feedReads: number;
  failSearch: boolean;
  /** The search box's quick answer is available (the default). Turn it off to see the client fall back to the search page. */
  quickSearch: boolean;
  /** The search page forgives typos (a word one edit away still matches). */
  fuzzyPage: boolean;
  /** Lists a release when it matches any one of the words. */
  looseSearch: boolean;
  /** Decides what a search returns, for tests that need the site to behave a certain way. */
  searchOverride: ((query: string) => MockPost[] | undefined) | undefined;
  /** How long reading a release takes, and the most releases that were being read at the same moment. */
  postDelayMs: number;
  readonly maxInFlightPosts: number;
  /** Every request is refused (403), like a site that turned the bot away. */
  rejectAll: boolean;
  /** Where download links end up (the site's storage): this server unless set. */
  linkBase: string | undefined;
  /** Releases per list page (48 on the real site). */
  perPage: number;
  /** What a file's download serves. */
  bytes(slug: string, index?: number): Buffer;
  reset(): void;
}

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/</g, '&lt;');

/** How the real pages carry their data: a run of `self.__next_f.push([1, "…"])` scripts, each a JSON string. */
const pageWith = (data: string, extraHead = ''): string => {
  const chunks: string[] = [];
  for (let at = 0; at < data.length; at += 700) chunks.push(data.slice(at, at + 700));
  const scripts = chunks.map((chunk) => `<script>self.__next_f.push([1,${JSON.stringify(chunk).replace(/</g, '\\u003c')}])</script>`).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>${extraHead}</head><body><div id="app"></div>${scripts}</body></html>`;
};

const SITE_CATEGORY: Record<string, string> = { Singles: 'singles', Videos: 'videos', 'Weddings & Events': 'weddings' };

/** A pretend music-table.com: its search box and search page, release pages, lists, feed, download links, and storage. */
export async function startMockMusicTable(posts: MockPost[]): Promise<MockMusicTable> {
  const state = {
    signed: 0,
    searches: [] as string[],
    searchKinds: [] as ('quick' | 'page')[],
    postReads: [] as string[],
    fileRequests: [] as string[],
    listReads: 0,
    feedReads: 0,
    failSearch: false,
    quickSearch: true,
    fuzzyPage: false,
    looseSearch: false,
    searchOverride: undefined as ((query: string) => MockPost[] | undefined) | undefined,
    postDelayMs: 0,
    inFlight: 0,
    maxInFlight: 0,
    rejectAll: false,
    linkBase: undefined as string | undefined,
    perPage: 48,
  };

  const bytesOf = (post: MockPost, index: number) =>
    post.files?.[index]?.data ?? Buffer.from(`${post.slug}-${index}-audio-bytes`.repeat(30));
  const split = (title: string) => {
    const at = title.indexOf(' - ');
    return at < 0 ? { artist: '', name: title } : { artist: title.slice(0, at), name: title.slice(at + 3) };
  };
  const categoriesOf = (post: MockPost) => [...new Set([...(post.category && SITE_CATEGORY[post.category] ? [SITE_CATEGORY[post.category]!] : []), ...(post.categoryPages ?? [])])];
  const coverOf = (post: MockPost) => (post.coverId ? `/media/covers/${post.coverId}` : null);
  /** A release the way the lists show it. */
  const listed = (post: MockPost) => ({
    slug: post.slug,
    title: split(post.title).name,
    artist: split(post.title).artist,
    cover: coverOf(post),
    categories: categoriesOf(post),
    price: post.price ? post.price / 100 : null,
    publishedAt: post.publishedAt ?? null,
    views: post.views ?? 0,
    rating: null,
    ratingCount: 0,
    likes: 0,
  });

  const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  /** The quick search: every word has to start a word of the title (any one word, when `looseSearch` is on). */
  const quickMatches = (q: string) => {
    const words = wordsOf(q);
    return posts.filter((post) => {
      const titleWords = wordsOf(post.title);
      const has = (word: string) => titleWords.some((candidate) => candidate.startsWith(word));
      return state.looseSearch ? words.some(has) : words.length > 0 && words.every(has);
    });
  };
  /** The search page: a substring match, or with `fuzzyPage` a word one edit away still counts. */
  const pageMatches = (q: string) => {
    const words = wordsOf(q);
    return posts.filter((post) => {
      const title = post.title.toLowerCase();
      const titleWords = wordsOf(post.title);
      const has = (word: string) =>
        title.includes(word) || (state.fuzzyPage && word.length >= 5 && titleWords.some((candidate) => editDistance(word, candidate) <= 1));
      return state.looseSearch ? words.some(has) : words.every(has);
    });
  };

  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const base = `http://${req.headers.host}`;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const html = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    const mine = (path: string) => url.pathname === path;

    if (state.rejectAll && !url.pathname.startsWith('/files/')) return json(403, { error: 'forbidden' });

    if (mine('/api/suggest')) {
      if (!state.quickSearch) return html(404, pageWith('{"notFound":true}'));
      const q = url.searchParams.get('q') ?? '';
      state.searches.push(q);
      state.searchKinds.push('quick');
      if (state.failSearch) return json(500, { error: 'boom' });
      const matches = state.searchOverride?.(q) ?? quickMatches(q);
      json(200, {
        completions: [],
        corrected: null,
        artists: [],
        releases: matches.slice(0, 20).map((post) => ({
          key: post.slug,
          title: split(post.title).name,
          subtitle: split(post.title).artist,
          image: `${base}/_next/image?url=x`,
          href: `${base}/post/${post.slug}`,
        })),
        channels: [],
        videos: [],
        albums: [],
        downloads: [],
      });
    } else if (mine('/search')) {
      const q = url.searchParams.get('q') ?? '';
      state.searches.push(q);
      state.searchKinds.push('page');
      if (state.failSearch) return html(500, 'boom');
      const matches = state.searchOverride?.(q) ?? pageMatches(q);
      const items = matches.map((post) => ({ key: post.slug, node: ['$', '$L52', null, { release: listed(post) }] }));
      html(200, pageWith(`44:["$","$L48",null,{"title":"Releases","href":"/new-music?q=${encodeURIComponent(q)}","items":${JSON.stringify(items)}}]\n`));
    } else if (url.pathname.startsWith('/post/')) {
      const slug = decodeURIComponent(url.pathname.slice('/post/'.length));
      const post = posts.find((candidate) => candidate.slug === slug);
      if (!post || post.gone) return html(404, pageWith('{"notFound":true}'));
      state.postReads.push(slug);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      if (state.postDelayMs) await new Promise((resolve) => setTimeout(resolve, state.postDelayMs));
      state.inFlight -= 1;
      const { artist, name } = split(post.title);
      const files = (post.files ?? []).map((file, index) => ({
        id: `f${index}-${post.slug.length}`,
        name: file.name,
        type: file.name.split('.').pop(),
        sizeBytes: bytesOf(post, index).length,
      }));
      const linked = {
        '@context': 'https://schema.org',
        '@type': 'MusicRecording',
        name,
        byArtist: artist ? [{ '@type': 'MusicGroup', name: artist }] : [],
        ...(post.publishedAt ? { datePublished: post.publishedAt } : {}),
        url: `${base}/post/${post.slug}`,
        offers: { '@type': 'Offer', price: ((post.price ?? 0) / 100).toFixed(2), priceCurrency: 'USD' },
      };
      const views = post.views !== undefined ? `["$","p",null,{"children":["Single"," · ",null,"Sep 8, 2026"," · ","${post.views.toLocaleString('en-US')}"," ","views"]}]` : 'null';
      const data =
        `42:["$","$L45",null,${JSON.stringify({ release: { slug: post.slug, title: name, artist, cover: coverOf(post) }, files })}]\n` +
        `43:["$","$L46",null,{"slug":"${post.slug}","priceCents":${post.price ?? 0},"children":${views}}]\n`;
      html(200, pageWith(data, `<script type="application/ld+json">${JSON.stringify([linked])}</script>`));
    } else if (mine('/new-music')) {
      state.listReads += 1;
      const category = url.searchParams.get('category');
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1);
      let all = posts.filter((post) => !post.gone && (!category || categoriesOf(post).includes(category)));
      if (url.searchParams.get('sort') === 'views') all = [...all].sort((a, b) => (b.views ?? 0) - (a.views ?? 0));
      const pages = Math.max(1, Math.ceil(all.length / state.perPage));
      const shown = all.slice((page - 1) * state.perPage, page * state.perPage).map(listed);
      const query = { featuredOnly: false, category: category ?? '$undefined', sort: url.searchParams.get('sort') ?? 'newest' };
      html(200, pageWith(`43:["$","$L46","/new-music",{"storageKey":"/new-music","initial":${JSON.stringify(shown)},"page":${page},"pages":${pages},"query":${JSON.stringify(query)},"perPage":${state.perPage}}]\n`));
    } else if (mine('/feed.xml')) {
      state.feedReads += 1;
      const items = posts
        .filter((post) => !post.gone)
        .slice(0, 20)
        .map(
          (post) =>
            `<item><title>${esc(post.title)}</title><link>${base}/post/${post.slug}</link>` +
            `<pubDate>${new Date(post.publishedAt ?? 0).toUTCString()}</pubDate></item>`,
        )
        .join('');
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Music Table</title>${items}</channel></rss>`);
    } else if (mine('/api/downloads') && req.method === 'POST') {
      const body = JSON.parse(await readText(req)) as { type?: string; slug?: string; index?: number };
      const post = posts.find((candidate) => candidate.slug === body.slug && !candidate.gone);
      const index = Number(body.index);
      if (!post || !post.files?.[index]) return json(404, { error: "This file isn't available." });
      if (post.price) return json(402, { error: 'buy' });
      state.signed += 1;
      const token = Buffer.from(JSON.stringify({ type: 'release', slug: post.slug, index, n: state.signed })).toString('base64url');
      json(200, { url: `/api/download/${token}` });
    } else if (url.pathname.startsWith('/api/download/')) {
      let ref: { slug?: string; index?: number; n?: number } = {};
      try {
        ref = JSON.parse(Buffer.from(url.pathname.slice('/api/download/'.length), 'base64url').toString()) as typeof ref;
      } catch {
        return json(400, { error: 'bad link' });
      }
      const post = posts.find((candidate) => candidate.slug === ref.slug);
      const file = post?.files?.[Number(ref.index)];
      if (!post || !file) return json(404, { error: 'gone' });
      // Like the real site: a redirect to the file in its storage, with a signature that lasts a few minutes.
      res.writeHead(302, { location: `${state.linkBase ?? base}/files/${post.slug}/${ref.index}/${encodeURIComponent(file.name)}?X-Amz-Signature=S${ref.n}` });
      res.end();
    } else if (url.pathname.startsWith('/files/')) {
      state.fileRequests.push(`${req.method} ${decodeURIComponent(url.pathname)}`);
      if (!url.searchParams.get('X-Amz-Signature')) {
        res.writeHead(403);
        res.end();
        return;
      }
      const [, , slug, indexText] = decodeURIComponent(url.pathname).split('/');
      const post = posts.find((candidate) => candidate.slug === slug);
      const index = Number(indexText);
      const file = post?.files?.[index];
      if (!post || !file) {
        res.writeHead(404);
        res.end();
        return;
      }
      const data = bytesOf(post, index);
      res.writeHead(200, { 'content-type': file.mimeType ?? 'audio/mpeg', 'content-length': String(data.length) });
      res.end(req.method === 'HEAD' ? undefined : data);
    } else {
      html(404, pageWith('{"notFound":true}'));
    }
  });

  return {
    ...server,
    get signed() {
      return state.signed;
    },
    get searches() {
      return state.searches;
    },
    get postReads() {
      return state.postReads;
    },
    get fileRequests() {
      return state.fileRequests;
    },
    get listReads() {
      return state.listReads;
    },
    get feedReads() {
      return state.feedReads;
    },
    get searchKinds() {
      return state.searchKinds;
    },
    get quickSearch() {
      return state.quickSearch;
    },
    set quickSearch(value: boolean) {
      state.quickSearch = value;
    },
    get fuzzyPage() {
      return state.fuzzyPage;
    },
    set fuzzyPage(value: boolean) {
      state.fuzzyPage = value;
    },
    get failSearch() {
      return state.failSearch;
    },
    set failSearch(value: boolean) {
      state.failSearch = value;
    },
    get looseSearch() {
      return state.looseSearch;
    },
    set looseSearch(value: boolean) {
      state.looseSearch = value;
    },
    get searchOverride() {
      return state.searchOverride;
    },
    set searchOverride(value) {
      state.searchOverride = value;
    },
    get postDelayMs() {
      return state.postDelayMs;
    },
    set postDelayMs(value: number) {
      state.postDelayMs = value;
    },
    get maxInFlightPosts() {
      return state.maxInFlight;
    },
    get rejectAll() {
      return state.rejectAll;
    },
    set rejectAll(value: boolean) {
      state.rejectAll = value;
    },
    get linkBase() {
      return state.linkBase;
    },
    set linkBase(value: string | undefined) {
      state.linkBase = value;
    },
    get perPage() {
      return state.perPage;
    },
    set perPage(value: number) {
      state.perPage = value;
    },
    bytes: (slug, index = 0) => bytesOf(posts.find((post) => post.slug === slug)!, index),
    reset() {
      state.signed = 0;
      state.searches.length = 0;
      state.postReads.length = 0;
      state.fileRequests.length = 0;
      state.listReads = 0;
      state.feedReads = 0;
      state.searchKinds.length = 0;
      state.quickSearch = true;
      state.fuzzyPage = false;
      state.failSearch = false;
      state.looseSearch = false;
      state.searchOverride = undefined;
      state.postDelayMs = 0;
      state.inFlight = 0;
      state.maxInFlight = 0;
      state.rejectAll = false;
      state.linkBase = undefined;
      state.perPage = 48;
    },
  };
}
