import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { createBot, waitingArtistsReplies } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { createNewReleases, ZemerReleases } from '../src/sources/zemer-releases.ts';
import { YouTubeMusic, youTubeGate } from '../src/sources/youtube-music.ts';
import { ZemerWhitelist, ZemerWhitelistError, zemerWhitelistFromEnv } from '../src/sources/zemer-whitelist.ts';
import type { Reply } from '../src/types.ts';
import { createWaitingNotice } from '../src/waiting-notice.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { startMockZemerReleases, type MockFeedRelease, type MockZemerReleases } from './helpers/mock-zemer-releases.ts';
import { artistId } from './helpers/mock-youtube-music.ts';

// Zemer's content server (the artist list) answers only its signed official app since November 2026. The list is then
// frozen at its last good copy, and the owner keeps it up to date from the chat: an artist that Zemer's public releases feed
// shows but the copy doesn't know waits for the owner's word, and anyone can be blocked.

const LISTED: MockArtist[] = [
  { id: artistId('The Night Owls'), name: 'The Night Owls' },
  { id: artistId('Yossi Rotner'), name: 'Yossi Rotner - יוסי רוטנר' },
  { id: artistId('Rina Cohen'), name: 'Rina Cohen', female: true },
  { id: artistId('Mira Vale'), name: 'Mira Vale' },
];
const night = artistId('The Night Owls');
const rina = artistId('Rina Cohen');
const newcomer = artistId('Newcomer Band');
const stranger = artistId('Another Newcomer');

const memory = () => {
  const kept = new Map<string, string>();
  return { kept, getState: (key: string) => kept.get(key), setState: (key: string, value: string) => void kept.set(key, value) };
};

type TextReply = Extract<Reply, { kind: 'text' }>;
const texts = (replies: Reply[]): string[] => replies.flatMap((reply) => (reply.kind === 'text' ? [reply.text] : []));
const textReplies = (replies: Reply[]): TextReply[] => replies.filter((reply): reply is TextReply => reply.kind === 'text');

