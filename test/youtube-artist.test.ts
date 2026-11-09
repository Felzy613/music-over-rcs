import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createBot } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import {
  createYouTubeAlbumSource,
  createYouTubeMusicSource,
  gatedAudioCheck,
  parseArtistPage,
  parseDiscography,
  playsOf,
  YouTubeMusic,
  youTubeGate,
} from '../src/sources/youtube-music.ts';
import { createZemerFinder } from '../src/sources/zemer.ts';
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import type { Reply } from '../src/types.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { artistId, startMockYouTubeMusic, type MockAlbum, type MockArtistPage, type MockSong, type MockYouTubeMusic } from './helpers/mock-youtube-music.ts';

// Zemer's own search is locked to its app (since 2026-10-28), so a search is made from YouTube Music's: its song and
// album searches find only a page of each, and an artist's whole page of releases is behind the artist. These tests
// are the bot with Zemer's search off, over a mock of YouTube Music that has artist pages shaped like the real ones.

const MENDY = 'Mendy Brook';
const WOMAN = 'Rina Cohen';

/** Twelve albums (newest first, 2026 down to 2015) and six singles (two of them 2026), of which the page itself shows 2 of each. */
const ALBUMS_OF_MENDY = Array.from({ length: 12 }, (_, i) => ({ browseId: `MPREb_mendyrecord${String(i).padStart(2, '0')}`, title: `Mendy Record ${i + 1}`, year: 2026 - i }));
const SINGLES_OF_MENDY = [
  { browseId: 'MPREb_mendysingle1', title: 'Fresh Single', year: 2026 },
  { browseId: 'MPREb_mendysingle2', title: 'Newer Single', year: 2026 },
  { browseId: 'MPREb_mendysingle3', title: 'Old Single', year: 2019 },
  { browseId: 'MPREb_mendyep00004', title: 'Little EP', year: 2018, ep: true },
  { browseId: 'MPREb_mendysingle5', title: 'Older Single', year: 2017 },
  { browseId: 'MPREb_mendysingle6', title: 'Oldest Single', year: 2016 },
];

const PAGES: MockArtistPage[] = [
  {
    name: MENDY,
    songs: [
      { videoId: 'mendysong01', title: 'Big Hit', plays: '4.4M plays' },
      { videoId: 'mendysong02', title: 'Duet With Her', artists: [MENDY, WOMAN], plays: '2M plays' },
      { videoId: 'mendysong03', title: 'Quiet One', plays: '930 plays' },
    ],
    albums: ALBUMS_OF_MENDY,
    singles: SINGLES_OF_MENDY,
  },
];

const SONGS: MockSong[] = [
  { videoId: 'mendysong01', title: 'Big Hit', artists: [MENDY] },
  { videoId: 'nightsong01', title: 'Night Songs', artists: ['The Night Owls'] },
];
const ALBUMS: MockAlbum[] = [{ browseId: 'MPREb_nightsongs1', title: 'Night Songs', artists: ['The Night Owls'], year: 2021, tracks: [{ videoId: 'nightsong01', title: 'Night Songs' }] }];

const LISTED: MockArtist[] = [
  { id: artistId(MENDY), name: MENDY },
  { id: artistId('The Night Owls'), name: 'The Night Owls' },
  { id: artistId(WOMAN), name: WOMAN, female: true },
];

type TextReply = Extract<Reply, { kind: 'text' }>;
const texts = (replies: Reply[]): string[] => replies.filter((reply): reply is TextReply => reply.kind === 'text' && reply.text !== '').map((reply) => reply.text);

