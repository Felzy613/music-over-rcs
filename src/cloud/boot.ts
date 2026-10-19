import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { bridgeRegistration, patchBridgeConfig, pathsFor, SYNAPSE_LOG_CONFIG, synapseConfig, type BridgeOptions, type CloudPaths } from './provision.ts';
import type { ChildSpec, LeaseState } from './supervise.ts';

// What the cloud host does between "the container started" and "the bot is answering", and what it undoes on the way out.
// The order matters and is the point of this file: nothing touches the databases or Google's session until this host holds
// the lease; nothing starts on an empty database when a backup exists; and the replicator stops last.

export interface CloudConfig {
  dataDir: string;
  master: string;
  serverName: string;
  user: string;
  password: string;
  holder: string;
  /** Where the databases are backed up, and the lease and alerts are kept (R2); without it none of that happens, which is only for trying things out. */
  backup: boolean;
  runDir: string;
  appDir: string;
  /**
   * Where the homeserver, the bridge and the bot's own web door listen, on this machine only; and the port the host's front door
   * (src/cloud/front-door.ts) has open to the world, which Render names in PORT.
   */
  ports: { homeserver: number; bridge: number; bot: number; front: number };
  bins: { bridge: string; python: string; register: string; litestream: string; node: string };
  litestreamConfig: string;
}

/** Reads the host's settings from the environment, reporting every problem at once. */
export function readCloudConfig(env: NodeJS.ProcessEnv): CloudConfig {
  const problems: string[] = [];
  const need = (name: string): string => {
    const value = env[name]?.trim() ?? '';
    if (!value) problems.push(`${name} is not set`);
    return value;
  };
  const master = need('SECRET_KEY');
  if (master && master.length < 16) problems.push('SECRET_KEY must be at least 16 characters');
  const password = need('MATRIX_PASSWORD');
  const port = (name: string, fallback: number): number => {
    const value = Number(env[name]?.trim() || fallback);
    if (!(Number.isInteger(value) && value >= 1 && value <= 65535)) problems.push(`${name} must be a port number (got "${env[name]}")`);
    return value;
  };
  const homeserver = port('SYNAPSE_PORT', 8008);
  const bridgePort = port('BRIDGE_PORT', 29336);
  const botPort = port('BOT_WEB_PORT', 8081);
  const frontPort = port('PORT', 8080);
  if (botPort === frontPort) problems.push(`BOT_WEB_PORT must differ from PORT (both ${frontPort}): the front door is on PORT and passes requests to the bot on BOT_WEB_PORT`);
  const backup = Boolean(env.R2_ENDPOINT?.trim() && env.R2_BUCKET?.trim() && env.R2_ACCESS_KEY_ID?.trim() && env.R2_SECRET_ACCESS_KEY?.trim());
  if (problems.length > 0) throw new Error(`Configuration problems:\n  - ${problems.join('\n  - ')}`);
  return {
    dataDir: env.DATA_DIR?.trim() || '/data',
    master,
    serverName: env.SERVER_NAME?.trim() || 'localhost',
    user: env.MATRIX_USER?.trim() || 'me',
    password,
    holder: env.INSTANCE_ID?.trim() || env.RENDER_INSTANCE_ID?.trim() || `${hostname()}-${randomBytes(3).toString('hex')}`,
    backup,
    runDir: env.RUN_DIR?.trim() || '/run/mors',
    appDir: env.APP_DIR?.trim() || '/app',
    ports: { homeserver, bridge: bridgePort, bot: botPort, front: frontPort },
    bins: {
      bridge: env.BRIDGE_BIN?.trim() || '/usr/local/bin/mautrix-gmessages',
      python: env.SYNAPSE_PYTHON?.trim() || '/opt/venv/bin/python',
      register: env.REGISTER_BIN?.trim() || '/opt/venv/bin/register_new_matrix_user',
      litestream: env.LITESTREAM_BIN?.trim() || '/usr/local/bin/litestream',
      node: env.NODE_BIN?.trim() || process.execPath,
    },
    litestreamConfig: env.LITESTREAM_CONFIG?.trim() || '/etc/litestream.yml',
  };
}

