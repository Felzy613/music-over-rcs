// What the owner changed from the admin console, newest last: what, when, from what to what. Kept in the catalog's state table
// (so it survives a restart, and Litestream backs it up) and bounded, so it stays small: it is written only when the owner
// changes something, never by the bot's own work.

export interface AuditEntry {
  /** Unix ms. */
  at: number;
  /** A short name for the change: "allow artist", "setting DIGEST_TIME". */
  what: string;
  /** Who or what it was about (an artist's name and channel id, a song's title). */
  detail?: string;
  from?: string;
  to?: string;
}

interface StateStore {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

const KEY = 'admin.audit';
const MAX_ENTRIES = 200;
const MAX_FIELD_CHARS = 240;

const clip = (text: string | undefined): string | undefined => {
  const clean = text?.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return clean ? clean.slice(0, MAX_FIELD_CHARS) : undefined;
};

export class AuditLog {
  #state: StateStore | undefined;
  #now: () => number;
  #entries: AuditEntry[] = [];

  constructor(options: { state?: StateStore | undefined; now?: () => number } = {}) {
    this.#state = options.state;
    this.#now = options.now ?? Date.now;
    try {
      const saved: unknown = JSON.parse(this.#state?.getState(KEY) ?? '[]');
      if (Array.isArray(saved)) {
        this.#entries = saved.flatMap((entry): AuditEntry[] =>
          entry && typeof entry === 'object' && typeof entry.at === 'number' && typeof entry.what === 'string'
            ? [{ at: entry.at, what: entry.what, ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}), ...(typeof entry.from === 'string' ? { from: entry.from } : {}), ...(typeof entry.to === 'string' ? { to: entry.to } : {}) }]
            : [],
        );
      }
    } catch {
      // a damaged log starts again empty
    }
  }

  add(entry: Omit<AuditEntry, 'at'>): void {
    const detail = clip(entry.detail);
    const from = clip(entry.from);
    const to = clip(entry.to);
    this.#entries.push({ at: this.#now(), what: clip(entry.what) ?? 'change', ...(detail ? { detail } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
    if (this.#entries.length > MAX_ENTRIES) this.#entries.splice(0, this.#entries.length - MAX_ENTRIES);
    try {
      this.#state?.setState(KEY, JSON.stringify(this.#entries));
    } catch {
      // the change itself has been made; only its record is lost
    }
  }

  /** Newest first. */
  list(limit = MAX_ENTRIES): AuditEntry[] {
    return this.#entries.slice(-Math.max(1, limit)).reverse();
  }
}
