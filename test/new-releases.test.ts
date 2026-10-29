import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { catalogBrowse } from '../src/library/browse.ts';
import { LibraryJobs, localDay, STATE } from '../src/library/jobs.ts';
import { MusicTable } from '../src/sources/music-table.ts';
import { createNewReleases, ZemerReleases, type NewReleases } from '../src/sources/zemer-releases.ts';
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import type { Reply } from '../src/types.ts';
import { startMockMusicTable, type MockMusicTable, type MockPost } from './helpers/mock-music-table.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { startMockZemerReleases, type MockFeedRelease, type MockZemerReleases } from './helpers/mock-zemer-releases.ts';
import { startMockZemerSearch, type MockZemerRelease, type MockZemerSearch } from './helpers/mock-zemer-search.ts';
import { artistId, startMockYouTubeMusic, type MockYouTubeMusic } from './helpers/mock-youtube-music.ts';
import { fixtureBot } from './helpers/zemer-fixtures.ts';

// Zemer as a source of new releases: its feed (the one behind the Zemer app's Latest Releases shelf) joins music-table.com's
// in the "new" list, the daily message and the alerts for artists you follow.

/** A time on an October day of 2026 in this machine's time zone, like the bot's own clock (so no test depends on where it runs). */
const at = (day: number, hour = 12, minute = 0): Date => new Date(2026, 9, day, hour, minute);
const NOW = at(29, 10);
const MINUTE = 60_000;

type TextReply = Extract<Reply, { kind: 'text' }>;
const texts = (replies: Reply[]): string[] => replies.flatMap((reply) => (reply.kind === 'text' && reply.text ? [reply.text] : []));
const lines = (replies: Reply[]): TextReply[] => replies.filter((reply): reply is TextReply => reply.kind === 'text' && Boolean(reply.postback) && !reply.postback!.startsWith('view:'));
const lineOf = (replies: Reply[], start: string): TextReply => {
  const found = lines(replies).find((reply) => reply.text.startsWith(start));
  assert.ok(found, `no line "${start}" in ${JSON.stringify(texts(replies))}`);
  return found;
};

const trackId = (row: MockFeedRelease, i: number): string => (i === 0 ? row.sampleVideoId! : `${row.sampleVideoId!.slice(0, 9)}${String(i).padStart(2, '0')}`);
/** A release of the feed. A single has one song; anything else is an album with that many songs. */
const release = (slug: string, title: string, artist: string, when: Date, songs = 1): MockFeedRelease => ({
  artistId: artistId(artist),
  artistName: artist,
  title,
  browseId: `MPREb_${slug}`,
  playlistId: `OLAK5uy_${slug}`,
  thumbnail: `https://yt3.googleusercontent.com/${slug}=w544-h544-l90-rj`,
  year: 2026,
  uploadDate: when.toISOString(),
  trackCount: songs,
  sampleVideoId: `v${slug}`.padEnd(11, '0').slice(0, 11),
});
/** The same release as its album page on Zemer's search service. */
const albumPage = (row: MockFeedRelease): MockZemerRelease => ({
  id: row.browseId,
  title: row.title,
  artist: row.artistName,
  artistId: row.artistId,
  year: row.year,
  releaseDate: row.uploadDate,
  thumbnail: row.thumbnail,
  type: row.trackCount === 1 ? 'single' : 'album',
  tracks: Array.from({ length: row.trackCount ?? 1 }, (_, i) => ({ videoId: trackId(row, i), title: row.trackCount === 1 ? row.title : `${row.title} · song ${i + 1}` })),
});

/** The pretend music-table.com post in the catalog: what a sync of the site leaves there. */
function sitePost(catalog: Catalog, slug: string, artist: string, title: string, when: Date, files = 1): void {
  catalog.savePost({ slug, title: `${artist} - ${title}`, category: 'Singles', publishedAt: when.toISOString(), views: 0, audioFiles: files }, NOW);
  for (let i = 0; i < files; i += 1) {
    catalog.add({ title: files > 1 ? `${title} ${i + 1}` : title, artist, url: `https://x.test/post/${slug}#${i}`, post: slug, releasedAt: when.toISOString() });
  }
}

