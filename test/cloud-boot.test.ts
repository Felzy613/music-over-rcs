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
const EXAMPLE = `homeserver:\n    address: https://example.com\n    domain: example.com\nappservice:\n    address: http://localhost:29336\n    hostname: 0.0.0.0\n    port: 29336\n    as_token: "x"\n    hs_token: "y"\ndatabase:\n    type: "postgres"\n    uri: postgres://x\nprovisioning:\n    allow_matrix_auth: false\nnetwork:\n    initial_chat_sync_count: 25\nbackfill:\n    enabled: true\nmatrix:\n    message_status_events: false\nlogging:\n    min_level: debug\n    writers:\n        - type: stdout\nbridge:\n    permissions:\n        "*": relay\n`;

/** A signing key as Synapse writes it: algorithm, version, base64 seed. */
const MADE_KEY = 'ed25519 a_MADE c2VlZHNlZWRzZWVkc2VlZHNlZWRzZWVkc2Vl\n';
const KEPT_KEY = 'ed25519 a_KEPT a2VwdGtlcHRrZXB0a2VwdGtlcHRrZXB0a2Vw\n';

interface Setup {
  events: string[];
  files: Map<string, string>;
  specs: ChildSpec[];
  commands: Array<{ command: string; args: string[] }>;
  deps: BootDeps;
  /** Lets `lease.acquire` finish when the test says. */
  grantLease(): void;
  renewals: LeaseState[];
  /** What the start said it was doing, for the front door's page. */
  phases: string[];
  /** The most database restores that were running at the same moment. */
  restoreOverlap(): number;
}

function setUp(options: { env?: Record<string, string | undefined>; backup?: boolean; restoreCode?: number; keysCode?: number; signingKey?: BootDeps['signingKey']; replicaExists?: boolean; lease?: boolean; holdLease?: boolean; accountOutput?: { code: number; output: string } } = {}): Setup {
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
  const phases: string[] = [];
  let restoring = 0;
  let widest = 0;
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
        restoring++;
        widest = Math.max(widest, restoring);
        await new Promise((resolve) => setTimeout(resolve, 5));
        restoring--;
        if (options.restoreCode) return { code: options.restoreCode, output: 'R2 said no' };
        if (options.replicaExists) files.set(args.at(-1)!, 'database');
        return { code: 0, output: '' };
      }
      if (name === 'mautrix-gmessages' && args.includes('-e')) {
        files.set(paths.bridgeConfig, EXAMPLE);
        return { code: 0, output: '' };
      }
      if (name === 'python' && args.includes('--generate-keys') && options.keysCode) return { code: options.keysCode, output: 'no signing key for you' };
      if (name === 'python' && args.includes('--generate-keys')) files.set(paths.synapseKey, MADE_KEY);
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
            acquire: async (acquireOptions) => {
              events.push('lease.acquire');
              if (options.holdLease) acquireOptions?.onWaiting?.();
              await granted;
              events.push('lease.granted');
            },
            renew: async () => renewals.shift() ?? 'ok',
            release: async () => void events.push('lease.release'),
          },
    onLost: () => void events.push('onLost'),
    onPhase: (text) => void phases.push(text),
    ...(options.signingKey ? { signingKey: options.signingKey } : {}),
    renewEveryMs: 10,
  };
  // The lease is granted at once unless a test wants to hold it back.
  if (!options.holdLease) grant();
  return { events, files, specs, commands, deps, grantLease: grant, renewals, phases, restoreOverlap: () => widest };
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
/** Where in the events a thing happened; fails the test if it never did. */
const at = (events: string[], needle: string): number => {
  const index = events.findIndex((event) => event.includes(needle));
  assert.ok(index >= 0, `${needle} never happened:\n${events.join('\n')}`);
  return index;
};

