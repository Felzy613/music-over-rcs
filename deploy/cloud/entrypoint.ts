import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { boot, readCloudConfig, type Booted, type BootSys } from '../../src/cloud/boot.ts';
import { openFrontDoor, type FrontDoor } from '../../src/cloud/front-door.ts';
import { RESTART_EXIT_CODE, RESTART_SIGNAL } from '../../src/cloud/host-restart.ts';
import { s3LeaseStore } from '../../src/cloud/lease.ts';
import { PEOPLE_OBJECT } from '../../src/cloud/people-list.ts';
import { s3FromEnv } from '../../src/cloud/s3.ts';
import { LeaseClient, Supervisor } from '../../src/cloud/supervise.ts';

// The container's PID 1 work: see docs/cloud.md. It takes the lease, restores the databases, writes the settings and keeps
// the replicator, homeserver, bridge and bot running; on SIGTERM it stops them in order and lets the lease go. The bot can ask it to restart
// (SIGUSR2, from the management console after the people list changed): it stops the same way and then exits with a failure code, so the
// container ends and Render starts it again, which is a deploy's start (src/cloud/host-restart.ts).
const log = (line: string) => console.log(`${new Date().toISOString()} [host] ${line}`);

let config;
try {
  config = readCloudConfig(process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const sys: BootSys = {
  mkdir: async (path) => void (await mkdir(path, { recursive: true })),
  writeFile: async (path, text, mode) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, mode ? { mode } : undefined);
  },
  readFile: (path) => readFile(path, 'utf8'),
  exists: (path) => access(path).then(() => true, () => false),
  run: (command, args, options) =>
    new Promise((resolve) => {
      execFile(command, args, { cwd: options?.cwd, maxBuffer: 8 * 1024 * 1024, timeout: 10 * 60_000 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
        resolve({ code, output: `${stdout}${stderr}${err && code === 1 && !stdout && !stderr ? err.message : ''}` });
      });
    }),
  fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// The web port is open from the first moment to the last (src/cloud/front-door.ts). Render sends traffic to a new instance, and stops
// the old one, as soon as the port accepts a connection, and the old one's stopping is what lets go of the lease; so the port must
// be open while this copy waits for the lease, and stay open while it restores and starts, or visitors get "Bad Gateway" and Render
// restarts the instance for refusing connections. Everything but /healthz is passed to the bot's own door, once that is open.
let door: FrontDoor;
try {
  door = await openFrontDoor({ port: config.ports.front, upstream: { port: config.ports.bot }, phase: 'starting' });
  log(`front door open on port ${door.port}`);
} catch (err) {
  console.error(`cannot open the web port ${config.ports.front}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const bucket = s3FromEnv(process.env, { log });
const lease = bucket ? new LeaseClient({ store: s3LeaseStore(bucket), holder: config.holder }) : undefined;
// Synapse's signing key is kept in the bucket, so a start does not have Python make a new one (15 to 20 s on this CPU).
const SIGNING_KEY_OBJECT = 'keys/synapse-signing.key';
const signingKey = bucket
  ? {
      get: async () => (await bucket.get(SIGNING_KEY_OBJECT))?.text,
      put: async (text: string) => {
        if (!(await bucket.put(SIGNING_KEY_OBJECT, text)).ok) throw new Error('R2 refused the key');
      },
    }
  : undefined;
// The people added from the console are read here once, at the very start (src/cloud/people-list.ts); a failure is the boot sequence's to log.
const savedPeople = bucket ? { get: async () => (await bucket.get(PEOPLE_OBJECT))?.text } : undefined;
// Render allows 30 s between SIGTERM and SIGKILL, and four processes are stopped one after another.
const supervisor = new Supervisor({ log, graceMs: 6000 });

let booted: Booted | undefined;
let terminating = false;
const terminate = async (signal: string, exitCode = 0): Promise<void> => {
  if (terminating) return;
  terminating = true;
  log(`${signal} received`);
  try {
    if (booted) await booted.shutdown();
    else await lease?.release();
  } finally {
    process.exit(exitCode);
  }
};
process.on('SIGTERM', () => void terminate('SIGTERM'));
process.on('SIGINT', () => void terminate('SIGINT'));
// The console asked for a restart: the same orderly stop, then a failure exit so that the container ends and is started again. While the
// processes stop, the front door's page says so instead of "starting".
process.on(RESTART_SIGNAL, () => {
  if (terminating) return;
  door.setPhase('restarting, as the console asked');
  void terminate(`${RESTART_SIGNAL} (restart asked for by the console)`, RESTART_EXIT_CODE);
});

try {
  booted = await boot({ config, env: process.env, log, sys, supervisor, lease, onLost: () => process.exit(1), onPhase: (text) => door.setPhase(text), signingKey, ...(savedPeople ? { savedPeople } : {}) });
  log(`up as ${config.holder}`);
} catch (err) {
  console.error(`cannot start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
