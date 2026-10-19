import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createBot, type TrackSource } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { catalogNaming } from '../src/library/naming.ts';
import { soundsLike } from '../src/sources/relevance.ts';
import { createYouTubeAlbumSource, createYouTubeMusicSource, gatedAudioCheck, YouTubeMusic, youTubeGate } from '../src/sources/youtube-music.ts';
import { createZemerFinder, tidyVideoTitle, ZemerError, ZemerSearch, zemerSearchFromEnv } from '../src/sources/zemer.ts';
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import type { Reply } from '../src/types.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { startMockZemerSearch, type MockZemerRelease, type MockZemerSearch, type MockZemerSong } from './helpers/mock-zemer-search.ts';
import { artistId, startMockYouTubeMusic, type MockYouTubeMusic } from './helpers/mock-youtube-music.ts';

const LIPA = 'Lipa Schmeltzer';
const YOELY = 'Yoely Weiss';
const SHUA = 'Shua Rose';
const ELAZAR = 'אלעזר קרדש';
const id = (name: string): string => artistId(name);
const cover = (name: string): string => `https://yt3.googleusercontent.com/${name}=w544-h544-l90-rj`;
/** The mark that keeps a Hebrew title running right to left; Zemer's titles come with it. */
const LRM = '‎';

const lipaSong = (videoId: string, title: string, playCount: number, extra: Partial<MockZemerSong> = {}): MockZemerSong => ({
  videoId,
  title,
  artist: LIPA,
  artistId: id(LIPA),
  playCount,
  durationSec: 240,
  thumbnail: cover(videoId),
  ...extra,
});

const SONGS: MockZemerSong[] = [
  lipaSong('lipamizrach', 'Mizrach', 4_400_000),
  lipaSong('lipahangup0', 'Hang Up The Phone', 591_000),
  lipaSong('lipaabaye00', "Abaye Ve'rava - אביי ורבא", 300_000),
  lipaSong('lipamiracle', 'Believe In A Miracle', 200_000),
  lipaSong('lipashualim', 'Shualim - שועלים', 100_000),
  lipaSong('lipakevodo0', 'Kevodo', 50_000, { album: { id: 'MPREb_leapoffaith', name: 'Leap Of Faith' } }),
  // The search sends no picture with a song; its album's comes from the albums found with it, or from the album's page.
  lipaSong('lipaposhite', 'A Poshiter Yid', 40_000, { album: { id: 'MPREb_poshiteryid', name: 'A Poshiter Yid' }, thumbnail: undefined }),
  lipaSong('lipavnusni0', `${LRM}ונתנו`, 30_000, { album: { id: 'MPREb_vnusnisingle', name: 'ונתנו' }, thumbnail: undefined, keywords: ['vnusni'] }),
  { videoId: 'lipaleiby00', title: `${LIPA} - Leiby Forever (Official Music Video)`, artist: LIPA, artistId: id(LIPA), video: true },
  { videoId: 'shuashabbos', title: 'Shabbos', artist: SHUA, artistId: id(SHUA), album: { id: 'MPREb_shuashabbos', name: 'Shabbos' } },
  { videoId: 'yoelyshabbo', title: 'Shabbos', artist: YOELY, artistId: id(YOELY) },
  { videoId: 'yoelyshabat', title: 'שבת', artist: YOELY, artistId: id(YOELY), keywords: ['shabbos'] },
  { videoId: 'elazarmisheb', title: 'מי שברך', artist: ELAZAR, artistId: id(ELAZAR), keywords: ['elazar'] },
  // Zemer's own list keeps these out; the copy of the list here must too, whatever the server sends.
  { videoId: 'rinashabbos', title: 'Shabbos Song', artist: 'Rina Cohen', artistId: id('Rina Cohen') },
  { videoId: 'strangeshab', title: 'Shabbos Stranger', artist: 'Stranger Band', artistId: id('Stranger Band') },
];

const lipaAlbum = (albumId: string, title: string, year: number, tracks: MockZemerRelease['tracks'], extra: Partial<MockZemerRelease> = {}): MockZemerRelease => ({
  id: albumId,
  title,
  artist: LIPA,
  artistId: id(LIPA),
  year,
  releaseDate: `${year}-06-01T00:00:00-07:00`,
  thumbnail: cover(albumId),
  tracks,
  ...extra,
});

