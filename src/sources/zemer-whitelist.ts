import { SourceError } from '../bot.ts';

// The artist whitelist the Zemer app filters YouTube Music with (github.com/ZemerTeam/zemer-app, docs/whitelist): a
// curated list of artist channels, each flagged female or not, plus a list of single songs to hide even when their
// artist is on it. Zemer reads both from its public content mirror, content.zemer.io, without signing in, and so does
// this: `/whitelist/version` says whether the list changed, `/whitelist` is the list, `/blockedContentIds` the songs.
//
// This bot always filters the way Zemer does with female singers turned off (Zemer's default): a song is let through
// only when one of its artists is on the list and none of its artists is flagged female, and never when its id is on
// the blocked list. With no list to filter by there is no answer rather than an unfiltered one, as in Zemer.

export const ZEMER_CONTENT_URL = 'https://content.zemer.io';

const STATE_KEY = 'zemer.whitelist';
const WHITELIST_TIMEOUT_MS = 20_000;
const SMALL_TIMEOUT_MS = 8_000;
/** The list changes through the day as music comes out, so it is never trusted for longer than this without asking. */
const CHECK_EVERY_MS = 5 * 60_000;
/** A search waits at most this long for that question to be answered, then goes on with the list it has. */
const PATIENCE_MS = 2_000;
/** After a failed check, the next is not tried for this long. */
const RETRY_AFTER_MS = 60_000;
const WATCH_EVERY_MS = 10 * 60_000;

/** A problem whose message is fit to show to the user. */
export class ZemerWhitelistError extends SourceError {
  constructor(message: string) {
    super(message);
    this.name = 'ZemerWhitelistError';
  }
}

export interface WhitelistedArtist {
  name: string;
  female: boolean;
}

/** Why a song was let through or held back, in plain words. */
export type Verdict = { ok: true } | { ok: false; why: 'blocked' | 'female' | 'not on the list' };

/** What is kept between runs: the list, and the version it was fetched at. */
interface Saved {
  gate: number;
  checkedAt: number;
  /** [channel id, name, 1 if flagged female] */
  artists: Array<[string, string, 0 | 1]>;
  blocked: string[];
}

export interface ZemerWhitelistOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Where the list is kept between runs (the catalog's state table). Without one it is kept in memory only. */
  state?: { getState(key: string): string | undefined; setState(key: string, value: string): void } | undefined;
  /** How old the list may be before a search asks whether it changed. */
  checkEveryMs?: number;
  /** How long a search waits for that answer. */
  patienceMs?: number;
  retryAfterMs?: number;
  now?: () => number;
}

