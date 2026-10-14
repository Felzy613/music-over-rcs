import { spawn as nodeSpawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

/** One long-running process the host keeps going, like a launchd job with KeepAlive. */
export interface ChildSpec {
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Not started (or started again) until this says true, e.g. until the homeserver answers. */
  ready?: () => Promise<boolean>;
  /** Where the process id is written on each start, for the bot to restart this process with a signal. */
  pidFile?: string;
  /** Stopped in this order, lowest first, so the bot stops before the services it uses and the replicator last. */
  stopRank: number;
}

export interface RunningChild {
  pid: number | undefined;
  /** Calls back once, when the process has ended. */
  onExit(callback: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export type Spawn = (spec: ChildSpec, onLine: (line: string) => void) => RunningChild;

export const nodeSpawner: Spawn = (spec, onLine) => {
  const child = nodeSpawn(spec.command, spec.args, { env: spec.env ?? process.env, cwd: spec.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', onLine);
  return {
    pid: child.pid,
    onExit: (callback) => {
      child.once('error', () => callback(null, null));
      child.once('exit', callback);
    },
    kill: (signal) => void child.kill(signal),
  };
};

export interface SupervisorOptions {
  spawn?: Spawn;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Wait before starting a process again after it ended (default 5 s, doubling to a minute while it keeps ending quickly). */
  restartDelayMs?: number;
  /** How long a process is given to end after being asked to, before it is killed. */
  graceMs?: number;
  /** Wait before starting a process that was asked to end by a signal (the bot restarting the bridge); default 1 s. */
  askedDelayMs?: number;
  writePid?: (path: string, pid: number) => void;
}

interface Slot {
  spec: ChildSpec;
  child: RunningChild | undefined;
  startedAt: number;
  quickEnds: number;
  ended: Promise<void>;
  restart: NodeJS.Timeout | undefined;
}

/**
 * Keeps a set of processes running: starts each once it is ready, starts it again when it ends (waiting longer if it keeps
 * ending at once), prefixes what each prints with its name, and on stop asks them to end in order and kills a straggler.
 */
export class Supervisor {
  #slots: Slot[] = [];
  #stopping = false;
  #spawn: Spawn;
  #log: (line: string) => void;
  #sleep: (ms: number) => Promise<void>;
  #now: () => number;
  #restartDelay: number;
  #grace: number;
  #askedDelay: number;
  #writePid: (path: string, pid: number) => void;

  constructor(options: SupervisorOptions) {
    this.#spawn = options.spawn ?? nodeSpawner;
    this.#log = options.log;
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
    this.#restartDelay = options.restartDelayMs ?? 5000;
    this.#grace = options.graceMs ?? 20_000;
    this.#askedDelay = options.askedDelayMs ?? 1000;
    this.#writePid = options.writePid ?? ((path, pid) => writeFileSync(path, `${pid}\n`));
  }

  /** Begins keeping each process running. Returns at once; a process that isn't ready yet is started when it is. */
  start(specs: ChildSpec[]): void {
    for (const spec of specs) {
      const slot: Slot = { spec, child: undefined, startedAt: 0, quickEnds: 0, ended: Promise.resolve(), restart: undefined };
      this.#slots.push(slot);
      void this.#launch(slot);
    }
  }

  /** The names of the processes running now. */
  running(): string[] {
    return this.#slots.filter((slot) => slot.child).map((slot) => slot.spec.name);
  }

  async #launch(slot: Slot): Promise<void> {
    const { spec } = slot;
    while (!this.#stopping && spec.ready && !(await spec.ready().catch(() => false))) await this.#sleep(1000);
    if (this.#stopping) return;
    slot.startedAt = this.#now();
    const child = this.#spawn(spec, (line) => this.#log(`[${spec.name}] ${line}`));
    slot.child = child;
    if (spec.pidFile && child.pid !== undefined) {
      try {
        this.#writePid(spec.pidFile, child.pid);
      } catch (err) {
        this.#log(`could not write ${spec.pidFile}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.#log(`started ${spec.name}${child.pid !== undefined ? ` (pid ${child.pid})` : ''}`);
    slot.ended = new Promise<void>((resolve) => {
      child.onExit((code, signal) => {
        slot.child = undefined;
        resolve();
        if (this.#stopping) return;
        const ranFor = this.#now() - slot.startedAt;
        slot.quickEnds = ranFor < 30_000 ? slot.quickEnds + 1 : 0;
        // Asked to end by the bot (a bridge restart) is not a crash: back at once.
        const asked = signal === 'SIGTERM';
        const delay = asked ? this.#askedDelay : Math.min(this.#restartDelay * 2 ** Math.max(0, slot.quickEnds - 1), 60_000);
        this.#log(`${spec.name} ended (${signal ?? `code ${code}`}) after ${Math.round(ranFor / 1000)} s; starting it again in ${delay >= 1000 ? `${Math.round(delay / 1000)} s` : `${delay} ms`}`);
        slot.restart = setTimeout(() => void this.#launch(slot), delay);
      });
    });
  }

  /** Ends every process, in order, and returns when all are gone. */
  async stop(): Promise<void> {
    this.#stopping = true;
    for (const slot of this.#slots) clearTimeout(slot.restart);
    const ranks = [...new Set(this.#slots.map((slot) => slot.spec.stopRank))].sort((a, b) => a - b);
    for (const rank of ranks) {
      await Promise.all(
        this.#slots
          .filter((slot) => slot.spec.stopRank === rank && slot.child)
          .map(async (slot) => {
            const child = slot.child!;
            this.#log(`stopping ${slot.spec.name}`);
            child.kill('SIGTERM');
            let timer: NodeJS.Timeout | undefined;
            const gaveUp = new Promise<'late'>((resolve) => {
              timer = setTimeout(() => resolve('late'), this.#grace);
            });
            if ((await Promise.race([slot.ended.then(() => 'done' as const), gaveUp])) === 'late') {
              this.#log(`${slot.spec.name} did not end in time; killing it`);
              child.kill('SIGKILL');
              await slot.ended;
            }
            clearTimeout(timer);
          }),
      );
    }
  }
}

export type LeaseState = 'ok' | 'lost' | 'unreachable';

/** The client of the Worker's lease (cloudflare/lease.ts): at most one host runs at a time. */
export class LeaseClient {
  #url: string;
  #token: string;
  #holder: string;
  #ttl: number;
  #fetch: typeof fetch;

  constructor(options: { url: string; token: string; holder: string; ttlSeconds?: number; fetch?: typeof fetch }) {
    this.#url = options.url.replace(/\/+$/, '');
    this.#token = options.token;
    this.#holder = options.holder;
    this.#ttl = options.ttlSeconds ?? 90;
    this.#fetch = options.fetch ?? fetch;
  }

  get holder(): string {
    return this.#holder;
  }

  async #call(action: 'acquire' | 'renew' | 'release'): Promise<{ ok: boolean; heldBy?: string; retryInSeconds?: number }> {
    const res = await this.#fetch(`${this.#url}/lease/${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ holder: this.#holder, ttlSeconds: this.#ttl }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`the lease service answered HTTP ${res.status}`);
    return (await res.json()) as { ok: boolean; heldBy?: string; retryInSeconds?: number };
  }

  /** Waits until the lease is this host's, however long the old host takes to let go. */
  async acquire(options: { sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {}): Promise<void> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let waited = 0; ; ) {
      let wait = 5;
      try {
        const answer = await this.#call('acquire');
        if (answer.ok) {
          options.log?.(`took the lease as ${this.#holder}`);
          return;
        }
        wait = Math.min(Math.max(answer.retryInSeconds ?? 5, 2), 15);
        options.log?.(`another host (${answer.heldBy ?? 'unknown'}) holds the lease; waiting ${wait} s (${waited} s so far)`);
      } catch (err) {
        options.log?.(`could not reach the lease service: ${err instanceof Error ? err.message : String(err)}; trying again in ${wait} s`);
      }
      waited += wait;
      await sleep(wait * 1000);
    }
  }

  /** Extends the lease. 'lost' means another host has it now, and this one must stop; 'unreachable' means only that the service didn't answer. */
  async renew(): Promise<LeaseState> {
    try {
      return (await this.#call('renew')).ok ? 'ok' : 'lost';
    } catch {
      return 'unreachable';
    }
  }

  async release(): Promise<void> {
    try {
      await this.#call('release');
    } catch {
      // it lapses by itself in a minute or so
    }
  }
}
