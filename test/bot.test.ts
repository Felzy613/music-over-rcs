import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AudioCheck } from '../src/audio-check.ts';
import { createBot, describe as describeTrack, HELP_TEXT, joinLists, SourceError } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import type { Reply, Track } from '../src/types.ts';
import { splitPostback } from '../src/views.ts';
import { SAMPLE } from './helpers/sample.ts';
import { postbackOf, shown } from './helpers/zemer-fixtures.ts';

type TextReply = Extract<Reply, { kind: 'text' }>;

/** A menu's song lines (the ones a 👍 picks), without its last line. */
const songLines = (replies: Reply[]): string[] => replies.flatMap((reply) => (reply.kind === 'text' && reply.postback?.startsWith('play:') ? [reply.text] : []));

function textOf(reply: Reply | undefined): TextReply {
  assert.ok(reply && reply.kind === 'text', 'expected a text reply');
  return reply;
}

/** The audio reply the bot should produce for a track: its URL, plus a display name for naming the file. */
const audio = (track: Track): Reply => ({ kind: 'audio', url: track.url, title: describeTrack(track) });

const FROM = '+15551234567';

function setup(check: (url: string) => Promise<AudioCheck> = async () => ({ ok: true, type: 'audio/mpeg' })) {
  const catalog = new Catalog(':memory:');
  const tracks = SAMPLE.map((track) => catalog.add(track));
  const checked: string[] = [];
  const bot = createBot({
    catalog,
    checkAudio: async (url) => {
      checked.push(url);
      return check(url);
    },
  });
  return {
    bot,
    catalog,
    checked,
    byTitle: (title: string) => tracks.find((track) => track.title === title)!,
    ask: (text: string) => bot.handle({ from: FROM, messageId: 'm1', text }),
    tap: (postback: string) => bot.handle({ from: FROM, messageId: 'm2', postback }),
  };
}

