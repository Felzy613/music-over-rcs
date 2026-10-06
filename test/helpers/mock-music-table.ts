import { editDistance } from '../../src/sources/relevance.ts';
import { listen, readText, type Listening } from './servers.ts';

const BLOG_APP_ID = '14bcded7-0066-7c35-14d7-466cb3f09103';
const SEARCH_APP_ID = '1484cb44-49cd-5b39-9681-75188ab429de';

export interface MockFile {
  name: string;
  mimeType?: string;
  data?: Buffer;
}

export interface MockPost {
  slug: string;
  title: string;
  files?: MockFile[];
  /** Adds an embedded YouTube video, like the real posts have under "To Listen". */
  video?: boolean;
  /** Listed by the search but gone when its page is read. */
  gone?: boolean;
  /** When it was first published (ISO). Posts are listed newest first, in the order given. */
  publishedAt?: string;
  views?: number;
  /** The category name the RSS feed gives ("Singles", "Videos"…). */
  category?: string;
  /** The id of its picture on the image host. */
  coverId?: string;
}

export interface MockMusicTable extends Listening {
  tokensIssued: number;
  signed: number;
  /** The words of every search, quick or page, in the order they arrived. */
  searches: string[];
  /** Which kind each of those searches was. */
  searchKinds: ('quick' | 'page')[];
  postReads: string[];
  /** Every request for a file's bytes (HEAD or GET), as "METHOD /path", so tests can tell checking from downloading. */
  fileRequests: string[];
  /** How many times the post list and the feed were read. */
  listReads: number;
  feedReads: number;
  failSearch: boolean;
  /** The fast JSON search is available (the default). Turn it off to see the client fall back to the search page. */
  quickSearch: boolean;
  /** The search page forgives typos (a word one edit away still matches), like the real one. */
  fuzzyPage: boolean;
  /** Like the real search, which lists a post when it matches any one of the words. */
  looseSearch: boolean;
  /** Decides what a search returns, for tests that need the site to behave a certain way. */
  searchOverride: ((query: string) => MockPost[] | undefined) | undefined;
  /** How long reading a post takes, and the most posts that were being read at the same moment. */
  postDelayMs: number;
  readonly maxInFlightPosts: number;
  /** Every authorized call is refused, however fresh the token. */
  rejectAll: boolean;
  /** Points download links at this address instead of this server. */
  linkBase: string | undefined;
  /** Makes every token handed out so far stop working. */
  expireTokens(): void;
  /** What a file's download link serves. */
  bytes(slug: string, index?: number): Buffer;
  reset(): void;
}

const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;').replace(/</g, '&lt;');

