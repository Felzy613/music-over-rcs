import { execFile } from 'node:child_process';

/** The launchd service deploy/mac/setup.sh installs for the Google Messages bridge. */
export const BRIDGE_SERVICE = 'com.musicoverrcs.bridge';

export type Exec = (file: string, args: string[]) => Promise<void>;

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
 */
export function bridgeRestarter(
  env: NodeJS.ProcessEnv = process.env,
  options: { platform?: string; uid?: number | undefined; exec?: Exec } = {},
): (() => Promise<void>) | undefined {
  if (/^(off|false|no|0)$/i.test(env.BRIDGE_AUTO_RESTART?.trim() ?? '')) return undefined;
  const platform = options.platform ?? process.platform;
  const uid = 'uid' in options ? options.uid : process.getuid?.();
  if (platform !== 'darwin' || uid === undefined) return undefined;
  const service = env.BRIDGE_SERVICE?.trim() || BRIDGE_SERVICE;
  const exec = options.exec ?? launchctl;
  return () => exec('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${service}`]);
}
