import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { AUTO_FOLLOW_AFTER, catalogFollows } from '../src/library/follows.ts';
import { OWNER, personOf } from '../src/people.ts';
import { createNewReleases, ZemerReleases } from '../src/sources/zemer-releases.ts';
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { startMockZemerReleases, type MockFeedRelease, type MockZemerReleases } from './helpers/mock-zemer-releases.ts';

// What each person has of their own in the catalog: plays, follows (and the unfollow mark), and what went out to them in
// the daily message and the alerts. The owner's chat is '' and behaves as it always did.

const ALICE = personOf('alice').chat;
const BOB = personOf('bob').chat;
const DAY_MS = 24 * 60 * 60_000;
const iso = (day: number, hour = 12) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const when = (day: number, hour = 12) => new Date(iso(day, hour));

/** A site post with its one song, by an artist. */
function addPost(catalog: Catalog, slug: string, artist: string, options: { publishedAt?: string; seenAt?: Date; files?: number } = {}) {
  catalog.savePost(
    { slug, title: `${artist} - ${slug}`, category: 'Singles', publishedAt: options.publishedAt ?? iso(20), views: 0, audioFiles: options.files ?? 1 },
    options.seenAt ?? when(20),
  );
  return catalog.add({ title: slug, artist, url: `https://x.test/post/${slug}#0`, post: slug });
}

const withDir = <T>(run: (dir: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'people-catalog-'));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe('plays, one set for each person', () => {
  let catalog: Catalog;
  beforeEach(() => {
    catalog = new Catalog(':memory:');
  });
  afterEach(() => catalog.close());

  test('a play is the chat that asked for it; the owner is the one left unsaid', () => {
    const one = catalog.add({ title: 'One', artist: 'Yoely Weiss', url: 'https://x.test/1.mp3' });
    const two = catalog.add({ title: 'Two', artist: 'Yoely Weiss', url: 'https://x.test/2.mp3' });
    const yoely = catalog.findArtist(['yoely', 'weiss'])!;
    catalog.recordPlay(one.id);
    catalog.recordPlay(two.id, new Date(), ALICE);
    catalog.recordPlay(two.id, new Date(), ALICE);
    assert.equal(catalog.playedSongsBy(yoely.id), 1, "the owner's: one song");
    assert.equal(catalog.playedSongsBy(yoely.id, OWNER.chat), 1);
    assert.equal(catalog.playedSongsBy(yoely.id, ALICE), 1, "alice's: the other one, once however often");
    assert.equal(catalog.playedSongsBy(yoely.id, BOB), 0);
    catalog.recordPlay(one.id, new Date(), ALICE);
    assert.equal(catalog.playedSongsBy(yoely.id, ALICE), 2);
    assert.equal(catalog.playedSongsBy(yoely.id), 1, 'and the owner is still at one');
  });

  test('what is kept ready is for everybody, so the most played adds all of them up', () => {
    const one = catalog.add({ title: 'One', artist: 'A', url: 'https://x.test/1.mp3' });
    const two = catalog.add({ title: 'Two', artist: 'B', url: 'https://x.test/2.mp3' });
    catalog.recordPlay(one.id);
    catalog.recordPlay(two.id, new Date(), ALICE);
    catalog.recordPlay(two.id, new Date(), BOB);
    assert.deepEqual(
      catalog.mostPlayed(5).map((track) => [track.title, track.plays]),
      [['Two', 2], ['One', 1]],
    );
  });

  test("a release is 'had' only by the chat that played a song of it", () => {
    const song = catalog.add({ title: 'S', artist: 'A', url: 'https://x.test/s.mp3', album: { id: 'MPREb_one', title: 'One' } });
    catalog.recordPlay(song.id, new Date(), ALICE);
    assert.equal(catalog.releaseHad('MPREb_one', ALICE), true);
    assert.equal(catalog.releaseHad('MPREb_one'), false, 'not the owner');
    assert.equal(catalog.releaseHad('MPREb_one', BOB), false);
    catalog.recordPlay(song.id);
    assert.equal(catalog.releaseHad('MPREb_one'), true);
  });
});

