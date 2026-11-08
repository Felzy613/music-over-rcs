import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { AdminConsole } from '../src/admin/console.ts';
import { Catalog } from '../src/catalog.ts';
import { loadMatrixHostConfig } from '../src/config.ts';
import { addChat, removeChat, startHost, type AddChatOptions, type ChatBridge, type Host, type HostChat } from '../src/host.ts';
import type { Extension } from '../src/extensions.ts';
import { OWNER, personOf } from '../src/people.ts';
import { PERSON_STARTUP_TEXT, STARTUP_TEXT } from '../src/startup-message.ts';
import { recentTimelines } from '../src/timeline.ts';
import { sentThisMonth } from '../src/usage.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';
import { listen, readBuffer, type Listening } from './helpers/servers.ts';
import { startMockMusicTable, type MockMusicTable } from './helpers/mock-music-table.ts';
import { artistId, startMockYouTubeMusic, type MockYouTubeMusic } from './helpers/mock-youtube-music.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';

// Two people on one host, each in their own chat (src/host.ts): the owner and "alice", each with a mock homeserver of their own, sharing one
// catalog, one artist list, one set of song sources and one delivery gate. What these pin: each chat gets only its own answers, nothing
// a person does with menus and picks reaches the other's, anyone but the owner has no artist-list commands, Zemer's rules hold for
// both people's results and sends, and the owner's own chat is exactly what it was before there were people.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `ready` holds (polling), or fails the test after five seconds (or `ms`). */
async function until(ready: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const LISTED: MockArtist[] = [
  { id: artistId('The Night Owls'), name: 'The Night Owls' },
  { id: artistId('Mira Vale'), name: 'Mira Vale' },
  { id: artistId('Rina Cohen'), name: 'Rina Cohen', female: true },
];
const night = artistId('The Night Owls');
const rina = artistId('Rina Cohen');

const dawn = (n: number) => ({ videoId: `dawnsong00${n}`, title: `Dawn Song ${n}`, artists: ['Mira Vale'] });
const SONGS = [
  { videoId: 'bluehorizon', title: 'Blue Horizon', artists: ['The Night Owls'], album: 'Horizons' },
  { videoId: 'bluemoon001', title: 'Blue Moon Rising', artists: ['The Night Owls'] },
  { videoId: 'paperplanes', title: 'Paper Planes at Dawn', artists: ['Mira Vale'] },
  { videoId: 'paperboats1', title: 'Paper Boats', artists: ['Mira Vale'] },
  { videoId: 'hersong0001', title: 'Blue Her Song', artists: ['Rina Cohen'] },
  { videoId: 'paperskies1', title: 'Skies One', artists: ['Mira Vale'], album: 'Paper Skies' },
  { videoId: 'paperskies2', title: 'Skies Two', artists: ['Mira Vale'], album: 'Paper Skies' },
  ...[1, 2, 3, 4, 5, 6, 7].map(dawn),
];
const ALBUMS = [
  {
    browseId: 'MPREb_horizons',
    title: 'Horizons',
    artists: ['The Night Owls'],
    year: 2024,
    tracks: [
      { videoId: 'bluehorizon', title: 'Blue Horizon' },
      { videoId: 'bluehoriz02', title: 'Blue Two' },
    ],
  },
  {
    browseId: 'MPREb_skies',
    title: 'Paper Skies',
    artists: ['Mira Vale'],
    year: 2023,
    tracks: [
      { videoId: 'paperskies1', title: 'Skies One' },
      { videoId: 'paperskies2', title: 'Skies Two' },
    ],
  },
];

/** A bridge that is fine, and one that is not (the person's login is signed out): what the chat's announcements wait for. */
const connected = (): ChatBridge => ({ check: async () => {}, sendFailed() {}, blocked: () => undefined });
const signedOut = (why = 'the bridge is not connected to Google Messages'): ChatBridge => ({ check: async () => {}, sendFailed() {}, blocked: () => why });

/** The body of a message the bot sent, with the invisible direction marks taken out. */
const body = (event: MockMatrix['sent'][number]): string => String(event.content.body ?? event.content.filename ?? '').replace(/[‎‏]/g, '');

/**
 * No test here may reach the real network. A cover picture is asked of Google's picture host (the mock YouTube Music names one), and the
 * real host does not have these made-up ones: it is answered 404, which is what skips the card, and anything else not on this
 * machine is a failure.
 */
const realFetch = globalThis.fetch;
const coverRequests: string[] = [];
const offlineFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/^http:\/\/127\.0\.0\.1[:/]/.test(url)) return realFetch(input, init);
  if (/^https:\/\/yt3\.googleusercontent\.com\//.test(url)) {
    coverRequests.push(url);
    return new Response('not found', { status: 404 });
  }
  throw new Error(`a test reached the real network: ${url}`);
}) as typeof fetch;

