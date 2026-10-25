import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { checkAudio } from '../src/audio-check.ts';
import { fetchAudio } from '../src/audio-fetch.ts';
import { createBot, SourceError, type AlbumSource } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { createRunner } from '../src/runner.ts';
import {
  createYouTubeAlbumSource,
  createYouTubeMusicSource,
  gatedAudioCheck,
  parseAlbumPage,
  parseAlbumSearch,
  resolvingYouTubeAudio,
  YouTubeMusic,
  YouTubeMusicError,
  youTubeGate,
} from '../src/sources/youtube-music.ts';
import { createZemerFinder } from '../src/sources/zemer.ts';
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import type { Reply } from '../src/types.ts';
import { splitPostback } from '../src/views.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';
import { readZip } from './helpers/read-zip.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { artistId, startMockYouTubeMusic, type MockAlbum, type MockSong, type MockYouTubeMusic } from './helpers/mock-youtube-music.ts';

const MICHOEL = 'Michoel Schnitzler';
const OWLS = 'The Night Owls';

const ALBUMS: MockAlbum[] = [
  {
    browseId: 'MPREb_shabbuson01',
    title: 'Shabbuson',
    artists: [MICHOEL],
    year: 2022,
    tracks: [
      { videoId: 'albumsong01', title: 'Opening' },
      { videoId: 'albumsong02', title: 'הנחת תפילין' },
      { videoId: 'albumsong03', title: 'Duet With A Guest', artists: [MICHOEL, 'Rina Cohen'] },
      { title: 'Greyed Out' },
      { videoId: 'albumsong04', title: 'Closing' },
    ],
  },
  { browseId: 'MPREb_shabbuson02', title: 'Shabbuson Live', artists: [MICHOEL], year: 2023, tracks: [{ videoId: 'albumsong05', title: 'Live Opening' }] },
  {
    browseId: 'MPREb_nightsongs3',
    title: 'Night Songs',
    artists: [OWLS],
    year: 2021,
    firstPage: 2,
    tracks: [
      { videoId: 'nightsong001', title: 'One' },
      { videoId: 'nightsong002', title: 'Two' },
      { videoId: 'nightsong003', title: 'Three' },
    ].map((track) => ({ ...track, videoId: track.videoId.slice(0, 11) })),
  },
  { browseId: 'MPREb_heralbum04', title: 'Her Album', artists: ['Rina Cohen'], year: 2020, tracks: [{ videoId: 'albumsong06', title: 'Hers' }] },
  { browseId: 'MPREb_strangers05', title: 'Strangers', artists: ['Nobody Known'], year: 2019, tracks: [{ videoId: 'albumsong07', title: 'Theirs' }] },
];

/** Every playable song on those albums is also a video the player knows. */
const SONGS: MockSong[] = [
  ...ALBUMS.flatMap((album) => album.tracks.flatMap((track) => (track.videoId ? [{ videoId: track.videoId, title: track.title, artists: track.artists ?? album.artists }] : []))),
  { videoId: 'aaaaaaaaaa1', title: 'Blue Horizon', artists: [OWLS], duration: '3:05' },
  { videoId: 'nightsongs1', title: 'Night Songs', artists: [OWLS], duration: '3:30' },
];

const LISTED: MockArtist[] = [
  ...[MICHOEL, OWLS].map((name) => ({ id: artistId(name), name })),
  { id: artistId('Rina Cohen'), name: 'Rina Cohen', female: true },
];

type TextReply = Extract<Reply, { kind: 'text' }>;
type AlbumReply = Extract<Reply, { kind: 'album' }>;
const textOf = (reply: Reply | undefined): TextReply => {
  assert.ok(reply && reply.kind === 'text', `expected a text reply, got ${JSON.stringify(reply)}`);
  return reply;
};
const albumOf = (replies: Reply[]): AlbumReply => {
  const found = replies.find((reply): reply is AlbumReply => reply.kind === 'album');
  assert.ok(found, `expected an album reply in ${JSON.stringify(replies)}`);
  return found;
};