describe('follows, one set for each person', () => {
  let catalog: Catalog;
  beforeEach(() => {
    catalog = new Catalog(':memory:');
    catalog.add({ title: 'Song', artist: 'Yoely Weiss', url: 'https://x.test/a.mp3' });
    catalog.add({ title: 'Other', artist: 'Mendy Weiss', url: 'https://x.test/b.mp3' });
  });
  afterEach(() => catalog.close());

  const yoely = () => catalog.findArtist(['yoely', 'weiss'])!;
  const mendy = () => catalog.findArtist(['mendy', 'weiss'])!;

  test('one person follows an artist and the others do not see it', () => {
    catalog.follow(yoely().id, false, when(20), ALICE);
    assert.deepEqual(catalog.followed(ALICE).map((artist) => artist.name), ['Yoely Weiss']);
    assert.deepEqual(catalog.followed(), [], 'not the owner');
    assert.deepEqual(catalog.followed(BOB), []);
    assert.equal(catalog.followState(yoely().id, ALICE), 'on');
    assert.equal(catalog.followState(yoely().id), undefined);
    assert.equal(catalog.followState(yoely().id, BOB), undefined);
    assert.deepEqual(catalog.followedSince(ALICE).map((entry) => [entry.name, entry.since]), [['Yoely Weiss', iso(20)]]);
    assert.deepEqual(catalog.followedSince(), []);
    assert.deepEqual(catalog.followingChats(), [ALICE]);
  });

  test('two chats can follow the same artist, each from their own day and each for their own reason', () => {
    catalog.follow(yoely().id, false, when(10));
    catalog.follow(yoely().id, true, when(15), ALICE);
    assert.deepEqual(catalog.followed().map((artist) => [artist.name, artist.auto]), [['Yoely Weiss', false]]);
    assert.deepEqual(catalog.followed(ALICE).map((artist) => [artist.name, artist.auto]), [['Yoely Weiss', true]]);
    assert.deepEqual(catalog.followedSince().map((entry) => entry.since), [iso(10)]);
    assert.deepEqual(catalog.followedSince(ALICE).map((entry) => entry.since), [iso(15)]);
    assert.deepEqual(catalog.followingChats(), ['', ALICE], "the owner's first");
  });

  test("an unfollow is the person's own: it stays their 'off' and does not touch anyone else's follow", () => {
    catalog.follow(yoely().id, false, when(10));
    catalog.follow(yoely().id, false, when(10), ALICE);
    catalog.unfollow(yoely().id, when(12), ALICE);
    assert.equal(catalog.followState(yoely().id, ALICE), 'off');
    assert.equal(catalog.followState(yoely().id), 'on');
    assert.deepEqual(catalog.followed(ALICE), []);
    assert.deepEqual(catalog.followed().map((artist) => artist.name), ['Yoely Weiss']);
    assert.deepEqual(catalog.followingChats(), [''], 'alice no longer follows anyone');
    // The owner's unfollow of an artist alice has never met leaves alice free to follow later.
    catalog.unfollow(mendy().id, when(12));
    assert.equal(catalog.followState(mendy().id), 'off');
    assert.equal(catalog.followState(mendy().id, ALICE), undefined);
    // Following again undoes the unfollow, for that person only.
    catalog.follow(yoely().id, false, when(14), ALICE);
    assert.equal(catalog.followState(yoely().id, ALICE), 'on');
    assert.equal(catalog.followState(mendy().id), 'off');
  });

  test('after three songs a person is made to follow the artist; their plays are their own, so another person is not', () => {
    const songs = [1, 2, 3].map((n) => catalog.add({ title: `Hit ${n}`, artist: 'Mendy Weiss', url: `https://x.test/hit${n}.mp3` }));
    const aliceFollows = catalogFollows(catalog, ALICE, () => when(20));
    const bobFollows = catalogFollows(catalog, BOB, () => when(20));
    assert.equal(AUTO_FOLLOW_AFTER, 3);
    for (const song of songs) {
      catalog.recordPlay(song.id, when(20), ALICE);
      const added = aliceFollows.afterPlay(song);
      assert.deepEqual(added, song === songs[2] ? ['Mendy Weiss'] : [], song.title);
    }
    assert.deepEqual(aliceFollows.list(), [{ name: 'Mendy Weiss', auto: true }]);
    assert.deepEqual(bobFollows.list(), []);
    assert.deepEqual(catalogFollows(catalog).list(), [], 'not the owner');
    // Bob has had one of them: not enough to follow.
    catalog.recordPlay(songs[0]!.id, when(20), BOB);
    assert.deepEqual(bobFollows.afterPlay(songs[0]!), []);
    assert.deepEqual(bobFollows.list(), []);
  });

  test("a person's unfollow stops that person's auto-follow only", () => {
    const songs = [1, 2, 3].map((n) => catalog.add({ title: `Hit ${n}`, artist: 'Mendy Weiss', url: `https://x.test/hit${n}.mp3` }));
    const alice = catalogFollows(catalog, ALICE, () => when(20));
    const owner = catalogFollows(catalog, () => when(20));
    assert.deepEqual(alice.unfollow(['mendy', 'weiss']), { artist: mendy(), was: false });
    for (const song of songs) {
      catalog.recordPlay(song.id, when(20), ALICE);
      catalog.recordPlay(song.id, when(20));
      alice.afterPlay(song);
      owner.afterPlay(song);
    }
    assert.deepEqual(alice.list(), [], 'alice said no');
    assert.deepEqual(owner.list(), [{ name: 'Mendy Weiss', auto: true }], 'the owner never did');
  });

  test('catalogFollows(catalog, now) is the owner, as before, and a chat can come with a clock', () => {
    const fixed = () => when(18);
    const owner = catalogFollows(catalog, fixed);
    assert.equal(owner.follow(['yoely', 'weiss'])?.name, 'Yoely Weiss');
    assert.deepEqual(catalog.followedSince().map((entry) => entry.since), [iso(18)]);
    assert.deepEqual(catalogFollows(catalog).list(), [{ name: 'Yoely Weiss', auto: false }]);
    const alice = catalogFollows(catalog, ALICE, () => when(19));
    alice.follow(['mendy', 'weiss']);
    assert.deepEqual(catalog.followedSince(ALICE).map((entry) => entry.since), [iso(19)]);
    assert.deepEqual(alice.list(), [{ name: 'Mendy Weiss', auto: false }]);
    assert.deepEqual(catalogFollows(catalog, '').list(), [{ name: 'Yoely Weiss', auto: false }], "'' is the owner");
    assert.deepEqual(alice.unfollow(['yoely', 'weiss'])?.was, false, 'alice did not follow Yoely');
    assert.deepEqual(catalogFollows(catalog).list(), [{ name: 'Yoely Weiss', auto: false }], "and her unfollow left the owner's alone");
  });
});

