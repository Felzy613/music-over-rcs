import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import type { DownloadedAudio } from '../src/audio-fetch.ts';
import { splitArtists } from '../src/artists.ts';
import { createBot, joinLists } from '../src/bot.ts';
import { Catalog, choicesIn, linksIn, type SitePost } from '../src/catalog.ts';
import { catalogBrowse } from '../src/library/browse.ts';
import { AudioCache, cachedCheck, cachedFetch, prefetch, songsToKeep } from '../src/library/audio-cache.ts';
import { buildDigest, categoryLabel } from '../src/library/digest.ts';
import { LibraryJobs, localDay, parseDailyTime, STATE } from '../src/library/jobs.ts';
import { syncSite } from '../src/library/sync.ts';
import { coverUrl, MusicTable, parseFeed } from '../src/sources/music-table.ts';
import type { Reply, Track } from '../src/types.ts';
import { startMockMusicTable, type MockMusicTable, type MockPost } from './helpers/mock-music-table.ts';

/** A time on a day in October 2026, in this machine's time zone (the schedule works in local time). */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const iso = (date: Date) => date.toISOString();
const texts = (replies: Reply[]) => replies.flatMap((reply) => (reply.kind === 'text' ? [reply.text] : []));

const post = (over: Partial<SitePost> & { slug: string }): Omit<SitePost, 'firstSeenAt' | 'announcedAt'> => ({
  title: over.slug,
  category: '',
  publishedAt: iso(at(5, 12)),
  views: 0,
  audioFiles: 1,
  ...over,
});

