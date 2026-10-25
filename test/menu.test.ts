import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { TrackSource } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { closingLine, helpText } from '../src/menu.ts';
import { foldEditions, plainTitle, rankArtists, songTier } from '../src/ranking.ts';
import type { Reply } from '../src/types.ts';
import { splitPostback } from '../src/views.ts';
import { startMockYouTubeMusic, artistId, type MockYouTubeMusic } from './helpers/mock-youtube-music.ts';
import { startMockZemerContent, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { startMockZemerSearch, type MockZemerSearch } from './helpers/mock-zemer-search.ts';
import { choicesIn, FIXTURE_WHITELIST, fixtureBot, postbackOf, serveFixtures, shown } from './helpers/zemer-fixtures.ts';

// The menu a search gives (the owner's design, 2026-10-20): artists, albums and songs, five of each, nothing sent or opened
// on its own; "… more" pages; a 👍 opens an artist or album, or goes back to an earlier menu. The golden menus are made of
// what Zemer answered for the plan's three walkthroughs (test/fixtures/zemer).

const sent = (replies: Reply[]): Reply[] => replies.filter((reply) => reply.kind === 'audio' || reply.kind === 'album');

const ACHAS = [
  '🎤 Nachas',
  '🎤 Yiddish Nachas',
  '🎤 Shlepping Nachas',
  '💿 1. Achas — Mordechai Shapiro · 2022 · 12 songs',
  '💿 2. Achas - A Freilach Medley — Zanvil Weinberger · 2024 · 8 songs',
  '💿 3. One Heart (Aguda Achas) — Beri Weber · 2016 · 11 songs',
  'Achas — Mordechai Shapiro',
  'Achas — Yingerlich',
  'Achas — Yaakov Rosenblum',
  'Achas — Yerachmiel Begun & The Miami Boys Choir',
  'Achas — Freilach Band',
  'Text "songs more" for 8 more songs, or an album\'s number for its songs.',
];
const ACHAS_MORE = [
  'Achas — Simcha Leiner',
  'Achas — Shmueli Ungar',
  'Achas — Shalsheles',
  'Achas — Moshe Tischler',
  'Achas — Shlomo Katz',
  'Achas — Shlomo Simcha',
  'Achas — Shloime Dachs',
  'Achas — Shir V’shevach Boys Choir',
  'Text "songs more" for 8 more songs, or an album\'s number for its songs.',
];

describe('the search menu', () => {
  let search: MockZemerSearch;
  let content: MockZemerContent;
  let youtube: MockYouTubeMusic;
  const urls = () => ({ search: search.url, content: content.url, youtube: youtube.url });

  before(async () => {
    search = await startMockZemerSearch({ artists: [], songs: [], releases: [] });
    content = await startMockZemerContent(FIXTURE_WHITELIST.artists);
    // YouTube Music's own search, for when Zemer's can't be reached, knows one song.
    youtube = await startMockYouTubeMusic([{ videoId: 'ytmachas001', title: 'Achas', artists: ['Mordechai Shapiro'], duration: '3:44' }]);
  });
  after(async () => {
    await search.close();
    await content.close();
    await youtube.close();
  });
  beforeEach(() => {
    search.reset();
    serveFixtures(search);
    content.reset(FIXTURE_WHITELIST.artists);
    youtube.reset();
  });

  describe('the walkthroughs', () => {
    test('"search achas": the Nachas artists offered, the Achas albums, then the Achas songs most played first; nothing sent', async () => {
      const { say } = fixtureBot(urls());
      const menu = await say('search achas');
      assert.deepEqual(shown(menu), ACHAS);
      assert.deepEqual(sent(menu), [], 'a typo of an artist is offered, never opened, and no song is sent');
      assert.equal(menu.length, 12, 'one message per line: each can be 👍’d');
      assert.match(postbackOf(menu, '🎤 Nachas'), /^artist:UCFaqeWT7ZBJsdeOvCWvYhfA@\d+$/);
      assert.match(postbackOf(menu, '💿 Achas — Mordechai'), /^album:MPREb_SSjgz2CDJBF@\d+$/);
      assert.match(postbackOf(menu, 'Achas — Mordechai'), /^play:\d+@\d+$/);
      assert.match(postbackOf(menu, 'Text "songs more"'), /^view:\d+$/, 'a 👍 on the last line comes back to this menu');
      assert.deepEqual(
        choicesIn(menu)!.numbers!.map((choice) => [choice.number, splitPostback(choice.postback).action]),
        [
          [1, 'album:MPREb_SSjgz2CDJBF'],
          [2, 'album:MPREb_d6r8wplPkuO'],
          [3, 'album:MPREb_mZaW0HLantM'],
        ],
        'an album’s number opens it',
      );
    });

    test('"songs more" goes on 8 at a time, all the songs called "Achas" before any "Achas Shoalti"', async () => {
      const { say } = fixtureBot(urls());
      await say('search achas');
      assert.deepEqual(shown(await say('songs more')), ACHAS_MORE);
      const third = shown(await say('songs more'));
      assert.deepEqual(third.slice(0, 3), ['Achas — Naftali Blumenthal', 'Achas — Dovid Stein', 'Achas אחת — Mendy Hershkowitz Band'], 'a title in both alphabets is named too');
      const pages: string[] = [];
      for (let i = 0; i < 4; i += 1) pages.push(...shown(await say('more')).slice(0, -1));
      const firstShoalti = pages.findIndex((line) => /Shoalti|Shaalti|Shoalty/.test(line));
      assert.ok(firstShoalti > 0 && pages.slice(0, firstShoalti).every((line) => /^Achas( \(Live\)| אחת)? — /.test(line)), pages.join('\n'));
    });

    test('"search lipa schmeltzer": a menu, not his page; his albums’ editions as one line, and a credit only on another artist’s album', async () => {
      const { say } = fixtureBot(urls());
      const menu = shown(await say('search lipa schmeltzer'));
      assert.deepEqual(menu, [
        '🎤 Lipa Schmeltzer',
        '💿 1. ליפא פאַר א גוּט יאָר - Lipa’s Tekiyos · 2026 · 12 songs',
        '💿 2. אלעזר ליפא׳לע · 2025 · 15 songs',
        '💿 3. Lipa Schmeltzer Concert — Camp Coolam · 2025 · 7 songs',
        '💿 4. יום טוב ליפא · 2023 · 17 songs',
        '💿 5. The Event 5769 (Live) · 2023 · 26 songs',
        'פועל',
        'Kovati (AKA Lipa\'s Superbowl Takeover)',
        "Lipa's Shul",
        'Yener',
        'שלום',
        'Text "albums more" or "songs more" for 8 more, or an album\'s number for its songs.',
      ]);
      const albums = shown(await say('albums more'));
      assert.deepEqual(albums.slice(0, 2), ['💿 6. BavLipa - בבליפא · 2022 · 20 songs', "💿 7. Lipa's Gevaldig · 2020 · 13 songs"], 'numbers run on, and a re-upload is one line');
      assert.ok(!albums.some((line) => /Yinglish|גרסה עברית/.test(line)), 'the editions stay folded');
    });

    test('"search forever": no artist fits; exact album titles first, then the newest; the song titles that are just "Forever"', async () => {
      const { say } = fixtureBot(urls());
      assert.deepEqual(shown(await say('search forever')), [
        '💿 1. FOREVER — Itzik Dadya · 2025 · 13 songs',
        '💿 2. Forever — Shimon Kugel · 2009 · 11 songs',
        '💿 3. Miami Forever! — Yerachmiel Begun & The Miami Boys Choir · 2019 · 13 songs',
        "💿 4. Forever More (Me'atah V'ad Olam) — Shimon Craimer · 2018 · 10 songs",
        '💿 5. Forever One — Avraham Fried · 2010 · 10 songs',
        'Forever — Zusha',
        'Forever - פוראבר — Itzik Dadya',
        'Forever — Chayala Neuhaus & Yehuda Kirschner',
        'Forever — Yosef Gestetner',
        'Forever — Shloime Dachs',
        'Text "albums more" or "songs more" for 8 more, or an album\'s number for its songs.',
      ]);
    });

    test('an album opens into its songs, numbered, with its zip as a 📦 line; the 📦 (or "zip") sends the zip', async () => {
      const { say, tap } = fixtureBot(urls());
      const menu = await say('search forever');
      const album = await tap(postbackOf(menu, '💿 FOREVER'));
      const lines = shown(album);
      assert.equal(lines[0], '💿 FOREVER — Itzik Dadya · 2025 · 13 songs');
      assert.deepEqual(lines.slice(1, 3), ['1. Bayit Shel Shalom - בית של שלום', '2. Forever - פוראבר']);
      assert.equal(lines.length, 16, 'the album, 13 songs, the zip and the last line');
      assert.match(lines.at(-2)!, /^📦 All 13 songs as one zip · \d+ min$/);
      assert.deepEqual(sent(album), [], 'opening an album sends nothing');
      const zip = await tap(postbackOf(album, '📦'));
      assert.deepEqual(shown(zip).slice(1), ['13 songs, coming as a zip.', '[album]']);
      const again = await say('zip');
      assert.equal(sent(again)[0]?.kind, 'album', '"zip" in an album sends it too');
    });
  });

  describe('nothing is picked for you', () => {
    test('one song the words name exactly is a menu of it, not the song', async () => {
      search.raw.clear();
      const { say } = fixtureBot(urls());
      search.songs.push({ videoId: 'uniquesong1', title: 'Achas Unique', artist: 'Mordechai Shapiro', artistId: 'UCm5x_womXL5E7TAYca5JkZQ', playCount: 5 });
      const menu = await say('search achas unique');
      assert.deepEqual(shown(menu), ['Achas Unique — Mordechai Shapiro', 'Tap 👍 on a song to get it.']);
      assert.deepEqual(sent(menu), []);
    });

    test('an artist’s whole name is a menu too; a 👍 on them opens their page: newest albums and most played songs', async () => {
      const { say, tap } = fixtureBot(urls());
      const menu = await say('search achas');
      const artist = shown(await tap(postbackOf(menu, '🎤 Nachas')));
      assert.equal(artist[0], '🎤 Nachas · 3 albums · 72 songs');
      assert.deepEqual(artist.slice(1, 4), ['💿 1. 2nd Dance (Live) · 2024 · 11 songs', '💿 2. Nachas (Live at Virtual Hasc) · 2020 · 8 songs', '💿 3. בשכר זה · 2015 · 14 songs']);
      assert.equal(artist.length, 10, 'their name, 3 albums, 5 songs and the last line');
      assert.deepEqual(shown(await say('albums more')), ["That's all the albums for \"Nachas\"."]);
      assert.equal(shown(await say('songs more')).length, 9, 'the next 8 of their songs');
    });
  });

  describe('going back', () => {
    test('after an artist: a 👍 on a song of the menu sends it, and "songs more" goes on with the menu', async () => {
      const { say, tap } = fixtureBot(urls());
      const menu = await say('search achas');
      await tap(postbackOf(menu, '🎤 Nachas'));
      const song = await tap(postbackOf(menu, 'Achas — Yaakov Rosenblum'));
      assert.deepEqual(
        song.map((reply) => reply.kind),
        ['image', 'audio', 'text'],
        'the song, and the menu’s numbers again',
      );
      assert.deepEqual(shown(await say('songs more')), ACHAS_MORE);
    });

    test('after an album: "songs more" in the album goes up to the menu’s songs; "albums more" says when there are no more', async () => {
      const { say, tap } = fixtureBot(urls());
      const menu = await say('search achas');
      const album = await tap(postbackOf(menu, '💿 Achas — Mordechai'));
      assert.equal(shown(album).length, 15, 'the album, 12 songs, the zip and the last line');
      assert.deepEqual(shown(await say('songs more')), ACHAS_MORE);
      assert.deepEqual(shown(await say('albums more')), ['That\'s all the albums for "achas".']);
    });

    test('after a song: "albums more" is the menu’s; a 👍 on the last line goes back without sending anything', async () => {
      const { say, tap } = fixtureBot(urls());
      const menu = await say('search achas');
      await tap(postbackOf(menu, 'Achas — Yingerlich'));
      assert.deepEqual(shown(await say('albums more')), ['That\'s all the albums for "achas".']);
      await say('search forever');
      const back = await tap(postbackOf(menu, 'Text "songs more"'));
      assert.deepEqual(shown(back), ['Back to "achas".']);
      assert.deepEqual(choicesIn(back)!.numbers!.map((choice) => choice.number), [1, 2, 3], 'its numbers are the ones picked from now');
      assert.deepEqual(shown(await say('songs more')), ACHAS_MORE);
    });

    test('a bare "more" repeats the last "… more"; with none yet, it says which there are', async () => {
      const { say } = fixtureBot(urls());
      await say('search lipa schmeltzer');
      assert.deepEqual(shown(await say('more')), ['Text "albums more" or "songs more".']);
      await say('albums more');
      assert.match(shown(await say('more'))[0]!, /^💿 14\. /);
    });

    test('a restart in the middle loses nothing: the menu goes on from the catalog', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'menu-'));
      try {
        const path = join(dir, 'catalog.db');
        const first = fixtureBot(urls(), { catalog: new Catalog(path) });
        await first.say('search achas');
        first.catalog.close();
        const second = fixtureBot(urls(), { catalog: new Catalog(path) });
        assert.deepEqual(shown(await second.say('songs more')), ACHAS_MORE);
        second.catalog.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('old lines and other commands', () => {
    test('a line sent before menus (no view in it) still works: an album opens into its songs; a song is sent', async () => {
      const { tap, catalog } = fixtureBot(urls());
      for (const old of ['album:MPREb_SSjgz2CDJBF', 'tracks:MPREb_SSjgz2CDJBF']) {
        const album = await tap(old);
        assert.equal(shown(album)[0], '💿 Achas — Mordechai Shapiro · 2022 · 12 songs');
        assert.deepEqual(sent(album), [], 'an album line no longer sends the zip');
      }
      const track = catalog.add({ title: 'Old Song', artist: 'Someone', url: 'https://www.music-table.com/post/old-song#0' });
      assert.deepEqual(
        (await tap(`play:${track.id}`)).map((reply) => reply.kind),
        ['text', 'audio'],
      );
      const all = await tap(`all:play:${track.id}|album:MPREb_SSjgz2CDJBF@1`);
      assert.deepEqual(
        all.map((reply) => reply.kind),
        ['text', 'audio'],
        '"all" sends the songs and leaves the albums',
      );
    });

    test('"artist", "album" and "song" (or the plural) give that kind alone; "albums more" pages and "albums <name>" searches', async () => {
      const { say } = fixtureBot(urls());
      assert.deepEqual(shown(await say('artists achas')), ['🎤 Nachas', '🎤 Yiddish Nachas', '🎤 Shlepping Nachas', 'Tap 👍 on one to open it.']);
      const albums = shown(await say('album lipa schmeltzer'));
      assert.equal(albums.length, 6);
      assert.ok(albums.slice(0, 5).every((line) => line.startsWith('💿 ')));
      assert.match(albums[5]!, /^Text "albums more" for 8 more albums/);
      assert.match(shown(await say('albums more'))[0]!, /^💿 6\. /);
      const songs = shown(await say('songs more'));
      assert.deepEqual(songs.slice(0, 2), ['פועל', "Kovati (AKA Lipa's Superbowl Takeover)"], 'the query’s songs, from the first');
      assert.equal(shown(await say('song forever'))[0], 'Forever — Zusha');
    });

    test('"zip" outside an album says how to open one; "help" is one message with every command', async () => {
      const { say } = fixtureBot(urls());
      await say('search achas');
      assert.deepEqual(shown(await say('zip')), ['Open an album first: tap 👍 on a 💿 line.']);
      const help = await say('help');
      assert.equal(help.length, 1);
      assert.match(shown(help)[0]!, /^Start each message with a command:\nsearch <words>/);
      for (const command of ['artist / album / song', 'songs more', '📦', 'zemer <words>', 'all —']) assert.ok(shown(help)[0]!.includes(command), command);
    });
  });

  describe('Zemer’s list and the other places to look', () => {
    test('a female singer flagged on Zemer’s list is never in a menu, and a song of hers kept from before is refused when sent', async () => {
      const { say, tap } = fixtureBot(urls());
      const menu = await say('search achas');
      const kept = postbackOf(menu, 'Achas — Yingerlich');
      // The list is checked for changes before each search (checkEveryMs is 0 here) and each song sent.
      content.publish((artists) => {
        artists.find((artist) => artist.id === 'UCaDC4VKiVa5q_iSNJxCSLhQ')!.female = true;
      });
      const again = shown(await say('search achas'));
      assert.ok(!again.some((line) => line.includes('Yingerlich')));
      assert.equal(again.filter((line) => line.startsWith('Achas — ')).length, 5, 'the next song takes its place');
      const refused = await tap(kept);
      assert.deepEqual(sent(refused), []);
      assert.match(shown(refused)[0]!, /^I can't send /);
    });

    test('with Zemer down, YouTube Music’s own search answers with a menu, held to the same list', async () => {
      search.failing = true;
      content.reset([...FIXTURE_WHITELIST.artists, { id: artistId('Mordechai Shapiro'), name: 'Mordechai Shapiro' }]);
      const { say } = fixtureBot(urls());
      const menu = await say('search achas');
      assert.deepEqual(shown(menu), ['Achas — Mordechai Shapiro', 'Tap 👍 on a song to get it.']);
      assert.deepEqual(sent(menu), []);
    });

    test('with nothing on Zemer, music-table.com answers with the same kind of menu, never a song on its own', async () => {
      const catalog = new Catalog(':memory:');
      const site: TrackSource = {
        name: 'music-table.com',
        async lookup(query) {
          return /zzzq/.test(query) ? [catalog.add({ title: 'Zzzq Song', artist: 'Site Artist', url: 'https://www.music-table.com/post/zzzq-song#0' })] : [];
        },
      };
      const { say } = fixtureBot(urls(), { catalog, site });
      const menu = await say('search zzzq song');
      assert.deepEqual(shown(menu), ['Zzzq Song — Site Artist', 'Tap 👍 on a song to get it.']);
      assert.deepEqual(sent(menu), []);
      assert.deepEqual(shown(await say('search qqqqq')), ['No match for "qqqqq" on Zemer or music-table.com. Try the artist and title, or fewer words.']);
    });
  });
});

describe('ranking and the menu’s words', () => {
  test('an artist the words spell exactly comes before one they only start, and one a typo away is last', () => {
    const artists = [{ name: 'Nachas' }, { name: 'Achas Band' }, { name: 'Achashverosh' }];
    assert.deepEqual(
      rankArtists(artists, ['achas']).map((artist) => artist.name),
      ['Achas Band', 'Achashverosh', 'Nachas'],
    );
    assert.deepEqual(rankArtists([{ name: 'The Early Shabbos Band' }], ['shabbos']), [], 'the words must cover half the name');
  });

  test('a song’s tier: named (feat. and Live aside, either alphabet), every word in the title, or only with the artist', () => {
    assert.equal(songTier({ title: 'Achas (feat. Someone)', artist: 'X' }, ['achas']), 3);
    assert.equal(songTier({ title: 'Achas (Live)', artist: 'X' }, ['achas']), 3);
    assert.equal(songTier({ title: 'ונתנו', artist: 'Lipa Schmeltzer' }, ['vnusni']), 3);
    assert.equal(songTier({ title: 'Achas Shoalti', artist: 'X' }, ['achas']), 2);
    assert.equal(songTier({ title: 'Gelt', artist: 'Lipa Schmeltzer' }, ['lipa']), 1);
    assert.equal(songTier({ title: 'Lipa Schmeltzer X Sruly Green - i need my Afikoman', artist: 'Lipa Schmeltzer' }, ['lipa', 'schmeltzer']), 1, 'the artist’s own name in a title is not the title’s');
    assert.equal(songTier({ title: 'Gelt', artist: 'Lipa Schmeltzer' }, ['shabbos']), 0);
    assert.equal(plainTitle('Achas (feat. Chaim Meir Fligman)'), 'Achas');
  });

  test('editions fold where the first of them is, shown as the one that is just the album’s name; other artists’ albums never fold', () => {
    const albums = [
      { title: 'X - גרסה עברית', artist: 'Lipa' },
      { title: 'Y', artist: 'Camp' },
      { title: 'X', artist: 'Lipa' },
      { title: 'X (Yinglish Version)', artist: 'Lipa' },
      { title: 'X', artist: 'Someone Else' },
    ];
    assert.deepEqual(
      foldEditions(albums).map((album) => `${album.title}|${album.artist}`),
      ['X|Lipa', 'Y|Camp', 'X|Someone Else'],
    );
  });

  test('the last line names only the kinds with more, and how numbers pick where a 👍 can’t', () => {
    assert.deepEqual(closingLine(['songs'], true, true), { text: 'Text "songs more" for 8 more songs, or an album\'s number for its songs.', numbered: 'Text "songs more" for 8 more songs, or reply with a number to pick one.' });
    assert.equal(closingLine(['artists', 'albums', 'songs'], false, true).text, 'Text "artists more", "albums more" or "songs more" for 8 more.');
    assert.equal(closingLine([], true, true).text, "Text an album's number for its songs.");
    assert.ok(!helpText({ browse: false, follows: false, finder: false }).includes('trending'));
  });
});