describe('bot', () => {
  test('greetings, "help" and empty messages get the help text without touching the catalog', async () => {
    const { ask, checked } = setup();
    for (const text of ['', '   ', 'hi', 'Hello', 'help', 'help me', 'menu', '?']) {
      assert.deepEqual(await ask(text), [{ kind: 'text', text: HELP_TEXT }], `for "${text}"`);
    }
    assert.deepEqual(checked, []);
  });

  test('a lone character, like a stray "a" or a "2" with no list to pick from, gets the help text', async () => {
    const { ask, checked } = setup();
    for (const text of ['a', '2', 'x.', ' 7 ']) {
      assert.deepEqual(await ask(text), [{ kind: 'text', text: HELP_TEXT }], `for "${text}"`);
    }
    assert.deepEqual(checked, []);
    // Two characters is enough to search for.
    assert.match(textOf((await ask('search zz'))[0]).text, /No match for "zz"/);
  });

  test('a message starts with its command: without "search", a song name is not searched for, and the answer says how', async () => {
    const { ask, checked } = setup();
    for (const text of ['paper planes', 'play paper planes', 'blue horizon by the night owls']) {
      assert.deepEqual(await ask(text), [{ kind: 'text', text: `To look for a song, start with "search":\nsearch ${text}\n\nText "help" for the other commands.` }], text);
    }
    assert.deepEqual(checked, []);
  });

  test('"search" with nothing after it asks for a song; a letter off in "search" still searches', async () => {
    const { ask, byTitle } = setup();
    for (const text of ['search', 'Search:', 'search a']) {
      assert.deepEqual(await ask(text), [{ kind: 'text', text: 'Text "search" and a song name, like "search blue horizon night owls".' }], text);
    }
    for (const text of ['Search paper planes', 'search: paper planes', 'serach paper planes', 'seach paper planes']) {
      assert.deepEqual(songLines(await ask(text)), [`${byTitle('Paper Planes at Dawn').title} — Mira Vale`], text);
    }
  });

  test('a song is found without the apostrophes in its name, and with part of the artist\'s name in front', async () => {
    const { catalog, ask } = setup();
    const vnusni = catalog.add({ title: 'V’Nusni', artist: 'Lipa Schmeltzer', url: 'https://cdn.example.test/vnusni.mp3' });
    catalog.add({ title: 'ShabbaTrump', artist: 'Lipa Schmeltzer', url: 'https://cdn.example.test/trump.mp3' });
    for (const text of ['search lipa vnusni', 'search vnusni', "search v'nusni", 'search lipa shmeltzer vnusni', 'search vnusni lipa']) {
      assert.equal(songLines(await ask(text))[0], `${vnusni.title} — Lipa Schmeltzer`, text);
    }
  });

  test('says so when nothing matches', async () => {
    const replies = await setup().ask('search zzzz qqqq');
    assert.equal(replies.length, 1);
    assert.match(textOf(replies[0]).text, /No match for "zzzz qqqq"/);
  });

  test('one match is a menu of one, nothing sent; a 👍 on it announces the song, then sends it as an audio file', async () => {
    const { ask, tap, byTitle, checked } = setup();
    const paper = byTitle('Paper Planes at Dawn');
    const menu = await ask('search paper planes');
    assert.deepEqual(shown(menu), ['Paper Planes at Dawn — Mira Vale', 'Tap 👍 on a song to get it.']);
    assert.deepEqual(checked, [], 'nothing is checked until it is picked');
    assert.deepEqual(await tap(postbackOf(menu, 'Paper Planes')), [{ kind: 'text', text: '🎵 Mira Vale — Paper Planes at Dawn' }, audio(paper)]);
    assert.deepEqual(checked, [paper.url]);
  });

  test('the song the words name comes first: an exact title, "title by artist", and extra words that narrow it', async () => {
    const { ask } = setup();
    assert.equal(songLines(await ask('search blue horizon'))[0], 'Blue Horizon — The Night Owls');
    assert.equal(songLines(await ask('search blue horizon by the night owls'))[0], 'Blue Horizon — The Night Owls');
    assert.equal(songLines(await ask('search blue horizon live'))[0], 'Blue Horizon (Live) — The Night Owls');
  });

  test('a menu is one message per song (a 👍 on it picks it), and its last line carries the list as chips', async () => {
    const { ask, byTitle } = setup();
    const replies = await ask('search night owls');
    const blue = `play:${byTitle('Blue Horizon').id}`;
    const live = `play:${byTitle('Blue Horizon (Live)').id}`;
    assert.deepEqual(
      replies.map((reply) => (reply.kind === 'text' ? [reply.text, splitPostback(reply.postback ?? '').action] : [reply.kind, ''])),
      [
        ['Blue Horizon — The Night Owls', blue],
        ['Blue Horizon (Live) — The Night Owls', live],
        ['Tap 👍 on a song to get it.', textOf(replies.at(-1)).postback!],
      ],
    );
    assert.deepEqual(
      textOf(replies.at(-1)).chips?.map((chip) => [chip.label, splitPostback(chip.postback).action]),
      [
        ['1. Blue Horizon', blue],
        ['2. Blue Horizon (Live)', live],
      ],
    );
    // Where a 👍 can't reach the bot, it's one message, numbered as the chips are, and a number picks.
    assert.deepEqual(
      joinLists(replies).map((reply) => (reply.kind === 'text' ? reply.text : reply.kind)),
      ['1. Blue Horizon — The Night Owls\n2. Blue Horizon (Live) — The Night Owls\n\nReply with a number to pick one.'],
    );
  });

  test('songs by different artists are one list, each line "Title — Artist", with no headings', async () => {
    const { catalog, ask } = setup();
    const duet = catalog.add({ title: 'Night Duet', artist: 'The Night Owls & Mira Vale', url: 'https://cdn.example.test/duet.mp3' });
    const solo = catalog.add({ title: 'Night Solo', artist: 'Mira Vale', url: 'https://cdn.example.test/solo.mp3' });
    catalog.add({ title: 'Night Crowd', artist: 'Ann, Ben, Cal, Dov & Eli', url: 'https://cdn.example.test/crowd.mp3' });
    const replies = await ask('search night');
    const lines = replies.flatMap((reply) => (reply.kind === 'text' && reply.text ? [reply.text] : []));
    assert.ok(lines.includes('Night Duet — The Night Owls & Mira Vale'), lines.join(' | '));
    assert.ok(lines.includes('Night Solo — Mira Vale'), lines.join(' | '));
    assert.ok(lines.includes('Night Crowd — Ann & 4 more'), 'a long credit is cut short');
    assert.ok(!lines.some((line) => line.startsWith('🎤')), 'no artist heading over a list of several artists');
    const chips = textOf(replies.at(-1)).chips ?? [];
    assert.deepEqual(chips.map((chip) => splitPostback(chip.postback).action).filter((postback) => [`play:${duet.id}`, `play:${solo.id}`].includes(postback)).length, 2);
    // The numbers in a chat without 👍 follow the order on screen.
    const joined = textOf(joinLists(replies)[0]).text.split('\n');
    const numbered = joined.filter((line) => /^\d+\. /.test(line)).map((line) => Number(line.split('.')[0]));
    assert.deepEqual(numbered, numbered.map((_, i) => i + 1));
    assert.equal(numbered.length, songLines(replies).length);
  });

  test('a track number in front of a title is left out of the list', async () => {
    const { catalog, ask } = setup();
    catalog.add({ title: '01 Mendy Hershkowitz Band', artist: 'Kalmen Band', url: 'https://cdn.example.test/k1.mp3' });
    catalog.add({ title: '02 Yoel Hersh Fuchs', artist: 'Kalmen Band', url: 'https://cdn.example.test/k2.mp3' });
    assert.deepEqual(songLines(await ask('search kalmen band')), ['Mendy Hershkowitz Band — Kalmen Band', 'Yoel Hersh Fuchs — Kalmen Band']);
  });

  test('chip labels are cut to 25 characters', async () => {
    const { catalog, ask } = setup();
    catalog.add({ title: 'A very long song title that keeps going 🎵 part one', artist: 'Verbose Band', url: 'https://cdn.example.test/v1.mp3' });
    catalog.add({ title: 'A very long song title that keeps going 🎵 part two', artist: 'Verbose Band', url: 'https://cdn.example.test/v2.mp3' });
    const chips = textOf((await ask('search verbose band')).at(-1)).chips ?? [];
    assert.equal(chips.length, 2);
    for (const chip of chips) assert.ok(Array.from(chip.label).length <= 25, chip.label);
    assert.ok(chips[0]?.label.endsWith('…'));
  });

  test('tapping a chip plays that track', async () => {
    const { tap, byTitle } = setup();
    const live = byTitle('Blue Horizon (Live)');
    assert.deepEqual((await tap(`play:${live.id}`))[1], audio(live));
  });

  test('a chip for a deleted track, or an unknown payload, is handled', async () => {
    const { tap } = setup();
    assert.match(textOf((await tap('play:9999'))[0]).text, /no longer in the catalog/);
    assert.deepEqual(await tap('whatever'), [{ kind: 'text', text: HELP_TEXT }]);
  });

  test('a URL that fails the check is explained instead of sent', async () => {
    const { ask, tap } = setup(async () => ({ ok: false, reason: "it isn't an audio file" }));
    const replies = await tap(postbackOf(await ask('search paper planes'), 'Paper Planes'));
    assert.deepEqual(replies, [{ kind: 'text', text: `I can't send "Mira Vale — Paper Planes at Dawn": it isn't an audio file.` }]);
  });

  test('a song with a picture: its card (the cover with its name on it), then the file; two messages', async () => {
    const { catalog, ask, tap } = setup();
    const art = catalog.add({ title: 'Ana Elech', artist: 'Oizer Oberlander', url: 'https://cdn.example.test/ana.mp3', cover: 'https://img.example.test/ana.jpg' });
    assert.deepEqual(await tap(postbackOf(await ask('search oizer oberlander ana elech'), 'Ana Elech')), [
      { kind: 'image', url: 'https://img.example.test/ana.jpg', caption: { title: 'Ana Elech', artist: 'Oizer Oberlander' } },
      audio(art),
    ]);
  });

  test('every song about to be sent is counted, and a broken counter never stops it', async () => {
    const catalog = new Catalog(':memory:');
    const paper = catalog.add({ title: 'Paper Planes at Dawn', artist: 'Mira Vale', url: 'https://cdn.example.test/p.mp3' });
    const played: number[] = [];
    const bot = createBot({ catalog, checkAudio: async () => ({ ok: true, type: 'audio/mpeg' }), onPlay: (track) => played.push(track.id) });
    await bot.handle({ from: FROM, messageId: 'm1', text: 'search paper planes' });
    assert.deepEqual(played, [], 'a menu is not a play');
    await bot.handle({ from: FROM, messageId: 'm1', postback: `play:${paper.id}` });
    assert.deepEqual(played, [paper.id]);
    const failing = createBot({
      catalog,
      checkAudio: async () => ({ ok: true, type: 'audio/mpeg' }),
      onPlay: () => {
        throw new Error('disk full');
      },
    });
    assert.equal((await failing.handle({ from: FROM, messageId: 'm2', postback: `play:${paper.id}` })).length, 2);
  });

  describe('with another place to look', () => {
    function withSource(found: (catalog: Catalog) => Track[] | Error) {
      const catalog = new Catalog(':memory:');
      const asked: string[] = [];
      const bot = createBot({
        catalog,
        checkAudio: async () => ({ ok: true, type: 'audio/mpeg' }),
        source: {
          name: 'music-table.com',
          async lookup(query) {
            asked.push(query);
            const result = found(catalog);
            if (result instanceof Error) throw result;
            return result;
          },
        },
      });
      return { catalog, asked, ask: (text: string) => bot.handle({ from: FROM, messageId: 'm1', text }) };
    }

    test('a song the catalog has is offered with what the other place has, the one the words name first', async () => {
      const { catalog, asked, ask } = withSource((c) => [c.add({ title: 'Shabbos Kodesh', artist: 'Yoely Weiss', url: 'https://cdn.example.test/k.mp3' })]);
      catalog.add({ title: 'Shabbos', artist: 'Yoely Weiss', url: 'https://cdn.example.test/s.mp3' });
      assert.deepEqual(songLines(await ask('search yoely weiss shabbos')), ['Shabbos — Yoely Weiss', 'Shabbos Kodesh — Yoely Weiss']);
      assert.deepEqual(asked, ['yoely weiss shabbos']);
    });

    test("a broader request also asks the other place, so songs the catalog doesn't have yet are offered", async () => {
      const { catalog, asked, ask } = withSource((c) => [
        c.add({ title: 'Purim', artist: 'Yoely Weiss', url: 'https://cdn.example.test/p.mp3' }),
        c.add({ title: 'Shabbos', artist: 'Yoely Weiss', url: 'https://cdn.example.test/s.mp3' }),
      ]);
      catalog.add({ title: 'Shabbos', artist: 'Yoely Weiss', url: 'https://cdn.example.test/s.mp3' });
      const replies = await ask('search yoely weiss');
      assert.deepEqual(asked, ['yoely weiss']);
      assert.deepEqual(songLines(replies), ['Purim — Yoely Weiss', 'Shabbos — Yoely Weiss'], 'its results first, no repeats');
    });

    test('when the other place fails, what the catalog has is still offered', async () => {
      const { catalog, ask } = withSource(() => new SourceError('the site is down'));
      catalog.add({ title: 'Shabbos', artist: 'Yoely Weiss', url: 'https://cdn.example.test/s.mp3' });
      catalog.add({ title: 'Purim', artist: 'Yoely Weiss', url: 'https://cdn.example.test/p.mp3' });
      assert.deepEqual(songLines(await ask('search yoely weiss')).sort(), ['Purim — Yoely Weiss', 'Shabbos — Yoely Weiss']);
      assert.equal(textOf((await ask('search nothing like it'))[0]).text, "I couldn't search music-table.com right now: the site is down.");
    });
  });

  test('very long messages are truncated rather than rejected', async () => {
    const replies = await setup().ask(`search ${'paper '.repeat(500)}`);
    assert.equal(replies.length, 2);
  });
});
