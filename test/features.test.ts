import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { createBot, joinLists } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { BridgeWatch, Health, type BridgeStatus } from '../src/health.ts';
import { catalogBrowse } from '../src/library/browse.ts';
import { Categories } from '../src/library/categories.ts';
import { buildDigest } from '../src/library/digest.ts';
import { catalogFollows } from '../src/library/follows.ts';
import { LibraryJobs, STATE } from '../src/library/jobs.ts';
import { seasonOn } from '../src/library/seasons.ts';
import { syncSite } from '../src/library/sync.ts';
import { MusicTable } from '../src/sources/music-table.ts';
import type { Reply } from '../src/types.ts';
import { startMockMusicTable, type MockMusicTable, type MockPost } from './helpers/mock-music-table.ts';

/** Noon on a day, in this machine's time zone. */
const day = (y: number, m: number, d: number, hour = 12, minute = 0) => new Date(y, m - 1, d, hour, minute);
const iso = (date: Date) => date.toISOString();
const texts = (replies: Reply[]) => replies.flatMap((reply) => (reply.kind === 'text' ? [reply.text] : []));

const CHANUKAH = '692ef1952612b1d9793d92e2';
const SINGLES = '5d2c506d874cd9041c2ecab4';
const VOCAL = '5f0000000000000000000001';

describe('seasons', () => {
  test('Chanukah, Purim (Adar II in a leap year), Sefirah and the Three Weeks, by the Jewish calendar', () => {
    const cases: Array<[Date, string | undefined]> = [
      [day(2026, 10, 6), undefined], // 25 Tishri
      [day(2026, 11, 25), 'chanukah'], // 15 Kislev: the run-up
      [day(2026, 12, 5), 'chanukah'], // 25 Kislev
      [day(2026, 12, 13), 'chanukah'], // 3 Tevet
      [day(2027, 1, 1), undefined], // 22 Tevet
      [day(2027, 2, 15), undefined], // 8 Adar I: not yet
      [day(2027, 3, 23), 'purim'], // 14 Adar II
      [day(2027, 4, 22), undefined], // 15 Nisan: Pesach, before the counting
      [day(2027, 5, 24), 'sefirah'], // 17 Iyar
      [day(2027, 6, 11), undefined], // 6 Sivan: Shavuos
      [day(2027, 7, 22), 'three-weeks'], // 17 Tamuz
      [day(2027, 8, 12), 'three-weeks'], // 9 Av
      [day(2028, 3, 12), 'purim'], // 14 Adar, a plain year
    ];
    for (const [date, expected] of cases) assert.equal(seasonOn(date)?.key, expected, date.toDateString());
    assert.match(seasonOn(day(2027, 5, 24))!.hint, /"vocal" for a cappella songs/);
  });
});

