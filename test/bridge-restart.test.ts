import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bridgeRestarter } from '../src/bridge-restart.ts';
import { BridgeWatch, Health, bridgeStatus, type BridgeStatus } from '../src/health.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { createRunner } from '../src/runner.ts';
import { startMockMatrix } from './helpers/mock-matrix.ts';

const at = (hour: number, minute = 0) => new Date(2026, 9, 9, hour, minute);
const CONNECTED: BridgeStatus = { state: 'CONNECTED', rcsEnabled: true };
const DOWN: BridgeStatus = { state: 'TRANSIENT_DISCONNECT', error: 'Fatal error polling messages', rcsEnabled: true };

/** A watch on a fake clock, with the internet, the bridge's status and its restarts under the test's control. */
function setUp(options: { restart?: boolean; restartFails?: boolean } = {}) {
  const state = { clock: at(8), up: true, status: CONNECTED as BridgeStatus | Error, restarts: 0 };
  const shown: string[] = [];
  const health = new Health({ notify: async (_title, message) => void shown.push(message), now: () => state.clock });
  const watch = new BridgeWatch({
    health,
    now: () => state.clock,
    online: async () => state.up,
    status: async () => {
      if (state.status instanceof Error) throw state.status;
      return state.status;
    },
    ...(options.restart === false
      ? {}
      : {
          restart: async () => {
            state.restarts += 1;
            if (options.restartFails) throw new Error('Could not find service "com.musicoverrcs.bridge"');
          },
        }),
  });
  const tick = async (hour: number, minute: number) => {
    state.clock = at(hour, minute);
    await watch.check();
  };
  return { state, shown, watch, tick };
}