describe("library: the catalog's new tables", () => {
  let catalog: Catalog;
  beforeEach(() => {
    catalog = new Catalog(':memory:');
  });
  afterEach(() => catalog.close());

  test('a song keeps its picture, and an update without one leaves it', () => {
    const first = catalog.add({ title: 'Ana Elech', artist: 'Oizer Oberlander', url: 'https://x.test/post/a#0', cover: 'https://img.test/a.jpg' });
    assert.equal(first.cover, 'https://img.test/a.jpg');
    const again = catalog.add({ title: 'Ana Elech', artist: 'Oizer Oberlander', url: 'https://x.test/post/a#0' });
    assert.equal(again.cover, 'https://img.test/a.jpg');
    assert.equal(catalog.byUrl('https://x.test/post/a#0')?.id, first.id);
    assert.equal(catalog.search('ana elech')[0]?.cover, 'https://img.test/a.jpg');
    const plain = catalog.add({ title: 'No Picture', url: 'https://x.test/b.mp3' });
    assert.equal('cover' in plain, false, 'a song without a picture has no cover field at all');
  });

  test('a catalog made before songs had pictures gets the column when opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mors-catalog-'));
    try {
      const path = join(dir, 'old.db');
      const { DatabaseSync } = await import('node:sqlite');
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE tracks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL DEFAULT '', url TEXT NOT NULL UNIQUE, added_at TEXT NOT NULL DEFAULT (datetime('now')))`);
      old.prepare('INSERT INTO tracks (title, artist, url) VALUES (?, ?, ?)').run('Old Song', 'Old Band', 'https://x.test/old.mp3');
      old.close();
      const upgraded = new Catalog(path);
      assert.equal(upgraded.add({ title: 'New', url: 'https://x.test/new.mp3', cover: 'https://img.test/n.jpg' }).cover, 'https://img.test/n.jpg');
      assert.equal(upgraded.get(1)?.title, 'Old Song');
      upgraded.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('posts are recorded once, refreshed later, and known as new only the first time', () => {
    assert.deepEqual(catalog.savePost(post({ slug: 'a', views: 10, category: 'Singles' }), at(5, 13)), { isNew: true });
    assert.deepEqual(catalog.savePost(post({ slug: 'a', views: 25, category: '' }), at(6, 13)), { isNew: false });
    const saved = catalog.sitePost('a')!;
    assert.equal(saved.views, 25);
    assert.equal(saved.category, 'Singles', 'a missing category does not wipe the known one');
    assert.equal(saved.firstSeenAt, iso(at(5, 13)));
    catalog.savePost(post({ slug: 'a', views: 3 }));
    assert.equal(catalog.sitePost('a')!.views, 25, 'views never go down');
  });

  test('posts still to announce: published since a time, not announced yet, newest first', () => {
    catalog.savePost(post({ slug: 'old', publishedAt: iso(at(1, 9)) }));
    catalog.savePost(post({ slug: 'mid', publishedAt: iso(at(5, 9)) }));
    catalog.savePost(post({ slug: 'new', publishedAt: iso(at(5, 18)) }));
    assert.deepEqual(catalog.postsToAnnounce(at(4, 0)).map((p) => p.slug), ['new', 'mid']);
    catalog.markAnnounced(['new'], at(6, 9));
    assert.deepEqual(catalog.postsToAnnounce(at(4, 0)).map((p) => p.slug), ['mid']);
    assert.equal(catalog.sitePost('new')?.announcedAt, iso(at(6, 9)));
  });

  test('popular posts are the most viewed with music in a window; newest posts are those with music', () => {
    catalog.savePost(post({ slug: 'video', views: 9000, audioFiles: 0, publishedAt: iso(at(5, 9)) }));
    catalog.savePost(post({ slug: 'hit', views: 3000, publishedAt: iso(at(3, 9)) }));
    catalog.savePost(post({ slug: 'fresh', views: 100, publishedAt: iso(at(6, 9)) }));
    catalog.savePost(post({ slug: 'ancient', views: 99_000, publishedAt: iso(new Date(2026, 6, 1)) }));
    assert.deepEqual(catalog.popularPosts(at(1, 0), 5).map((p) => p.slug), ['hit', 'fresh']);
    assert.deepEqual(catalog.newestPosts(2).map((p) => p.slug), ['fresh', 'hit']);
    assert.equal(catalog.postCount(), 4);
  });

  test('plays are counted; the most played come first, ties going to the most recent', () => {
    const a = catalog.add({ title: 'A', url: 'https://x.test/a.mp3' });
    const b = catalog.add({ title: 'B', url: 'https://x.test/b.mp3' });
    const c = catalog.add({ title: 'C', url: 'https://x.test/c.mp3' });
    catalog.recordPlay(a.id, at(5, 9));
    catalog.recordPlay(b.id, at(5, 10));
    catalog.recordPlay(b.id, at(5, 11));
    catalog.recordPlay(c.id, at(5, 12));
    assert.deepEqual(
      catalog.mostPlayed(3).map((t) => [t.title, t.plays]),
      [
        ['B', 2],
        ['C', 1],
        ['A', 1],
      ],
    );
    catalog.remove(b.id);
    assert.deepEqual(catalog.mostPlayed(3).map((t) => t.title), ['C', 'A'], "a removed song's plays go with it");
  });

  test('the options on offer are kept in the database, and anything unreadable counts as none', () => {
    const store = choicesIn(catalog);
    assert.equal(store.load(), undefined);
    store.save({ chips: [{ label: '1. A', postback: 'play:1' }], at: 5, validMs: 60_000 });
    assert.deepEqual(choicesIn(catalog).load(), { chips: [{ label: '1. A', postback: 'play:1' }], at: 5, validMs: 60_000 });
    store.save(undefined);
    assert.equal(store.load(), undefined);
    catalog.setState('chat.choices', '{broken');
    assert.equal(store.load(), undefined);
  });

  test('small facts are kept between runs', () => {
    assert.equal(catalog.getState('x'), undefined);
    catalog.setState('x', '1');
    catalog.setState('x', '2');
    assert.equal(catalog.getState('x'), '2');
  });
});

describe('library: reading the site', () => {
  test('parseFeed reads each post: link, title, date and category, through CDATA and entities', () => {
    const xml = `<rss><channel><title>Music Table</title>
      <item><title><![CDATA[Yumi Lowy - Mi Adir]]></title><link>https://www.music-table.com/post/yumi-lowy-mi-adir</link>
        <category><![CDATA[Singles]]></category><pubDate>Mon, 05 Oct 2026 15:06:12 GMT</pubDate></item>
      <item><title>Tzali Gold &#38; Dovy Meisels - Galei Kevoid</title><link>https://www.music-table.com/post/tzali-gold-dovy-meisels-galei-kevoid</link>
        <category>Weddings &amp; Events</category><pubDate>Mon, 28 Sep 2026 01:26:00 GMT</pubDate></item>
      <item><title>No link</title><pubDate>Mon, 28 Sep 2026 01:26:00 GMT</pubDate></item>
    </channel></rss>`;
    assert.deepEqual(parseFeed(xml), [
      { slug: 'yumi-lowy-mi-adir', title: 'Yumi Lowy - Mi Adir', category: 'Singles', publishedAt: '2026-10-05T15:06:12.000Z' },
      { slug: 'tzali-gold-dovy-meisels-galei-kevoid', title: 'Tzali Gold & Dovy Meisels - Galei Kevoid', category: 'Weddings & Events', publishedAt: '2026-09-28T01:26:00.000Z' },
    ]);
  });

  test('coverUrl asks the image host for a chat-sized JPEG, and refuses odd ids', () => {
    assert.equal(
      coverUrl('0ba30e_dd79~mv2.png'),
      'https://static.wixstatic.com/media/0ba30e_dd79~mv2.png/v1/fill/w_640,h_360,al_c,q_80/cover.jpg',
    );
    assert.equal(coverUrl('../../etc/passwd'), undefined);
    assert.equal(coverUrl('a b'), undefined);
  });

  test('listPosts reads files, pictures, views and dates for many posts in one request', async () => {
    const site = await startMockMusicTable([
      { slug: 'new-one', title: 'Band - New One', files: [{ name: 'New One.mp3' }], views: 552, publishedAt: '2026-10-05T17:37:57.000Z', coverId: 'img1~mv2.png' },
      { slug: 'clip', title: 'Band - Clip', video: true, views: 790, publishedAt: '2026-10-05T12:41:50.000Z' },
    ]);
    try {
      const table = new MusicTable({ baseUrl: site.url, minIntervalMs: 0 });
      const posts = await table.listPosts();
      assert.equal(site.listReads, 1);
      assert.deepEqual(
        posts.map((p) => ({ slug: p.slug, files: p.files.length, views: p.views, publishedAt: p.publishedAt, cover: p.cover })),
        [
          { slug: 'new-one', files: 1, views: 552, publishedAt: '2026-10-05T17:37:57.000Z', cover: coverUrl('img1~mv2.png') },
          { slug: 'clip', files: 0, views: 790, publishedAt: '2026-10-05T12:41:50.000Z', cover: undefined },
        ],
      );
      // Read already, so reading one of them again is free.
      await table.getPost('new-one');
      assert.deepEqual(site.postReads, []);
    } finally {
      await site.close();
    }
  });
});

const SITE_POSTS: MockPost[] = [
  { slug: 'oizer-ana-elech', title: 'Oizer Oberlander - Ana Elech', files: [{ name: 'Ana Elech.mp3' }], publishedAt: iso(at(5, 17)), views: 552, category: 'Singles', coverId: 'img1~mv2.png' },
  { slug: 'yumi-mi-adir', title: 'Yumi Lowy - Mi Adir', files: [{ name: 'Mi Adir.mp3' }], publishedAt: iso(at(5, 15)), views: 722, category: 'Singles', coverId: 'img2~mv2.jpg' },
  { slug: 'hershey-makdim', title: 'Hershey Eisenbach - Makdim Shalom', files: [{ name: 'Makdim Shalom.mp3' }], video: true, publishedAt: iso(at(5, 12)), views: 790, category: 'Videos', coverId: 'img3~mv2.jpg' },
  { slug: 'clip-only', title: 'Some Band - The Clip', video: true, publishedAt: iso(at(5, 11)), views: 900, category: 'Videos' },
  {
    slug: 'tyh-album',
    title: 'TYH Nation - Bardichevers (Full Album)',
    files: [{ name: 'TYH Nation - One.mp3' }, { name: 'TYH Nation - Two.mp3' }],
    publishedAt: iso(at(1, 9)),
    views: 3392,
    category: 'Singles',
    coverId: 'img5~mv2.jpg',
  },
];

describe('library: keeping the catalog in step with the site', () => {
  let site: MockMusicTable;
  let catalog: Catalog;
  let table: MusicTable;
  beforeEach(async () => {
    site = await startMockMusicTable(SITE_POSTS);
    catalog = new Catalog(':memory:');
    table = new MusicTable({ baseUrl: site.url, minIntervalMs: 0 });
  });
  afterEach(async () => {
    catalog.close();
    await site.close();
  });

  test('records every post with its category, and every MP3 as a song with its picture', async () => {
    const result = await syncSite({ musicTable: table, catalog, now: () => at(5, 18) });
    assert.equal(result.seen, 5);
    assert.equal(result.fresh.length, 5);
    assert.equal(result.songs, 5, 'one song each, two for the album, none for the clip');
    assert.equal(site.listReads, 1);
    assert.equal(site.feedReads, 1);
    assert.equal(catalog.sitePost('hershey-makdim')?.category, 'Videos');
    assert.equal(catalog.sitePost('clip-only')?.audioFiles, 0);
    const song = catalog.byUrl(table.trackUrl({ slug: 'oizer-ana-elech' }, 0));
    assert.deepEqual(song && { title: song.title, artist: song.artist, cover: song.cover }, {
      title: 'Ana Elech',
      artist: 'Oizer Oberlander',
      cover: coverUrl('img1~mv2.png'),
    });
    assert.deepEqual(catalog.search('tyh nation').map((t) => t.title).sort(), ['One', 'Two']);
  });

  test('only the first sync calls a post new; later syncs refresh what changed', async () => {
    await syncSite({ musicTable: table, catalog });
    const again = await syncSite({ musicTable: table, catalog });
    assert.equal(again.fresh.length, 0);
    assert.equal(catalog.count(), 5, 'no songs twice');
  });

  test('when the feed fails the posts still sync, without category names', async () => {
    const broken = {
      listPosts: table.listPosts.bind(table),
      trackUrl: table.trackUrl.bind(table),
      feed: async () => {
        throw new Error('feed down');
      },
    };
    const result = await syncSite({ musicTable: broken, catalog });
    assert.equal(result.seen, 5);
    assert.equal(catalog.sitePost('oizer-ana-elech')?.category, '');
  });
});

describe('library: the daily message', () => {
  const song = (id: number, title: string, artist: string, cover?: string): Track => ({ id, title, artist, url: `https://x.test/${id}`, ...(cover ? { cover } : {}) });
  const sitePost = (slug: string, category: string, audioFiles = 1, cover?: string): SitePost => ({
    slug,
    title: slug,
    category,
    publishedAt: iso(at(5, 12)),
    views: 0,
    audioFiles,
    firstSeenAt: iso(at(5, 12)),
    ...(cover ? { cover } : {}),
  });

  test('a heading, one picture of the covers (numbered), a line per song, then the video-only posts and how to pick', () => {
    const replies = buildDigest(
      [
        { post: sitePost('ana-elech', 'Singles'), song: song(7, 'Ana Elech', 'Oizer Oberlander', 'https://img.test/1.jpg') },
        { post: sitePost('makdim', 'Videos', 1, 'https://img.test/3.jpg'), song: song(9, 'Makdim Shalom', 'Hershey Eisenbach') },
        { post: { ...sitePost('clip', 'Videos', 0), title: 'Some Band - The Clip' } },
      ],
      { date: at(5, 9) },
    );
    assert.deepEqual(
      replies.map((reply) =>
        reply.kind === 'text' ? reply.text : reply.kind === 'collage' ? `[collage] ${reply.images.map((tile) => `${tile.number} ${tile.label} ${tile.url}`).join(' | ')}` : `[${reply.kind}]`,
      ),
      [
        'New music · Monday, Oct 5\n2 new songs on music-table.com',
        '[collage] 1 Oizer Oberlander — Ana Elech https://img.test/1.jpg | 2 Hershey Eisenbach — Makdim Shalom https://img.test/3.jpg',
        '1. Oizer Oberlander — Ana Elech · single',
        '2. Hershey Eisenbach — Makdim Shalom · music video',
        'Also new, video only:\n• Some Band - The Clip\n\nReply with a number or 👍 a song to get it, or text me any name.',
      ],
    );
    // Each song's line stands for it, so a 👍 on it gets the song.
    assert.deepEqual(
      replies.flatMap((reply) => (reply.kind === 'text' && reply.postback ? [reply.postback] : [])),
      ['play:7', 'play:9'],
    );
    const last = replies.at(-1)!;
    assert.ok(last.kind === 'text' && last.chips);
    assert.deepEqual(last.chips.map((chip) => chip.postback), ['play:7', 'play:9']);
    assert.equal(last.chipsValidMs, 24 * 60 * 60_000, 'the numbers work all day');
  });

  test('the picture holds up to the limit of covers; every song still gets its numbered line', () => {
    const items = [1, 2, 3].map((n) => ({ post: sitePost(`p${n}`, 'Singles', 1, `https://img.test/${n}.jpg`), song: song(n, `Song ${n}`, 'Band') }));
    const replies = buildDigest(items, { date: at(5, 9), maxPictures: 2 });
    const collage = replies.find((reply) => reply.kind === 'collage');
    assert.ok(collage && collage.kind === 'collage');
    assert.deepEqual(collage.images.map((tile) => tile.number), [1, 2]);
    assert.deepEqual(texts(replies).filter((line) => /^\d\. /.test(line)), ['1. Band — Song 1 · single', '2. Band — Song 2 · single', '3. Band — Song 3 · single']);
  });

  test('a day with nothing new sends nothing', () => {
    assert.deepEqual(buildDigest([], { date: at(5, 9) }), []);
  });

  test('category names read naturally after a song', () => {
    assert.deepEqual(['Singles', 'Videos', 'Weddings & Events', ''].map(categoryLabel), ['single', 'music video', 'Weddings & Events', '']);
  });
});

