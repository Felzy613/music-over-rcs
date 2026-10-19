import { readdirSync, readFileSync } from 'node:fs';

/** How much memory there is and how much of it is in use. */
export interface MemoryUse {
  limit: number;
  used: number;
}

/**
 * The container's memory limit and what is really using it (anonymous memory: the processes' own, not the file cache, which the
 * system takes back when it needs it). That is what decides whether a big song can be handled without the host being killed,
 * whichever process holds the memory. Nothing when there is no limit or this is not a container (the Mac).
 */
export function containerMemory(read: (path: string) => string = (path) => readFileSync(path, 'utf8')): MemoryUse | undefined {
  try {
    const max = read('/sys/fs/cgroup/memory.max').trim();
    if (max === 'max') return undefined;
    const limit = Number(max);
    const anon = Number(/^anon (\d+)$/m.exec(read('/sys/fs/cgroup/memory.stat'))?.[1]);
    const shmem = Number(/^shmem (\d+)$/m.exec(read('/sys/fs/cgroup/memory.stat'))?.[1] ?? 0);
    return Number.isFinite(limit) && limit > 0 && Number.isFinite(anon) ? { limit, used: anon + (Number.isFinite(shmem) ? shmem : 0) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The memory check for the bot: the container's, when there is one; otherwise this process against a share it was told it has
 * (BOT_MEMORY_MB); otherwise none, and no limit applies.
 */
export function memoryCheck(env: NodeJS.ProcessEnv = process.env, deps: { container?: () => MemoryUse | undefined; rss?: () => number } = {}): (() => MemoryUse | undefined) | undefined {
  const share = Number(env.BOT_MEMORY_MB);
  const container = deps.container ?? containerMemory;
  const rss = deps.rss ?? (() => process.memoryUsage.rss());
  if (container() === undefined && !(share > 0)) return undefined;
  return () => container() ?? (share > 0 ? { limit: share * 1048576, used: rss() } : undefined);
}

const MB = 1048576;

/** What one kind of process on the host holds (every process of that name added together), in MB. */
export interface ProcessMemory {
  name: string;
  count: number;
  /** Anonymous memory: the part that is really used, and that the host is stopped for running out of. */
  anonMb: number;
  /** Everything resident, shared libraries and mapped files too (always at least `anonMb`). */
  rssMb: number;
}

// How a process is told from the others by what it runs: they are mostly "node" or "python" to the system.
const KNOWN_PROCESSES: Array<[RegExp, string]> = [
  [/entrypoint\.ts/, 'supervisor'],
  [/cloud-main\.ts|matrix-main\.ts|beeper-main\.ts/, 'bot'],
  [/synapse\.app/, 'synapse'],
  [/mautrix-gmessages/, 'bridge'],
  [/litestream/, 'litestream'],
];

/**
 * What each kind of process in the container holds, largest first (read from /proc, so only on Linux; nothing elsewhere). Render's
 * graph says how much the whole host uses; this says who: a host that is stopped for memory leaves nothing behind to look at.
 */
export function processMemory(deps: { pids?: () => string[]; read?: (path: string) => string } = {}): ProcessMemory[] {
  const read = deps.read ?? ((path: string) => readFileSync(path, 'utf8'));
  const pids = deps.pids ?? (() => readdirSync('/proc').filter((name) => /^\d+$/.test(name)));
  const groups = new Map<string, ProcessMemory>();
  try {
    for (const pid of pids()) {
      try {
        const status = read(`/proc/${pid}/status`);
        const kb = (field: string): number => Number(new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(status)?.[1]);
        const rss = kb('VmRSS');
        if (!Number.isFinite(rss)) continue; // a kernel thread, or one that has just ended
        const anon = Number.isFinite(kb('RssAnon')) ? kb('RssAnon') : rss;
        const command = read(`/proc/${pid}/cmdline`).replace(/\0/g, ' ');
        const comm = /^Name:\s+(\S+)/m.exec(status)?.[1];
        // (tini, which starts the supervisor, shows the supervisor's own command line.)
        const name = comm === 'tini' ? 'tini' : (KNOWN_PROCESSES.find(([pattern]) => pattern.test(command))?.[1] ?? comm ?? pid);
        const group = groups.get(name) ?? { name, count: 0, anonMb: 0, rssMb: 0 };
        group.count += 1;
        group.anonMb += anon / 1024;
        group.rssMb += rss / 1024;
        groups.set(name, group);
      } catch {
        // it ended between the listing and the reading
      }
    }
  } catch {
    return [];
  }
  return [...groups.values()].map((g) => ({ ...g, anonMb: Math.round(g.anonMb), rssMb: Math.round(g.rssMb) })).sort((a, b) => b.anonMb - a.anonMb);
}

export interface MemoryReport {
  limitMb: number;
  usedMb: number;
  percent: number;
  /** Everything the container's memory accounts for right now, the file cache included (what Render's graph shows). */
  currentMb: number | undefined;
  processes: ProcessMemory[];
  /** The most it has used since this started, and who held it then. */
  peak: { usedMb: number; percent: number; at: string; processes: ProcessMemory[] } | undefined;
  /** Past this, a line naming who holds the memory goes in the log. */
  warnAtPercent: number;
}

const readCurrent = (): number | undefined => {
  try {
    const current = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
    return Number.isFinite(current) ? current : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Looks at the container's memory every few seconds, says in the log who holds it while more than `warnAtPercent` is in use (and
 * when it is back down), and remembers the highest it reached since the start, for /status. A host that runs out of memory is
 * stopped with nothing left to read, and an hour later all that is known is that it was; this keeps the evidence.
 */
export class MemoryWatch {
  #read: () => MemoryUse | undefined;
  #processes: () => ProcessMemory[];
  #current: () => number | undefined;
  #log: (line: string) => void;
  #now: () => Date;
  #warnAt: number;
  #everyMs: number;
  #repeatMs: number;
  #timer: NodeJS.Timeout | undefined;
  #lastWarnAt = 0;
  #warned = false;
  #peak: MemoryReport['peak'];
  #reportEveryMs: number;
  #nextReportAt: number;

  constructor(options: {
    log: (line: string) => void;
    read?: () => MemoryUse | undefined;
    processes?: () => ProcessMemory[];
    current?: () => number | undefined;
    now?: () => Date;
    /** Percent of the limit past which it speaks (default 85). */
    warnAtPercent?: number;
    /** How often it looks (default 5 s). */
    everyMs?: number;
    /** How often it repeats itself while memory stays high (default 15 s). */
    repeatMs?: number;
    /** When the first routine line is written after the start (default 90 s, when everything is up), and how often after that (default 6 hours). */
    firstReportMs?: number;
    reportEveryMs?: number;
  }) {
    this.#log = options.log;
    this.#read = options.read ?? containerMemory;
    this.#processes = options.processes ?? processMemory;
    this.#current = options.current ?? readCurrent;
    this.#now = options.now ?? (() => new Date());
    this.#warnAt = options.warnAtPercent ?? 85;
    this.#everyMs = options.everyMs ?? 5000;
    this.#repeatMs = options.repeatMs ?? 15_000;
    this.#reportEveryMs = options.reportEveryMs ?? 6 * 3_600_000;
    this.#nextReportAt = this.#now().getTime() + (options.firstReportMs ?? 90_000);
  }

  /** Begins looking (nothing happens where there is no container limit to look at). */
  start(): void {
    if (this.#timer || !this.#read()) return;
    this.#timer = setInterval(() => this.check(), this.#everyMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** One look. */
  check(): void {
    const use = this.#read();
    if (!use) return;
    const percent = (use.used / use.limit) * 100;
    const high = percent >= this.#warnAt;
    const newPeak = !this.#peak || use.used > this.#peak.usedMb * MB;
    // Who holds it is read only when it matters: at a new high, or while it is high.
    const processes = high || newPeak ? this.#processes() : [];
    const at = this.#now();
    if (newPeak) this.#peak = { usedMb: Math.round(use.used / MB), percent: Math.round(percent), at: at.toISOString(), processes };
    const line = (label: string, who: ProcessMemory[]): string =>
      `${label}: ${Math.round(use.used / MB)} of ${Math.round(use.limit / MB)} MB in use (${Math.round(percent)}%)${who.length ? ` - ${who.slice(0, 6).map((p) => `${p.name} ${p.anonMb} MB`).join(', ')}` : ''} (anonymous memory)`;
    if (high && at.getTime() - this.#lastWarnAt >= this.#repeatMs) {
      this.#lastWarnAt = at.getTime();
      this.#warned = true;
      this.#log(line('memory', processes));
    } else if (at.getTime() >= this.#nextReportAt) {
      // A routine line, with the host at rest: it shows who holds what, and over days how that creeps.
      this.#nextReportAt = at.getTime() + this.#reportEveryMs;
      this.#log(line('memory (routine check)', processes.length ? processes : this.#processes()));
    } else if (!high && this.#warned && percent < this.#warnAt - 5) {
      this.#warned = false;
      this.#log(`memory: back down to ${Math.round(use.used / MB)} of ${Math.round(use.limit / MB)} MB (${Math.round(percent)}%)`);
    }
  }

  /** For /status. Nothing where there is no container limit. */
  report(): MemoryReport | undefined {
    const use = this.#read();
    if (!use) return undefined;
    const current = this.#current();
    return {
      limitMb: Math.round(use.limit / MB),
      usedMb: Math.round(use.used / MB),
      percent: Math.round((use.used / use.limit) * 100),
      currentMb: current === undefined ? undefined : Math.round(current / MB),
      processes: this.#processes(),
      peak: this.#peak,
      warnAtPercent: this.#warnAt,
    };
  }
}
