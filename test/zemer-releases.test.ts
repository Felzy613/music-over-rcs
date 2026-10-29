import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { createNewReleases, newReleasesFromEnv, parseFeed, ZemerReleases, ZemerReleasesError, ZEMER_RELEASES_URL, zemerReleasesFromEnv } from '../src/sources/zemer-releases.ts';
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { startMockZemerReleases, type MockFeedRelease, type MockZemerReleases } from './helpers/mock-zemer-releases.ts';

// What the Zemer team's new-releases feed answered on 2026-10-29 (the first eleven of its 44 releases): the golden answer.
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/zemer/latest-releases.json', import.meta.url), 'utf8')) as { releases: MockFeedRelease[] };
const BY = (title: string): MockFeedRelease => {
  const found = FIXTURE.releases.find((release) => release.title === title);
  assert.ok(found, `the fixture has no "${title}"`);
  return found;
};
const BAKOL = BY('Bakol');
const WEDDING = BY('חתונה בזריחה');
const EP = BY('A Color War EP');
const ALBUM = BY('VOICE OF THE STARS 2');
const MOTTI = BY("מיכאל'ס מאמע");

const DAY_MS = 24 * 60 * 60_000;
const everyone = (): MockArtist[] => [...new Map(FIXTURE.releases.map((release) => [release.artistId, { id: release.artistId, name: release.artistName }])).values()];

