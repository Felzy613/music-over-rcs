// Restarting the whole cloud host from the management console. A person added from the console is set up at the host's start (their bridge
// permission, their Matrix account, their token and their runner are all made then), so the console asks the host to restart, and the host
// does what it does for a deploy: stops the bot, the bridge, the homeserver and the replicator in order, lets go of the lease, and goes.
//
// The bot (which serves the console) cannot do that itself: it is one of the host's four processes. It signals the host process, the one
// that runs deploy/cloud/entrypoint.ts, which handles the signal like SIGTERM and then exits with a failure code so that the container
// ends and Render starts it again (the same way the host already leaves when another host takes its lease). Every start restores the
// databases from the bucket, so a restart is always the proven start.

/** What the bot sends the host. SIGUSR2 is free in Node (SIGUSR1 starts the inspector); a process with no handler for it is killed, which is why the pid is never guessed. */
export const RESTART_SIGNAL: NodeJS.Signals = 'SIGUSR2';

/** The console answers the page first; the signal goes this long afterwards. */
export const RESTART_DELAY_MS = 3000;

/**
 * The code the host exits with after a requested restart. A failure code, like the one used when the lease is lost: nothing in this
 * project shows what Render does with a clean exit of the main process, and a failure is certainly started again.
 */
export const RESTART_EXIT_CODE = 1;

/**
 * How long a request counts as on its way. A host that was asked stops within a minute and the bot with it, so a bot still here after this
 * long was never stopped (the signal was lost, or the host would not go): the request is forgotten so the owner can ask again.
 */
export const RESTART_PENDING_MS = 5 * 60_000;

/** Why a restart cannot be requested, with the HTTP status the console answers with. */
export class HostRestartError extends Error {
  readonly status: 409 | 503;
  constructor(status: 409 | 503, message: string) {
    super(message);
    this.name = 'HostRestartError';
    this.status = status;
  }
}

export interface HostRestarter {
  /** Whether this process can ask the host to restart, and if not, why (in words for the owner). */
  available(): { ok: true } | { ok: false; why: string };
  /** True from a request until the process ends (or `RESTART_PENDING_MS` has passed without it ending): a second request while one is on its way is refused. */
  pending(): boolean;
  /** Asks the host to restart, `inSeconds` from now (so the answer to the page goes first). Throws a `HostRestartError` when it cannot. */
  request(): { inSeconds: number };
}

export interface HostRestarterOptions {
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  delayMs?: number;
  log?: (line: string) => void;
  /** This process's own id, which is never signalled. */
  ownPid?: number;
  setTimer?: (work: () => void, ms: number) => unknown;
  now?: () => number;
}

/**
 * The bot's way to ask the host to restart. The host's process id comes from HOST_PID, which only the host sets (src/cloud/boot.ts): it is
 * not taken from the parent process, which outside the host would be someone's shell.
 */
export function hostRestarter(env: NodeJS.ProcessEnv, options: HostRestarterOptions = {}): HostRestarter {
  const raw = env.HOST_PID?.trim() ?? '';
  const ownPid = options.ownPid ?? process.pid;
  const pid = /^\d{1,9}$/.test(raw) ? Number(raw) : undefined;
  const kill = options.kill ?? ((target, signal) => void process.kill(target, signal));
  const delayMs = options.delayMs ?? RESTART_DELAY_MS;
  const setTimer = options.setTimer ?? ((work, ms) => setTimeout(work, ms));
  const now = options.now ?? Date.now;
  /** When the request that is on its way was made; undefined when none is. */
  let askedAt: number | undefined;
  const isPending = (): boolean => {
    if (askedAt !== undefined && now() - askedAt >= RESTART_PENDING_MS) askedAt = undefined;
    return askedAt !== undefined;
  };

  const available = (): { ok: true } | { ok: false; why: string } =>
    pid === undefined || pid < 2 || pid === ownPid
      ? { ok: false, why: 'This process was not started by the host, so it cannot ask the host to restart. Restart the service in Render instead.' }
      : { ok: true };

  return {
    available,
    pending: isPending,
    request() {
      const can = available();
      if (!can.ok || pid === undefined) throw new HostRestartError(409, can.ok ? 'This process cannot restart the host.' : can.why);
      if (isPending()) throw new HostRestartError(409, 'A restart is already on its way.');
      try {
        // Signal 0 only asks whether the process is there: a host that is gone is told now, not discovered after the page has waited.
        kill(pid, 0);
      } catch (err) {
        throw new HostRestartError(503, `The host process (${pid}) is not there to restart: ${err instanceof Error ? err.message : String(err)}. Restart the service in Render instead.`);
      }
      askedAt = now();
      options.log?.(`restart requested from the console: the host is asked to restart in ${Math.round(delayMs / 1000)} s`);
      setTimer(() => {
        try {
          kill(pid, RESTART_SIGNAL);
        } catch (err) {
          askedAt = undefined;
          options.log?.(`the host could not be asked to restart: ${err instanceof Error ? err.message : String(err)}`);
        }
      }, delayMs);
      return { inSeconds: Math.max(1, Math.round(delayMs / 1000)) };
    },
  };
}