describe('library: the schedule', () => {
  let site: MockMusicTable | undefined;
  let catalog: Catalog;
  let opened: Catalog | undefined;
  afterEach(async () => {
    opened?.close();
    opened = undefined;
    await site?.close();
    site = undefined;
  });

  async function setUp(posts: MockPost[], options: { digestAt?: { hour: number; minute: number } | undefined; failAnnounce?: number; scan?: boolean } = {}) {
    site = await startMockMusicTable(posts);
    catalog = new Catalog(':memory:');
    opened = catalog;
    // The whole-site scan has its own tests; here it is done already, so only the sync reads the list.
    if (!options.scan) catalog.setState(STATE.scanDone, iso(at(1, 0)));
    let clock = at(6, 8);
    const sent: Reply[][] = [];
    const logs: string[] = [];
    let failures = options.failAnnounce ?? 0;
    const jobs = new LibraryJobs({
      musicTable: new MusicTable({ baseUrl: site.url, minIntervalMs: 0 }),
      catalog,
      announce: async (replies) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('chat unreachable');
        }
        sent.push(replies);
      },
      digestAt: 'digestAt' in options ? options.digestAt : { hour: 9, minute: 0 },
      fetchAudio: async () => {
        throw new Error('no downloads in these tests');
      },
      log: (line) => logs.push(line),
      now: () => clock,
    });
    return {
      jobs,
      sent,
      logs,
      site: site!,
      setClock: (date: Date) => {
        clock = date;
      },
    };
  }

  const fresh = (day: number, hour: number): MockPost[] => [
    { slug: `song-${day}-${hour}`, title: `Band - Song ${day}.${hour}`, files: [{ name: 'song.mp3' }], publishedAt: iso(at(day, hour)), category: 'Singles', coverId: 'img~mv2.jpg' },
    { slug: `clip-${day}-${hour}`, title: `Band - Clip ${day}.${hour}`, video: true, publishedAt: iso(at(day, hour - 1)), category: 'Videos' },
  ];

  test('started after the time on its first day, it waits for tomorrow; then it sends once', async () => {
    const t = await setUp(fresh(6, 18));
    t.setClock(at(6, 20));
    await t.jobs.check();
    assert.equal(t.sent.length, 0, 'no surprise message the evening it is switched on');
    t.setClock(at(7, 9));
    await t.jobs.check();
    assert.equal(t.sent.length, 1);
    assert.match(texts(t.sent[0]!)[0]!, /^New music · Wednesday, Oct 7\n1 new song on music-table\.com$/);
    assert.ok(t.sent[0]!.some((reply) => reply.kind === 'collage'), 'with the album art');
    t.setClock(at(7, 9, 5));
    await t.jobs.check();
    assert.equal(t.sent.length, 1, 'once a day');
    assert.equal(catalog.getState(STATE.digestDate), localDay(at(7, 9)));
  });

  test('started before the time, the first message comes that same morning', async () => {
    const t = await setUp(fresh(6, 7));
    t.setClock(at(6, 8));
    await t.jobs.check();
    assert.equal(t.sent.length, 0);
    t.setClock(at(6, 9));
    await t.jobs.check();
    assert.equal(t.sent.length, 1);
  });

  test('a Mac asleep at the time sends when it wakes, once', async () => {
    const t = await setUp(fresh(6, 7));
    t.setClock(at(6, 8));
    await t.jobs.check();
    t.setClock(at(6, 22, 30)); // the lid was closed all day
    await t.jobs.check();
    await t.jobs.check();
    assert.equal(t.sent.length, 1);
  });

  test('posts go out once: the next day has nothing new, so no message, and the day still counts as done', async () => {
    const t = await setUp(fresh(6, 7));
    t.setClock(at(6, 8));
    await t.jobs.check();
    t.setClock(at(6, 9));
    await t.jobs.check();
    t.setClock(at(7, 9));
    await t.jobs.check();
    assert.equal(t.sent.length, 1);
    assert.ok(t.logs.some((line) => /nothing new today/.test(line)), t.logs.join('\n'));
    assert.equal(catalog.getState(STATE.digestDate), localDay(at(7, 9)));
  });

  test('a message that could not be sent is tried again after half an hour, not every minute', async () => {
    const t = await setUp(fresh(6, 7), { failAnnounce: 1 });
    t.setClock(at(6, 8));
    await t.jobs.check();
    t.setClock(at(6, 9));
    await t.jobs.check();
    assert.equal(t.sent.length, 0);
    t.setClock(at(6, 9, 10));
    await t.jobs.check();
    assert.equal(t.sent.length, 0, 'not yet');
    t.setClock(at(6, 9, 31));
    await t.jobs.check();
    assert.equal(t.sent.length, 1);
  });

  test('with DIGEST_TIME=off no message is ever sent, and the catalog still syncs every three hours', async () => {
    const t = await setUp(fresh(6, 7), { digestAt: undefined });
    t.setClock(at(6, 9));
    await t.jobs.check();
    assert.equal(t.site.listReads, 1);
    t.setClock(at(6, 11));
    await t.jobs.check();
    assert.equal(t.site.listReads, 1, 'not due yet');
    t.setClock(at(6, 12));
    await t.jobs.check();
    assert.equal(t.site.listReads, 2);
    assert.equal(t.sent.length, 0);
  });

  test('a sync that fails is tried again in an hour', async () => {
    const t = await setUp(fresh(6, 7), { digestAt: undefined });
    t.site.rejectAll = true;
    t.setClock(at(6, 9));
    await t.jobs.check();
    assert.ok(t.logs.some((line) => /could not sync/.test(line)), t.logs.join('\n'));
    t.site.rejectAll = false;
    t.setClock(at(6, 9, 30));
    await t.jobs.check();
    assert.equal(t.site.listReads, 0);
    t.setClock(at(6, 10, 1));
    await t.jobs.check();
    assert.equal(t.site.listReads, 1);
  });

  test('a round with nothing to do does not stop the rounds after it', async () => {
    const t = await setUp(fresh(6, 7), { digestAt: undefined });
    t.setClock(at(6, 9));
    await t.jobs.check();
    for (const minute of [1, 2, 3]) {
      t.setClock(at(6, 9, minute));
      await t.jobs.check(); // nothing due
    }
    t.setClock(at(6, 12, 5));
    await t.jobs.check();
    assert.equal(t.site.listReads, 2);
  });

  test('a bot started soon after a sync still gets its songs ready on its first round', async () => {
    site = await startMockMusicTable(fresh(6, 7));
    catalog = new Catalog(':memory:');
    opened = catalog;
    const dir = await mkdtemp(join(tmpdir(), 'mors-ready-'));
    try {
      const table = new MusicTable({ baseUrl: site.url, minIntervalMs: 0, trustedFileUrl: () => true });
      await syncSite({ musicTable: table, catalog });
      catalog.setState(STATE.lastSync, iso(at(6, 8, 50))); // synced ten minutes ago, by another run
      catalog.setState(STATE.scanDone, iso(at(1, 0)));
      const downloads: string[] = [];
      const jobs = new LibraryJobs({
        musicTable: table,
        catalog,
        announce: async () => {},
        digestAt: undefined,
        cache: new AudioCache({ dir, index: catalog, maxBytes: 1_000_000 }),
        fetchAudio: async (url) => {
          downloads.push(url);
          return { data: new Blob([Buffer.alloc(10)]), fileName: 'song.mp3', mimeType: 'audio/mpeg', bytes: 10 };
        },
        prefetchPauseMs: 0,
        now: () => at(6, 9),
      });
      await jobs.check();
      assert.equal(site.listReads, 1, 'only the sync above: none was due');
      assert.equal(downloads.length, 1, 'the newest song was got ready anyway');
      await jobs.check();
      assert.equal(downloads.length, 1, 'once per run, not every minute');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the preview shows what would go out without sending or marking anything', async () => {
    const t = await setUp(fresh(6, 7));
    t.setClock(at(6, 10));
    const { replies, slugs } = await t.jobs.previewDigest();
    assert.equal(slugs.length, 2);
    assert.ok(replies.length > 0);
    assert.equal(t.sent.length, 0);
    assert.equal(catalog.postsToAnnounce(at(5, 0)).length, 2, 'still to announce');
  });

  test('DIGEST_TIME is read as a 24-hour time, or "off"', () => {
    assert.deepEqual(parseDailyTime(undefined), { hour: 9, minute: 0 });
    assert.deepEqual(parseDailyTime(' 7:05 '), { hour: 7, minute: 5 });
    assert.equal(parseDailyTime('off'), undefined);
    assert.ok(parseDailyTime('24:00') instanceof Error);
    assert.ok(parseDailyTime('9am') instanceof Error);
  });
});