describe('the boot sequence', () => {
  test('touches no database and starts no process until the lease is this host’s, but makes the settings while it waits', async () => {
    const s = setUp({ holdLease: true });
    const booting = boot(s.deps);
    await settle(30);
    const before = s.events.filter((event) => !event.startsWith('log'));
    assert.ok(before.includes('lease.acquire'));
    assert.ok(!before.some((event) => event.startsWith('run litestream')), 'no restore before the lease');
    assert.ok(!before.includes('supervisor.start'), 'no process before the lease');
    const paths = pathsFor('/data');
    for (const needle of [`write ${paths.synapseConfig}`, `write ${paths.bridgeRegistration}`, `write ${paths.bridgeConfig}`, 'run mautrix-gmessages', 'run python']) at(before, needle);
    assert.deepEqual(s.phases, ['waiting for the previous copy to let go']);
    s.grantLease();
    await booting;
    assert.ok(s.events.includes('supervisor.start'));
  });

  test('restores the three databases, all at once, after the lease and before starting anything', async () => {
    const s = setUp({ replicaExists: true });
    await boot(s.deps);
    const paths = pathsFor('/data');
    const restores = s.commands.filter((c) => c.args[0] === 'restore');
    assert.deepEqual(restores.map((c) => c.args.at(-1)), databasesOf(paths));
    assert.deepEqual(restores[0]!.args.slice(0, 4), ['restore', '-config', '/etc/litestream.yml', '-if-replica-exists']);
    assert.equal(s.restoreOverlap(), 3, 'each restore is mostly waiting on R2, so they do not wait for one another');
    const sequence = ['lease.granted', 'run litestream restore', 'supervisor.start'].map((needle) => at(s.events, needle));
    assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b), s.events.join('\n'));
    const settings = [`write ${paths.synapseConfig}`, 'run mautrix-gmessages', 'run python'].map((needle) => at(s.events, needle));
    assert.ok(Math.max(...settings) < at(s.events, 'supervisor.start'), 'the settings are all made before anything starts');
    assert.deepEqual(s.phases, ['restoring the databases', 'starting the services']);
    for (const db of databasesOf(paths)) assert.ok(s.events.some((event) => event.includes(`restored ${db}`)), `${db} restored`);
  });

  test('does not restore over a database that is already there', async () => {
    const s = setUp();
    s.files.set(pathsFor('/data').catalog, 'already here');
    await boot(s.deps);
    assert.deepEqual(s.commands.filter((c) => c.args[0] === 'restore').map((c) => c.args.at(-1)), [pathsFor('/data').synapseDb, pathsFor('/data').bridgeDb]);
  });

  test('a restore that fails stops the start before anything is started, and lets the lease go', async () => {
    const s = setUp({ restoreCode: 1 });
    await assert.rejects(() => boot(s.deps), /could not restore .*homeserver\.db.*R2 said no/);
    assert.ok(!s.events.includes('supervisor.start'));
    assert.deepEqual(s.events.filter((event) => event.startsWith('supervisor.') || event.startsWith('lease.')).slice(-2), ['supervisor.stop', 'lease.release']);
  });

  test('settings that cannot be made are reported once the lease is this host’s, with no restore and no process, and the lease is let go', async () => {
    const s = setUp({ keysCode: 1 });
    await assert.rejects(() => boot(s.deps), /Synapse could not make its signing key \(exit 1\).*no signing key for you/);
    assert.ok(!s.commands.some((c) => c.args[0] === 'restore'), 'nothing restored over a start that cannot finish');
    assert.ok(!s.events.includes('supervisor.start'));
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

  describe('Synapse’s signing key', () => {
    const keyStore = (initial: string | undefined, behaviour: { getThrows?: boolean; putThrows?: boolean } = {}) => {
      const puts: string[] = [];
      let gets = 0;
      return {
        puts,
        gets: () => gets,
        store: {
          get: async () => {
            gets++;
            if (behaviour.getThrows) throw new Error('R2 said no');
            return initial;
          },
          put: async (text: string) => {
            if (behaviour.putThrows) throw new Error('R2 refused the key');
            puts.push(text);
          },
        },
      };
    };
    const keyPath = pathsFor('/data').synapseKey;

    test('a key kept from an earlier start is put in place, and Python is not asked for another', async () => {
      const kept = keyStore(KEPT_KEY);
      const s = setUp({ signingKey: kept.store });
      await boot(s.deps);
      assert.equal(s.files.get(keyPath), KEPT_KEY);
      assert.ok(!s.commands.some((c) => c.args.includes('--generate-keys')), 'the 15 seconds of Python are skipped');
      assert.deepEqual(kept.puts, [], 'and nothing is written back');
      assert.ok(s.events.some((event) => /signing key came from the backup/.test(event)));
    });

    test('the first start makes the key with Synapse and keeps what Synapse wrote for the next', async () => {
      const kept = keyStore(undefined);
      const s = setUp({ signingKey: kept.store });
      await boot(s.deps);
      assert.ok(s.commands.some((c) => c.args.includes('--generate-keys')));
      assert.deepEqual(kept.puts, [MADE_KEY]);
      assert.equal(s.files.get(keyPath), MADE_KEY);
      assert.ok(s.events.some((event) => /kept Synapse's signing key in the backup/.test(event)));
    });

    test('a kept key without its final newline still lands as one line, and a key in the wrong form is not trusted', async () => {
      const bare = setUp({ signingKey: keyStore(KEPT_KEY.trimEnd()).store });
      await boot(bare.deps);
      assert.equal(bare.files.get(keyPath), KEPT_KEY);

      for (const garbage of ['', 'not a key', 'rsa a_x AAAA\n', 'ed25519 a_x AAAA\nextra line\n', '<html>Bad Gateway</html>']) {
        const kept = keyStore(garbage);
        const s = setUp({ signingKey: kept.store });
        await boot(s.deps);
        assert.ok(s.commands.some((c) => c.args.includes('--generate-keys')), `"${garbage}" is not used`);
        assert.equal(s.files.get(keyPath), MADE_KEY);
        assert.deepEqual(kept.puts, [MADE_KEY], `"${garbage}" is replaced by Synapse's own`);
        assert.ok(s.events.some((event) => /not in the form Synapse writes/.test(event)));
      }
    });

    test('a bucket that cannot be read makes the start slower, not impossible', async () => {
      const kept = keyStore(KEPT_KEY, { getThrows: true });
      const s = setUp({ signingKey: kept.store });
      await boot(s.deps);
      assert.ok(s.commands.some((c) => c.args.includes('--generate-keys')));
      assert.ok(s.events.includes('supervisor.start'));
      assert.ok(s.events.some((event) => /could not read Synapse's signing key from the backup \(R2 said no\)/.test(event)));
    });

    test('a bucket that refuses the key is reported and the start carries on', async () => {
      const s = setUp({ signingKey: keyStore(undefined, { putThrows: true }).store });
      await boot(s.deps);
      assert.ok(s.events.includes('supervisor.start'));
      assert.ok(s.events.some((event) => /could not keep Synapse's signing key in the backup \(R2 refused the key\)/.test(event)));
    });

    test('a key that Synapse itself failed to make is still a failed start, and nothing bad is kept', async () => {
      const kept = keyStore(undefined);
      const s = setUp({ signingKey: kept.store, keysCode: 1 });
      await assert.rejects(() => boot(s.deps), /Synapse could not make its signing key/);
      assert.deepEqual(kept.puts, []);
    });

    test('without a bucket it is made every start, as before', async () => {
      const s = setUp({ backup: false });
      await boot(s.deps);
      assert.ok(s.commands.some((c) => c.args.includes('--generate-keys')));
    });

    test('is looked up once, while the host waits for the lease and before anything is restored', async () => {
      const kept = keyStore(KEPT_KEY);
      const s = setUp({ signingKey: kept.store, holdLease: true, replicaExists: true });
      const booting = boot(s.deps);
      await settle(30);
      assert.equal(kept.gets(), 1);
      assert.equal(s.files.get(keyPath), KEPT_KEY, 'in place before the lease, so the wait is not spent on it');
      assert.ok(!s.commands.some((c) => c.args[0] === 'restore'));
      s.grantLease();
      await booting;
      assert.equal(kept.gets(), 1);
    });
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
    assert.equal(env('bot').PORT, '8081', 'the bot’s web door is on its own port, behind the front door');
    assert.equal(env('bot').HOST, '127.0.0.1', 'and on this machine only');
    assert.equal(env('bot').PREFETCH_MB, '0', 'nothing is kept on a disk that is wiped on every restart');
    assert.equal(env('bridge').GOMEMLIMIT, '64MiB');
  });

  test('the bot’s own port is not the one Render watches, whatever PORT is', async () => {
    const s = setUp({ env: { PORT: '10000', HOST: '0.0.0.0' } });
    assert.equal(s.deps.config.ports.front, 10000);
    await boot(s.deps);
    const bot = s.specs.find((spec) => spec.name === 'bot')!;
    assert.equal(bot.env!.PORT, '8081');
    assert.equal(bot.env!.HOST, '127.0.0.1');
    const moved = setUp({ env: { PORT: '10000', BOT_WEB_PORT: '9001' } });
    await boot(moved.deps);
    assert.equal(moved.specs.find((spec) => spec.name === 'bot')!.env!.PORT, '9001');
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
    assert.throws(() => readCloudConfig({ SECRET_KEY: ENV.SECRET_KEY, MATRIX_PASSWORD: 'x', PORT: '8081' }), /BOT_WEB_PORT must differ from PORT/);
    assert.throws(() => readCloudConfig({ SECRET_KEY: ENV.SECRET_KEY, MATRIX_PASSWORD: 'x', PORT: 'ten thousand' }), /PORT must be a port number/);
  });

  test('has defaults for a container, and takes the instance name from Render', () => {
    const config = readCloudConfig({ SECRET_KEY: ENV.SECRET_KEY, MATRIX_PASSWORD: 'x', RENDER_INSTANCE_ID: 'srv-abc-12345' });
    assert.equal(config.dataDir, '/data');
    assert.equal(config.serverName, 'localhost');
    assert.equal(config.user, 'me');
    assert.equal(config.holder, 'srv-abc-12345');
    assert.equal(config.backup, false);
    assert.deepEqual(config.ports, { homeserver: 8008, bridge: 29336, bot: 8081, front: 8080 });
    assert.match(readCloudConfig({ SECRET_KEY: ENV.SECRET_KEY, MATRIX_PASSWORD: 'x' }).holder, /-[0-9a-f]{6}$/);
  });
});
