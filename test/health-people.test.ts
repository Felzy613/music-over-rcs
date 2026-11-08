import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { AdminConsole } from '../src/admin/console.ts';
import { Catalog } from '../src/catalog.ts';
import { loadMatrixHostConfig } from '../src/config.ts';
import { BridgeWatch, Health, type BridgeStatus } from '../src/health.ts';
import { addChat, personBridge, startHost, type Host } from '../src/host.ts';
import { OWNER, personOf, type Person } from '../src/people.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';
import { listen, type Listening } from './helpers/servers.ts';
import { startMockYouTubeMusic, type MockYouTubeMusic } from './helpers/mock-youtube-music.ts';
import { startMockZemerContent, type MockZemerContent } from './helpers/mock-zemer-content.ts';

// The bridge is ONE process for every person's Google login, so one person's dead phone, signed-out login or undelivered message must never
// restart it for the owner. What these pin: a watch for anyone but the owner has no restart (and cannot be given one), says what is wrong
// in words that name the person under keys of their own, and says nothing at all about someone who has never linked. The owner's own
// watch is what it always was.

const alice = personOf('alice');
const bob = personOf('bob');
const CONNECTED: BridgeStatus = { state: 'CONNECTED', rcsEnabled: true };
const SIGNED_OUT: BridgeStatus = { state: 'BAD_CREDENTIALS', message: 'Logged out', rcsEnabled: true };
const UNPAIRED: BridgeStatus = { state: 'BAD_CREDENTIALS', error: 'Unpaired from Google Messages, please re-link', rcsEnabled: true };
const NO_LOGIN: BridgeStatus = { state: undefined };
const DOWN: BridgeStatus = { state: 'TRANSIENT_DISCONNECT', error: 'gm-ping-failed', rcsEnabled: true };
const PHONE_SILENT: BridgeStatus = { state: 'TRANSIENT_DISCONNECT', error: 'gm-phone-not-responding', rcsEnabled: true };

type Login = BridgeStatus | Error;

/** One Health and one fake clock for every watch in a test, and one shared restart counter standing for the bridge's single process. */
function world() {
  const clock = { ms: Date.UTC(2026, 9, 9, 12) };
  const told: string[] = [];
  const health = new Health({ notify: async (_title, message) => void told.push(message), now: () => new Date(clock.ms) });
  const bridge = { restarts: 0 };
  const restart = async (): Promise<void> => {
    bridge.restarts += 1;
  };

  function watch(person: Person, options: { restart?: boolean; seen?: 'already' | 'not yet' | 'asked not'; online?: () => Promise<boolean> } = {}) {
    const login: { status: Login } = { status: CONNECTED };
    const memory = { has: options.seen === 'already', marks: 0 };
    const logs: string[] = [];
    const made = new BridgeWatch({
      health,
      person,
      now: () => new Date(clock.ms),
      status: async () => {
        if (login.status instanceof Error) throw login.status;
        return login.status;
      },
      log: (line) => void logs.push(line),
      // Only the owner may be given a restart (that is the point); a test can try to give one to anyone to see it refused.
      ...(options.restart === false ? {} : person.owner || options.restart === true ? { restart } : {}),
      ...(options.online ? { online: options.online } : {}),
      ...(options.seen
        ? {
            everConnected: {
              has: () => memory.has,
              mark: () => {
                memory.has = true;
                memory.marks += 1;
              },
            },
          }
        : {}),
    });
    return { watch: made, login, memory, logs };
  }

  /** Looks `times` times, a minute apart, at the end of which `login` is what each saw. */
  async function minutes(one: { watch: BridgeWatch }, times: number): Promise<void> {
    for (let i = 0; i < times; i++) {
      clock.ms += 60_000;
      await one.watch.check();
    }
  }
  return { clock, told, health, bridge, watch, minutes };
}

const keysOf = (health: Health): string[] => health.problems().map((problem) => problem.key).sort();

