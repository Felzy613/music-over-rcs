import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** The launchd label a Mac install used for the Google Messages bridge (the Mac install is retired; this stays for a bot run on a Mac). */
export const BRIDGE_SERVICE = 'com.musicoverrcs.bridge';

export type Exec = (file: string, args: string[]) => Promise<void>;
export type Kill = (pid: number, signal: NodeJS.Signals) => void;

const launchctl: Exec = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 30_000 }, (err, _stdout, stderr) => (err ? reject(new Error(String(stderr).trim() || err.message)) : resolve()));
  });

/**
 * A function that restarts the bridge (launchd stops it and starts it again; that signs it in to Google afresh,
 * which is what a bridge stuck after a long loss of internet needs), or undefined where that isn't possible:
 * not a Mac, or BRIDGE_AUTO_RESTART=off. It rejects, in launchctl's own words, when the service isn't loaded
 * (`stack stop`, or the bridge running in a terminal), so a bridge you stopped on purpose stays stopped.
 * BRIDGE_SERVICE names another launchd label.
 *
 * On a server there is no launchd: BRIDGE_PIDFILE names the file where the process supervisor (src/cloud/supervise.ts, started by deploy/cloud/entrypoint.ts)
 * writes the bridge's process id, and the restart is a SIGTERM to it, which the supervisor answers by starting it again.
 */
export function bridgeRestarter(
  env: NodeJS.ProcessEnv = process.env,
  options: { platform?: string; uid?: number | undefined; exec?: Exec; kill?: Kill; readPid?: (path: string) => Promise<string> } = {},
): (() => Promise<void>) | undefined {
  if (/^(off|false|no|0)$/i.test(env.BRIDGE_AUTO_RESTART?.trim() ?? '')) return undefined;
  const pidfile = env.BRIDGE_PIDFILE?.trim();
  if (pidfile) {
    const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    const readPid = options.readPid ?? ((path) => readFile(path, 'utf8'));
    return async () => {
      const pid = Number.parseInt((await readPid(pidfile)).trim(), 10);
      if (!Number.isInteger(pid) || pid < 2) throw new Error(`${pidfile} does not hold a process id`);
      kill(pid, 'SIGTERM');
    };
  }
  const platform = options.platform ?? process.platform;
  const uid = 'uid' in options ? options.uid : process.getuid?.();
  if (platform !== 'darwin' || uid === undefined) return undefined;
  const service = env.BRIDGE_SERVICE?.trim() || BRIDGE_SERVICE;
  const exec = options.exec ?? launchctl;
  return () => exec('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${service}`]);
}