describe('holiday and category lists', () => {
  let site: MockMusicTable | undefined;
  let catalog: Catalog | undefined;
  afterEach(async () => {
    catalog?.close();
    await site?.close();
    catalog = undefined;
    site = undefined;
  });

  const posts: MockPost[] = [
    { slug: 'maoz-tzur', title: 'Leiby Moskowitz - Maoz Tzur 2.0', files: [{ name: 'a.mp3' }], categoryIds: [SINGLES, CHANUKAH], categoryPages: ['chanukah'], views: 900, publishedAt: '2025-12-10T12:00:00.000Z' },
    { slug: 'haneiros', title: 'Yisroel Adler - Haneiros Hallolu', files: [{ name: 'b.mp3' }], categoryIds: [SINGLES, CHANUKAH], categoryPages: ['chanukah'], views: 4000, publishedAt: '2024-12-20T12:00:00.000Z' },
    { slug: 'summer-hit', title: 'Band - Summer Hit', files: [{ name: 'c.mp3' }], categoryIds: [SINGLES], views: 99_000, publishedAt: '2026-07-01T12:00:00.000Z' },
  ];

  const setUp = async () => {
    site = await startMockMusicTable(posts);
    catalog = new Catalog(':memory:');
    const musicTable = new MusicTable({ baseUrl: site.url, minIntervalMs: 0 });
    let clock = day(2026, 12, 5);
    const categories = new Categories({ musicTable, catalog, now: () => clock });
    return { musicTable, categories, site, catalog, setClock: (date: Date) => (clock = date) };
  };

  test("a category's id is learned once, from the posts its page lists: the one they share, and the rarest if several", async () => {
    const { categories, site } = await setUp();
    assert.equal(await categories.id('chanukah'), CHANUKAH, 'both posts are Singles too, but Chanukah is the rare one');
    const reads = site.postReads.length;
    assert.equal(await categories.id('chanukah'), CHANUKAH);
    assert.equal(site.postReads.length, reads, 'remembered');
    assert.equal(await categories.id('purim'), undefined, 'a category with no page answers nothing');
  });

  test('a category list is its posts, most viewed first, read from the site at most once a day', async () => {
    const { categories, setClock, site } = await setUp();
    const songs = await categories.songs('chanukah', 10);
    assert.deepEqual(songs.map((song) => song.title), ['Haneiros Hallolu', 'Maoz Tzur 2.0']);
    const lists = site.listReads;
    await categories.songs('chanukah', 10);
    assert.equal(site.listReads, lists, 'not again the same day');
    setClock(day(2026, 12, 7));
    await categories.songs('chanukah', 10);
    assert.ok(site.listReads > lists, 'a day later, fresh');
  });

  test('texting "chanukah" lists it, and in season the general lists point to it', async () => {
    const { categories, catalog, site } = await setUp();
    const bot = createBot({
      catalog,
      checkAudio: async () => ({ ok: true, type: 'audio/mpeg' }),
      browse: catalogBrowse(catalog, () => day(2026, 12, 5), categories),
      now: () => day(2026, 12, 5),
    });
    const ask = async (text: string) => joinLists(await bot.handle({ from: 'me', messageId: 'm', text }))[0];
    const list = await ask('hanukkah');
    assert.ok(list?.kind === 'text');
    assert.match(list.text, /^🕎 Chanukah · most popular first\n1\. Yisroel Adler — Haneiros Hallolu · Dec 20, 2024\n2\. Leiby Moskowitz — Maoz Tzur 2\.0 · Dec 10, 2025/);
    await syncSite({ musicTable: new MusicTable({ baseUrl: site.url, minIntervalMs: 0 }), catalog, now: () => day(2026, 12, 5) });
    const trending = await ask('new');
    assert.ok(trending?.kind === 'text');
    assert.match(trending.text, /^🆕 New on music-table\.com\n🕎 Chanukah is here: text "chanukah" for Chanukah songs\./);
  });

  test('the daily message points to the season, and in Sefirah puts vocal songs first, marked', () => {
    const post = (slug: string, categoryIds: string[]) => ({
      slug,
      title: slug,
      category: 'Singles',
      publishedAt: iso(day(2027, 5, 23)),
      views: 0,
      audioFiles: 1,
      firstSeenAt: iso(day(2027, 5, 23)),
      categoryIds,
    });
    const song = (id: number, title: string) => ({ id, title, artist: 'Band', url: `https://x.test/${id}` });
    const replies = buildDigest(
      [
        { post: post('loud', [SINGLES]), song: song(1, 'Loud One') },
        { post: post('quiet', [SINGLES, VOCAL]), song: song(2, 'A Cappella One') },
      ],
      { date: day(2027, 5, 24), seasonHint: seasonOn(day(2027, 5, 24))!.hint, vocal: (item) => item.post.categoryIds?.includes(VOCAL) ?? false },
    );
    assert.deepEqual(texts(replies).slice(0, 3), [
      'New music · Monday, May 24\n2 new songs on music-table.com\n🎤 It\'s Sefirah: text "vocal" for a cappella songs.',
      'Band — A Cappella One · vocal',
      'Band — Loud One · single',
    ]);
  });
});

