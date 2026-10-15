import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { boot, databasesOf, readCloudConfig, type BootDeps, type BootSys } from '../src/cloud/boot.ts';
import { derive, pathsFor } from '../src/cloud/provision.ts';
import type { ChildSpec, LeaseState } from '../src/cloud/supervise.ts';

const ENV = {
  SECRET_KEY: 'a-master-secret-of-some-length',
  MATRIX_PASSWORD: 'account-password',
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_BUCKET: 'mors-state',
  R2_ACCESS_KEY_ID: 'r2-id',
  R2_SECRET_ACCESS_KEY: 'r2-secret',
  ADMIN_TOKEN: 'admin-token',
  INSTANCE_ID: 'host-1',
  PATH: '/usr/bin',
  HOME: '/root',
  TZ: 'America/New_York',
};
const EXAMPLE = `homeserver:\n    address: https://example.com\n    domain: example.com\nappservice:\n    address: http://localhost:29336\n    hostname: 0.0.0.0\n    port: 29336\n    as_token: "x"\n    hs_token: "y"\ndatabase:\n    type: "postgres"\n    uri: postgres://x\nprovisioning:\n    allow_matrix_auth: false\nnetwork:\n    initial_chat_sync_count: 25\nbackfill:\n    enabled: true\nlogging:\n    min_level: debug\n    writers:\n        - type: stdout\nbridge:\n    permissions:\n        "*": relay\n`;

interface Setup {
  events: string[];
  files: Map<string, string>;
  specs: ChildSpec[];
  commands: Array<{ command: string; args: string[] }>;
  deps: BootDeps;
  /** Lets `lease.acquire` finish when the test says. */
  grantLease(): void;
  renewals: LeaseState[];
}