describe('Zemer’s new releases', () => {
  let feed: MockZemerReleases;
  let content: MockZemerContent;
  let catalog: Catalog;
  let whitelist: ZemerWhitelist;
  let clock = Date.parse('2026-10-29T06:00:00Z');
  before(async () => {
    feed = await startMockZemerReleases(FIXTURE.releases);
    content = await startMockZemerContent(everyone());
  });
  after(async () => {
    await feed.close();
    await content.close();
  });
  beforeEach(() => {
    feed.reset(FIXTURE.releases);
    content.reset(everyone());
    catalog = new Catalog(':memory:');
    // Kept current by its watcher while the bot runs; here a test asks it to look when it changes the list.
    whitelist = new ZemerWhitelist({ baseUrl: content.url, checkEveryMs: 0, retryAfterMs: 0 });
    clock = Date.parse('2026-10-29T06:00:00Z');
  });
  afterEach(() => catalog.close());

  const client = () => new ZemerReleases({ url: `${feed.url}/?page=zemer_releases` });
  const store = (logs: string[] = []) =>
    createNewReleases({
      feed: client(),
      whitelist,
      catalog,
      log: (line) => logs.push(line),
      now: () => new Date(clock),
    });

  describe('the feed', () => {
    test('is read the way the Zemer app reads it: newest first, a single told by its one song, dates in UTC', async () => {
      const releases = await client().latest();
      assert.equal(releases.length, 11);
      assert.deepEqual(releases[0], {
        id: WEDDING.browseId,
        title: 'חתונה בזריחה',
        artist: 'David Ben Arza',
        artistId: WEDDING.artistId,
        cover: WEDDING.thumbnail,
        releasedAt: '2026-10-28T12:02:02.000Z',
        songs: 1,
        videoId: WEDDING.sampleVideoId,
      });
      const ep = releases.find((release) => release.id === EP.browseId)!;
      assert.deepEqual([ep.songs, ep.videoId], [2, undefined], 'an EP is not a single: its sample song says nothing about it');
      assert.equal(releases.find((release) => release.id === ALBUM.browseId)!.songs, 12);
      assert.deepEqual(
        releases.map((release) => release.releasedAt),
        [...releases.map((release) => release.releasedAt)].sort().reverse(),
        'the feed’s order is kept',
      );
    });

    test('a release it cannot use is left out and the others still count; an answer that is no feed is an error', () => {
      const good = FIXTURE.releases[0]!;
      const feedOf = (...rows: unknown[]) => ({ releases: rows });
      assert.deepEqual(parseFeed(feedOf()), [], 'an empty feed is a feed');
      const kept = parseFeed(
        feedOf(
          { ...good, browseId: 'no spaces allowed' },
          { ...good, artistId: undefined },
          { ...good, title: '  ' },
          { ...good, uploadDate: 'last tuesday' },
          'not even an object',
          { ...good, browseId: 'MPREb_kept', trackCount: undefined, sampleVideoId: 'short', thumbnail: 'http://insecure.example/cover.jpg', title: `‎ונתנו‏` },
        ),
      );
      assert.equal(kept.length, 1);
      assert.deepEqual(kept[0], { id: 'MPREb_kept', title: 'ונתנו', artist: good.artistName, artistId: good.artistId, releasedAt: '2026-10-28T12:02:02.000Z', songs: 0 });
      for (const answer of [{}, { releases: 'soon' }, [], null, 'a page']) assert.throws(() => parseFeed(answer), ZemerReleasesError);
    });

    test('is not believed more than it has to be: covers only from Google’s picture hosts, and no title the length of a page', () => {
      const good = FIXTURE.releases[0]!;
      const [near, far, fake, long] = parseFeed({
        releases: [
          { ...good, browseId: 'MPREb_near', thumbnail: 'https://lh3.googleusercontent.com/abc=w544' },
          { ...good, browseId: 'MPREb_far', thumbnail: 'https://169.254.169.254/latest/meta-data' },
          { ...good, browseId: 'MPREb_fake', thumbnail: 'https://googleusercontent.com.evil.example/cover.jpg' },
          { ...good, browseId: 'MPREb_long', title: 'x'.repeat(500) },
        ],
      });
      assert.equal(near!.cover, 'https://lh3.googleusercontent.com/abc=w544');
      assert.equal(far!.cover, undefined, 'the release is kept, with no picture');
      assert.equal(fake!.cover, undefined);
      assert.equal(long, undefined, 'a title that long is no title');
    });

    test('is asked again with the ETag it was given, and a 304 keeps the list', async () => {
      const zemer = client();
      const first = await zemer.latest();
      assert.deepEqual(feed.requests.map((request) => request.etag), ['']);
      assert.equal((await zemer.latest()).length, first.length);
      assert.match(feed.requests[1]!.etag, /^"mock-feed-\d+"$/, 'the second ask says which answer it has');
      assert.deepEqual(await zemer.latest(), first, 'and gets it back unchanged');
      feed.publish((releases) => releases.shift());
      assert.equal((await zemer.latest()).length, first.length - 1, 'a rebuilt feed is read again');
    });

    test('a feed that cannot be had is an error in words fit for the chat, and never loses the list it has', async () => {
      const zemer = client();
      const first = await zemer.latest();
      feed.failing = true;
      await assert.rejects(zemer.latest(), (err) => err instanceof ZemerReleasesError && err.message === "Zemer's new-releases feed answered HTTP 500");
      feed.failing = false;
      feed.body = 'this is not json';
      await assert.rejects(zemer.latest(), (err) => err instanceof ZemerReleasesError && /unreadable/.test(err.message));
      feed.body = '{"releases":"soon"}';
      await assert.rejects(zemer.latest(), (err) => err instanceof ZemerReleasesError && /can't read/.test(err.message));
      await assert.rejects(new ZemerReleases({ url: 'http://127.0.0.1:9/', timeoutMs: 500 }).latest(), (err) => err instanceof ZemerReleasesError && /didn't answer/.test(err.message));
      feed.body = undefined;
      assert.deepEqual(await zemer.latest(), first, 'the next good answer is the same feed');
    });

    test('ZEMER_RELEASES=off turns it off; ZEMER_RELEASES_URL points it elsewhere', () => {
      assert.equal(zemerReleasesFromEnv({ ZEMER_RELEASES: 'off' }), undefined);
      assert.equal(zemerReleasesFromEnv({ ZEMER_RELEASES: 'No' }), undefined);
      assert.equal(zemerReleasesFromEnv({ ZEMER_RELEASES_URL: 'http://127.0.0.1:1/?page=x' })!.url, 'http://127.0.0.1:1/?page=x');
      assert.equal(zemerReleasesFromEnv({})!.url, ZEMER_RELEASES_URL);
      assert.equal(ZEMER_RELEASES_URL, 'https://flipphoneguy.duckdns.org/?page=zemer_releases');
      const whitelist = new ZemerWhitelist({ baseUrl: content.url });
      assert.ok(newReleasesFromEnv({ catalog, whitelist }, {}));
      assert.equal(newReleasesFromEnv({ catalog, whitelist }, { ZEMER_RELEASES: 'off' }), undefined);
      assert.equal(newReleasesFromEnv({ catalog, whitelist: undefined }, {}), undefined, 'without the artist list nothing from Zemer goes unchecked, so nothing at all');
    });
  });

  describe('the releases kept', () => {
    test('are the ones the artist list lets through: listed artists, no women, nothing blocked', async () => {
      content.reset(
        everyone()
          .filter((artist) => artist.name !== 'Chaim Ghoori')
          .map((artist) => (artist.name === 'מוטי ויזל' ? { ...artist, female: true } : artist)),
      );
      content.blocked.global.push(BAKOL.sampleVideoId!);
      const logs: string[] = [];
      const releases = store(logs);
      const outcome = await releases.sync();
      assert.ok(outcome.ok);
      assert.equal(outcome.seen, 8, 'eleven in the feed, three held back');
      assert.equal(outcome.fresh.length, 8);
      assert.deepEqual(
        releases.list().map((release) => release.title),
        FIXTURE.releases.map((release) => release.title).filter((title) => !['But i hope (It leads to you)', "מיכאל'ס מאמע", 'Bakol'].includes(title)),
        'newest first',
      );
      assert.equal(catalog.releases().length, 8, 'the ones held back are not even kept');
      assert.deepEqual(logs, ["read Zemer's new releases: 11 in the feed, 8 pass Zemer's list, 8 new here"]);
    });

    test('stay kept when their artist is flagged later, but are no longer listed, announced or alerted', async () => {
      const releases = store();
      await releases.sync();
      const names = () => releases.list().map((release) => release.artist);
      assert.ok(names().includes('Yisroel Meth'));
      content.publish((artists, blocked) => {
        artists.find((artist) => artist.name === 'Yisroel Meth')!.female = true;
        blocked.global.push(WEDDING.sampleVideoId!);
      });
      await whitelist.ready();
      assert.ok(!names().includes('Yisroel Meth'), 'a woman is flagged');
      assert.ok(!names().includes('David Ben Arza'), 'a song is blocked');
      assert.equal(catalog.releases().length, 11);
      assert.ok(releases.toAnnounce(new Date(clock - 30 * DAY_MS)).every((release) => release.artist !== 'Yisroel Meth'));
    });

    test('are read again after a while, not on every ask; a failure waits ten minutes; asks at the same time share one request', async () => {
      const releases = store();
      const [a, b] = await Promise.all([releases.sync(), releases.sync()]);
      assert.deepEqual([feed.requests.length, a.ok, b.ok], [1, true, true]);
      clock += 5 * 60_000;
      const again = await releases.sync();
      assert.deepEqual([feed.requests.length, again.ok && again.fresh.length], [1, 0], 'five minutes later, nothing is asked');
      clock += 11 * 60_000;
      assert.ok((await releases.sync()).ok);
      assert.equal(feed.requests.length, 2, 'a quarter of an hour later it is, with the ETag, so the feed says nothing changed');
      assert.match(feed.requests[1]!.etag, /^"mock-feed-/);

      feed.failing = true;
      clock += 20 * 60_000;
      const failed = await releases.sync();
      assert.ok(!failed.ok && /HTTP 500/.test(failed.problem));
      clock += 5 * 60_000;
      await releases.sync();
      assert.equal(feed.requests.length, 3, 'five minutes after a failure it is not asked again');
      clock += 6 * 60_000;
      const stillFailing = await releases.sync();
      assert.equal(feed.requests.length, 4, 'ten minutes after, it is');
      assert.ok(!stillFailing.ok && !failed.ok && stillFailing.since.getTime() === failed.since.getTime(), 'one failure that goes on, since when it began');

      feed.failing = false;
      clock += 11 * 60_000;
      assert.ok((await releases.sync()).ok, 'and the first good answer ends it');
      assert.equal(releases.list().length, 11, 'with the releases it had all along');
    });

    test('a sync with no artist list at all fails in words, and keeps what it has', async () => {
      const releases = createNewReleases({
        feed: client(),
        whitelist: new ZemerWhitelist({ baseUrl: 'http://127.0.0.1:9' }),
        catalog,
        now: () => new Date(clock),
      });
      const outcome = await releases.sync();
      assert.ok(!outcome.ok && /artist list/.test(outcome.problem), JSON.stringify(outcome));
      assert.equal(feed.requests.length, 0, 'the feed is not even asked: nothing would be checked');
      assert.equal(catalog.releases().length, 0);
    });

    test('are forgotten a month and a half after they came out', async () => {
      const releases = store();
      await releases.sync();
      assert.equal(catalog.releases().length, 11);
      feed.reset([]);
      clock = Date.parse('2026-12-20T06:00:00Z');
      assert.ok((await releases.sync()).ok);
      assert.equal(catalog.releases().length, 0);
    });

    test('are announced once: those that came out after the last message, and not announced yet', async () => {
      const releases = store();
      await releases.sync();
      const since = new Date('2026-10-27T12:00:00Z');
      const due = releases.toAnnounce(since);
      assert.deepEqual(
        due.map((release) => release.title),
        ['חתונה בזריחה', 'Light Of My Neshama', 'אמונה (feat. שגיא ציקורל)', 'Arum Mich (feat. Leiby Nitzlich)', 'But i hope (It leads to you)'],
        'came out after noon on the 27th (UTC)',
      );
      releases.markAnnounced([due[0]!.id, due[1]!.id], new Date(clock));
      assert.deepEqual(releases.toAnnounce(since).map((release) => release.title), ['אמונה (feat. שגיא ציקורל)', 'Arum Mich (feat. Leiby Nitzlich)', 'But i hope (It leads to you)']);
      assert.equal(catalog.releases().find((release) => release.id === due[0]!.id)!.announcedAt, new Date(clock).toISOString());
    });

    describe('alerts', () => {
      const follow = (artist: string, since: string) => {
        catalog.add({ title: `Older song by ${artist}`, artist, url: `https://music.youtube.com/watch?v=${artist.replace(/\W/g, '').padEnd(11, 'x').slice(0, 11)}` });
        catalog.follow(catalog.findArtist(artist.toLowerCase().split(' '))!.id, false, new Date(since));
      };
      const since = () => new Date(clock - 3 * DAY_MS);

      test('are for artists you follow, once they have been seen after you started following, and not for a song you had', async () => {
        const releases = store();
        await releases.sync();
        follow('Yisroel Meth', '2026-10-28T00:00:00Z');
        follow('Chaim Pollak', '2026-10-30T00:00:00Z'); // follows later than the release was first seen
        follow('David Ben Arza', '2026-10-28T00:00:00Z');
        // A song of that release that was sent: Zemer's album page has been opened and it was played.
        const had = catalog.add({ title: 'חתונה בזריחה', artist: 'David Ben Arza', url: 'https://music.youtube.com/watch?v=1P8kYZb0nkU', album: { id: WEDDING.browseId, title: 'חתונה בזריחה', songs: 1 } });
        catalog.recordPlay(had.id);
        const alerts = releases.toAlert(since());
        assert.deepEqual(alerts.map((release) => [release.title, release.artists]), [['Bakol', ['Yisroel Meth']]]);
        releases.markAlerted(alerts.map((release) => release.id), new Date(clock));
        assert.deepEqual(releases.toAlert(since()), [], 'once');
        assert.equal(catalog.releases().find((release) => release.id === BAKOL.browseId)!.alertedAt, new Date(clock).toISOString());
      });

      test('know an artist by their name in either alphabet, as the artist list has it', async () => {
        content.reset(everyone().map((artist) => (artist.name === 'מוטי ויזל' ? { ...artist, altName: 'Moti Weisel' } : artist)));
        const releases = store();
        await releases.sync();
        follow('Moti Weisel', '2026-10-20T00:00:00Z');
        assert.deepEqual(releases.toAlert(since()).map((release) => [release.title, release.artists]), [[MOTTI.title, ['Moti Weisel']]]);
      });

      test('are for nobody when you follow nobody, and not for a release the artist list no longer lets through', async () => {
        const releases = store();
        await releases.sync();
        assert.deepEqual(releases.toAlert(since()), []);
        follow('Yisroel Meth', '2026-10-20T00:00:00Z');
        assert.equal(releases.toAlert(since()).length, 1);
        content.publish((_artists, blocked) => blocked.global.push(BAKOL.sampleVideoId!));
        await whitelist.ready();
        assert.deepEqual(releases.toAlert(since()), []);
      });

      test('are only for what came out in the last two days of the window asked for', async () => {
        const releases = store();
        await releases.sync();
        follow('Yisroel Meth', '2026-10-20T00:00:00Z');
        assert.equal(releases.toAlert(new Date('2026-10-28T00:00:00Z')).length, 0, 'Bakol came out on the 27th');
        assert.equal(releases.toAlert(new Date('2026-10-27T00:00:00Z')).length, 1);
      });
    });
  });
});
