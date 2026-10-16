import assert from 'node:assert/strict';
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
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import type { Reply } from '../src/types.ts';
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

  describe('from the bot', () => {
    function setup(options: { albums?: boolean | AlbumSource; catalog?: Catalog } = {}) {
      const catalog = options.catalog ?? new Catalog(':memory:');
      const youTube = client();
      const whitelist = new ZemerWhitelist({ baseUrl: zemer.url, state: catalog, checkEveryMs: 0, retryAfterMs: 0 });
      const songs = createYouTubeMusicSource({ youTube, catalog, whitelist });
      const audio = resolvingYouTubeAudio(youTube, {
        checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }),
        fetchAudio: (url, title) => fetchAudio(url, title),
      });
      const bot = createBot({
        catalog,
        checkAudio: gatedAudioCheck(youTubeGate({ youTube, whitelist, catalog }), audio.checkAudio),
        youtube: songs,
        first: songs,
        ...(options.albums === false ? {} : { albums: typeof options.albums === 'object' ? options.albums : createYouTubeAlbumSource({ youTube, catalog, whitelist }) }),
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

    test('"album" and a name that names one album sends it at once: its cover, a word on what is in it, then the album', async () => {
      const { say, youTube } = setup();
      const replies = await say('album shabbuson');
      assert.equal(replies.length, 3);
      assert.deepEqual(replies[0], { kind: 'image', url: 'https://lh3.googleusercontent.com/MPREb_shabbuson01=w544-h544-l90-rj', caption: { title: 'Shabbuson', artist: MICHOEL } });
      assert.match(textOf(replies[1]).text, /^3 songs, about \d+ MB; 1 left out\. Zipping it up, one moment\.$/);
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

    test('several albums fit: a list, one message each, and a 👍 on one sends it; "all" does not send every album', async () => {
      const { say, tap } = setup();
      const replies = await say('albums michoel schnitzler');
      assert.equal(textOf(replies[0]).text, 'Which album?');
      const lines = replies.filter((reply): reply is TextReply => reply.kind === 'text' && reply.postback !== undefined);
      assert.deepEqual(lines.map((line) => line.text), [`${MICHOEL} — Shabbuson (2022)`, `${MICHOEL} — Shabbuson Live (2023)`]);
      assert.deepEqual(lines.map((line) => line.postback), ['album:MPREb_shabbuson01', 'album:MPREb_shabbuson02']);
      assert.equal(textOf(replies.at(-1)).text, 'Tap 👍 on one to get the whole album as a zip.');
      assert.equal(textOf(replies.at(-1)).chips?.length, 2);

      assert.equal(albumOf(await tap('album:MPREb_shabbuson02')).title, 'Shabbuson Live');
      const all = await tap(`all:${lines.map((line) => line.postback).join('|')}`);
      assert.match(textOf(all[0]).text, /That list is albums/);
      assert.equal(all.length, 1);
    });

    test('says what to do when nothing fits, when there is nothing to search for, and why a woman’s album is not there', async () => {
      const { say } = setup();
      assert.equal(textOf((await say('album zzzz'))[0]).text, 'No album for "zzzz" on YouTube Music (it only shows artists on Zemer\'s list). Try the artist and the album\'s name, or fewer words.');
      assert.equal(textOf((await say('album her album'))[0]).text.startsWith('No album for "her album"'), true);
      assert.equal(textOf((await say('album'))[0]).text, 'Text "album" and an album or an artist, like "album michoel schnitzler".');
    });

    test('an album whose own page may not be sent is refused with the reason', async () => {
      const { tap } = setup();
      assert.equal(textOf((await tap('album:MPREb_heralbum04'))[0]).text, "I can't send that album: it has a female singer, which I don't send.");
    });

    test('a song blocked after the album was opened stays out: each is checked again just before it goes', async () => {
      const { tap, youTube } = setup();
      const opened = await tap('album:MPREb_shabbuson01');
      assert.equal(albumOf(opened).songs.length, 3);
      zemer.publish((_artists, blocked) => blocked.global.push('albumsong02'));
      const again = await tap('album:MPREb_shabbuson01');
      assert.deepEqual(albumOf(again).songs.map((song) => song.url), [youTube.trackUrl('albumsong01'), youTube.trackUrl('albumsong04')]);
      assert.match(textOf(again[1]).text, /^2 songs, about \d+ MB; 2 left out\./);
    });

    test('a search whose words match an album says so, under the song it found, with the album’s 👍 on that line', async () => {
      const { say, tap, youTube } = setup();
      const replies = await say('search night songs');
      assert.deepEqual(replies.find((reply) => reply.kind === 'audio'), { kind: 'audio', url: youTube.trackUrl('nightsongs1'), title: `${OWLS} — Night Songs` });
      const notice = textOf(replies.at(-1));
      assert.equal(notice.text, `💿 Also an album: ${OWLS} — Night Songs (2021). 👍 this, or text "album Night Songs", to get all of it as a zip.`);
      assert.equal(notice.postback, 'album:MPREb_nightsongs3');
      assert.deepEqual(albumOf(await tap(notice.postback!)).songs.map((song) => song.title), ['One', 'Two', 'Three']);
    });

    test('with no song by that name but an album, the album is the answer, as a list to pick from', async () => {
      const { say } = setup();
      const replies = await say('search shabbuson');
      assert.equal(textOf(replies[0]).text, 'No song by that name, but there are albums:');
      const lines = replies.filter((reply): reply is TextReply => reply.kind === 'text' && reply.postback !== undefined);
      assert.deepEqual(lines.map((line) => [line.text, line.postback]), [
        [`${MICHOEL} — Shabbuson (2022)`, 'album:MPREb_shabbuson01'],
        [`${MICHOEL} — Shabbuson Live (2023)`, 'album:MPREb_shabbuson02'],
      ]);
      assert.equal(textOf(replies.at(-1)).text, 'Tap 👍 on one to get the whole album as a zip.');
      assert.equal(textOf(replies.at(-1)).chips?.length, 2);
      const one = await say('search shabbuson live');
      assert.equal(textOf(one[0]).text, "No song by that name, but there's an album:");
    });

    test('an album the words name outright beats a song that only resembles them', async () => {
      // The catalog's looser search finds "Shabbuson Medley" for "shabbuson", but that is not what was asked for.
      const catalog = new Catalog(':memory:');
      catalog.add({ title: 'Shabbuson Medley', artist: OWLS, url: 'https://www.music-table.com/post/shabbuson-medley#0' });
      const { say } = setup({ catalog });
      const replies = await say('search shabbuson');
      assert.equal(textOf(replies[0]).text, "No song by that name, but there's an album:");
      assert.deepEqual(
        replies.filter((reply): reply is TextReply => reply.kind === 'text' && reply.postback !== undefined).map((reply) => reply.text),
        [`${MICHOEL} — Shabbuson (2022)`],
        'only the album the words name, not "Shabbuson Live"',
      );
      assert.equal(replies.some((reply) => reply.kind === 'audio'), false);
    });

    test('a search that is only an artist’s name is not about any one album, so none is mentioned', async () => {
      const { say } = setup();
      const replies = await say('search michoel schnitzler');
      assert.equal(replies.some((reply) => reply.kind === 'text' && reply.text.includes('💿')), false);
      assert.equal(textOf(replies[0]).text, 'Which one?');
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
      assert.equal(replies.some((reply) => reply.kind === 'audio'), true);
      assert.equal(replies.some((reply) => reply.kind === 'text' && reply.text.includes('💿')), false);
    });

    test('"youtube" mentions a matching album too', async () => {
      const { say } = setup();
      const replies = await say('youtube night songs');
      assert.match(textOf(replies.at(-1)).text, /^💿 Also an album: The Night Owls — Night Songs \(2021\)/);
    });

    test('with YouTube Music off there are no albums, and it says so', async () => {
      const { say } = setup({ albums: false });
      assert.match(textOf((await say('album shabbuson'))[0]).text, /Albums come from YouTube Music, which is turned off/);
    });

    test('"youtube" asks only YouTube Music, whatever the catalog holds, and "yt" and "youtube music" mean the same', async () => {
      const catalog = new Catalog(':memory:');
      catalog.add({ title: 'Blue Horizon', artist: OWLS, url: 'https://www.music-table.com/post/blue-horizon#0' });
      const { bot, youTube } = setup({ catalog });
      for (const text of ['youtube blue horizon night owls', 'yt blue horizon night owls', 'youtube music blue horizon night owls', 'Youtub blue horizon night owls']) {
        const replies = await bot.handle({ from: 'u', messageId: 'm', text });
        assert.deepEqual(replies.at(-1), { kind: 'audio', url: youTube.trackUrl('aaaaaaaaaa1'), title: `${OWLS} — Blue Horizon` }, text);
      }
      // "search" would have answered from the catalog alone, without asking YouTube Music at all.
      youtube.reset();
      const fresh = new Catalog(':memory:');
      fresh.add({ title: 'Blue Horizon', artist: OWLS, url: 'https://www.music-table.com/post/blue-horizon#0' });
      const local = createBot({ catalog: fresh, checkAudio: async () => ({ ok: true, type: 'audio/mpeg' }), youtube: createYouTubeMusicSource({ youTube: client(), catalog: fresh, whitelist: new ZemerWhitelist({ baseUrl: zemer.url }) }) });
      const searched = await local.handle({ from: 'u', messageId: 'm', text: 'search blue horizon night owls' });
      assert.equal((searched.at(-1) as { url: string }).url, 'https://www.music-table.com/post/blue-horizon#0');
      assert.deepEqual(youtube.searches, []);
    });

    test('"youtube" says why nothing was found, and what is wrong when YouTube Music is down', async () => {
      const { say } = setup();
      assert.equal(textOf((await say('youtube zzzz'))[0]).text, 'No match for "zzzz" on YouTube Music (it only shows artists on Zemer\'s list). Try the artist and title, or fewer words.');
      assert.equal(textOf((await say('youtube'))[0]).text, 'Text "youtube" and a song or an artist, like "youtube lipa vnusni".');
      youtube.failSearch = true;
      assert.equal(textOf((await say('youtube blue horizon'))[0]).text, "I couldn't search YouTube Music: YouTube Music answered HTTP 500.");
      const off = createBot({ catalog: new Catalog(':memory:'), checkAudio: async () => ({ ok: true, type: 'audio/mp4' }) });
      assert.match(textOf((await off.handle({ from: 'u', messageId: 'm', text: 'youtube blue horizon' }))[0]).text, /YouTube Music is turned off/);
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

  function makeRunner(options: { maxFileBytes?: number; noFiles?: boolean; failSong?: string } = {}) {
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
      youtube: createYouTubeMusicSource({ youTube, catalog, whitelist }),
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
      : matrixClient;
    return createRunner({
      chat,
      bot,
      chatID: matrix.roomId,
      fetchAudio: async (url, title) => {
        if (options.failSong && url.endsWith(options.failSong)) throw new Error('boom');
        return audio.fetchAudio(url, title);
      },
      pollMs: 20,
      log: () => {},
      ...(options.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {}),
    });
  }

  async function ask(runner: ReturnType<typeof makeRunner>, text: string): Promise<void> {
    await runner.prime();
    matrix.addMessage(matrix.ghost, { msgtype: 'm.text', body: text });
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

  test('a song that cannot be had is left out of the zip, and the chat is told', async () => {
    const runner = makeRunner({ failSong: 'albumsong02' });
    await ask(runner, 'album shabbuson');

    assert.deepEqual(readZip(matrix.uploads[0]!.bytes).map((entry) => entry.name), ['01 Opening.m4a', '05 Closing.m4a']);
    assert.equal(matrix.sent.at(-1)?.content.body, '🎵 I couldn\'t get one song of "Shabbuson": הנחת תפילין.');
  });

  test('a chat that cannot take a file gets the songs one by one instead', async () => {
    const runner = makeRunner({ noFiles: true });
    await ask(runner, 'album shabbuson');

    const audio = matrix.sent.filter((event) => event.content.msgtype === 'm.audio');
    assert.equal(audio.length, 3);
    assert.equal(matrix.sent.some((event) => event.content.msgtype === 'm.file'), false);
    assert.deepEqual(matrix.uploads.map((upload) => upload.bytes.length), [4000, 4000, 4000]);
  });

  test('picking from a list of albums with a 👍-style postback sends the zip too', async () => {
    const runner = makeRunner();
    await ask(runner, 'album night songs');
    const file = matrix.sent.find((event) => event.content.msgtype === 'm.file')!.content;
    assert.equal(file.filename, 'The Night Owls - Night Songs.zip');
    assert.deepEqual(readZip(matrix.uploads[0]!.bytes).map((entry) => entry.name), ['01 One.m4a', '02 Two.m4a', '03 Three.m4a']);
  });
});