describe('what went out, kept for each person', () => {
  let catalog: Catalog;
  beforeEach(() => {
    catalog = new Catalog(':memory:');
  });
  afterEach(() => catalog.close());

  const slugs = (posts: Array<{ slug: string }>) => posts.map((post) => post.slug).sort();

  test('a post announced to the owner can still be announced to another person, and the other way round', () => {
    addPost(catalog, 'a', 'Yoely Weiss');
    addPost(catalog, 'b', 'Mendy Weiss');
    const since = when(1);
    assert.deepEqual(slugs(catalog.postsToAnnounce(since)), ['a', 'b']);
    assert.deepEqual(slugs(catalog.postsToAnnounce(since, 30, ALICE)), ['a', 'b']);

    catalog.markAnnounced(['a'], when(21));
    assert.deepEqual(slugs(catalog.postsToAnnounce(since)), ['b'], 'the owner has had a');
    assert.deepEqual(slugs(catalog.postsToAnnounce(since, 30, ALICE)), ['a', 'b'], 'alice has not');
    assert.deepEqual(slugs(catalog.postsToAnnounce(since, 30, BOB)), ['a', 'b']);

    catalog.markAnnounced(['b'], when(22), ALICE);
    assert.deepEqual(slugs(catalog.postsToAnnounce(since, 30, ALICE)), ['a']);
    assert.deepEqual(slugs(catalog.postsToAnnounce(since)), ['b'], "alice's mark is not the owner's");
    assert.deepEqual(slugs(catalog.postsToAnnounce(since, 30, BOB)), ['a', 'b']);
    assert.equal(catalog.delivery('post.announced', 'a'), iso(21));
    assert.equal(catalog.delivery('post.announced', 'a', ALICE), undefined);
    assert.equal(catalog.delivery('post.announced', 'b', ALICE), iso(22));
  });

  test("the owner's mark is also on the post, as it always was; another person's is not, and is not shown as the owner's", () => {
    addPost(catalog, 'a', 'Yoely Weiss');
    catalog.markAnnounced(['a'], when(21), ALICE);
    assert.equal(catalog.sitePost('a')?.announcedAt, undefined, "alice's is not on the shared row");
    catalog.markAnnounced(['a'], when(22));
    assert.equal(catalog.sitePost('a')?.announcedAt, iso(22));
    catalog.markAlerted(['a'], when(23));
    assert.equal(catalog.sitePost('a')?.alertedAt, iso(23));
    // What a query hands another person leaves the owner's times off.
    const [shown] = catalog.postsToAnnounce(when(1), 30, BOB);
    assert.equal(shown?.slug, 'a');
    assert.ok(!('announcedAt' in shown!) && !('alertedAt' in shown!));
    // Marking again moves the time, as it did.
    catalog.markAnnounced(['a'], when(25));
    assert.equal(catalog.delivery('post.announced', 'a'), iso(25));
    assert.equal(catalog.sitePost('a')?.announcedAt, iso(25));
  });

  test('a post that does not exist is not marked', () => {
    catalog.markAnnounced(['nope'], when(21));
    catalog.markAnnounced(['nope'], when(21), ALICE);
    catalog.markAlerted(['nope'], when(21));
    catalog.markReleasesAnnounced(['nope'], when(21));
    catalog.markReleasesAlerted(['nope'], when(21), ALICE);
    assert.equal(catalog.delivery('post.announced', 'nope'), undefined);
    assert.equal(catalog.delivery('post.announced', 'nope', ALICE), undefined);
    assert.equal(catalog.delivery('release.alerted', 'nope', ALICE), undefined);
    addPost(catalog, 'nope', 'Yoely Weiss');
    assert.deepEqual(catalog.postsToAnnounce(when(1)).map((post) => post.slug), ['nope'], 'and it is new when it turns up');
  });

  describe('alerts for the artists a person follows', () => {
    const followAs = (artist: string, chat: string, since = when(20)) => catalog.follow(catalog.findArtist(artist.toLowerCase().split(' '))!.id, false, since, chat);

    test('each person is alerted to their own artists; once; the alert marks are theirs', () => {
      addPost(catalog, 'yoely-new', 'Yoely Weiss', { seenAt: when(22), publishedAt: iso(22) });
      addPost(catalog, 'mendy-new', 'Mendy Weiss', { seenAt: when(22), publishedAt: iso(22) });
      followAs('Yoely Weiss', '');
      followAs('Yoely Weiss', ALICE);
      followAs('Mendy Weiss', ALICE);
      followAs('Mendy Weiss', BOB);
      const since = when(21);
      assert.deepEqual(catalog.postsToAlert(since).map((post) => [post.slug, post.artists]), [['yoely-new', ['Yoely Weiss']]]);
      assert.deepEqual(slugs(catalog.postsToAlert(since, ALICE)), ['mendy-new', 'yoely-new']);
      assert.deepEqual(catalog.postsToAlert(since, BOB).map((post) => post.slug), ['mendy-new']);
      assert.deepEqual(catalog.postsToAlert(since, 'carol'), [], 'someone who follows nobody');

      catalog.markAlerted(['yoely-new'], when(23));
      assert.deepEqual(catalog.postsToAlert(since), [], "the owner's is done");
      assert.deepEqual(slugs(catalog.postsToAlert(since, ALICE)), ['mendy-new', 'yoely-new'], "alice's still waits");
      catalog.markAlerted(['yoely-new', 'mendy-new'], when(23), ALICE);
      assert.deepEqual(catalog.postsToAlert(since, ALICE), []);
      assert.deepEqual(catalog.postsToAlert(since, BOB).map((post) => post.slug), ['mendy-new'], "bob's still waits");
      assert.equal(catalog.delivery('post.alerted', 'yoely-new', ALICE), iso(23));
      assert.equal(catalog.delivery('post.alerted', 'mendy-new', BOB), undefined);
    });

    test("one person's play of the song, or of its post, holds back only their own alert", () => {
      const song = addPost(catalog, 'yoely-new', 'Yoely Weiss', { seenAt: when(22), publishedAt: iso(22) });
      followAs('Yoely Weiss', '');
      followAs('Yoely Weiss', ALICE);
      catalog.recordPlay(song.id, when(22), ALICE);
      const since = when(21);
      assert.deepEqual(catalog.postsToAlert(since, ALICE), [], 'alice has had it');
      assert.deepEqual(catalog.postsToAlert(since).map((post) => post.slug), ['yoely-new'], 'the owner has not');
      catalog.recordPlay(song.id, when(22));
      assert.deepEqual(catalog.postsToAlert(since), []);
    });

    test("a follow's date is the person's own: a post seen before they began is not theirs", () => {
      addPost(catalog, 'yoely-new', 'Yoely Weiss', { seenAt: when(22), publishedAt: iso(22) });
      followAs('Yoely Weiss', '', when(21));
      followAs('Yoely Weiss', ALICE, when(23));
      assert.deepEqual(catalog.postsToAlert(when(21)).map((post) => post.slug), ['yoely-new']);
      assert.deepEqual(catalog.postsToAlert(when(21), ALICE), []);
    });
  });

  describe('Zemer releases', () => {
    const release = (id: string, over: Partial<Parameters<Catalog['saveRelease']>[0]> = {}) =>
      catalog.saveRelease({ id, title: `Release ${id}`, artist: 'Yoely Weiss', artistId: 'UCyoely', releasedAt: iso(22), songs: 1, ...over }, when(22));

    test('the marks are the chat that was asked, in the list, in what is not alerted yet, and for the owner on the row too', () => {
      release('MPREb_a');
      release('MPREb_b');
      catalog.markReleasesAnnounced(['MPREb_a'], when(23));
      catalog.markReleasesAnnounced(['MPREb_b'], when(24), ALICE);
      catalog.markReleasesAlerted(['MPREb_a'], when(25), ALICE);
      const marks = (chat = '') => catalog.releases(chat).map((one) => [one.id, one.announcedAt ?? null, one.alertedAt ?? null]);
      assert.deepEqual(marks(), [['MPREb_a', iso(23), null], ['MPREb_b', null, null]]);
      assert.deepEqual(marks(ALICE), [['MPREb_a', null, iso(25)], ['MPREb_b', iso(24), null]]);
      assert.deepEqual(marks(BOB), [['MPREb_a', null, null], ['MPREb_b', null, null]]);
      assert.deepEqual(catalog.releases().map((one) => one.id), catalog.releases(ALICE).map((one) => one.id), 'the same releases, in the same order');

      assert.deepEqual(catalog.unalertedReleases(when(1)).map((one) => one.id), ['MPREb_a', 'MPREb_b']);
      assert.deepEqual(catalog.unalertedReleases(when(1), ALICE).map((one) => one.id), ['MPREb_b']);
      assert.deepEqual(catalog.unalertedReleases(when(1), BOB).map((one) => one.id), ['MPREb_a', 'MPREb_b']);
      catalog.markReleasesAlerted(['MPREb_a', 'MPREb_b'], when(26));
      assert.deepEqual(catalog.unalertedReleases(when(1)), []);
      assert.deepEqual(catalog.unalertedReleases(when(1), ALICE).map((one) => one.id), ['MPREb_b']);
    });

    test('what is forgotten with a release takes the marks about it along, and only those', () => {
      release('MPREb_old', { releasedAt: iso(1) });
      release('MPREb_new', { releasedAt: iso(22) });
      addPost(catalog, 'post', 'Yoely Weiss');
      catalog.markReleasesAnnounced(['MPREb_old', 'MPREb_new'], when(23));
      catalog.markReleasesAlerted(['MPREb_old'], when(23), ALICE);
      catalog.markAnnounced(['post'], when(23), ALICE);
      assert.equal(catalog.pruneReleases(when(10)), 1);
      assert.equal(catalog.delivery('release.announced', 'MPREb_old'), undefined);
      assert.equal(catalog.delivery('release.alerted', 'MPREb_old', ALICE), undefined);
      assert.equal(catalog.delivery('release.announced', 'MPREb_new'), iso(23));
      assert.equal(catalog.delivery('post.announced', 'post', ALICE), iso(23), 'posts are not forgotten');
      assert.equal(catalog.pruneReleases(when(10)), 0);
    });
  });
});