const ELUZOR = ['elazar', 'lipale', 'lipa', 'le'];
const RELEASES: MockZemerRelease[] = [
  lipaAlbum('MPREb_eluzor', 'אלעזר ליפא׳לע', 2025, [{ videoId: 'eluzortrk01', title: `${LRM}שקויעך` }, { videoId: 'eluzortrk02', title: `${LRM}לאזן גיין` }], { keywords: ELUZOR }),
  lipaAlbum('MPREb_eluzoryinglish', 'אלעזר ליפא׳לע (Yinglish Version)', 2025, [{ videoId: 'eluzoryng01', title: 'Shkoyech' }], { keywords: ELUZOR, releaseDate: '2025-06-02T00:00:00-07:00' }),
  lipaAlbum('MPREb_eluzorhebrew', 'אלעזר ליפא׳לע - גרסה עברית', 2025, [{ videoId: 'eluzorheb01', title: 'שכויח' }], { keywords: ELUZOR, releaseDate: '2025-06-03T00:00:00-07:00' }),
  lipaAlbum('MPREb_leapoffaith', 'Leap Of Faith', 2012, [{ videoId: 'lipakevodo0', title: 'Kevodo' }]),
  lipaAlbum('MPREb_poshiteryid', 'A Poshiter Yid', 2008, [
    { videoId: 'lipaposhite', title: 'A Poshiter Yid' },
    { videoId: 'lipaamen000', title: 'Amen' },
    { videoId: 'lipaguest00', title: 'With A Guest', artist: YOELY },
    { videoId: 'lipawoman00', title: 'With A Woman', artist: 'Rina Cohen' },
  ]),
  lipaAlbum('MPREb_hallel', 'Hallel', 2006, [{ videoId: 'lipahallel0', title: 'Hallel' }]),
  lipaAlbum('MPREb_baderech', 'Lipa Baderech', 2003, [{ videoId: 'lipabadere0', title: 'Baderech' }]),
  lipaAlbum('MPREb_shema', 'Shema', 2000, [{ videoId: 'lipashema00', title: 'Shema' }]),
  // A single the search doesn't bring up by itself: the song's cover comes from its page.
  lipaAlbum('MPREb_vnusnisingle', 'ונתנו', 2026, [{ videoId: 'lipavnusni0', title: 'ונתנו' }], { type: 'single', thumbnail: cover('vnusni') }),
  { id: 'MPREb_shuashabbos', title: 'Shabbos Classics', artist: SHUA, artistId: id(SHUA), year: 2024, thumbnail: cover('shua'), tracks: [{ videoId: 'shuashabbos', title: 'Shabbos' }] },
  { id: 'MPREb_rina', title: 'Shabbos With Rina', artist: 'Rina Cohen', artistId: id('Rina Cohen'), year: 2020, tracks: [{ videoId: 'rinashabbos', title: 'Shabbos Song' }] },
];

const ZEMER_ARTISTS = [LIPA, YOELY, SHUA, ELAZAR, 'Rina Cohen', 'Stranger Band'].map((name) => ({ id: id(name), name }));
const LISTED: MockArtist[] = [
  { id: id(LIPA), name: LIPA },
  { id: id(YOELY), name: YOELY },
  { id: id(SHUA), name: SHUA },
  { id: id(ELAZAR), name: ELAZAR, altName: 'Elazar Kardash' },
  { id: id('Rina Cohen'), name: 'Rina Cohen', female: true },
];

type TextReply = Extract<Reply, { kind: 'text' }>;
const texts = (replies: Reply[]): string[] => replies.flatMap((reply) => (reply.kind === 'text' && reply.text ? [reply.text] : []));
const picks = (replies: Reply[]): Array<[string, string]> => replies.flatMap((reply) => (reply.kind === 'text' && reply.postback ? [[reply.text, reply.postback] as [string, string]] : []));
/** The numbered lines of a list, with their numbers. */
const numbersOf = (replies: Reply[]): Array<[number, string]> => replies.flatMap((reply) => (reply.kind === 'text' && reply.number !== undefined ? [[reply.number, reply.text] as [number, string]] : []));
const textOf = (reply: Reply | undefined): TextReply => {
  assert.ok(reply && reply.kind === 'text', `expected a text reply, got ${JSON.stringify(reply)}`);
  return reply;
};

