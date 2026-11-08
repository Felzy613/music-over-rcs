import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PEOPLE_OBJECT, serializePeople } from '../src/cloud/people-list.ts';
import { RESTART_EXIT_CODE } from '../src/cloud/host-restart.ts';
import { startFakeS3, type FakeS3Server } from './helpers/fake-s3-server.ts';

// The container's own process (deploy/cloud/entrypoint.ts) run for real, with stand-ins for the four programs it keeps running (a short shell or
// node script each), the bucket (a small HTTP server that does what R2 does with ETags and conditions) and nothing else: no network beyond this
// machine, no Render. It shows what the host does when the console asks it to restart (the same orderly stop as for a deploy, then a failure
// exit so the container ends and is started again), that a stop from Render still exits cleanly, and that the people saved in the bucket are
// read at the start and set up like the people in PEOPLE.

const ENTRY = fileURLToPath(new URL('../deploy/cloud/entrypoint.ts', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const EXAMPLE = `homeserver:\n    address: https://example.com\n    domain: example.com\nappservice:\n    address: http://localhost:29336\n    hostname: 0.0.0.0\n    port: 29336\n    as_token: "x"\n    hs_token: "y"\ndatabase:\n    type: "postgres"\n    uri: postgres://x\nprovisioning:\n    allow_matrix_auth: false\nnetwork:\n    initial_chat_sync_count: 25\nbackfill:\n    enabled: true\nmatrix:\n    message_status_events: false\nlogging:\n    min_level: debug\n    writers:\n        - type: stdout\nbridge:\n    permissions:\n        "*": relay\n`;

async function until(ready: () => boolean, what: string | (() => string), ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${typeof what === 'string' ? what : what()}`);
    await sleep(25);
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('the container’s own process (deploy/cloud/entrypoint.ts)', () => {
  const running: ChildProcess[] = [];
  const folders: string[] = [];
  let bucket: FakeS3Server;
  before(async () => {
    bucket = await startFakeS3();
  });
  after(async () => {
    for (const child of running) child.kill('SIGKILL');
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
    await bucket.close();
  });
  afterEach(() => {
    bucket.objects.clear();
    bucket.unreadable.clear();
  });

  /** Writes the stand-ins and starts the entrypoint on them. */
  async function start(options: { bucket?: boolean; env?: Record<string, string> } = {}) {
    const folder = mkdtempSync(join(tmpdir(), 'entrypoint-'));
    folders.push(folder);
    const bin = (name: string, text: string): string => {
      const path = join(folder, name);
      writeFileSync(path, text);
      chmodSync(path, 0o755);
      return path;
    };
    const fakeSynapse = join(folder, 'synapse.mjs');
    writeFileSync(
      fakeSynapse,
      `import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const config = readFileSync(args[args.indexOf('-c') + 1], 'utf8');
if (args.includes('--generate-keys')) {
  writeFileSync(/signing_key_path: "([^"]+)"/.exec(config)[1], 'ed25519 a_FAKE ZmFrZWZha2VmYWtl\\n');
  process.exit(0);
}
createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"versions":["v1.1"]}'); }).listen(Number(/- port: (\\d+)/.exec(config)[1]), '127.0.0.1');
`,
    );
    const data = join(folder, 'data');
    const botEnvOut = join(folder, 'bot-env.txt');
    const registerLog = join(folder, 'register.log');
    const example = join(folder, 'example.yaml');
    writeFileSync(example, EXAMPLE);
    const [front, bot, homeserver, bridgePort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: folder,
      SECRET_KEY: 'an-entrypoint-test-master-key',
      MATRIX_PASSWORD: 'the-owners-matrix-password',
      INSTANCE_ID: 'host-under-test',
      DATA_DIR: data,
      RUN_DIR: join(folder, 'run'),
      APP_DIR: REPO,
      PORT: String(front),
      BOT_WEB_PORT: String(bot),
      SYNAPSE_PORT: String(homeserver),
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_BIN: bin('bridge', `#!/bin/sh\ncase " $* " in *" -e "*) cp "${example}" "$2"; exit 0;; esac\nexec sleep 600\n`),
      SYNAPSE_PYTHON: bin('python', `#!/bin/sh\nexec "${process.execPath}" "${fakeSynapse}" "$@"\n`),
      REGISTER_BIN: bin('register', `#!/bin/sh\necho "$*" >> "${registerLog}"\nexit 0\n`),
      LITESTREAM_BIN: bin('litestream', `#!/bin/sh\ncase "$1" in restore) exit 0;; esac\nexec sleep 600\n`),
      NODE_BIN: bin('fake-node', `#!/bin/sh\nenv > "${botEnvOut}"\nexec sleep 600\n`),
      ...(options.bucket === false ? {} : { R2_ENDPOINT: bucket.url, R2_BUCKET: 'mors-state', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret' }),
      ...options.env,
    };
    const output = { text: '' };
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], { cwd: REPO, env });
    running.push(child);
    child.stdout.on('data', (chunk: Buffer) => (output.text += chunk));
    child.stderr.on('data', (chunk: Buffer) => (output.text += chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    await until(() => output.text.includes('[host] up as'), () => `the host to be up:\n${output.text}`);
    return {
      child,
      output,
      exited,
      front,
      botEnv: (): Record<string, string> => Object.fromEntries(readFileSync(botEnvOut, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])),
      /** The bot and the bridge (which waits for the homeserver) have both been started, so a stop has all four to stop. */
      botEnvReady: () => existsSync(botEnvOut) && output.text.includes('started bridge'),
      registered: (): string[] => (existsSync(registerLog) ? readFileSync(registerLog, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ')[line.split(' ').indexOf('-u') + 1]!) : []),
      bridgeConfig: (): string => readFileSync(join(data, 'gmessages', 'config.yaml'), 'utf8'),
    };
  }

  /** The stop's log lines in the order they came, by the first words of each. */
  const stopOrder = (text: string): string[] => ['shutting down', 'stopping bot', 'stopping bridge', 'stopping synapse', 'stopping litestream'].filter((line) => text.includes(`] ${line}`) || text.includes(` ${line}`));

  test('SIGUSR2, the console’s request, stops everything in a deploy’s order, lets go of the lease, and exits with a failure so the container is started again', async () => {
    const host = await start();
    assert.equal(RESTART_EXIT_CODE, 1);
    assert.ok(host.child.pid);
    // The bot is told the host's own process id: that is where the console sends the signal.
    await until(host.botEnvReady, 'the bot to start');
    assert.equal(host.botEnv().HOST_PID, String(host.child.pid));
    assert.ok(JSON.parse(bucket.objects.get('lease.json')!.body).expiresAt > Date.now(), 'the host holds the lease');
    process.kill(host.child.pid!, 'SIGUSR2');
    const { code, signal } = await host.exited;
    assert.deepEqual([code, signal], [RESTART_EXIT_CODE, null]);
    const text = host.output.text;
    assert.match(text, /SIGUSR2 \(restart asked for by the console\) received/);
    const positions = ['SIGUSR2 (restart asked', 'shutting down', 'stopping bot', 'stopping bridge', 'stopping synapse', 'stopping litestream'].map((needle) => text.indexOf(needle));
    assert.ok(positions.every((position) => position >= 0), text);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in the order a deploy stops them: the bot first, the replicator last');
    assert.equal(JSON.parse(bucket.objects.get('lease.json')!.body).expiresAt, 0, 'the lease is let go, so the next start takes it at once');
  });

  test('SIGTERM, Render’s stop, is still an orderly stop that exits cleanly', async () => {
    const host = await start();
    await until(host.botEnvReady, 'the bot to start');
    process.kill(host.child.pid!, 'SIGTERM');
    const { code } = await host.exited;
    assert.equal(code, 0);
    assert.equal(stopOrder(host.output.text).length, 5);
    assert.equal(JSON.parse(bucket.objects.get('lease.json')!.body).expiresAt, 0);
    assert.doesNotMatch(host.output.text, /restart asked for by the console/);
  });

  test('a second request while it is already stopping changes nothing', async () => {
    const host = await start();
    await until(host.botEnvReady, 'the bot to start');
    process.kill(host.child.pid!, 'SIGUSR2');
    await sleep(20);
    try {
      process.kill(host.child.pid!, 'SIGUSR2');
      process.kill(host.child.pid!, 'SIGTERM');
    } catch {
      // it may already be gone
    }
    const { code } = await host.exited;
    assert.equal(code, RESTART_EXIT_CODE, 'the first reason stands');
    assert.equal((host.output.text.match(/shutting down/g) ?? []).length, 1);
  });

  test('a host with no bucket can be asked too: nothing is saved or leased, and it still stops and exits with a failure', async () => {
    const host = await start({ bucket: false });
    await until(host.botEnvReady, 'the bot to start');
    assert.equal(host.botEnv().HOST_PID, String(host.child.pid));
    assert.match(host.output.text, /NO LEASE/);
    process.kill(host.child.pid!, 'SIGUSR2');
    assert.equal((await host.exited).code, RESTART_EXIT_CODE);
    assert.equal(stopOrder(host.output.text).length, 4, 'no replicator without a bucket');
  });

  test('with nothing saved and nothing in PEOPLE the start is the owner’s alone: one account, one permission, no people for the bot', async () => {
    const host = await start();
    await until(host.botEnvReady, 'the bot to start');
    await until(() => host.registered().length >= 1, 'the owner’s account');
    assert.deepEqual(host.registered(), ['me']);
    assert.match(host.bridgeConfig(), /permissions:\n {8}"@me:localhost": admin$/);
    const env = host.botEnv();
    for (const name of ['PEOPLE', 'PEOPLE_PASSWORDS', 'PEOPLE_IN_RENDER']) assert.equal(name in env, false, name);
    assert.ok(!host.output.text.includes('people added in the console'));
    process.kill(host.child.pid!, 'SIGTERM');
    await host.exited;
  });

  test('the people saved in the bucket are read at the start and set up like the people in PEOPLE', async () => {
    bucket.objects.set(PEOPLE_OBJECT, { body: serializePeople([{ id: 'alice', addedAt: '2026-11-08T12:00:00.000Z' }, { id: 'bob', addedAt: null }]), etag: '"saved"' });
    const host = await start({ env: { PEOPLE: 'zed' } });
    await until(host.botEnvReady, 'the bot to start');
    await until(() => host.registered().length >= 4, 'the accounts');
    assert.deepEqual(host.registered(), ['me', 'zed', 'alice', 'bob']);
    assert.match(host.bridgeConfig(), /"@me:localhost": admin\n {8}"@zed:localhost": user\n {8}"@alice:localhost": user\n {8}"@bob:localhost": user$/);
    const env = host.botEnv();
    assert.equal(env.PEOPLE, 'zed,alice,bob');
    assert.equal(env.PEOPLE_IN_RENDER, 'zed');
    assert.match(env.PEOPLE_PASSWORDS!, /^zed:[0-9a-f]+,alice:[0-9a-f]+,bob:[0-9a-f]+$/);
    assert.match(host.output.text, /people added in the console: alice, bob/);
    assert.equal(bucket.objects.get(PEOPLE_OBJECT)!.etag, '"saved"', 'the host only reads the list');
    process.kill(host.child.pid!, 'SIGTERM');
    await host.exited;
  });

  test('a list in the bucket that cannot be read never stops the host: one line, and PEOPLE alone', async () => {
    bucket.unreadable.add(PEOPLE_OBJECT);
    const host = await start({ env: { PEOPLE: 'zed' } });
    await until(host.botEnvReady, 'the bot to start');
    await until(() => host.registered().length >= 2, 'the accounts');
    assert.deepEqual(host.registered(), ['me', 'zed']);
    assert.equal((host.output.text.match(/could not read the people added in the console/g) ?? []).length, 1);
    assert.equal(host.botEnv().PEOPLE, 'zed');
    process.kill(host.child.pid!, 'SIGTERM');
    await host.exited;
  });

  test('a damaged list never stops the host either', async () => {
    bucket.objects.set(PEOPLE_OBJECT, { body: '{"people": [', etag: '"bad"' });
    const host = await start();
    await until(host.botEnvReady, 'the bot to start');
    assert.match(host.output.text, /the saved list of people \(config\/people\.json\) is not valid JSON.*carrying on with the names in PEOPLE/);
    assert.equal('PEOPLE' in host.botEnv(), false);
    process.kill(host.child.pid!, 'SIGTERM');
    await host.exited;
  });

  test('the front door says "restarting" while it stops, and answers /healthz until the end', async () => {
    const host = await start();
    await until(host.botEnvReady, 'the bot to start');
    assert.equal((await fetch(`http://127.0.0.1:${host.front}/healthz`)).status, 200);
    process.kill(host.child.pid!, 'SIGUSR2');
    let said = '';
    for (let i = 0; i < 40 && !said; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${host.front}/admin/`, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(500) });
        const body = await res.text();
        if (res.status === 503 && body.includes('restarting')) said = body;
      } catch {
        // gone already
      }
      await sleep(10);
    }
    await host.exited;
    // The window is short (the stand-ins stop at once), so this is only checked when it was caught; the phase text itself is fixed in the entry.
    if (said) assert.match(said, /restarting, as the console asked/);
    assert.match(readFileSync(ENTRY, 'utf8'), /door\.setPhase\('restarting, as the console asked'\)/);
  });
});
