// What the owner can start from the admin console, each at most once at a time and not again until a cooldown has passed, with
// its result kept so the console can show it. The result of the last run of each action lives in memory only: nothing is
// written to a database for it.

/** A problem with the request itself, fit to show to the owner. */
export class AdminError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
  }
}

/** How an action went. */
export interface ActionResult {
  ok: boolean;
  /** One sentence. */
  summary: string;
  /** More lines, when there is more to say (a preview of the daily message). */
  lines?: string[] | undefined;
  startedAt: number;
  finishedAt: number;
}

/** What an action's work returns. */
export interface ActionOutcome {
  ok: boolean;
  summary: string;
  lines?: string[] | undefined;
}

export interface ActionState {
  running: boolean;
  last: ActionResult | null;
  /** When it may be started again (Unix ms), if that is in the future. */
  readyAt: number | null;
}

export class ActionGuard {
  #now: () => number;
  #running = new Set<string>();
  #last = new Map<string, ActionResult>();
  #readyAt = new Map<string, number>();

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  /**
   * Runs `work` as action `name`. Refused with 409 while the same action is running and 429 until `cooldownMs` has passed since it
   * last started. Never rejects for a failure of the work itself: that is a result with `ok: false`.
   */
  async run(name: string, cooldownMs: number, work: () => Promise<ActionOutcome>): Promise<ActionResult> {
    if (this.#running.has(name)) throw new AdminError(409, 'That is running already; its result will show here when it is done.');
    const startedAt = this.#now();
    const readyAt = this.#readyAt.get(name);
    if (readyAt !== undefined && startedAt < readyAt) {
      const seconds = Math.ceil((readyAt - startedAt) / 1000);
      throw new AdminError(429, `That ran a moment ago; wait ${seconds >= 120 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} second${seconds === 1 ? '' : 's'}`} before running it again.`);
    }
    this.#running.add(name);
    this.#readyAt.set(name, startedAt + cooldownMs);
    let outcome: ActionOutcome;
    try {
      outcome = await work();
    } catch (err) {
      outcome = { ok: false, summary: err instanceof Error ? err.message : String(err) };
    } finally {
      this.#running.delete(name);
    }
    const result: ActionResult = { ok: outcome.ok, summary: outcome.summary, ...(outcome.lines ? { lines: outcome.lines } : {}), startedAt, finishedAt: this.#now() };
    this.#last.set(name, result);
    return result;
  }

  snapshot(names: readonly string[]): Record<string, ActionState> {
    const now = this.#now();
    return Object.fromEntries(
      names.map((name) => {
        const readyAt = this.#readyAt.get(name);
        return [name, { running: this.#running.has(name), last: this.#last.get(name) ?? null, readyAt: readyAt !== undefined && readyAt > now ? readyAt : null } satisfies ActionState];
      }),
    );
  }
}