describe('restarting the bridge on its own', () => {
  test('after the internet comes back, a bridge still disconnected two minutes later is restarted, and again while it stays down', async () => {
    const { state, shown, tick } = setUp();
    state.up = false;
    state.status = DOWN;
    await tick(8, 0);
    await tick(8, 30);
    assert.equal(state.restarts, 0, 'no restart while the internet is down');
    state.up = true;
    await tick(8, 31);
    assert.equal(state.restarts, 0, 'a moment to reconnect first');
    await tick(8, 33);
    assert.equal(state.restarts, 1);
    await tick(8, 36);
    assert.equal(state.restarts, 1, 'the first restart gets a few minutes');
    await tick(8, 38);
    assert.equal(state.restarts, 2, 'still down: again');
    await tick(8, 45);
    assert.equal(state.restarts, 2);
    await tick(8, 48);
    assert.equal(state.restarts, 3, 'then every ten minutes');
    await tick(8, 49);
    assert.match(shown.at(-1)!, /can't reach Google Messages/);
    state.status = CONNECTED;
    await tick(8, 50);
    assert.equal(shown.at(-1), 'Fixed: the bridge is connected to Google Messages again.');
    for (let minute = 51; minute < 60; minute++) await tick(8, minute);
    assert.equal(state.restarts, 3, 'connected: left alone');
  });

  test('after a long outage the bridge is refreshed even when it says it is connected, then left alone', async () => {
    const { state, tick } = setUp();
    state.up = false;
    await tick(8, 0);
    await tick(8, 20);
    state.up = true;
    await tick(8, 21);
    await tick(8, 23);
    assert.equal(state.restarts, 1);
    for (let minute = 24; minute < 60; minute++) await tick(8, minute);
    assert.equal(state.restarts, 1);
  });

  test("a blip in the internet check while the bridge is connected doesn't restart it", async () => {
    const { state, tick } = setUp();
    await tick(8, 0);
    state.up = false;
    await tick(8, 1);
    state.up = true;
    for (let minute = 2; minute < 30; minute++) await tick(8, minute);
    assert.equal(state.restarts, 0);
  });

  test('an ordinary disconnect with the internet up waits fifteen minutes before a restart', async () => {
    const { state, tick } = setUp();
    state.status = DOWN;
    await tick(8, 0);
    await tick(8, 14);
    assert.equal(state.restarts, 0);
    await tick(8, 15);
    assert.equal(state.restarts, 1);
  });

  test('a failed delivery restarts the bridge at most once in ten minutes', async () => {
    const { state, watch } = setUp();
    await watch.sendFailed();
    await watch.sendFailed();
    assert.equal(state.restarts, 1);
    state.clock = at(8, 9);
    await watch.sendFailed();
    assert.equal(state.restarts, 1);
    state.clock = at(8, 11);
    await watch.sendFailed();
    assert.equal(state.restarts, 2);
  });

  test("with restarts off, or when one fails, it's said on the Mac instead", async () => {
    const off = setUp({ restart: false });
    await off.watch.sendFailed();
    assert.match(off.shown.at(-1)!, /reported an undelivered message\. Restart the bridge: npm run stack -- restart/);

    const failing = setUp({ restartFails: true });
    await failing.watch.sendFailed();
    assert.equal(failing.state.restarts, 1);
    assert.match(failing.shown.at(-1)!, /couldn't restart automatically \(Could not find service .*\)\. Restart it manually/);
  });
});

describe('recovering by itself when Google turns the bridge away for a while', () => {
  const SIGNED_OUT: BridgeStatus = { state: 'BAD_CREDENTIALS', rcsEnabled: true };
  /** Ticks every minute from `from` (minutes after 08:00) up to but not including `to`. */
  const run = async (tick: (hour: number, minute: number) => Promise<void>, from: number, to: number) => {
    for (let t = from; t < to; t++) await tick(8 + Math.floor(t / 60), t % 60);
  };

  test("a block that lasts hours is waited out: restarts keep coming, the bridge is back within ten minutes of it lifting, and it is said only once", async () => {
    const { state, shown, tick } = setUp();
    state.status = DOWN;
    await run(tick, 0, 180);
    assert.ok(state.restarts >= 15, `restarted again and again (${state.restarts} times in three hours)`);
    assert.ok(state.restarts <= 20, `but not constantly (${state.restarts})`);
    assert.equal(shown.filter((line) => /can't reach Google Messages/.test(line)).length, 1, 'said once, not at every restart');
    assert.match(shown.at(-1)!, /keeps restarting it and reconnects on its own/);

    // The block lifts: the next restart gets through.
    const before = state.restarts;
    const liftedAt = 180;
    let backAt: number | undefined;
    for (let t = liftedAt; t < liftedAt + 15 && backAt === undefined; t++) {
      const restartsBefore = state.restarts;
      await tick(8 + Math.floor(t / 60), t % 60);
      if (state.restarts > restartsBefore) state.status = CONNECTED;
      else if (state.status === CONNECTED) backAt = t;
    }
    assert.ok(state.restarts > before);
    assert.ok(backAt !== undefined && backAt - liftedAt <= 11, `back ${backAt === undefined ? 'never' : `${backAt - liftedAt} minutes`} after the block lifted`);
    await tick(11, 20);
    assert.equal(shown.at(-1), 'Fixed: the bridge is connected to Google Messages again.');
  });

  test("a bridge signed out by a block is restarted after two minutes, not left waiting for a login; it is said only after fifteen", async () => {
    const { state, shown, tick } = setUp();
    state.status = SIGNED_OUT;
    await tick(8, 0);
    await tick(8, 1);
    assert.equal(state.restarts, 0);
    await tick(8, 2);
    assert.equal(state.restarts, 1);
    assert.deepEqual(shown, [], 'nothing said while it may mend itself');
    await run(tick, 3, 14);
    assert.deepEqual(shown, []);
    await tick(8, 15);
    assert.match(shown.at(-1)!, /signed out of Google Messages\. The bot keeps restarting it and reconnects on its own.*If this lasts for hours, log in again/);
    assert.ok(state.restarts >= 2);
    state.status = CONNECTED;
    await tick(8, 16);
    assert.equal(shown.at(-1), 'Fixed: the bridge is connected to Google Messages again.');
  });

  test("a bridge that has only just started, and has no state yet, is not called logged out; one with no login at all is, after two minutes, and isn't restarted", async () => {
    const { state, shown, tick } = setUp();
    state.status = { state: undefined };
    await tick(8, 0);
    await tick(8, 1);
    assert.deepEqual(shown, []);
    await tick(8, 2);
    assert.match(shown.at(-1)!, /^Google Messages is logged out of the bridge\. Log in again: npm run matrix-console/);
    await run(tick, 3, 40);
    assert.equal(state.restarts, 0, 'a restart cannot link an account');
  });

  test('a bridge that stops answering is restarted too, again and again, and the Mac says so at once', async () => {
    const { state, shown, tick } = setUp();
    state.status = new Error('connection refused');
    await tick(8, 0);
    assert.match(shown.at(-1)!, /isn't answering/);
    assert.equal(state.restarts, 0);
    await tick(8, 2);
    assert.equal(state.restarts, 1);
    await run(tick, 3, 60);
    assert.ok(state.restarts >= 5 && state.restarts <= 8, `${state.restarts}`);
    state.status = CONNECTED;
    await tick(9, 1);
    assert.equal(shown.at(-1), 'Fixed: the bridge is connected to Google Messages again.');
  });

  test("a restart that can't happen (the bridge was stopped on purpose) is not hammered every minute", async () => {
    const { state, shown, tick } = setUp({ restartFails: true });
    state.status = DOWN;
    await run(tick, 0, 60);
    assert.ok(state.restarts >= 3 && state.restarts <= 5, `${state.restarts}`);
    assert.ok(shown.some((line) => /couldn't restart automatically/.test(line)));
  });
});

describe("the bridge's login status", () => {
  const ask = (logins: unknown) => bridgeStatus({ url: 'http://bridge', token: 't', userId: '@dave:localhost', fetch: (async () => Response.json({ logins })) as typeof fetch });

  test('a login that has not reported a state yet is connecting, not logged out; no login at all has no state', async () => {
    assert.equal((await ask([{}])).state, 'CONNECTING');
    assert.equal((await ask([])).state, undefined);
    const connected = await ask([{ state: { state_event: 'CONNECTED', info: { settings: { rcs_enabled: true } } } }]);
    assert.deepEqual([connected.state, connected.rcsEnabled], ['CONNECTED', true]);
    assert.equal((await ask([{ state: { state_event: 'BAD_CREDENTIALS', message: 'Logged out' } }])).message, 'Logged out');
  });
});

describe('bridgeRestarter', () => {
  test('kicks the launchd service on a Mac, unless BRIDGE_AUTO_RESTART is off', async () => {
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]) => void calls.push([file, ...args]);
    const restart = bridgeRestarter({}, { platform: 'darwin', uid: 501, exec });
    await restart!();
    assert.deepEqual(calls, [['/bin/launchctl', 'kickstart', '-k', 'gui/501/com.musicoverrcs.bridge']]);
    await bridgeRestarter({ BRIDGE_SERVICE: 'com.example.bridge' }, { platform: 'darwin', uid: 501, exec })!();
    assert.deepEqual(calls.at(-1), ['/bin/launchctl', 'kickstart', '-k', 'gui/501/com.example.bridge']);
    for (const value of ['off', 'false', 'no', '0', 'OFF']) assert.equal(bridgeRestarter({ BRIDGE_AUTO_RESTART: value }, { platform: 'darwin', uid: 501, exec }), undefined);
    assert.equal(bridgeRestarter({}, { platform: 'linux', uid: 501, exec }), undefined);
    assert.equal(bridgeRestarter({}, { platform: 'darwin', uid: undefined, exec }), undefined);
  });
});

describe("the bridge's delivery notices", () => {
  test("a slow phone is no failure; another reason is, and it reaches the restart", async () => {
    const mock = await startMockMatrix();
    try {
      const client = new MatrixClient({ token: mock.token, homeserver: mock.url });
      await client.listMessages(mock.roomId);
      mock.addMessage(mock.botUser, { msgtype: 'm.notice', body: '⚠️ Your message may not have been bridged: phone has not confirmed message delivery' });
      mock.addMessage(mock.botUser, { msgtype: 'm.notice', body: '⚠️ Your message may not have been bridged: failed to upload media' });
      mock.addMessage(mock.ghost, { msgtype: 'm.text', body: 'Your message may not have been bridged: just a text I typed' });
      const failures = (await client.listMessages(mock.roomId)).map((message) => message.bridgeSendFailure === true);
      assert.deepEqual(failures, [false, true, false]);

      let restarts = 0;
      const runner = createRunner({
        chat: client,
        bot: { handle: async () => [] },
        chatID: mock.roomId,
        fetchAudio: async () => {
          throw new Error('no songs here');
        },
        onBridgeSendFailure: () => void (restarts += 1),
      });
      await runner.prime();
      mock.addMessage(mock.botUser, { msgtype: 'm.notice', body: '⚠️ Your message may not have been bridged: phone has not confirmed message delivery' });
      mock.addMessage(mock.botUser, { msgtype: 'm.notice', body: '⚠️ Your message may not have been bridged: failed to upload media' });
      await runner.tick();
      assert.equal(restarts, 1);
    } finally {
      await mock.close();
    }
  });
});