function setUp(options: { env?: Record<string, string | undefined>; backup?: boolean; restoreCode?: number; replicaExists?: boolean; lease?: boolean; holdLease?: boolean; accountOutput?: { code: number; output: string } } = {}): Setup {
  const env = { ...ENV, ...options.env } as NodeJS.ProcessEnv;
  if (options.backup === false) for (const name of ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) delete env[name];
  const config = readCloudConfig(env);
  const paths = pathsFor(config.dataDir);
  const events: string[] = [];
  const files = new Map<string, string>();
  const commands: Array<{ command: string; args: string[] }> = [];
  const specs: ChildSpec[] = [];
  let grant!: () => void;
  const granted = new Promise<void>((resolve) => (grant = resolve));
  const renewals: LeaseState[] = [];
  const sys: BootSys = {
    mkdir: async (path) => void events.push(`mkdir ${path}`),
    writeFile: async (path, text) => {
      events.push(`write ${path}`);
      files.set(path, text);
    },
    readFile: async (path) => files.get(path) ?? '',
    exists: async (path) => files.has(path),
    run: async (command, args) => {
      commands.push({ command, args });
      const name = command.split('/').pop()!;
      events.push(`run ${name} ${args[0] ?? ''}`.trim());
      if (name === 'litestream' && args[0] === 'restore') {
        if (options.restoreCode) return { code: options.restoreCode, output: 'R2 said no' };
        if (options.replicaExists) files.set(args.at(-1)!, 'database');
        return { code: 0, output: '' };
      }
      if (name === 'mautrix-gmessages' && args.includes('-e')) {
        files.set(paths.bridgeConfig, EXAMPLE);
        return { code: 0, output: '' };
      }
      if (name === 'register_new_matrix_user') return options.accountOutput ?? { code: 0, output: '' };
      return { code: 0, output: '' };
    },
    fetch: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
    sleep: async () => {},
  };
  const deps: BootDeps = {
    config,
    env,
    log: (line) => events.push(`log ${line}`),
    sys,
    supervisor: {
      start: (list) => {
        events.push('supervisor.start');
        specs.push(...list);
      },
      stop: async () => void events.push('supervisor.stop'),
    },
    lease:
      options.lease === false
        ? undefined
        : {
            acquire: async () => {
              events.push('lease.acquire');
              await granted;
              events.push('lease.granted');
            },
            renew: async () => renewals.shift() ?? 'ok',
            release: async () => void events.push('lease.release'),
          },
    onLost: () => void events.push('onLost'),
    renewEveryMs: 10,
  };
  // The lease is granted at once unless a test wants to hold it back.
  if (!options.holdLease) grant();
  return { events, files, specs, commands, deps, grantLease: grant, renewals };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
/** Where in the events a thing happened; fails the test if it never did. */
const at = (events: string[], needle: string): number => {
  const index = events.findIndex((event) => event.includes(needle));
  assert.ok(index >= 0, `${needle} never happened:\n${events.join('\n')}`);
  return index;
};

describe('the boot sequence', () => {
  test('touches nothing until the lease is this host’s', async () => {
    const s = setUp({ holdLease: true });
    const booting = boot(s.deps);
    await settle(20);
    assert.deepEqual(s.events.filter((event) => !event.startsWith('log')), ['lease.acquire'], 'no directory, no restore, no process before the lease');
    s.grantLease();
    await booting;
    assert.ok(s.events.includes('supervisor.start'));
  });

  test('restores the three databases, in order, before writing settings or starting anything', async () => {
    const s = setUp({ replicaExists: true });
    await boot(s.deps);
    const paths = pathsFor('/data');
    const restores = s.commands.filter((c) => c.args[0] === 'restore');
    assert.deepEqual(restores.map((c) => c.args.at(-1)), databasesOf(paths));
    assert.deepEqual(restores[0]!.args.slice(0, 4), ['restore', '-config', '/etc/litestream.yml', '-if-replica-exists']);
    const sequence = ['lease.granted', 'run litestream restore', `write ${paths.synapseConfig}`, 'run mautrix-gmessages', 'run python', 'supervisor.start'].map((needle) => at(s.events, needle));
    assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b), s.events.join('\n'));
  });

  test('does not restore over a database that is already there', async () => {
    const s = setUp();
    s.files.set(pathsFor('/data').catalog, 'already here');
    await boot(s.deps);
    assert.deepEqual(s.commands.filter((c) => c.args[0] === 'restore').map((c) => c.args.at(-1)), [pathsFor('/data').synapseDb, pathsFor('/data').bridgeDb]);
  });

  test('a restore that fails stops the start before anything is written or started, and lets the lease go', async () => {
    const s = setUp({ restoreCode: 1 });
    await assert.rejects(() => boot(s.deps), /could not restore .*homeserver\.db.*R2 said no/);
    assert.ok(!s.events.includes('supervisor.start'));
    assert.ok(!s.events.some((event) => event.startsWith('write ')), 'no settings written');
    assert.deepEqual(s.events.filter((event) => event.startsWith('supervisor.') || event.startsWith('lease.')).slice(-2), ['supervisor.stop', 'lease.release']);
  });

  test('writes the settings with the derived secrets, and the bridge’s patched config', async () => {
    const s = setUp();
    await boot(s.deps);
    const paths = pathsFor('/data');
    assert.ok(s.files.get(paths.synapseConfig)!.includes(derive(ENV.SECRET_KEY, 'synapse-registration')));
    assert.ok(s.files.get(paths.bridgeRegistration)!.includes(derive(ENV.SECRET_KEY, 'bridge-as')));
    const bridge = s.files.get(paths.bridgeConfig)!;
    assert.ok(bridge.includes(`as_token: "${derive(ENV.SECRET_KEY, 'bridge-as')}"`));
    assert.ok(bridge.includes('"@me:localhost": admin'));
    assert.ok(bridge.includes('address: "http://127.0.0.1:8008"'));
    assert.deepEqual(s.commands.find((c) => c.args.includes('--generate-keys'))?.args.slice(0, 3), ['-m', 'synapse.app.homeserver', '-c']);
  });

  test('starts the replicator, homeserver, bridge and bot, to be stopped in the reverse order', async () => {
    const s = setUp();
    await boot(s.deps);
    assert.deepEqual(s.specs.map((spec) => [spec.name, spec.stopRank]), [['litestream', 4], ['synapse', 3], ['bridge', 2], ['bot', 1]]);
    assert.deepEqual(s.specs.find((spec) => spec.name === 'litestream')!.args, ['replicate', '-config', '/etc/litestream.yml']);
    assert.ok(s.specs.find((spec) => spec.name === 'bridge')!.ready, 'the bridge waits for the homeserver');
    assert.equal(s.specs.find((spec) => spec.name === 'bridge')!.pidFile, '/run/mors/bridge.pid');
    assert.deepEqual(s.specs.find((spec) => spec.name === 'bot')!.args.slice(-1), ['/app/src/cloud-main.ts']);
  });

  test('each process gets only the secrets it needs', async () => {
    const s = setUp();
    await boot(s.deps);
    const env = (name: string) => s.specs.find((spec) => spec.name === name)!.env!;
    for (const name of ['synapse', 'bridge']) {
      assert.deepEqual(Object.keys(env(name)).filter((key) => /SECRET|TOKEN|PASSWORD|R2_/.test(key)), [], `${name} has no secrets`);
    }
    assert.equal(env('litestream').R2_SECRET_ACCESS_KEY, 'r2-secret');
    assert.equal(env('litestream').R2_REGION, 'auto', 'R2 wants the region auto');
    assert.equal(env('litestream').MATRIX_PASSWORD, undefined);
    assert.equal(env('bot').SECRET_KEY, undefined, 'the bot cannot derive the homeserver’s secrets');
    assert.equal(env('bot').R2_SECRET_ACCESS_KEY, 'r2-secret', 'but it keeps the bucket, where its alerts go for the Worker to mail');
    assert.equal(env('bot').MATRIX_PASSWORD, 'account-password');
    assert.equal(env('bot').ADMIN_TOKEN, 'admin-token');
    assert.equal(env('bot').CATALOG_DB, '/data/catalog.db');
    assert.equal(env('bot').BRIDGE_PIDFILE, '/run/mors/bridge.pid');
    assert.equal(env('bot').PREFETCH_MB, '0', 'nothing is kept on a disk that is wiped on every restart');
    assert.equal(env('bridge').GOMEMLIMIT, '64MiB');
  });

  test('the bot’s memory is capped, and the cap can be changed', async () => {
    const s = setUp();
    await boot(s.deps);
    const bot = s.specs.find((spec) => spec.name === 'bot')!;
  
    assert.equal(bot.env!.MALLOC_MMAP_THRESHOLD_, '262144', 'big buffers go back to the system when freed');
    assert.ok(bot.args.includes('--expose-gc'));
    assert.ok(s.specs.find((spec) => spec.name === 'bot')!.args.includes('--max-old-space-size=120'));
    const custom = setUp({ env: { BOT_HEAP_MB: '90' } });
    await boot(custom.deps);
    assert.ok(custom.specs.find((spec) => spec.name === 'bot')!.args.includes('--max-old-space-size=90'));
  });

  test('without backup settings it says so loudly and runs no replicator', async () => {
    const s = setUp({ backup: false });
    await boot(s.deps);
    assert.ok(s.events.some((event) => /NOTHING IS BACKED UP/.test(event)));
    assert.ok(!s.specs.some((spec) => spec.name === 'litestream'));
    assert.ok(!s.commands.some((c) => c.args[0] === 'restore'));
  });

  test('without a lease service it still starts, with a warning', async () => {
    const s = setUp({ lease: false });
    await boot(s.deps);
    assert.ok(s.events.some((event) => /NO LEASE/.test(event)));
    assert.ok(s.events.includes('supervisor.start'));
  });

  test('makes the Matrix account once the homeserver answers, and is content if it exists', async () => {
    const made = setUp();
    await boot(made.deps);
    await settle();
    const register = made.commands.find((c) => c.command.endsWith('register_new_matrix_user'))!;
    assert.deepEqual(register.args.slice(2, 6), ['-u', 'me', '-p', 'account-password']);
    const existing = setUp({ accountOutput: { code: 1, output: 'User ID already taken.' } });
    await boot(existing.deps);
    await settle();
    assert.ok(existing.events.some((event) => /the Matrix account @me:localhost exists/.test(event)));
    assert.equal(existing.commands.filter((c) => c.command.endsWith('register_new_matrix_user')).length, 1, 'no retries for an existing account');
  });

  test('shutting down stops the processes and then gives the lease back, once', async () => {
    const s = setUp();
    const booted = await boot(s.deps);
    await settle(20); // the account is made in the background
    s.events.length = 0;
    await booted.shutdown();
    await booted.shutdown();
    assert.deepEqual(s.events.filter((event) => !event.startsWith('log')), ['supervisor.stop', 'lease.release']);
  });

  test('a lease lost to another host stops everything and then reports it', async () => {
    const s = setUp();
    await boot(s.deps);
    await settle(20); // the account is made in the background
    s.events.length = 0;
    s.renewals.push('lost');
    await settle(60);
    assert.deepEqual(s.events.filter((event) => !event.startsWith('log')), ['supervisor.stop', 'lease.release', 'onLost']);
  });

  test('a lease service that does not answer is not a reason to stop', async () => {
    const s = setUp();
    const booted = await boot(s.deps);
    await settle(20); // the account is made in the background
    s.events.length = 0;
    s.renewals.push('unreachable', 'unreachable', 'ok');
    await settle(80);
    await booted.shutdown();
    assert.ok(!s.events.includes('onLost'));
    assert.ok(s.events.some((event) => /could not reach the lease service; carrying on/.test(event)));
  });
});

describe('the host settings', () => {
  test('reports every problem at once', () => {
    assert.throws(() => readCloudConfig({}), /SECRET_KEY is not set[\s\S]*MATRIX_PASSWORD is not set/);
    assert.throws(() => readCloudConfig({ SECRET_KEY: 'short', MATRIX_PASSWORD: 'x' }), /at least 16 characters/);
  });

  test('has defaults for a container, and takes the instance name from Render', () => {
    const config = readCloudConfig({ SECRET_KEY: ENV.SECRET_KEY, MATRIX_PASSWORD: 'x', RENDER_INSTANCE_ID: 'srv-abc-12345' });
    assert.equal(config.dataDir, '/data');
    assert.equal(config.serverName, 'localhost');
    assert.equal(config.user, 'me');
    assert.equal(config.holder, 'srv-abc-12345');
    assert.equal(config.backup, false);
    assert.match(readCloudConfig({ SECRET_KEY: ENV.SECRET_KEY, MATRIX_PASSWORD: 'x' }).holder, /-[0-9a-f]{6}$/);
  });
});