describe('YouTube Music artist pages', () => {
  let youtube: MockYouTubeMusic;
  let zemer: MockZemerContent;
  before(async () => {
    youtube = await startMockYouTubeMusic(SONGS, ALBUMS, PAGES);
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

  describe('reading them', () => {
    test('a play count is read from "1.1M plays", "24K plays" and "930 plays"', () => {
      assert.equal(playsOf('1.1M plays'), 1_100_000);
      assert.equal(playsOf('24K plays'), 24_000);
      assert.equal(playsOf('930 plays'), 930);
      assert.equal(playsOf('1 play'), 1);
      assert.equal(playsOf('Album'), undefined);
    });

    test('the artist is read with all of their albums, all of their singles (an EP is an album) and their top songs, from the "see all" pages', async () => {
      const page = await client().artist(artistId(MENDY));
      assert.ok(page);
      assert.equal(page.name, MENDY);
      assert.deepEqual(
        page.albums.map((release) => release.title),
        [...ALBUMS_OF_MENDY.map((album) => album.title), 'Little EP'],
        'twelve albums and the EP, though the page itself shows two albums',
      );
      assert.deepEqual(
        page.singles.map((release) => [release.title, release.year, release.single]),
        [
          ['Fresh Single', 2026, true],
          ['Newer Single', 2026, true],
          ['Old Single', 2019, true],
          ['Older Single', 2017, true],
          ['Oldest Single', 2016, true],
        ],
      );
      assert.deepEqual(
        page.songs.map((song) => [song.title, song.plays, song.artistIds.length]),
        [
          ['Big Hit', 4_400_000, 1],
          ['Duet With Her', 2_000_000, 2],
          ['Quiet One', 930, 1],
        ],
      );
      assert.equal(page.songs[1]!.artist, `${MENDY} & ${WOMAN}`);
    });

    test('a page is asked for once in ten minutes, and the ones that fail keep what the page itself shows', async () => {
      const yt = client();
      await yt.artist(artistId(MENDY));
      const asked = youtube.browses.length;
      assert.equal(asked, 4, 'the page, and the albums, the singles and the songs behind it');
      await yt.artist(artistId(MENDY));
      assert.equal(youtube.browses.length, asked, 'kept');
      assert.equal(await client().artist('not-an-artist'), undefined);
      assert.equal(await client().artist(artistId('Nobody At All')).catch(() => 'failed'), 'failed', 'an unknown channel is an error from YouTube Music, not a page');
    });

    test('parsers read the real shapes: a page without a name is nothing, and cards that are not releases are left out', () => {
      assert.equal(parseArtistPage({ header: {} }, 'UCxxxxxxxxxxxxxxxxxxxxxx'), undefined);
      assert.deepEqual(parseDiscography({ contents: {} }, 'album'), []);
    });
  });

  describe('from the bot, with Zemer’s search off', () => {
    function setup() {
      const catalog = new Catalog(':memory:');
      const youTube = client();
      const whitelist = new ZemerWhitelist({ baseUrl: zemer.url, state: catalog, checkEveryMs: 0, retryAfterMs: 0 });
      const finder = createZemerFinder({
        zemer: undefined,
        youTube,
        catalog,
        whitelist,
        fallback: { songs: createYouTubeMusicSource({ youTube, catalog, whitelist }), albums: createYouTubeAlbumSource({ youTube, catalog, whitelist }) },
      });
      const bot = createBot({
        catalog,
        checkAudio: gatedAudioCheck(youTubeGate({ youTube, whitelist, catalog }), async () => ({ ok: true, type: 'audio/mp4', bytes: 1000 })),
        finder,
        albums: finder.albums,
      });
      return {
        say: (text: string) => bot.handle({ from: 'u', messageId: 'm1', text }),
        tap: (postback: string) => bot.handle({ from: 'u', messageId: 'm2', postback }),
      };
    }

    test('searching an artist lists them, five albums to start with, and "albums more" goes through every one of them (twelve, not what a search holds)', async () => {
      const { say } = setup();
      const menu = texts(await say('search mendy brook'));
      assert.equal(menu[0], `🎤 ${MENDY}`);
      const albums = menu.filter((line) => line.startsWith('💿'));
      assert.deepEqual(albums, ['💿 Mendy Record 1 · 2026', '💿 Mendy Record 2 · 2025', '💿 Mendy Record 3 · 2024', '💿 Mendy Record 4 · 2023', '💿 Mendy Record 5 · 2022']);
      assert.ok(menu.at(-1)!.includes('"albums more"'), 'it says there are more');
      const more = texts(await say('albums more'));
      assert.deepEqual(
        more.filter((line) => line.startsWith('💿')),
        // Newest first by year; the EP is of 2018 like the ninth album.
        ['💿 Mendy Record 6 · 2021', '💿 Mendy Record 7 · 2020', '💿 Mendy Record 8 · 2019', '💿 Mendy Record 9 · 2018', '💿 Little EP · 2018', '💿 Mendy Record 10 · 2017', '💿 Mendy Record 11 · 2016', '💿 Mendy Record 12 · 2015'],
      );
      assert.ok(texts(await say('albums more')).some((line) => line.startsWith("That's all the albums")));
    });

    test('their top songs are listed by plays, a duet with a woman is not, and a song’s plays do not need the artist’s name on every line', async () => {
      const { say } = setup();
      const menu = texts(await say('search mendy brook'));
      const songs = menu.slice(menu.findIndex((line) => !line.startsWith('🎤') && !line.startsWith('💿')));
      assert.equal(songs[0], 'Big Hit');
      assert.ok(!menu.some((line) => line.includes('Duet With Her')), 'not a song a woman is credited on');
      assert.ok(menu.includes('Quiet One'));
    });

    test('a 👍 on the artist opens their page: the newest of everything first (singles among the albums, marked), with every kind counted', async () => {
      const { say, tap } = setup();
      const menu = await say('search mendy brook');
      const artist = menu.find((reply): reply is TextReply => reply.kind === 'text' && reply.text.startsWith('🎤'));
      const page = texts(await tap(artist!.postback!));
      assert.equal(page[0], `🎤 ${MENDY} · 13 albums · 5 singles · 2 songs`, 'the EP is counted among the albums; the duet with a woman is not a song');
      const releases = page.filter((line) => line.startsWith('💿'));
      assert.equal(releases.length, 5);
      // Newest first by year; within a year the albums come before the singles, as the two shelves give them.
      assert.deepEqual(releases, ['💿 Mendy Record 1 · 2026', '💿 Fresh Single · 2026 · single', '💿 Newer Single · 2026 · single', '💿 Mendy Record 2 · 2025', '💿 Mendy Record 3 · 2024']);
    });

    test('"album" and a name is the same search with only the albums, and so is "search album" and a name', async () => {
      const { say } = setup();
      const plain = texts(await say('album mendy brook'));
      const searched = texts(await say('search album mendy brook'));
      assert.deepEqual(searched, plain);
      assert.ok(plain.every((line) => line.startsWith('💿') || line.startsWith('Text ')), 'only albums');
      assert.ok(plain.length > 1);
    });

    test('"search … album" with the kind last finds what the words alone find nothing for, and "night songs" is still a song and an album', async () => {
      const { say } = setup();
      const plain = texts(await say('album mendy brook'));
      assert.deepEqual(texts(await say('search mendy brook album')).filter((line) => line.startsWith('💿')), plain.filter((line) => line.startsWith('💿')));
      const night = texts(await say('search night songs'));
      assert.ok(night.some((line) => line.startsWith('💿 Night Songs')), 'the album');
      assert.ok(night.some((line) => line.startsWith('Night Songs')), 'and the song');
    });

    test('words that name no artist open no artist’s page', async () => {
      const { say } = setup();
      await say('search night songs');
      assert.ok(!youtube.browses.some((id) => id.startsWith('VLTOP') || id.startsWith('MPAD')), 'nobody’s page was fetched');
    });

    test('an artist Zemer’s list does not have is never offered, nor is their page opened', async () => {
      zemer.reset(LISTED.filter((artist) => artist.name !== MENDY));
      const { say } = setup();
      const menu = texts(await say('search mendy brook'));
      assert.ok(!menu.some((line) => line.startsWith('🎤') || line.includes('Mendy Record')), JSON.stringify(menu));
      assert.ok(!youtube.browses.some((id) => id.startsWith('VLTOP') || id.startsWith('MPAD')), 'nobody’s page was fetched');
    });
  });
});