describe('Zemer', () => {
  let search: MockZemerSearch;
  let content: MockZemerContent;
  let youtube: MockYouTubeMusic;
  before(async () => {
    search = await startMockZemerSearch({ artists: ZEMER_ARTISTS, songs: SONGS, releases: RELEASES });
    content = await startMockZemerContent(LISTED);
    // YouTube Music's own search, for when Zemer's can't be reached, knows one of the songs.
    youtube = await startMockYouTubeMusic([{ videoId: 'lipakevodo0', title: 'Kevodo', artists: [LIPA], duration: '4:11' }]);
  });
  after(async () => {
    await search.close();
    await content.close();
    await youtube.close();
  });
  beforeEach(() => {
    search.reset();
    content.reset(LISTED);
    youtube.reset();
  });

  describe('its search service', () => {
    const client = () => new ZemerSearch({ baseUrl: search.url });

    test('every request says to leave out female singers; what it finds comes sorted into kinds, without the marks Hebrew titles carry', async () => {
      const found = await client().search('vnusni lipa');
      const asked = new URL(search.url + search.requests[0]!).searchParams;
      assert.deepEqual([asked.get('q'), asked.get('allowFemale'), asked.get('blockVideos'), asked.get('kidZone'), asked.get('k')], ['vnusni lipa', '0', '0', '0', '20']);
      assert.ok(found.songs.some((song) => song.title === 'ונתנו'), 'the invisible mark is gone');
      assert.ok(found.videos.some((song) => song.videoId === 'lipaleiby00'));
      assert.deepEqual(found.artists.map((artist) => artist.name), [LIPA]);
      const album = found.albums.find((release) => release.id === 'MPREb_poshiteryid');
      assert.deepEqual(album, { id: 'MPREb_poshiteryid', title: 'A Poshiter Yid', artist: LIPA, artistId: id(LIPA), year: 2008, released: '2008-06-01T00:00:00-07:00', cover: cover('MPREb_poshiteryid'), songs: 4, single: false });
    });

    test('an artist or an album it does not have is undefined, and an id that is not one is not even asked for', async () => {
      const zemer = client();
      assert.equal(await zemer.artist('UC_Nobody'), undefined);
      assert.equal(await zemer.album('MPREb_nothing'), undefined);
      assert.equal(await zemer.album('not an id!'), undefined);
      assert.equal(search.requests.length, 2);
    });

    test('an artist’s page is asked for once in a while, not on every "more"; their songs are theirs', async () => {
      const zemer = client();
      const page = await zemer.artist(id(LIPA));
      await zemer.artist(id(LIPA));
      assert.equal(search.requests.length, 1);
      assert.ok(page!.songs.every((song) => song.artist === LIPA && song.artistId === id(LIPA)));
      assert.equal(page!.singles.length, 1);
    });

    test('a server error is a ZemerError in words fit for the chat', async () => {
      search.failing = true;
      await assert.rejects(client().search('lipa'), (err) => err instanceof ZemerError && err.message === "Zemer's search answered HTTP 500");
      await assert.rejects(new ZemerSearch({ baseUrl: 'http://127.0.0.1:9' }).search('lipa'), (err) => err instanceof ZemerError && /didn't answer/.test(err.message));
    });

    test('ZEMER_SEARCH=off turns it off; ZEMER_SEARCH_URL points it elsewhere', () => {
      assert.equal(zemerSearchFromEnv({ ZEMER_SEARCH: 'off' }), undefined);
      assert.equal(zemerSearchFromEnv({ ZEMER_SEARCH_URL: 'http://127.0.0.1:1/' })!.baseUrl, 'http://127.0.0.1:1');
      assert.equal(zemerSearchFromEnv({})!.baseUrl, 'https://search.zemer.io');
    });

    test('a video’s title loses its artist in front and what kind of video it is', () => {
      assert.equal(tidyVideoTitle(`${LIPA} - Leiby Forever (Official Music Video)`, LIPA), 'Leiby Forever');
      assert.equal(tidyVideoTitle("V’Nusni - ונתנו by Lipa Schmeltzer (Offical Audio)", LIPA), "V’Nusni - ונתנו by Lipa Schmeltzer");
      assert.equal(tidyVideoTitle('Hang Up The Phone [Official Video]', LIPA), 'Hang Up The Phone');
      assert.equal(tidyVideoTitle('Someone Else - A Song', LIPA), 'Someone Else - A Song', 'only the artist’s own name is taken off');
    });
  });

  test('a Latin spelling is read against Hebrew letters', () => {
    assert.ok(soundsLike('vnusni', 'ונתנו'));
    assert.ok(soundsLike('elazar', 'אלעזר'));
    assert.ok(soundsLike('lipale', 'ליפא׳לע'));
    assert.ok(soundsLike('shabbos', 'שבת') && soundsLike('shabbat', 'שבת'));
    assert.ok(soundsLike('weiss', 'ווייס'));
    assert.ok(!soundsLike('shabbos', 'שלום'));
    assert.ok(!soundsLike('vnusni', 'נתנו'), 'every letter must be read');
    assert.ok(!soundsLike('elazar', 'אלעזר kardash'), 'only a word all in Hebrew letters');
  });

  describe('as the first place a search looks', () => {
    function setup(options: { zemer?: boolean; youTube?: YouTubeMusic } = {}) {
      const catalog = new Catalog(':memory:');
      const youTube = options.youTube ?? new YouTubeMusic({ baseUrl: youtube.url });
      const whitelist = new ZemerWhitelist({ baseUrl: content.url, state: catalog, checkEveryMs: 0, retryAfterMs: 0 });
      const notes: string[] = [];
      const finder = createZemerFinder({
        zemer: options.zemer === false ? undefined : new ZemerSearch({ baseUrl: search.url }),
        youTube,
        catalog,
        whitelist,
        fallback: { songs: createYouTubeMusicSource({ youTube, catalog, whitelist }), albums: createYouTubeAlbumSource({ youTube, catalog, whitelist }) },
        onNote: (note) => notes.push(note),
      });
      const siteAsked: string[] = [];
      const site: TrackSource = {
        name: 'music-table.com',
        async lookup(query) {
          siteAsked.push(query);
          return /zzzq/.test(query) ? [catalog.add({ title: 'Zzzq Song', artist: 'Site Artist', url: 'https://www.music-table.com/post/zzzq-song#0' })] : [];
        },
      };
      const bot = createBot({
        catalog,
        checkAudio: gatedAudioCheck(youTubeGate({ youTube, whitelist, catalog }), async () => ({ ok: true, type: 'audio/mp4', bytes: 1000 })),
        finder,
        albums: finder.albums,
        source: site,
      });
      return {
        catalog,
        youTube,
        notes,
        siteAsked,
        say: (text: string) => bot.handle({ from: 'u', messageId: 'm', text }),
        tap: (postback: string) => bot.handle({ from: 'u', messageId: 'm', postback }),
      };
    }

    test('an artist’s name opens their page: most played songs, newest albums (one edition each), and "more" for the rest', async () => {
      const { say, siteAsked } = setup();
      for (const words of ['search lipa', 'search lipa shmeltzer']) {
        const page = await say(words);
        assert.deepEqual(texts(page), [
          `🎤 ${LIPA}\n8 albums · 1 single · 8 songs`,
          'Mizrach',
          'Hang Up The Phone',
          "Abaye Ve'rava - אביי ורבא",
          'Believe In A Miracle',
          'Shualim - שועלים',
          '💿 אלעזר ליפא׳לע · 2025 · 2 songs',
          '💿 Leap Of Faith · 2012 · single',
          '💿 A Poshiter Yid · 2008 · 4 songs',
          '💿 Hallel · 2006 · single',
          '💿 Lipa Baderech · 2003 · single',
          `Text an album's number to choose from its songs, or "more" for more of ${LIPA}.`,
        ], words);
        assert.equal(picks(page)[5]![1], 'album:MPREb_eluzor', 'the original edition, not the Yinglish or the Hebrew one');
        // The albums are numbered: texting a number lists that album's songs.
        assert.deepEqual(numbersOf(page), [[1, '💿 אלעזר ליפא׳לע · 2025 · 2 songs'], [2, '💿 Leap Of Faith · 2012 · single'], [3, '💿 A Poshiter Yid · 2008 · 4 songs'], [4, '💿 Hallel · 2006 · single'], [5, '💿 Lipa Baderech · 2003 · single']]);
        assert.deepEqual(textOf(page.at(-1)).numbers?.[2], { number: 3, postback: 'tracks:MPREb_poshiteryid' });
      }
      const more = await say('more');
      // The song "A Poshiter Yid" is on the album of that name (number 3), so it is there, not listed as if it were a single.
      assert.deepEqual(texts(more), [`🎤 ${LIPA}, continued`, 'Kevodo', 'ונתנו', '💿 Shema · 2000 · single', "Text an album's number to choose from its songs."]);
      assert.deepEqual(numbersOf(more), [[6, '💿 Shema · 2000 · single']], 'the numbers go on from the page before');
      assert.equal(textOf(more.at(-1)).numbers?.length, 6, "the first page's albums still answer their numbers");
      assert.deepEqual(texts(await say('more')), [`That's all of ${LIPA}.`]);
      assert.match(texts(await say('more'))[0]!, /^Text "search" and an artist first/);
      assert.deepEqual(siteAsked, [], 'music-table.com was not asked');
    });

    test('words that name one song send it at once, with its album’s cover, and the album under it when they name that too', async () => {
      const { say, tap, youTube } = setup();
      const replies = await say('search a poshiter yid');
      assert.deepEqual(replies.slice(0, 2), [
        { kind: 'image', url: cover('MPREb_poshiteryid'), caption: { title: 'A Poshiter Yid', artist: LIPA } },
        { kind: 'audio', url: youTube.trackUrl('lipaposhite'), title: `${LIPA} — A Poshiter Yid` },
      ]);
      assert.deepEqual(picks(replies), [['💿 A Poshiter Yid · 2008 · 4 songs', 'album:MPREb_poshiteryid']]);
      const kevodo = await say('search kevodo lipa');
      assert.equal(kevodo.find((reply) => reply.kind === 'audio')?.url, youTube.trackUrl('lipakevodo0'));
      assert.equal(picks(kevodo).length, 0, 'no album note when the words name no album');
      // Played again from the list later, it is the same song from the catalog.
      assert.ok(await tap(`play:${replies.length}`));
    });

    test('a Latin spelling finds a Hebrew title, and a song with no picture gets its album’s from the album’s page', async () => {
      const { say, youTube } = setup();
      const replies = await say('search vnusni');
      assert.deepEqual(replies, [
        { kind: 'image', url: cover('vnusni'), caption: { title: 'ונתנו', artist: LIPA } },
        { kind: 'audio', url: youTube.trackUrl('lipavnusni0'), title: `${LIPA} — ונתנו` },
      ]);
      assert.ok(search.requests.some((request) => request.startsWith('/album?id=MPREb_vnusnisingle')));
    });

    test('"elazar lipa\'le" finds the album with that Hebrew name: the one it names first, then its other editions', async () => {
      const { say } = setup();
      const replies = await say("search elazar lipa'le");
      assert.deepEqual(texts(replies), [
        `🎤 ${LIPA}`,
        '💿 אלעזר ליפא׳לע · 2025 · 2 songs',
        '💿 אלעזר ליפא׳לע (Yinglish Version) · 2025 · single',
        '💿 אלעזר ליפא׳לע - גרסה עברית · 2025 · single',
        "Text an album's number to choose from its songs.",
      ]);
      assert.ok(!texts(replies).some((text) => text.includes('מי שברך')), "a song that has only Elazar's name in it is not what was asked for");
    });

    test('songs by several artists are one list, "Title — Artist", then their albums; nothing by a woman or an artist off Zemer’s list', async () => {
      const { say } = setup();
      const replies = await say('search shabbos');
      assert.deepEqual(texts(replies), [
        'Shabbos — Shua Rose',
        'Shabbos — Yoely Weiss',
        'שבת — Yoely Weiss',
        '💿 Shabbos Classics — Shua Rose · 2024 · single',
        "Text an album's number to choose from its songs.",
      ]);
      assert.equal(textOf(replies.at(-1)).chips?.length, 4);
    });

    test('Zemer answers any words with something, so only what fits counts: otherwise the catalog and music-table.com answer', async () => {
      const { say, siteAsked } = setup();
      const replies = await say('search lipa zzzq');
      assert.deepEqual(siteAsked, ['lipa zzzq']);
      assert.equal(replies.find((reply) => reply.kind === 'audio')?.url, 'https://www.music-table.com/post/zzzq-song#0');
      assert.equal(textOf((await say('search qqqq wwww'))[0]).text, 'No match for "qqqq wwww" on Zemer or music-table.com. Try the artist and title, or fewer words.');
    });

    test('when Zemer’s search can’t be reached, YouTube Music’s own search answers, held to the same list', async () => {
      search.failing = true;
      const { say, notes, youTube } = setup();
      const replies = await say('search kevodo lipa');
      assert.equal(replies.find((reply) => reply.kind === 'audio')?.url, youTube.trackUrl('lipakevodo0'));
      assert.ok(notes.some((note) => /Zemer's search answered HTTP 500; asking YouTube Music's own search instead/.test(note)), notes.join(' | '));
      youtube.failSearch = true;
      assert.equal(
        textOf((await say('zemer kevodo lipa'))[0]).text,
        "I couldn't search Zemer right now: Zemer's search answered HTTP 500, and YouTube Music answered HTTP 500.",
      );
    });

    test('when YouTube turns this host away, a search goes to music-table.com, and "zemer" says why', async () => {
      const turned = new YouTubeMusic({ baseUrl: youtube.url });
      youtube.firstAcceptedVisitor = 99;
      await turned.checkStreams();
      const { say, siteAsked } = setup({ youTube: turned });
      await say('search lipa zzzq');
      assert.deepEqual(siteAsked, ['lipa zzzq']);
      assert.deepEqual(search.requests, [], 'Zemer was not asked for songs that could not be sent');
      assert.match(textOf((await say('zemer lipa'))[0]).text, /^I couldn't search Zemer right now: YouTube Music is turning this server away/);
    });

    test('"album" and an artist lists every album of theirs, newest first; "album" and a name sends that album', async () => {
      const { say } = setup();
      const listed = await say('album lipa');
      assert.deepEqual(texts(listed), [
        `🎤 ${LIPA} · 8 albums, newest first`,
        '💿 אלעזר ליפא׳לע - גרסה עברית · 2025 · single',
        '💿 אלעזר ליפא׳לע (Yinglish Version) · 2025 · single',
        '💿 אלעזר ליפא׳לע · 2025 · 2 songs',
        '💿 Leap Of Faith · 2012 · single',
        '💿 A Poshiter Yid · 2008 · 4 songs',
        '💿 Hallel · 2006 · single',
        '💿 Lipa Baderech · 2003 · single',
        '💿 Shema · 2000 · single',
        "Text an album's number to choose from its songs.",
      ]);
      assert.deepEqual(
        numbersOf(listed).map(([n]) => n),
        [1, 2, 3, 4, 5, 6, 7, 8],
      );
      const sent = await say('album a poshiter yid');
      const album = sent.find((reply) => reply.kind === 'album');
      assert.equal(album?.kind === 'album' && album.title, 'A Poshiter Yid');
    });

    test('opening an album checks every song against Zemer’s list: a woman’s song is left out, a guest on the list stays', async () => {
      const { tap, catalog, youTube } = setup();
      const replies = await tap('album:MPREb_poshiteryid');
      assert.deepEqual(replies[0], { kind: 'image', url: cover('MPREb_poshiteryid'), caption: { title: 'A Poshiter Yid', artist: LIPA } });
      assert.equal(textOf(replies[1]).text, '3 songs, coming as a zip (1 left out).');
      const album = replies[2];
      assert.ok(album?.kind === 'album');
      assert.deepEqual(album.songs.map((song) => [song.number, song.title]), [
        [1, 'A Poshiter Yid'],
        [2, 'Amen'],
        [3, 'With A Guest'],
      ]);
      assert.deepEqual(catalog.artistIdsOf(youTube.trackUrl('lipaguest00')), [id(YOELY)], 'the guest is checked as themself');
      assert.equal(textOf((await tap('album:MPREb_rina'))[0]).text, "I can't send that album: it has a female singer, which I don't send.");
    });

    test('an album\'s number lists its songs, numbered as on the album: a 👍 on the album gets its zip, on a song (or its number) that song', async () => {
      const { tap, catalog, youTube } = setup();
      const replies = await tap('tracks:MPREb_poshiteryid');
      assert.deepEqual(picks(replies), [
        [`💿 A Poshiter Yid — ${LIPA} · 2008 · 4 songs`, 'album:MPREb_poshiteryid'],
        ['A Poshiter Yid', `play:${catalog.search('a poshiter yid lipa', 1)[0]!.id}`],
        ['Amen', `play:${catalog.search('amen', 1)[0]!.id}`],
        [`With A Guest — ${YOELY}`, `play:${catalog.search('with a guest', 1)[0]!.id}`],
      ]);
      assert.deepEqual(numbersOf(replies).map(([n, text]) => [n, text]), [
        [1, 'A Poshiter Yid'],
        [2, 'Amen'],
        [3, `With A Guest — ${YOELY}`],
      ]);
      const closing = textOf(replies.at(-1));
      assert.equal(closing.text, "Tap 👍 on the songs you want, or on the album for all of it as a zip. (1 song left out: not on Zemer's list.)");
      assert.deepEqual(closing.numbers?.map((entry) => entry.number), [1, 2, 3]);
      assert.equal(closing.chips?.length, 3, '"all" sends the three songs');
      // Nothing was checked or downloaded: a song is when it is picked.
      const amen = await tap(closing.numbers![1]!.postback);
      assert.equal(amen.find((reply) => reply.kind === 'audio')?.url, youTube.trackUrl('lipaamen000'));
      assert.equal(textOf((await tap('tracks:MPREb_rina'))[0]).text, "I can't open that album: it has a female singer, which I don't send.");
    });

    test('a song keeps its album, so its file is tagged and filed by it: an opened album’s songs at once, a song sent alone from its album’s page', async () => {
      const { tap, catalog, youTube } = setup();
      await tap('album:MPREb_poshiteryid');
      assert.deepEqual(catalog.albumOf(youTube.trackUrl('lipaamen000')), { id: 'MPREb_poshiteryid', title: 'A Poshiter Yid', artist: LIPA, number: 2, songs: 4, year: 2008 });
      const naming = catalogNaming(catalog);
      const m4a = { fileName: 'x.m4a', mimeType: 'audio/mp4' };
      assert.equal(naming.placeOf(youTube.trackUrl('lipaguest00'), m4a), `${LIPA}/A Poshiter Yid/03 With A Guest.m4a`);
      assert.deepEqual(naming.tagsOf(youTube.trackUrl('lipaguest00'), m4a), {
        title: 'With A Guest',
        artist: YOELY,
        albumArtist: LIPA,
        album: 'A Poshiter Yid',
        track: '3/4',
        year: '2008',
        cover: cover('MPREb_poshiteryid'),
      });

      // Found by a search, a song knows its album but not its number on it, until it is sent.
      const fresh = setup();
      await fresh.say('search shabbos');
      const shua = fresh.youTube.trackUrl('shuashabbos');
      assert.deepEqual(fresh.catalog.albumOf(shua), { id: 'MPREb_shuashabbos', title: 'Shabbos Classics', artist: SHUA, number: 1, songs: 1, year: 2024 }, 'a one-song release is a single: song 1 of 1');
      const requests = search.requests.length;
      await fresh.say('search a poshiter yid');
      assert.ok(search.requests.slice(requests).some((request) => request.startsWith('/album?id=MPREb_poshiteryid')), 'its album’s page was asked for');
      assert.deepEqual(fresh.catalog.albumOf(fresh.youTube.trackUrl('lipaposhite')), { id: 'MPREb_poshiteryid', title: 'A Poshiter Yid', artist: LIPA, number: 1, songs: 4, year: 2008 }, 'filled in when it was sent');
    });

    test('"zemer" asks Zemer alone, and says why when it has nothing', async () => {
      const { say, siteAsked } = setup();
      assert.ok((await say('zemer kevodo lipa')).some((reply) => reply.kind === 'audio'));
      assert.equal(textOf((await say('zemer lipa zzzq'))[0]).text, 'No match for "lipa zzzq" on Zemer (it only has artists on Zemer\'s list). Try the artist and title, or fewer words.');
      assert.deepEqual(siteAsked, []);
    });

    test('a song found on Zemer is checked against the list again when it is sent', async () => {
      const { say, tap, catalog, youTube } = setup();
      await say('search shabbos');
      const song = catalog.search('shabbos shua rose', 1)[0]!;
      assert.equal(song.url, youTube.trackUrl('shuashabbos'));
      assert.deepEqual(catalog.artistIdsOf(song.url), [id(SHUA)]);
      content.publish((_artists, blocked) => blocked.global.push('shuashabbos'));
      assert.equal(textOf((await tap(`play:${song.id}`))[0]).text, `I can't send "${SHUA} — Shabbos": Zemer's list blocks that song.`);
    });

    test('with Zemer’s search off, YouTube Music’s own search is used', async () => {
      const { say, youTube } = setup({ zemer: false });
      assert.equal((await say('search kevodo lipa')).find((reply) => reply.kind === 'audio')?.url, youTube.trackUrl('lipakevodo0'));
      assert.deepEqual(search.requests, []);
    });
  });
});
