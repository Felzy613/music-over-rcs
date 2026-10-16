import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createBot, SourceError, type LookupOptions, type TrackSource } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { arrangeSources, combineSources } from '../src/sources/songs.ts';
import { createYouTubeMusicSource, gatedAudioCheck, YouTubeMusic, youTubeGate } from '../src/sources/youtube-music.ts';
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import type { Reply, Track } from '../src/types.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { artistId, startMockYouTubeMusic, type MockSong, type MockYouTubeMusic } from './helpers/mock-youtube-music.ts';

const OWLS = 'The Night Owls';
const SONGS: MockSong[] = [
  { videoId: 'aaaaaaaaaa1', title: 'Blue Horizon', artists: [OWLS], duration: '3:05' },
  { videoId: 'aaaaaaaaaa2', title: 'Blue Horizon (Live)', artists: [OWLS], duration: '4:10' },
  { videoId: 'eeeeeeeeee3', title: 'Stranger Song', artists: ['Nobody Known'], duration: '2:50' },
  { videoId: 'ffffffffff1', title: 'Shabbos Medley', artists: ['Mira Vale'], duration: '5:00' },
  { videoId: 'gggggggggg1', title: "V'Nusni", artists: ['Mira Vale'], duration: '4:00' },
];
const LISTED: MockArtist[] = [OWLS, 'Mira Vale'].map((name) => ({ id: artistId(name), name }));

type TextReply = Extract<Reply, { kind: 'text' }>;
const textOf = (reply: Reply | undefined): TextReply => {
  assert.ok(reply && reply.kind === 'text', `expected a text reply, got ${JSON.stringify(reply)}`);
  return reply;
};