describe('the tables as a new database makes them', () => {
  test('follows are keyed by chat and artist, plays and views carry the chat, deliveries are keyed by chat, kind and key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'people-catalog-'));
    try {
      const path = join(dir, 'fresh.db');
      new Catalog(path).close();
      const db = new DatabaseSync(path);
      const info = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null; pk: number }>;
      const follows = info('follows');
      assert.deepEqual(follows.map((column) => column.name), ['chat', 'artist_id', 'following', 'auto', 'since']);
      assert.deepEqual(follows.filter((column) => column.pk > 0).map((column) => [column.name, column.pk]), [['chat', 1], ['artist_id', 2]]);
      assert.equal(follows[0]!.dflt_value, "''");
      for (const table of ['plays', 'views']) {
        const chat = info(table).find((column) => column.name === 'chat');
        assert.ok(chat, `${table}.chat`);
        assert.deepEqual([chat.notnull, chat.dflt_value], [1, "''"]);
      }
      const deliveries = info('deliveries');
      assert.deepEqual(deliveries.map((column) => column.name), ['chat', 'kind', 'key', 'at']);
      assert.deepEqual(deliveries.filter((column) => column.pk > 0).map((column) => column.name), ['chat', 'kind', 'key']);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a database made before people', () => {
  /**
   * A catalog the way the last release left it: the follows keyed by the artist alone, no chat on the plays, no deliveries,
   * and the marks on the posts and releases themselves. What `seed` puts in is made with the current code first, then the
   * tables are put back in their old shape, which is what a restore of an old backup is.
   */
  function oldShaped(
    path: string,
    seed: (catalog: Catalog) => void,
    marks: (db: DatabaseSync) => void,
    follows: Array<[artistName: string, following: number, auto: number, since: string]>,
  ): void {
    const catalog = new Catalog(path);
    seed(catalog);
    const ids = new Map<string, number>();
    for (const [name] of follows) ids.set(name, catalog.findArtist(name.toLowerCase().split(' '))!.id);
    catalog.close();
    const db = new DatabaseSync(path);
    db.exec(`
      DROP TABLE deliveries;
      ALTER TABLE plays DROP COLUMN chat;
      DROP TABLE follows;
      CREATE TABLE follows (
        artist_id INTEGER PRIMARY KEY REFERENCES artists (id) ON DELETE CASCADE,
        following INTEGER NOT NULL,
        auto      INTEGER NOT NULL DEFAULT 0,
        since     TEXT NOT NULL
      );
    `);
    const put = db.prepare('INSERT INTO follows (artist_id, following, auto, since) VALUES (?, ?, ?, ?)');
    for (const [name, following, auto, since] of follows) put.run(ids.get(name)!, following, auto, since);
    marks(db);
    db.close();
  }

  const seed = (catalog: Catalog) => {
    addPost(catalog, 'announced', 'Yoely Weiss', { seenAt: when(22), publishedAt: iso(22) });
    addPost(catalog, 'alerted', 'Mendy Weiss', { seenAt: when(22), publishedAt: iso(22) });
    addPost(catalog, 'fresh', 'Yoely Weiss', { seenAt: when(23), publishedAt: iso(23) });
    catalog.saveRelease({ id: 'MPREb_a', title: 'A', artist: 'Yoely Weiss', artistId: 'UCy', releasedAt: iso(22), songs: 1 }, when(22));
    catalog.saveRelease({ id: 'MPREb_b', title: 'B', artist: 'Yoely Weiss', artistId: 'UCy', releasedAt: iso(22), songs: 1 }, when(22));
    const played = catalog.add({ title: 'Played', artist: 'Yoely Weiss', url: 'https://x.test/played.mp3', album: { id: 'MPREb_a', title: 'A' } });
    catalog.recordPlay(played.id, when(22));
    catalog.recordPlay(played.id, when(22));
  };
  const marks = (db: DatabaseSync) => {
    db.exec(`
      UPDATE site_posts SET announced_at = '${iso(24)}' WHERE slug = 'announced';
      UPDATE site_posts SET alerted_at = '${iso(24, 6)}' WHERE slug = 'alerted';
      UPDATE zemer_releases SET announced_at = '${iso(24, 7)}' WHERE id = 'MPREb_a';
      UPDATE zemer_releases SET alerted_at = '${iso(24, 8)}' WHERE id = 'MPREb_b';
    `);
  };
  const FOLLOWS: Array<[string, number, number, string]> = [
    ['Yoely Weiss', 1, 0, iso(10)],
    ['Mendy Weiss', 0, 0, iso(11)],
  ];

  test("opens, and what the owner had is the owner's: follows (also the unfollow), plays, and what was sent", () => {
    withDir((dir) => {
      const path = join(dir, 'catalog.db');
      oldShaped(path, seed, marks, FOLLOWS);
      const catalog = new Catalog(path);

      assert.deepEqual(catalog.followed().map((artist) => [artist.name, artist.auto]), [['Yoely Weiss', false]]);
      assert.equal(catalog.followState(catalog.findArtist(['yoely', 'weiss'])!.id), 'on');
      assert.equal(catalog.followState(catalog.findArtist(['mendy', 'weiss'])!.id), 'off', 'the unfollow too');
      assert.deepEqual(catalog.followedSince().map((entry) => [entry.name, entry.since]), [['Yoely Weiss', iso(10)]]);
      assert.deepEqual(catalog.followed(ALICE), []);
      assert.deepEqual(catalog.followingChats(), ['']);

      const yoely = catalog.findArtist(['yoely', 'weiss'])!;
      assert.equal(catalog.playedSongsBy(yoely.id), 1, 'plays that were there are the owner\'s');
      assert.equal(catalog.playedSongsBy(yoely.id, ALICE), 0);
      assert.equal(catalog.releaseHad('MPREb_a'), true);
      assert.equal(catalog.releaseHad('MPREb_a', ALICE), false);

      assert.deepEqual(catalog.postsToAnnounce(when(1)).map((post) => post.slug).sort(), ['alerted', 'fresh'], 'the one announced is not announced again');
      assert.deepEqual(catalog.postsToAnnounce(when(1), 30, ALICE).map((post) => post.slug).sort(), ['alerted', 'announced', 'fresh'], 'but alice has had nothing');
      assert.equal(catalog.delivery('post.announced', 'announced'), iso(24));
      assert.equal(catalog.delivery('post.alerted', 'alerted'), iso(24, 6));
      assert.equal(catalog.sitePost('announced')?.announcedAt, iso(24));
      assert.deepEqual(catalog.releases().map((one) => [one.id, one.announcedAt ?? null, one.alertedAt ?? null]), [['MPREb_a', iso(24, 7), null], ['MPREb_b', null, iso(24, 8)]]);
      assert.deepEqual(catalog.unalertedReleases(when(1)).map((one) => one.id), ['MPREb_a'], 'the one alerted is not alerted again');
      assert.deepEqual(catalog.releases(ALICE).map((one) => [one.announcedAt ?? null, one.alertedAt ?? null]), [[null, null], [null, null]]);

      // The rebuilt table takes another person's follow of the same artist, which the old key could not.
      catalog.follow(yoely.id, false, when(25), ALICE);
      assert.deepEqual(catalog.followed(ALICE).map((artist) => artist.name), ['Yoely Weiss']);
      assert.equal(catalog.followed().length, 1);
      catalog.close();
    });
  });

  test('is changed once: opening it again, or a second connection at the same time, changes and fails nothing', () => {
    withDir((dir) => {
      const path = join(dir, 'catalog.db');
      oldShaped(path, seed, marks, FOLLOWS);
      const first = new Catalog(path);
      const second = new Catalog(path);
      first.follow(first.findArtist(['yoely', 'weiss'])!.id, false, when(25), ALICE);
      first.markAnnounced(['fresh'], when(26), ALICE);
      first.close();
      second.close();
      const third = new Catalog(path);
      assert.deepEqual(third.followed().map((artist) => artist.name), ['Yoely Weiss']);
      assert.deepEqual(third.followed(ALICE).map((artist) => artist.name), ['Yoely Weiss'], 'what was added since is still there');
      assert.equal(third.delivery('post.announced', 'fresh', ALICE), iso(26));
      third.close();

      const db = new DatabaseSync(path);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'follows%'").all() as Array<{ name: string }>).map((row) => row.name);
      assert.deepEqual(tables, ['follows'], 'no half-made table is left behind');
      assert.equal((db.prepare('SELECT count(*) AS n FROM follows').get() as { n: number }).n, 3);
      assert.equal((db.prepare('SELECT count(*) AS n FROM deliveries').get() as { n: number }).n, 5, 'the four marks and the one just made');
      db.close();
    });
  });

  test('a follow whose artist is gone does not stop the file from opening: it is left out, the rest is kept', () => {
    withDir((dir) => {
      const path = join(dir, 'catalog.db');
      oldShaped(path, seed, marks, FOLLOWS);
      const edited = new DatabaseSync(path);
      edited.exec('PRAGMA foreign_keys = OFF');
      edited.prepare('INSERT INTO follows (artist_id, following, auto, since) VALUES (?, 1, 0, ?)').run(9999, iso(12));
      edited.close();
      const catalog = new Catalog(path);
      assert.deepEqual(catalog.followed().map((artist) => artist.name), ['Yoely Weiss']);
      assert.equal(catalog.followState(catalog.findArtist(['mendy', 'weiss'])!.id), 'off', 'the unfollow is kept too');
      assert.equal(catalog.followState(9999), undefined);
      catalog.close();
      const db = new DatabaseSync(path);
      assert.equal((db.prepare('SELECT count(*) AS n FROM follows').get() as { n: number }).n, 2);
      db.close();
    });
  });

  test('a rebuild that fails changes nothing, and the next open does it', () => {
    withDir((dir) => {
      const path = join(dir, 'catalog.db');
      oldShaped(path, seed, marks, FOLLOWS);
      const trouble = new DatabaseSync(path);
      trouble.exec('CREATE VIEW follows_with_chat AS SELECT 1 AS x'); // in the way of the table the rebuild makes
      trouble.close();
      assert.throws(() => new Catalog(path));
      const db = new DatabaseSync(path);
      assert.deepEqual((db.prepare('PRAGMA table_info(follows)').all() as Array<{ name: string }>).map((column) => column.name), ['artist_id', 'following', 'auto', 'since'], 'still the old table');
      assert.equal((db.prepare('SELECT count(*) AS n FROM follows').get() as { n: number }).n, 2, 'with its rows');
      db.exec('DROP VIEW follows_with_chat');
      db.close();
      const catalog = new Catalog(path);
      assert.deepEqual(catalog.followed().map((artist) => artist.name), ['Yoely Weiss']);
      catalog.close();
    });
  });

  test('an older release started again on a migrated file still plays, announces and alerts: its marks come over on the next open', () => {
    withDir((dir) => {
      const path = join(dir, 'catalog.db');
      oldShaped(path, seed, marks, FOLLOWS);
      new Catalog(path).close();

      // What the previous release does to the file: a play with no chat, and a mark on the post itself.
      const old = new DatabaseSync(path);
      const track = old.prepare("SELECT id FROM tracks WHERE title = 'Played'").get() as { id: number };
      old.prepare('INSERT INTO plays (track_id, at) VALUES (?, ?)').run(track.id, iso(26));
      old.prepare("UPDATE site_posts SET announced_at = ? WHERE slug = 'fresh'").run(iso(26));
      old.close();

      const catalog = new Catalog(path);
      assert.equal(catalog.playedSongsBy(catalog.findArtist(['yoely', 'weiss'])!.id), 1, 'the owner played that');
      assert.equal(catalog.playedSongsBy(catalog.findArtist(['yoely', 'weiss'])!.id, ALICE), 0);
      assert.deepEqual(catalog.postsToAnnounce(when(1)).map((post) => post.slug), ['alerted'], 'fresh was announced meanwhile');
      assert.equal(catalog.delivery('post.announced', 'fresh'), iso(26));
      catalog.close();
    });
  });

  test('a mark already in deliveries is not moved by the ones the posts carry', () => {
    withDir((dir) => {
      const path = join(dir, 'catalog.db');
      oldShaped(path, seed, marks, FOLLOWS);
      const first = new Catalog(path);
      first.markAnnounced(['announced'], when(27));
      first.close();
      const second = new Catalog(path);
      assert.equal(second.delivery('post.announced', 'announced'), iso(27));
      second.close();
    });
  });

  test("importing it into an empty catalog brings every chat's plays, follows and marks along", () => {
    withDir((dir) => {
      const sourcePath = join(dir, 'source.db');
      oldShaped(sourcePath, seed, marks, FOLLOWS);
      const source = new Catalog(sourcePath);
      source.follow(source.findArtist(['yoely', 'weiss'])!.id, true, when(25), ALICE);
      source.recordPlay(source.add({ title: 'Hers', artist: 'Yoely Weiss', url: 'https://x.test/hers.mp3' }).id, when(25), ALICE);
      source.markAnnounced(['fresh'], when(26), ALICE);
      source.close();

      const target = new Catalog(join(dir, 'target.db'));
      const counts = target.importFrom(sourcePath);
      assert.equal(counts.follows, 3);
      assert.equal(counts.plays, 3);
      assert.deepEqual(target.followed().map((artist) => artist.name), ['Yoely Weiss']);
      assert.deepEqual(target.followed(ALICE).map((artist) => [artist.name, artist.auto]), [['Yoely Weiss', true]]);
      assert.equal(target.playedSongsBy(target.findArtist(['yoely', 'weiss'])!.id, ALICE), 1);
      assert.deepEqual(target.postsToAnnounce(when(1)).map((post) => post.slug).sort(), ['alerted', 'fresh']);
      assert.deepEqual(target.postsToAnnounce(when(1), 30, ALICE).map((post) => post.slug).sort(), ['alerted', 'announced']);
      target.close();
    });
  });
});

// The same, through the releases as the bot uses them: held to Zemer's artist list for every chat.
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/zemer/latest-releases.json', import.meta.url), 'utf8')) as { releases: MockFeedRelease[] };
const BY = (title: string): MockFeedRelease => {
  const found = FIXTURE.releases.find((one) => one.title === title);
  assert.ok(found, `the fixture has no "${title}"`);
  return found;
};
const BAKOL = BY('Bakol');
const WEDDING = BY('חתונה בזריחה');
const everyone = (): MockArtist[] => [...new Map(FIXTURE.releases.map((one) => [one.artistId, { id: one.artistId, name: one.artistName }])).values()];

describe("Zemer's new releases for each person", () => {
  let feed: MockZemerReleases;
  let content: MockZemerContent;
  let catalog: Catalog;
  let whitelist: ZemerWhitelist;
  const clock = Date.parse('2026-10-29T06:00:00Z');
  before(async () => {
    feed = await startMockZemerReleases(FIXTURE.releases);
    content = await startMockZemerContent(everyone());
  });
  after(async () => {
    await feed.close();
    await content.close();
  });
  beforeEach(() => {
    content.reset(everyone());
    catalog = new Catalog(':memory:');
    whitelist = new ZemerWhitelist({ baseUrl: content.url, checkEveryMs: 0, retryAfterMs: 0 });
  });
  afterEach(() => catalog.close());

  const store = () => createNewReleases({ feed: new ZemerReleases({ url: `${feed.url}/?page=zemer_releases` }), whitelist, catalog, now: () => new Date(clock) });
  const follow = (artist: string, since: string, chat: string) => {
    catalog.add({ title: `Older song by ${artist}`, artist, url: `https://music.youtube.com/watch?v=${artist.replace(/\W/g, '').padEnd(11, 'x').slice(0, 11)}` });
    catalog.follow(catalog.findArtist(artist.toLowerCase().split(' '))!.id, false, new Date(since), chat);
  };
  const lookback = () => new Date(clock - 3 * DAY_MS);

  test('the daily message of one person does not use up the other one’s', async () => {
    const releases = store();
    await releases.sync();
    const since = new Date('2026-10-27T12:00:00Z');
    const due = releases.toAnnounce(since);
    assert.equal(due.length, 5);
    assert.deepEqual(releases.toAnnounce(since, ALICE).map((one) => one.id), due.map((one) => one.id), 'the same for alice');

    releases.markAnnounced([due[0]!.id, due[1]!.id], new Date(clock));
    assert.equal(releases.toAnnounce(since).length, 3, 'the owner has had two');
    assert.equal(releases.toAnnounce(since, ALICE).length, 5, 'alice has had none');

    releases.markAnnounced([due[4]!.id], new Date(clock), ALICE);
    assert.deepEqual(releases.toAnnounce(since, ALICE).map((one) => one.id), due.slice(0, 4).map((one) => one.id));
    assert.equal(releases.toAnnounce(since).length, 3, "alice's did not change the owner's");
    assert.equal(releases.toAnnounce(since, BOB).length, 5);
    assert.equal(catalog.releases().find((one) => one.id === due[0]!.id)!.announcedAt, new Date(clock).toISOString());
    assert.equal(catalog.releases(ALICE).find((one) => one.id === due[0]!.id)!.announcedAt, undefined);
  });

  test('each person is alerted to what their artists put out; once; and not for a release they have had', async () => {
    const releases = store();
    await releases.sync();
    follow('Yisroel Meth', '2026-10-28T00:00:00Z', ''); // Bakol
    follow('David Ben Arza', '2026-10-28T00:00:00Z', ALICE); // the wedding song
    follow('Yisroel Meth', '2026-10-28T00:00:00Z', BOB);
    follow('David Ben Arza', '2026-10-28T00:00:00Z', BOB);
    assert.deepEqual(releases.toAlert(lookback()).map((one) => [one.title, one.artists]), [['Bakol', ['Yisroel Meth']]]);
    assert.deepEqual(releases.toAlert(lookback(), ALICE).map((one) => [one.title, one.artists]), [[WEDDING.title, ['David Ben Arza']]]);
    assert.deepEqual(releases.toAlert(lookback(), BOB).map((one) => one.title).sort(), ['Bakol', WEDDING.title].sort());
    assert.deepEqual(releases.toAlert(lookback(), 'carol'), [], 'someone who follows nobody');

    // Bob has had the wedding song already: it is no alert for him, and still one for alice.
    const had = catalog.add({ title: WEDDING.title, artist: 'David Ben Arza', url: 'https://music.youtube.com/watch?v=1P8kYZb0nkU', album: { id: WEDDING.browseId, title: WEDDING.title, songs: 1 } });
    catalog.recordPlay(had.id, new Date(clock), BOB);
    assert.deepEqual(releases.toAlert(lookback(), BOB).map((one) => one.title), ['Bakol']);
    assert.equal(releases.toAlert(lookback(), ALICE).length, 1);

    releases.markAlerted([BAKOL.browseId], new Date(clock));
    assert.deepEqual(releases.toAlert(lookback()), [], "the owner's, once");
    assert.equal(releases.toAlert(lookback(), BOB).length, 1, "bob's Bakol is still to come");
    releases.markAlerted([WEDDING.browseId], new Date(clock), ALICE);
    assert.deepEqual(releases.toAlert(lookback(), ALICE), []);
    assert.equal(catalog.releases(ALICE).find((one) => one.id === WEDDING.browseId)!.alertedAt, new Date(clock).toISOString());
    assert.equal(catalog.releases().find((one) => one.id === WEDDING.browseId)!.alertedAt, undefined);
  });

  test("Zemer's artist list still holds back what any person would be told", async () => {
    const releases = store();
    await releases.sync();
    follow('Yisroel Meth', '2026-10-20T00:00:00Z', ALICE);
    assert.equal(releases.toAlert(lookback(), ALICE).length, 1);
    content.publish((_artists, blocked) => blocked.global.push(BAKOL.sampleVideoId!));
    await whitelist.ready();
    assert.deepEqual(releases.toAlert(lookback(), ALICE), []);
    assert.ok(releases.toAnnounce(new Date('2026-10-20T00:00:00Z'), ALICE).every((one) => one.id !== BAKOL.browseId), 'nor is it in the daily message');
    assert.ok(releases.toAnnounce(new Date('2026-10-20T00:00:00Z')).every((one) => one.id !== BAKOL.browseId));
  });
});