/** A pretend music-table.com: the search page, the visitor token, the blog API, and the host that serves the files. */
export async function startMockMusicTable(posts: MockPost[]): Promise<MockMusicTable> {
  const valid = new Set<string>();
  const state = {
    tokensIssued: 0,
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
  };

  const filePath = (post: MockPost, index: number) => `/inst-1/${index}ab${post.slug.length}-${post.files![index]!.name}`;
  const idOf = (post: MockPost) => `id-${post.slug}`;
  const bytesOf = (post: MockPost, index: number) =>
    post.files?.[index]?.data ?? Buffer.from(`${post.slug}-${index}-audio-bytes`.repeat(30));
  /** A post the way the blog API sends it: its MP3s as file nodes, its picture, views and date, and a video when asked. */
  const postJson = (post: MockPost, withContent: boolean) => {
    const nodes: unknown[] = [{ type: 0, id: 'p1', nodes: [{ type: 1, id: 't1', nodes: [], textData: { text: post.title } }] }];
    post.files?.forEach((file, index) =>
      nodes.push({
        type: 10,
        id: `f${index}`,
        nodes: [],
        fileData: {
          name: file.name,
          type: file.name.split('.').pop(),
          size: bytesOf(post, index).length,
          mimeType: file.mimeType ?? 'audio/mpeg',
          path: filePath(post, index),
          src: { id: `src${index}`, private: false },
        },
      }),
    );
    if (post.video) nodes.push({ type: 8, id: 'v', nodes: [], videoData: { video: { src: { url: 'https://youtu.be/abc' } } } });
    return {
      id: idOf(post),
      title: post.title,
      slug: post.slug,
      categoryIds: ['cat1'],
      ...(post.views !== undefined ? { viewCount: post.views } : {}),
      ...(post.publishedAt ? { firstPublishedDate: post.publishedAt } : {}),
      ...(post.coverId ? { coverImage: { src: { id: post.coverId, width: 1280, height: 720 } } } : {}),
      ...(withContent ? { richContent: { nodes } } : {}),
    };
  };

  const wordsOf = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const queryWords = (q: string) => wordsOf(q);
  /** The quick search: every word has to start a word of the title (any one word, when `looseSearch` is on). */
  const quickMatches = (q: string) => {
    const words = queryWords(q);
    return posts.filter((post) => {
      const titleWords = wordsOf(post.title);
      const has = (word: string) => titleWords.some((candidate) => candidate.startsWith(word));
      return state.looseSearch ? words.some(has) : words.length > 0 && words.every(has);
    });
  };
  /** The search page: a substring match, or with `fuzzyPage` a word one edit away still counts. */
  const pageMatches = (q: string) => {
    const words = queryWords(q);
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
    const authorized = () => !state.rejectAll && valid.has(String(req.headers.authorization ?? ''));
    const mine = (path: string) => url.pathname === path;

    if (mine('/search')) {
      const q = url.searchParams.get('q') ?? '';
      state.searches.push(q);
      state.searchKinds.push('page');
      if (state.failSearch) {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      const matches = state.searchOverride?.(q) ?? pageMatches(q);
      const items = matches
        .map(
          (post) =>
            `<li><a aria-hidden="true" tabindex="-1" title="${esc(post.title)}" href="${base}/post/${post.slug}"><img src="x"></a>` +
            `<div><a href="${base}/post/${post.slug}">${esc(post.title)}</a></div></li>`,
        )
        .join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<html><body><a href="${base}/new-music" title="NEW MUSIC">NEW MUSIC</a><ul aria-label="New Music search results">${items}</ul></body></html>`,
      );
    } else if (mine('/_api/v1/access-tokens')) {
      state.tokensIssued += 1;
      const token = `tok-${state.tokensIssued}`;
      const searchToken = `stok-${state.tokensIssued}`;
      valid.add(token);
      valid.add(searchToken);
      json(200, {
        visitorId: 'v',
        apps: { [BLOG_APP_ID]: { instance: token, intId: 1 }, [SEARCH_APP_ID]: { instance: searchToken, intId: 2 }, 'other-app': { instance: 'zzz' } },
      });
    } else if (mine('/_api/search-services-sitesearch/v1/suggest/federated') && req.method === 'POST') {
      if (!state.quickSearch) return json(404, { message: 'no such route' });
      if (!authorized()) return json(401, { message: 'unauthorized' });
      const payload = JSON.parse(await readText(req)) as { query?: string; limit?: number };
      const q = payload.query ?? '';
      state.searches.push(q);
      state.searchKinds.push('quick');
      if (state.failSearch) return json(500, { message: 'boom' });
      const matches = state.searchOverride?.(q) ?? quickMatches(q);
      json(200, {
        results: [
          { documentType: 'public/stores/products', documents: [] },
          {
            documentType: 'public/blog/posts',
            documents: matches.slice(0, payload.limit ?? 20).map((post, index) => ({ _score: 200 - index, title: post.title, url: `/post/${post.slug}`, id: post.slug })),
          },
        ],
      });
    } else if (url.pathname.startsWith('/_api/communities-blog-node-api/_api/posts/')) {
      if (!authorized()) return json(401, { message: 'unauthorized' });
      const slug = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      const post = posts.find((candidate) => candidate.slug === slug);
      if (!post || post.gone) return json(404, { message: 'not found' });
      state.postReads.push(slug);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      if (state.postDelayMs) await new Promise((resolve) => setTimeout(resolve, state.postDelayMs));
      state.inFlight -= 1;
      json(200, postJson(post, url.searchParams.get('fieldsets') === 'content'));
    } else if (mine('/_api/communities-blog-node-api/_api/posts')) {
      if (!authorized()) return json(401, { message: 'unauthorized' });
      state.listReads += 1;
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const size = Number(url.searchParams.get('size') ?? 20);
      const content = url.searchParams.get('fieldsets') === 'content';
      json(200, posts.filter((post) => !post.gone).slice(offset, offset + size).map((post) => postJson(post, content)));
    } else if (mine('/blog-feed.xml')) {
      state.feedReads += 1;
      const items = posts
        .filter((post) => !post.gone)
        .slice(0, 20)
        .map(
          (post) =>
            `<item><title><![CDATA[${post.title}]]></title><link>${base}/post/${post.slug}</link>` +
            `<category><![CDATA[${post.category ?? ''}]]></category><pubDate>${new Date(post.publishedAt ?? 0).toUTCString()}</pubDate></item>`,
        )
        .join('');
      res.writeHead(200, { 'content-type': 'text/xml; charset=UTF-8' });
      res.end(`<?xml version="1.0"?><rss><channel><title>Music Table</title>${items}</channel></rss>`);
    } else if (mine('/_api/communities-blog-node-api/v2/files/download-url') && req.method === 'POST') {
      if (!authorized()) return json(401, { message: 'unauthorized' });
      const body = JSON.parse(await readText(req)) as { postId?: string; filePath?: string };
      const post = posts.find((candidate) => idOf(candidate) === body.postId);
      const index = post?.files?.findIndex((_, i) => filePath(post, i) === body.filePath) ?? -1;
      if (!post || index < 0) return json(404, { message: 'Media resource not found.' });
      state.signed += 1;
      // Like the real site, the address comes back raw: spaces and all.
      json(200, { url: `${state.linkBase ?? base}/files${filePath(post, index)}?token=T${state.signed}&filename=${post.files![index]!.name}` });
    } else if (url.pathname.startsWith('/files/')) {
      state.fileRequests.push(`${req.method} ${decodeURIComponent(url.pathname)}`);
      if (!url.searchParams.get('token')) {
        res.writeHead(403);
        res.end();
        return;
      }
      const wanted = decodeURIComponent(url.pathname).slice('/files'.length);
      let data: Buffer | undefined;
      let mimeType = 'audio/mpeg';
      for (const post of posts) {
        post.files?.forEach((file, index) => {
          if (filePath(post, index) === wanted) {
            data = bytesOf(post, index);
            mimeType = file.mimeType ?? 'audio/mpeg';
          }
        });
      }
      if (!data) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': mimeType, 'content-length': String(data.length) });
      res.end(req.method === 'HEAD' ? undefined : data);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return {
    ...server,
    get tokensIssued() {
      return state.tokensIssued;
    },
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
    expireTokens: () => valid.clear(),
    bytes: (slug, index = 0) => bytesOf(posts.find((post) => post.slug === slug)!, index),
    reset() {
      valid.clear();
      state.tokensIssued = 0;
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
    },
  };
}
