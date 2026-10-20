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
  /** The lowest it was in the last quarter of an hour (once the start is over): what "well above its resting level" is measured from. */
  restMb: number | undefined;
  /** Set while it has been well above its resting level for a while (and the log has said so): when that began. */
  raisedSince: string | undefined;
  /** Who held what the last time it was resting (refreshed about once a minute while it stays near its lowest): what a rise is measured against, process by process. */
  restProcesses: ProcessMemory[];
}

/**
 * Who holds what, with how much more each holds than at rest: "synapse 143 MB (+51), bot 89 MB (+42)", the largest growth first, a
 * process that was not there at rest marked "new". Without a resting breakdown to compare with, just what each holds.
 */
function holdersLine(now: ProcessMemory[], rest: ProcessMemory[]): string {
  if (now.length === 0) return '';
  if (rest.length === 0) return ` - ${now.slice(0, 6).map((p) => `${p.name} ${p.anonMb} MB`).join(', ')}`;
  const before = new Map(rest.map((p) => [p.name, p.anonMb]));
  const rows = now
    .map((p) => ({ p, isNew: !before.has(p.name), growth: p.anonMb - (before.get(p.name) ?? 0) }))
    .sort((a, b) => b.growth - a.growth || b.p.anonMb - a.p.anonMb);
  return ` - ${rows.slice(0, 6).map(({ p, isNew, growth }) => `${p.name} ${p.anonMb} MB (${isNew ? 'new' : growth >= 0 ? `+${growth}` : growth})`).join(', ')}`;
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
 *
 * It also notices memory that goes up and stays up well short of the warning line, which is how a big song leaves it (on
 * 2026-10-19 a 27 MB song took the container from 257 to 370 MB and it stayed there for minutes): once it has been `riseMb` or more
 * above its resting level (the lowest of the last 15 minutes) for `holdMs`, one line names who holds it, and another says when it
 * has settled, each with how much more every process holds than when memory last rested. Nothing is said in the first 90 s after a
 * start, when everything is still settling in.
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
  #startedAt: number;
  #warmUpMs: number;
  #riseMb: number;
  #holdMs: number;
  #settleMb: number;
  #restWindowMs: number;
  #episodeMaxMs: number;
  /** What it used at each look since the start settled, for the last quarter of an hour. */
  #samples: Array<{ at: number; used: number }> = [];
  /** A rise being watched: from when, from what level (and who held what then), and whether the log has said so. */
  #rising: { since: number; restMb: number; restProcesses: ProcessMemory[]; announced: boolean } | undefined;
  /** Who held what at the last look while it was resting, and when that was taken. */
  #restProcesses: ProcessMemory[] = [];
  #restSnapshotAt = 0;

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
    /** The start is left alone this long before a rise is looked for (default 90 s, by when everything is up and the routine line is written). */
    warmUpMs?: number;
    /** How far above its resting level counts as a rise, in MB (default 60); how long it must last (default 45 s); how near the resting level counts as settled again (default 30 MB). */
    riseMb?: number;
    holdMs?: number;
    settleMb?: number;
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
    this.#startedAt = this.#now().getTime();
    this.#warmUpMs = options.warmUpMs ?? 90_000;
    this.#riseMb = options.riseMb ?? 60;
    this.#holdMs = options.holdMs ?? 45_000;
    this.#settleMb = options.settleMb ?? 30;
    this.#restWindowMs = 15 * 60_000;
    this.#episodeMaxMs = 30 * 60_000;
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
    this.#watchRise(use, percent, at);
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

  /** Notices memory that has gone well above its resting level and stays there, and says who holds it; and when it has come back. */
  #watchRise(use: MemoryUse, percent: number, at: Date): void {
    const now = at.getTime();
    if (now - this.#startedAt < this.#warmUpMs) return;
    const usedMb = use.used / MB;
    const total = `${Math.round(usedMb)} of ${Math.round(use.limit / MB)} MB`;
    const rising = this.#rising;
    if (!rising) {
      this.#samples = this.#samples.filter((sample) => now - sample.at <= this.#restWindowMs);
      const floor = this.#samples.length > 0 ? Math.min(...this.#samples.map((sample) => sample.used)) / MB : undefined;
      this.#samples.push({ at: now, used: use.used });
      // Who holds what while it rests, looked at about once a minute while it stays near its lowest: a rise is told process by process against this.
      if ((floor === undefined || usedMb <= floor + 15) && now - this.#restSnapshotAt >= 60_000) {
        this.#restSnapshotAt = now;
        const holders = this.#processes();
        if (holders.length > 0) this.#restProcesses = holders;
      }
      if (floor !== undefined && usedMb - floor >= this.#riseMb) this.#rising = { since: now, restMb: floor, restProcesses: this.#restProcesses, announced: false };
      return;
    }
    if (!rising.announced) {
      if (usedMb - rising.restMb < this.#riseMb) this.#rising = undefined; // a blip, not a rise
      else if (now - rising.since >= this.#holdMs) {
        rising.announced = true;
        this.#log(`memory (raised): ${total} in use (${Math.round(percent)}%), ${Math.round(usedMb - rising.restMb)} MB above its resting ${Math.round(rising.restMb)} MB for ${Math.round((now - rising.since) / 1000)} s${holdersLine(this.#processes(), rising.restProcesses)} (anonymous memory)`);
      }
      return;
    }
    if (usedMb <= rising.restMb + this.#settleMb) {
      this.#rising = undefined;
      this.#log(`memory (settled): ${total} in use (${Math.round(percent)}%), back to its resting ${Math.round(rising.restMb)} MB level ${Math.round((now - rising.since) / 1000)} s after it rose${holdersLine(this.#processes(), rising.restProcesses)} (anonymous memory)`);
    } else if (now - rising.since > this.#episodeMaxMs) {
      // It has not come back in half an hour: this is the level it rests at now.
      this.#rising = undefined;
      this.#samples = [];
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
      restMb: this.#samples.length > 0 ? Math.round(Math.min(...this.#samples.map((sample) => sample.used)) / MB) : undefined,
      raisedSince: this.#rising?.announced ? new Date(this.#rising.since).toISOString() : undefined,
      restProcesses: this.#rising ? this.#rising.restProcesses : this.#restProcesses,
    };
  }
}
