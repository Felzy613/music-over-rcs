import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { boot, readCloudConfig, type Booted, type BootSys } from '../../src/cloud/boot.ts';
import { s3LeaseStore } from '../../src/cloud/lease.ts';
import { s3FromEnv } from '../../src/cloud/s3.ts';
import { LeaseClient, Supervisor } from '../../src/cloud/supervise.ts';

// The container's PID 1 work: see docs/cloud.md. It takes the lease, restores the databases, writes the settings and keeps
// the replicator, homeserver, bridge and bot running; on SIGTERM it stops them in order and lets the lease go.
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

const bucket = s3FromEnv(process.env, { log });
const lease = bucket ? new LeaseClient({ store: s3LeaseStore(bucket), holder: config.holder }) : undefined;
// Render allows 30 s between SIGTERM and SIGKILL, and four processes are stopped one after another.
const supervisor = new Supervisor({ log, graceMs: 6000 });

let booted: Booted | undefined;
let terminating = false;
const terminate = async (signal: string): Promise<void> => {
  if (terminating) return;
  terminating = true;
  log(`${signal} received`);
  try {
    if (booted) await booted.shutdown();
    else await lease?.release();
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', () => void terminate('SIGTERM'));
process.on('SIGINT', () => void terminate('SIGINT'));

try {
  booted = await boot({ config, env: process.env, log, sys, supervisor, lease, onLost: () => process.exit(1) });
  log(`up as ${config.holder}`);
} catch (err) {
  console.error(`cannot start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
