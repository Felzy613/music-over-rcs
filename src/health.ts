import { execFile } from 'node:child_process';

/** Shows a notification on a Mac running the bot (Notification Center). Elsewhere it does nothing; the cloud host mails its alerts instead (src/alert.ts). */
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
  /** CONNECTED, CONNECTING, TRANSIENT_DISCONNECT, BAD_CREDENTIALS, LOGGED_OUT, UNKNOWN_ERROR…; none when there is no login at all. */
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
  // Failed pairing attempts stay behind as signed-out logins, so the working one is looked for first.
  const logins = body.logins ?? [];
  const login = logins.find((l) => l.state?.state_event === 'CONNECTED' || l.state?.state_event === 'BACKFILLING') ?? logins[0];
  if (!login) return { state: undefined };
  return {
    // A login that hasn't reported yet (the bridge has just started) is connecting, not logged out.
    state: login.state?.state_event ?? 'CONNECTING',
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
/** How long to wait before restarting a bridge that is still down after the first restart, then after the second and every one after. */
const RESTART_AGAIN_MS = [5 * 60_000, 10 * 60_000];
/** How often a bridge is restarted while Google says the phone isn't answering (the first after this long of it too): a restart can't make the phone answer. */
const PHONE_RESTART_MS = 2 * 60 * 60_000;
/**
 * The bridge's reason when Google answers but the phone doesn't: mautrix-gmessages' gm-phone-not-responding, "Your
 * Google Messages app is not responding. Open the Google Messages app on your phone…".
 */
const PHONE_NOT_RESPONDING = /phone.not.responding|not responding.*phone/i;

/**
 * Turns the bridge's status into problems: logged out (log in again), not reaching Google (after a while), RCS off
 * on the phone, or the bridge not running. When the bridge can't reach Google because this Mac has no internet,
 * that is what's said instead (once, after ten minutes), with nothing blamed on the bridge or the phone.
 *
 * A bridge that is down with the internet up is restarted, and restarted again every few minutes for as long as it
 * stays down: Google can turn it away for a while (a web filter's downtime, a bad stretch of network) and the bridge
 * doesn't reliably try again by itself once Google is reachable, so there is no one restart that is "the" restart.
 * Only a bridge with no Google login at all can't mend itself; linking one takes a code scanned on the phone.
 * The exception is the phone not answering: the bridge's link to Google is fine then and it reconnects by itself once
 * the phone answers, so it is restarted only every two hours meanwhile, in case the bridge is what's stuck.
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
  /** Restarts in this stretch of trouble, and when the last one was. */
  #restarts = 0;
  #lastRestartAt: number | undefined;
  #lastSendFailureRestartAt: number | undefined;
  /** When the bridge started saying the phone isn't answering, and when it last said so. */
  #phoneSilentSince: number | undefined;
  #phoneSilentAt: number | undefined;

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
      // launchd starts a crashed bridge again by itself; one that hangs without exiting is restarted here.
      const now = this.#now().getTime();
      this.#troubleSince ??= now;
      this.#health.problem('bridge', "The Google Messages bridge isn't answering. It is restarted on its own; if this lasts, restart the service in Render.");
      if (this.#restartDue(now, BRIDGE_RESTART_GRACE_MS)) await this.#restartBridge("The Google Messages bridge isn't answering; restarting its bridge service.", now);
      return;
    }
    const now = this.#now().getTime();
    const noLogin = !status.state;
    const signedOut = status.state === 'BAD_CREDENTIALS' || status.state === 'LOGGED_OUT';
    // Google itself ended the link ("Unpaired from Google Messages, please re-link"), as opposed to turning the bridge away for a while.
    const unlinked = signedOut && /unpaired|re-?link/i.test(`${status.error ?? ''} ${status.message ?? ''}`);
    const connected = status.state === 'CONNECTED' || status.state === 'BACKFILLING';
    if (!noLogin && this.#online) {
      if (!(await this.#online())) {
        this.#offlineSince ??= now;
        this.#troubleSince = undefined;
        this.#networkRecovery = true;
        this.#restartAttempted = false;
        if (now - this.#offlineSince >= OFFLINE_GRACE_MS) {
          this.#health.problem('internet', "The bot's host has no internet. Texts you send meanwhile are answered when it's back.");
        }
        return;
      }
    }
    if (this.#offlineSince !== undefined) {
      const outageMs = now - this.#offlineSince;
      this.#offlineSince = undefined;
      this.#health.ok('internet', 'Fixed: the bot\'s host is back online.');
      // Give the bridge a short chance to reconnect before restarting its stale Google session.
      this.#troubleSince = now;
      this.#networkRecovery = outageMs >= BRIDGE_RESTART_GRACE_MS || !connected;
      this.#restartAttempted = false;
    }
    const why = status.message || status.error;
    if (noLogin) {
      // Nothing to reconnect: Google Messages has to be linked again, which takes a code scanned on the phone. A bridge
      // that has only just started may not list its login yet, so that isn't said at once.
      this.#troubleSince ??= now;
      this.#networkRecovery = false;
      this.#restartAttempted = false;
      this.#health.ok('bridge-restart', 'The bridge is responding, but Google Messages needs a fresh login.');
      if (now - this.#troubleSince >= BRIDGE_RESTART_GRACE_MS) {
        this.#health.problem('bridge', "Google Messages is logged out of the bridge. Log in again on the service's /pair page.");
      }
    } else if (unlinked) {
      // Restarting can't undo this, so it isn't tried: only a new link, made with a code scanned on the phone, mends it.
      this.#troubleSince = undefined;
      this.#networkRecovery = false;
      this.#restartAttempted = false;
      this.#restarts = 0;
      this.#lastRestartAt = undefined;
      this.#phoneSilentSince = this.#phoneSilentAt = undefined;
      this.#health.ok('bridge-restart', 'The bridge is responding, but Google Messages needs a fresh login.');
      this.#health.problem(
        'bridge',
        `Google Messages unlinked the bridge${why ? ` (${why})` : ''}. Restarting can't fix that; link it again on the service's /pair page (docs/cloud.md, step 4).`,
      );
    } else if (connected) {
      if (this.#networkRecovery && this.#restart && !this.#restartAttempted && this.#troubleSince !== undefined && now - this.#troubleSince >= BRIDGE_RESTART_GRACE_MS) {
        await this.#restartBridge('Google Messages still reports connected after a network outage; restarting its bridge service to refresh the session.', now);
        return;
      }
      if (!this.#networkRecovery || !this.#restart) {
        this.#troubleSince = undefined;
        this.#networkRecovery = false;
        this.#restartAttempted = false;
        this.#restarts = 0;
        this.#lastRestartAt = undefined;
        this.#phoneSilentSince = this.#phoneSilentAt = undefined;
      }
      this.#health.ok('bridge', 'Fixed: the bridge is connected to Google Messages again.');
      this.#health.ok('bridge-restart', 'Fixed: the bridge recovered after its automatic restart.');
    } else {
      // Brief disconnects happen; only one that lasts is worth a word. Google turning the bridge away (signed out) is
      // restarted sooner: a restart is how it tries again, and it costs nothing if it's still being turned away.
      this.#troubleSince ??= now;
      const troubleFor = now - this.#troubleSince;
      // The phone not answering is waited out instead (see the class comment). The bridge's error can alternate between
      // two texts, so the phone counts as silent until it hasn't been named for a while; a network recovery or Google
      // turning the bridge away still gets its prompt restart.
      if (!signedOut && PHONE_NOT_RESPONDING.test(`${status.error ?? ''} ${status.message ?? ''}`)) {
        this.#phoneSilentSince ??= now;
        this.#phoneSilentAt = now;
      }
      const phoneSilent = !signedOut && !this.#networkRecovery && this.#phoneSilentAt !== undefined && now - this.#phoneSilentAt < TROUBLE_GRACE_MS;
      if (!phoneSilent && this.#phoneSilentSince !== undefined) {
        // Another reason now: the usual restarts, from the first, as for a disconnect that has lasted this long.
        this.#phoneSilentSince = this.#phoneSilentAt = undefined;
        this.#restarts = 0;
        this.#lastRestartAt = undefined;
      }
      const restartAfter = this.#networkRecovery || signedOut ? BRIDGE_RESTART_GRACE_MS : TROUBLE_GRACE_MS;
      if (phoneSilent) {
        if (this.#phoneRestartDue(now)) await this.#restartBridge("Google Messages still can't reach the phone; restarting its bridge service in case the bridge is what's stuck.", now);
      } else if (this.#restartDue(now, restartAfter)) {
        await this.#restartBridge(
          signedOut
            ? 'Google Messages has the bridge signed out; restarting its bridge service to try again.'
            : 'Google Messages is still disconnected with the internet up; restarting its bridge service.',
          now,
        );
      }
      // With no automatic restarts there is nothing to wait for, so being signed out is said at once.
      if (troubleFor >= TROUBLE_GRACE_MS || (signedOut && !this.#restart)) {
        const detail = why ? ` (${why})` : '';
        const retrying = ' The bot keeps restarting it and reconnects on its own once Google lets it through (a web filter blocking Google does this).';
        if (signedOut && this.#restart) {
          this.#health.problem('bridge', `The bridge is signed out of Google Messages${detail}.${retrying} If this lasts for hours, log in again on the service's /pair page.`);
        } else if (signedOut) {
          this.#health.problem('bridge', `Google Messages is logged out of the bridge${detail}. Log in again on the service's /pair page.`);
        } else {
          const phone = phoneSilent || /phone/i.test(why ?? '') ? ' Is your phone on and online?' : '';
          const hint = !this.#restart
            ? phone || ' It keeps trying; if this lasts, restart the service in Render.'
            : `${phoneSilent ? ' It reconnects on its own once the phone answers.' : retrying}${phone}`;
          this.#health.problem('bridge', `The bridge can't reach Google Messages${detail}.${hint}`);
        }
      }
    }
    if (status.rcsEnabled === false) this.#health.problem('rcs', "RCS chats are off on your phone, so songs can't be sent. Turn them on: Messages → Settings → RCS chats.");
    else if (status.rcsEnabled === true) this.#health.ok('rcs', 'Fixed: RCS chats are on again.');
  }

  /** A terminal bridge notice means its retries already failed, even if the status API still says CONNECTED. */
  async sendFailed(): Promise<void> {
    const now = this.#now().getTime();
    if (!this.#restart) {
      this.#health.problem('bridge-restart', 'Google Messages reported an undelivered message. If texts stop arriving, restart the service in Render.');
      return;
    }
    if (this.#lastSendFailureRestartAt !== undefined && now - this.#lastSendFailureRestartAt < 10 * 60_000) {
      this.#log('Google Messages reported another undelivered message; the bridge was restarted recently, so skipping another restart.');
      return;
    }
    this.#lastSendFailureRestartAt = now;
    await this.#restartBridge('Google Messages reported an undelivered message; restarting its bridge service.', now);
  }

  /** Whether a bridge that is still not working is due a restart: the first after `firstAfterMs` of trouble, then again after growing gaps, for as long as it lasts. */
  #restartDue(now: number, firstAfterMs: number): boolean {
    if (!this.#restart || this.#troubleSince === undefined) return false;
    if (this.#lastRestartAt === undefined) return now - this.#troubleSince >= firstAfterMs;
    const gap = RESTART_AGAIN_MS[Math.min(this.#restarts - 1, RESTART_AGAIN_MS.length - 1)] ?? 10 * 60_000;
    return now - this.#lastRestartAt >= gap;
  }

  /** Whether a bridge waiting for the phone is due its rare restart: two hours after the phone went silent or after the last restart, whichever is later. */
  #phoneRestartDue(now: number): boolean {
    if (!this.#restart || this.#phoneSilentSince === undefined) return false;
    return now - Math.max(this.#phoneSilentSince, this.#lastRestartAt ?? 0) >= PHONE_RESTART_MS;
  }

  async #restartBridge(reason: string, now: number): Promise<void> {
    if (!this.#restart) return;
    this.#restartAttempted = true;
    this.#networkRecovery = false;
    // Counted even if it fails, so a restart that can't happen (the service was stopped on purpose) isn't retried every minute.
    this.#restarts += 1;
    this.#lastRestartAt = now;
    this.#log(reason);
    try {
      await this.#restart();
      this.#log('restarted the Google Messages bridge; waiting for it to reconnect');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.#log(`could not restart the Google Messages bridge automatically: ${detail}`);
      this.#health.problem('bridge-restart', `The bridge couldn't restart automatically (${detail}). Restart the service in Render.`);
    }
  }
}