/** The outside world the boot sequence touches, so a test can watch it happen. */
export interface BootSys {
  mkdir(path: string): Promise<void>;
  writeFile(path: string, text: string, mode?: number): Promise<void>;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  run(command: string, args: string[], options?: { cwd?: string }): Promise<{ code: number; output: string }>;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
}

export interface BootDeps {
  config: CloudConfig;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  sys: BootSys;
  supervisor: { start(specs: ChildSpec[]): void; stop(): Promise<void> };
  lease: { acquire(options?: { log?: (line: string) => void; onWaiting?: () => void }): Promise<void>; renew(): Promise<LeaseState>; release(): Promise<void> } | undefined;
  /** Called, after everything has been stopped, when the lease is found to belong to another host. */
  onLost: () => void;
  /** Told what the start is doing ("restoring the databases"), for the front door's "starting up" page. */
  onPhase?: (text: string) => void;
  /**
   * Where Synapse's signing key is kept between starts (the bucket). Without it every start has Synapse make a new one, which on a
   * tenth of a CPU is 15 to 20 seconds of Python while the bot is away.
   */
  signingKey?: { get(): Promise<string | undefined>; put(text: string): Promise<void> };
  renewEveryMs?: number;
}

export interface Booted {
  shutdown(): Promise<void>;
}

/** Synapse's signing key file: one line, `<algorithm> <version> <base64 key>`. */
const SIGNING_KEY = /^ed25519 \S+ \S+\n?$/;

const pick = (env: NodeJS.ProcessEnv, names: string[]): NodeJS.ProcessEnv => Object.fromEntries(names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));

/** The databases that are backed up and brought back, in the order they are restored. */
export const databasesOf = (paths: CloudPaths): string[] => [paths.synapseDb, paths.bridgeDb, paths.catalog];