describe('a person’s bridge watch never restarts the bridge', () => {
  test('a watch for anyone but the owner cannot be given a restart', () => {
    const w = world();
    assert.throws(() => w.watch(alice, { restart: true }), /alice cannot restart the bridge: it is one process for every person's login/);
    // The owner may have one (and does, on the host).
    assert.doesNotThrow(() => w.watch(OWNER, { restart: true }));
  });

  test('signed out, phone silent, down and not answering for hours: the owner’s watch restarts the bridge over and over, a person’s never does', async () => {
    // The same hours of trouble for both, one after the other, so the owner's count shows these statuses really would restart the bridge.
    const script: Array<[Login, number]> = [
      [SIGNED_OUT, 5 * 60],
      [PHONE_SILENT, 5 * 60],
      [DOWN, 3 * 60],
      [new Error('connection refused'), 3 * 60],
      [UNPAIRED, 60],
      [NO_LOGIN, 60],
    ];
    const counts: Record<string, number> = {};
    for (const person of [OWNER, alice]) {
      const w = world();
      const one = w.watch(person, { seen: person.owner ? undefined : 'already' });
      for (const [status, length] of script) {
        one.login.status = status;
        await w.minutes(one, length);
      }
      counts[person.id] = w.bridge.restarts;
    }
    assert.ok(counts.owner! >= 20, `the owner's watch restarted ${counts.owner} times, so these statuses ask for restarts`);
    assert.equal(counts.alice, 0);
  });

  test('a person’s undelivered messages never restart it either, and are reported under the person’s own key', async () => {
    const w = world();
    const owner = w.watch(OWNER);
    const one = w.watch(alice, { seen: 'already' });
    for (let i = 0; i < 5; i++) {
      await one.watch.sendFailed();
      w.clock.ms += 11 * 60_000;
    }
    assert.equal(w.bridge.restarts, 0);
    assert.deepEqual(keysOf(w.health), ['bridge-restart:alice']);
    assert.match(w.told.at(-1)!, /undelivered message for alice/);
    // The owner's own undelivered message still restarts it (once, then waits ten minutes).
    await owner.watch.sendFailed();
    assert.equal(w.bridge.restarts, 1);
    assert.deepEqual(keysOf(w.health), ['bridge-restart:alice']);
  });

  test('the owner connected and a person dead for hours: not one restart, and the owner has nothing wrong', async () => {
    const w = world();
    const owner = w.watch(OWNER);
    const one = w.watch(alice, { seen: 'already' });
    for (const status of [SIGNED_OUT, PHONE_SILENT, DOWN, UNPAIRED, NO_LOGIN, new Error('refused')]) {
      one.login.status = status;
      for (let i = 0; i < 90; i++) {
        w.clock.ms += 60_000;
        await owner.watch.check();
        await one.watch.check();
      }
    }
    assert.equal(w.bridge.restarts, 0);
    assert.equal(w.health.has('bridge'), false);
    assert.equal(w.health.has('bridge-restart'), false);
    assert.ok(w.health.has('bridge:alice'));
  });

  test('the owner’s restarts are the same with a broken person beside them as without one', async () => {
    const run = async (withAlice: boolean): Promise<number> => {
      const w = world();
      const owner = w.watch(OWNER);
      const one = w.watch(alice, { seen: 'already' });
      owner.login.status = DOWN;
      one.login.status = withAlice ? SIGNED_OUT : CONNECTED;
      for (let i = 0; i < 240; i++) {
        w.clock.ms += 60_000;
        await owner.watch.check();
        if (withAlice) await one.watch.check();
      }
      return w.bridge.restarts;
    };
    const alone = await run(false);
    assert.ok(alone >= 10, `the owner's own trouble restarts the bridge (${alone} times)`);
    assert.equal(await run(true), alone);
  });
});

describe('a person who has never linked raises nothing', () => {
  test('whatever the bridge says of a login that was never connected, for a day: no problem, no alert, no restart', async () => {
    const w = world();
    const owner = w.watch(OWNER);
    const one = w.watch(alice, { seen: 'not yet' });
    one.login.status = NO_LOGIN;
    for (const status of [NO_LOGIN, UNPAIRED, SIGNED_OUT, DOWN, PHONE_SILENT, { state: 'CONNECTING', rcsEnabled: false } as BridgeStatus, new Error('refused')]) {
      one.login.status = status;
      for (let i = 0; i < 200; i++) {
        w.clock.ms += 60_000;
        await owner.watch.check();
        await one.watch.check();
      }
    }
    await one.watch.sendFailed();
    assert.deepEqual(w.told, []);
    assert.deepEqual(w.health.problems(), []);
    assert.equal(w.bridge.restarts, 0);
    assert.equal(one.watch.linked(), false);
    assert.equal(one.memory.marks, 0);
  });

  test('the first time it is seen connected is remembered once, and from then on its trouble is reported', async () => {
    const w = world();
    const one = w.watch(alice, { seen: 'not yet' });
    one.login.status = NO_LOGIN;
    await w.minutes(one, 10);
    assert.deepEqual(w.told, []);
    one.login.status = CONNECTED;
    await w.minutes(one, 5);
    assert.equal(one.memory.marks, 1, 'written once, not at every look');
    assert.equal(one.watch.linked(), true);
    one.login.status = NO_LOGIN;
    await w.minutes(one, 1);
    assert.deepEqual(w.told, [], 'a bridge that has only just started may not list its login yet');
    await w.minutes(one, 3);
    assert.equal(w.told.length, 1);
    assert.match(w.told[0]!, /^Google Messages is logged out of the bridge for alice\./);
    assert.equal(one.memory.marks, 1);
  });

  test('a login seen connected before a restart of the host is reported straight away, and is not written again', async () => {
    const w = world();
    const one = w.watch(alice, { seen: 'already' });
    assert.equal(one.watch.linked(), true);
    one.login.status = UNPAIRED;
    await w.minutes(one, 1);
    assert.match(w.told[0]!, /unlinked the bridge for alice/);
    assert.equal(one.memory.marks, 0);
  });

  test('a undelivered notice for a login that never connected is only logged', async () => {
    const w = world();
    const one = w.watch(alice, { seen: 'not yet' });
    await one.watch.sendFailed();
    assert.deepEqual(w.told, []);
    assert.equal(w.health.has('bridge-restart:alice'), false);
    assert.match(one.logs.join('\n'), /has not connected yet/);
  });

  test('a state that cannot be read counts as never connected, and one that cannot be written does not stop the watch', async () => {
    const w = world();
    const logs: string[] = [];
    const status: { now: BridgeStatus } = { now: CONNECTED };
    const watch = new BridgeWatch({
      health: w.health,
      person: alice,
      now: () => new Date(w.clock.ms),
      status: async () => status.now,
      log: (line) => void logs.push(line),
      everConnected: {
        has: () => {
          throw new Error('database is closed');
        },
        mark: () => {
          throw new Error('database is closed');
        },
      },
    });
    assert.equal(watch.linked(), false);
    await watch.check();
    assert.equal(watch.linked(), true, 'seen connected now, whatever the write did');
    assert.match(logs.join('\n'), /could not remember that this login has connected: database is closed/);
    status.now = UNPAIRED;
    await watch.check();
    assert.match(w.told.at(-1)!, /unlinked the bridge for alice/);
  });
});

describe('what a person’s watch says', () => {
  const NAMES_ALICE = (message: string): void => {
    assert.ok(message.includes('alice'), `names alice: ${message}`);
    // Nothing said for a person is the owner's wording: no "your phone", no /pair page, no promise that the bridge restarts on its own.
    assert.doesNotMatch(message, /your phone|\/pair|restarted on its own|keeps restarting|automatic restart/i, message);
  };

  test('no login: after two minutes, naming alice and where to link her again', async () => {
    const w = world();
    const one = w.watch(alice, { seen: 'already' });
    one.login.status = NO_LOGIN;
    await w.minutes(one, 1);
    assert.deepEqual(w.told, []);
    await w.minutes(one, 2);
    assert.equal(w.told.length, 1);
    NAMES_ALICE(w.told[0]!);
    assert.match(w.told[0]!, /Connect tab of the service's \/admin\/ console \(pick alice\)/);
    assert.deepEqual(keysOf(w.health), ['bridge:alice']);
  });

  test('unlinked by Google, signed out, and not reaching Google (the phone, and not the phone)', async () => {
    const cases: Array<[BridgeStatus, number, RegExp]> = [
      [UNPAIRED, 1, /^Google Messages unlinked the bridge for alice \(Unpaired from Google Messages, please re-link\)\. Restarting can't fix that\./],
      [SIGNED_OUT, 1, /^Google Messages is logged out of the bridge for alice \(Logged out\)\. Link it again/],
      [DOWN, 16, /^The bridge can't reach Google Messages for alice \(gm-ping-failed\)\. It keeps trying on its own; if this lasts, ask alice to check/],
      [PHONE_SILENT, 16, /^The bridge can't reach Google Messages for alice \(gm-phone-not-responding\)\. Is alice's phone on and online\?$/],
    ];
    for (const [status, length, expected] of cases) {
      const w = world();
      const one = w.watch(alice, { seen: 'already' });
      one.login.status = status;
      await w.minutes(one, length);
      assert.equal(w.told.length, 1, `${status.state} ${status.error ?? status.message}: ${JSON.stringify(w.told)}`);
      assert.match(w.told[0]!, expected);
      NAMES_ALICE(w.told[0]!);
      assert.deepEqual(keysOf(w.health), ['bridge:alice']);
    }
  });

  test('a disconnect that mends: the fix names alice too, and clears only her key', async () => {
    const w = world();
    const owner = w.watch(OWNER);
    const one = w.watch(alice, { seen: 'already' });
    owner.login.status = DOWN;
    one.login.status = SIGNED_OUT;
    await w.minutes(owner, 20);
    await w.minutes(one, 1);
    assert.deepEqual(keysOf(w.health), ['bridge', 'bridge:alice']);
    one.login.status = CONNECTED;
    await w.minutes(one, 1);
    assert.deepEqual(keysOf(w.health), ['bridge'], 'the owner’s trouble stands');
    assert.equal(w.told.at(-1), "Fixed: alice's Google Messages is connected to the bridge again.");
  });

  test('RCS off on her phone, and on again; and an undelivered message that is delivering again', async () => {
    const w = world();
    const one = w.watch(alice, { seen: 'already' });
    one.login.status = { state: 'CONNECTED', rcsEnabled: false };
    await w.minutes(one, 1);
    assert.equal(w.told.at(-1), "RCS chats are off on alice's phone, so songs can't be sent to them. They can turn them on: Messages → Settings → RCS chats.");
    assert.deepEqual(keysOf(w.health), ['rcs:alice']);
    await one.watch.sendFailed();
    NAMES_ALICE(w.told.at(-1)!);
    assert.deepEqual(keysOf(w.health), ['bridge-restart:alice', 'rcs:alice']);
    one.login.status = CONNECTED;
    await w.minutes(one, 1);
    assert.deepEqual(w.health.problems(), []);
    assert.ok(w.told.includes("Fixed: RCS chats are on again on alice's phone."));
    assert.ok(w.told.includes("Fixed: alice's Google Messages is delivering again."));
  });

  test('the bridge not answering: the owner is told at once, a person only after fifteen minutes of it', async () => {
    const w = world();
    const owner = w.watch(OWNER);
    const one = w.watch(alice, { seen: 'already' });
    owner.login.status = new Error('connection refused');
    one.login.status = new Error('connection refused');
    for (let i = 1; i <= 14; i++) {
      w.clock.ms += 60_000;
      await owner.watch.check();
      await one.watch.check();
    }
    assert.deepEqual(keysOf(w.health), ['bridge'], 'only the owner’s, and the owner’s watch is what restarts it');
    assert.ok(w.bridge.restarts >= 2);
    const owners = w.bridge.restarts;
    w.clock.ms += 2 * 60_000;
    await one.watch.check();
    assert.deepEqual(keysOf(w.health), ['bridge', 'bridge:alice']);
    NAMES_ALICE(w.told.at(-1)!);
    assert.match(w.told.at(-1)!, /so alice's login can't be checked/);
    assert.equal(w.bridge.restarts, owners, 'saying it restarted nothing');
  });

  test('the owner’s words are exactly what they were', async () => {
    const w = world();
    const noRestart = w.watch(OWNER, { restart: false });
    noRestart.login.status = NO_LOGIN;
    await w.minutes(noRestart, 3);
    assert.equal(w.told.at(-1), "Google Messages is logged out of the bridge. Log in again on the service's /pair page.");
    noRestart.login.status = UNPAIRED;
    await w.minutes(noRestart, 1);
    // The same key as the last word, so it is kept up to date and not said again within hours.
    assert.equal(
      w.health.problems().find((problem) => problem.key === 'bridge')?.message,
      "Google Messages unlinked the bridge (Unpaired from Google Messages, please re-link). Restarting can't fix that; link it again on the service's /pair page (docs/cloud.md, step 4).",
    );
    noRestart.login.status = { state: 'CONNECTED', rcsEnabled: false };
    await w.minutes(noRestart, 1);
    assert.equal(w.told.at(-2), 'Fixed: the bridge is connected to Google Messages again.');
    assert.equal(w.told.at(-1), "RCS chats are off on your phone, so songs can't be sent. Turn them on: Messages → Settings → RCS chats.");
    await noRestart.watch.sendFailed();
    assert.equal(w.told.at(-1), 'Google Messages reported an undelivered message. If texts stop arriving, restart the service in Render.');
    noRestart.login.status = new Error('refused');
    await w.minutes(noRestart, 1);
    assert.equal(w.told.at(-1), "The Google Messages bridge isn't answering. It is restarted on its own; if this lasts, restart the service in Render.");
    assert.deepEqual(keysOf(w.health), ['bridge', 'bridge-restart', 'rcs']);
    assert.deepEqual(noRestart.watch.keys(), { bridge: 'bridge', restart: 'bridge-restart', rcs: 'rcs' });
    assert.equal(noRestart.watch.linked(), true);
  });
});

describe('the keys do not collide', () => {
  test('the owner and every person have keys of their own, whatever they are called; only the internet is shared', async () => {
    const w = world();
    const names = ['alice', 'bob', 'restart', 'rcs', 'internet', 'bridge', 'room'];
    const everyone = [OWNER, ...names.map((id) => personOf(id))];
    const keys = everyone.flatMap((person) => Object.values(w.watch(person, { seen: person.owner ? undefined : 'already' }).watch.keys()));
    assert.equal(new Set(keys).size, keys.length, keys.join(', '));
    assert.ok(!keys.includes('internet'));
    // A person's keys end in their own id, which is how /status finds them, and the owner's end in nobody's.
    for (const person of everyone.slice(1)) {
      for (const key of Object.values(w.watch(person, { seen: 'already' }).watch.keys())) assert.ok(key.endsWith(`:${person.id}`), key);
    }
    for (const key of Object.values(w.watch(OWNER).watch.keys())) assert.ok(!key.includes(':'), key);
  });

  test('one person’s trouble and fix never touch another’s or the owner’s', async () => {
    const w = world();
    const owner = w.watch(OWNER);
    const a = w.watch(alice, { seen: 'already' });
    const b = w.watch(bob, { seen: 'already' });
    owner.login.status = { state: 'CONNECTED', rcsEnabled: false };
    a.login.status = SIGNED_OUT;
    b.login.status = { state: 'CONNECTED', rcsEnabled: false };
    await w.minutes(owner, 1);
    await w.minutes(a, 1);
    await w.minutes(b, 1);
    assert.deepEqual(keysOf(w.health), ['bridge:alice', 'rcs', 'rcs:bob']);
    b.login.status = CONNECTED;
    await w.minutes(b, 1);
    assert.deepEqual(keysOf(w.health), ['bridge:alice', 'rcs'], 'bob’s fix clears bob’s');
    a.login.status = CONNECTED;
    await w.minutes(a, 1);
    assert.deepEqual(keysOf(w.health), ['rcs'], 'alice’s fix clears alice’s');
    owner.login.status = SIGNED_OUT;
    await w.minutes(owner, 16);
    assert.ok(w.health.has('bridge'));
    assert.equal(w.health.has('bridge:alice'), false);
  });

  test('the host’s internet is one problem for everybody: said once, fixed once, and no login blamed meanwhile', async () => {
    const w = world();
    const state = { up: false };
    const online = async (): Promise<boolean> => state.up;
    const owner = w.watch(OWNER, { online });
    const a = w.watch(alice, { seen: 'already', online });
    const b = w.watch(bob, { seen: 'already', online });
    for (const one of [owner, a, b]) one.login.status = DOWN;
    for (let i = 0; i < 30; i++) {
      w.clock.ms += 60_000;
      for (const one of [owner, a, b]) await one.watch.check();
    }
    assert.deepEqual(keysOf(w.health), ['internet']);
    assert.equal(w.told.filter((message) => /has no internet/.test(message)).length, 1);
    state.up = true;
    w.clock.ms += 60_000;
    for (const one of [owner, a, b]) {
      one.login.status = CONNECTED;
      await one.watch.check();
    }
    assert.equal(w.told.filter((message) => /back online/.test(message)).length, 1);
    assert.deepEqual(w.health.problems(), []);
  });
});

// ---- the host's wiring: personBridge, with the real bridge client against a stand-in bridge ----

interface MockBridge extends Listening {
  /** What the bridge says for each account's token: its logins, or false for a bridge that answers 500. */
  logins: Map<string, unknown[] | false>;
  requests: Array<{ token: string; userId: string }>;
}

async function startMockBridge(): Promise<MockBridge> {
  const logins = new Map<string, unknown[] | false>();
  const requests: MockBridge['requests'] = [];
  const server = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://bridge');
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    requests.push({ token, userId: url.searchParams.get('user_id') ?? '' });
    const mine = logins.get(token);
    if (url.pathname !== '/_matrix/provision/v3/whoami' || mine === false) {
      res.writeHead(500).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ logins: mine ?? [] }));
  });
  return Object.assign(server, { logins, requests });
}