describe('Zemer’s artist list when its server turns the bot away', () => {
  let content: MockZemerContent;
  before(async () => {
    content = await startMockZemerContent(LISTED);
  });
  after(() => content.close());
  beforeEach(() => content.reset(LISTED));

  const make = (options: ConstructorParameters<typeof ZemerWhitelist>[0] = {}) => new ZemerWhitelist({ baseUrl: content.url, checkEveryMs: 0, retryAfterMs: 0, ...options });
  /** A list that has the good copy and then meets the lock, as the live bot did. */
  async function frozenList(options: ConstructorParameters<typeof ZemerWhitelist>[0] = {}) {
    const list = make(options);
    await list.ready();
    content.refusing = true;
    await list.ready();
    assert.equal(list.frozen, true);
    return list;
  }

  describe('the lock itself', () => {
    test('keeps the last good list, says it is frozen, and is not asked again for hours', async () => {
      let clock = 1_000_000;
      const list = make({ now: () => clock, checkEveryMs: 5 * 60_000 });
      await list.ready();
      assert.equal(list.frozen, false);

      content.refusing = true;
      content.requests = [];
      clock += 6 * 60_000;
      await list.ready();
      assert.equal(list.frozen, true);
      assert.equal(list.allows('x', [night]), true, 'the last good list still filters');
      assert.equal(list.allows('x', [rina]), false);
      assert.deepEqual(content.requests, ['/whitelist/version']);

      clock += 20 * 60_000;
      await list.ready();
      await list.ready();
      assert.equal(content.requests.length, 1, 'a server that turned it away is left alone');

      clock += 3 * 60 * 60_000;
      await list.ready();
      assert.equal(content.requests.length, 2, 'asked again once the wait is over');

      content.refusing = false;
      clock += 3 * 60 * 60_000 + 1;
      await list.ready();
      assert.equal(list.frozen, false, 'answering again unfreezes it');
      assert.equal(list.ageMs, 0);
    });

    test('with no list at all it has no answer, and says so again without asking again', async () => {
      content.refusing = true;
      const list = make();
      await assert.rejects(list.ready(), (err) => err instanceof ZemerWhitelistError && err.refused && /turned the bot away \(HTTP 403\)/.test(err.message));
      await assert.rejects(list.ready(), /turned the bot away/);
      await assert.rejects(list.ready(), /turned the bot away/);
      assert.equal(content.requests.length, 1);
    });

    test('an ordinary failure is not a refusal: it is asked again soon, and the list is not frozen', async () => {
      const list = make();
      await list.ready();
      content.failing = new Set(['/whitelist/version']);
      await list.ready();
      assert.equal(list.frozen, false);
      content.failing = new Set();
      content.requests = [];
      await list.ready();
      assert.ok(content.requests.length > 0);
    });

    test('the background check reports the refusal without asking again until the wait is over', async () => {
      const list = make({ checkEveryMs: 60_000 });
      await list.ready();
      content.refusing = true;
      content.requests = [];
      const seen: Array<string | undefined> = [];
      const stop = list.watch((error) => seen.push(error), 15);
      await new Promise((resolve) => setTimeout(resolve, 150));
      stop();
      assert.equal(content.requests.length, 1);
      assert.ok(seen.length >= 3 && seen.every((error) => /turned the bot away/.test(error ?? '')), JSON.stringify(seen));
    });
  });

  describe('waiting artists', () => {
    test('are noted only while frozen, only for a channel id, and never for an artist the list knows or the owner has decided on', async () => {
      const live = make();
      await live.ready();
      assert.equal(live.consider(newcomer, 'Newcomer Band'), false, 'with a list that answers, the list is the authority');
      assert.deepEqual(live.pending(), []);

      const list = await frozenList();
      assert.equal(list.consider(night, 'The Night Owls'), false, 'already on the list');
      assert.equal(list.consider('not-a-channel', 'Someone'), false);
      assert.equal(list.consider(newcomer, '   '), false, 'no name');
      assert.equal(list.consider(newcomer, 'Newcomer Band'), true);
      assert.equal(list.consider(newcomer, 'Newcomer Band'), false, 'noted once');
      assert.equal(list.consider(stranger, '‮Another\u0000  Newcomer'), true);
      assert.deepEqual(list.pending(), [
        { id: newcomer, name: 'Newcomer Band' },
        { id: stranger, name: 'Another Newcomer' },
      ]);
      assert.deepEqual(list.owner, { allowed: 0, blocked: 0, waiting: 2 });
    });

    test('are held back until allowed, and a long or endless feed cannot flood the list', async () => {
      const list = await frozenList();
      list.consider(newcomer, 'Newcomer Band');
      assert.deepEqual(list.verdict('x', [newcomer]), { ok: false, why: 'not on the list' });
      assert.equal(list.artist(newcomer), undefined);
      assert.equal(list.consider(artistId('x'.repeat(30)), 'y'.repeat(500)), true);
      assert.equal(list.pending().find((artist) => artist.id === artistId('x'.repeat(30)))!.name.length, 80, 'a name is cut short');
      for (let i = 0; i < 400; i += 1) list.consider(`UC_flood_${String(i).padStart(10, '0')}`, `Flood ${i}`);
      assert.ok(list.pending().length <= 200);
    });

    test('allow lets their songs through, by name, by either half of a dual name, or by id', async () => {
      const list = await frozenList();
      list.consider(newcomer, 'Newcomer Band');
      list.consider(stranger, 'Dual Name - שם כפול');
      list.consider(artistId('Third Newcomer'), 'Third Newcomer');

      assert.deepEqual(list.allow('  newcomer   BAND '), [{ id: newcomer, name: 'Newcomer Band' }]);
      assert.deepEqual(list.verdict('x', [newcomer]), { ok: true });
      assert.deepEqual(list.artist(newcomer), { name: 'Newcomer Band', female: false });
      assert.deepEqual(list.idsNamed('newcomer band'), [newcomer], 'a credit that is only a name finds them');

      assert.deepEqual(list.allow('שם כפול'), [{ id: stranger, name: 'Dual Name - שם כפול' }]);
      assert.equal(list.allows('x', [stranger]), true);
      assert.deepEqual(list.allow(artistId('Third Newcomer')).map((artist) => artist.name), ['Third Newcomer']);

      assert.deepEqual(list.allow('Nobody Here'), [], 'nobody is waiting under that name');
      assert.deepEqual(list.pending(), []);
      assert.deepEqual(list.owner, { allowed: 3, blocked: 0, waiting: 0 });
    });

    test('a song with a listed artist and an allowed one goes, but a woman among the credits still stops it', async () => {
      const list = await frozenList();
      list.consider(newcomer, 'Newcomer Band');
      list.allow('Newcomer Band');
      assert.equal(list.allows('x', [night, newcomer]), true);
      assert.deepEqual(list.verdict('x', [newcomer, rina]), { ok: false, why: 'female' });
    });
  });

  describe('blocking', () => {
    test('hides anyone, always wins, and says whose doing it is', async () => {
      const list = await frozenList();
      assert.deepEqual(list.block('the night owls'), [{ id: night, name: 'The Night Owls' }]);
      assert.deepEqual(list.verdict('x', [night]), { ok: false, why: 'owner' });
      assert.deepEqual(list.verdict('x', [artistId('Mira Vale'), night]), { ok: false, why: 'owner' }, 'one blocked artist among the credits is enough');
      assert.equal(list.allows('x', [artistId('Mira Vale')]), true, 'others are untouched');
      assert.deepEqual(list.owner, { allowed: 0, blocked: 1, waiting: 0 });

      assert.deepEqual(list.block('Yossi Rotner'), [{ id: artistId('Yossi Rotner'), name: 'Yossi Rotner - יוסי רוטנר' }], 'by the English half of a dual name');
      assert.deepEqual(list.block('יוסי רוטנר').length, 1, 'and by the Hebrew half');
      assert.deepEqual(list.block('Never Heard Of Them'), []);
    });

    test('blocks an allowed artist and a waiting one, and a block is lifted by allow', async () => {
      const list = await frozenList();
      list.consider(newcomer, 'Newcomer Band');
      list.consider(stranger, 'Another Newcomer');
      list.allow('Newcomer Band');
      assert.equal(list.block('Newcomer Band').length, 1);
      assert.equal(list.allows('x', [newcomer]), false);
      assert.equal(list.block('Another Newcomer').length, 1, 'a waiting artist can be refused outright');
      assert.deepEqual(list.pending(), []);
      assert.equal(list.consider(stranger, 'Another Newcomer'), false, 'and is not asked about again');

      assert.deepEqual(list.allow('Newcomer Band').map((artist) => artist.id), [newcomer]);
      assert.equal(list.allows('x', [newcomer]), true);
      assert.deepEqual(list.allow('the night owls'), [], 'allowing someone who was never blocked or waiting does nothing');
      list.block('The Night Owls');
      assert.equal(list.allow('The Night Owls').length, 1);
      assert.equal(list.allows('x', [night]), true, 'lifting a block puts a listed artist back as they were');
    });

    test('allow never lifts Zemer’s own flag on a woman', async () => {
      const list = await frozenList();
      list.block('Rina Cohen');
      list.allow('Rina Cohen');
      assert.deepEqual(list.verdict('x', [rina]), { ok: false, why: 'female' });
    });

    test('a block holds for a song already stored, at the moment it is sent', async () => {
      const list = await frozenList();
      const youTube = new YouTubeMusic({ baseUrl: 'http://127.0.0.1:1' });
      const gate = youTubeGate({ youTube, whitelist: list, catalog: { artistIdsOf: () => [night] } });
      const url = youTube.trackUrl('aaaaaaaaaaa');
      assert.equal(await gate(url), undefined, 'a listed artist’s song goes');
      list.block('The Night Owls');
      assert.match((await gate(url)) ?? '', /you blocked its artist/);
    });
  });

  describe('across restarts and when the server comes back', () => {
    test('the decisions are kept apart from Zemer’s list and survive a restart with the server still locked', async () => {
      const state = memory();
      const list = await frozenList({ state });
      list.consider(newcomer, 'Newcomer Band');
      list.consider(stranger, 'Another Newcomer');
      list.allow('Newcomer Band');
      list.block('The Night Owls');
      assert.ok(state.kept.has('zemer.whitelist.owner'));

      const again = make({ state });
      assert.deepEqual(again.owner, { allowed: 1, blocked: 1, waiting: 1 });
      assert.equal(again.allows('x', [newcomer]), true);
      assert.equal(again.allows('x', [night]), false);
      assert.deepEqual(again.pending(), [{ id: stranger, name: 'Another Newcomer' }]);
      await again.ready();
      assert.equal(again.frozen, true, 'the lock is met again at once');

      state.kept.set('zemer.whitelist.owner', 'not json');
      assert.deepEqual(make({ state }).owner, { allowed: 0, blocked: 0, waiting: 0 }, 'a damaged copy is ignored');
    });

    test('when the server answers again its list is the base once more, and the decisions stay on top', async () => {
      const state = memory();
      let clock = 1_000_000;
      const list = await frozenList({ state, now: () => clock });
      list.consider(newcomer, 'Newcomer Band');
      list.consider(stranger, 'Another Newcomer');
      list.allow('Another Newcomer');
      list.block('Mira Vale');

      // Zemer adds Newcomer Band itself (and flags them), the lock lifts.
      content.refusing = false;
      content.publish((artists) => {
        artists.push({ id: newcomer, name: 'Newcomer Band', female: true });
      });
      clock += 4 * 60 * 60_000;
      await list.ready();
      assert.equal(list.frozen, false);
      assert.deepEqual(list.verdict('x', [newcomer]), { ok: false, why: 'female' }, 'Zemer’s flag now decides for an artist it knows');
      assert.deepEqual(list.pending(), [], 'nobody Zemer knows is waiting any more');
      assert.equal(list.allows('x', [stranger]), true, 'an allow stays for an artist Zemer still lacks');
      assert.equal(list.allows('x', [artistId('Mira Vale')]), false, 'a block stays');
    });
  });
});