describe('library: songs kept ready', () => {
  let dir: string;
  let catalog: Catalog;
  let clock: Date;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mors-cache-'));
    catalog = new Catalog(':memory:');
    clock = at(6, 9);
  });
  afterEach(async () => {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  });
  after(() => {});

  const song = (n: number, size = 1000): DownloadedAudio => ({
    data: new Blob([Buffer.alloc(size, n)]),
    fileName: `Song ${n}.mp3`,
    mimeType: 'audio/mpeg',
    bytes: size,
  });
  const cache = (maxBytes = 10_000, maxFiles = 50) => new AudioCache({ dir, index: catalog, maxBytes, maxFiles, now: () => clock });

  test('a kept song comes back exactly as it was stored', async () => {
    const kept = cache();
    await kept.put('https://x.test/1', song(1));
    const back = await kept.get('https://x.test/1');
    assert.ok(back);
    assert.equal(back.fileName, 'Song 1.mp3');
    assert.equal(back.mimeType, 'audio/mpeg');
    assert.deepEqual(Buffer.from(await back.data.arrayBuffer()), Buffer.alloc(1000, 1));
    assert.equal(await kept.get('https://x.test/other'), undefined);
    assert.deepEqual(kept.stats(), { files: 1, bytes: 1000 });
    assert.equal((await readdir(dir)).filter((name) => name.endsWith('.part')).length, 0, 'no half files left behind');
  });

  test('when full, the songs used least recently go first, except the ones asked to stay', async () => {
    const kept = cache(10_000, 3);
    for (const n of [1, 2, 3]) {
      clock = at(6, 9, n);
      await kept.put(`https://x.test/${n}`, song(n));
    }
    clock = at(6, 10);
    await kept.get('https://x.test/1'); // used again, so it's now the most recent
    clock = at(6, 11);
    await kept.put('https://x.test/4', song(4), new Set(['https://x.test/2']));
    assert.equal(kept.has('https://x.test/1'), true);
    assert.equal(kept.has('https://x.test/2'), true, 'spared');
    assert.equal(kept.has('https://x.test/3'), false, 'least recently used');
    assert.equal(kept.has('https://x.test/4'), true);
    assert.equal((await readdir(dir)).length, 3, 'its file is gone too');
  });

  test('with no limits set (the default) every song stays', async () => {
    const kept = new AudioCache({ dir, index: catalog, now: () => clock });
    for (let n = 1; n <= 60; n++) await kept.put(`https://x.test/${n}`, song(n, 50_000));
    assert.deepEqual(kept.stats(), { files: 60, bytes: 3_000_000 });
    assert.equal((await kept.trim()).length, 0);
  });

  test('the size limit counts bytes; a song bigger than the whole limit is not kept at all', async () => {
    const kept = cache(2500);
    await kept.put('https://x.test/1', song(1));
    await kept.put('https://x.test/2', song(2));
    await kept.put('https://x.test/3', song(3));
    assert.deepEqual(kept.stats(), { files: 2, bytes: 2000 });
    await kept.put('https://x.test/huge', song(9, 3000));
    assert.equal(kept.has('https://x.test/huge'), false);
  });

  test('a file that went missing or changed is forgotten instead of sent', async () => {
    const kept = cache();
    await kept.put('https://x.test/1', song(1));
    await kept.put('https://x.test/2', song(2));
    const [first, second] = catalog.listCachedAudio();
    await rm(join(dir, first!.file));
    await writeFile(join(dir, second!.file), 'short');
    assert.equal(await kept.get(first!.url), undefined);
    assert.equal(await kept.get(second!.url), undefined);
    assert.deepEqual(kept.stats(), { files: 0, bytes: 0 });
    assert.equal(existsSync(join(dir, second!.file)), false);
  });

  test('the downloader looks on disk first: a song is downloaded once, then sent from disk', async () => {
    let downloads = 0;
    const fetchFromDisk = cachedFetch(cache(), async () => {
      downloads += 1;
      return song(1);
    });
    await fetchFromDisk('https://x.test/1', 'Song 1');
    const second = await fetchFromDisk('https://x.test/1', 'Song 1');
    assert.equal(downloads, 1);
    assert.equal(second.bytes, 1000);
  });

  test('a kept song needs no check with the site', async () => {
    const kept = cache();
    await kept.put('https://x.test/1', song(1));
    let checks = 0;
    const check = cachedCheck(kept, async () => {
      checks += 1;
      return { ok: true, type: 'audio/mpeg' };
    });
    assert.deepEqual(await check('https://x.test/1'), { ok: true, type: 'audio/mpeg', bytes: 1000 });
    await check('https://x.test/2');
    assert.equal(checks, 1);
  });

  test('the songs worth keeping: your most played, then the newest, then the most viewed of the month', () => {
    const songUrl = (p: SitePost) => `https://x.test/post/${p.slug}#0`;
    const add = (slug: string, views: number, day: number) => {
      catalog.savePost(post({ slug, views, publishedAt: iso(at(day, 9)) }));
      return catalog.add({ title: slug, url: songUrl({ slug } as SitePost) });
    };
    const favourite = catalog.add({ title: 'favourite', url: 'https://x.test/fav.mp3' });
    catalog.recordPlay(favourite.id);
    add('newest', 10, 6);
    add('popular', 5000, 2);
    add('so-so', 300, 3);
    const picked = songsToKeep({ catalog, songUrl, now: () => at(6, 12) }, 3).map((t) => t.title);
    assert.deepEqual(picked, ['favourite', 'newest', 'so-so']);
    const more = songsToKeep({ catalog, songUrl, now: () => at(6, 12) }, 10).map((t) => t.title);
    assert.deepEqual(more, ['favourite', 'newest', 'so-so', 'popular'], 'newest five first, then by views; no repeats');
  });

  test('getting songs ready downloads only what is missing, one at a time with a pause, and counts failures', async () => {
    const kept = cache();
    await kept.put('https://x.test/1', song(1));
    const pauses: number[] = [];
    const asked: string[] = [];
    const songs = [1, 2, 3, 4].map((n) => ({ id: n, title: `Song ${n}`, artist: 'Band', url: `https://x.test/${n}` }));
    const result = await prefetch({
      cache: kept,
      songs,
      fetchAudio: async (url) => {
        asked.push(url);
        if (url.endsWith('/3')) throw new Error('gone');
        return song(Number(url.slice(-1)));
      },
      describe: (track) => track.title,
      pauseMs: 2000,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    assert.deepEqual(result, { downloaded: 2, alreadyKept: 1, failed: 1 });
    assert.deepEqual(asked, ['https://x.test/2', 'https://x.test/3', 'https://x.test/4']);
    assert.deepEqual(pauses, [2000, 2000], 'a pause between downloads, none before the first');
  });
});

