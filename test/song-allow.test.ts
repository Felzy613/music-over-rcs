import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { YouTubeMusic, youTubeGate } from '../src/sources/youtube-music.ts';
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { artistId } from './helpers/mock-youtube-music.ts';

// The owner can allow a single song (by its YouTube video id) without allowing its artist, and can lift Zemer's block on a single
// song. Neither can get round the owner's own blocks or Zemer's female flag, and Zemer's blocked songs stay blocked until the owner
// unblocks that very song.

const LISTED: MockArtist[] = [
  { id: artistId('The Night Owls'), name: 'The Night Owls' },
  { id: artistId('Rina Cohen'), name: 'Rina Cohen', female: true },
];
const night = artistId('The Night Owls');
const rina = artistId('Rina Cohen');
const newcomer = artistId('Newcomer Band');
const other = artistId('Another Band');
const SONG = 'abcdefghij1';
const BLOCKED = 'blockedsong';

const memory = () => {
  const kept = new Map<string, string>();
  return { kept, getState: (key: string) => kept.get(key), setState: (key: string, value: string) => void kept.set(key, value) };
};

describe('allowing one song by itself', () => {
  let content: MockZemerContent;
  before(async () => {
    content = await startMockZemerContent(LISTED);
  });
  after(() => content.close());
  beforeEach(() => {
    content.reset(LISTED);
    content.blocked.global = [BLOCKED];
  });

  async function make(state = memory()) {
    const list = new ZemerWhitelist({ baseUrl: content.url, state, checkEveryMs: 0, retryAfterMs: 0 });
    await list.ready();
    return { list, state };
  }

  test('a song by an artist who is not on the list is held back, until the owner allows that song', async () => {
    const { list } = await make();
    assert.deepEqual(list.verdict(SONG, [newcomer]), { ok: false, why: 'not on the list' });
    const done = list.allowSong({ id: SONG, title: 'A Song', artist: 'Newcomer Band', artistIds: [newcomer] });
    assert.ok(done.ok);
    assert.deepEqual(list.verdict(SONG, [newcomer]), { ok: true });
    assert.equal(list.songAllowed(SONG), true);
    assert.deepEqual(list.verdict('another1son', [newcomer]), { ok: false, why: 'not on the list' }, 'the artist is not allowed, only that song');
    assert.equal(list.artist(newcomer), undefined);
  });

  test('a credited artist the owner blocked still stops it, whether they are credited now or were when it was allowed', async () => {
    const { list } = await make();
    list.allowSong({ id: SONG, title: 'A Song', artist: 'Newcomer Band & Another Band', artistIds: [newcomer, other] });
    assert.equal(list.allows(SONG, [newcomer, other]), true);
    list.refuse(other, 'Another Band');
    assert.deepEqual(list.verdict(SONG, [newcomer, other]), { ok: false, why: 'owner' });
    // A stored song whose credits are not known any more (no ids) is held to the credits it had when it was allowed.
    assert.deepEqual(list.verdict(SONG, []), { ok: false, why: 'owner' });
    list.unblock(other);
    assert.deepEqual(list.verdict(SONG, []), { ok: true });
  });

  test('a credited artist Zemer flags as a woman stops it', async () => {
    const { list } = await make();
    list.allowSong({ id: SONG, title: 'A Duet', artist: 'Newcomer Band & Rina Cohen', artistIds: [newcomer, rina] });
    assert.deepEqual(list.verdict(SONG, [newcomer, rina]), { ok: false, why: 'female' });
    assert.deepEqual(list.verdict(SONG, [newcomer]), { ok: false, why: 'female' }, 'she was credited when it was allowed');
  });

  test('a song on Zemer’s blocked list stays blocked after it is allowed, until that song is unblocked', async () => {
    const { list } = await make();
    assert.deepEqual(list.unblockSong('neverblocked', 'x'), { ok: false, why: "that isn't a YouTube video id" }, 'not an id');
    assert.deepEqual(list.unblockSong('neverblock1', 'x'), { ok: false, why: "Zemer's list doesn't block that song" });

    const done = list.allowSong({ id: BLOCKED, title: 'Blocked One', artist: 'Newcomer Band', artistIds: [newcomer] });
    assert.ok(done.ok);
    assert.deepEqual(done.verdict, { ok: false, why: 'blocked' }, 'saved, but still held back');
    assert.deepEqual(list.verdict(BLOCKED, [night]), { ok: false, why: 'blocked' }, 'even by an artist on the list');

    assert.ok(list.unblockSong(BLOCKED, 'Blocked One').ok);
    assert.deepEqual(list.verdict(BLOCKED, [newcomer]), { ok: true }, 'unblocked and allowed');
    assert.deepEqual(list.verdict(BLOCKED, [night]), { ok: true }, 'unblocked and its artist is on the list');
    assert.deepEqual(list.verdict(BLOCKED, [rina]), { ok: false, why: 'female' }, 'its artists must still pass');

    assert.equal(list.reblockSong(BLOCKED)?.id, BLOCKED);
    assert.deepEqual(list.verdict(BLOCKED, [night]), { ok: false, why: 'blocked' });
    assert.equal(list.reblockSong(BLOCKED), undefined);
  });

  test('is kept across a restart, and removing it puts the song back as it was', async () => {
    const first = await make();
    first.list.allowSong({ id: SONG, title: 'A Song', artist: 'Newcomer Band', artistIds: [newcomer] });
    first.list.unblockSong(BLOCKED, 'Blocked One');
    first.list.refuse(other, 'Another Band');

    const { list } = await make(first.state);
    assert.deepEqual(list.songs().allowed.map((song) => [song.id, song.title, song.artistIds]), [[SONG, 'A Song', [newcomer]]]);
    assert.deepEqual(list.songs().unblocked.map((song) => song.id), [BLOCKED]);
    assert.equal(list.allows(SONG, [newcomer]), true);
    assert.equal(list.ownerArtists().blocked[0]?.id, other);
    assert.ok(typeof list.ownerArtists().blocked[0]?.at === 'number', 'when it was decided is kept');

    assert.equal(list.unallowSong(SONG)?.id, SONG);
    assert.equal(list.allows(SONG, [newcomer]), false);
    assert.equal(list.unallowSong(SONG), undefined);
  });

  test('takes a video id only, and no more than a thousand songs', async () => {
    const { list } = await make();
    assert.equal(list.allowSong({ id: 'short' }).ok, false);
    assert.equal(list.allowSong({ id: 'has a space!' }).ok, false);
    for (let i = 0; i < 1000; i += 1) assert.ok(list.allowSong({ id: String(i).padStart(11, 'x') }).ok);
    const over = list.allowSong({ id: 'oneTooMany1' });
    assert.equal(over.ok, false);
    assert.ok(list.allowSong({ id: String(5).padStart(11, 'x'), title: 'again' }).ok, 'one already allowed can still be updated');
  });

  describe('at send time (youTubeGate)', () => {
    const youTube = new YouTubeMusic({ baseUrl: 'http://127.0.0.1:9' });
    const url = youTube.trackUrl(SONG);

    test('a song allowed by itself goes even when the catalog has no credits for it; any other song with none does not', async () => {
      const { list } = await make();
      const gate = youTubeGate({ youTube, whitelist: list, catalog: { artistIdsOf: () => undefined } });
      assert.match((await gate(url)) ?? '', /hasn't been checked/);
      list.allowSong({ id: SONG, title: 'A Song', artist: 'Newcomer Band', artistIds: [newcomer] });
      assert.equal(await gate(url), undefined);
      assert.match((await gate(youTube.trackUrl('another1son'))) ?? '', /hasn't been checked/);
    });

    test('is held to the owner’s blocks and Zemer’s blocks at that moment', async () => {
      const { list } = await make();
      const gate = youTubeGate({ youTube, whitelist: list, catalog: { artistIdsOf: () => undefined } });
      list.allowSong({ id: SONG, title: 'A Song', artist: 'Newcomer Band', artistIds: [newcomer] });
      assert.equal(await gate(url), undefined);
      list.refuse(newcomer, 'Newcomer Band');
      assert.match((await gate(url)) ?? '', /you blocked its artist/);
      list.unblock(newcomer);
      assert.equal(await gate(url), undefined);

      list.allowSong({ id: BLOCKED, title: 'Blocked One', artist: 'Newcomer Band', artistIds: [newcomer] });
      assert.match((await gate(youTube.trackUrl(BLOCKED))) ?? '', /Zemer's list blocks that song/);
      list.unblockSong(BLOCKED);
      assert.equal(await gate(youTube.trackUrl(BLOCKED)), undefined);
    });

    test('with credits stored, a song allowed by itself is still checked against them', async () => {
      const { list } = await make();
      list.allowSong({ id: SONG, title: 'A Duet', artist: 'Newcomer Band', artistIds: [newcomer] });
      const gate = youTubeGate({ youTube, whitelist: list, catalog: { artistIdsOf: () => [newcomer, rina] } });
      assert.match((await gate(url)) ?? '', /female singer/);
    });
  });
});

describe('the owner’s decisions about artists, by channel id', () => {
  let content: MockZemerContent;
  before(async () => {
    content = await startMockZemerContent(LISTED);
  });
  after(() => content.close());

  async function make() {
    const state = memory();
    const list = new ZemerWhitelist({ baseUrl: content.url, state, checkEveryMs: 0, retryAfterMs: 0 });
    await list.ready();
    return { list, state };
  }

  test('admit allows an artist found elsewhere, never lifts Zemer’s female flag, and wants a real channel id', async () => {
    const { list } = await make();
    assert.deepEqual(list.standing(newcomer), { state: 'unknown' });
    assert.equal(list.admit('not-a-channel', 'X').ok, false);
    assert.equal(list.admit(newcomer, '   ').ok, false, 'a name is needed');
    const done = list.admit(newcomer, 'Newcomer  Band');
    assert.ok(done.ok && !done.already);
    assert.deepEqual(list.standing(newcomer), { state: 'allowed', name: 'Newcomer Band' });
    assert.equal(list.allows('x', [newcomer]), true);
    const again = list.admit(newcomer, 'Newcomer Band');
    assert.ok(again.ok && again.already);

    const refused = list.admit(rina, 'Rina Cohen');
    assert.equal(refused.ok, false);
    assert.equal(list.allows('x', [rina]), false);
    assert.deepEqual(list.standing(rina), { state: 'female', name: 'Rina Cohen' });
  });

  test('refuse blocks anyone by id, and a block always wins over an allow and over Zemer’s own list', async () => {
    const { list } = await make();
    list.admit(newcomer, 'Newcomer Band');
    assert.ok(list.refuse(newcomer, 'Newcomer Band').ok);
    assert.deepEqual(list.standing(newcomer), { state: 'blocked', name: 'Newcomer Band' });
    assert.equal(list.allows('x', [newcomer]), false);
    assert.ok(list.refuse(night, 'The Night Owls').ok, 'someone on Zemer’s list');
    assert.deepEqual(list.verdict('x', [night]), { ok: false, why: 'owner' });
    assert.ok(list.refuse(other, 'Another Band').ok, 'someone nobody has mentioned');

    // Unblocking puts them as they were: on Zemer's list they pass again, the others are unknown (hidden) until they are allowed.
    assert.equal(list.unblock(night)?.id, night);
    assert.equal(list.allows('x', [night]), true);
    assert.equal(list.unblock(newcomer)?.id, newcomer);
    assert.equal(list.allows('x', [newcomer]), false, 'an allow does not come back by itself');
    assert.equal(list.unblock(newcomer), undefined);
  });

  test('allowing a waiting artist, and taking an allow away', async () => {
    const state = memory();
    const first = new ZemerWhitelist({ baseUrl: content.url, state, checkEveryMs: 0, retryAfterMs: 0 });
    await first.ready();
    content.refusing = true;
    await first.ready();
    content.refusing = false;
    assert.ok(first.frozen);
    first.consider(newcomer, 'Newcomer Band');
    assert.equal(first.standing(newcomer).state, 'waiting');
    assert.ok(first.admit(newcomer, '').ok, 'the name it was found under is kept');
    assert.deepEqual(first.pending(), []);
    assert.equal(first.unallow(newcomer)?.name, 'Newcomer Band');
    assert.equal(first.standing(newcomer).state, 'unknown');
  });

  test('report and refreshNow: live or frozen, the back-off respected, and one forced try', async () => {
    let clock = 5_000_000;
    const list = new ZemerWhitelist({ baseUrl: content.url, now: () => clock, checkEveryMs: 0, retryAfterMs: 0 });
    assert.equal(list.report().loaded, false);
    const first = await list.refreshNow();
    assert.ok(first.ok);
    assert.match(first.message, /2 artists/);
    assert.equal(list.report().frozen, false);

    content.refusing = true;
    content.requests = [];
    const refused = await list.refreshNow();
    assert.equal(refused.ok, false);
    assert.match(refused.message, /turned the bot away \(HTTP 403\)/);
    assert.equal(list.report().frozen, true);
    assert.match(list.report().lastError ?? '', /HTTP 403/);
    assert.ok(list.report().nextAttemptAt! > clock);
    assert.equal(content.requests.length, 1);

    const waiting = await list.refreshNow();
    assert.ok(waiting.skipped, 'the three hours are respected');
    assert.match(waiting.message, /not asked again for about 3 hours/);
    assert.equal(content.requests.length, 1);

    const forced = await list.refreshNow({ force: true });
    assert.equal(forced.skipped, false);
    assert.equal(content.requests.length, 2, 'one forced try is one request');
    assert.match(forced.message, /turned the bot away/);

    content.refusing = false;
    clock += 4 * 60 * 60_000;
    const back = await list.refreshNow();
    assert.ok(back.ok);
    assert.equal(list.report().frozen, false);
  });

  test('the saved list can be searched by name, other-alphabet name or channel id, a page at a time', async () => {
    const mock = await startMockZemerContent([
      { id: artistId('Yossi Rotner'), name: 'Yossi Rotner', altName: 'יוסי רוטנר' },
      { id: artistId('Mira Vale'), name: 'Mira Vale', female: true },
      { id: artistId('The Night Owls'), name: 'The Night Owls' },
    ]);
    try {
      const list = new ZemerWhitelist({ baseUrl: mock.url });
      await list.ready();
      assert.equal(list.listedArtists().total, 3);
      assert.deepEqual(list.listedArtists({ query: 'רוטנר' }).matches.map((a) => a.name), ['Yossi Rotner']);
      assert.deepEqual(list.listedArtists({ query: 'mira' }).matches.map((a) => [a.name, a.female]), [['Mira Vale', true]]);
      assert.deepEqual(list.listedArtists({ query: artistId('The Night Owls').toLowerCase() }).matches.map((a) => a.name), ['The Night Owls']);
      assert.equal(list.listedArtists({ limit: 2 }).matches.length, 2);
      assert.equal(list.listedArtists({ limit: 2, offset: 2 }).matches.length, 1);
      list.refuse(artistId('Mira Vale'), 'Mira Vale');
      assert.equal(list.listedArtists({ query: 'mira' }).matches[0]?.owner, 'blocked');
    } finally {
      await mock.close();
    }
  });
});

describe('the catalog read for the console', () => {
  test('counts its tables and lists what was added last and the views', () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'One', artist: 'A', url: 'https://example.test/1' });
    catalog.add({ title: 'Two', artist: 'B', url: 'https://example.test/2' });
    const counts = catalog.tableCounts();
    assert.equal(counts.tracks, 2);
    assert.equal(counts.artists, 2);
    assert.deepEqual(catalog.recentTracks(5).map((track) => track.title), ['Two', 'One']);
    assert.deepEqual(catalog.recentViews(5), []);
    catalog.close();
  });
});
