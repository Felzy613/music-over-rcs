import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HostRestartError, RESTART_DELAY_MS, RESTART_EXIT_CODE, RESTART_PENDING_MS, RESTART_SIGNAL, hostRestarter } from '../src/cloud/host-restart.ts';

// The bot's side of "restart the host": a signal to the host's own process, a few seconds after the answer to the page, at most once.

type Call = { pid: number; signal: NodeJS.Signals | 0 };

function make(env: NodeJS.ProcessEnv, options: { failing?: (call: Call) => Error | undefined; ownPid?: number; now?: () => number } = {}) {
  const calls: Call[] = [];
  const timers: Array<{ work: () => void; ms: number }> = [];
  const lines: string[] = [];
  const restarter = hostRestarter(env, {
    kill: (pid, signal) => {
      const call = { pid, signal };
      calls.push(call);
      const err = options.failing?.(call);
      if (err) throw err;
    },
    setTimer: (work, ms) => void timers.push({ work, ms }),
    log: (line) => lines.push(line),
    ownPid: options.ownPid ?? 77,
    ...(options.now ? { now: options.now } : {}),
  });
  return { restarter, calls, timers, lines };
}

describe('asking the host to restart', () => {
  test('uses SIGUSR2 and a failure exit code, and waits a few seconds so the page gets its answer first', () => {
    assert.equal(RESTART_SIGNAL, 'SIGUSR2');
    assert.notEqual(RESTART_EXIT_CODE, 0, 'a clean exit is not known to be started again');
    assert.ok(RESTART_DELAY_MS >= 2000);
  });

  test('signals the process the host named, not a moment before the delay, and says in how many seconds', () => {
    const { restarter, calls, timers, lines } = make({ HOST_PID: '4242' });
    assert.deepEqual(restarter.available(), { ok: true });
    const answer = restarter.request();
    assert.equal(answer.inSeconds, Math.round(RESTART_DELAY_MS / 1000));
    // Before the delay only the "is it there" question (signal 0) has been asked.
    assert.deepEqual(calls, [{ pid: 4242, signal: 0 }]);
    assert.equal(timers.length, 1);
    assert.equal(timers[0]!.ms, RESTART_DELAY_MS);
    timers[0]!.work();
    assert.deepEqual(calls, [{ pid: 4242, signal: 0 }, { pid: 4242, signal: 'SIGUSR2' }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /restart requested from the console/);
  });

  test('only once: a second request while one is on its way is a 409, and it stays so', () => {
    const { restarter, calls, timers } = make({ HOST_PID: '4242' });
    assert.equal(restarter.pending(), false);
    restarter.request();
    assert.equal(restarter.pending(), true);
    for (let i = 0; i < 3; i++) {
      assert.throws(() => restarter.request(), (err: HostRestartError) => err instanceof HostRestartError && err.status === 409 && /already on its way/.test(err.message));
    }
    timers[0]!.work();
    assert.equal(restarter.pending(), true, 'until the process ends');
    assert.equal(calls.filter((call) => call.signal === 'SIGUSR2').length, 1);
    assert.equal(timers.length, 1);
  });

  test('without HOST_PID, or with one that is not a process id of the host, it cannot, and says so; nothing is signalled', () => {
    for (const env of [{}, { HOST_PID: '' }, { HOST_PID: 'abc' }, { HOST_PID: '-5' }, { HOST_PID: '1' }, { HOST_PID: '0' }, { HOST_PID: '77' }, { HOST_PID: '12; kill 1' }, { HOST_PID: '4242 ' + '9'.repeat(20) }]) {
      const { restarter, calls, timers } = make(env, { ownPid: 77 });
      const can = restarter.available();
      assert.equal(can.ok, false, JSON.stringify(env));
      assert.match((can as { why: string }).why, /Restart the service in Render/);
      assert.throws(() => restarter.request(), (err: HostRestartError) => err.status === 409, JSON.stringify(env));
      assert.deepEqual([calls, timers], [[], []], JSON.stringify(env));
      assert.equal(restarter.pending(), false);
    }
  });

  test('never signals itself, whatever HOST_PID says', () => {
    const { restarter, calls } = make({ HOST_PID: '77' }, { ownPid: 77 });
    assert.equal(restarter.available().ok, false);
    assert.throws(() => restarter.request());
    assert.deepEqual(calls, []);
  });

  test('a host that is not there is an error now, and nothing is left pending', () => {
    const { restarter, calls, timers } = make({ HOST_PID: '4242' }, { failing: () => new Error('kill ESRCH') });
    assert.throws(() => restarter.request(), (err: HostRestartError) => err.status === 503 && /not there/.test(err.message) && /Render/.test(err.message));
    assert.equal(restarter.pending(), false);
    assert.deepEqual(calls, [{ pid: 4242, signal: 0 }]);
    assert.equal(timers.length, 0);
  });

  test('if the signal itself fails later, it is logged and the request can be made again', () => {
    const { restarter, timers, lines } = make({ HOST_PID: '4242' }, { failing: (call) => (call.signal === 'SIGUSR2' ? new Error('kill EPERM') : undefined) });
    restarter.request();
    timers[0]!.work();
    assert.equal(restarter.pending(), false);
    assert.match(lines.at(-1)!, /could not be asked to restart: kill EPERM/);
    assert.doesNotThrow(() => restarter.request());
  });

  test('a request that was never followed by the host stopping us is forgotten after a while, so the owner is not locked out', () => {
    let clock = 1_000_000;
    const { restarter, timers } = make({ HOST_PID: '4242' }, { now: () => clock });
    restarter.request();
    timers[0]!.work();
    clock += RESTART_PENDING_MS - 1;
    assert.equal(restarter.pending(), true);
    assert.throws(() => restarter.request(), (err: HostRestartError) => err.status === 409);
    clock += 1;
    assert.equal(restarter.pending(), false);
    assert.doesNotThrow(() => restarter.request());
    assert.equal(restarter.pending(), true);
  });
});
