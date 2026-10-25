import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createBot, SourceError, type Album, type Finder, type FoundSong, type LookupOptions, type TrackSource } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { combineSources } from '../src/sources/songs.ts';
import type { Reply, Track } from '../src/types.ts';

const OWLS = 'The Night Owls';
const ZEMER_SONGS = [
  { title: 'Blue Horizon', artist: OWLS, url: 'https://music.youtube.com/watch?v=aaaaaaaaaa1' },
  { title: 'Blue Horizon (Live)', artist: OWLS, url: 'https://music.youtube.com/watch?v=aaaaaaaaaa2' },
  { title: 'Shabbos Medley', artist: 'Mira Vale', url: 'https://music.youtube.com/watch?v=ffffffffff1' },
  { title: "V'Nusni", artist: 'Mira Vale', url: 'https://music.youtube.com/watch?v=gggggggggg1' },
];

type TextReply = Extract<Reply, { kind: 'text' }>;
const textOf = (reply: Reply | undefined): TextReply => {
  assert.ok(reply && reply.kind === 'text', `expected a text reply, got ${JSON.stringify(reply)}`);
  return reply;
};
const audioUrl = (replies: Reply[]): string | undefined => replies.find((reply) => reply.kind === 'audio')?.url;
/** The menu's song lines. */
const songLines = (replies: Reply[]): string[] => replies.flatMap((reply) => (reply.kind === 'text' && reply.postback?.startsWith('play:') ? [reply.text] : []));

/**
 * Which place a search asks, and in what order: Zemer first (a stand-in that, like the real one, answers any words with
 * every song it has that shares one of them), then the catalog and music-table.com.
 */
