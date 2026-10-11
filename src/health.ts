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

  /** Something is wrong. Announced now, then again only every few hours while it lasts, whatever its details say by then. */
  problem(key: string, message: string): void {
    const now = this.#now().getTime();
    const known = this.#problems.get(key);
    if (known && now - known.told < this.#repeatMs) {
      // The same trouble in other words (the bridge's error alternates between two): kept up to date, not said again.
      if (known.message !== message) {
        known.message = message;
        this.#persist();
      }
      return;
    }
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

  /** Whether this is a problem right now. */
  has(key: string): boolean {
    return this.#problems.has(key);
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
 * Whether this Mac can reach the internet: any answer from Google's "no content" address counts. Wi-Fi can stay
 * connected while nothing gets through (the router's own connection is down), so this asks the internet itself.
 */
export async function online(doFetch: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await doFetch('https://www.google.com/generate_204', { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

const OFFLINE_GRACE_MS = 10 * 60_000;
const BRIDGE_RESTART_GRACE_MS = 2 * 60_000;
const TROUBLE_GRACE_MS = 15 * 60_000;

/**
 * Turns the bridge's status into problems: logged out (log in again), not reaching Google (after a while), RCS off
 * on the phone, or the bridge not running. When the bridge can't reach Google because this Mac has no internet,
 * that is what's said instead (once, after ten minutes), with nothing blamed on the bridge or the phone.
 */
export class BridgeWatch {
  #health: Health;
  #status: () => Promise<BridgeStatus>;
  #online: (() => Promise<boolean>) | undefined;
  #restart: (() => Promise<void>) | undefined;
  #log: (line: string) => void;
  #now: () => Date;
  #troubleSince: number | undefined;
  #offlineSince: number | undefined;
  #networkRecovery = false;
  #restartAttempted = false;
  #lastSendFailureRestartAt: number | undefined;

  constructor(options: {
    health: Health;
    status: () => Promise<BridgeStatus>;
    online?: () => Promise<boolean>;
    restart?: () => Promise<void>;
    log?: (line: string) => void;
    now?: () => Date;
  }) {
    this.#health = options.health;
    this.#status = options.status;
    this.#online = options.online;
    this.#restart = options.restart;
    this.#log = options.log ?? (() => {});
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
    const now = this.#now().getTime();
    const loggedOut = !status.state || status.state === 'BAD_CREDENTIALS' || status.state === 'LOGGED_OUT';
    const connected = status.state === 'CONNECTED' || status.state === 'BACKFILLING';
    if (!loggedOut && this.#online) {
      if (!(await this.#online())) {
        this.#offlineSince ??= now;
        this.#troubleSince = undefined;
        this.#networkRecovery = true;
        this.#restartAttempted = false;
        if (now - this.#offlineSince >= OFFLINE_GRACE_MS) {
          this.#health.problem('internet', "This Mac has no internet (it may still show Wi-Fi as connected). Texts you send meanwhile are answered when it's back.");
        }
        return;
      }
    }
    if (this.#offlineSince !== undefined) {
      const outageMs = now - this.#offlineSince;
      this.#offlineSince = undefined;
      this.#health.ok('internet', 'Fixed: this Mac is back online.');
      // Give the bridge a short chance to reconnect before restarting its stale Google session.
      this.#troubleSince = now;
      this.#networkRecovery = outageMs >= BRIDGE_RESTART_GRACE_MS || !connected;
      this.#restartAttempted = false;
    }
    const why = status.message || status.error;
    if (loggedOut) {
      this.#troubleSince = undefined;
      this.#networkRecovery = false;
      this.#restartAttempted = false;
      this.#health.ok('bridge-restart', 'The bridge is responding, but Google Messages needs a fresh login.');
      this.#health.problem('bridge', `Google Messages is logged out of the bridge${why ? ` (${why})` : ''}. Log in again: npm run matrix-console, then "login google".`);
    } else if (connected) {
      if (this.#networkRecovery && this.#restart && !this.#restartAttempted && this.#troubleSince !== undefined && now - this.#troubleSince >= BRIDGE_RESTART_GRACE_MS) {
        await this.#restartBridge('Google Messages still reports connected after a network outage; restarting its bridge service to refresh the session.', now);
        return;
      }
      if (!this.#networkRecovery || !this.#restart) {
        this.#troubleSince = undefined;
        this.#networkRecovery = false;
        this.#restartAttempted = false;
      }
      this.#health.ok('bridge', 'Fixed: the bridge is connected to Google Messages again.');
      this.#health.ok('bridge-restart', 'Fixed: the bridge recovered after its automatic restart.');
    } else {
      // Brief disconnects happen; only one that lasts is worth a word.
      this.#troubleSince ??= now;
      const troubleFor = now - this.#troubleSince;
      const restartAfter = this.#networkRecovery ? BRIDGE_RESTART_GRACE_MS : TROUBLE_GRACE_MS;
      if (this.#restart && !this.#restartAttempted && troubleFor >= restartAfter) {
        await this.#restartBridge('Google Messages is still disconnected with the internet up; restarting its bridge service.', now);
      } else if (troubleFor >= TROUBLE_GRACE_MS) {
        const hint = /phone/i.test(why ?? '') ? 'Is your phone on and online?' : 'It keeps trying; if this lasts, restart it: npm run stack -- restart';
        this.#health.problem('bridge', `The bridge can't reach Google Messages${why ? ` (${why})` : ''}. ${hint}`);
      }
    }
    if (status.rcsEnabled === false) this.#health.problem('rcs', "RCS chats are off on your phone, so songs can't be sent. Turn them on: Messages → Settings → RCS chats.");
    else if (status.rcsEnabled === true) this.#health.ok('rcs', 'Fixed: RCS chats are on again.');
  }

  /** A terminal bridge notice means its retries already failed, even if the status API still says CONNECTED. */
  async sendFailed(): Promise<void> {
    const now = this.#now().getTime();
    if (!this.#restart) {
      this.#health.problem('bridge-restart', 'Google Messages reported an undelivered message. Restart the bridge: npm run stack -- restart');
      return;
    }
    if (this.#lastSendFailureRestartAt !== undefined && now - this.#lastSendFailureRestartAt < 10 * 60_000) {
      this.#log('Google Messages reported another undelivered message; the bridge was restarted recently, so skipping another restart.');
      return;
    }
    this.#lastSendFailureRestartAt = now;
    await this.#restartBridge('Google Messages reported an undelivered message; restarting its bridge service.', now);
  }

  async #restartBridge(reason: string, now: number): Promise<void> {
    if (!this.#restart) return;
    this.#restartAttempted = true;
    this.#networkRecovery = false;
    this.#log(reason);
    try {
      await this.#restart();
      this.#troubleSince = now;
      this.#log('restarted the Google Messages bridge; waiting for it to reconnect');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#log(`could not restart the Google Messages bridge automatically: ${detail}`);
      this.#health.problem('bridge-restart', `The bridge couldn't restart automatically (${detail}). Restart it manually: npm run stack -- restart`);
    }
  }
}
