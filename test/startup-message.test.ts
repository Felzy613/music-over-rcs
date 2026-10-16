import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { STARTUP_SENT_KEY, STARTUP_TEXT, sendStartupMessage, startupModeFrom, type StartupMode } from '../src/startup-message.ts';
import type { Reply } from '../src/types.ts';

function setUp(mode: StartupMode, extra: { readyAnswers?: boolean[]; failSends?: number; seed?: Record<string, string> } = {}) {
  const store = new Map<string, string>(Object.entries(extra.seed ?? {}));
  const sent: Reply[][] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const answers = [...(extra.readyAnswers ?? [true])];
  let failures = extra.failSends ?? 0;
  const run = (more: Partial<Parameters<typeof sendStartupMessage>[0]> = {}) =>
    sendStartupMessage({
      mode,
      state: { getState: (key) => store.get(key), setState: (key, value) => void store.set(key, value) },
      ready: async () => answers.length > 1 ? answers.shift()! : answers[0]!,
      send: async (replies) => {
        if (failures-- > 0) throw new Error('the chat refused it');
        sent.push(replies);
      },
      sleep: async (ms) => void sleeps.push(ms),
      now: () => new Date('2026-10-16T03:00:00Z'),
      log: (line) => logs.push(line),
      ...more,
    });
  return { run, store, sent, logs, sleeps };
}

describe('the startup message', () => {
  test('modes: off by default, once or always when asked, and a typo is an error rather than a silent default', () => {
    assert.equal(startupModeFrom({}), 'off');
    assert.equal(startupModeFrom({ STARTUP_MESSAGE: ' Once ' }), 'once');
    assert.equal(startupModeFrom({ STARTUP_MESSAGE: 'always' }), 'always');
    assert.equal(startupModeFrom({ STARTUP_MESSAGE: 'off' }), 'off');
    assert.throws(() => startupModeFrom({ STARTUP_MESSAGE: 'sometimes' }), /off, once or always/);
  });

  test('once: says hello the first time, as plain bot text, and remembers it', async () => {
    const { run, store, sent } = setUp('once');
    assert.equal(await run(), true);
    assert.deepEqual(sent, [[{ kind: 'text', text: STARTUP_TEXT }]]);
    assert.equal(store.get(STARTUP_SENT_KEY), '2026-10-16T03:00:00.000Z');
  });

  test('once: a start after that, even a new process, stays quiet', async () => {
    const { run, sent } = setUp('once', { seed: { [STARTUP_SENT_KEY]: '2026-10-15T00:00:00.000Z' } });
    assert.equal(await run(), false);
    assert.equal(sent.length, 0);
  });

  test('always: says hello at every start', async () => {
    const { run, sent } = setUp('always', { seed: { [STARTUP_SENT_KEY]: '2026-10-15T00:00:00.000Z' } });
    assert.equal(await run(), true);
    assert.equal(sent.length, 1);
  });

  test('off: nothing, and the bridge is not even asked', async () => {
    let asked = 0;
    const { run, sent } = setUp('off');
    assert.equal(await run({ ready: async () => (asked++, true) }), false);
    assert.equal(sent.length, 0);
    assert.equal(asked, 0);
  });

  test('waits until the bridge can deliver, instead of sending a message that would be lost', async () => {
    const { run, sent, sleeps, store } = setUp('once', { readyAnswers: [false, false, true] });
    assert.equal(await run({ everyMs: 7000 }), true);
    assert.deepEqual(sleeps, [7000, 7000]);
    assert.equal(sent.length, 1);
    assert.ok(store.get(STARTUP_SENT_KEY));
  });

  test('a refused send is tried again, and a once that never went out is not marked as sent', async () => {
    const retried = setUp('once', { failSends: 2 });
    assert.equal(await retried.run(), true);
    assert.equal(retried.sent.length, 1);
    assert.equal(retried.logs.filter((line) => /the chat refused it/.test(line)).length, 2);

    const never = setUp('once', { readyAnswers: [false] });
    assert.equal(await never.run({ attempts: 3 }), false);
    assert.equal(never.store.has(STARTUP_SENT_KEY), false, 'the next start tries again');
    assert.deepEqual(never.sleeps.length, 2);
    assert.match(never.logs.at(-1)!, /not sent after 3 tries/);
  });

  test('stops trying when the bot is shutting down', async () => {
    let stopped = false;
    const { run, sent } = setUp('once', { readyAnswers: [false] });
    assert.equal(await run({ sleep: async () => void (stopped = true), stopped: () => stopped }), false);
    assert.equal(sent.length, 0);
  });
});