const BAKOL = release('bakol', 'Bakol', 'Yisroel Meth', at(27, 12));
const WEDDING = release('wedding', 'חתונה בזריחה', 'David Ben Arza', at(28, 12, 30));
const VOICE = release('voice', 'VOICE OF THE STARS 2', 'Tzvi Silberstein', at(23, 12), 12);
const WAR = release('war', 'A Color War EP', 'Camp M & N', at(26, 9), 2);
const FEED = [WEDDING, BAKOL, WAR, VOICE];
const LISTED: MockArtist[] = [...new Set([...FEED.map((row) => row.artistName), 'Someone Else', 'Old Band'])].map((name) => ({ id: artistId(name), name }));

describe('new releases from Zemer', () => {
  let feed: MockZemerReleases;
  let content: MockZemerContent;
  let search: MockZemerSearch;
  let youtube: MockYouTubeMusic;
  before(async () => {
    feed = await startMockZemerReleases(FEED);
    content = await startMockZemerContent(LISTED);
    search = await startMockZemerSearch({ artists: [], songs: [], releases: [] });
    youtube = await startMockYouTubeMusic([], []);
  });
  after(async () => {
    await Promise.all([feed.close(), content.close(), search.close(), youtube.close()]);
  });

  let catalog: Catalog;
  let whitelist: ZemerWhitelist;
  let clock = NOW.getTime();
  let logs: string[] = [];
  beforeEach(() => {
    feed.reset(FEED);
    content.reset(LISTED);
    search.reset();
    search.releases = FEED.map(albumPage);
    youtube.reset();
    catalog = new Catalog(':memory:');
    whitelist = new ZemerWhitelist({ baseUrl: content.url, checkEveryMs: 0, retryAfterMs: 0 });
    clock = NOW.getTime();
    logs = [];
  });
  afterEach(() => catalog.close());

  const releasesOf = (): NewReleases =>
    createNewReleases({ feed: new ZemerReleases({ url: `${feed.url}/?page=zemer_releases` }), whitelist, catalog, log: (line) => logs.push(line), now: () => new Date(clock) });

  describe('the "new" list', () => {
    /** A bot over the catalog and Zemer's mocks; `null` leaves Zemer's feed out. */
    const chat = (releases: NewReleases | null = releasesOf()) => {
      const browse = catalogBrowse(catalog, () => NOW, undefined, releases ?? undefined);
      return fixtureBot({ search: search.url, content: content.url, youtube: youtube.url }, { catalog, deps: { browse, now: () => NOW } });
    };
    const sitePosts = () => {
      sitePost(catalog, 'other', 'Someone Else', 'Other Song', at(28, 20));
      // The same song Zemer has: listed once, as Zemer's.
      sitePost(catalog, 'bakol-site', 'Yisroel Meth', 'Bakol', at(27, 15));
      sitePost(catalog, 'old-album', 'Old Band', 'Old Album', at(24, 9), 3);
      sitePost(catalog, 'oldest', 'Old Band', 'Oldest', at(20, 9));
    };

    test("lists Zemer's releases among music-table.com's, newest first, and a song both have once, as Zemer's", async () => {
      sitePosts();
      const { say } = chat();
      const replies = await say('new');
      assert.deepEqual(texts(replies), [
        '🆕 New on Zemer and music-table.com',
        'Other Song — Someone Else · Oct 28',
        'חתונה בזריחה — David Ben Arza · Oct 28',
        'Bakol — Yisroel Meth · Oct 27',
        '💿 A Color War EP — Camp M & N · 2 songs · Oct 26',
        '💿 Old Album — Old Band · 3 songs · Oct 24',
        '💿 VOICE OF THE STARS 2 — Tzvi Silberstein · 12 songs · Oct 23',
        'Oldest — Old Band · Oct 20',
        'Tap 👍 on one to get it.',
      ]);
      const postbacks = lines(replies).map((reply) => reply.postback!.replace(/@\d+$/, '').replace(/^play:\d+$/, 'play:N'));
      assert.deepEqual(postbacks, ['play:N', 'single:MPREb_wedding', 'single:MPREb_bakol', 'album:MPREb_war', 'post:old-album', 'album:MPREb_voice', 'play:N']);
      assert.ok(catalog.search('Bakol', 5).some((track) => track.url.includes('bakol-site')), 'music-table.com’s copy is still in the catalog, only not listed twice');
    });

    test('without Zemer’s feed it is music-table.com’s list, as it was', async () => {
      sitePosts();
      const { say } = chat(null);
      const replies = await say('new');
      assert.equal(texts(replies)[0], '🆕 New on music-table.com');
      assert.equal(lines(replies).length, 4);
    });

    test('the help says where "new" looks, only when Zemer’s feed is one of the places', async () => {
      const withZemer = texts(await chat().say('help'))[0]!;
      assert.match(withZemer, /\nnew — the newest releases, from Zemer and music-table\.com\ntrending · chanukah · purim · wedding · vocal — music-table\.com lists$/);
      const without = texts(await chat(null).say('help'))[0]!;
      assert.match(without, /\ntrending · new · chanukah · purim · wedding · vocal — music-table\.com lists$/);
    });

    test('a 👍 on a single sends its song, on an album opens its songs', async () => {
      const { say, tap } = chat();
      const replies = await say('new');
      const single = await tap(lineOf(replies, 'Bakol').postback!);
      assert.deepEqual(
        single.map((reply) => reply.kind),
        ['image', 'audio'],
        'a card with the cover, then the song',
      );
      const song = `${youtube.url}/watch?v=${BAKOL.sampleVideoId}`;
      const audio = single.find((reply) => reply.kind === 'audio');
      assert.ok(audio?.kind === 'audio' && audio.url === song, JSON.stringify(audio));
      assert.equal(catalog.albumOf(song)?.id, BAKOL.browseId, 'and it is on its album, as any song of Zemer’s');

      const album = await tap(lineOf(replies, '💿 A Color War EP').postback!);
      const shown = texts(album);
      assert.match(shown[0]!, /^💿 A Color War EP — Camp M & N · 2026 · 2 songs$/);
      assert.deepEqual(album.flatMap((reply) => (reply.kind === 'text' && reply.number !== undefined ? [reply.number] : [])), [1, 2]);
      assert.ok(shown.includes('📦 All 2 songs as one zip'));
    });

    test('goes on with "more", in the same order, nothing twice', async () => {
      const singles = Array.from({ length: 12 }, (_, i) => release(`s${String(i).padStart(2, '0')}`, `Single ${i + 1}`, `Artist ${i % 3}`, at(28, 23 - i)));
      feed.reset(singles);
      search.releases = singles.map(albumPage);
      content.reset([...singles.map((row) => ({ id: row.artistId, name: row.artistName })), { id: artistId('Band'), name: 'Band' }]);
      for (const [i, hour] of [11, 10, 9].entries()) sitePost(catalog, `site${i}`, 'Band', `Site Song ${i + 1}`, at(28, hour));
      const { say } = chat();
      const first = await say('new');
      assert.equal(lines(first).length, 10);
      assert.match(texts(first).at(-1)!, /text "more" for the next ones/);
      const second = await say('more');
      assert.deepEqual(
        lines(second).map((reply) => reply.text.replace(/ — .*/, '')),
        ['Single 11', 'Single 12', 'Site Song 1', 'Site Song 2', 'Site Song 3'],
      );
      const all = [...lines(first), ...lines(second)].map((reply) => reply.text);
      assert.equal(new Set(all).size, all.length, 'no line twice');
      assert.equal(feed.requests.length, 1, 'the second page goes on with what the first found');
    });

    test('reads the feed when asked, but not again within a quarter of an hour; a feed that is down leaves music-table.com’s list', async () => {
      sitePosts();
      const { say } = chat();
      await say('new');
      await say('new');
      assert.equal(feed.requests.length, 1);
      clock += 16 * MINUTE;
      await say('new');
      assert.equal(feed.requests.length, 2);
      assert.match(feed.requests[1]!.etag, /^"mock-feed-/, 'with the ETag, so an unchanged feed costs nothing');

      catalog.close();
      catalog = new Catalog(':memory:');
      sitePosts();
      feed.failing = true;
      clock += 20 * MINUTE;
      const down = await chat().say('new');
      assert.deepEqual(texts(down).slice(0, 3), ['🆕 New on Zemer and music-table.com', 'Other Song — Someone Else · Oct 28', 'Bakol — Yisroel Meth · Oct 27'], 'no word about it: the site’s list as it is');
      assert.equal(lines(down).length, 4);
    });

    test('does not make you wait for a slow feed: the list is what is there now, and the feed is read on in the background', async () => {
      sitePosts();
      const releases = releasesOf();
      const browse = catalogBrowse(catalog, () => NOW, undefined, releases, 40);
      const { say } = fixtureBot({ search: search.url, content: content.url, youtube: youtube.url }, { catalog, deps: { browse, now: () => NOW } });
      feed.delayMs = 200;
      const started = Date.now();
      const slow = await say('new');
      assert.ok(Date.now() - started < 150, `took ${Date.now() - started} ms`);
      assert.equal(lines(slow).length, 4, 'music-table.com’s alone, for now');
      await new Promise((resolve) => setTimeout(resolve, 250));
      feed.delayMs = 0;
      assert.equal(lines(await say('new')).length, 7, 'and Zemer’s too once it has been read');
      assert.equal(feed.requests.length, 1, 'by the one read that was under way');
    });

    test('lists nothing the artist list no longer lets through', async () => {
      const { say } = chat();
      assert.equal(lines(await say('new')).length, 4);
      content.publish((artists) => {
        artists.find((artist) => artist.name === 'Camp M & N')!.female = true;
      });
      await whitelist.ready();
      const after = texts(await say('new'));
      assert.ok(after.every((line) => !line.includes('Camp M')), JSON.stringify(after));
      assert.equal(after.length, 5);
    });
  });

  describe('the daily message and the alerts', () => {
    let site: MockMusicTable | undefined;
    let clockNow = at(28, 8);
    afterEach(async () => {
      await site?.close();
      site = undefined;
    });

    const A = release('alpha', 'Zed Single', 'Artist Alpha', at(28, 7, 30));
    const B = release('beta', 'Bee Single', 'Artist Beta', at(28, 5));
    const C = release('gamma', 'Cee Album', 'Artist Gamma', at(27, 20), 9);
    const JOBS_LISTED = [A, B, C].map((row) => ({ id: row.artistId, name: row.artistName }));

    async function jobsSetUp(options: { posts?: MockPost[]; feedRows?: MockFeedRelease[]; quiet?: { from: { hour: number; minute: number }; to: { hour: number; minute: number } }; chatDown?: { value: boolean } } = {}) {
      site = await startMockMusicTable(options.posts ?? []);
      feed.reset(options.feedRows ?? [A, B, C]);
      content.reset([...JOBS_LISTED, { id: artistId('Band'), name: 'Band' }]);
      clockNow = at(28, 8);
      // The whole-site scan is done and the bot has run before: only the sync and the daily message matter here.
      catalog.setState(STATE.scanDone, at(1, 0).toISOString());
      catalog.setState(STATE.digestDate, localDay(at(27, 9)));
      const releases = createNewReleases({
        feed: new ZemerReleases({ url: `${feed.url}/?page=zemer_releases` }),
        whitelist: new ZemerWhitelist({ baseUrl: content.url, checkEveryMs: 0, retryAfterMs: 0 }),
        catalog,
        log: (line) => logs.push(line),
        now: () => clockNow,
      });
      const sent: Reply[][] = [];
      const told: Array<[boolean, string | undefined]> = [];
      const jobs = new LibraryJobs({
        musicTable: new MusicTable({ baseUrl: site.url, minIntervalMs: 0 }),
        catalog,
        announce: async (replies) => {
          if (options.chatDown?.value) throw new Error('the bridge is not connected to Google Messages');
          sent.push(replies);
        },
        digestAt: { hour: 9, minute: 0 },
        fetchAudio: async () => {
          throw new Error('no downloads in these tests');
        },
        releases,
        onReleases: (ok, problem) => void told.push([ok, problem]),
        quiet: options.quiet,
        log: (line) => logs.push(line),
        now: () => clockNow,
      });
      return { jobs, sent, told, releases, setClock: (date: Date) => (clockNow = date) };
    }

    const sitePosts: MockPost[] = [{ slug: 'site-song', title: 'Band - Site Song', files: [{ name: 'song.mp3' }], publishedAt: at(28, 6).toISOString(), category: 'Singles', coverId: 'img~mv2.jpg' }];

    test("the daily message has Zemer's releases among music-table.com's, the newest first, and goes out once", async () => {
      const { jobs, sent, setClock } = await jobsSetUp({ posts: sitePosts });
      await jobs.check();
      assert.equal(sent.length, 0, 'before nine');
      setClock(at(28, 9, 5));
      await jobs.check();
      assert.equal(sent.length, 1);
      const message = sent[0]!;
      assert.deepEqual(texts(message), [
        'New music · Wednesday, Oct 28\n4 new songs on Zemer and music-table.com',
        'Zed Single — Artist Alpha · single',
        'Site Song — Band · single',
        'Bee Single — Artist Beta · single',
        '💿 Cee Album — Artist Gamma · 9 songs',
        'Tap 👍 on a song to get it, or "search" for anything else.',
      ]);
      const postbacks = lines(message).map((reply) => reply.postback!.replace(/^play:\d+$/, 'play:N'));
      assert.deepEqual(postbacks, ['single:MPREb_alpha', 'play:N', 'single:MPREb_beta', 'album:MPREb_gamma']);
      const collage = message.find((reply) => reply.kind === 'collage');
      assert.ok(collage?.kind === 'collage');
      assert.deepEqual(collage.images.map((image) => image.postback.replace(/^play:\d+$/, 'play:N')), postbacks, 'a cover for each, in the same order');
      const closing = message.at(-1);
      assert.ok(closing?.kind === 'text' && closing.chips?.map((chip) => chip.label).join('|') === '1. Zed Single|2. Site Song|3. Bee Single|4. Cee Album');
      assert.ok(catalog.releases().every((one) => one.announcedAt), 'every release is marked as announced');
      assert.ok(catalog.sitePost('site-song')?.announcedAt);

      setClock(at(28, 9, 40));
      await jobs.check();
      assert.equal(sent.length, 1, 'once a day');
      setClock(at(29, 9, 5));
      await jobs.check();
      assert.equal(sent.length, 1, 'and nothing new the next day, so no message');
    });

    test('a song both have is in the message once, as Zemer’s, and the site’s copy is done with; Zemer alone is "on Zemer"', async () => {
      const dup: MockPost = { slug: 'dup', title: 'Artist Alpha - Zed Single', files: [{ name: 'dup.mp3' }], publishedAt: at(28, 6, 30).toISOString(), category: 'Singles' };
      const { jobs, sent, setClock } = await jobsSetUp({ posts: [dup] });
      await jobs.check();
      setClock(at(28, 9, 5));
      await jobs.check();
      assert.equal(sent.length, 1);
      assert.deepEqual(texts(sent[0]!).slice(0, 2), ['New music · Wednesday, Oct 28\n3 new songs on Zemer', 'Zed Single — Artist Alpha · single']);
      assert.ok(texts(sent[0]!).every((line) => !line.includes('music-table.com') || line.startsWith('New music')), 'one line for the song');
      assert.ok(catalog.sitePost('dup')?.announcedAt, 'the copy counts as announced, so it does not turn up tomorrow');
    });

    test("with Zemer's feed down the message is music-table.com’s alone, and a feed down for half a day is said once, and again when it is back", async () => {
      const { jobs, sent, told, setClock } = await jobsSetUp({ posts: sitePosts });
      feed.failing = true;
      /** A check every half hour, from `from` to `to` minutes after eight in the morning. */
      const checks = async (from: number, to: number): Promise<void> => {
        for (let minutes = from; minutes <= to; minutes += 30) {
          setClock(new Date(at(28, 8).getTime() + minutes * MINUTE));
          await jobs.check();
        }
      };
      await checks(0, 11 * 60 + 30);
      assert.equal(sent.length, 1, 'the daily message went out at nine all the same');
      assert.equal(texts(sent[0]!)[0], 'New music · Wednesday, Oct 28\n1 new song on music-table.com');
      assert.equal(told.length, 0, 'eleven and a half hours down is not yet worth a word');
      assert.equal(logs.filter((line) => line.startsWith("could not read Zemer's new releases")).length, 1, 'logged once, not every few minutes');

      await checks(12 * 60, 13 * 60);
      assert.ok(told.length > 0 && told.every(([ok]) => !ok), JSON.stringify(told));
      assert.ok(told[0]![1]!.startsWith("Zemer's new releases haven't been readable for 12 hours (Zemer's new-releases feed answered HTTP 500)"), told[0]![1]);
      assert.equal(logs.filter((line) => line.startsWith("could not read Zemer's new releases")).length, 1, 'and still once');

      feed.failing = false;
      setClock(new Date(at(28, 8).getTime() + 14 * 60 * MINUTE));
      await jobs.check();
      assert.equal(told.at(-1)?.[0], true);
      assert.ok(logs.includes("Zemer's new releases are being read again"));
      assert.equal(catalog.releases().length, 3);
    });

    describe('alerts for artists you follow', () => {
      const follow = (artist: string, since = at(27, 0)): void => {
        catalog.add({ title: `Older song by ${artist}`, artist, url: `https://music.youtube.com/watch?v=${artist.replace(/\W/g, '').padEnd(11, 'x').slice(0, 11)}` });
        catalog.follow(catalog.findArtist(artist.toLowerCase().split(' '))!.id, false, since);
      };

      test('come on their own with the card, once: a single is sent when picked, an album opens', async () => {
        const { jobs, sent } = await jobsSetUp();
        follow('Artist Alpha');
        follow('Artist Gamma');
        await jobs.check();
        assert.equal(sent.length, 1, 'in the round that read the feed');
        const alert = sent[0]!;
        assert.deepEqual(
          alert.map((reply) => (reply.kind === 'text' ? reply.text : `[${reply.kind}]`)),
          ['[image]', '🔔 New from Artist Alpha: Artist Alpha — Zed Single', '[image]', '🔔 New from Artist Gamma: Cee Album · album, 9 songs', 'Tap 👍 on one to get it.'],
        );
        assert.deepEqual(
          alert.flatMap((reply) => (reply.kind === 'image' || (reply.kind === 'text' && reply.postback) ? [reply.kind === 'image' ? reply.postback : reply.postback] : [])),
          ['single:MPREb_alpha', 'single:MPREb_alpha', 'album:MPREb_gamma', 'album:MPREb_gamma'],
        );
        const closing = alert.at(-1);
        assert.ok(closing?.kind === 'text' && closing.chips?.map((chip) => `${chip.label}=${chip.postback}`).join('|') === '1. Zed Single=single:MPREb_alpha|2. Cee Album=album:MPREb_gamma');
        assert.equal(await jobs.alertFollowed(), 0, 'not twice');
        assert.deepEqual(catalog.releases().filter((one) => one.alertedAt).map((one) => one.id).sort(), ['MPREb_alpha', 'MPREb_gamma']);
      });

      test('wait for the morning in the quiet hours, and for the chat when it cannot take them', async () => {
        const chatDown = { value: true };
        const { jobs, sent, setClock } = await jobsSetUp({ quiet: { from: { hour: 22, minute: 0 }, to: { hour: 7, minute: 0 } }, chatDown });
        follow('Artist Alpha');
        setClock(at(28, 6));
        assert.equal(await jobs.alertFollowed(), 0);
        await jobs.syncReleases();
        assert.equal(await jobs.alertFollowed(), 0, 'quiet hours: it waits');
        setClock(at(28, 7, 5));
        assert.equal(await jobs.alertFollowed(), 0, 'the chat is down');
        assert.equal(catalog.releases().filter((one) => one.alertedAt).length, 0, 'so it is not counted as sent');
        chatDown.value = false;
        setClock(at(28, 7, 10));
        assert.equal(await jobs.alertFollowed(), 1);
        assert.equal(sent.length, 1);
      });

      test('are not sent for a song you had, nor for an artist you follow from after it came out', async () => {
        const { jobs, sent } = await jobsSetUp();
        follow('Artist Alpha');
        follow('Artist Beta', at(29, 0));
        const had = catalog.add({ title: 'Zed Single', artist: 'Artist Alpha', url: `https://music.youtube.com/watch?v=${A.sampleVideoId}`, album: { id: A.browseId, title: 'Zed Single', songs: 1 } });
        catalog.recordPlay(had.id);
        await jobs.check();
        assert.equal(sent.length, 0);
      });
    });
  });
});