describe('library: artists, trending and new', () => {
  let catalog: Catalog;
  beforeEach(() => {
    catalog = new Catalog(':memory:');
  });
  afterEach(() => catalog.close());

  const song = (slug: string, title: string, artist: string, day: number, views: number, files = 1) => {
    catalog.savePost(post({ slug, title: `${artist} - ${title}`, views, publishedAt: iso(at(day, 12)), audioFiles: files }));
    return catalog.add({ title, artist, url: `https://x.test/post/${slug}#0`, post: slug, releasedAt: iso(at(day, 12)) });
  };

  test('a credit names each artist once, however they are joined', () => {
    assert.deepEqual(splitArtists('Mendy Weiss, Yoely Davidowitz & Yoely Samuel'), ['Mendy Weiss', 'Yoely Davidowitz', 'Yoely Samuel']);
    assert.deepEqual(splitArtists('TYH Ft. Avraham Fried'), ['TYH', 'Avraham Fried']);
    assert.deepEqual(splitArtists('Matt Dubb x Itzik Dadya'), ['Matt Dubb', 'Itzik Dadya']);
    assert.deepEqual(splitArtists('Shloime Daskal & The Freilach Band'), ['Shloime Daskal', 'The Freilach Band']);
    assert.deepEqual(splitArtists('MBD feat. MBD'), ['MBD'], 'once each');
    assert.deepEqual(splitArtists(''), []);
  });

  test("an artist is found by their whole name (typos allowed) or a last name they're known by", () => {
    song('a', 'Shabbos', 'Yoely Weiss', 1, 10);
    song('b', 'Purim', 'Yoely Weiss', 2, 10);
    song('c', 'Elul', 'Yaakov Shwekey', 3, 10);
    song('d', 'Thank You', 'Yaakov Shwekey', 4, 10);
    song('e', 'Ani Yehudi', 'Yaakov Shwekey', 5, 10);
    song('f', 'One', 'Mendy Weiss, Yoely Weiss', 6, 10);
    assert.deepEqual(catalog.findArtist(['yoely', 'weiss']), { id: catalog.findArtist(['yoely', 'weiss'])!.id, name: 'Yoely Weiss', songs: 3 });
    assert.equal(catalog.findArtist(['yoely', 'wiess'])?.name, 'Yoely Weiss', 'a typo');
    assert.equal(catalog.findArtist(['shwekey'])?.name, 'Yaakov Shwekey', 'a last name, for an artist on several songs');
    assert.equal(catalog.findArtist(['weiss'])?.name, 'Yoely Weiss', 'the artist clearly known by that name');
    song('x', 'Lechaim', 'Shwekey', 9, 10); // a one-song credit spelled just "Shwekey"
    assert.equal(catalog.findArtist(['shwekey'])?.name, 'Yaakov Shwekey', 'the artist on clearly more songs beats a one-song exact name');
    assert.equal(catalog.findArtist(['yaakov'])?.name, 'Yaakov Shwekey', 'a first name an artist goes by');
    song('g', 'Two', 'Mendy Weiss', 7, 10);
    song('h', 'Three', 'Mendy Weiss', 8, 10);
    assert.equal(catalog.findArtist(['weiss']), undefined, 'now two artists share it and neither clearly leads');
    assert.equal(catalog.findArtist(['yoely', 'weiss', 'shabbos']), undefined, 'that is a song, not an artist');
    assert.deepEqual(catalog.artistSongs(catalog.findArtist(['yoely', 'weiss'])!.id, 10).map((t) => t.title), ['One', 'Purim', 'Shabbos'], 'newest first');
    assert.equal(catalog.artistCount(), 4, 'Yoely Weiss, Yaakov Shwekey, Mendy Weiss and the one-song "Shwekey"');

    song('i', 'Aderaba', 'Avraham Fried', 10, 10);
    assert.equal(catalog.findArtist(['avrohom', 'fried'])?.name, 'Avraham Fried', 'a whole name spelled the way it is said');
    assert.equal(catalog.findArtist(['avrohom', 'friedman']), undefined, 'a longer name is another artist, not a typo');
    assert.equal(catalog.findArtist(['mendy', 'wiess'])?.name, 'Mendy Weiss', 'still the plain typo rule first');
  });

  test("trending is views for a song's age; new is newest first; one song per post, only posts with music", () => {
    song('old-hit', 'Old Hit', 'Band', 1, 3000);
    song('fresh', 'Fresh', 'Band', 5, 2000);
    song('steady', 'Steady', 'Band', 3, 900);
    catalog.add({ title: 'Fresh (track 2)', artist: 'Band', url: 'https://x.test/post/fresh#1', post: 'fresh' });
    catalog.savePost(post({ slug: 'clip', title: 'Band - Clip', views: 99_999, publishedAt: iso(at(5, 13)), audioFiles: 0 }));
    const now = at(6, 12);
    assert.deepEqual(catalog.trendingSongs(now, 10).map((t) => t.title), ['Fresh', 'Old Hit', 'Steady']);
    assert.deepEqual(catalog.newestSongs(10).map((t) => t.title), ['Fresh', 'Steady', 'Old Hit']);
    assert.deepEqual(catalog.newestSongs(1, 1).map((t) => t.title), ['Steady'], 'paged');
    assert.equal(catalog.newestSongs(10)[0]?.views, 2000);
  });

  test('messages that stand for a song are remembered for a month', () => {
    const links = linksIn(catalog);
    links.link('$ev1', 'play:7');
    assert.equal(links.lookup('$ev1'), 'play:7');
    assert.equal(links.lookup('$other'), undefined);
    catalog.linkMessage('$ev2', 'play:8', new Date(Date.now() + 40 * 24 * 60 * 60_000));
    assert.equal(links.lookup('$ev1'), undefined, 'gone after a month');
  });

  describe('the bot with lists', () => {
    const bot = () => createBot({ catalog, checkAudio: async () => ({ ok: true, type: 'audio/mpeg' }), browse: catalogBrowse(catalog, () => at(6, 12)), now: () => at(6, 12) });
    const ask = (text: string) => bot().handle({ from: 'me', messageId: 'm', text });
    // The lists as one message each, as a chat without 👍 gets them; the split form has its own tests.
    const text = (replies: Reply[]) => {
      const first = joinLists(replies)[0];
      assert.ok(first && first.kind === 'text');
      return first;
    };

    test('"trending" and "new" list ten at a time; "more" goes on, and the numbers keep counting', async () => {
      for (let day = 1; day <= 12; day += 1) song(`s${day}`, `Song ${day}`, 'Band', Math.min(day, 6), day * 100);
      const first = text(await ask('trending'));
      assert.match(first.text, /^🔥 Trending on music-table\.com\n1\. Band — Song /);
      assert.match(first.text, /\n\nReply with a number to get it, or "more" for the next ones\.$/);
      assert.equal(first.chips?.length, 10);
      const more = text(await ask('more'));
      assert.match(more.text, /^🔥 Trending on music-table\.com \(continued\)\n11\. /);
      assert.match(more.text, /\n12\. /);
      assert.doesNotMatch(more.text, /"more"/, 'nothing after these');
      assert.equal(more.chips?.length, 12, 'every number shown so far still works');
      assert.equal(more.chipsValidMs, 2 * 60 * 60_000);
      assert.match(text(await ask('more')).text, /^Text me "trending", "new" or an artist first/);
      assert.match(text(await ask('new')).text, /^🆕 New on music-table\.com\n1\. Band — Song (6|7|8|9|10|11|12) · Oct 6/);
    });

    test("an artist's name lists their songs, newest first, with dates", async () => {
      song('a', 'Shabbos', 'Yoely Weiss', 1, 10);
      song('b', 'Purim', 'Yoely Weiss', 4, 10);
      const list = text(await ask('yoely weiss'));
      assert.equal(list.text, '🎤 Yoely Weiss · 2 releases, newest first\n1. Purim · Oct 4\n2. Shabbos · Oct 1\n\nReply with a number to get it.');
      assert.deepEqual(list.chips?.map((chip) => chip.postback), [`play:${catalog.findArtist(['yoely', 'weiss'])!.id && catalog.search('purim')[0]!.id}`, `play:${catalog.search('shabbos')[0]!.id}`]);
    });

    test('an album is one entry, and picking it lists its songs in order', async () => {
      catalog.savePost(post({ slug: 'tyh', title: 'TYH Nation - Bardichevers (Full Album)', views: 5000, publishedAt: iso(at(5, 12)), audioFiles: 3 }));
      for (const [i, title] of ['01 Intro', '02 Yiddishkeit', '10 Finale'].entries()) {
        catalog.add({ title, artist: 'TYH Nation', url: `https://x.test/post/tyh#${[0, 1, 10][i]}`, post: 'tyh', releasedAt: iso(at(5, 12)) });
      }
      song('single', 'Elul', 'Yaakov Shwekey', 4, 100);
      const list = text(await ask('trending'));
      assert.match(list.text, /\n1\. TYH Nation — Bardichevers \(Full Album\) · album, 3 songs · Oct 5\n2\. Yaakov Shwekey — Elul · Oct 4/);
      assert.equal(list.chips?.[0]?.postback, 'post:tyh');
      const album = await bot().handle({ from: 'me', messageId: 'm', postback: 'post:tyh' });
      assert.equal(text(album).text, 'TYH Nation · 3 songs\n1. 01 Intro\n2. 02 Yiddishkeit\n3. 10 Finale\n\nReply with a number to get it.', 'track 10 after track 1, not before 2');
      assert.match(text(await ask('tyh nation')).text, /\n1\. Bardichevers \(Full Album\) · album, 3 songs · Oct 5$/m);
    });

    test('"all" on a list with an album sends the album\'s songs too, at most twenty, and says what it could not send', async () => {
      catalog.savePost(post({ slug: 'big', title: 'Band - Big Album', publishedAt: iso(at(5, 12)), audioFiles: 25 }));
      for (let n = 0; n < 25; n += 1) catalog.add({ title: `Track ${n + 1}`, artist: 'Band', url: `https://x.test/post/big#${n}`, post: 'big' });
      const single = song('single', 'Single', 'Band', 4, 10);
      const checked = createBot({
        catalog,
        checkAudio: async (url) => (url.endsWith('#2') ? { ok: false, reason: 'gone' } : { ok: true, type: 'audio/mpeg' }),
        browse: catalogBrowse(catalog, () => at(6, 12)),
      });
      const replies = await checked.handle({ from: 'me', messageId: 'm', postback: `all:play:${single.id}|post:big` });
      assert.equal(replies[0]?.kind === 'text' && replies[0].text, '🎵 Here come all 19 songs (the first 20 of 26):');
      assert.equal(replies.filter((reply) => reply.kind === 'audio').length, 19);
      assert.deepEqual(replies.at(-1), { kind: 'text', text: "I couldn't send Band — Track 3." }, 'the file at #2 is the third track');
    });

    test('a song name still plays the song, and help mentions the lists', async () => {
      song('a', 'Shabbos', 'Yoely Weiss', 1, 10);
      assert.equal((await ask('yoely weiss shabbos'))[1]?.kind, 'audio');
      assert.match(text(await ask('help')).text, /"trending", "new", "chanukah", "purim", "wedding" or "vocal"/);
    });

    test('lists say so when the catalog has nothing yet', async () => {
      assert.match(text(await ask('trending')).text, /still being filled/);
    });
  });
});

