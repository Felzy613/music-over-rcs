import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// The owner's own user name and password for the web pages, kept in the catalog's state table (so it is in the database, backed up
// like the rest, and not in Render's environment), and the browser sessions that signing in with it opens. The password is never
// kept: only a salted scrypt hash of it, with the cost it was made at. A session is a random token in a cookie of which only the
// SHA-256 is kept, so reading the database does not give anyone a session. Both are written only when the owner signs in, signs out,
// or changes the account: a handful of tiny writes, never from the bot's own work.

const ACCOUNT_KEY = 'admin.account';
const SESSIONS_KEY = 'admin.sessions';

/** scrypt at 16 MiB: about 50 ms on a full CPU, and a second or so on the host's tenth of one, for a sign-in that happens once a fortnight. */
const COST = { N: 16_384, r: 8, p: 1, keyLength: 32, maxmem: 64 * 1024 * 1024 } as const;

export const MIN_PASSWORD_CHARS = 12;
export const MAX_PASSWORD_CHARS = 200;
export const MIN_USER_CHARS = 3;
export const MAX_USER_CHARS = 64;
const SESSION_MS = 14 * 24 * 60 * 60_000;
const MAX_SESSIONS = 10;

interface StateStore {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

interface AccountRecord {
  user: string;
  /** base64 */
  salt: string;
  /** base64 of the scrypt hash */
  hash: string;
  cost: { N: number; r: number; p: number };
  changedAt: number;
}

const derive = (password: string, salt: Buffer, cost: { N: number; r: number; p: number }): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(password.normalize('NFKC'), salt, COST.keyLength, { N: cost.N, r: cost.r, p: cost.p, maxmem: COST.maxmem }, (err, key) => (err ? reject(err) : resolve(key))));

const same = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

/** The owner's user name and password. */
export class AdminAccount {
  #state: StateStore | undefined;
  #now: () => number;
  #record: AccountRecord | undefined;
  /** One hash at a time: each takes 16 MiB, and the host has little to spare. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: { state?: StateStore | undefined; now?: () => number } = {}) {
    this.#state = options.state;
    this.#now = options.now ?? Date.now;
    try {
      const saved: unknown = JSON.parse(this.#state?.getState(ACCOUNT_KEY) ?? 'null');
      const record = saved as Partial<AccountRecord> | null;
      if (record && typeof record.user === 'string' && typeof record.salt === 'string' && typeof record.hash === 'string' && record.cost && typeof record.cost.N === 'number' && typeof record.cost.r === 'number' && typeof record.cost.p === 'number') {
        this.#record = { user: record.user, salt: record.salt, hash: record.hash, cost: record.cost, changedAt: typeof record.changedAt === 'number' ? record.changedAt : 0 };
      }
    } catch {
      // damaged: there is no account, and ADMIN_TOKEN signs in
    }
  }

  /** Whether the owner has set a user name and password. */
  get isSet(): boolean {
    return this.#record !== undefined;
  }

  get user(): string | undefined {
    return this.#record?.user;
  }

  get changedAt(): number | undefined {
    return this.#record?.changedAt;
  }

  /** What is wrong with a user name and password the owner chose, in words; undefined when they will do. */
  static problem(user: string, password: string, token?: string): string | undefined {
    const name = user.trim();
    if (name.length < MIN_USER_CHARS || name.length > MAX_USER_CHARS) return `The user name must be ${MIN_USER_CHARS} to ${MAX_USER_CHARS} characters.`;
    if (/[\u0000-\u001f\u007f]/.test(name)) return 'The user name can not have control characters in it.';
    if (password.length < MIN_PASSWORD_CHARS) return `The password must be at least ${MIN_PASSWORD_CHARS} characters. A few words in a row make a good one.`;
    if (password.length > MAX_PASSWORD_CHARS) return `The password can be at most ${MAX_PASSWORD_CHARS} characters.`;
    if (password.toLowerCase() === name.toLowerCase()) return 'The password can not be the same as the user name.';
    if (token !== undefined && password === token) return "The password can not be the host's ADMIN_TOKEN: that one lives in Render.";
    return undefined;
  }

