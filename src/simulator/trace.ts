import { EventEmitter } from 'node:events';
import type { SiteEvent } from '../sources/music-table.ts';

export type Tone = 'site' | 'cached' | 'catalog' | 'note' | 'reply' | 'warn';

export interface TraceItem {
  /** Milliseconds after the request was picked up. */
  at: number;
  label: string;
  detail: string;
  /** How long the step took, when it took any time worth showing. */
  ms?: number;
  tone: Tone;
}

export interface TraceRun {
  id: number;
  text: string;
  /** The message was a number picking one of the options the bot listed, not a new search. */
  choice: boolean;
  startedAt: number;
  items: TraceItem[];
  /** Milliseconds from pick-up until the first reply was sent, and until everything was done. */
  firstReplyMs?: number;
  totalMs?: number;
}

const KEEP_RUNS = 40;

const SITE_LABELS: Record<SiteEvent['kind'], string> = {
  token: 'visitor session',
  search: 'site search',
  post: 'read post',
  link: 'download link',
  list: 'newest posts',
  feed: 'site feed',
};

/** Records what happens while the bot works on each request, so the simulator can show it and the time each step took. */
export class Trace {
  readonly runs: TraceRun[] = [];
  /** Events: 'begin' (a TraceRun), 'item' ({ run, item }) and 'end' (a TraceRun). */
  readonly events = new EventEmitter();
  #now: () => number;
  #active: TraceRun | undefined;
  #counter = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  get active(): TraceRun | undefined {
    return this.#active;
  }

  begin(text: string, choice = false): TraceRun {
    if (this.#active) this.end();
    this.#counter += 1;
    const run: TraceRun = { id: this.#counter, text, choice, startedAt: this.#now(), items: [] };
    this.#active = run;
    this.runs.push(run);
    if (this.runs.length > KEEP_RUNS) this.runs.shift();
    this.events.emit('begin', run);
    return run;
  }

  add(item: Omit<TraceItem, 'at'>): void {
    const run = this.#active;
    if (!run) return;
    const full: TraceItem = { at: this.#now() - run.startedAt, ...item };
    run.items.push(full);
    if (full.tone === 'reply' && run.firstReplyMs === undefined) run.firstReplyMs = full.at;
    this.events.emit('item', { run, item: full });
  }

  end(): void {
    const run = this.#active;
    if (!run) return;
    run.totalMs = this.#now() - run.startedAt;
    this.#active = undefined;
    this.events.emit('end', run);
  }

  clear(): void {
    this.#active = undefined;
    this.runs.length = 0;
  }

  /** A request or answer from music-table.com, as reported by the client. */
  site(event: SiteEvent): void {
    const detail = [event.kind === 'search' ? `“${event.detail}”` : event.detail, event.note].filter(Boolean).join(' · ');
    this.add({
      label: SITE_LABELS[event.kind],
      detail: event.cached ? `${detail} · remembered, no request` : detail,
      ...(event.cached ? {} : { ms: event.ms }),
      tone: event.cached ? 'cached' : 'site',
    });
  }
}