const login = (status: BridgeStatus): unknown => ({ state: { state_event: status.state, error: status.error, message: status.message, info: { settings: { rcs_enabled: status.rcsEnabled } } } });

describe('a person’s chat on the host watches their own login and never restarts the bridge', () => {
  const OWNER_TOKEN = 'tok-owner';
  const ALICE_TOKEN = 'tok-alice';
  let youMock: MockYouTubeMusic;
  let content: MockZemerContent;
  let ownerMock: MockMatrix;
  let aliceMock: MockMatrix;
  let bridge: MockBridge;
  let catalog: Catalog;
  let host: Host | undefined;
  let told: string[];
  let scratch: string | undefined;

  const realFetch = globalThis.fetch;
  before(async () => {
    // Nothing here may reach the real network: only this machine is answered.
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input instanceof Request ? input.url : input);
      if (/^http:\/\/127\.0\.0\.1[:/]/.test(url)) return realFetch(input, init);
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    youMock = await startMockYouTubeMusic([], []);
    content = await startMockZemerContent([]);
    ownerMock = await startMockMatrix(0, { eventPrefix: 'o', user: 'me', token: OWNER_TOKEN, roomId: '!owner:localhost' });
    aliceMock = await startMockMatrix(0, { eventPrefix: 'a', user: 'alice', token: ALICE_TOKEN, roomId: '!alice:localhost' });
    bridge = await startMockBridge();
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await Promise.all([youMock.close(), content.close(), ownerMock.close(), aliceMock.close(), bridge.close()]);
  });
  beforeEach(() => {
    ownerMock.reset();
    aliceMock.reset();
    catalog = new Catalog(':memory:');
    told = [];
    host = undefined;
    scratch = undefined;
    bridge.requests.length = 0;
    bridge.logins.clear();
    bridge.logins.set(OWNER_TOKEN, [login(CONNECTED)]);
    bridge.logins.set(ALICE_TOKEN, [login(CONNECTED)]);
  });
  afterEach(async () => {
    await host?.stop();
    catalog.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  async function start(env: NodeJS.ProcessEnv = {}): Promise<Host> {
    const merged: NodeJS.ProcessEnv = {
      YOUTUBE_MUSIC_URL: youMock.url,
      ZEMER_CONTENT_URL: content.url,
      ZEMER_SEARCH: 'off',
      MUSIC_TABLE: 'off',
      ZEMER_RELEASES: 'off',
      PREFETCH_MB: 'off',
      SONG_GAP_SECONDS: 'off',
      MATRIX_SYNC_WAIT_MS: '0',
      BRIDGE_URL: bridge.url,
      ...env,
    };
    host = await startHost({
      env: merged,
      config: { ...loadMatrixHostConfig(merged), pollMs: 20, dbPath: ':memory:' },
      catalog,
      admin: new AdminConsole(),
      notify: async (_title, message) => void told.push(message),
      extensions: [],
      online: async () => true,
      log: () => {},
    });
    return host;
  }

  const addOwner = (running: Host, bridgeOption?: Parameters<typeof addChat>[2]['bridge']) =>
    addChat(running, OWNER, { token: OWNER_TOKEN, roomID: ownerMock.roomId, homeserver: ownerMock.url, ...(bridgeOption ? { bridge: bridgeOption } : {}) });
  const addAlice = (running: Host) => addChat(running, alice, { token: ALICE_TOKEN, roomID: aliceMock.roomId, homeserver: aliceMock.url });

  test('personBridge is for the people besides the owner', async () => {
    const running = await start();
    assert.throws(() => personBridge(running, OWNER, { token: 't', userId: '@me:localhost', online: async () => true }), /for the people besides the owner/);
  });

  test('each watch asks the bridge about its own login: their token with their id, never the other’s', async () => {
    const running = await start({ BRIDGE_AUTO_RESTART: 'off' });
    const owner = await addOwner(running);
    const her = await addAlice(running);
    await owner.bridge.check();
    await her.bridge.check();
    const seen = new Set(bridge.requests.map((request) => `${request.token} ${request.userId}`));
    assert.deepEqual([...seen].sort(), [`${ALICE_TOKEN} @alice:localhost`, `${OWNER_TOKEN} @me:localhost`]);
  });

  test('a person who has not linked: nothing is raised, what is sent to them waits, and the first connection is written once', async () => {
    const writes: string[] = [];
    const original = catalog.setState.bind(catalog);
    catalog.setState = (key: string, value: string) => {
      if (key.startsWith('bridge.seen')) writes.push(key);
      original(key, value);
    };
    bridge.logins.set(ALICE_TOKEN, []);
    const running = await start({ BRIDGE_AUTO_RESTART: 'off' });
    await addOwner(running);
    const her = await addAlice(running);
    for (let i = 0; i < 4; i++) await her.bridge.check();
    assert.deepEqual(running.health.problems(), []);
    assert.deepEqual(told, []);
    assert.match(her.bridge.blocked() ?? '', /^alice's Google Messages is not linked to the bridge yet$/);
    await assert.rejects(her.announce([{ kind: 'text', text: 'x' }]), /not linked to the bridge yet/);
    assert.equal(catalog.getState('bridge.seen:alice'), undefined);

    bridge.logins.set(ALICE_TOKEN, [login(CONNECTED)]);
    await her.bridge.check();
    await her.bridge.check();
    assert.equal(her.bridge.blocked(), undefined);
    assert.deepEqual(writes, ['bridge.seen:alice']);
    assert.match(catalog.getState('bridge.seen:alice') ?? '', /^\d{4}-\d\d-\d\dT/);
    assert.equal(catalog.getState('bridge.seen'), undefined, 'the owner’s key is not alice’s');
  });

  test('her login unlinked by Google: reported under her key, naming her; her messages wait; the owner is untouched', async () => {
    const running = await start({ BRIDGE_AUTO_RESTART: 'off' });
    const owner = await addOwner(running);
    const her = await addAlice(running);
    await her.bridge.check();
    assert.equal(her.bridge.blocked(), undefined);
    bridge.logins.set(ALICE_TOKEN, [login(UNPAIRED)]);
    await her.bridge.check();
    await owner.bridge.check();
    assert.deepEqual(running.health.problems().map((problem) => problem.key), ['bridge:alice']);
    assert.equal(told.length, 1);
    assert.match(told[0]!, /unlinked the bridge for alice/);
    assert.equal(her.bridge.blocked(), "alice's Google Messages is not connected to the bridge");
    assert.equal(owner.bridge.blocked(), undefined);
    await assert.rejects(her.announce([{ kind: 'text', text: 'x' }]), /alice's Google Messages is not connected/);
    // Linked again: the problem clears and her messages flow.
    bridge.logins.set(ALICE_TOKEN, [login(CONNECTED)]);
    await her.bridge.check();
    assert.deepEqual(running.health.problems(), []);
    assert.equal(her.bridge.blocked(), undefined);
  });

  test('her bridge login and the host’s internet: the host’s outage blocks both and is one problem', async () => {
    const running = await start({ BRIDGE_AUTO_RESTART: 'off' });
    const owner = await addOwner(running);
    const her = await addAlice(running);
    await her.bridge.check();
    running.health.problem('internet', "The bot's host has no internet. Texts you send meanwhile are answered when it's back.");
    assert.equal(her.bridge.blocked(), 'the host has no internet');
    assert.equal(owner.bridge.blocked(), 'the host has no internet');
  });

  test('an undelivered message in her chat does not restart the bridge; one in the owner’s chat does', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'mors-health-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    try {
      const pidfile = join(scratch, 'bridge.pid');
      writeFileSync(pidfile, String(child.pid));
      const running = await start({ BRIDGE_PIDFILE: pidfile });
      const owner = await addOwner(running);
      const her = await addAlice(running);
      await owner.bridge.check();
      await her.bridge.check();

      for (let i = 0; i < 3; i++) await her.bridge.sendFailed();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null, 'the bridge process was left alone');
      assert.deepEqual(running.health.problems().map((problem) => problem.key), ['bridge-restart:alice']);
      assert.match(told.at(-1)!, /undelivered message for alice/);

      await owner.bridge.sendFailed();
      assert.equal(await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 3000))]), 'SIGTERM', 'the owner’s watch is the one that restarts it');
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('a person’s dead login for good: the bridge process is never signalled', async () => {
    scratch = mkdtempSync(join(tmpdir(), 'mors-health-'));
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const pidfile = join(scratch, 'bridge.pid');
      writeFileSync(pidfile, String(child.pid));
      const running = await start({ BRIDGE_PIDFILE: pidfile });
      const owner = await addOwner(running);
      const her = await addAlice(running);
      await owner.bridge.check();
      await her.bridge.check();
      for (const status of [SIGNED_OUT, PHONE_SILENT, DOWN]) {
        bridge.logins.set(ALICE_TOKEN, [login(status)]);
        for (let i = 0; i < 5; i++) {
          await her.bridge.check();
          await owner.bridge.check();
        }
      }
      bridge.logins.set(ALICE_TOKEN, false);
      for (let i = 0; i < 5; i++) await her.bridge.check();
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(child.signalCode, null);
      assert.equal(child.exitCode, null);
      assert.ok(running.health.has('bridge:alice'));
      assert.equal(running.health.has('bridge'), false);
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('with nobody but the owner the owner’s watch is the one it always was', async () => {
    const running = await start({ BRIDGE_AUTO_RESTART: 'off' });
    const owner = await addOwner(running);
    bridge.logins.set(OWNER_TOKEN, [login(SIGNED_OUT)]);
    await owner.bridge.check();
    assert.deepEqual(running.health.problems().map((problem) => problem.key), ['bridge']);
    assert.equal(told.at(-1), "Google Messages is logged out of the bridge (Logged out). Log in again on the service's /pair page.");
    assert.equal(owner.bridge.blocked(), 'the bridge is not connected to Google Messages');
    assert.equal(catalog.getState('bridge.seen'), undefined);
  });
});
