// Where the time of one request goes, as one line in the host's log: from the phone to the bot, the bot's own work (and
// what it waited on), each message it sent, and when Google Messages had them. The owner asked for measurements, not
// guesses (2026-10-20), and Render's log search finds these by their first word (`timeline:`, `song:`, `album:`).

/** "0.21s" under a second, "7.6s" above. */
export const seconds = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(ms < 1000 ? 2 : 1)}s`;

/** A step of the bot's own work and how long it took, as the bot reports it (`Bot.handle`'s trace). */
export type Trace = (step: string, ms: number) => void;

export interface TimelineOptions {
  /** When the request left the phone (Unix ms): Google's time for it, which the bridge passes on. */
  phoneAt?: number | undefined;
  now?: () => number;
}

/** One request's timeline. Times are from when the bot read the request (`seenAt`). */
export class Timeline {
  readonly label: string;
  readonly seenAt: number;
  readonly phoneAt: number | undefined;
  #now: () => number;
  #spans = new Map<string, { ms: number; count: number }>();
  #marks = new Map<string, number>();
  #sends: Array<{ at: number; ms: number }> = [];
  /** The messages sent for it, and when each reached Google (once that is known). */
  #reached = new Map<string, number | undefined>();
  #done = false;

  constructor(label: string, options: TimelineOptions = {}) {
    this.label = label;
    this.#now = options.now ?? Date.now;
    this.seenAt = this.#now();
    this.phoneAt = options.phoneAt !== undefined && Number.isFinite(options.phoneAt) ? options.phoneAt : undefined;
  }

  /** A step that took `ms`; the same step again adds to it ("zemer 0.42s ×2"). */
  span(step: string, ms: number): void {
    const had = this.#spans.get(step);
    this.#spans.set(step, { ms: (had?.ms ?? 0) + ms, count: (had?.count ?? 0) + 1 });
  }

  /** Something happened now ("bot": the answer is ready). Only the first time counts. */
  mark(step: string): void {
    if (!this.#marks.has(step)) this.#marks.set(step, this.#now() - this.seenAt);
  }

  /** A message went out, its send having taken `ms`; `id` is its id in the chat, for matching Google's word on it. */
  sent(ms: number, id?: string | void): void {
    this.#sends.push({ at: this.#now() - this.seenAt, ms });
    if (id) this.#reached.set(id, undefined);
  }

  /** Whether `id` is one of this request's messages. */
  has(id: string): boolean {
    return this.#reached.has(id);
  }

  /** Google had message `id` at `at` (Unix ms). */
  reached(id: string, at: number): void {
    if (this.#reached.has(id)) this.#reached.set(id, at);
  }

  /** How many of its messages Google hasn't been heard about yet. */
  get waiting(): number {
    return [...this.#reached.values()].filter((at) => at === undefined).length;
  }

  /** Everything it sends has been sent. */
  finish(): void {
    this.#done = true;
  }

  get finished(): boolean {
    return this.#done;
  }

  /**
   * The line for the log: `timeline: "search achas" phone→seen 7.6s · bot 1.0s (zemer 0.21s) · 12 msgs first +1.0s last
   * +4.3s (0.30s each) · at Google +5.1s`. "at Google" is there only when Google's word on the messages was asked for.
   */
  line(withGoogle = false): string {
    const parts: string[] = [];
    const head = `timeline: ${JSON.stringify(this.label)}`;
    parts.push(this.phoneAt !== undefined ? `${head} phone→seen ${seconds(this.seenAt - this.phoneAt)}` : head);
    const spans = [...this.#spans].map(([step, { ms, count }]) => `${step} ${seconds(ms)}${count > 1 ? ` ×${count}` : ''}`);
    const bot = this.#marks.get('bot');
    if (bot !== undefined) parts.push(`bot ${seconds(bot)}${spans.length > 0 ? ` (${spans.join(', ')})` : ''}`);
    else if (spans.length > 0) parts.push(spans.join(', '));
    for (const [step, at] of this.#marks) if (step !== 'bot') parts.push(`${step} +${seconds(at)}`);
    if (this.#sends.length > 0) {
      const n = this.#sends.length;
      const each = this.#sends.reduce((sum, send) => sum + send.ms, 0) / n;
      parts.push(`${n} msg${n === 1 ? '' : 's'} first +${seconds(this.#sends[0]!.at)} last +${seconds(this.#sends.at(-1)!.at)} (${seconds(each)} each)`);
    }
    if (withGoogle && this.#reached.size > 0) {
      const times = [...this.#reached.values()].filter((at): at is number => at !== undefined);
      const latest = times.length > 0 ? Math.max(...times) : undefined;
      const all = times.length === this.#reached.size;
      parts.push(
        latest === undefined
          ? `at Google: no word on ${this.#reached.size}`
          : `at Google +${seconds(latest - this.seenAt)}${all ? '' : ` (${times.length} of ${this.#reached.size})`}`,
      );
    }
    return parts.join(' · ');
  }
}

/** The last few timeline lines, for /status, so a check doesn't need a log search. */
export class RecentLines {
  #lines: string[] = [];
  readonly size: number;

  constructor(size = 20) {
    this.size = size;
  }

  add(line: string): void {
    this.#lines.push(`${new Date().toISOString()} ${line}`);
    if (this.#lines.length > this.size) this.#lines.splice(0, this.#lines.length - this.size);
  }

  list(): string[] {
    return [...this.#lines];
  }
}

/** This process's recent timeline lines (the cloud host's /status shows them). */
export const recentTimelines = new RecentLines(20);

/** Times one piece of work for `trace` (when there is one): `await timed(trace, 'zemer', finder.find(q))`. */
export async function timed<T>(trace: Trace | undefined, step: string, work: Promise<T>): Promise<T> {
  if (!trace) return work;
  const start = performance.now();
  try {
    return await work;
  } finally {
    trace(step, performance.now() - start);
  }
}
