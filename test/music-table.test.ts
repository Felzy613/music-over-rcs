import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { checkAudio } from '../src/audio-check.ts';
import { AudioFetchError, fetchAudio } from '../src/audio-fetch.ts';
import { createBot } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { createRunner } from '../src/runner.ts';
import {
  createMusicTableSource,
  decodeEntities,
  isRelevant,
  MusicTable,
  MusicTableError,
  musicTableFromEnv,
  pageData,
  parsePostPage,
  parseReleaseList,
  parseSearchResults,
  parseSuggest,
  resolvingAudio,
  splitTitle,
  tracksOf,
  type MusicTableOptions,
  type SiteEvent,
} from '../src/sources/music-table.ts';
import type { Reply } from '../src/types.ts';
import { splitPostback } from '../src/views.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';
import { startMockMusicTable, type MockMusicTable, type MockPost } from './helpers/mock-music-table.ts';

const POSTS: MockPost[] = [
  { slug: 'yoely-weiss-shabbos', title: 'Yoely Weiss - Shabbos', files: [{ name: 'Yoely Weiss - Shabbos.mp3' }], video: true },
  { slug: 'yoely-weiss-purim-26', title: "Yoely Weiss - Purim '26 & More", files: [{ name: "Yoely Weiss Purim '26.mp3" }] },
  { slug: 'yoely-weiss-wedding-clip', title: 'Yoely Weiss - Wedding Clip', video: true },
  {
    slug: 'mendy-weiss-album',
    title: 'Mendy Weiss - Full Album',
    files: [{ name: 'Mendy Weiss - One.mp3' }, { name: 'Two.mp3' }, { name: 'bonus.zip', mimeType: 'application/zip' }],
  },
  { slug: 'old-band-old-song', title: 'Old Band - Old Song', files: [{ name: 'Old Song.mp3' }], gone: true },
];

type TextReply = Extract<Reply, { kind: 'text' }>;
function textOf(reply: Reply | undefined): TextReply {
  assert.ok(reply && reply.kind === 'text', 'expected a text reply');
  return reply;
}

describe('music-table.com text helpers', () => {
  test('decodeEntities handles named, decimal and hex entities and leaves unknown ones alone', () => {
    assert.equal(decodeEntities('Tom &amp; Jerry'), 'Tom & Jerry');
    assert.equal(decodeEntities('Purim &#x27;26'), "Purim '26");
    assert.equal(decodeEntities('&#39;a&quot;'), `'a"`);
    assert.equal(decodeEntities('&bogus; &#0; &#xZZ;'), '&bogus; &#0; &#xZZ;');
  });

  test('splitTitle splits "Artist - Title" on the first spaced dash', () => {
    assert.deepEqual(splitTitle("Yoely Weiss - R' Chaim Zanvil Ben R' Moshe"), { artist: 'Yoely Weiss', title: "R' Chaim Zanvil Ben R' Moshe" });
    assert.deepEqual(splitTitle('Mendy Weiss, Yoely Davidowitz & Yoely Samuel - Bondo Drive'), {
      artist: 'Mendy Weiss, Yoely Davidowitz & Yoely Samuel',
      title: 'Bondo Drive',
    });
    assert.deepEqual(splitTitle('Song - Part 1 - Live'), { artist: 'Song', title: 'Part 1 - Live' });
    assert.deepEqual(splitTitle('A – B'), { artist: 'A', title: 'B' });
    assert.deepEqual(splitTitle('Spaced   out  -  title'), { artist: 'Spaced out', title: 'title' });
  });

  test('splitTitle finds no artist without a spaced dash', () => {
    assert.deepEqual(splitTitle('Just A Title'), { artist: '', title: 'Just A Title' });
    assert.deepEqual(splitTitle('Rock-n-Roll'), { artist: '', title: 'Rock-n-Roll' });
  });

  test('isRelevant wants every word, but lets a request of three or more words miss one', () => {
    const post = { slug: 'yoely-weiss-shabbos', title: 'Yoely Weiss - Shabbos' };
    assert.ok(isRelevant(post, ['yoely', 'weiss', 'shabbos']));
    assert.ok(isRelevant(post, ['shab']), 'a word prefix counts');
    assert.ok(!isRelevant(post, ['zzzz', 'shabbos']), 'two words need both');
    assert.ok(!isRelevant(post, ['zzzz']));
    assert.ok(isRelevant(post, ['yoely', 'wiess', 'shabbos']), 'one typo among three');
    assert.ok(isRelevant(post, ['yoely', 'weiss', 'shabbos', 'mp3']), 'one extra word among four');
    assert.ok(!isRelevant(post, ['aaa', 'bbb', 'shabbos']), 'two misses among three');
    assert.ok(isRelevant({ slug: 'yoely-weiss-shabbos', title: '' }, ['yoely', 'shabbos']), 'falls back to the slug');
  });

  test('parseSearchResults keeps each post once, in order, with decoded titles, and ignores everything else', () => {
    const base = 'https://www.music-table.com';
    const page = `
      <a href="${base}/new-music" title="NEW MUSIC">NEW MUSIC</a>
      <ul>
        <li><a aria-hidden="true" title="Yoely Weiss - Purim &#x27;26 &amp; More" href="${base}/post/yoely-weiss-purim-26"><img></a>
            <a href="${base}/post/yoely-weiss-purim-26">Yoely Weiss - Purim '26</a></li>
        <li><a href="/post/relative-one">no title attribute</a></li>
        <li><a title="Late title" href="/post/relative-one">second sighting carries the title</a></li>
        <li><a title="Elsewhere" href="https://other.example/post/not-ours">off site</a></li>
        <li><a title="No slug" href="${base}/post/">no slug</a></li>
        <li><a title="Deeper" href="${base}/post/a/b">deeper path</a></li>
        <li><a title="Query" href="${base}/post/with-query?lightbox=1">with a query string</a></li>
      </ul>`;
    assert.deepEqual(parseSearchResults(page, base), [
      { slug: 'yoely-weiss-purim-26', title: "Yoely Weiss - Purim '26 & More", url: `${base}/post/yoely-weiss-purim-26` },
      { slug: 'relative-one', title: 'Late title', url: `${base}/post/relative-one` },
      { slug: 'with-query', title: 'Query', url: `${base}/post/with-query` },
    ]);
  });

  test('parseSearchResults reads the releases out of the page data first, joining artist and title', () => {
    const base = 'https://www.music-table.com';
    const data = `44:["$","$L48",null,{"items":[{"key":"a","node":{"release":{"slug":"yoely-weiss-shabbos","title":"Shabbos","artist":"Yoely Weiss","cover":null}}},{"key":"b","node":{"wedding":{"slug":"june-9-wedding","title":"June 9 \\"26 Wedding"}}}]}]`;
    const page = `<html><script>self.__next_f.push([1,${JSON.stringify(data)}])</script><a href="/post/yoely-weiss-shabbos">again</a><a title="Only linked" href="/post/only-linked">x</a></html>`;
    assert.equal(pageData(page), data);
    assert.deepEqual(parseSearchResults(page, base), [
      { slug: 'yoely-weiss-shabbos', title: 'Yoely Weiss - Shabbos', url: `${base}/post/yoely-weiss-shabbos` },
      { slug: 'june-9-wedding', title: 'June 9 "26 Wedding', url: `${base}/post/june-9-wedding` },
      { slug: 'only-linked', title: 'Only linked', url: `${base}/post/only-linked` },
    ]);
  });
});

