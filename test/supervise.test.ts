import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LeaseClient, Supervisor, type ChildSpec, type RunningChild, type Spawn } from '../src/cloud/supervise.ts';

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
  function service(answers: Array<{ ok: boolean; heldBy?: string; retryInSeconds?: number } | Error | number>) {
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)), authorization: new Headers(init?.headers).get('authorization') });
      const next = answers.shift() ?? { ok: true };
      if (next instanceof Error) throw next;
      if (typeof next === 'number') return new Response('nope', { status: next });
      return Response.json(next);
    }) as unknown as typeof fetch;
    return { calls, client: new LeaseClient({ url: 'https://edge.example/', token: 'tok', holder: 'host-1', ttlSeconds: 60, fetch: fakeFetch }) };
  }

  test('asks with its name and the shared token', async () => {
    const { client, calls } = service([{ ok: true }]);
    await client.acquire({ sleep: async () => {} });
    assert.deepEqual(calls, [{ url: 'https://edge.example/lease/acquire', body: { holder: 'host-1', ttlSeconds: 60 }, authorization: 'Bearer tok' }]);
  });

  test('waits while another host holds it, for as long as it is told (2 to 15 seconds), and tries again', async () => {
    const { client, calls } = service([{ ok: false, heldBy: 'old', retryInSeconds: 80 }, { ok: false, heldBy: 'old', retryInSeconds: 1 }, { ok: true }]);
    const waits: number[] = [];
    const logs: string[] = [];
    await client.acquire({ sleep: async (ms) => void waits.push(ms), log: (line) => logs.push(line) });
    assert.deepEqual(waits, [15_000, 2_000]);
    assert.equal(calls.length, 3);
    assert.ok(logs.some((line) => /old/.test(line)));
  });

  test('keeps trying through errors from the service, however many', async () => {
    const { client, calls } = service([new Error('network down'), 502, new Error('timeout'), { ok: true }]);
    const waits: number[] = [];
    await client.acquire({ sleep: async (ms) => void waits.push(ms) });
    assert.equal(calls.length, 4);
    assert.deepEqual(waits, [5000, 5000, 5000]);
  });

  test('renewing says ok, lost (another host has it) or unreachable (no answer, which is not the same)', async () => {
    const { client } = service([{ ok: true }, { ok: false, heldBy: 'other' }, new Error('down'), 500]);
    assert.equal(await client.renew(), 'ok');
    assert.equal(await client.renew(), 'lost');
    assert.equal(await client.renew(), 'unreachable');
    assert.equal(await client.renew(), 'unreachable');
  });

  test('releasing never throws', async () => {
    const { client, calls } = service([new Error('down')]);
    await client.release();
    assert.equal(calls[0]!.url, 'https://edge.example/lease/release');
  });
});