describe('Zemer’s new releases while the list is frozen', () => {
  let feed: MockZemerReleases;
  let content: MockZemerContent;
  const WHEN = new Date(2026, 9, 28, 12);
  const row = (artist: string, slug: string, title: string): MockFeedRelease => ({
    artistId: artistId(artist),
    artistName: artist,
    title,
    browseId: `MPREb_${slug}`,
    playlistId: `OLAK5uy_${slug}`,
    thumbnail: `https://yt3.googleusercontent.com/${slug}=w544-h544-l90-rj`,
    year: 2026,
    uploadDate: WHEN.toISOString(),
    trackCount: 1,
    sampleVideoId: `v${slug}`.padEnd(11, '0').slice(0, 11),
  });
  const KNOWN = row('The Night Owls', 'owls', 'Midnight');
  const NEW = row('Newcomer Band', 'newcomer', 'First Song');

  before(async () => {
    feed = await startMockZemerReleases([KNOWN, NEW]);
    content = await startMockZemerContent(LISTED);
  });
  after(async () => {
    await Promise.all([feed.close(), content.close()]);
  });

  let catalog: Catalog;
  beforeEach(() => {
    feed.reset([KNOWN, NEW]);
    content.reset(LISTED);
    catalog = new Catalog(':memory:');
  });
  afterEach(() => catalog.close());

  async function setUp() {
    const whitelist = new ZemerWhitelist({ baseUrl: content.url, checkEveryMs: 0, retryAfterMs: 0 });
    await whitelist.ready();
    content.refusing = true;
    await whitelist.ready();
    const logs: string[] = [];
    const releases = createNewReleases({ feed: new ZemerReleases({ url: `${feed.url}/?page=zemer_releases` }), whitelist, catalog, log: (line) => logs.push(line), now: () => new Date(2026, 9, 29, 10) });
    return { whitelist, releases, logs };
  }

  test('an artist the frozen list does not know waits, their release stays out, and allowing them brings it in', async () => {
    const { whitelist, releases, logs } = await setUp();
    const first = await releases.sync(0);
    assert.ok(first.ok);
    assert.deepEqual(releases.list().map((release) => release.title), ['Midnight'], 'only the listed artist’s release is in "new"');
    assert.deepEqual(whitelist.pending(), [{ id: artistId('Newcomer Band'), name: 'Newcomer Band' }]);
    assert.ok(logs.some((line) => /1 artist .*wait/.test(line)), JSON.stringify(logs));

    assert.equal(whitelist.allow('Newcomer Band').length, 1);
    const second = await releases.sync(0);
    assert.ok(second.ok);
    assert.deepEqual(releases.list().map((release) => release.title).sort(), ['First Song', 'Midnight']);
    assert.ok(second.ok && second.fresh.some((release) => release.title === 'First Song'), 'their release counts as new once allowed');
  });

  test('a blocked artist’s releases leave "new", and a feed with a bad artist id cannot make anyone wait', async () => {
    const { whitelist, releases } = await setUp();
    await releases.sync(0);
    assert.equal(releases.list().length, 1);
    whitelist.block('The Night Owls');
    assert.deepEqual(releases.list(), []);

    feed.publish((rows) => rows.push({ ...row('Bad Id', 'bad', 'Bad'), artistId: '<script>alert(1)</script>' }));
    await releases.sync(0);
    assert.deepEqual(whitelist.pending().map((artist) => artist.name), ['Newcomer Band']);
  });

  test('with Zemer’s server answering, nobody waits: its list decides', async () => {
    const whitelist = new ZemerWhitelist({ baseUrl: content.url, checkEveryMs: 0, retryAfterMs: 0 });
    const releases = createNewReleases({ feed: new ZemerReleases({ url: `${feed.url}/?page=zemer_releases` }), whitelist, catalog, now: () => new Date(2026, 9, 29, 10) });
    await releases.sync(0);
    assert.deepEqual(whitelist.pending(), []);
    assert.deepEqual(releases.list().map((release) => release.title), ['Midnight']);
  });
});

