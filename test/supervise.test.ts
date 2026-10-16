import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { acquire, type LeaseStore } from '../src/cloud/lease.ts';
import { LeaseClient, Supervisor, type ChildSpec, type RunningChild, type Spawn } from '../src/cloud/supervise.ts';
import { memoryLeaseStore } from './helpers/memory-lease.ts';

/** Processes that exist only as far as the test says: it decides when each one ends. */
class FakeProcesses {
  started: string[] = [];
  live = new Map<string, FakeChild[]>();
  killed: Array<[string, NodeJS.Signals]> = [];
  /** Processes that ignore SIGTERM until killed. */
  stubborn = new Set<string>();
  #pid = 100;
  spawn: Spawn = (spec, onLine) => {
    const child = new FakeChild(++this.#pid, (signal) => {
      this.killed.push([spec.name, signal]);
      if (signal === 'SIGKILL' || !this.stubborn.has(spec.name)) child.end(null, signal);
    });
    this.started.push(spec.name);
    this.live.set(spec.name, [...(this.live.get(spec.name) ?? []), child]);
    onLine(`hello from ${spec.name}`);
    return child;
  };
  last(name: string): FakeChild {
    return this.live.get(name)!.at(-1)!;
  }
}

class FakeChild implements RunningChild {
  pid: number;
  #exit: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  #kill: (signal: NodeJS.Signals) => void;
  constructor(pid: number, kill: (signal: NodeJS.Signals) => void) {
    this.pid = pid;
    this.#kill = kill;
  }
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.#exit = callback;
  }
  kill(signal: NodeJS.Signals): void {
    this.#kill(signal);
  }
  end(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.#exit?.(code, signal);
  }
}

const spec = (name: string, extra: Partial<ChildSpec> = {}): ChildSpec => ({ name, command: name, args: [], stopRank: 1, ...extra });
const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the supervisor', () => {
  function setUp(options: { restartDelayMs?: number; graceMs?: number } = {}) {
    const processes = new FakeProcesses();
    const logs: string[] = [];
    const pids: Array<[string, number]> = [];
    const supervisor = new Supervisor({
      spawn: processes.spawn,
      log: (line) => logs.push(line),
      sleep: async () => void (await settle(2)),
      restartDelayMs: options.restartDelayMs ?? 10,
      askedDelayMs: 5,
      graceMs: options.graceMs ?? 40,
      writePid: (path, pid) => void pids.push([path, pid]),
    });
    return { processes, logs, pids, supervisor };
  }

  test('starts each process and prefixes what it prints with its name', async () => {
    const { processes, logs, supervisor } = setUp();
    supervisor.start([spec('synapse'), spec('bot')]);
    await settle();
    assert.deepEqual(processes.started, ['synapse', 'bot']);
    assert.ok(logs.includes('[synapse] hello from synapse'));
    assert.deepEqual(supervisor.running(), ['synapse', 'bot']);
  });

  test('a process that is not ready waits, and starts when it is', async () => {
    const { processes, supervisor } = setUp();
    let ready = false;
    supervisor.start([spec('bridge', { ready: async () => ready })]);
    await settle(20);
    assert.deepEqual(processes.started, []);
    ready = true;
    await settle(30);
    assert.deepEqual(processes.started, ['bridge']);
  });

  test('writes the process id where the bot looks for it, each time it starts', async () => {
    const { processes, pids, supervisor } = setUp();
    supervisor.start([spec('bridge', { pidFile: '/run/mors/bridge.pid' })]);
    await settle();
    processes.last('bridge').end(1);
    await settle(40);
    assert.deepEqual(pids.map(([path]) => path), ['/run/mors/bridge.pid', '/run/mors/bridge.pid']);
    assert.notEqual(pids[0]![1], pids[1]![1]);
  });

  test('starts a process again when it ends, and keeps the others going', async () => {
    const { processes, supervisor } = setUp();
    supervisor.start([spec('synapse'), spec('bot')]);
    await settle();
    processes.last('bot').end(1);
    await settle(40);
    assert.deepEqual(processes.started, ['synapse', 'bot', 'bot']);
  });

  test('a process that keeps ending at once is started less and less often', async () => {
    const { processes, supervisor } = setUp({ restartDelayMs: 20 });
    supervisor.start([spec('bot')]);
    await settle();
    processes.last('bot').end(1);
    await settle(30);
    assert.equal(processes.started.length, 2);
    processes.last('bot').end(1);
    await settle(25);
    assert.equal(processes.started.length, 2, 'the second wait is twice as long');
    await settle(40);
    assert.equal(processes.started.length, 3);
  });

  test('a process the bot asked to end (a bridge restart) is back quickly, not treated as a crash', async () => {
    const { processes, supervisor } = setUp({ restartDelayMs: 500 });
    supervisor.start([spec('bridge')]);
    await settle();
    processes.last('bridge').end(null, 'SIGTERM');
    await settle(40);
    assert.equal(processes.started.length, 2);
  });

  test('stopping ends them in order, lowest rank first, and starts nothing again', async () => {
    const { processes, supervisor } = setUp();
    supervisor.start([spec('litestream', { stopRank: 4 }), spec('synapse', { stopRank: 3 }), spec('bridge', { stopRank: 2 }), spec('bot', { stopRank: 1 })]);
    await settle();
    await supervisor.stop();
    assert.deepEqual(processes.killed.map(([name]) => name), ['bot', 'bridge', 'synapse', 'litestream']);
    assert.deepEqual(supervisor.running(), []);
    await settle(40);
    assert.equal(processes.started.length, 4, 'nothing was restarted');
  });

  test('a process that will not end is killed after the grace period', async () => {
    const { processes, supervisor } = setUp({ graceMs: 30 });
    processes.stubborn.add('bot');
    supervisor.start([spec('bot')]);
    await settle();
    await supervisor.stop();
    assert.deepEqual(processes.killed, [['bot', 'SIGTERM'], ['bot', 'SIGKILL']]);
  });

  test('stopping while a process is waiting to be ready starts it never', async () => {
    const { processes, supervisor } = setUp();
    supervisor.start([spec('bridge', { ready: async () => false })]);
    await settle(10);
    await supervisor.stop();
    await settle(30);
    assert.deepEqual(processes.started, []);
  });
});

