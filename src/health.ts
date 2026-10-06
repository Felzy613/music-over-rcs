import { execFile } from 'node:child_process';

/** Shows a notification on this Mac (Notification Center). Elsewhere it does nothing. */
export type Notify = (title: string, message: string) => Promise<void>;

export const macNotify: Notify = (title, message) =>
  new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve();
    const quote = (text: string) => `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
    execFile('/usr/bin/osascript', ['-e', `display notification ${quote(message)} with title ${quote(title)}`], { timeout: 10_000 }, () => resolve());
  });

export interface Problem {
  key: string;
  message: string;
  since: string;
}

/**
 * Keeps track of what's wrong and says so on the Mac, since the bot can't text you about it when the chat is the
 * thing that's broken. A problem is announced when it starts and again every few hours while it lasts; when it
 * clears, that is announced too. What's wrong right now is also kept (`save`) for `npm run library -- status`.
 */
export class Health {
  #notify: Notify;
  #log: (line: string) => void;
  #now: () => Date;
  #repeatMs: number;
  #save: ((problems: Problem[]) => void) | undefined;
  #problems = new Map<string, Problem & { told: number }>();

  constructor(options: { notify?: Notify; log?: (line: string) => void; now?: () => Date; repeatMs?: number; save?: (problems: Problem[]) => void } = {}) {
    this.#notify = options.notify ?? macNotify;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? (() => new Date());
    this.#repeatMs = options.repeatMs ?? 6 * 60 * 60_000;
    this.#save = options.save;
  }

  /** Something is wrong. Announced now, then again only every few hours while it lasts. */
  problem(key: string, message: string): void {
    const now = this.#now().getTime();
    const known = this.#problems.get(key);
    if (known && known.message === message && now - known.told < this.#repeatMs) return;
    this.#problems.set(key, { key, message, since: known?.since ?? new Date(now).toISOString(), told: now });
    this.#log(`problem: ${message}`);
    void this.#notify('Music over RCS', message);
    this.#persist();
  }

  /** It's fine (again). If it was a problem, says it's fixed. */
  ok(key: string, fixed?: string): void {
    const known = this.#problems.get(key);
    if (!known) return;
    this.#problems.delete(key);
    const message = fixed ?? `Fixed: ${known.message}`;
    this.#log(message);
    void this.#notify('Music over RCS', message);
    this.#persist();
  }

  problems(): Problem[] {
    return [...this.#problems.values()].map(({ key, message, since }) => ({ key, message, since }));
  }

  #persist(): void {
    try {
      this.#save?.(this.problems());
    } catch {
      // keeping a copy for the status command is a nicety
    }
  }
}

/** What the bridge says about your Google Messages login. */
export interface BridgeStatus {
  /** CONNECTED, CONNECTING, TRANSIENT_DISCONNECT, BAD_CREDENTIALS, LOGGED_OUT, UNKNOWN_ERROR…; none when no login. */
  state: string | undefined;
  error?: string | undefined;
  message?: string | undefined;
  rcsEnabled?: boolean | undefined;
}

/**
 * Asks the bridge (its provisioning API, with your Matrix token) how your Google Messages login is doing.
 * Throws when the bridge doesn't answer.
 */
export async function bridgeStatus(options: { url: string; token: string; userId: string; fetch?: typeof fetch }): Promise<BridgeStatus> {
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(`${options.url.replace(/\/+$/, '')}/_matrix/provision/v3/whoami?user_id=${encodeURIComponent(options.userId)}`, {
    headers: { authorization: `Bearer ${options.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`the bridge answered HTTP ${res.status}`);
  const body = (await res.json()) as {
    logins?: Array<{ state?: { state_event?: string; error?: string; message?: string; info?: { settings?: { rcs_enabled?: boolean } } } }>;
  };
  const login = body.logins?.[0];
  if (!login) return { state: undefined };
  return {
    state: login.state?.state_event,
    error: login.state?.error,
    message: login.state?.message,
    rcsEnabled: login.state?.info?.settings?.rcs_enabled,
  };
}

/**
 * Turns the bridge's status into problems: logged out (log in again), not reaching Google (after a while: the phone
 * may be off or offline), RCS off on the phone, or the bridge not running.
 */
export class BridgeWatch {
  #health: Health;
  #status: () => Promise<BridgeStatus>;
  #now: () => Date;
  #troubleSince: number | undefined;

  constructor(options: { health: Health; status: () => Promise<BridgeStatus>; now?: () => Date }) {
    this.#health = options.health;
    this.#status = options.status;
    this.#now = options.now ?? (() => new Date());
  }

  async check(): Promise<void> {
    let status: BridgeStatus;
    try {
      status = await this.#status();
    } catch {
      this.#health.problem('bridge', "The Google Messages bridge isn't answering. Start it: npm run stack -- start");
      return;
    }
    const why = status.message || status.error;
    if (!status.state || status.state === 'BAD_CREDENTIALS' || status.state === 'LOGGED_OUT') {
      this.#troubleSince = undefined;
      this.#health.problem('bridge', `Google Messages is logged out of the bridge${why ? ` (${why})` : ''}. Log in again: npm run matrix-console, then "login google".`);
    } else if (status.state === 'CONNECTED' || status.state === 'BACKFILLING') {
      this.#troubleSince = undefined;
      this.#health.ok('bridge', 'Fixed: the bridge is connected to Google Messages again.');
    } else {
      // Brief disconnects happen; only one that lasts is worth a word.
      const now = this.#now().getTime();
      this.#troubleSince ??= now;
      if (now - this.#troubleSince >= 15 * 60_000) {
        this.#health.problem('bridge', `The bridge can't reach Google Messages${why ? ` (${why})` : ''}. Is your phone on and online?`);
      }
    }
    if (status.rcsEnabled === false) this.#health.problem('rcs', "RCS chats are off on your phone, so songs can't be sent. Turn them on: Messages → Settings → RCS chats.");
    else if (status.rcsEnabled === true) this.#health.ok('rcs', 'Fixed: RCS chats are on again.');
  }
}