describe('search looks on Zemer first, then in the catalog and on music-table.com', () => {
  function setup(options: { catalog?: Catalog; site?: string[]; zemerDown?: boolean; siteDown?: boolean; musicTableFirst?: boolean } = {}) {
    const catalog = options.catalog ?? new Catalog(':memory:');
    const zemerAsked: string[] = [];
    const finder: Finder = {
      name: 'Zemer',
      async find(query) {
        zemerAsked.push(query);
        if (options.zemerDown) throw new SourceError("Zemer's search answered HTTP 500");
        const words = query.toLowerCase().split(/\s+/);
        const songs = ZEMER_SONGS.filter((song) => words.some((word) => `${song.title} ${song.artist}`.toLowerCase().includes(word))).map(
          (song): FoundSong => ({ id: song.url.slice(-11), title: song.title, artist: song.artist, keep: async () => catalog.add(song) }),
        );
        return { songs, albums: [] as Album[], artists: [] };
      },
      artist: async () => undefined,
    };
    const siteAsked: string[] = [];
    const site: TrackSource = {
      name: 'music-table.com',
      async lookup(query) {
        siteAsked.push(query);
        if (options.siteDown) throw new SourceError('the site may have changed');
        return (options.site ?? []).map((title) => catalog.add({ title, artist: 'Site Artist', url: `https://www.music-table.com/post/${title.toLowerCase().replace(/\W+/g, '-')}#0` }));
      },
    };
    const bot = createBot({
      catalog,
      checkAudio: async () => ({ ok: true, type: 'audio/mp4' }),
      finder,
      source: site,
      ...(options.musicTableFirst ? { musicTableFirst: true } : {}),
    });
    const say = (text: string) => bot.handle({ from: 'u', messageId: 'm', text });
    /** The menu's first song, picked: where its audio comes from. */
    const first = async (text: string): Promise<string | undefined> => {
      const menu = await say(text);
      const line = menu.find((reply) => reply.kind === 'text' && reply.postback?.startsWith('play:'));
      assert.ok(line?.kind === 'text', `no song in ${JSON.stringify(menu)}`);
      assert.equal(audioUrl(menu), undefined, 'a menu sends nothing');
      return audioUrl(await bot.handle({ from: 'u', messageId: 'm', postback: line.postback! }));
    };
    return { catalog, zemerAsked, siteAsked, say, first };
  }

  test('a song Zemer has is sent from there, even when the catalog holds the same one from music-table.com', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Blue Horizon', artist: OWLS, url: 'https://www.music-table.com/post/blue-horizon#0' });
    const { first, siteAsked } = setup({ catalog });
    assert.equal(await first('search blue horizon night owls'), 'https://music.youtube.com/watch?v=aaaaaaaaaa1');
    assert.deepEqual(siteAsked, [], 'music-table.com was not even asked');
  });

  test('words that name one of Zemer’s songs put it first in the menu; nothing is played at once', async () => {
    const { say, first } = setup();
    assert.equal(await first('search blue horizon'), 'https://music.youtube.com/watch?v=aaaaaaaaaa1');
    assert.deepEqual(songLines(await say('search night owls')), [`Blue Horizon — ${OWLS}`, `Blue Horizon (Live) — ${OWLS}`]);
  });

  test('when Zemer has nothing that fits, the catalog is looked in, then music-table.com', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Stranger Song', artist: 'Nobody Known', url: 'https://www.music-table.com/post/stranger-song#0' });
    const { first, zemerAsked, siteAsked } = setup({ catalog, site: ['Other Song'] });
    assert.equal(await first('search stranger song nobody known'), 'https://www.music-table.com/post/stranger-song#0');
    assert.deepEqual(zemerAsked, ['stranger song nobody known'], 'Zemer was asked first');
    assert.equal(await first('search other song'), 'https://www.music-table.com/post/other-song#0');
    assert.deepEqual(siteAsked, ['stranger song nobody known', 'other song']);
  });

  test('Zemer answers any words with its nearest songs, so only those with every word count', async () => {
    // "blue horizon owls zzzz" would bring Blue Horizon by The Night Owls, which misses "zzzz": a different song.
    const { first, siteAsked } = setup({ site: ['Blue Horizon Owls Zzzz'] });
    assert.equal(await first('search blue horizon owls zzzz'), 'https://www.music-table.com/post/blue-horizon-owls-zzzz#0');
    assert.deepEqual(siteAsked, ['blue horizon owls zzzz']);
  });

  test('a typo within the allowance, or an apostrophe left out, still finds the song on Zemer', async () => {
    const { first } = setup();
    assert.equal(await first('search shabos medley'), 'https://music.youtube.com/watch?v=ffffffffff1');
    assert.equal(await first('search mira vnusni'), 'https://music.youtube.com/watch?v=gggggggggg1');
  });

  test('when Zemer cannot be asked, the catalog and music-table.com answer, without a word about it', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Blue Horizon', artist: OWLS, url: 'https://www.music-table.com/post/blue-horizon#0' });
    const { first } = setup({ catalog, zemerDown: true });
    assert.equal(await first('search blue horizon night owls'), 'https://www.music-table.com/post/blue-horizon#0');
  });

  test('when nothing is found anywhere it says where it looked, and when nobody could be asked it says why', async () => {
    assert.equal(textOf((await setup().say('search qqqq wwww'))[0]).text, 'No match for "qqqq wwww" on Zemer or music-table.com. Try the artist and title, or fewer words.');
    assert.equal(
      textOf((await setup({ zemerDown: true, siteDown: true }).say('search blue horizon'))[0]).text,
      "I couldn't search Zemer (Zemer's search answered HTTP 500) or music-table.com (the site may have changed) right now.",
    );
    // One of them down and nothing found by the other is just no match.
    assert.match(textOf((await setup({ zemerDown: true }).say('search qqqq'))[0]).text, /^No match for "qqqq"/);
  });

  test('with music-table.com first in SONG_SOURCES, the catalog is looked in before Zemer', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Blue Horizon', artist: OWLS, url: 'https://www.music-table.com/post/blue-horizon#0' });
    const { first, zemerAsked } = setup({ catalog, musicTableFirst: true });
    assert.equal(await first('search blue horizon night owls'), 'https://www.music-table.com/post/blue-horizon#0');
    assert.deepEqual(zemerAsked, []);
  });

  test('the options of a lookup reach every source in a combined one', async () => {
    const seen: Array<LookupOptions | undefined> = [];
    const spy = (name: string): TrackSource => ({
      name,
      async lookup(_query, _limit, options) {
        seen.push(options);
        return [];
      },
    });
    await combineSources([spy('a'), spy('b')])!.lookup('q', 5, { relevant: true });
    assert.deepEqual(seen, [{ relevant: true }, { relevant: true }]);
    const track: Track = { id: 1, title: 't', artist: 'a', url: 'https://x.test/1' };
    assert.equal(track.id, 1);
  });
});