describe('following artists', () => {
  let site: MockMusicTable | undefined;
  let catalog: Catalog;
  afterEach(async () => {
    catalog.close();
    await site?.close();
    site = undefined;
  });

  const add = (n: number, artist: string, slug = `p${n}`) =>
    catalog.add({ title: `Song ${n}`, artist, url: `https://x.test/post/${slug}#0`, post: slug, cover: `https://img.test/${n}.jpg` });

  const chat = (now = () => day(2026, 10, 6)) => {
    const follows = catalogFollows(catalog, now);
    const bot = createBot({
      catalog,
      checkAudio: async () => ({ ok: true, type: 'audio/mpeg' }),
      onPlay: (track) => catalog.recordPlay(track.id),
      follows,
      browse: catalogBrowse(catalog, now),
      now,
    });
    return async (text: string) => texts(await bot.handle({ from: 'me', messageId: 'm', text }));
  };

  test('"follow", "following" and "unfollow"', async () => {
    catalog = new Catalog(':memory:');
    add(1, 'Yoely Weiss');
    const ask = chat();
    assert.deepEqual(await ask('follow yoely wiess'), ['🔔 Following Yoely Weiss. Their new songs will come to you as soon as they\'re out.']);
    assert.deepEqual(await ask('follow nobody at all'), ['I don\'t know an artist called "nobody at all". Try their full name as the site writes it.']);
    assert.deepEqual(await ask('following'), ['🔔 You follow: Yoely Weiss.\nText "unfollow" and a name to stop.']);
    assert.deepEqual(await ask('unfollow yoely weiss'), ['Stopped following Yoely Weiss.']);
    assert.deepEqual(await ask('stop following yoely weiss'), ["You weren't following Yoely Weiss; I won't start on my own."]);
    assert.match((await ask('following'))[0]!, /^You don't follow anyone yet/);
  });

  test('after three different songs by an artist the bot follows them for you, says so once, and never after an unfollow', async () => {
    catalog = new Catalog(':memory:');
    for (const n of [1, 2, 3, 4]) add(n, 'Yoely Weiss');
    add(5, 'Mendy Weiss');
    for (const n of [5, 6, 7]) catalog.add({ title: `Other ${n}`, artist: 'Mendy Weiss', url: `https://x.test/post/m${n}#0`, post: `m${n}` });
    const ask = chat();
    assert.equal((await ask('search yoely weiss song 1')).length, 0, 'a card and a file, no text');
    await ask('search yoely weiss song 1'); // the same song again doesn't count twice
    await ask('search yoely weiss song 2');
    const third = await ask('search yoely weiss song 3');
    assert.deepEqual(third, ['🔔 You\'ve had a few songs by Yoely Weiss, so I\'ll send you their new ones as soon as they\'re out. (Text "unfollow yoely weiss" to stop.)']);
    assert.deepEqual(await ask('search yoely weiss song 4'), [], 'said once');
    assert.deepEqual(catalog.followed().map((artist) => [artist.name, artist.auto]), [['Yoely Weiss', true]]);

    await ask('unfollow mendy weiss');
    for (const title of ['mendy weiss song 5', 'mendy weiss other 5', 'mendy weiss other 6', 'mendy weiss other 7']) await ask(title);
    assert.deepEqual(catalog.followed().map((artist) => artist.name), ['Yoely Weiss'], 'an unfollow sticks');
  });

  const alertPosts = (published: string): MockPost[] => [
    { slug: 'yw-new', title: 'Yoely Weiss - Brand New', files: [{ name: 'new.mp3' }], publishedAt: published, coverId: 'img1~mv2.jpg' },
    { slug: 'other-new', title: 'Someone Else - Also New', files: [{ name: 'other.mp3' }], publishedAt: published },
  ];

  async function alertSetUp(clock: { now: Date }, quiet?: { from: { hour: number; minute: number }; to: { hour: number; minute: number } }) {
    site = await startMockMusicTable([]);
    catalog = new Catalog(':memory:');
    catalog.setState(STATE.scanDone, iso(day(2026, 10, 1)));
    catalog.add({ title: 'Old', artist: 'Yoely Weiss', url: 'https://x.test/post/old#0', post: 'old' });
    catalog.follow(catalog.findArtist(['yoely', 'weiss'])!.id, false, day(2026, 10, 6));
    const sent: Reply[][] = [];
    const jobs = new LibraryJobs({
      musicTable: new MusicTable({ baseUrl: site.url, minIntervalMs: 0 }),
      catalog,
      announce: async (replies) => void sent.push(replies),
      digestAt: undefined,
      fetchAudio: async () => {
        throw new Error('no downloads here');
      },
      quiet,
      now: () => clock.now,
    });
    return { jobs, sent };
  }

  test('a new song by an artist you follow comes on its own, with its card; once; and not in the quiet hours', async () => {
    const clock = { now: day(2026, 10, 6, 23) };
    const { jobs, sent } = await alertSetUp(clock, { from: { hour: 22, minute: 0 }, to: { hour: 7, minute: 0 } });
    site!.reset();
    // The site gets two new posts, one by Yoely Weiss.
    const fresh = await startMockMusicTable(alertPosts(iso(day(2026, 10, 6, 21))));
    const table = new MusicTable({ baseUrl: fresh.url, minIntervalMs: 0 });
    await syncSite({ musicTable: table, catalog, now: () => clock.now });
    await fresh.close();

    assert.equal(await jobs.alertFollowed(), 0, 'quiet hours: it waits');
    clock.now = day(2026, 10, 7, 7, 5);
    assert.equal(await jobs.alertFollowed(), 1);
    const [alert] = sent;
    assert.deepEqual(
      alert!.map((reply) => (reply.kind === 'text' ? reply.text : `[${reply.kind}]`)),
      ['[image]', '🔔 New from Yoely Weiss: Yoely Weiss — Brand New', 'Tap 👍 on it to get it.'],
    );
    const card = alert![0]!;
    assert.ok(card.kind === 'image' && card.postback?.startsWith('play:') && card.caption?.title === 'Brand New');
    assert.equal(await jobs.alertFollowed(), 0, 'not twice');
  });

  test("no alert for a song you've had already, or for one out before you followed the artist", async () => {
    const clock = { now: day(2026, 10, 6, 23) };
    const { jobs, sent } = await alertSetUp(clock);
    const fresh = await startMockMusicTable([
      ...alertPosts(iso(day(2026, 10, 6, 21))),
      { slug: 'yw-two', title: 'Yoely Weiss & Mendy Weiss - Two Of Us', files: [{ name: 'two.mp3' }], publishedAt: iso(day(2026, 10, 6, 20)) },
    ]);
    await syncSite({ musicTable: new MusicTable({ baseUrl: fresh.url, minIntervalMs: 0 }), catalog, now: () => day(2026, 10, 5, 23) });
    await fresh.close();
    assert.equal(await jobs.alertFollowed(), 0, 'seen by the catalog before the follow began');

    catalog.follow(catalog.findArtist(['yoely', 'weiss'])!.id, false, day(2026, 10, 5, 22));
    catalog.recordPlay(catalog.postTracks('yw-new')[0]!.id);
    assert.equal(await jobs.alertFollowed(), 1, 'the one you had is left out');
    assert.equal(texts(sent[0]!)[0], '🔔 New from Yoely Weiss: Yoely Weiss & Mendy Weiss — Two Of Us', 'named by the artist you follow');
  });

  test('while you follow anyone, the feed is checked every few minutes and a new post is synced at once', async () => {
    const clock = { now: day(2026, 10, 6, 12) };
    site = await startMockMusicTable(alertPosts(iso(day(2026, 10, 6, 11))));
    catalog = new Catalog(':memory:');
    catalog.setState(STATE.scanDone, iso(day(2026, 10, 1)));
    catalog.setState(STATE.lastSync, iso(day(2026, 10, 6, 11, 30)));
    catalog.add({ title: 'Old', artist: 'Yoely Weiss', url: 'https://x.test/post/old#0', post: 'old' });
    catalog.follow(catalog.findArtist(['yoely', 'weiss'])!.id, false, day(2026, 10, 6, 11));
    const sent: Reply[][] = [];
    const jobs = new LibraryJobs({
      musicTable: new MusicTable({ baseUrl: site.url, minIntervalMs: 0 }),
      catalog,
      announce: async (replies) => void sent.push(replies),
      digestAt: undefined,
      fetchAudio: async () => {
        throw new Error('no downloads here');
      },
      quiet: undefined,
      watchEveryMs: 10 * 60_000,
      now: () => clock.now,
    });
    await jobs.check();
    assert.equal(site.feedReads, 1);
    assert.equal(site.listReads, 1, 'the feed showed a post the catalog lacked, so it synced');
    assert.equal(sent.length, 1, 'and the alert went out in the same round');
    clock.now = day(2026, 10, 6, 12, 5);
    await jobs.check();
    assert.equal(site.feedReads, 1, 'not again within ten minutes');
  });
});

describe('health on the Mac', () => {
  const notices = () => {
    const shown: string[] = [];
    return { shown, notify: async (_title: string, message: string) => void shown.push(message) };
  };

  test('a problem is shown once, again only after hours, and its fix is shown too', () => {
    let clock = day(2026, 10, 6, 12);
    const { shown, notify } = notices();
    const saved: unknown[] = [];
    const health = new Health({ notify, now: () => clock, repeatMs: 6 * 60 * 60_000, save: (problems) => saved.push(problems) });
    health.problem('site', 'the site is down');
    health.problem('site', 'the site is down');
    clock = day(2026, 10, 6, 19);
    health.problem('site', 'the site is down');
    health.ok('site', 'Fixed: the site is back.');
    health.ok('site');
    assert.deepEqual(shown, ['the site is down', 'the site is down', 'Fixed: the site is back.']);
    assert.deepEqual(saved.at(-1), []);
  });

  test('the bridge: logged out, back, a short drop (quiet), a long one (said), RCS off, and not running', async () => {
    let clock = day(2026, 10, 6, 12);
    let status: BridgeStatus | Error = { state: 'CONNECTED', rcsEnabled: true };
    const { shown, notify } = notices();
    const health = new Health({ notify, now: () => clock });
    const watch = new BridgeWatch({
      health,
      now: () => clock,
      status: async () => {
        if (status instanceof Error) throw status;
        return status;
      },
    });
    await watch.check();
    assert.equal(shown.length, 0);

    status = { state: 'BAD_CREDENTIALS', message: 'Logged out', rcsEnabled: true };
    await watch.check();
    assert.match(shown.at(-1)!, /^Google Messages is logged out of the bridge \(Logged out\)\. Log in again/);
    status = { state: 'CONNECTED', rcsEnabled: true };
    await watch.check();
    assert.equal(shown.at(-1), 'Fixed: the bridge is connected to Google Messages again.');

    status = { state: 'TRANSIENT_DISCONNECT', error: 'gm-phone-not-responding', rcsEnabled: true };
    await watch.check();
    clock = day(2026, 10, 6, 12, 10);
    await watch.check();
    assert.equal(shown.length, 2, 'ten minutes of trouble: nothing yet');
    clock = day(2026, 10, 6, 12, 16);
    await watch.check();
    assert.match(shown.at(-1)!, /can't reach Google Messages \(gm-phone-not-responding\)\. Is your phone on and online\?/);

    status = { state: 'CONNECTED', rcsEnabled: false };
    await watch.check();
    assert.ok(shown.includes("RCS chats are off on your phone, so songs can't be sent. Turn them on: Messages → Settings → RCS chats."));

    status = new Error('connection refused');
    await watch.check();
    assert.match(shown.at(-1)!, /isn't answering\. Start it: npm run stack -- start/);
  });

  test('the same trouble in other words is not announced again until the hours pass', () => {
    let clock = day(2026, 10, 6, 1);
    const { shown, notify } = notices();
    const health = new Health({ notify, now: () => clock, repeatMs: 6 * 60 * 60_000 });
    health.problem('bridge', 'error A');
    clock = day(2026, 10, 6, 1, 5);
    health.problem('bridge', 'error B');
    clock = day(2026, 10, 6, 1, 10);
    health.problem('bridge', 'error A');
    assert.deepEqual(shown, ['error A']);
    assert.equal(health.problems()[0]?.message, 'error A', 'kept up to date');
    clock = day(2026, 10, 6, 7, 30);
    health.problem('bridge', 'error B');
    assert.deepEqual(shown, ['error A', 'error B']);
  });

  test("when this Mac has no internet that's what is said, after ten minutes, and the bridge isn't blamed; then its return", async () => {
    let clock = day(2026, 10, 6, 23);
    let up = false;
    let status: BridgeStatus = { state: 'TRANSIENT_DISCONNECT', error: 'gm-ping-failed', rcsEnabled: true };
    const { shown, notify } = notices();
    const health = new Health({ notify, now: () => clock });
    const watch = new BridgeWatch({ health, now: () => clock, status: async () => status, online: async () => up });
    await watch.check();
    clock = day(2026, 10, 6, 23, 5);
    await watch.check();
    assert.equal(shown.length, 0, 'a short drop: nothing yet');
    for (const minute of [10, 15, 20, 25, 30]) {
      clock = day(2026, 10, 6, 23, minute);
      await watch.check();
    }
    assert.deepEqual(shown, ["This Mac has no internet (it may still show Wi-Fi as connected). Texts you send meanwhile are answered when it's back."]);
    assert.equal(health.has('bridge'), false, 'nothing blamed on the bridge or the phone');

    up = true;
    clock = day(2026, 10, 7, 10);
    await watch.check();
    assert.equal(shown.at(-1), 'Fixed: this Mac is back online.');
    status = { state: 'CONNECTED', rcsEnabled: true };
    clock = day(2026, 10, 7, 10, 5);
    await watch.check();
    assert.equal(shown.length, 2, 'the bridge got its fresh while to reconnect, and did');
  });
});