describe('the lease client', () => {
  function setUp() {
    const store = memoryLeaseStore();
    let clock = 1_800_000_000_000;
    const client = new LeaseClient({ store, holder: 'host-1', ttlSeconds: 60, now: () => clock });
    return { store, client, advance: (ms: number) => void (clock += ms), at: () => clock };
  }

  test('takes the lease when it is free', async () => {
    const { client, store, at } = setUp();
    await client.acquire({ sleep: async () => {} });
    assert.deepEqual((await store.read())?.record, { holder: 'host-1', expiresAt: at() + 60_000 });
  });

  test('waits while another host holds it, for as long as it is told (2 to 15 seconds), and tries again', async () => {
    const { client, store, at, advance } = setUp();
    await acquire(store, 'old', 90, at());
    const waits: number[] = [];
    const logs: string[] = [];
    await client.acquire({
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 2) advance(100_000); // the old host's lease runs out
      },
      log: (line) => logs.push(line),
    });
    assert.deepEqual(waits, [15_000, 15_000]);
    assert.ok(logs.some((line) => /old/.test(line)));
    assert.equal((await store.read())?.record.holder, 'host-1');
  });

  test('says so when the lease has run out but R2 will not take the update', async () => {
    const real = memoryLeaseStore();
    await acquire(real, 'old', 60, 0);
    let refusals = 2;
    const store: LeaseStore = {
      read: () => real.read(),
      write: async (record, version) => (refusals-- > 0 ? false : real.write(record, version)),
    };
    const logs: string[] = [];
    const client = new LeaseClient({ store, holder: 'host-1', now: () => 3_600_000 });
    await client.acquire({ sleep: async () => {}, log: (line) => logs.push(line) });
    assert.equal(logs.filter((line) => /has run out but R2 refused the update/.test(line)).length, 2);
    assert.equal(logs.some((line) => /another host/.test(line)), false);
    assert.match(logs.at(-1)!, /took the lease as host-1/);
  });

  test('tells the caller each time it has to wait (so it can open a waiting door), and never when the lease is free', async () => {
    const free = new LeaseClient({ store: memoryLeaseStore(), holder: 'host-1' });
    let calls = 0;
    await free.acquire({ sleep: async () => {}, onWaiting: () => void calls++ });
    assert.equal(calls, 0);

    const store = memoryLeaseStore();
    await acquire(store, 'old', 90, 0);
    let now = 0;
    const waiting = new LeaseClient({ store, holder: 'host-2', now: () => now });
    let told = 0;
    await waiting.acquire({
      sleep: async () => {
        now += 40_000;
      },
      onWaiting: () => void told++,
    });
    assert.equal(told, 3, 'refused at 0 s, 40 s and 80 s, then the lease lapsed at 90 s');
  });

  test('keeps trying through errors from R2, however many', async () => {
    let failures = 3;
    const real = memoryLeaseStore();
    const flaky: LeaseStore = {
      read: async () => {
        if (failures-- > 0) throw new Error('R2 refused reading lease.json (HTTP 503)');
        return real.read();
      },
      write: (record, version) => real.write(record, version),
    };
    const client = new LeaseClient({ store: flaky, holder: 'host-1' });
    const waits: number[] = [];
    await client.acquire({ sleep: async (ms) => void waits.push(ms) });
    assert.deepEqual(waits, [5000, 5000, 5000]);
  });

  test('renewing says ok, lost (another host has it) or unreachable (no answer, which is not the same)', async () => {
    const { client, store, at, advance } = setUp();
    await client.acquire({ sleep: async () => {} });
    assert.equal(await client.renew(), 'ok');
    advance(120_000);
    await acquire(store, 'other', 60, at());
    assert.equal(await client.renew(), 'lost');
    const broken = new LeaseClient({ store: { read: async () => { throw new Error('down'); }, write: async () => false }, holder: 'host-1' });
    assert.equal(await broken.renew(), 'unreachable');
  });

  test('releasing gives it back, and never throws', async () => {
    const { client, store } = setUp();
    await client.acquire({ sleep: async () => {} });
    await client.release();
    assert.equal((await store.read())?.record.expiresAt, 0);
    await new LeaseClient({ store: { read: async () => { throw new Error('down'); }, write: async () => false }, holder: 'x' }).release();
  });
});
