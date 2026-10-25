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
import { splitPostback } from '../src/views.ts';
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
/**
 * A song as it is sent, with its card's picture as it is drawn: the album's cover, looked up while the song downloads (the
 * card's `better`), and the song's file waiting for that lookup before it is tagged (`after`).
 */
async function sent(replies: Reply[]): Promise<Reply[]> {
  return Promise.all(
    replies.map(async (reply) => {
      if (reply.kind === 'image') {
        const { better, ...card } = reply;
        const url = await better;
        return url ? { ...card, url } : card;
      }
      if (reply.kind === 'audio') {
        const { after, ...audio } = reply;
        assert.ok(after, 'its tags wait for its album to be looked up');
        return audio;
      }
      return reply;
    }),
  );
}
const textOf = (reply: Reply | undefined): TextReply => {
  assert.ok(reply && reply.kind === 'text', `expected a text reply, got ${JSON.stringify(reply)}`);
  return reply;
};
/** A menu's song lines. */
const songLines = (replies: Reply[]): string[] => replies.flatMap((reply) => (reply.kind === 'text' && reply.postback?.startsWith('play:') ? [reply.text] : []));
/** The postback of the line that starts with `text`. */
const lineOf = (replies: Reply[], text: string): string => {
  const line = replies.find((reply) => reply.kind === 'text' && reply.text.startsWith(text) && reply.postback);
  assert.ok(line?.kind === 'text', `no line "${text}" in ${JSON.stringify(texts(replies))}`);
  return line.postback!;
};
/** A 💿 line as the chat shows it, its number after the mark. */
const numbered = (replies: Reply[]): string[] =>
  replies.flatMap((reply) => (reply.kind === 'text' && reply.text ? [reply.number !== undefined && reply.text.startsWith('💿 ') ? `💿 ${reply.number}. ${reply.text.slice(3)}` : reply.number !== undefined ? `${reply.number}. ${reply.text}` : reply.text] : []));

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
      assert.deepEqual([asked.get('q'), asked.get('allowFemale'), asked.get('blockVideos'), asked.get('kidZone'), asked.get('k')], ['vnusni lipa', '0', '0', '0', '50']);
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

    test('an artist’s name is a menu; a 👍 on them opens their page: newest albums (one edition each), most played songs, and "… more"', async () => {
      const { say, tap, siteAsked } = setup();
      for (const words of ['search lipa', 'search lipa shmeltzer']) {
        const menu = await say(words);
        assert.equal(texts(menu)[0], `🎤 ${LIPA}`, words);
        assert.ok(!menu.some((reply) => reply.kind === 'audio'), 'nothing is opened or sent on its own');
      }
      const page = await tap(lineOf(await say('search lipa'), '🎤'));
      assert.deepEqual(numbered(page), [
        `🎤 ${LIPA} · 6 albums · 8 songs`,
        '💿 1. אלעזר ליפא׳לע · 2025 · 2 songs',
        '💿 2. Leap Of Faith · 2012 · single',
        '💿 3. A Poshiter Yid · 2008 · 4 songs',
        '💿 4. Hallel · 2006 · single',
        '💿 5. Lipa Baderech · 2003 · single',
        'Mizrach',
        'Hang Up The Phone',
        "Abaye Ve'rava - אביי ורבא",
        'Believe In A Miracle',
        'Shualim - שועלים',
        'Text "albums more" or "songs more" for 8 more, or an album\'s number for its songs.',
      ]);
      assert.equal(splitPostback(lineOf(page, '💿 אלעזר')).action, 'album:MPREb_eluzor', 'the original edition, not the Yinglish or the Hebrew one');
      assert.deepEqual(splitPostback(textOf(page.at(-1)).numbers![2]!.postback).action, 'album:MPREb_poshiteryid', 'an album’s number opens it');
      assert.deepEqual(texts(await say('more')), ['Text "albums more" or "songs more".']);
      // A song is listed even when its album is (the owner asked, 2026-10-20): "A Poshiter Yid" is album 3 and a song too.
      const songs = await say('songs more');
      assert.deepEqual(texts(songs), ['Kevodo', 'A Poshiter Yid', 'ונתנו', 'Text "albums more" for 8 more albums, or an album\'s number for its songs.']);
      assert.deepEqual(numbered(await say('albums more')), ['💿 6. Shema · 2000 · single', "Text an album's number for its songs."], 'the numbers go on from the page before');
      assert.deepEqual(texts(await say('songs more')), [`That's all the songs for "${LIPA}".`]);
      assert.deepEqual(siteAsked, [], 'music-table.com was not asked');
    });

    test('words that name one song put it in a menu with its album; a 👍 sends it with its album’s cover', async () => {
      const { say, tap, youTube } = setup();
      const menu = await say('search a poshiter yid');
      assert.deepEqual(numbered(menu), [`💿 1. A Poshiter Yid — ${LIPA} · 2008 · 4 songs`, `A Poshiter Yid — ${LIPA}`, "Text an album's number for its songs."]);
      assert.ok(!menu.some((reply) => reply.kind === 'audio'));
      const replies = await sent(await tap(lineOf(menu, 'A Poshiter Yid —')));
      assert.deepEqual(replies.slice(0, 2), [
        { kind: 'image', url: cover('MPREb_poshiteryid'), caption: { title: 'A Poshiter Yid', artist: LIPA } },
        { kind: 'audio', url: youTube.trackUrl('lipaposhite'), title: `${LIPA} — A Poshiter Yid` },
      ]);
      const kevodo = await say('search kevodo lipa');
      assert.deepEqual(songLines(kevodo), [`Kevodo — ${LIPA}`], 'the words name no artist, so the line says whose it is');
    });

    test('a Latin spelling finds a Hebrew title, and a song with no picture gets its album’s from the album’s page', async () => {
      const { say, tap, youTube } = setup();
      const menu = await say('search vnusni');
      assert.deepEqual(songLines(menu), [`ונתנו — ${LIPA}`]);
      const replies = await sent(await tap(lineOf(menu, 'ונתנו')));
      assert.deepEqual(replies, [
        { kind: 'image', url: cover('vnusni'), caption: { title: 'ונתנו', artist: LIPA } },
        { kind: 'audio', url: youTube.trackUrl('lipavnusni0'), title: `${LIPA} — ונתנו` },
      ]);
      assert.ok(search.requests.some((request) => request.startsWith('/album?id=MPREb_vnusnisingle')));
    });

    test('"elazar lipa\'le" finds the album with that Hebrew name, its editions as one line', async () => {
      const { say } = setup();
      const replies = await say("search elazar lipa'le");
      assert.deepEqual(numbered(replies), [`💿 1. אלעזר ליפא׳לע — ${LIPA} · 2025 · 2 songs`, "Text an album's number for its songs."]);
      assert.ok(!texts(replies).some((text) => text.includes('מי שברך')), "a song that has only Elazar's name in it is not what was asked for");
    });

    test('songs by several artists are one list, "Title — Artist", after their albums; nothing by a woman or an artist off Zemer’s list', async () => {
      const { say } = setup();
      const replies = await say('search shabbos');
      assert.deepEqual(numbered(replies), [
        '💿 1. Shabbos Classics — Shua Rose · 2024 · single',
        'Shabbos — Shua Rose',
        'Shabbos — Yoely Weiss',
        'שבת — Yoely Weiss',
        "Text an album's number for its songs.",
      ]);
      assert.equal(textOf(replies.at(-1)).chips?.length, 4);
    });

    test('Zemer answers any words with something, so only what fits counts: otherwise the catalog and music-table.com answer', async () => {
      const { say, siteAsked } = setup();
      const replies = await say('search lipa zzzq');
      assert.deepEqual(siteAsked, ['lipa zzzq']);
      assert.deepEqual(songLines(replies), ['Zzzq Song — Site Artist']);
      assert.equal(textOf((await say('search qqqq wwww'))[0]).text, 'No match for "qqqq wwww" on Zemer or music-table.com. Try the artist and title, or fewer words.');
    });

    test('when Zemer’s search can’t be reached, YouTube Music’s own search answers, held to the same list', async () => {
      search.failing = true;
      const { say, tap, notes, youTube } = setup();
      const menu = await say('search kevodo lipa');
      assert.deepEqual(songLines(menu), [`Kevodo — ${LIPA}`]);
      assert.equal((await tap(lineOf(menu, 'Kevodo'))).find((reply) => reply.kind === 'audio')?.url, youTube.trackUrl('lipakevodo0'));
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

    test('"album" and an artist lists their albums, newest first, one line for an album’s editions; "album" and a name lists that album', async () => {
      const { say } = setup();
      const listed = await say('album lipa');
      assert.deepEqual(numbered(listed), [
        '💿 1. אלעזר ליפא׳לע · 2025 · 2 songs',
        '💿 2. Leap Of Faith · 2012 · single',
        '💿 3. A Poshiter Yid · 2008 · 4 songs',
        '💿 4. Hallel · 2006 · single',
        '💿 5. Lipa Baderech · 2003 · single',
        'Text "albums more" for 8 more albums, or an album\'s number for its songs.',
      ]);
      assert.deepEqual(numbered(await say('albums more')), ['💿 6. Shema · 2000 · single', "Text an album's number for its songs."]);
      const one = await say('album a poshiter yid');
      assert.deepEqual(numbered(one), [`💿 1. A Poshiter Yid — ${LIPA} · 2008 · 4 songs`, "Text an album's number for its songs."]);
      assert.ok(!one.some((reply) => reply.kind === 'album'), 'nothing is sent on its own');
    });

    test('an album’s zip checks every song against Zemer’s list: a woman’s song is left out, a guest on the list stays', async () => {
      const { tap, catalog, youTube } = setup();
      const replies = await tap('zip:MPREb_poshiteryid');
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
      assert.equal(textOf((await tap('zip:MPREb_rina'))[0]).text, "I can't send that album: it has a female singer, which I don't send.");
    });

    test("an album opens into its songs, numbered as on the album, and its zip: a 👍 on a song (or its number) gets that song, on 📦 all of it", async () => {
      const { tap, catalog, youTube } = setup();
      for (const opened of ['tracks:MPREb_poshiteryid', 'album:MPREb_poshiteryid']) {
        const replies = await tap(opened);
        assert.deepEqual(
          replies.flatMap((reply) => (reply.kind === 'text' && reply.text ? [[reply.text, splitPostback(reply.postback ?? '').action.replace(/^view:\d+$/, 'view')]] : [])),
          [
            [`💿 A Poshiter Yid — ${LIPA} · 2008 · 4 songs`, 'view'],
            ['A Poshiter Yid', `play:${catalog.search('a poshiter yid lipa', 1)[0]!.id}`],
            ['Amen', `play:${catalog.search('amen', 1)[0]!.id}`],
            [`With A Guest — ${YOELY}`, `play:${catalog.search('with a guest', 1)[0]!.id}`],
            ['📦 All 3 songs as one zip', 'zip:MPREb_poshiteryid'],
            ['Tap 👍 on the songs you want, or text their numbers; 👍 📦 or text "zip" for all of it. (1 song left out: not on Zemer\'s list.)', 'view'],
          ],
          opened,
        );
        assert.deepEqual(numbersOf(replies).map(([n, text]) => [n, text]), [
          [1, 'A Poshiter Yid'],
          [2, 'Amen'],
          [3, `With A Guest — ${YOELY}`],
        ]);
        const closing = textOf(replies.at(-1));
        assert.deepEqual(closing.numbers?.map((entry) => entry.number), [1, 2, 3]);
        assert.equal(closing.chips?.length, 3, '"all" sends the three songs');
        assert.ok(!replies.some((reply) => reply.kind === 'album'), 'opening it sends nothing');
        // Nothing was checked or downloaded: a song is when it is picked.
        const amen = await tap(closing.numbers![1]!.postback);
        assert.equal(amen.find((reply) => reply.kind === 'audio')?.url, youTube.trackUrl('lipaamen000'));
      }
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
      const menu = await fresh.say('search a poshiter yid');
      const requests = search.requests.length;
      await fresh.tap(lineOf(menu, 'A Poshiter Yid —'));
      assert.ok(search.requests.slice(requests).some((request) => request.startsWith('/album?id=MPREb_poshiteryid')) || fresh.catalog.albumOf(fresh.youTube.trackUrl('lipaposhite'))?.number === 1, 'its album’s page was asked for');
      assert.deepEqual(fresh.catalog.albumOf(fresh.youTube.trackUrl('lipaposhite')), { id: 'MPREb_poshiteryid', title: 'A Poshiter Yid', artist: LIPA, number: 1, songs: 4, year: 2008 }, 'filled in when it was sent');
    });

    test('"zemer" asks Zemer alone, and says why when it has nothing', async () => {
      const { say, siteAsked } = setup();
      assert.deepEqual(songLines(await say('zemer kevodo lipa')), [`Kevodo — ${LIPA}`]);
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
      const { say, tap, youTube } = setup({ zemer: false });
      const menu = await say('search kevodo lipa');
      assert.equal((await tap(lineOf(menu, 'Kevodo'))).find((reply) => reply.kind === 'audio')?.url, youTube.trackUrl('lipakevodo0'));
      assert.deepEqual(search.requests, []);
    });
  });
});