  /** Whether this user name and password are the owner's. Does the same work whichever of the two is wrong. */
  verify(user: string, password: string): Promise<boolean> {
    const record = this.#record;
    if (!record || password.length > MAX_PASSWORD_CHARS || user.length > 200) return Promise.resolve(false);
    return this.#serialized(async () => {
      const hash = await derive(password, Buffer.from(record.salt, 'base64'), record.cost);
      const userMatches = same(createHash('sha256').update(user.trim()).digest(), createHash('sha256').update(record.user).digest());
      return same(hash, Buffer.from(record.hash, 'base64')) && userMatches;
    });
  }

  /** Whether `password` is the owner's password (whoever they are signed in as). */
  verifyPassword(password: string): Promise<boolean> {
    const record = this.#record;
    if (!record || password.length > MAX_PASSWORD_CHARS) return Promise.resolve(false);
    return this.#serialized(async () => same(await derive(password, Buffer.from(record.salt, 'base64'), record.cost), Buffer.from(record.hash, 'base64')));
  }

  /** Sets the user name and password (the caller has checked `problem`). Only the hash is kept. */
  async set(user: string, password: string): Promise<void> {
    const salt = randomBytes(16);
    const hash = await this.#serialized(() => derive(password, salt, COST));
    this.#record = { user: user.trim(), salt: salt.toString('base64'), hash: hash.toString('base64'), cost: { N: COST.N, r: COST.r, p: COST.p }, changedAt: this.#now() };
    this.#state?.setState(ACCOUNT_KEY, JSON.stringify(this.#record));
  }

  /** Removes the account: only ADMIN_TOKEN signs in. Returns whether there was one. */
  clear(): boolean {
    if (!this.#record) return false;
    this.#record = undefined;
    this.#state?.setState(ACCOUNT_KEY, 'null');
    return true;
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work);
    this.#queue = run.catch(() => {});
    return run;
  }
}

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * What ties a session to the ADMIN_TOKEN the host had when it was opened: a keyed hash of a fixed word (not the token, and not
 * reversible to it without guessing it). Changing the token in Render (after a leak, say) changes this, so every session opened
 * under the old one ends at the next start instead of lasting its two weeks.
 */
export function sessionBinding(token: string | undefined): string {
  return createHmac('sha256', token ?? '').update('mors-session-binding').digest('hex').slice(0, 16);
}

/** A signed-in browser, as the console lists it. */
export interface SessionInfo {
  /** Unix ms it was opened. */
  at: number;
  expiresAt: number;
  /** Whether it is the browser asking. */
  current: boolean;
}

/** The browsers that are signed in: server-side, so one can be ended, and kept across restarts. */
export class Sessions {
  #state: StateStore | undefined;
  #now: () => number;
  #ttl: number;
  #max: number;
  /** SHA-256 of the token → when it was opened and when it ends. */
  #open = new Map<string, { at: number; exp: number }>();
  #binding: string;

  constructor(options: { state?: StateStore | undefined; now?: () => number; ttlMs?: number; max?: number; binding?: string } = {}) {
    this.#binding = options.binding ?? '';
    this.#state = options.state;
    this.#now = options.now ?? Date.now;
    this.#ttl = options.ttlMs ?? SESSION_MS;
    this.#max = options.max ?? MAX_SESSIONS;
    try {
      const saved: unknown = JSON.parse(this.#state?.getState(SESSIONS_KEY) ?? '[]');
      if (Array.isArray(saved)) {
        for (const entry of saved) {
          // Only a session opened under the token the host has now is still good.
          if (entry && typeof entry.h === 'string' && typeof entry.at === 'number' && typeof entry.exp === 'number' && entry.exp > this.#now() && (typeof entry.b === 'string' ? entry.b : '') === this.#binding) this.#open.set(entry.h, { at: entry.at, exp: entry.exp });
        }
      }
    } catch {
      // damaged: everyone signs in again
    }
  }

  /** Opens a session. Only the token's hash is kept; the token goes to the browser once. */
  create(): { token: string; maxAgeSeconds: number } {
    const token = randomBytes(32).toString('base64url');
    const now = this.#now();
    this.#prune(now);
    this.#open.set(hashOf(token), { at: now, exp: now + this.#ttl });
    // The oldest go first when there are too many.
    while (this.#open.size > this.#max) this.#open.delete([...this.#open.entries()].sort((a, b) => a[1].at - b[1].at)[0]![0]);
    this.#persist();
    return { token, maxAgeSeconds: Math.floor(this.#ttl / 1000) };
  }

  valid(token: string | undefined): boolean {
    if (!token) return false;
    const found = this.#open.get(hashOf(token));
    return found !== undefined && found.exp > this.#now();
  }

  /** Ends one session. */
  revoke(token: string | undefined): void {
    if (token && this.#open.delete(hashOf(token))) this.#persist();
  }

  /** Ends every session: the browsers are all signed out. */
  revokeAll(): number {
    const count = this.#open.size;
    this.#open.clear();
    if (count > 0) this.#persist();
    return count;
  }

  list(currentToken?: string): SessionInfo[] {
    const now = this.#now();
    const mine = currentToken ? hashOf(currentToken) : undefined;
    return [...this.#open.entries()].filter(([, one]) => one.exp > now).sort((a, b) => b[1].at - a[1].at).map(([key, one]) => ({ at: one.at, expiresAt: one.exp, current: key === mine }));
  }

  #prune(now: number): void {
    for (const [key, one] of this.#open) if (one.exp <= now) this.#open.delete(key);
  }

  #persist(): void {
    try {
      this.#state?.setState(SESSIONS_KEY, JSON.stringify([...this.#open].map(([h, one]) => ({ h, b: this.#binding, at: one.at, exp: one.exp }))));
    } catch {
      // they stay signed in until the next restart
    }
  }
}