/** A homeserver in front of a mock one that can hold every read of the chat (/sync) until it is let go: for a chat that is slow to come up. */
async function slowReads(target: string): Promise<Listening & { hold(): void; release(): void; requests: number; reads: number }> {
  let open: Promise<void> = Promise.resolve();
  let letGo: () => void = () => {};
  const state = { requests: 0, reads: 0 };
  const proxy = await listen(async (req, res) => {
    state.requests += 1;
    const body = await readBuffer(req);
    const isRead = (req.url ?? '').includes('/sync');
    if (isRead) {
      state.reads += 1;
      await open;
    }
    const headers: Record<string, string> = {};
    for (const name of ['authorization', 'content-type']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    const answer = await realFetch(target + (req.url ?? '/'), { method: req.method ?? 'GET', headers, ...(body.length > 0 ? { body } : {}) });
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
  return {
    url: proxy.url,
    server: proxy.server,
    close: proxy.close,
    hold() {
      open = new Promise<void>((resolve) => (letGo = resolve));
    },
    release() {
      letGo();
    },
    get requests() {
      return state.requests;
    },
    get reads() {
      return state.reads;
    },
  };
}

describe('two people on one host', () => {
  let youMock: MockYouTubeMusic;
  let content: MockZemerContent;
  let site: MockMusicTable;
  let ownerMock: MockMatrix;
  let aliceMock: MockMatrix;
  let catalog: Catalog;
  let host: Host | undefined;
  let logs: string[];
  let problems: string[];

  before(async () => {
    globalThis.fetch = offlineFetch;
    youMock = await startMockYouTubeMusic(SONGS, ALBUMS);
    content = await startMockZemerContent(LISTED);
    site = await startMockMusicTable([]);
    ownerMock = await startMockMatrix(0, { eventPrefix: 'o' });
    aliceMock = await startMockMatrix(0, { eventPrefix: 'a' });
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await Promise.all([youMock.close(), content.close(), site.close(), ownerMock.close(), aliceMock.close()]);
  });
  beforeEach(() => {
    youMock.reset();
    content.reset(LISTED);
    ownerMock.reset();
    aliceMock.reset();
    catalog = new Catalog(':memory:');
    logs = [];
    problems = [];
    host = undefined;
  });
  afterEach(async () => {
    await host?.stop();
    catalog.close();
  });

  const baseEnv = (): NodeJS.ProcessEnv => ({
    YOUTUBE_MUSIC_URL: youMock.url,
    ZEMER_CONTENT_URL: content.url,
    ZEMER_SEARCH: 'off',
    MUSIC_TABLE: 'off',
    ZEMER_RELEASES: 'off',
    PREFETCH_MB: 'off',
    SONG_GAP_SECONDS: 'off',
    MATRIX_SYNC_WAIT_MS: '0',
  });

  async function start(env: NodeJS.ProcessEnv = {}, extensions: Extension[] = [], minuteMs?: number): Promise<Host> {
    const merged = { ...baseEnv(), ...env };
    // A poll every 20 ms and no long poll: the mock homeservers answer at once.
    const config = { ...loadMatrixHostConfig(merged), pollMs: 20, dbPath: ':memory:' };
    host = await startHost({
      env: merged,
      config,
      catalog,
      admin: new AdminConsole(),
      notify: async (_title, message) => void problems.push(message),
      extensions,
      online: async () => true,
      ...(minuteMs ? { minuteMs } : {}),
      log: (line) => logs.push(line),
    });
    return host;
  }

  /** What one person sees: the phone that types into their chat, and everything the bot sent there. */
  interface Side {
    chat: HostChat;
    mock: MockMatrix;
    type(text: string): string;
    like(eventId: string): void;
    bodies(): string[];
    /** The id of the first message the bot sent that contains `text`. */
    line(text: string): string;
    /** Waits until the bot has sent a message that contains `text`. */
    sees(text: string): Promise<void>;
  }
  function side(chat: HostChat, mock: MockMatrix): Side {
    return {
      chat,
      mock,
      type: (text) => mock.addMessage(mock.ghost, { msgtype: 'm.text', body: text }),
      like: (eventId) => void mock.addReaction(mock.ghost, eventId, '👍'),
      bodies: () => mock.sent.map(body),
      line(text) {
        const found = mock.sent.find((event) => body(event).includes(text));
        if (!found) assert.fail(`no message with "${text}" in ${JSON.stringify(mock.sent.map(body))}`);
        return found.eventId;
      },
      sees: (text) => until(() => mock.sent.some((event) => body(event).includes(text)), `"${text}" in ${mock.userId}'s chat`),
    };
  }

  /** Brings the owner's chat up, and alice's unless `alice: false`. */
  async function both(options: { env?: NodeJS.ProcessEnv; alice?: boolean; ownerBridge?: ChatBridge; aliceBridge?: ChatBridge; extensions?: Extension[]; aliceOptions?: Partial<AddChatOptions>; minuteMs?: number } = {}) {
    const running = await start(options.env, options.extensions, options.minuteMs);
    const owner = side(await addChat(running, OWNER, { token: ownerMock.token, roomID: ownerMock.roomId, homeserver: ownerMock.url, bridge: options.ownerBridge ?? connected() }), ownerMock);
    const alice =
      options.alice === false
        ? undefined
        : side(await addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: options.aliceBridge ?? connected(), ...options.aliceOptions }), aliceMock);
    return { host: running, owner, alice: alice! };
  }

  describe('answers', () => {
    test('each chat gets its own answers and never the other’s', async () => {
      const { owner, alice } = await both();
      owner.type('search blue');
      alice.type('search paper');
      await owner.sees('Blue Horizon');
      await alice.sees('Paper Planes at Dawn');
      assert.ok(owner.bodies().every((text) => !/Paper/.test(text)), JSON.stringify(owner.bodies()));
      assert.ok(alice.bodies().every((text) => !/Blue/.test(text)), JSON.stringify(alice.bodies()));
    });

    test('two chats are answered side by side: each gets the answers to all it asked', async () => {
      const { owner, alice } = await both();
      for (const words of ['blue horizon', 'blue moon', 'blue']) owner.type(`search ${words}`);
      for (const words of ['paper planes', 'paper boats', 'paper']) alice.type(`search ${words}`);
      await until(() => ownerMock.sent.length >= 6 && aliceMock.sent.length >= 6, 'three answers each');
      await sleep(50);
      assert.ok(owner.bodies().every((text) => !/Paper/.test(text)));
      assert.ok(alice.bodies().every((text) => !/Blue/.test(text)));
    });

    test('each person’s log lines say whose they are, and the owner’s are as they always were', async () => {
      const { owner, alice } = await both();
      owner.type('search blue');
      alice.type('search paper');
      await owner.sees('Blue Horizon');
      await alice.sees('Paper Planes at Dawn');
      await until(() => logs.some((line) => /^timeline: "search blue"/.test(line)) && logs.some((line) => /^timeline: \[alice\] "search paper"/.test(line)), 'both timelines');
      assert.ok(logs.some((line) => /^<- "search blue"/.test(line)));
      assert.ok(logs.some((line) => /^\[alice\] <- "search paper"/.test(line)));
      assert.ok(logs.every((line) => !/^\[owner\]|\bowner\] /.test(line)), 'the owner is never tagged');
      assert.ok(logs.some((line) => /^signed in as @me:localhost, watching room !portal:localhost, \d+ tracks in :memory:, Zemer off/.test(line)));
      assert.ok(logs.some((line) => /^\[alice\] signed in as @me:localhost, watching room !portal:localhost\. Text "search"/.test(line)));
      const seen = recentTimelines.list();
      assert.ok(seen.some((line) => /timeline: \[alice\] "search paper"/.test(line)));
      assert.ok(seen.some((line) => / timeline: "search blue"/.test(line)));
    });
  });

  describe('what each person keeps apart', () => {
    test('a number picks from your own menu, not the other person’s', async () => {
      const { owner, alice } = await both();
      owner.type('search horizons');
      await owner.sees('💿 1. Horizons');
      // Alice has no menu of her own yet: the owner's number is not hers.
      alice.type('1');
      await alice.sees('Start each message with a command');
      assert.ok(alice.bodies().every((text) => !/Horizons/.test(text)), JSON.stringify(alice.bodies()));
      alice.type('search paper skies');
      await alice.sees('💿 1. Paper Skies');
      owner.type('1');
      alice.type('1');
      await owner.sees('Blue Two');
      await alice.sees('Skies Two');
      assert.ok(owner.bodies().every((text) => !/Skies/.test(text)), JSON.stringify(owner.bodies()));
      assert.ok(alice.bodies().every((text) => !/Horizons|Blue/.test(text) || /Paper/.test(text)), JSON.stringify(alice.bodies()));
    });

    test('the state is kept under the owner’s old keys and under alice’s own', async () => {
      const { owner, alice } = await both();
      owner.type('search blue');
      alice.type('search paper');
      await owner.sees('Blue Horizon');
      await alice.sees('Paper Planes at Dawn');
      await until(() => catalog.getState('chat.resume:alice') !== undefined && catalog.getState('chat.resume') !== undefined, 'both resume points');
      for (const key of ['chat.resume', 'chat.view', 'chat.choices', 'chat.resume:alice', 'chat.view:alice', 'chat.choices:alice']) {
        assert.ok(catalog.getState(key), `${key} is kept`);
      }
      assert.equal(catalog.getState('chat.view:owner'), undefined, 'the owner has no suffixed key');
      assert.equal(catalog.getState('chat.resume:owner'), undefined);
      assert.notEqual(catalog.getState('chat.view'), catalog.getState('chat.view:alice'));
      // A view belongs to one chat: the other can't open it.
      const mine = Number(JSON.parse(catalog.getState('chat.view')!));
      const hers = Number(JSON.parse(catalog.getState('chat.view:alice')!));
      assert.ok(catalog.view(mine, '') && !catalog.view(mine, 'alice'));
      assert.ok(catalog.view(hers, 'alice') && !catalog.view(hers, ''));
    });

    test('“songs more” goes on from your own search, and “zip” opens only your own album', async () => {
      const { owner, alice } = await both();
      owner.type('search dawn');
      await owner.sees('Dawn Song');
      const first = owner.bodies().filter((text) => /Dawn Song \d/.test(text)).length;
      assert.ok(first > 0);
      alice.type('songs more');
      await until(() => alice.mock.sent.length >= 1, 'an answer for alice');
      assert.ok(alice.bodies().every((text) => !/Dawn Song/.test(text)), `alice was not shown the owner’s list: ${JSON.stringify(alice.bodies())}`);
      owner.type('songs more');
      await until(() => owner.bodies().filter((text) => /Dawn Song \d/.test(text)).length > first, 'more of the owner’s list');

      // An album opened by the owner is not alice’s to zip.
      owner.type('search horizons');
      await owner.sees('💿 1. Horizons');
      owner.type('1');
      await owner.sees('All 2 songs as one zip');
      alice.type('zip');
      await alice.sees('Open an album first');
      owner.type('zip');
      await until(() => ownerMock.uploads.some((upload) => /\.zip$/.test(upload.fileName ?? '')), 'the owner’s zip');
      assert.equal(aliceMock.uploads.length, 0);
    });

    test('a 👍 on an older menu goes back to that menu in your chat only', async () => {
      const { owner, alice } = await both();
      owner.type('search blue');
      await owner.sees('Blue Horizon');
      const older = owner.line('Blue Horizon');
      alice.type('search paper');
      await alice.sees('Paper Planes at Dawn');
      const aliceView = catalog.getState('chat.view:alice');
      owner.type('search paper boats');
      await owner.sees('Paper Boats');
      // The owner taps the song on the older menu: it is the owner’s, and it is sent to the owner.
      owner.like(older);
      await until(() => ownerMock.uploads.length === 1, 'the owner’s song');
      assert.match(ownerMock.uploads[0]!.fileName ?? '', /Blue Horizon/);
      assert.equal(aliceMock.uploads.length, 0);
      assert.equal(catalog.getState('chat.view:alice'), aliceView, 'alice’s place in her menus did not move');
    });

    test('a request typed in both chats in the same words is linked to each chat’s own menu', async () => {
      const { owner, alice } = await both();
      owner.type('search blue horizon');
      alice.type('search blue horizon');
      await owner.sees('Blue Horizon');
      await alice.sees('Blue Horizon');
      const text = '🎵 Blue Horizon — The Night Owls';
      const key = `text:${text}`;
      const mine = catalog.linkedPostback(key);
      const hers = catalog.linkedPostback(`text@alice:${text}`);
      assert.match(mine ?? '', /^play:\d+@\d+$/);
      assert.match(hers ?? '', /^play:\d+@\d+$/);
      assert.notEqual(mine, hers, 'the same words stand for each person’s own view');
    });
  });

  describe('commands only the owner has', () => {
    test('allow, block and pending are not commands for anyone else, and change nothing', async () => {
      const { owner, alice, host: running } = await both();
      alice.type('pending');
      alice.type('allow The Night Owls');
      alice.type('block The Night Owls');
      await until(() => aliceMock.sent.length >= 3, 'three answers');
      for (const text of alice.bodies()) assert.match(text, /To look for a song, start with "search"/);
      assert.deepEqual(running.whitelist!.ownerArtists().blocked, []);
      assert.equal(running.whitelist!.owner.blocked, 0);
      // A tap on an "allow" line is the same: help, and nothing allowed.
      const reply = await alice.chat.bot.handle({ from: 'alice', messageId: 'x', postback: `allow:${night}` });
      assert.equal(reply.length, 1);
      const only = reply[0];
      assert.match(only?.kind === 'text' ? only.text : '', /search/);
      assert.equal(running.whitelist!.owner.allowed, 0);
      // Her searches still find the artist, and the owner has the commands.
      alice.type('search blue');
      await alice.sees('Blue Horizon');
      owner.type('pending');
      await owner.sees('No artists are waiting for your word.');
    });

    test('the help names the artist-list commands to the owner and to no one else', async () => {
      const { owner, alice } = await both();
      owner.type('help');
      alice.type('help');
      await owner.sees('Start each message with a command');
      await alice.sees('Start each message with a command');
      const ownersHelp = owner.bodies().find((text) => /Start each message/.test(text)) ?? '';
      const alicesHelp = alice.bodies().find((text) => /Start each message/.test(text)) ?? '';
      assert.match(ownersHelp, /pending/);
      assert.match(ownersHelp, /block/);
      assert.doesNotMatch(alicesHelp, /pending|allow|block/);
    });

    test('the owner’s block takes the artist out of both people’s next searches', async () => {
      const { owner, alice } = await both();
      owner.type('block The Night Owls');
      await owner.sees('Blocked The Night Owls');
      alice.type('search blue');
      owner.type('search blue');
      await until(() => aliceMock.sent.length >= 1 && ownerMock.sent.length >= 2, 'an answer each');
      await sleep(100);
      assert.ok(alice.bodies().every((text) => !/Night Owls/.test(text)), JSON.stringify(alice.bodies()));
      assert.ok(owner.bodies().filter((text) => !/Blocked/.test(text)).every((text) => !/Night Owls/.test(text)), JSON.stringify(owner.bodies()));
    });

    test('a song found before the owner blocked its artist is refused at the send, in either chat', async () => {
      const { owner, alice } = await both();
      owner.type('search blue horizon');
      alice.type('search blue horizon');
      await owner.sees('Blue Horizon');
      await alice.sees('Blue Horizon');
      const hers = alice.line('Blue Horizon');
      const mine = owner.line('Blue Horizon');
      owner.type('block The Night Owls');
      await owner.sees('Blocked The Night Owls');
      alice.like(hers);
      owner.like(mine);
      await alice.sees("I can't send");
      await owner.sees("I can't send");
      // The owner is told who blocked it and how to undo that; anyone else can't undo it, so their refusal says only that it isn't sent.
      const mine2 = owner.bodies().find((text) => /I can't send/.test(text)) ?? '';
      const hers2 = alice.bodies().find((text) => /I can't send/.test(text)) ?? '';
      assert.match(mine2, /you blocked its artist \(text "allow" and their name to undo that\)/);
      assert.match(hers2, /its artist isn't one I send/);
      assert.ok(!/allow|you blocked/.test(hers2), hers2);
      assert.equal(aliceMock.uploads.length, 0, 'nothing was sent to alice');
      assert.equal(ownerMock.uploads.length, 0, 'nothing was sent to the owner either');
    });

    test('both bots are given the same checked sources: a woman’s song is refused for both, even when it is already in the catalog', async () => {
      const { owner, alice, host: running } = await both();
      const stored = catalog.add({ title: 'Blue Her Song', artist: 'Rina Cohen', url: 'https://music.youtube.com/watch?v=hersong0001', artistIds: [rina] });
      for (const who of [owner, alice]) {
        const answer = await who.chat.bot.handle({ from: 'x', messageId: 'x', postback: `play:${stored.id}` });
        assert.ok(answer.every((reply) => reply.kind !== 'audio'), `${who.chat.person.id} was not given the song`);
      }
      // And the host's own check is the one both use.
      assert.equal((await running.checkAudio(stored.url)).ok, false);
    });

    test('the assistant of an add-on is the owner’s: for anyone else its word is not a command', async () => {
      const asked: string[] = [];
      const extension: Extension = {
        name: 'helper',
        assistant: { word: 'jarvis', name: 'Jarvis', forward: async (text) => void asked.push(text) },
      };
      const { owner, alice } = await both({ extensions: [extension] });
      alice.type('jarvis play something');
      await alice.sees('To look for a song');
      assert.deepEqual(asked, []);
      owner.type('jarvis play something');
      await until(() => asked.length === 1, 'the assistant hears the owner');
      assert.equal(asked[0], 'play something');
    });
  });

  describe('the owner’s chat, as it was', () => {
    test('with no one else on the host, the state keys, the hello and the log line are the old ones', async () => {
      const { owner } = await both({ alice: false, env: { STARTUP_MESSAGE: 'once' } });
      owner.type('search blue');
      await owner.sees('Blue Horizon');
      await owner.sees(STARTUP_TEXT);
      await until(() => catalog.getState('hello.sent') !== undefined, 'the hello is recorded');
      for (const key of ['chat.resume', 'chat.view', 'chat.choices', 'hello.sent']) assert.ok(catalog.getState(key), `${key} is kept`);
      assert.ok(logs.some((line) => /^signed in as @me:localhost, watching room !portal:localhost, \d+ tracks in :memory:, Zemer off \(YouTube Music search instead\), music-table\.com off, no songs kept ready\. Text "search" and a song name in that chat\.$/.test(line)), logs.join('\n'));
      assert.equal(logs.filter((line) => /^\[/.test(line)).length, 0, 'no line is tagged');
      assert.equal(host!.chats.size, 1);
    });

    test('each person is told hello once, in their own words, under their own key', async () => {
      const { owner, alice } = await both({ env: { STARTUP_MESSAGE: 'once' } });
      await owner.sees(STARTUP_TEXT);
      await alice.sees(PERSON_STARTUP_TEXT);
      assert.ok(alice.bodies().every((text) => !text.includes('your Mac')), 'nothing about the owner’s Mac');
      await until(() => catalog.getState('hello.sent') !== undefined && catalog.getState('hello.sent:alice') !== undefined, 'both hellos are recorded');
      assert.equal(owner.bodies().filter((text) => text.includes(STARTUP_TEXT)).length, 1);
      assert.equal(owner.bodies().filter((text) => text.includes(PERSON_STARTUP_TEXT)).length, 0);

      // A new start with the same catalog says nothing more to either.
      await host!.stop();
      ownerMock.reset();
      aliceMock.reset();
      const again = await both({ env: { STARTUP_MESSAGE: 'once' } });
      await sleep(150);
      assert.deepEqual(again.owner.bodies(), []);
      assert.deepEqual(again.alice.bodies(), []);
    });

    test('a person added later is told hello when their chat comes up, not before', async () => {
      const { owner } = await both({ alice: false, env: { STARTUP_MESSAGE: 'once' } });
      await owner.sees(STARTUP_TEXT);
      assert.equal(catalog.getState('hello.sent:alice'), undefined);
      const alice = side(await addChat(host!, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() }), aliceMock);
      await alice.sees(PERSON_STARTUP_TEXT);
    });
  });

  describe('what is sent, and counted', () => {
    test('a song goes only to the chat that asked, and is counted for that person alone', async () => {
      const { owner, alice } = await both();
      owner.type('search blue horizon');
      alice.type('search paper planes');
      await owner.sees('Blue Horizon');
      await alice.sees('Paper Planes at Dawn');
      alice.like(alice.line('Paper Planes at Dawn'));
      await until(() => aliceMock.uploads.length === 1, 'alice’s song');
      assert.equal(ownerMock.uploads.length, 0);
      await until(() => sentThisMonth(catalog, new Date(), 'alice') > 0, 'alice’s bytes to be counted');
      assert.equal(sentThisMonth(catalog), 0, 'the owner has sent nothing');
      owner.like(owner.line('Blue Horizon'));
      await until(() => ownerMock.uploads.length === 1 && sentThisMonth(catalog) > 0, 'the owner’s song to be counted');
      assert.equal(aliceMock.uploads.length, 1);
      assert.equal(sentThisMonth(catalog, new Date(), 'alice'), aliceMock.uploads[0]!.bytes.length, 'alice’s count is her own file');
      assert.equal(sentThisMonth(catalog), ownerMock.uploads[0]!.bytes.length, 'and the owner’s is the owner’s');
      assert.ok(catalog.getState(`usage.${new Date().toISOString().slice(0, 7)}.alice.sent_bytes`), 'under her own key');
    });

    test('plays and follows are each person’s own', async () => {
      catalog.add({ title: 'Old Hit', artist: 'Mendy Weiss', url: 'https://x.test/old-hit.mp3' });
      const { owner, alice } = await both();
      // Alice plays a song: it counts for her, and not for the owner.
      alice.type('search paper planes');
      await alice.sees('Paper Planes at Dawn');
      alice.like(alice.line('Paper Planes at Dawn'));
      await until(() => aliceMock.uploads.length === 1, 'alice’s song');
      const mira = catalog.findArtist(['mira', 'vale'])!;
      assert.ok(mira, 'the song’s artist is in the catalog');
      assert.equal(catalog.playedSongsBy(mira.id, 'alice'), 1);
      assert.equal(catalog.playedSongsBy(mira.id), 0, 'the owner has not played it');
      // Following is kept per chat, and one person’s unfollow is not the other’s.
      alice.type('follow mendy weiss');
      await alice.sees('Mendy Weiss');
      assert.deepEqual(catalog.followed('alice').map((artist) => artist.name), ['Mendy Weiss']);
      assert.deepEqual(catalog.followed(), []);
      owner.type('follow mendy weiss');
      await owner.sees('Mendy Weiss');
      assert.deepEqual(catalog.followed().map((artist) => artist.name), ['Mendy Weiss']);
      alice.type('unfollow mendy weiss');
      await until(() => catalog.followed('alice').length === 0, 'alice’s unfollow');
      assert.deepEqual(catalog.followed().map((artist) => artist.name), ['Mendy Weiss'], 'the owner still follows');
    });

    test('songs are not copied to the owner’s OneDrive for anyone else', async () => {
      const { owner, alice, host: running } = await both({ env: { ONEDRIVE_CLIENT_ID: '00000000-0000-0000-0000-000000000000' } });
      const offered: string[] = [];
      const archive = running.library.archive!;
      assert.ok(archive, 'the owner has an archive');
      archive.offer = (url) => void offered.push(url);
      alice.type('search paper planes');
      owner.type('search blue horizon');
      await alice.sees('Paper Planes at Dawn');
      await owner.sees('Blue Horizon');
      alice.like(alice.line('Paper Planes at Dawn'));
      await until(() => aliceMock.uploads.length === 1, 'alice’s song');
      assert.deepEqual(offered, [], 'alice’s song was not offered');
      owner.like(owner.line('Blue Horizon'));
      await until(() => ownerMock.uploads.length === 1, 'the owner’s song');
      assert.equal(offered.length, 1, 'the owner’s was');
      assert.match(offered[0]!, /bluehorizon/);
    });

    test('a person’s monthly share is theirs: past it they get a word instead of a song, and the owner still gets songs', async () => {
      const { owner, alice } = await both({ env: { PERSON_MAX_MB_PER_MONTH: '0' } });
      alice.type('search paper planes');
      owner.type('search blue horizon');
      await alice.sees('Paper Planes at Dawn');
      await owner.sees('Blue Horizon');
      alice.like(alice.line('Paper Planes at Dawn'));
      owner.like(owner.line('Blue Horizon'));
      await alice.sees("this month's share of songs");
      await until(() => ownerMock.uploads.length === 1, 'the owner’s song');
      assert.equal(aliceMock.uploads.length, 0);
    });

    test('the host is sending between two songs of an answer too, while the gap is waited outside the gate', async () => {
      const { owner, host: running } = await both({ alice: false, env: { SONG_GAP_SECONDS: '1' } });
      owner.type('search dawn');
      await owner.sees('Dawn Song');
      owner.type('all');
      await until(() => ownerMock.uploads.length >= 1 && !running.gate.busy(), 'the first song up and the gate free');
      assert.equal(running.gate.busy(), false);
      assert.equal(running.sending(), true, 'the answer is not over: OneDrive copies keep waiting');
    });

    test('one file at a time on the whole host: nothing is uploaded to either chat while another unit holds the gate', async () => {
      const { owner, alice, host: running } = await both();
      owner.type('search blue horizon');
      alice.type('search paper planes');
      await owner.sees('Blue Horizon');
      await alice.sees('Paper Planes at Dawn');
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const holding = running.gate.run('someone-else', () => held);
      assert.equal(running.sending(), true, 'the host is sending while the gate is held');
      owner.like(owner.line('Blue Horizon'));
      alice.like(alice.line('Paper Planes at Dawn'));
      await sleep(250);
      assert.equal(ownerMock.uploads.length + aliceMock.uploads.length, 0, 'the gate is shared');
      release();
      await holding;
      await until(() => ownerMock.uploads.length === 1 && aliceMock.uploads.length === 1, 'both songs once the gate is free');
      await until(() => !running.sending(), 'the host to be idle');
    });
  });

  describe('coming and going', () => {
    test('a person can be taken off the host: nothing more is answered to them, and the owner carries on', async () => {
      const { owner, alice, host: running } = await both();
      alice.type('search paper');
      await alice.sees('Paper Planes at Dawn');
      assert.equal(await removeChat(running, 'alice'), true);
      assert.equal(running.chats.has('alice'), false);
      assert.equal(await removeChat(running, 'alice'), false, 'nothing to remove the second time');
      const heard = aliceMock.sent.length;
      alice.type('search paper boats');
      owner.type('search blue');
      await owner.sees('Blue Horizon');
      await sleep(150);
      assert.equal(aliceMock.sent.length, heard);
      // Coming back, she is answered what she asked while she was away.
      await addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() });
      await alice.sees('Paper Boats');
    });

    test('a chat that cannot be joined leaves nothing behind and does not touch the others', async () => {
      const { owner, host: running } = await both({ alice: false, env: { MUSIC_TABLE_URL: site.url, MUSIC_TABLE: '1' } });
      aliceMock.goneRooms.push(aliceMock.roomId);
      await assert.rejects(addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() }));
      assert.deepEqual([...running.chats.keys()], ['owner']);
      assert.deepEqual(running.library.jobs?.recipients().map((person) => person.id), ['owner']);
      owner.type('search blue');
      await owner.sees('Blue Horizon');
      // The room comes back: she can be added after all.
      aliceMock.goneRooms.length = 0;
      await addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() });
      assert.deepEqual([...running.chats.keys()], ['owner', 'alice']);
    });

    test('one person cannot be added twice, not even at once', async () => {
      const { host: running } = await both({ alice: false });
      const add = () => addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() });
      const results = await Promise.allSettled([add(), add()]);
      assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
      await assert.rejects(add(), /already has a chat/);
      assert.equal(running.chats.size, 2);
    });

    test('the jobs start with the first chat, once, or when asked', async () => {
      const running = await start({ MUSIC_TABLE_URL: site.url, MUSIC_TABLE: '1' });
      assert.equal(running.library.jobs, undefined, 'a host with no chat has not started them');
      await addChat(running, OWNER, { token: ownerMock.token, roomID: ownerMock.roomId, homeserver: ownerMock.url, bridge: connected() });
      const jobs = running.library.jobs;
      assert.ok(jobs, 'the first chat started them');
      await addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() });
      assert.equal(running.library.jobs, jobs, 'the second chat did not start another set');
      running.startJobs();
      assert.equal(running.library.jobs, jobs);
    });

    test('a person can be the first on a host whose owner’s chat is not there', async () => {
      const running = await start({ MUSIC_TABLE_URL: site.url, MUSIC_TABLE: '1' });
      const alice = side(await addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() }), aliceMock);
      alice.type('search paper');
      await alice.sees('Paper Planes at Dawn');
      assert.deepEqual(running.library.jobs?.recipients().map((person) => person.id), ['alice']);
      // The owner's chat comes up later and joins the others.
      await addChat(running, OWNER, { token: ownerMock.token, roomID: ownerMock.roomId, homeserver: ownerMock.url, bridge: connected() });
      assert.deepEqual(running.library.jobs?.recipients().map((person) => person.id), ['owner', 'alice']);
    });

    test('a room the homeserver forgets is reported for that chat alone, once', async () => {
      const gone: string[] = [];
      const running = await start();
      await addChat(running, OWNER, { token: ownerMock.token, roomID: ownerMock.roomId, homeserver: ownerMock.url, bridge: connected(), roomCheckEveryMs: 20, onRoomGone: (room) => void gone.push(`owner ${room}`) });
      await addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected(), roomCheckEveryMs: 20, onRoomGone: (room) => void gone.push(`alice ${room}`) });
      await sleep(80);
      assert.deepEqual(gone, [], 'both rooms are fine');
      aliceMock.goneRooms.push(aliceMock.roomId);
      await until(() => gone.length === 1, 'alice’s room to be missed');
      await sleep(80);
      assert.deepEqual(gone, [`alice ${aliceMock.roomId}`], 'said once, and only for alice');
      assert.equal(running.chats.has('owner'), true);
    });

    test('a chat with no room check never reports its room gone, and a removed chat’s check stops', async () => {
      const gone: string[] = [];
      const running = await start();
      await addChat(running, OWNER, { token: ownerMock.token, roomID: ownerMock.roomId, homeserver: ownerMock.url, bridge: connected() });
      await addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected(), roomCheckEveryMs: 20, onRoomGone: (room) => void gone.push(room) });
      await removeChat(running, 'alice');
      const asked = aliceMock.requests.length;
      aliceMock.goneRooms.push(aliceMock.roomId);
      await sleep(120);
      assert.deepEqual(gone, []);
      assert.equal(aliceMock.requests.length, asked, 'nothing asks about her room any more');
    });

    test('a host that is stopped while a chat is coming up does not keep that chat running', async () => {
      const running = await start();
      const adding = addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() });
      await running.stop();
      await assert.rejects(adding, /stopping/);
      const asked = aliceMock.requests.length;
      await sleep(100);
      assert.equal(aliceMock.requests.length, asked, 'nothing polls her chat');
      assert.equal(running.chats.size, 0);
    });

    test('a host stopped while a chat is still being read for the first time does not keep that chat running', async () => {
      const slow = await slowReads(aliceMock.url);
      try {
        slow.hold();
        const running = await start();
        const adding = addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: slow.url, bridge: connected() });
        const rejected = assert.rejects(adding, /stopping/);
        await until(() => slow.reads >= 1, 'the first read of her chat');
        const stopped = running.stop();
        slow.release();
        await rejected;
        await stopped;
        const asked = slow.requests;
        await sleep(120);
        assert.equal(slow.requests, asked, 'nothing polls her chat any more');
        assert.equal(running.chats.size, 0);
      } finally {
        slow.release();
        await slow.close();
      }
    });

    test('whatever goes wrong after a chat is up takes it out again, and its runner stops', async () => {
      const running = await start();
      const working = running.library.addRecipient;
      running.library.addRecipient = () => {
        throw new Error('the jobs could not take another chat');
      };
      await assert.rejects(addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() }), /the jobs could not take another chat/);
      assert.equal(running.chats.has('alice'), false);
      const asked = aliceMock.requests.length;
      await sleep(120);
      assert.equal(aliceMock.requests.length, asked, 'her runner was stopped');
      // Once the jobs work, she can be added.
      running.library.addRecipient = working;
      const alice = side(await addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() }), aliceMock);
      alice.type('search paper planes');
      await alice.sees('Paper Planes at Dawn');
    });

    test('a person’s token is the one given, whatever the environment holds', async () => {
      const kept = { token: process.env.MATRIX_ACCESS_TOKEN, room: process.env.MATRIX_ROOM_ID };
      process.env.MATRIX_ACCESS_TOKEN = 'the-owners-token-from-the-environment';
      process.env.MATRIX_ROOM_ID = '!the-owners-room:localhost';
      try {
        const { alice } = await both({ env: { MATRIX_ACCESS_TOKEN: 'the-owners-token-from-the-environment', MATRIX_ROOM_ID: '!the-owners-room:localhost' } });
        alice.type('search paper planes');
        await alice.sees('Paper Planes at Dawn');
      } finally {
        if (kept.token === undefined) delete process.env.MATRIX_ACCESS_TOKEN;
        else process.env.MATRIX_ACCESS_TOKEN = kept.token;
        if (kept.room === undefined) delete process.env.MATRIX_ROOM_ID;
        else process.env.MATRIX_ROOM_ID = kept.room;
      }
    });

    test('addChat and removeChat need a host from startHost', async () => {
      const fake = {} as Host;
      await assert.rejects(addChat(fake, OWNER, { token: 't', roomID: '!r:x' }), /made by startHost/);
      await assert.rejects(removeChat(fake, 'alice'), /made by startHost/);
    });

    test('the host can stand with no one in it, and stops', async () => {
      const running = await start();
      assert.equal(running.chats.size, 0);
      assert.equal(running.sending(), false);
      // A file under way at the gate is sending, whoever's chat it is for.
      let release!: () => void;
      const holding = running.gate.run('nobody', () => new Promise<void>((resolve) => (release = resolve)));
      assert.equal(running.sending(), true);
      release();
      await holding;
      assert.equal(running.sending(), false);
      await running.stop();
      await assert.rejects(addChat(running, OWNER, { token: ownerMock.token, roomID: ownerMock.roomId, homeserver: ownerMock.url }), /stopping/);
    });

    test('a start with settings that cannot work fails before anything is opened', async () => {
      const bad = { ...baseEnv(), ONEDRIVE_MAX_MB_PER_MONTH: 'lots' };
      await assert.rejects(startHost({ env: bad, config: { ...loadMatrixHostConfig(baseEnv()), dbPath: ':memory:' }, catalog, admin: new AdminConsole(), extensions: [], log: () => {} }), /ONEDRIVE_MAX_MB_PER_MONTH/);
      const typo = { ...baseEnv(), STARTUP_MESSAGE: 'sometimes' };
      await assert.rejects(startHost({ env: typo, config: { ...loadMatrixHostConfig(baseEnv()), dbPath: ':memory:' }, catalog, admin: new AdminConsole(), extensions: [], log: () => {} }), /STARTUP_MESSAGE/);
    });
  });

  describe('the daily message and the alerts', () => {
    test('every chat is a recipient of the jobs, each reached through its own chat and only while its own login can pass it on', async () => {
      const { owner, alice, host: running } = await both({ env: { MUSIC_TABLE_URL: site.url, MUSIC_TABLE: '1' }, aliceBridge: signedOut('alice’s Google Messages login is signed out') });
      assert.deepEqual(running.library.jobs?.recipients().map((person) => person.id), ['owner', 'alice']);
      const hello = [{ kind: 'text' as const, text: 'new music today' }];
      await owner.chat.announce(hello);
      await assert.rejects(alice.chat.announce(hello), /signed out/);
      assert.equal(alice.bodies().some((text) => text.includes('new music today')), false, 'nothing reached alice');
      assert.equal(owner.bodies().some((text) => text.includes('new music today')), true);
    });

    test('the owner’s bridge being down holds the owner’s daily message and not alice’s', async () => {
      const { owner, alice } = await both({ ownerBridge: signedOut('the bridge is not connected to Google Messages') });
      const hello = [{ kind: 'text' as const, text: 'new music today' }];
      await assert.rejects(owner.chat.announce(hello), /not connected/);
      await alice.chat.announce(hello);
      assert.equal(alice.bodies().some((text) => text.includes('new music today')), true);
      assert.equal(owner.bodies().some((text) => text.includes('new music today')), false);
    });

    test('a person added with a time offset is sent the daily message that many minutes after the host’s time, and can be removed from the jobs', async () => {
      const { host: running } = await both({ env: { MUSIC_TABLE_URL: site.url, MUSIC_TABLE: '1', DIGEST_TIME: '09:00' }, aliceOptions: { digestOffsetMinutes: 10 } });
      const report = running.library.jobs!.report();
      assert.equal(report.digest.at, '09:00', 'the owner is at the host’s time');
      assert.deepEqual(report.people.map((one) => [one.id, one.digest.at]), [['alice', '09:10']]);
      await removeChat(running, 'alice');
      assert.deepEqual(running.library.jobs?.recipients().map((person) => person.id), ['owner']);
    });
  });

  describe('every round', () => {
    test('each chat’s login is looked at, a chat that is gone is not, and a check that fails is only logged', async () => {
      const checks = { owner: 0, alice: 0 };
      const counting = (who: 'owner' | 'alice', fail = false): ChatBridge => ({
        check: async () => {
          checks[who] += 1;
          if (fail) throw new Error(`${who}'s login could not be read`);
        },
        sendFailed() {},
        blocked: () => undefined,
      });
      const { host: running } = await both({ minuteMs: 15, ownerBridge: counting('owner'), aliceBridge: counting('alice', true) });
      await until(() => checks.owner >= 4 && checks.alice >= 4, 'four rounds');
      assert.ok(logs.some((line) => /^\[alice\] could not check the bridge: alice's login could not be read$/.test(line)), logs.join('\n'));
      await removeChat(running, 'alice');
      const seen = checks.alice;
      await sleep(100);
      assert.equal(checks.alice, seen, 'a chat taken off the host is not looked at again');
      assert.ok(checks.owner > 4);
    });

    test('the artists waiting for a word are told to the owner and to no one else', async () => {
      catalog.setState('zemer.whitelist.owner', JSON.stringify({ allowed: [], blocked: [], waiting: [[artistId('Newcomer Band'), 'Newcomer Band', 1]] }));
      const { owner, alice } = await both({ minuteMs: 15, env: { QUIET_HOURS: 'off' } });
      await owner.sees("I'm holding their songs back until you say");
      await owner.sees('Newcomer Band');
      await sleep(100);
      assert.deepEqual(alice.bodies(), [], 'alice is told nothing of it');
      assert.ok(catalog.getState('whitelist.told'), 'the owner’s told-list is the one kept');
      assert.equal(catalog.getState('whitelist.told:alice'), undefined);
    });

    test('the month’s traffic counts what everyone was sent, once, for the whole host', async () => {
      const month = new Date().toISOString().slice(0, 7);
      catalog.setState(`usage.${month}.alice.sent_bytes`, String(4_500 * 1048576));
      catalog.setState(`usage.${month}.people`, 'alice');
      await both({ minuteMs: 15 });
      await until(() => problems.some((message) => /MB/.test(message) && /alice/.test(message)), 'the traffic problem');
      assert.equal(problems.filter((message) => /alice/.test(message)).length, 1, 'said once');
    });
  });

  describe('add-ons and waiting artists are the owner’s', () => {
    test('an add-on is started with the owner’s chat even when another person’s chat is up first', async () => {
      const started: string[] = [];
      const extension: Extension = { name: 'echo', start: (chat) => void chat.post('🤖 hello from the add-on').then(() => started.push('posted')) };
      const running = await start({}, [extension]);
      const alice = side(await addChat(running, personOf('alice'), { token: aliceMock.token, roomID: aliceMock.roomId, homeserver: aliceMock.url, bridge: connected() }), aliceMock);
      await sleep(100);
      assert.deepEqual(started, [], 'nothing starts for alice');
      assert.equal(alice.bodies().some((text) => text.includes('hello from the add-on')), false);
      const owner = side(await addChat(running, OWNER, { token: ownerMock.token, roomID: ownerMock.roomId, homeserver: ownerMock.url, bridge: connected() }), ownerMock);
      await until(() => started.length === 1, 'the add-on posts to the owner');
      assert.equal(owner.bodies().some((text) => text.includes('hello from the add-on')), true);
      assert.equal(alice.bodies().some((text) => text.includes('hello from the add-on')), false);
    });

    test('an add-on’s way of making pictures is the owner’s: a song’s card for anyone else is made the usual way', async () => {
      const made: string[] = [];
      const extension: Extension = {
        name: 'cards',
        pictures: () => async (picture) => {
          made.push(picture.kind === 'image' ? picture.caption?.title ?? '' : 'collage');
          const data = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' });
          return { image: { data, fileName: 'add-on-card.jpg', mimeType: 'image/jpeg', bytes: 4, sourceUrl: 'https://cards.test/x.jpg' }, captioned: true };
        },
      };
      const { owner, alice } = await both({ extensions: [extension] });
      owner.type('search blue horizon');
      alice.type('search paper planes');
      await owner.sees('Blue Horizon');
      await alice.sees('Paper Planes at Dawn');
      owner.like(owner.line('Blue Horizon'));
      alice.like(alice.line('Paper Planes at Dawn'));
      await until(() => ownerMock.uploads.some((upload) => /m4a$/.test(upload.fileName ?? '')) && aliceMock.uploads.some((upload) => /m4a$/.test(upload.fileName ?? '')), 'both songs');
      assert.deepEqual(made, ['Blue Horizon'], 'the add-on made the owner’s card only');
      assert.ok(ownerMock.uploads.some((upload) => upload.fileName === 'add-on-card.jpg'));
      assert.ok(aliceMock.uploads.every((upload) => upload.fileName !== 'add-on-card.jpg'));
    });

    test('an add-on is started once, with the owner’s chat', async () => {
      const started: string[] = [];
      const extension: Extension = {
        name: 'echo',
        start: (chat) => {
          void chat.post('🤖 hello from the add-on').then(() => started.push('posted'));
        },
      };
      const { owner, alice } = await both({ extensions: [extension] });
      await until(() => started.length === 1, 'the add-on posts');
      assert.equal(owner.bodies().some((text) => text.includes('hello from the add-on')), true);
      assert.equal(alice.bodies().some((text) => text.includes('hello from the add-on')), false);
      assert.equal(started.length, 1);
    });
  });
});