export async function boot(deps: BootDeps): Promise<Booted> {
  const { config, sys, log } = deps;
  const paths = pathsFor(config.dataDir);
  const HOMESERVER = `http://127.0.0.1:${config.ports.homeserver}`;
  const BRIDGE = `http://127.0.0.1:${config.ports.bridge}`;
  let stopped = false;
  let renewing: NodeJS.Timeout | undefined;

  const homeserverUp = async (): Promise<boolean> => {
    try {
      const res = await sys.fetch(`${HOMESERVER}/_matrix/client/versions`, { signal: AbortSignal.timeout(4000) });
      await res.body?.cancel().catch(() => {});
      return res.ok;
    } catch {
      return false;
    }
  };

  const phase = (text: string): void => deps.onPhase?.(text);
  const bridge: BridgeOptions = {
    domain: config.serverName,
    homeserverUrl: HOMESERVER,
    appserviceUrl: BRIDGE,
    port: config.ports.bridge,
    master: config.master,
    user: config.user,
    databaseUri: `file:${paths.bridgeDb}?_txlock=immediate`,
  };

  // The settings come first, and beside the wait for the lease. They touch neither the databases nor Google's session, only this
  // container's own disk, and making them is slow on a tenth of a CPU (Synapse's start-up check alone is 15 seconds), so doing it
  // while the old host is still letting go keeps it out of the time the bot is away. A failure is held until the lease is ours,
  // so it is reported and cleaned up the same way as any other.
  const provision = async (): Promise<void> => {
    for (const dir of [paths.data, paths.synapseDir, paths.bridgeDir, paths.mediaStore, config.runDir]) await sys.mkdir(dir);
    // Write the homeserver's and the bridge's settings (the same every start), and let Synapse make its signing key.
    await sys.writeFile(paths.synapseLog, SYNAPSE_LOG_CONFIG);
    await sys.writeFile(paths.synapseConfig, synapseConfig({ serverName: config.serverName, paths, master: config.master, port: config.ports.homeserver }), 0o600);
    await sys.writeFile(paths.bridgeRegistration, bridgeRegistration(bridge), 0o600);
    const generated = await sys.run(config.bins.bridge, ['-c', paths.bridgeConfig, '-e'], { cwd: paths.bridgeDir });
    if (generated.code !== 0 || !(await sys.exists(paths.bridgeConfig))) throw new Error(`the bridge could not write its example config (exit ${generated.code}): ${generated.output.trim().split('\n').slice(-3).join(' | ')}`);
    await sys.writeFile(paths.bridgeConfig, patchBridgeConfig(await sys.readFile(paths.bridgeConfig), bridge), 0o600);
    await signingKey();
  };

  // Synapse's signing key: the one kept from an earlier start if there is one, else Synapse makes it (the first start, or a bucket
  // that cannot be read) and it is kept for the next. What is kept is what Synapse itself wrote, so its form is never our guess;
  // it is only checked to be one line of the form `ed25519 <version> <key>` before it is trusted.
  const signingKey = async (): Promise<void> => {
    const store = deps.signingKey;
    let kept: string | undefined;
    if (store) {
      try {
        kept = await store.get();
      } catch (err) {
        log(`could not read Synapse's signing key from the backup (${err instanceof Error ? err.message : String(err)}); making a new one`);
      }
    }
    if (kept !== undefined && SIGNING_KEY.test(kept)) {
      await sys.writeFile(paths.synapseKey, kept.endsWith('\n') ? kept : `${kept}\n`, 0o600);
      log("Synapse's signing key came from the backup");
      return;
    }
    if (kept !== undefined) log("the signing key in the backup is not in the form Synapse writes; making a new one");
    const keys = await sys.run(config.bins.python, ['-m', 'synapse.app.homeserver', '-c', paths.synapseConfig, '--generate-keys']);
    if (keys.code !== 0) throw new Error(`Synapse could not make its signing key (exit ${keys.code}): ${keys.output.trim().split('\n').slice(-3).join(' | ')}`);
    if (!store) return;
    try {
      const made = await sys.readFile(paths.synapseKey);
      if (!SIGNING_KEY.test(made)) throw new Error('Synapse wrote a key in a form that was not expected, so it is not kept');
      await store.put(made);
      log("kept Synapse's signing key in the backup for the next start");
    } catch (err) {
      log(`could not keep Synapse's signing key in the backup (${err instanceof Error ? err.message : String(err)}); the next start makes another`);
    }
  };
  const provisioned: Promise<unknown> = provision().then(
    () => undefined,
    (err: unknown) => err ?? new Error('could not write the settings'),
  );

  // 1. Nothing touches a database, or starts a process, until no other host can be using Google's session or writing the backup.
  if (deps.lease) await deps.lease.acquire({ log, onWaiting: () => phase('waiting for the previous copy to let go') });
  else log('NO LEASE (it needs the R2 settings): only run one copy of this host at a time');

  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(renewing);
    log('shutting down');
    await deps.supervisor.stop();
    await deps.lease?.release();
  };

  try {
    const failure = await provisioned;
    if (failure) throw failure;

    // 2. Bring the databases back from the backup, the three at once (each is mostly waiting on R2). A failed restore stops the
    //    start: going on with empty databases would begin a backup of nothing on top of the real one.
    if (config.backup) {
      phase('restoring the databases');
      const results = await Promise.allSettled(
        databasesOf(paths).map(async (db) => {
          if (await sys.exists(db)) return;
          const result = await sys.run(config.bins.litestream, ['restore', '-config', config.litestreamConfig, '-if-replica-exists', db]);
          if (result.code !== 0) throw new Error(`could not restore ${db} from the backup (exit ${result.code}): ${result.output.trim().split('\n').slice(-3).join(' | ')}`);
          log(`${(await sys.exists(db)) ? 'restored' : 'no backup yet for'} ${db}`);
        }),
      );
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failed) throw failed.reason;
    } else {
      log('NOTHING IS BACKED UP: set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
    }

    phase('starting the services');

    // 3. Start everything. The bridge waits for the homeserver; the bot's own start waits for it too (src/cloud-main.ts).
    //    Each process gets only the secrets it needs: the homeserver and the bridge get none.
    const base = pick(deps.env, ['PATH', 'HOME', 'TZ', 'LANG', 'LC_ALL']);
    const botEnv: NodeJS.ProcessEnv = { ...deps.env, MATRIX_HOMESERVER: HOMESERVER, BRIDGE_URL: BRIDGE, MATRIX_USER: config.user, CATALOG_DB: paths.catalog, BRIDGE_DB: paths.bridgeDb, BRIDGE_PIDFILE: join(config.runDir, 'bridge.pid'), PREFETCH_MB: deps.env.PREFETCH_MB ?? '0' };
    // The bot's share of the 512 MB: what is left after the homeserver, bridge, replicator and this supervisor (see SongArchive).
    botEnv.BOT_MEMORY_MB ??= '220';
    // The first start in the cloud says hello in the chat (once; STARTUP_MESSAGE=off or always changes that).
    botEnv.STARTUP_MESSAGE ??= 'once';
    // YouTube asks this host's address to prove it isn't a bot, so its songs come by way of Cloudflare (src/cloud/youtube-relay.ts).
    botEnv.YOUTUBE_RELAY ??= 'r2';
    // Big buffers (a song) go straight back to the system when freed, so the bot's memory use follows what it really holds.
    botEnv.MALLOC_ARENA_MAX ??= '2';
    botEnv.MALLOC_MMAP_THRESHOLD_ ??= '262144';
    // The bot can't derive the homeserver's secrets. It keeps the R2 settings: its alerts go into the bucket for the Worker to mail.
    delete botEnv.SECRET_KEY;
    // The bot's web door is on a port of its own, on this machine only: the front door (src/cloud/front-door.ts) holds the port Render
    // watches, so that port is never closed while the bot starts, restarts or is replaced.
    botEnv.PORT = String(config.ports.bot);
    botEnv.HOST = '127.0.0.1';
    const specs: ChildSpec[] = [
      ...(config.backup
        ? [{ name: 'litestream', command: config.bins.litestream, args: ['replicate', '-config', config.litestreamConfig], env: { ...base, ...pick(deps.env, ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']), R2_REGION: deps.env.R2_REGION?.trim() || 'auto' }, stopRank: 4 } satisfies ChildSpec]
        : []),
      { name: 'synapse', command: config.bins.python, args: ['-m', 'synapse.app.homeserver', '-c', paths.synapseConfig], cwd: paths.synapseDir, env: { ...base, PYTHONUNBUFFERED: '1' }, stopRank: 3 },
      { name: 'bridge', command: config.bins.bridge, args: ['-c', paths.bridgeConfig], cwd: paths.bridgeDir, env: { ...base, GOMEMLIMIT: deps.env.GOMEMLIMIT ?? '64MiB' }, ready: homeserverUp, pidFile: join(config.runDir, 'bridge.pid'), stopRank: 2 },
      { name: 'bot', command: config.bins.node, args: ['--disable-warning=ExperimentalWarning', '--expose-gc', `--max-old-space-size=${deps.env.BOT_HEAP_MB ?? '120'}`, join(config.appDir, 'src', 'cloud-main.ts')], cwd: config.appDir, env: botEnv, stopRank: 1 },
    ];
    deps.supervisor.start(specs);

    // 4. The bot's account, made once the homeserver is up (nothing happens if it exists).
    void (async () => {
      while (!stopped && !(await homeserverUp())) await sys.sleep(2000);
      for (let attempt = 1; !stopped && attempt <= 5; attempt++) {
        const made = await sys.run(config.bins.register, ['-c', paths.synapseConfig, '-u', config.user, '-p', config.password, '--no-admin', HOMESERVER]);
        if (made.code === 0) return void log(`made the Matrix account @${config.user}:${config.serverName}`);
        if (/already.*(taken|in use|exists)|User ID already/i.test(made.output)) return void log(`the Matrix account @${config.user}:${config.serverName} exists`);
        log(`could not make the Matrix account (attempt ${attempt}): ${made.output.trim().split('\n').slice(-2).join(' | ')}`);
        await sys.sleep(5000);
      }
    })();

    // 5. Keep the lease. Losing it means another host has taken over: stop everything now rather than fight it.
    if (deps.lease) {
      renewing = setInterval(() => {
        void deps.lease!.renew().then(async (state) => {
          if (state === 'lost' && !stopped) {
            log('the lease now belongs to another host: stopping');
            await shutdown();
            deps.onLost();
          } else if (state === 'unreachable') {
            log('could not reach the lease service; carrying on');
          }
        });
      }, deps.renewEveryMs ?? 30_000);
      renewing.unref();
    }
    return { shutdown };
  } catch (err) {
    // Whatever went wrong, don't hold the lease: another try (or host) can have it at once.
    await shutdown();
    throw err;
  }
}