const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export class ZemerWhitelist {
  readonly baseUrl: string;
  #fetch: typeof fetch;
  #state: ZemerWhitelistOptions['state'];
  #checkEvery: number;
  #patience: number;
  #retryAfter: number;
  #now: () => number;
  #artists = new Map<string, WhitelistedArtist>();
  #blocked = new Set<string>();
  #gate: number | undefined;
  #checkedAt = 0;
  #retryAt = 0;
  #flight: Promise<void> | undefined;
  #watching: NodeJS.Timeout | undefined;

  constructor(options: ZemerWhitelistOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ZEMER_CONTENT_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#state = options.state;
    this.#checkEvery = options.checkEveryMs ?? CHECK_EVERY_MS;
    this.#patience = options.patienceMs ?? PATIENCE_MS;
    this.#retryAfter = options.retryAfterMs ?? RETRY_AFTER_MS;
    this.#now = options.now ?? Date.now;
    this.#restore();
  }

  /** How many artists are on the list, and how many songs are blocked. */
  get size(): { artists: number; blocked: number } {
    return { artists: this.#artists.size, blocked: this.#blocked.size };
  }

  /** Whether there is a list to filter by (kept from an earlier run, or fetched). */
  get loaded(): boolean {
    return this.#artists.size > 0;
  }

  /** How long ago the list was last confirmed to be the server's current one; Infinity when there is no list. */
  get ageMs(): number {
    return this.loaded ? this.#now() - this.#checkedAt : Infinity;
  }

  /**
   * Makes sure the list is current before it is used. With none, it is fetched now (rejecting if that can't be done).
   * With one that was last confirmed more than `checkEveryMs` ago, the server is asked whether it changed (a request of
   * about a hundred bytes) and a new list is fetched if so; a search waits a couple of seconds for that and otherwise
   * goes on with the list it has, which is the last good one: a failed check never empties or replaces it.
   */
  async ready(): Promise<void> {
    if (!this.loaded) return this.#refresh();
    if (this.ageMs < this.#checkEvery || this.#now() < this.#retryAt) return;
    const check = this.#refresh().catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([check, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.#patience)))]);
    clearTimeout(timer);
  }

  /**
   * Keeps the list current while the bot runs, whether or not anyone searches: checks every ten minutes and reports
   * each check's outcome (an error message when it failed), so a list that has stopped updating can be flagged.
   * Returns a function that stops it.
   */
  watch(onCheck?: (error: string | undefined) => void, everyMs = WATCH_EVERY_MS): () => void {
    this.#watching ??= setInterval(() => {
      this.#refresh().then(
        () => onCheck?.(undefined),
        (err: unknown) => onCheck?.(err instanceof Error ? err.message : String(err)),
      );
    }, everyMs);
    this.#watching.unref();
    return () => {
      clearInterval(this.#watching);
      this.#watching = undefined;
    };
  }

  /** Starts getting the list so the first search doesn't wait for it. A failure is left for `ready` to report. */
  warm(): Promise<void> {
    return this.ready().catch(() => {});
  }

  /** Whether a song is let through: `ids` are the channel ids of the artists credited on it. */
  verdict(videoId: string, ids: readonly string[]): Verdict {
    if (this.#blocked.has(videoId)) return { ok: false, why: 'blocked' };
    let listed = false;
    for (const id of ids) {
      const artist = this.#artists.get(id);
      if (!artist) continue;
      // One woman among the credits is enough: the song is a female singer's, whoever else is on it.
      if (artist.female) return { ok: false, why: 'female' };
      listed = true;
    }
    return listed ? { ok: true } : { ok: false, why: 'not on the list' };
  }

  allows(videoId: string, ids: readonly string[]): boolean {
    return this.verdict(videoId, ids).ok;
  }

  #refresh(): Promise<void> {
    this.#flight ??= this.#fetchList()
      .catch((err: unknown) => {
        this.#retryAt = this.#now() + this.#retryAfter;
        throw err;
      })
      .finally(() => {
        this.#flight = undefined;
      });
    return this.#flight;
  }

  async #fetchList(): Promise<void> {
    const first = !this.loaded;
    const version = record(await this.#get('/whitelist/version', SMALL_TIMEOUT_MS));
    const gate = Number(version?.gate);
    if (!Number.isFinite(gate)) throw new ZemerWhitelistError("Zemer's list didn't say which version it is");

    let artists = this.#artists;
    if (first || gate !== this.#gate) {
      const docs = await this.#get('/whitelist', WHITELIST_TIMEOUT_MS);
      artists = new Map();
      for (const doc of Array.isArray(docs) ? docs : []) {
        const entry = record(doc);
        const id = text(entry?.artistId) ?? text(entry?.id);
        const name = text(entry?.displayName) ?? text(entry?.name) ?? text(entry?.artistName);
        if (id && name) artists.set(id, { name, female: entry?.isFemale === true });
      }
      // An empty or broken answer must never replace a good list.
      if (artists.size === 0) throw new ZemerWhitelistError("Zemer's list came back empty");
    }

    // The blocked songs are read on every check, even when the list itself hasn't changed, as Zemer does. Failing to
    // is only fatal when there is nothing to fall back on.
    let blocked = this.#blocked;
    try {
      const answer = record(await this.#get('/blockedContentIds', SMALL_TIMEOUT_MS));
      blocked = new Set([...(Array.isArray(answer?.global) ? answer.global : []), ...(Array.isArray(answer?.female) ? answer.female : [])].filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()));
    } catch (err) {
      if (first) throw err;
    }

    this.#artists = artists;
    this.#blocked = blocked;
    this.#gate = gate;
    this.#checkedAt = this.#now();
    this.#save();
  }

  async #get(path: string, timeoutMs: number): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'music-over-rcs/0.1 (personal, single-user project)' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ZemerWhitelistError("I couldn't reach Zemer's artist list (network error or timeout)");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ZemerWhitelistError(`Zemer's artist list answered HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new ZemerWhitelistError("Zemer's artist list wasn't readable");
    }
  }

  #save(): void {
    if (!this.#state || this.#gate === undefined) return;
    const saved: Saved = {
      gate: this.#gate,
      checkedAt: this.#checkedAt,
      artists: [...this.#artists].map(([id, artist]) => [id, artist.name, artist.female ? 1 : 0]),
      blocked: [...this.#blocked],
    };
    try {
      this.#state.setState(STATE_KEY, JSON.stringify(saved));
    } catch {
      // not being able to keep the list only means fetching it again next time
    }
  }

  #restore(): void {
    let saved: Partial<Saved> | undefined;
    try {
      const raw = this.#state?.getState(STATE_KEY);
      saved = raw ? (JSON.parse(raw) as Partial<Saved>) : undefined;
    } catch {
      return;
    }
    if (!saved || typeof saved.gate !== 'number' || !Array.isArray(saved.artists) || saved.artists.length === 0) return;
    for (const entry of saved.artists) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') this.#artists.set(entry[0], { name: entry[1], female: entry[2] === 1 });
    }
    this.#blocked = new Set((Array.isArray(saved.blocked) ? saved.blocked : []).filter((id): id is string => typeof id === 'string'));
    this.#gate = saved.gate;
    this.#checkedAt = typeof saved.checkedAt === 'number' ? saved.checkedAt : 0;
  }
}

/** ZEMER_CONTENT_URL points it somewhere else (tests). */
export function zemerWhitelistFromEnv(env: NodeJS.ProcessEnv = process.env, options: ZemerWhitelistOptions = {}): ZemerWhitelist {
  const baseUrl = env.ZEMER_CONTENT_URL?.trim();
  return new ZemerWhitelist(baseUrl ? { ...options, baseUrl } : options);
}