describe('the chat’s commands for the artist list', () => {
  let content: MockZemerContent;
  before(async () => {
    content = await startMockZemerContent(LISTED);
  });
  after(() => content.close());
  beforeEach(() => content.reset(LISTED));

  async function chat() {
    const whitelist = new ZemerWhitelist({ baseUrl: content.url, checkEveryMs: 0, retryAfterMs: 0 });
    await whitelist.ready();
    content.refusing = true;
    await whitelist.ready();
    whitelist.consider(newcomer, 'Newcomer Band');
    whitelist.consider(stranger, 'Another Newcomer');
    const bot = createBot({ catalog: new Catalog(':memory:'), checkAudio: async () => ({ ok: true, type: 'audio/mpeg' }), artistList: whitelist });
    return {
      whitelist,
      ask: (text: string) => bot.handle({ from: '+15551234567', messageId: 'm1', text }),
      tap: (postback: string) => bot.handle({ from: '+15551234567', messageId: 'm2', postback }),
    };
  }

  test('"pending" lists who is waiting, one 🎤 line each to 👍, and says plainly what a 👍 means', async () => {
    const { ask } = await chat();
    for (const word of ['pending', 'Waiting', 'artists pending']) {
      const replies = await ask(word);
      const lines = textReplies(replies).filter((reply) => reply.postback);
      assert.deepEqual(lines.map((line) => line.text), ['🎤 Newcomer Band', '🎤 Another Newcomer'], word);
      assert.deepEqual(lines.map((line) => line.postback), [`allow:${newcomer}`, `allow:${stranger}`]);
      const last = textReplies(replies).at(-1)!;
      assert.match(last.text, /only if that artist is a man/);
      assert.deepEqual(last.chips?.map((chip) => chip.postback), [`allow:${newcomer}`, `allow:${stranger}`]);
      assert.ok(last.chipsValidMs && last.chipsValidMs > 0);
    }
  });

  test('"pending" with nobody waiting says so', async () => {
    const { ask, whitelist } = await chat();
    whitelist.block('Newcomer Band');
    whitelist.block('Another Newcomer');
    assert.deepEqual(texts(await ask('pending')), ['No artists are waiting for your word.']);
  });

  test('a 👍 on a name, or "allow" and the name, lets their songs through', async () => {
    const { ask, tap, whitelist } = await chat();
    const thumbs = texts(await tap(`allow:${newcomer}`));
    assert.match(thumbs[0]!, /^✅ Newcomer Band: their songs come through now/);
    assert.equal(whitelist.allows('x', [newcomer]), true);

    const typed = texts(await ask('allow another newcomer'));
    assert.match(typed[0]!, /^✅ Another Newcomer/);
    assert.equal(whitelist.allows('x', [stranger]), true);
  });

  test('"allow" and "block" without a name, or with one that means nobody, explain rather than guess', async () => {
    const { ask, whitelist } = await chat();
    assert.match(texts(await ask('allow'))[0]!, /Text "allow" and the name/);
    assert.match(texts(await ask('block'))[0]!, /Text "block" and the name/);
    assert.match(texts(await ask('allow Somebody Else'))[0]!, /I'm not holding anyone called "Somebody Else"\. Text "pending"/);
    assert.match(texts(await ask('block Somebody Else'))[0]!, /I don't know an artist called "Somebody Else"/);
    assert.equal(whitelist.owner.allowed, 0);
    assert.equal(whitelist.owner.blocked, 0);
  });

  test('"block" hides an artist and says how to undo it', async () => {
    const { ask, whitelist } = await chat();
    const said = texts(await ask('block The Night Owls'));
    assert.match(said[0]!, /^🚫 Blocked The Night Owls: none of their songs will come through\. Text "allow The Night Owls" to undo that\./);
    assert.equal(whitelist.allows('x', [night]), false);
    assert.match(texts(await ask('allow the night owls'))[0]!, /^✅ The Night Owls/);
    assert.equal(whitelist.allows('x', [night]), true);
  });

  test('a name in Hebrew letters is taken as typed', async () => {
    const { ask, whitelist } = await chat();
    whitelist.consider(artistId('Hebrew Newcomer'), 'Beri Weber - בערי וובר');
    assert.match(texts(await ask('allow בערי וובר'))[0]!, /^✅ Beri Weber - בערי וובר/);
  });

  test('the commands are not there without an artist list, and the help says so only when they are', async () => {
    const bare = createBot({ catalog: new Catalog(':memory:'), checkAudio: async () => ({ ok: true, type: 'audio/mpeg' }) });
    const answer = texts(await bare.handle({ from: '+1', messageId: 'm', text: 'block Somebody' }));
    assert.match(answer[0]!, /start with "search"/, 'it is taken for a message that is not a command');
    assert.doesNotMatch(texts(await bare.handle({ from: '+1', messageId: 'm', text: 'help' }))[0]!, /pending/);
    const { ask } = await chat();
    assert.match(texts(await ask('help'))[0]!, /pending — artists waiting for your OK · allow \/ block <artist>/);
  });

  test('a song held back because of a block is worded for the owner, who can lift it, and plainly for a chat without the list, which cannot', async () => {
    const reason = 'you blocked its artist (text "allow" and their name to undo that)';
    const catalog = new Catalog(':memory:');
    const song = catalog.add({ title: 'Blue Horizon', artist: 'The Night Owls', url: 'https://music.youtube.com/watch?v=blue0000001', artistIds: [night] });
    const refuse = async () => ({ ok: false as const, reason });
    const owner = createBot({ catalog, checkAudio: refuse, artistList: new ZemerWhitelist({ baseUrl: 'http://127.0.0.1:1', checkEveryMs: 0, retryAfterMs: 0 }) });
    const bare = createBot({ catalog, checkAudio: refuse });
    const ask = async (bot: typeof owner) => texts(await bot.handle({ from: '+1', messageId: 'm', postback: `play:${song.id}` }));
    assert.deepEqual(await ask(owner), [`I can't send "The Night Owls — Blue Horizon": ${reason}.`]);
    const plain = await ask(bare);
    assert.deepEqual(plain, [`I can't send "The Night Owls — Blue Horizon": its artist isn't one I send.`]);
    assert.doesNotMatch(plain.join(' '), /allow|you blocked/);
  });

  test('the message about waiting artists is the same one "pending" gives', () => {
    const replies = waitingArtistsReplies([{ id: newcomer, name: 'Newcomer Band' }]);
    assert.match(texts(replies)[0]!, /^Zemer has an artist on its list that I can't check/);
    assert.equal(textReplies(replies).filter((reply) => reply.postback).length, 1);
  });
});

describe('telling the owner about waiting artists', () => {
  const A = { id: newcomer, name: 'Newcomer Band' };
  const B = { id: stranger, name: 'Another Newcomer' };

  function notice(options: { waiting?: Array<{ id: string; name: string }>; ready?: () => boolean; quiet?: Parameters<typeof createWaitingNotice>[0]['quiet']; fail?: boolean; now?: Date } = {}) {
    const state = memory();
    const sent: Reply[][] = [];
    const logs: string[] = [];
    let waiting = options.waiting ?? [A];
    let failing = options.fail ?? false;
    const make = () =>
      createWaitingNotice({
        list: { pending: () => waiting },
        state,
        announce: async (replies) => {
          if (failing) throw new Error('the bridge is not connected');
          sent.push(replies);
        },
        ...(options.ready ? { ready: options.ready } : {}),
        quiet: options.quiet,
        now: () => options.now ?? new Date(2026, 10, 6, 12, 0),
        log: (line) => logs.push(line),
      });
    return { state, sent, logs, make, setWaiting: (next: typeof waiting) => (waiting = next), setFailing: (next: boolean) => (failing = next) };
  }

  test('says it once, then only about an artist it has not told about', async () => {
    const { make, sent, setWaiting } = notice();
    const check = make();
    await check();
    await check();
    assert.equal(sent.length, 1);
    assert.match(texts(sent[0]!)[0]!, /Zemer has an artist on its list/);

    setWaiting([A, B]);
    await check();
    assert.equal(sent.length, 2, 'a new artist is news');
    assert.ok(texts(sent[1]!).some((line) => line.includes('Another Newcomer')));

    setWaiting([B]);
    await check();
    assert.equal(sent.length, 2, 'one of them being decided is not news');
  });

  test('remembers across restarts, and says nothing when nobody is waiting', async () => {
    const { make, sent, setWaiting } = notice();
    await make()();
    await make()();
    assert.equal(sent.length, 1, 'a restart does not say it again');
    setWaiting([]);
    await make()();
    assert.equal(sent.length, 1);
  });

  test('waits for the quiet hours to end and for the chat to be able to take it', async () => {
    const quiet = { from: { hour: 22, minute: 0 }, to: { hour: 7, minute: 0 } };
    const night = notice({ quiet, now: new Date(2026, 10, 6, 23, 30) });
    await night.make()();
    assert.equal(night.sent.length, 0);

    let up = false;
    const down = notice({ ready: () => up });
    const check = down.make();
    await check();
    assert.equal(down.sent.length, 0);
    up = true;
    await check();
    assert.equal(down.sent.length, 1);
  });

  test('a send that fails is tried again at the next check, and never throws', async () => {
    const { make, sent, logs, setFailing } = notice({ fail: true });
    const check = make();
    await check();
    assert.equal(sent.length, 0);
    assert.ok(logs.some((line) => /could not tell the owner/.test(line)));
    setFailing(false);
    await check();
    assert.equal(sent.length, 1);
  });
});

// From 2026-11-08 the bot does not ask Zemer's content server at all unless ZEMER_CONTENT_URL is set: it was not going to open
// again, and every ask only ended in a refusal and a mailed problem. The saved copy is the list and the owner keeps it current.
describe('Zemer’s artist list when the bot no longer asks Zemer’s server', () => {
  let content: MockZemerContent;
  before(async () => {
    content = await startMockZemerContent(LISTED);
  });
  after(() => content.close());
  beforeEach(() => content.reset(LISTED));

  /** A saved copy, as an earlier run that could still read the list left it. */
  async function savedCopy() {
    const state = memory();
    await new ZemerWhitelist({ baseUrl: content.url, state, checkEveryMs: 0, retryAfterMs: 0 }).ready();
    content.requests = [];
    return state;
  }

  test('filters with the saved copy and never makes a request, however long it runs', async () => {
    let clock = 1_000_000;
    const state = await savedCopy();
    const list = new ZemerWhitelist({ baseUrl: content.url, state, offline: true, checkEveryMs: 0, now: () => clock });
    assert.equal(list.offline, true);
    assert.equal(list.frozen, true, 'new artists wait for the owner, as with a locked server');
    await list.ready();
    clock += 30 * 24 * 60 * 60_000;
    await list.ready();
    await list.warm();
    assert.equal(list.allows('x', [night]), true);
    assert.equal(list.allows('x', [rina]), false, 'Zemer’s female flag in the saved copy still holds');
    assert.equal(list.allows('x', [newcomer]), false, 'anyone it does not know is hidden');
    assert.equal(content.requests.length, 0, 'Zemer’s server was not asked');
  });

  test('watching reports nothing and asks nothing, so no problem is ever raised', async () => {
    const state = await savedCopy();
    const list = new ZemerWhitelist({ baseUrl: content.url, state, offline: true });
    const outcomes: Array<string | undefined> = [];
    const stop = list.watch((error) => outcomes.push(error), 10);
    await new Promise((resolve) => setTimeout(resolve, 80));
    stop();
    assert.deepEqual(outcomes, []);
    assert.equal(content.requests.length, 0);
  });

  test('the console’s refresh buttons say so instead of asking, forced or not', async () => {
    const state = await savedCopy();
    const list = new ZemerWhitelist({ baseUrl: content.url, state, offline: true });
    for (const force of [false, true]) {
      const done = await list.refreshNow({ force });
      assert.equal(done.ok, false);
      assert.equal(done.skipped, true);
      assert.match(done.message, /no longer asks Zemer's server/);
    }
    assert.equal(content.requests.length, 0);
    const report = list.report();
    assert.equal(report.offline, true);
    assert.equal(report.frozen, true);
    assert.equal(report.nextAttemptAt, null);
    assert.equal(report.size.artists, LISTED.length);
  });

  test('with no saved copy there is no list, said plainly and without asking', async () => {
    const list = new ZemerWhitelist({ baseUrl: content.url, state: memory(), offline: true });
    await assert.rejects(list.ready(), (err: unknown) => err instanceof ZemerWhitelistError && /no saved copy/.test(err.message) && !err.refused);
    assert.equal(list.loaded, false);
    assert.equal(content.requests.length, 0);
  });

  test('the owner still decides: a release’s artist waits, an allow lets them through, a block hides anyone', async () => {
    const state = await savedCopy();
    const list = new ZemerWhitelist({ baseUrl: content.url, state, offline: true });
    assert.equal(list.consider(newcomer, 'Newcomer Band'), true);
    assert.deepEqual(list.pending(), [{ id: newcomer, name: 'Newcomer Band' }]);
    assert.equal(list.allows('x', [newcomer]), false);
    assert.deepEqual(list.allow('Newcomer Band'), [{ id: newcomer, name: 'Newcomer Band' }]);
    assert.equal(list.allows('x', [newcomer]), true);
    list.block('The Night Owls');
    assert.equal(list.allows('x', [night]), false);
    // …and they are still there after a restart.
    const again = new ZemerWhitelist({ baseUrl: content.url, state, offline: true });
    assert.equal(again.allows('x', [newcomer]), true);
    assert.equal(again.allows('x', [night]), false);
    assert.equal(content.requests.length, 0);
  });

  test('zemerWhitelistFromEnv is offline unless ZEMER_CONTENT_URL is set, and then it asks that server', async () => {
    const state = await savedCopy();
    const idle = zemerWhitelistFromEnv({}, { state });
    assert.equal(idle.offline, true);
    await idle.ready();
    assert.equal(idle.allows('x', [night]), true);
    assert.equal(content.requests.length, 0);

    const live = zemerWhitelistFromEnv({ ZEMER_CONTENT_URL: content.url }, { checkEveryMs: 0, retryAfterMs: 0 });
    assert.equal(live.offline, false);
    assert.equal(live.frozen, false);
    await live.ready();
    assert.equal(live.allows('x', [night]), true);
    assert.ok(content.requests.includes('/whitelist/version'), 'the live one asked');
  });
});