describe('library: reading the whole site', () => {
  let site: MockMusicTable;
  let catalog: Catalog;
  afterEach(async () => {
    catalog.close();
    await site.close();
  });

  const many = (n: number): MockPost[] =>
    Array.from({ length: n }, (_, i) => ({ slug: `post-${i}`, title: `Artist ${i % 7} - Song ${i}`, files: [{ name: `song-${i}.mp3` }], publishedAt: iso(new Date(2026, 9, 6, 12) as Date) }));

  test('a few pages a round, picking up where it left off, until the whole site is in; then it stops', async () => {
    site = await startMockMusicTable(many(260));
    catalog = new Catalog(':memory:');
    const table = new MusicTable({ baseUrl: site.url, minIntervalMs: 0 });
    const jobs = new LibraryJobs({ musicTable: table, catalog, announce: async () => {}, fetchAudio: async () => { throw new Error('no'); }, now: () => at(6, 12) });
    await jobs.scanStep(2);
    assert.equal(catalog.getState(STATE.scanOffset), '100');
    assert.equal(catalog.getState(STATE.scanDone), undefined);
    // A new run of the bot carries on from there.
    const again = new LibraryJobs({ musicTable: table, catalog, announce: async () => {}, fetchAudio: async () => { throw new Error('no'); }, now: () => at(6, 13) });
    await again.scanStep(4);
    assert.equal(catalog.getState(STATE.scanOffset), '260');
    assert.ok(catalog.getState(STATE.scanDone));
    assert.equal(catalog.count(), 260);
    assert.equal(catalog.artistCount(), 7);
    assert.equal(site.feedReads, 0, 'old pages need no feed');
  });

  test('the command-line scan reads everything at once, pausing between requests', async () => {
    site = await startMockMusicTable(many(120));
    catalog = new Catalog(':memory:');
    const pauses: number[] = [];
    const jobs = new LibraryJobs({
      musicTable: new MusicTable({ baseUrl: site.url, minIntervalMs: 0 }),
      catalog,
      announce: async () => {},
      fetchAudio: async () => {
        throw new Error('no');
      },
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    const seen: number[] = [];
    assert.equal(await jobs.scanAll({ pauseMs: 500, progress: (n) => seen.push(n) }), 120);
    assert.deepEqual(seen, [50, 100, 120]);
    assert.deepEqual(pauses, [500, 500]);
    assert.equal(site.listReads, 3);
    assert.equal(catalog.count(), 120);
  });
});