describe('albums on YouTube Music', () => {
  let youtube: MockYouTubeMusic;
  let zemer: MockZemerContent;
  before(async () => {
    youtube = await startMockYouTubeMusic(SONGS, ALBUMS);
    zemer = await startMockZemerContent(LISTED);
  });
  after(async () => {
    await youtube.close();
    await zemer.close();
  });
  beforeEach(() => {
    youtube.reset();
    zemer.reset(LISTED);
  });

  const client = () => new YouTubeMusic({ baseUrl: youtube.url });

  test('lists albums with their artists, year and a larger cover', async () => {
    const hits = await client().searchAlbums('michoel schnitzler');
    assert.deepEqual(hits.map((hit) => [hit.browseId, hit.title, hit.artist, hit.year]), [
      ['MPREb_shabbuson01', 'Shabbuson', MICHOEL, 2022],
      ['MPREb_shabbuson02', 'Shabbuson Live', MICHOEL, 2023],
    ]);
    assert.deepEqual(hits[0]!.artistIds, [artistId(MICHOEL)]);
    assert.equal(hits[0]!.cover, 'https://lh3.googleusercontent.com/MPREb_shabbuson01=w544-h544-l90-rj');
    assert.deepEqual(parseAlbumSearch({}), []);
    assert.deepEqual(parseAlbumSearch(null), []);
  });

  test('reads an album page: its artists, year and cover, every playable song in order, each by the album’s artists unless it names its own', async () => {
    const page = await client().album('MPREb_shabbuson01');
    assert.deepEqual([page.title, page.artist, page.year], ['Shabbuson', MICHOEL, 2022]);
    assert.equal(page.cover, 'https://lh3.googleusercontent.com/MPREb_shabbuson01=w544-h544-l90-rj');
    assert.deepEqual(page.tracks.map((track) => [track.number, track.title]), [
      [1, 'Opening'],
      [2, 'הנחת תפילין'],
      [3, 'Duet With A Guest'],
      [5, 'Closing'],
    ]);
    assert.deepEqual(page.tracks[0]!.artistIds, [artistId(MICHOEL)], 'the album’s artists stand in');
    assert.deepEqual(page.tracks[2]!.artistIds, [artistId(MICHOEL), artistId('Rina Cohen')]);
    assert.equal(parseAlbumPage({}, 'MPREb_shabbuson01'), undefined);
  });

  test('follows an album’s continuation to the rest of its songs', async () => {
    const page = await client().album('MPREb_nightsongs3');
    assert.deepEqual(page.tracks.map((track) => [track.number, track.title]), [
      [1, 'One'],
      [2, 'Two'],
      [3, 'Three'],
    ]);
    assert.deepEqual(youtube.browses, ['MPREb_nightsongs3', 'continuation']);
  });

  test('refuses an address that is not an album without asking YouTube, and says so when the album is not there', async () => {
    await assert.rejects(client().album('../etc/passwd'), YouTubeMusicError);
    await assert.rejects(client().album('MPREb_doesnotexist'), /HTTP 404/);
    assert.deepEqual(youtube.browses, ['MPREb_doesnotexist']);
  });

  describe('as a source', () => {
    function setup() {
      const catalog = new Catalog(':memory:');
      const youTube = client();
      const whitelist = new ZemerWhitelist({ baseUrl: zemer.url, state: catalog, checkEveryMs: 0, retryAfterMs: 0 });
      const notes: string[] = [];
      return { catalog, youTube, whitelist, notes, albums: createYouTubeAlbumSource({ youTube, catalog, whitelist, onNote: (note) => notes.push(note) }) };
    }

    test('offers only albums by artists on Zemer’s list, never a woman’s or a stranger’s', async () => {
      const { albums, notes } = setup();
      assert.deepEqual((await albums.search('shabbuson her album strangers night songs', 10)).map((album) => album.title).sort(), ['Night Songs', 'Shabbuson', 'Shabbuson Live']);
      assert.match(notes[0]!, /listed 5 albums; 3 by artists on Zemer's list, none female/);
      assert.deepEqual(await albums.search('her album', 10), []);
      assert.deepEqual(await albums.search('   ', 10), []);
    });

    test('opens an album into the songs that may be sent, keeps them in the catalog with their artists, and counts those left out', async () => {
      const { albums, catalog, notes, youTube } = setup();
      const opened = await albums.open('MPREb_shabbuson01');
      assert.deepEqual(opened.album, { id: 'MPREb_shabbuson01', title: 'Shabbuson', artist: MICHOEL, year: 2022, cover: 'https://lh3.googleusercontent.com/MPREb_shabbuson01=w544-h544-l90-rj' });
      assert.deepEqual(opened.songs.map((song) => [song.number, song.track.title]), [
        [1, 'Opening'],
        [2, 'הנחת תפילין'],
        [5, 'Closing'],
      ]);
      assert.equal(opened.leftOut, 1, 'the song with a woman credited is left out');
      assert.deepEqual(catalog.artistIdsOf(youTube.trackUrl('albumsong01')), [artistId(MICHOEL)]);
      assert.equal(catalog.search('guest', 5).length, 0, 'the song that was left out is not kept');
      assert.match(notes.at(-1)!, /4 songs, 3 may be sent, 1 left out by Zemer's list/);
    });

    test('names the reason when a whole album may not be sent', async () => {
      const { albums } = setup();
      await assert.rejects(albums.open('MPREb_heralbum04'), (err) => err instanceof SourceError && err.message === "it has a female singer, which I don't send");
      await assert.rejects(albums.open('MPREb_strangers05'), (err) => err instanceof SourceError && err.message === "its artist isn't on Zemer's artist list");
      zemer.blocked = { global: ['MPREb_shabbuson02'], female: [] };
      const blocked = setup().albums;
      await assert.rejects(blocked.open('MPREb_shabbuson02'), (err) => err instanceof SourceError && err.message === "Zemer's list blocks that album");
      await assert.rejects(albums.open('nonsense'), YouTubeMusicError);
    });

    test('says so when none of an album’s songs may be sent', async () => {
      zemer.blocked = { global: ['albumsong05'], female: [] };
      await assert.rejects(setup().albums.open('MPREb_shabbuson02'), (err) => err instanceof SourceError && err.message === "none of its songs pass Zemer's list");
    });

    test('has no answer rather than an unfiltered one when there is no list', async () => {
      zemer.failing = new Set(['/whitelist/version']);
      const { albums } = setup();
      await assert.rejects(albums.search('shabbuson', 5), /Zemer's artist list answered HTTP 503/);
      assert.deepEqual(youtube.searches, [], 'YouTube Music was not even asked');
    });
  });

  describe('from the bot, with Zemer’s search off (YouTube Music’s own search instead)', () => {
    function setup(options: { albums?: boolean | AlbumSource; catalog?: Catalog } = {}) {
      const catalog = options.catalog ?? new Catalog(':memory:');
      const youTube = client();
      const whitelist = new ZemerWhitelist({ baseUrl: zemer.url, state: catalog, checkEveryMs: 0, retryAfterMs: 0 });
      const audio = resolvingYouTubeAudio(youTube, {
        checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }),
        fetchAudio: (url, title) => fetchAudio(url, title),
      });
      const albums = typeof options.albums === 'object' ? options.albums : createYouTubeAlbumSource({ youTube, catalog, whitelist });
      const finder = createZemerFinder({ zemer: undefined, youTube, catalog, whitelist, fallback: { songs: createYouTubeMusicSource({ youTube, catalog, whitelist }), albums } });
      const bot = createBot({
        catalog,
        checkAudio: gatedAudioCheck(youTubeGate({ youTube, whitelist, catalog }), audio.checkAudio),
        ...(options.albums === false ? {} : { finder, albums: finder.albums }),
      });
      return {
        catalog,
        youTube,
        audio,
        bot,
        say: (text: string) => bot.handle({ from: 'u', messageId: 'm1', text }),
        tap: (postback: string) => bot.handle({ from: 'u', messageId: 'm2', postback }),
      };
    }
    const lines = (replies: Reply[]): string[] => replies.filter((reply): reply is TextReply => reply.kind === 'text' && reply.postback !== undefined).map((reply) => reply.text);

    test('"album" and a name lists the albums, the one it names first; the album’s zip is its cover, one short line, then the album', async () => {
      const { say, tap, youTube } = setup();
      const menu = await say('album shabbuson');
      assert.deepEqual(lines(menu), [`💿 Shabbuson — ${MICHOEL} · 2022`, `💿 Shabbuson Live — ${MICHOEL} · 2023`, "Text an album's number for its songs."]);
      assert.equal(menu.some((reply) => reply.kind === 'album'), false, 'nothing is sent on its own');
      const replies = await tap('zip:MPREb_shabbuson01');
      assert.equal(replies.length, 3);
      assert.deepEqual(replies[0], { kind: 'image', url: 'https://lh3.googleusercontent.com/MPREb_shabbuson01=w544-h544-l90-rj', caption: { title: 'Shabbuson', artist: MICHOEL } });
      assert.equal(textOf(replies[1]).text, '3 songs, coming as a zip (1 left out).');
      assert.deepEqual(albumOf(replies), {
        kind: 'album',
        title: 'Shabbuson',
        artist: MICHOEL,
        songs: [
          { number: 1, title: 'Opening', url: youTube.trackUrl('albumsong01') },
          { number: 2, title: 'הנחת תפילין', url: youTube.trackUrl('albumsong02') },
          { number: 5, title: 'Closing', url: youTube.trackUrl('albumsong04') },
        ],
      });
    });

    test('several albums fit: "💿 Title — Artist · year" one message each, numbered; a 👍 on one opens it; "all" does not send every album', async () => {
      const { say, tap } = setup();
      const replies = await say('albums michoel schnitzler');
      assert.deepEqual(lines(replies), [`💿 Shabbuson Live — ${MICHOEL} · 2023`, `💿 Shabbuson — ${MICHOEL} · 2022`, "Text an album's number for its songs."]);
      const postbacks = replies.flatMap((reply) => (reply.kind === 'text' && reply.postback?.startsWith('album:') ? [reply.postback] : []));
      assert.deepEqual(
        postbacks.map((postback) => splitPostback(postback).action),
        ['album:MPREb_shabbuson02', 'album:MPREb_shabbuson01'],
      );
      // The list's chips ride on its last message, which says what an album's number does.
      assert.equal(textOf(replies.at(-1)).chips?.length, 2);
      assert.deepEqual(
        textOf(replies.at(-1)).numbers?.map((choice) => [choice.number, splitPostback(choice.postback).action]),
        [
          [1, 'album:MPREb_shabbuson02'],
          [2, 'album:MPREb_shabbuson01'],
        ],
      );
      const opened = await tap(postbacks[0]!);
      assert.equal(textOf(opened[0]).text, `💿 Shabbuson Live — ${MICHOEL} · 2023`);
      assert.equal(opened.some((reply) => reply.kind === 'album'), false);
      const all = await tap(`all:${postbacks.join('|')}`);
      assert.match(textOf(all[0]).text, /That list has no songs/);
      assert.equal(all.length, 1);
    });

    test('says what to do when nothing fits, when there is nothing to search for, and why a woman’s album is not there', async () => {
      const { say } = setup();
      assert.equal(textOf((await say('album zzzz'))[0]).text, 'No album for "zzzz" on Zemer (it only has artists on Zemer\'s list). Try the artist and the album\'s name, or fewer words.');
      assert.equal(textOf((await say('album her album'))[0]).text.startsWith('No album for "her album"'), true);
      assert.equal(textOf((await say('album'))[0]).text, 'Text "album" and an album or an artist, like "album a poshiter yid" or "album lipa".');
    });

    test('an album whose own page may not be sent is refused with the reason, opened or sent', async () => {
      const { tap } = setup();
      assert.equal(textOf((await tap('album:MPREb_heralbum04'))[0]).text, "I can't open that album: it has a female singer, which I don't send.");
      assert.equal(textOf((await tap('zip:MPREb_heralbum04'))[0]).text, "I can't send that album: it has a female singer, which I don't send.");
    });

    test('a song blocked after the album was opened stays out: each is checked again just before it goes', async () => {
      const { tap, youTube } = setup();
      const opened = await tap('zip:MPREb_shabbuson01');
      assert.equal(albumOf(opened).songs.length, 3);
      zemer.publish((_artists, blocked) => blocked.global.push('albumsong02'));
      const again = await tap('zip:MPREb_shabbuson01');
      assert.deepEqual(albumOf(again).songs.map((song) => song.url), [youTube.trackUrl('albumsong01'), youTube.trackUrl('albumsong04')]);
      assert.equal(textOf(again[1]).text, '2 songs, coming as a zip (2 left out).');
    });

    test('a search whose words name a song and an album lists both: the album (a 👍 opens it) and the song', async () => {
      const { say, tap } = setup();
      const replies = await say('search night songs');
      assert.deepEqual(lines(replies), [`💿 Night Songs — ${OWLS} · 2021`, `Night Songs — ${OWLS}`, "Text an album's number for its songs."]);
      assert.equal(replies.some((reply) => reply.kind === 'audio'), false);
      const album = replies.find((reply) => reply.kind === 'text' && reply.text.startsWith('💿'));
      assert.ok(album?.kind === 'text');
      assert.deepEqual(lines(await tap(album.postback!)).slice(1, 4), ['One', 'Two', 'Three']);
    });

    test('with no song by that name but an album, the albums are the answer, the one the words name first', async () => {
      const { say } = setup();
      const replies = await say('search shabbuson');
      assert.deepEqual(lines(replies), [`💿 Shabbuson — ${MICHOEL} · 2022`, `💿 Shabbuson Live — ${MICHOEL} · 2023`, "Text an album's number for its songs."]);
      assert.equal(textOf(replies.at(-1)).chips?.length, 2);
      assert.deepEqual(lines(await say('search shabbuson live')), [`💿 Shabbuson Live — ${MICHOEL} · 2023`, "Text an album's number for its songs."]);
    });

    test('an album the words name outright beats a song that only resembles them', async () => {
      // The catalog's looser search finds "Shabbuson Medley" for "shabbuson", but that is not what was asked for.
      const catalog = new Catalog(':memory:');
      catalog.add({ title: 'Shabbuson Medley', artist: OWLS, url: 'https://www.music-table.com/post/shabbuson-medley#0' });
      const { say } = setup({ catalog });
      const replies = await say('search shabbuson');
      assert.equal(lines(replies)[0], `💿 Shabbuson — ${MICHOEL} · 2022`);
      assert.equal(replies.some((reply) => reply.kind === 'audio'), false);
    });

    test('a search for an artist lists their albums, then their songs', async () => {
      const { say } = setup();
      const replies = await say('search michoel schnitzler');
      const shown = replies.flatMap((reply) => (reply.kind === 'text' && reply.text ? [reply.text] : []));
      const firstSong = shown.findIndex((text) => !text.startsWith('💿'));
      assert.deepEqual(shown.slice(0, firstSong), [`💿 Shabbuson Live — ${MICHOEL} · 2023`, `💿 Shabbuson — ${MICHOEL} · 2022`], 'albums first, newest first');
      assert.ok(shown.length - firstSong > 1, 'then songs');
      assert.ok(!shown.some((text) => text.includes('Guest')), 'nothing a woman is credited on');
    });

    test('an album by a woman, or by an artist not on Zemer’s list, is never mentioned', async () => {
      const { say } = setup();
      for (const query of ['her album', 'strangers']) {
        const replies = await say(`search ${query}`);
        assert.equal(replies.length, 1, query);
        assert.match(textOf(replies[0]).text, /^No match for/);
      }
    });

    test('an album lookup that fails never spoils the search for songs', async () => {
      const broken: AlbumSource = {
        name: 'YouTube Music',
        async search() {
          throw new SourceError('down');
        },
        async open() {
          throw new SourceError('down');
        },
      };
      const { say } = setup({ albums: broken });
      const replies = await say('search night songs');
      assert.ok(lines(replies).includes(`Night Songs — ${OWLS}`));
      assert.equal(replies.some((reply) => reply.kind === 'text' && reply.text.startsWith('💿')), false);
    });

    test('"zemer" lists a matching album too', async () => {
      const { say } = setup();
      const replies = await say('zemer night songs');
      assert.ok(lines(replies).includes(`💿 Night Songs — ${OWLS} · 2021`));
    });

    test('when YouTube turns this server away, an album request says so plainly', async () => {
      const { say, tap, youTube } = setup();
      youtube.firstAcceptedVisitor = 99;
      await youTube.checkStreams();
      assert.equal(textOf((await say('album shabbuson'))[0]).text, "I couldn't search Zemer right now: YouTube Music is turning this server away for now (it asks to confirm it isn't a bot).");
      assert.equal(textOf((await tap('album:MPREb_shabbuson01'))[0]).text, "I can't open that album: YouTube Music is turning this server away for now (it asks to confirm it isn't a bot).");
      assert.equal(textOf((await tap('zip:MPREb_shabbuson01'))[0]).text, "I can't send that album: YouTube Music is turning this server away for now (it asks to confirm it isn't a bot).");
    });

    test('with YouTube Music off there are no albums, and it says so', async () => {
      const { say } = setup({ albums: false });
      assert.match(textOf((await say('album shabbuson'))[0]).text, /Albums come from Zemer, which is turned off/);
    });

    test('"zemer" asks only Zemer, whatever the catalog holds, and "youtube", "yt" and "youtube music" mean the same', async () => {
      const catalog = new Catalog(':memory:');
      catalog.add({ title: 'Blue Horizon', artist: OWLS, url: 'https://www.music-table.com/post/blue-horizon#0' });
      const { bot, youTube } = setup({ catalog });
      for (const text of ['zemer blue horizon night owls', 'youtube blue horizon night owls', 'yt blue horizon night owls', 'youtube music blue horizon night owls', 'Youtub blue horizon night owls']) {
        const replies = await bot.handle({ from: 'u', messageId: 'm', text });
        const song = replies.find((reply) => reply.kind === 'text' && reply.postback?.startsWith('play:'));
        assert.ok(song?.kind === 'text' && song.text === `Blue Horizon — ${OWLS}`, text);
        const sent = await bot.handle({ from: 'u', messageId: 'm', postback: song.postback! });
        const audio = sent.at(-1);
        assert.ok(audio?.kind === 'audio');
        assert.deepEqual([audio.url, audio.title], [youTube.trackUrl('aaaaaaaaaa1'), `${OWLS} — Blue Horizon`], text);
      }
    });

    test('"zemer" says why nothing was found, and what is wrong when it can’t be searched', async () => {
      const { say } = setup();
      assert.equal(textOf((await say('zemer zzzz'))[0]).text, 'No match for "zzzz" on Zemer (it only has artists on Zemer\'s list). Try the artist and title, or fewer words.');
      assert.equal(textOf((await say('zemer'))[0]).text, 'Text "zemer" and a song or an artist, like "zemer lipa vnusni".');
      youtube.failSearch = true;
      assert.equal(textOf((await say('zemer blue horizon'))[0]).text, "I couldn't search Zemer right now: Zemer's search is turned off, and YouTube Music answered HTTP 500.");
      const off = createBot({ catalog: new Catalog(':memory:'), checkAudio: async () => ({ ok: true, type: 'audio/mp4' }) });
      assert.match(textOf((await off.handle({ from: 'u', messageId: 'm', text: 'zemer blue horizon' }))[0]).text, /Zemer is turned off/);
    });
  });
});

describe('sending an album as a zip', () => {
  let matrix: MockMatrix;
  let youtube: MockYouTubeMusic;
  let zemer: MockZemerContent;
  before(async () => {
    matrix = await startMockMatrix();
    youtube = await startMockYouTubeMusic(SONGS, ALBUMS);
    zemer = await startMockZemerContent(LISTED);
  });
  after(async () => {
    await matrix.close();
    await youtube.close();
    await zemer.close();
  });
  beforeEach(() => {
    matrix.reset();
    youtube.reset();
    zemer.reset(LISTED);
  });

  /** What happened, in order: "get <title>" when a download starts, "got <title>" when it ends, "zip <file>" when one is sent. */
  let events: string[] = [];
  let inFlight = 0;
  let mostInFlight = 0;

  function makeRunner(
    options: { maxFileBytes?: number; noFiles?: boolean; failSong?: string; downloadsAhead?: number; albumDownloads?: number; spoolDir?: string; memoryRoom?: () => boolean; turnedAway?: string } = {},
  ) {
    events = [];
    inFlight = 0;
    mostInFlight = 0;
    const catalog = new Catalog(':memory:');
    const youTube = new YouTubeMusic({ baseUrl: youtube.url });
    const whitelist = new ZemerWhitelist({ baseUrl: zemer.url, state: catalog });
    const audio = resolvingYouTubeAudio(youTube, {
      checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }),
      fetchAudio: (url, title) => fetchAudio(url, title),
    });
    const bot = createBot({
      catalog,
      checkAudio: gatedAudioCheck(youTubeGate({ youTube, whitelist, catalog }), audio.checkAudio),
      albums: createYouTubeAlbumSource({ youTube, catalog, whitelist }),
    });
    const matrixClient = new MatrixClient({ token: matrix.token, homeserver: matrix.url });
    // A chat that can't take a file: only what the runner has to have.
    const chat = options.noFiles
      ? {
          listMessages: matrixClient.listMessages.bind(matrixClient),
          sendText: matrixClient.sendText.bind(matrixClient),
          sendAudio: matrixClient.sendAudio.bind(matrixClient),
          reactions: true,
        }
      : {
          listMessages: matrixClient.listMessages.bind(matrixClient),
          sendText: matrixClient.sendText.bind(matrixClient),
          sendAudio: matrixClient.sendAudio.bind(matrixClient),
          reactions: true,
          sendFile: async (room: string, file: { data: Blob; fileName: string; mimeType: string; bytes: number }) => {
            events.push(`zip ${file.fileName}`);
            return matrixClient.sendFile(room, file);
          },
        };
    return createRunner({
      chat,
      bot,
      chatID: matrix.roomId,
      fetchAudio: async (url, title) => {
        const name = (title ?? url).replace(/^.* — /, '');
        events.push(`get ${name}`);
        inFlight += 1;
        mostInFlight = Math.max(mostInFlight, inFlight);
        try {
          if (options.failSong && url.endsWith(options.failSong)) throw new Error('boom');
          const file = await audio.fetchAudio(url, title);
          return options.turnedAway && url.endsWith(options.turnedAway) ? { ...file, timing: { turnedAway: 1 } } : file;
        } finally {
          inFlight -= 1;
          events.push(`got ${name}`);
        }
      },
      pollMs: 20,
      log: () => {},
      ...(options.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {}),
      ...(options.downloadsAhead !== undefined ? { downloadsAhead: options.downloadsAhead } : {}),
      ...(options.albumDownloads !== undefined ? { albumDownloads: options.albumDownloads } : {}),
      ...(options.memoryRoom ? { memoryRoom: options.memoryRoom } : {}),
      ...(options.spoolDir !== undefined ? { spoolDir: options.spoolDir } : {}),
    });
  }

  /** Typed on the phone: the album's name ("album …", a menu), its number (its songs), then "zip" (all of it). From then on only what the zip brought is kept. */
  async function ask(runner: ReturnType<typeof makeRunner>, text: string): Promise<void> {
    await runner.prime();
    for (const body of [text, '1']) {
      matrix.addMessage(matrix.ghost, { msgtype: 'm.text', body });
      await runner.tick();
    }
    events = [];
    mostInFlight = 0;
    matrix.sent.splice(0);
    matrix.addMessage(matrix.ghost, { msgtype: 'm.text', body: 'zip' });
    await runner.tick();
  }

  test('an album typed on the phone arrives as one zip of its songs, numbered in album order, with the original bytes', async () => {
    const runner = makeRunner();
    await ask(runner, 'album shabbuson');

    assert.equal(matrix.sent.length, 3);
    assert.equal(matrix.sent[0]?.content.body, '🎵 Michoel Schnitzler — Shabbuson');
    assert.match(String(matrix.sent[1]?.content.body), /3 songs/);
    const file = matrix.sent[2]!.content;
    assert.equal(file.msgtype, 'm.file');
    assert.equal(file.filename, 'Michoel Schnitzler - Shabbuson.zip');
    assert.equal(file.info.mimetype, 'application/zip');
    assert.equal(matrix.uploads.length, 1);
    const entries = readZip(matrix.uploads[0]!.bytes);
    assert.deepEqual(entries.map((entry) => entry.name), ['01 Opening.m4a', '02 הנחת תפילין.m4a', '05 Closing.m4a']);
    assert.deepEqual(Buffer.from(entries[0]!.data), youtube.bytes('albumsong01'));
    assert.deepEqual(Buffer.from(entries[2]!.data), youtube.bytes('albumsong04'));
  });

  test('an album bigger than one file may be goes as several zips, each saying which part it is', async () => {
    // Each song is 4,000 bytes; with this room, two songs fit in a zip and the third starts another.
    const runner = makeRunner({ maxFileBytes: 8_700 });
    await ask(runner, 'album shabbuson');

    const files = matrix.sent.filter((event) => event.content.msgtype === 'm.file');
    assert.deepEqual(files.map((event) => event.content.filename), ['Michoel Schnitzler - Shabbuson (part 1 of 2).zip', 'Michoel Schnitzler - Shabbuson (part 2 of 2).zip']);
    assert.deepEqual(readZip(matrix.uploads[0]!.bytes).map((entry) => entry.name), ['01 Opening.m4a', '02 הנחת תפילין.m4a']);
    assert.deepEqual(readZip(matrix.uploads[1]!.bytes).map((entry) => entry.name), ['05 Closing.m4a']);
    for (const upload of matrix.uploads) assert.ok(upload.bytes.length <= 8_700);
  });

  test('on a small host the songs wait on disk, one download at a time, and the zips go once they are all in; nothing is left behind', async () => {
    // Render's settings, scaled down: one download at a time, and two of these songs to a zip.
    const spoolDir = mkdtempSync(join(tmpdir(), 'album-spool-test-'));
    try {
      const runner = makeRunner({ maxFileBytes: 8_700, albumDownloads: 1, spoolDir });
      await ask(runner, 'album shabbuson');
      assert.deepEqual(events, [
        'get Opening',
        'got Opening',
        'get הנחת תפילין',
        'got הנחת תפילין',
        'get Closing',
        'got Closing',
        'zip Michoel Schnitzler - Shabbuson (part 1 of 2).zip',
        'zip Michoel Schnitzler - Shabbuson (part 2 of 2).zip',
      ]);
      assert.equal(mostInFlight, 1);
      assert.deepEqual(readdirSync(spoolDir), [], 'the songs on disk are gone once the album is sent');
    } finally {
      rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  test('an album’s songs download a few at a time (three unless told), each to disk as it comes, and the zip is still in album order', async () => {
    for (const [told, most] of [
      [undefined, 3],
      [2, 2],
    ] as const) {
      const runner = makeRunner(told === undefined ? {} : { albumDownloads: told });
      await ask(runner, 'album shabbuson');
      assert.equal(mostInFlight, most);
      assert.deepEqual(readZip(matrix.uploads.at(-1)!.bytes).map((entry) => entry.name), ['01 Opening.m4a', '02 הנחת תפילין.m4a', '05 Closing.m4a']);
    }
  });

  test('with no memory to spare, or once YouTube has turned the relay away, the rest of an album comes one at a time', async () => {
    const tight = makeRunner({ memoryRoom: () => false });
    await ask(tight, 'album shabbuson');
    assert.equal(mostInFlight, 1, 'one download always goes, so the album never stalls');
    assert.equal(readZip(matrix.uploads.at(-1)!.bytes).length, 3);

    // Six songs, three at a time; the first comes quickly, after YouTube turned the relay away once.
    const songs = Array.from({ length: 6 }, (_, i) => ({ number: i + 1, title: `Song ${i + 1}`, url: `https://x.test/${i + 1}` }));
    let inFlight = 0;
    let firstIn = false;
    let mostAfter = 0;
    const matrixClient = new MatrixClient({ token: matrix.token, homeserver: matrix.url });
    const runner = createRunner({
      chat: matrixClient,
      bot: { handle: async () => [{ kind: 'album', title: 'Six', artist: 'Band', songs }] },
      chatID: matrix.roomId,
      albumDownloads: 3,
      fetchAudio: async (url) => {
        inFlight += 1;
        if (firstIn) mostAfter = Math.max(mostAfter, inFlight);
        const first = url.endsWith('/1');
        await new Promise((resolve) => setTimeout(resolve, first ? 5 : 30));
        inFlight -= 1;
        firstIn ||= first;
        return { data: new Blob(['x']), fileName: 'x.m4a', mimeType: 'audio/mp4', bytes: 1, ...(first ? { timing: { turnedAway: 1 } } : {}) };
      },
      pollMs: 20,
      log: () => {},
    });
    await runner.prime();
    matrix.addMessage(matrix.ghost, { msgtype: 'm.text', body: 'six' });
    await runner.tick();
    assert.equal(mostAfter, 1, 'after the turn-away, a new download starts only once the others are in');
    assert.equal(readZip(matrix.uploads.at(-1)!.bytes).length, 6);
  });

  test('a song that cannot be had is left out of the zip, and the chat is told', async () => {
    const runner = makeRunner({ failSong: 'albumsong02' });
    await ask(runner, 'album shabbuson');

    assert.deepEqual(readZip(matrix.uploads[0]!.bytes).map((entry) => entry.name), ['01 Opening.m4a', '05 Closing.m4a']);
    // The left-to-right mark after the Hebrew keeps the full stop where it belongs on the phone.
    assert.equal(matrix.sent.at(-1)?.content.body, '🎵 I couldn\'t get one song of "Shabbuson": הנחת תפילין\u200e.');
  });

  test('a chat that cannot take a file gets the songs one by one instead', async () => {
    const runner = makeRunner({ noFiles: true });
    await ask(runner, 'album shabbuson');

    const audio = matrix.sent.filter((event) => event.content.msgtype === 'm.audio');
    assert.equal(audio.length, 3);
    assert.equal(matrix.sent.some((event) => event.content.msgtype === 'm.file'), false);
    assert.deepEqual(matrix.uploads.map((upload) => upload.bytes.length), [4000, 4000, 4000]);
  });

  test('an album picked by its number, then "zip", is the zip of that album', async () => {
    const runner = makeRunner();
    await ask(runner, 'album night songs');
    const file = matrix.sent.find((event) => event.content.msgtype === 'm.file')!.content;
    assert.equal(file.filename, 'The Night Owls - Night Songs.zip');
    assert.deepEqual(readZip(matrix.uploads[0]!.bytes).map((entry) => entry.name), ['01 One.m4a', '02 Two.m4a', '03 Three.m4a']);
  });
});