describe('search looks on YouTube Music first, then on music-table.com', () => {
  let youtube: MockYouTubeMusic;
  let zemer: MockZemerContent;
  before(async () => {
    youtube = await startMockYouTubeMusic(SONGS);
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

  /** A stand-in for music-table.com that finds the songs it is given, and notes each time it is asked. */
  function site(catalog: Catalog, titles: string[] = []): TrackSource & { asked: string[] } {
    const asked: string[] = [];
    return {
      name: 'music-table.com',
      asked,
      async lookup(query) {
        asked.push(query);
        return titles.map((title) => catalog.add({ title, artist: 'Site Artist', url: `https://www.music-table.com/post/${title.toLowerCase().replace(/\W+/g, '-')}#0` }));
      },
    };
  }

  function setup(options: { catalog?: Catalog; site?: string[]; order?: 'youtube-first' | 'site-first' | 'no-youtube' } = {}) {
    const catalog = options.catalog ?? new Catalog(':memory:');
    const youTube = new YouTubeMusic({ baseUrl: youtube.url });
    const whitelist = new ZemerWhitelist({ baseUrl: zemer.url, state: catalog, checkEveryMs: 0, retryAfterMs: 0 });
    const songs = createYouTubeMusicSource({ youTube, catalog, whitelist });
    const music = site(catalog, options.site);
    const order = options.order ?? 'youtube-first';
    const arranged =
      order === 'youtube-first'
        ? arrangeSources(['youtube-music', 'music-table'], { 'youtube-music': songs, 'music-table': music })
        : order === 'site-first'
          ? arrangeSources(['music-table', 'youtube-music'], { 'youtube-music': songs, 'music-table': music })
          : arrangeSources(['youtube-music', 'music-table'], { 'music-table': music });
    // Anything may be sent here: this is about which source is asked, not about the files.
    const bot = createBot({
      catalog,
      checkAudio: gatedAudioCheck(youTubeGate({ youTube, whitelist, catalog }), async () => ({ ok: true, type: 'audio/mp4' })),
      ...arranged,
      youtube: songs,
    });
    return {
      catalog,
      music,
      youTube,
      say: (text: string) => bot.handle({ from: 'u', messageId: 'm', text }),
    };
  }

  const audioUrl = (replies: Reply[]): string | undefined => replies.find((reply) => reply.kind === 'audio')?.url;

  test('a song YouTube Music has is sent from there, even when the catalog holds the same one from music-table.com', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Blue Horizon', artist: OWLS, url: 'https://www.music-table.com/post/blue-horizon#0' });
    const { say, music, youTube } = setup({ catalog });
    assert.equal(audioUrl(await say('search blue horizon night owls')), youTube.trackUrl('aaaaaaaaaa1'));
    assert.deepEqual(music.asked, [], 'music-table.com was not even asked');
  });

  test('a request that names one of the songs YouTube Music finds plays it at once; otherwise they are listed', async () => {
    const { say, youTube } = setup();
    assert.equal(audioUrl(await say('search blue horizon')), youTube.trackUrl('aaaaaaaaaa1'));
    const listed = await say('search night owls');
    assert.equal(textOf(listed[0]).text, 'Which one?');
    assert.deepEqual(
      listed.filter((reply): reply is TextReply => reply.kind === 'text' && reply.postback !== undefined).map((reply) => reply.text),
      ['The Night Owls — Blue Horizon', 'The Night Owls — Blue Horizon (Live)'],
    );
  });

  test('when YouTube Music has nothing it may send (an artist not on Zemer’s list), music-table.com is looked in', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Stranger Song', artist: 'Nobody Known', url: 'https://www.music-table.com/post/stranger-song#0' });
    const { say } = setup({ catalog });
    assert.equal(audioUrl(await say('search stranger song nobody known')), 'https://www.music-table.com/post/stranger-song#0');
    assert.equal(youtube.searches.length, 1, 'YouTube Music was asked first');
  });

  test('when music-table.com has to be asked, it is, and what it finds is offered', async () => {
    const { say, music } = setup({ site: ['Stranger Song'] });
    const replies = await say('search stranger song');
    assert.deepEqual(music.asked, ['stranger song']);
    assert.equal(audioUrl(replies), 'https://www.music-table.com/post/stranger-song#0');
  });

  test('YouTube Music answers any words with its nearest songs, so only those that fit the words count', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Owls Zzzzqq', artist: 'Site Artist', url: 'https://www.music-table.com/post/owls-zzzzqq#0' });
    const { say } = setup({ catalog });
    // YouTube Music would hand back The Night Owls' songs for "owls", but none of them has "zzzzqq" in it.
    assert.equal(audioUrl(await say('search owls zzzzqq')), 'https://www.music-table.com/post/owls-zzzzqq#0');
    assert.equal(youtube.searches.length, 1, 'YouTube Music was asked first, and its songs were not taken');
  });

  test('"youtube" keeps YouTube Music’s own answer for the same words, because there is nothing to fall back on', async () => {
    const { say } = setup();
    const replies = await say('youtube owls zzzzqq');
    assert.equal(textOf(replies[0]).text, 'Which one?');
  });

  test('a song that misses one of the words is a different song: music-table.com gets to answer instead', async () => {
    // "blue horizon owls zzzz": the loose rule (a long request may miss a word) would have taken Blue Horizon.
    const { say, music } = setup({ site: ['Blue Horizon Owls Zzzz'] });
    const replies = await say('search blue horizon owls zzzz');
    assert.deepEqual(music.asked, ['blue horizon owls zzzz']);
    assert.equal(audioUrl(replies), 'https://www.music-table.com/post/blue-horizon-owls-zzzz#0');
  });

  test('a typo within the allowance, or an apostrophe left out, still finds the song on YouTube Music', async () => {
    const { say, youTube } = setup();
    assert.equal(audioUrl(await say('search shabos medley')), youTube.trackUrl('ffffffffff1'));
    assert.equal(audioUrl(await say('search mira vnusni')), youTube.trackUrl('gggggggggg1'));
  });

  test('when YouTube Music cannot be asked the catalog and music-table.com answer, without a word about it', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Blue Horizon', artist: OWLS, url: 'https://www.music-table.com/post/blue-horizon#0' });
    youtube.failSearch = true;
    const { say } = setup({ catalog });
    assert.equal(audioUrl(await say('search blue horizon night owls')), 'https://www.music-table.com/post/blue-horizon#0');
  });

  test('when nothing is found anywhere it says where it looked, and when nobody could be asked it says why', async () => {
    const { say } = setup();
    assert.equal(textOf((await say('search qqqq wwww'))[0]).text, 'No match for "qqqq wwww" (I looked on YouTube Music and music-table.com too). Try the artist and title, or fewer words.');

    youtube.failSearch = true;
    const failing: TrackSource = {
      name: 'music-table.com',
      async lookup() {
        throw new SourceError('the site may have changed');
      },
    };
    const catalog = new Catalog(':memory:');
    const youTube = new YouTubeMusic({ baseUrl: youtube.url });
    const whitelist = new ZemerWhitelist({ baseUrl: zemer.url, state: catalog });
    const bot = createBot({ catalog, checkAudio: async () => ({ ok: true, type: 'audio/mp4' }), first: createYouTubeMusicSource({ youTube, catalog, whitelist }), source: failing });
    assert.equal(
      textOf((await bot.handle({ from: 'u', messageId: 'm', text: 'search blue horizon' }))[0]).text,
      "I couldn't search YouTube Music or music-table.com: YouTube Music: YouTube Music answered HTTP 500; music-table.com: the site may have changed.",
    );
  });

  test('with music-table.com first in SONG_SOURCES, the catalog is looked in before YouTube Music, as before', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Blue Horizon', artist: OWLS, url: 'https://www.music-table.com/post/blue-horizon#0' });
    const { say } = setup({ catalog, order: 'site-first' });
    assert.equal(audioUrl(await say('search blue horizon night owls')), 'https://www.music-table.com/post/blue-horizon#0');
    assert.deepEqual(youtube.searches, []);
  });

  test('arrangeSources puts YouTube Music first only when it leads the order', () => {
    const yt: TrackSource = { name: 'YouTube Music', lookup: async () => [] };
    const mt: TrackSource = { name: 'music-table.com', lookup: async () => [] };
    assert.deepEqual(arrangeSources(['youtube-music', 'music-table'], { 'youtube-music': yt, 'music-table': mt }), { first: yt, source: mt });
    assert.deepEqual(arrangeSources(['youtube-music'], { 'youtube-music': yt, 'music-table': mt }), { first: yt });
    assert.deepEqual(arrangeSources(['youtube-music', 'music-table'], { 'music-table': mt }), { source: mt }, 'YouTube Music off');
    assert.deepEqual(arrangeSources(['youtube-music', 'music-table'], { 'youtube-music': yt }), { first: yt });
    const behind = arrangeSources(['music-table', 'youtube-music'], { 'youtube-music': yt, 'music-table': mt });
    assert.equal(behind.first, undefined);
    assert.equal(behind.source?.name, 'music-table.com and YouTube Music');
    assert.deepEqual(arrangeSources(['music-table'], {}), {});
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