describe('parseSuggest', () => {
  const base = 'https://www.music-table.com';

  test('keeps the releases in the order the search box gave, as "Artist - Title", and ignores everything else', () => {
    const answer = {
      completions: [],
      corrected: 'yoely weiss shabbos',
      artists: [{ key: 'yoelyweiss', title: 'Yoely Weiss', href: `${base}/artists/yoely-weiss` }],
      releases: [
        { key: 'yoely-weiss-shabbos', title: ' Shabbos ', subtitle: 'Yoely Weiss', href: `${base}/post/yoely-weiss-shabbos` },
        { key: 'no-href', title: 'Untitled Artist Song', subtitle: '' },
        { key: 'bad/key', title: 'Bad', subtitle: 'X' },
        null,
      ],
      albums: [{ key: 'an-album', title: 'Album', href: `${base}/post/an-album` }],
    };
    assert.deepEqual(parseSuggest(answer, base), [
      { slug: 'yoely-weiss-shabbos', title: 'Yoely Weiss - Shabbos', url: `${base}/post/yoely-weiss-shabbos` },
      { slug: 'no-href', title: 'Untitled Artist Song', url: `${base}/post/no-href` },
    ]);
  });

  test('an empty answer is no results, and an unreadable one is an error fit for the user', () => {
    assert.deepEqual(parseSuggest({ releases: [] }, base), []);
    for (const bad of [null, {}, { releases: 'nope' }, 'text', { results: [] }]) {
      assert.throws(() => parseSuggest(bad, base), (err) => err instanceof MusicTableError && /couldn't read/.test(err.message));
    }
  });
});

describe('MusicTable client', () => {
  let site: MockMusicTable;
  before(async () => {
    site = await startMockMusicTable(POSTS);
  });
  after(() => site.close());
  beforeEach(() => site.reset());

  const table = (over: MusicTableOptions = {}) =>
    new MusicTable({ baseUrl: site.url, minIntervalMs: 0, trustedFileUrl: () => true, ...over });
  const slugs = (hits: { slug: string }[]) => hits.map((hit) => hit.slug);

  test('search sends the words to the site and returns its results in order', async () => {
    const hits = await table().search('yoely weiss');
    assert.deepEqual(site.searches, ['yoely weiss']);
    assert.deepEqual(slugs(hits), ['yoely-weiss-shabbos', 'yoely-weiss-purim-26', 'yoely-weiss-wedding-clip']);
    assert.equal(hits[1]?.title, "Yoely Weiss - Purim '26 & More");
  });

  test('search honours the limit, ignores empty queries and caps very long ones', async () => {
    const t = table();
    assert.equal((await t.search('weiss', 2)).length, 2);
    site.searches.length = 0;
    assert.deepEqual(await t.search('   '), []);
    assert.equal(site.searches.length, 0);
    await t.search('a'.repeat(300));
    assert.equal(site.searches[0]?.length, 100);
  });

  test('search reports a site error or a dead network in words fit for the user', async () => {
    site.failSearch = true;
    await assert.rejects(table().search('weiss'), (err) => err instanceof MusicTableError && /search answered HTTP 500/.test(err.message));
    const offline = new MusicTable({
      baseUrl: site.url,
      minIntervalMs: 0,
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(offline.search('weiss'), (err) => err instanceof MusicTableError && /didn't answer/.test(err.message));
  });

  test('getPost returns only the audio files, and none for a video-only post', async () => {
    const t = table();
    const shabbos = await t.getPost('yoely-weiss-shabbos');
    assert.equal(shabbos.id, 'yoely-weiss-shabbos');
    assert.equal(shabbos.title, 'Yoely Weiss - Shabbos');
    assert.deepEqual(shabbos.files.map((file) => file.name), ['Yoely Weiss - Shabbos.mp3']);
    assert.equal((await t.getPost('yoely-weiss-wedding-clip')).files.length, 0);
    const album = await t.getPost('mendy-weiss-album');
    assert.deepEqual(album.files.map((file) => file.name), ['Mendy Weiss - One.mp3', 'Two.mp3']);
  });

  test('getPost remembers a post for a while, then asks again', async () => {
    let clock = 0;
    const t = table({ now: () => clock, postTtlMs: 1000 });
    await t.getPost('yoely-weiss-shabbos');
    await t.getPost('yoely-weiss-shabbos');
    assert.equal(site.postReads.length, 1);
    clock = 1001;
    await t.getPost('yoely-weiss-shabbos');
    assert.equal(site.postReads.length, 2);
  });

  test('getPost says so when a post is gone, and refuses things that are not post names', async () => {
    const t = table();
    await assert.rejects(t.getPost('old-band-old-song'), (err) => err instanceof MusicTableError && /gone from music-table\.com/.test(err.message));
    await assert.rejects(t.getPost('nope/../../etc'), (err) => err instanceof MusicTableError);
  });

  test('a site that turns the bot away is reported with its status, in words fit for the user', async () => {
    site.rejectAll = true;
    await assert.rejects(table().getPost('yoely-weiss-shabbos'), (err) => err instanceof MusicTableError && /HTTP 403/.test(err.message));
    await assert.rejects(table().listReleases(), (err) => err instanceof MusicTableError && /HTTP 403/.test(err.message));
  });

  test('requests are spaced out, not sent back to back', async () => {
    let clock = 1000;
    const waits: number[] = [];
    const t = table({
      minIntervalMs: 500,
      burst: 1,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await t.search('a');
    await t.search('b');
    await t.search('c');
    // The first goes at once; each search then starts 500 ms after the one before.
    assert.deepEqual(waits, [500, 500]);
  });

  test('a small burst goes out at once, then the pace applies, and the burst comes back after a quiet spell', async () => {
    let clock = 1000;
    const waits: number[] = [];
    const t = table({
      minIntervalMs: 1000,
      burst: 2,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await t.search('a'); // these two use the two free starts
    await t.search('b');
    assert.deepEqual(waits, []);
    await t.search('c'); // so this one waits for the pace
    assert.deepEqual(waits, [1000]);
    clock += 10_000; // a quiet spell fills the burst up again
    await t.search('d');
    await t.search('e');
    assert.deepEqual(waits, [1000], 'two more starts went out without waiting');
    await t.search('f');
    assert.deepEqual(waits, [1000, 1000]);
  });

  test('requests that start together share the burst, so several posts are read at once', async () => {
    const waits: number[] = [];
    const t = table({
      minIntervalMs: 400,
      burst: 5,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await t.search('weiss'); // the session and the search: two starts
    await Promise.all(['yoely-weiss-shabbos', 'mendy-weiss-album', 'yoely-weiss-purim-26'].map((slug) => t.getPost(slug)));
    assert.deepEqual(waits, [], 'five starts fit in the burst');
  });

  test('trackUrl and parseTrackUrl round-trip, and reject addresses that are not ours', () => {
    const t = table();
    const url = t.trackUrl({ slug: 'a-b' }, 2);
    assert.equal(url, `${site.url}/post/a-b#2`);
    assert.deepEqual(t.parseTrackUrl(url), { slug: 'a-b', index: 2 });
    assert.deepEqual(t.parseTrackUrl(`${site.url}/post/a-b`), { slug: 'a-b', index: 0 });
    assert.equal(t.parseTrackUrl('https://cdn.example.test/post/a-b#0'), undefined);
    assert.equal(t.parseTrackUrl(`${site.url}/post/a-b#abc`), undefined);
    assert.equal(t.parseTrackUrl(`${site.url}/post/a-b#99`), undefined);
    assert.equal(t.parseTrackUrl(`${site.url}/new-music`), undefined);
    assert.equal(t.parseTrackUrl('not a url'), undefined);
  });

  test('resolveUrl turns a post address into a direct, signed link and leaves other URLs alone', async () => {
    const t = table();
    const link = await t.resolveUrl(t.trackUrl({ slug: 'yoely-weiss-shabbos' }, 0));
    assert.ok(link.startsWith(`${site.url}/api/download/`), link);
    assert.equal(site.signed, 1);
    assert.equal(await t.resolveUrl('https://cdn.example.test/a.mp3'), 'https://cdn.example.test/a.mp3');
    assert.equal(await t.resolveUrl(`${site.url}/new-music`), `${site.url}/new-music`);
  });

  test('a signed link is reused briefly, then asked for again', async () => {
    let clock = 0;
    const t = table({ now: () => clock, linkTtlMs: 1000 });
    const url = t.trackUrl({ slug: 'yoely-weiss-shabbos' }, 0);
    const first = await t.resolveUrl(url);
    assert.equal(await t.resolveUrl(url), first);
    assert.equal(site.signed, 1);
    clock = 1001;
    assert.notEqual(await t.resolveUrl(url), first);
    assert.equal(site.signed, 2);
  });

  test('resolveUrl explains a post with no MP3 and a file that is no longer there', async () => {
    const t = table();
    await assert.rejects(
      t.resolveUrl(t.trackUrl({ slug: 'yoely-weiss-wedding-clip' }, 0)),
      (err) => err instanceof MusicTableError && /has no MP3 to download/.test(err.message),
    );
    await assert.rejects(
      t.resolveUrl(t.trackUrl({ slug: 'mendy-weiss-album' }, 5)),
      (err) => err instanceof MusicTableError && /no longer on the release/.test(err.message),
    );
  });

  test('by default it accepts only a download link on the site itself (which redirects to its storage)', async () => {
    const via = (link: string) => {
      const stub = (async (input: string | URL | Request, init?: RequestInit) => {
        if (new URL(String(input)).pathname === '/api/downloads') return Response.json({ url: link });
        return fetch(input, init);
      }) as typeof fetch;
      const t = new MusicTable({ baseUrl: site.url, fetch: stub, minIntervalMs: 0 });
      return t.resolveUrl(t.trackUrl({ slug: 'yoely-weiss-shabbos' }, 0));
    };
    assert.equal(await via('/api/download/abc'), `${site.url}/api/download/abc`);
    assert.equal(await via(`${site.url}/api/download/def`), `${site.url}/api/download/def`);
    for (const bad of ['https://evil.example/B.mp3', site.url.replace('http://', 'https://') + '/api/download/x', 'javascript:alert(1)']) {
      await assert.rejects(via(bad), (err) => err instanceof MusicTableError, bad);
    }
  });

  test('downloads go through the site’s redirect to its storage, and arrive whole', async () => {
    const t = table();
    const link = await t.resolveUrl(t.trackUrl({ slug: 'mendy-weiss-album' }, 1));
    const res = await fetch(link);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), site.bytes('mendy-weiss-album', 1));
    assert.deepEqual(site.fileRequests, ['GET /files/mendy-weiss-album/1/Two.mp3']);
  });

  test('musicTableFromEnv is on unless MUSIC_TABLE says off, and can be pointed elsewhere', () => {
    for (const off of ['off', 'OFF', 'false', 'no', '0']) assert.equal(musicTableFromEnv({ MUSIC_TABLE: off }), undefined, off);
    assert.ok(musicTableFromEnv({}) instanceof MusicTable);
    assert.equal(musicTableFromEnv({ MUSIC_TABLE: 'on', MUSIC_TABLE_URL: 'http://localhost:9/' })?.baseUrl, 'http://localhost:9');
  });
});

describe('resolvingAudio', () => {
  let site: MockMusicTable;
  before(async () => {
    site = await startMockMusicTable(POSTS);
  });
  after(() => site.close());
  beforeEach(() => site.reset());

  const make = () => {
    const calls: string[] = [];
    const io = {
      async checkAudio(url: string) {
        calls.push(`check ${url}`);
        return { ok: true as const, type: 'audio/mpeg' };
      },
      async fetchAudio(url: string, title?: string) {
        calls.push(`fetch ${url} as ${title}`);
        return { data: new Blob(['x']), fileName: 'x.mp3', mimeType: 'audio/mpeg', bytes: 1 };
      },
    };
    const table = new MusicTable({ baseUrl: site.url, minIntervalMs: 0, trustedFileUrl: () => true });
    return { calls, io, table, wrapped: resolvingAudio(table, io) };
  };

  test('checks a site file from what its post says, downloads through the signed link, and leaves other URLs alone', async () => {
    const { calls, table, wrapped } = make();
    const url = table.trackUrl({ slug: 'yoely-weiss-shabbos' }, 0);
    assert.deepEqual(await wrapped.checkAudio(url), { ok: true, type: 'audio/mpeg', bytes: site.bytes('yoely-weiss-shabbos').length });
    assert.deepEqual(calls, [], 'no separate request is made just to check it');
    await wrapped.fetchAudio(url, 'Yoely Weiss — Shabbos');
    assert.match(calls[0]!, new RegExp(`^fetch ${site.url}/api/download/\\S+ as Yoely Weiss — Shabbos$`));
    await wrapped.checkAudio('https://cdn.example.test/a.mp3');
    assert.equal(calls[1], 'check https://cdn.example.test/a.mp3');
  });

  test('refuses a site file over the size limit, going by what the post says', async () => {
    const { calls, table, io } = make();
    const limited = resolvingAudio(table, io, { maxBytes: 10 });
    const result = await limited.checkAudio(table.trackUrl({ slug: 'yoely-weiss-shabbos' }, 0));
    assert.ok(!result.ok && /limit/.test(result.reason), JSON.stringify(result));
    assert.deepEqual(calls, []);
  });

  test('turns a site problem into a refusal the user can read, and lets other errors through', async () => {
    const { table, wrapped, io } = make();
    const noMp3 = table.trackUrl({ slug: 'yoely-weiss-wedding-clip' }, 0);
    assert.deepEqual(await wrapped.checkAudio(noMp3), { ok: false, reason: '"Yoely Weiss - Wedding Clip" has no MP3 to download on music-table.com' });
    await assert.rejects(wrapped.fetchAudio(noMp3), (err) => err instanceof AudioFetchError && /has no MP3/.test(err.message));

    const broken = resolvingAudio(table, {
      ...io,
      checkAudio: async () => {
        throw new Error('boom');
      },
    });
    await assert.rejects(broken.checkAudio('https://cdn.example.test/a.mp3'), /boom/);
  });

  test('is a no-op when the source is off', () => {
    const { io } = make();
    assert.equal(resolvingAudio(undefined, io), io);
  });
});

describe('looking things up on the site from the bot', () => {
  let site: MockMusicTable;
  before(async () => {
    site = await startMockMusicTable(POSTS);
  });
  after(() => site.close());
  beforeEach(() => site.reset());

  function setup(options: { site?: MockMusicTable; catalog?: Catalog } = {}) {
    const where = options.site ?? site;
    const catalog = options.catalog ?? new Catalog(':memory:');
    const table = new MusicTable({ baseUrl: where.url, minIntervalMs: 0, trustedFileUrl: () => true });
    const audio = resolvingAudio(table, {
      checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }),
      fetchAudio: (url, title) => fetchAudio(url, title),
    });
    const source = createMusicTableSource({ musicTable: table, catalog });
    const bot = createBot({ catalog, checkAudio: audio.checkAudio, source });
    return {
      catalog,
      table,
      source,
      ask: (text: string) => bot.handle({ from: 'u', messageId: 'm1', text: `search ${text}` }),
      tap: (postback: string) => bot.handle({ from: 'u', messageId: 'm2', postback }),
    };
  }

  test('tracksOf names tracks from the post title, or from the file names when a post has several', async () => {
    const t = new MusicTable({ baseUrl: site.url, minIntervalMs: 0 });
    const single = tracksOf(t, await t.getPost('yoely-weiss-purim-26'));
    assert.deepEqual(single, [{ title: "Purim '26 & More", artist: 'Yoely Weiss', url: `${site.url}/post/yoely-weiss-purim-26#0`, post: 'yoely-weiss-purim-26' }]);
    const album = tracksOf(t, await t.getPost('mendy-weiss-album'));
    assert.deepEqual(album, [
      { title: 'One', artist: 'Mendy Weiss', url: `${site.url}/post/mendy-weiss-album#0`, post: 'mendy-weiss-album' },
      { title: 'Two', artist: 'Mendy Weiss', url: `${site.url}/post/mendy-weiss-album#1`, post: 'mendy-weiss-album' },
    ]);
  });

  test('lookup stores what it finds in the catalog, skips posts without MP3, and honours the limit', async () => {
    const { source, catalog } = setup();
    const found = await source.lookup('weiss', 3);
    assert.deepEqual(found.map((track) => `${track.artist} — ${track.title}`), ['Yoely Weiss — Shabbos', "Yoely Weiss — Purim '26 & More", 'Mendy Weiss — One']);
    // Every track of a post it read is kept, even the one the limit left out, so asking for it next time costs nothing.
    assert.equal(catalog.count(), 4);
    assert.deepEqual(catalog.get(found[0]!.id), found[0]);
  });

  test('a post that cannot be read is skipped without hiding the others', async () => {
    const { source } = setup();
    assert.deepEqual(await source.lookup('old song', 5), []);
    const found = await source.lookup('yoely weiss shabbos', 5);
    assert.equal(found.length, 1);
  });

  test('the site matches any word, so the bot keeps only posts that fit the whole request', async () => {
    site.looseSearch = true;
    const { source, catalog } = setup();
    assert.deepEqual(await source.lookup('zzzz shabbos', 5), []);
    assert.equal(catalog.count(), 0, 'unrelated posts are neither offered nor stored');
    const typo = await source.lookup('yoely wiess shabbos', 5);
    assert.deepEqual(typo.map((track) => track.title), ['Shabbos']);
  });

  test('"no match" is the answer when the site only has loosely related posts', async () => {
    site.looseSearch = true;
    const { ask } = setup();
    assert.deepEqual(await ask('zzzz shabbos'), [
      { kind: 'text', text: 'No match for "zzzz shabbos" on music-table.com. Try the artist and title, or fewer words.' },
    ]);
  });

  test('a request the catalog cannot answer is answered from the site: a menu, and its song is a caption, then the audio address', async () => {
    const { ask, tap } = setup();
    const menu = await ask('yoely weiss shabbos');
    assert.deepEqual(
      menu.map((reply) => (reply.kind === 'text' ? reply.text : reply.kind)),
      ['Shabbos — Yoely Weiss', 'Tap 👍 on a song to get it.'],
    );
    assert.deepEqual(await tap(textOf(menu[0]).postback!), [
      { kind: 'text', text: '🎵 Yoely Weiss — Shabbos' },
      { kind: 'audio', url: `${site.url}/post/yoely-weiss-shabbos#0`, title: 'Yoely Weiss — Shabbos' },
    ]);
    assert.deepEqual(site.searches, ['yoely weiss shabbos']);
  });

  test('the same request again is answered from the catalog without touching the site', async () => {
    const { ask } = setup();
    await ask('yoely weiss shabbos');
    const again = await ask('yoely weiss shabbos');
    assert.equal(again.length, 2);
    assert.deepEqual(site.searches, ['yoely weiss shabbos']);
  });

  test('several finds become choices, and a tap (or 👍) plays the one chosen', async () => {
    const { ask, tap } = setup();
    const replies = await ask('weiss');
    assert.deepEqual(
      replies.flatMap((reply) => (reply.kind === 'text' && reply.postback?.startsWith('play:') ? [reply.text] : [])),
      ['Shabbos — Yoely Weiss', "Purim '26 & More — Yoely Weiss", 'One — Mendy Weiss', 'Two — Mendy Weiss'],
      'songs by two artists: one list, each with its artist',
    );
    const asked = textOf(replies.at(-1));
    assert.deepEqual(
      asked.chips?.map((chip) => splitPostback(chip.postback).action),
      ['play:1', 'play:2', 'play:3', 'play:4'],
    );
    assert.deepEqual(await tap(asked.chips![3]!.postback), [
      { kind: 'text', text: '🎵 Mendy Weiss — Two' },
      { kind: 'audio', url: `${site.url}/post/mendy-weiss-album#1`, title: 'Mendy Weiss — Two' },
    ]);
  });

  test('a site problem is reported in plain words, and "no match" says the site was tried', async () => {
    const { ask } = setup();
    site.failSearch = true;
    assert.deepEqual(await ask('yoely'), [{ kind: 'text', text: "I couldn't search music-table.com right now: music-table.com's search answered HTTP 500." }]);
    site.failSearch = false;
    assert.deepEqual(await ask('zzzz'), [
      { kind: 'text', text: 'No match for "zzzz" on music-table.com. Try the artist and title, or fewer words.' },
    ]);
  });

  test('a post that disappears after it was found is refused politely when played', async () => {
    const posts: MockPost[] = [{ slug: 'a-song', title: 'Some Band - A Song', files: [{ name: 'A Song.mp3' }] }];
    const mine = await startMockMusicTable(posts);
    try {
      const catalog = new Catalog(':memory:');
      const menu = await setup({ site: mine, catalog }).ask('a song');
      posts[0]!.gone = true;
      const later = setup({ site: mine, catalog }); // a fresh client, as after a restart
      assert.deepEqual(await later.tap(textOf(menu[0]).postback!), [{ kind: 'text', text: 'I can\'t send "Some Band — A Song": that release is gone from music-table.com.' }]);
    } finally {
      await mine.close();
    }
  });
});

describe('how the lookup chooses and reads', () => {
  let site: MockMusicTable;
  before(async () => {
    site = await startMockMusicTable(POSTS);
  });
  after(() => site.close());
  beforeEach(() => site.reset());

  const make = (over: MusicTableOptions = {}) => {
    const catalog = new Catalog(':memory:');
    const notes: string[] = [];
    const events: SiteEvent[] = [];
    const table = new MusicTable({ baseUrl: site.url, minIntervalMs: 0, trustedFileUrl: () => true, onEvent: (event) => events.push(event), ...over });
    const source = createMusicTableSource({ musicTable: table, catalog, onNote: (note) => notes.push(note) });
    return { catalog, notes, events, table, source };
  };

  test('an exact title is the only post read, even when the site lists many', async () => {
    site.looseSearch = true; // the real site lists every post matching any one of the words
    const { source, notes } = make();
    const found = await source.lookup('yoely weiss shabbos', 5);
    assert.deepEqual(found.map((track) => track.title), ['Shabbos']);
    assert.deepEqual(site.postReads, ['yoely-weiss-shabbos']);
    assert.ok(notes.some((note) => /exact title/.test(note)), notes.join(' | '));
  });

  test('the site is searched for the words that matter, not for "play" or "by"', async () => {
    const { source } = make();
    const found = await source.lookup('Please play Yoely Weiss by shabbos', 5);
    assert.deepEqual(site.searches, ['yoely weiss shabbos']);
    assert.deepEqual(found.map((track) => track.title), ['Shabbos']);
  });

  test('every exact title match is offered, so the user can choose between artists', async () => {
    const twins = await startMockMusicTable([
      { slug: 'a-band-one-song', title: 'A Band - One Song', files: [{ name: 'a.mp3' }] },
      { slug: 'b-band-one-song', title: 'B Band - One Song', files: [{ name: 'b.mp3' }] },
      { slug: 'c-band-one-song', title: 'C Band - One Song', files: [{ name: 'c.mp3' }] },
      { slug: 'one-song-remix', title: 'D Band - One Song Remix', files: [{ name: 'd.mp3' }] },
    ]);
    try {
      const catalog = new Catalog(':memory:');
      const table = new MusicTable({ baseUrl: twins.url, minIntervalMs: 0 });
      const source = createMusicTableSource({ musicTable: table, catalog });
      const found = await source.lookup('one song', 5);
      assert.deepEqual(found.map((track) => `${track.artist} — ${track.title}`), ['A Band — One Song', 'B Band — One Song', 'C Band — One Song']);
    } finally {
      await twins.close();
    }
  });

  test('several posts are read at the same time, not one after another', async () => {
    site.postDelayMs = 60;
    const { source } = make();
    await source.lookup('weiss', 5);
    assert.ok(site.maxInFlightPosts >= 3, `only ${site.maxInFlightPosts} at once`);
  });

  test('a typo among three or more words is survived by leaving each word out in turn', async () => {
    const { source, notes } = make();
    const found = await source.lookup('yoely wiess shabbos', 5);
    assert.deepEqual(found.map((track) => track.title), ['Shabbos']);
    assert.deepEqual([...site.searches].sort(), ['wiess shabbos', 'yoely shabbos', 'yoely wiess', 'yoely wiess shabbos']);
    assert.deepEqual(site.postReads, ['yoely-weiss-shabbos'], 'only the post that fits is read');
    assert.ok(notes.some((note) => /left out/.test(note)), notes.join(' | '));
  });

  test('a typo in a two-word request is fixed from the spellings the site uses for the other word', async () => {
    const { source, notes } = make();
    const found = await source.lookup('yoely wiess', 5);
    assert.deepEqual(found.map((track) => track.title), ['Shabbos', "Purim '26 & More"]);
    assert.ok(notes.some((note) => note.includes('trying "yoely weiss"')), notes.join(' | '));
    assert.ok(site.searchKinds.every((kind) => kind === 'quick'), 'the quick search was enough');
  });

  test('a long name spelled another way is fixed, even two letters off and even when the typed spelling exists elsewhere on the site', async () => {
    const withDecoy = [
      { slug: 'avraham-fried-veyeda', title: 'Avraham Fried - Veyeda', files: [{ name: 'veyeda.mp3' }] },
      { slug: 'benny-friedman-live', title: 'Benny Friedman - Live', files: [{ name: 'live.mp3' }] },
      // The site really does use "Avrohom" for somebody else, so the typed word is not unknown to it.
      { slug: 'avrohom-mordechai-shwartz-nishmas', title: 'Avrohom Mordechai Shwartz Nishmas', files: [{ name: 'nishmas.mp3' }] },
    ];
    for (const posts of [withDecoy.slice(0, 2), withDecoy]) {
      const fried = await startMockMusicTable(posts);
      try {
        const catalog = new Catalog(':memory:');
        const notes: string[] = [];
        const table = new MusicTable({ baseUrl: fried.url, minIntervalMs: 0, trustedFileUrl: () => true });
        const source = createMusicTableSource({ musicTable: table, catalog, onNote: (note) => notes.push(note) });
        const found = await source.lookup('avrohom fried', 5);
        assert.deepEqual(found.map((track) => track.title), ['Veyeda'], `with ${posts.length} posts`);
        assert.ok(notes.some((note) => note.includes('trying "avraham fried"')), notes.join(' | '));
        assert.ok(fried.searchKinds.every((kind) => kind === 'quick'), 'the slow search page was not needed');
      } finally {
        await fried.close();
      }
    }
  });

  test('a first name spelled another way is fixed from the artist\'s own songs', async () => {
    const daskal = await startMockMusicTable([
      { slug: 'shloime-daskal-yedid-nefesh', title: 'Shloime Daskal - Yedid Nefesh', files: [{ name: 'yedid.mp3' }] },
      { slug: 'shloime-daskal-bonim', title: 'Shloime Daskal - Bonim', files: [{ name: 'bonim.mp3' }] },
      { slug: 'yanky-and-shloime-daskal-song', title: 'Yanky & Shloime Daskal - Song', files: [{ name: 'song.mp3' }] },
      { slug: 'solomon-klein-other', title: 'Solomon Klein - Other', files: [{ name: 'other.mp3' }] },
    ]);
    try {
      const catalog = new Catalog(':memory:');
      const notes: string[] = [];
      const table = new MusicTable({ baseUrl: daskal.url, minIntervalMs: 0, trustedFileUrl: () => true });
      const source = createMusicTableSource({ musicTable: table, catalog, onNote: (note) => notes.push(note) });
      const found = await source.lookup('shlomo daskal', 5);
      assert.deepEqual(found.map((track) => track.title).sort(), ['Bonim', 'Song', 'Yedid Nefesh']);
      assert.ok(notes.some((note) => note.includes('trying "shloime daskal"')), notes.join(' | '));
    } finally {
      await daskal.close();
    }
  });

  test('what the first searches already showed is used to fix a spelling, before asking the site about the word alone', async () => {
    const daskal = await startMockMusicTable([
      { slug: 'shloime-daskal-yedid-nefesh', title: 'Shloime Daskal - Yedid Nefesh', files: [{ name: 'yedid.mp3' }] },
      { slug: 'shloime-daskal-bonim', title: 'Shloime Daskal - Bonim', files: [{ name: 'bonim.mp3' }] },
    ]);
    try {
      const catalog = new Catalog(':memory:');
      const table = new MusicTable({ baseUrl: daskal.url, minIntervalMs: 0, trustedFileUrl: () => true });
      const source = createMusicTableSource({ musicTable: table, catalog });
      const found = await source.lookup('shlomo daskal yedid nefesh', 5);
      assert.deepEqual(found.map((track) => track.title), ['Yedid Nefesh']);
      assert.ok(!daskal.searches.includes('shlomo'), `looked up the word alone: ${daskal.searches.join(' | ')}`);
      assert.ok(daskal.searches.includes('shloime daskal yedid nefesh'), daskal.searches.join(' | '));
    } finally {
      await daskal.close();
    }
  });

  test('a word that cannot be a typo does not cost a trip to the slow search page', async () => {
    site.fuzzyPage = true;
    const { source } = make();
    assert.deepEqual(await source.lookup('שבת', 5), [], 'another alphabet');
    assert.deepEqual(await source.lookup('abc', 5), [], 'too short to have a typo');
    assert.equal(site.searchKinds.filter((kind) => kind === 'page').length, 0, site.searches.join(', '));
  });

  test('a typo near the end of a word is fixed by looking up how the word begins', async () => {
    const { source, notes } = make();
    const found = await source.lookup('shabos', 5);
    assert.deepEqual(found.map((track) => track.title), ['Shabbos']);
    assert.ok(site.searches.includes('shab'), `looked up ${site.searches.join(', ')}`);
    assert.ok(site.searchKinds.every((kind) => kind === 'quick'), 'the slow search page was not needed');
    assert.ok(notes.some((note) => note.includes('trying "shabbos"')), notes.join(' | '));
  });

  test('a typo the quick search cannot trace is fixed with the help of the search page', async () => {
    site.fuzzyPage = true; // the real search page forgives a swapped pair of letters; the quick search does not
    const { source, notes } = make();
    const found = await source.lookup('wiess', 5);
    assert.deepEqual(found.map((track) => track.title), ['Shabbos', "Purim '26 & More", 'One', 'Two']);
    assert.equal(site.searchKinds.filter((kind) => kind === 'page').length, 1, 'the page is asked once, for spellings only');
    assert.ok(notes.some((note) => note.includes('trying "weiss"')), notes.join(' | '));
  });

  test('falls back to the search page when the quick search is not available', async () => {
    site.quickSearch = false;
    const { source, events } = make();
    const found = await source.lookup('yoely weiss shabbos', 5);
    assert.deepEqual(found.map((track) => track.title), ['Shabbos']);
    assert.ok(site.searchKinds.every((kind) => kind === 'page'));
    assert.ok(events.some((event) => event.kind === 'search' && /search page, the quick search failed/.test(event.note ?? '')));
  });

  test('a request nothing matches, with no spelling to fix, gives up after looking up the unknown word', async () => {
    site.looseSearch = true;
    const { source } = make();
    assert.deepEqual(await source.lookup('zzzz shabbos', 5), []);
    assert.deepEqual(site.searches, ['zzzz shabbos', 'zzzz', 'zzz'], 'the word the results already use is not looked up again');
    assert.ok(site.searchKinds.every((kind) => kind === 'quick'));
  });

  test('the same search is asked of the site once, then remembered for a while', async () => {
    let clock = 0;
    const { source } = make({ now: () => clock, searchTtlMs: 1000 });
    await source.lookup('yoely weiss shabbos', 5);
    await source.lookup('Yoely  Weiss shabbos', 5); // same words, different case and spacing
    assert.equal(site.searches.length, 1);
    clock = 1001;
    await source.lookup('yoely weiss shabbos', 5);
    assert.equal(site.searches.length, 2);
  });

  test('asking for the same post twice at once reads it once', async () => {
    site.postDelayMs = 40;
    const { table } = make();
    await Promise.all([table.getPost('yoely-weiss-shabbos'), table.getPost('yoely-weiss-shabbos')]);
    assert.equal(site.postReads.length, 1);
  });

  test('reports what it did, and what it already knew, to a listener that may even be broken', async () => {
    const { table, events } = make();
    await table.search('yoely weiss shabbos');
    await table.search('yoely weiss shabbos');
    const url = table.trackUrl({ slug: 'yoely-weiss-shabbos' }, 0);
    await table.resolveUrl(url);
    await table.resolveUrl(url);
    assert.deepEqual(
      events.map((event) => `${event.kind}${event.cached ? ' (memory)' : ''}`),
      ['search', 'search (memory)', 'post', 'link', 'link (memory)'],
    );
    assert.equal(events[2]?.note, '1 MP3');

    const broken = new MusicTable({
      baseUrl: site.url,
      minIntervalMs: 0,
      onEvent: () => {
        throw new Error('the listener broke');
      },
    });
    assert.ok((await broken.search('weiss')).length > 0);
  });

  test('inspect gives a site file’s signed link, type and size, and nothing for other URLs', async () => {
    const { table } = make();
    const info = await table.inspect(table.trackUrl({ slug: 'yoely-weiss-shabbos' }, 0));
    assert.ok(info?.link.startsWith(`${site.url}/api/download/`));
    assert.equal(info?.type, 'audio/mpeg');
    assert.equal(info?.bytes, site.bytes('yoely-weiss-shabbos').length);
    assert.equal(await table.inspect('https://cdn.example.test/a.mp3'), undefined);
  });

  test('a file the site gives a generic type but names .mp3 is treated as audio', async () => {
    const odd = await startMockMusicTable([{ slug: 'odd-type', title: 'A - B', files: [{ name: 'B.mp3', mimeType: 'application/octet-stream' }] }]);
    try {
      const table = new MusicTable({ baseUrl: odd.url, minIntervalMs: 0 });
      assert.equal((await table.getPost('odd-type')).files[0]?.mimeType, 'audio/mpeg');
    } finally {
      await odd.close();
    }
  });
});

describe('music-table.com over Matrix, end to end', () => {
  let matrix: MockMatrix;
  let site: MockMusicTable;
  before(async () => {
    matrix = await startMockMatrix();
    site = await startMockMusicTable(POSTS);
  });
  after(async () => {
    await matrix.close();
    await site.close();
  });
  beforeEach(() => {
    matrix.reset();
    site.reset();
  });

  function makeRunner() {
    const catalog = new Catalog(':memory:');
    const table = new MusicTable({ baseUrl: site.url, minIntervalMs: 0, trustedFileUrl: () => true });
    const audio = resolvingAudio(table, {
      checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }),
      fetchAudio: (url, title) => fetchAudio(url, title),
    });
    const bot = createBot({ catalog, checkAudio: audio.checkAudio, source: createMusicTableSource({ musicTable: table, catalog }) });
    const chat = new MatrixClient({ token: matrix.token, homeserver: matrix.url });
    return createRunner({ chat, bot, chatID: matrix.roomId, fetchAudio: audio.fetchAudio, pollMs: 20, log: () => {} });
  }

  test('a song typed on the phone is found on the site and, 👍’d in its menu, arrives as the site’s own MP3', async () => {
    const runner = makeRunner();
    await runner.prime();
    matrix.addMessage(matrix.ghost, { msgtype: 'm.text', body: 'search yoely weiss shabbos' });
    await runner.tick();
    assert.deepEqual(matrix.sent.map((event) => event.content.body), ['🎵 Shabbos — Yoely Weiss', '‎Tap 👍 on a song to get it.']);
    matrix.addReaction(matrix.ghost, matrix.sent[0]!.eventId, '👍');
    await runner.tick();

    assert.equal(matrix.sent.length, 4);
    assert.deepEqual(matrix.sent[2]?.content, { msgtype: 'm.text', body: '🎵 Yoely Weiss — Shabbos' });
    const audio = matrix.sent[3]?.content;
    assert.equal(audio?.msgtype, 'm.audio');
    assert.equal(audio?.filename, 'Yoely Weiss — Shabbos.mp3');
    assert.equal(audio?.info.mimetype, 'audio/mpeg');
    assert.deepEqual(matrix.uploads[0]?.bytes, site.bytes('yoely-weiss-shabbos'));
  });
});

describe('the site’s release pages and lists', () => {
  const RELEASES: MockPost[] = [
    { slug: 'new-single', title: 'Avrumi - Vay Lon', files: [{ name: 'Avrumi - Vay Lon.mp3' }], publishedAt: '2026-10-15T15:43:37.000Z', views: 1234, coverId: 'vay-lon.jpg', category: 'Singles' },
    { slug: 'chanukah-song', title: 'Shira Choir - Haneiros', files: [{ name: 'Haneiros.mp3' }], publishedAt: '2025-12-21T19:00:47.000Z', views: 5532, category: 'Videos', categoryPages: ['chanukah'] },
    { slug: 'sold-album', title: 'Big Star - Paid Album', files: [{ name: '01 One.mp3' }, { name: '02 Two.mp3' }], price: 999, publishedAt: '2025-11-01T00:00:00.000Z', views: 80 },
    { slug: 'just-a-video', title: 'Someone - A Clip', publishedAt: '2025-10-01T00:00:00.000Z', category: 'Videos', views: 9000 },
  ];
  let site: MockMusicTable;
  before(async () => {
    site = await startMockMusicTable(RELEASES);
  });
  after(() => site.close());
  beforeEach(() => site.reset());
  const table = () => new MusicTable({ baseUrl: site.url, minIntervalMs: 0 });

  test('a release page gives the release’s name, files, picture, views and date', async () => {
    const post = await table().getPost('new-single');
    assert.deepEqual(post, {
      id: 'new-single',
      slug: 'new-single',
      title: 'Avrumi - Vay Lon',
      url: `${site.url}/post/new-single`,
      files: [{ name: 'Avrumi - Vay Lon.mp3', path: 'f0-10', size: site.bytes('new-single').length, mimeType: 'audio/mpeg' }],
      cover: `${site.url}/media/covers/vay-lon.jpg`,
      views: 1234,
      publishedAt: '2026-10-15T15:43:37.000Z',
    });
    assert.throws(() => parsePostPage('<html>a page with no release</html>', 'x', site.url), (err) => err instanceof MusicTableError && /couldn't read/.test(err.message));
  });

  test('a release the site sells is no song here: its files are known but not offered, and not downloaded', async () => {
    const t = table();
    const sold = await t.getPost('sold-album');
    assert.equal(sold.forSale, true);
    assert.equal(sold.files.length, 2);
    assert.deepEqual(tracksOf(t, sold), []);
    await assert.rejects(t.resolveUrl(t.trackUrl(sold, 0)), (err) => err instanceof MusicTableError && /sold on music-table\.com/.test(err.message));
    assert.equal(site.signed, 0, 'it never asked for a link');
  });

  test('lists come a page at a time, newest first or most viewed first, and for one category', async () => {
    site.perPage = 2;
    const t = table();
    const first = await t.listReleases();
    assert.deepEqual([first.page, first.pages], [1, 2]);
    assert.deepEqual(first.releases.map((release) => release.slug), ['new-single', 'chanukah-song']);
    assert.deepEqual(first.releases[1], {
      slug: 'chanukah-song',
      title: 'Shira Choir - Haneiros',
      url: `${site.url}/post/chanukah-song`,
      categories: ['videos', 'chanukah'],
      views: 5532,
      publishedAt: '2025-12-21T19:00:47.000Z',
    });
    const second = await t.listReleases(2);
    assert.deepEqual(second.releases.map((release) => [release.slug, release.forSale ?? false]), [['sold-album', true], ['just-a-video', false]]);
    assert.deepEqual((await t.listReleases(1, { sort: 'views' })).releases.map((release) => release.slug), ['just-a-video', 'chanukah-song']);
    assert.deepEqual((await t.listReleases(1, { category: 'chanukah' })).releases.map((release) => release.slug), ['chanukah-song']);
    await assert.rejects(t.listReleases(1, { category: 'no/such' }), (err) => err instanceof MusicTableError);
  });

  test('a list page that has changed shape is an error, not an empty list', () => {
    assert.throws(() => parseReleaseList('<html>nothing here</html>', site.url), (err) => err instanceof MusicTableError && /may have changed/.test(err.message));
  });
});
