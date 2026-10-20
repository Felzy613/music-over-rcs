import { createHmac } from 'node:crypto';
import { join } from 'node:path';

// The cloud host starts from an empty disk every time (the databases come back from the replica; nothing else does), so the
// homeserver's and the bridge's settings are written afresh at each start. The secrets in them are derived from one master
// secret, so they come out the same every time and nothing needs to be kept: the bridge and the homeserver always agree,
// and a restarted bot's saved access token still means something to the homeserver.

/** A secret that is the same whenever the same master secret and label are given (64 hex characters). */
export function derive(master: string, label: string): string {
  return createHmac('sha256', master).update(`music-over-rcs:${label}`).digest('hex');
}

export interface CloudPaths {
  data: string;
  synapseDir: string;
  synapseDb: string;
  synapseConfig: string;
  synapseLog: string;
  synapseKey: string;
  mediaStore: string;
  bridgeDir: string;
  bridgeDb: string;
  bridgeConfig: string;
  bridgeRegistration: string;
  catalog: string;
}

export function pathsFor(data: string): CloudPaths {
  const synapseDir = join(data, 'synapse');
  const bridgeDir = join(data, 'gmessages');
  return {
    data,
    synapseDir,
    synapseDb: join(synapseDir, 'homeserver.db'),
    synapseConfig: join(synapseDir, 'homeserver.yaml'),
    synapseLog: join(synapseDir, 'log.config'),
    synapseKey: join(synapseDir, 'signing.key'),
    mediaStore: join(synapseDir, 'media_store'),
    bridgeDir,
    bridgeDb: join(bridgeDir, 'mautrix-gmessages.db'),
    bridgeConfig: join(bridgeDir, 'config.yaml'),
    bridgeRegistration: join(bridgeDir, 'registration.yaml'),
    catalog: join(data, 'catalog.db'),
  };
}

export const SYNAPSE_LOG_CONFIG = `version: 1
formatters:
  precise:
    format: '%(asctime)s - %(name)s - %(lineno)d - %(levelname)s - %(request)s - %(message)s'
handlers:
  console:
    class: logging.StreamHandler
    formatter: precise
loggers:
  synapse.storage.SQL:
    level: WARNING
root:
  level: WARNING
  handlers:
  - console
disable_existing_loggers: false
`;

export interface SynapseOptions {
  serverName: string;
  paths: CloudPaths;
  master: string;
  /** Synapse's cache scale (1 is the default); small hosts want less. */
  cacheFactor?: number;
  /** The port it listens on, on this machine only (default 8008). */
  port?: number;
}

/**
 * Synapse's settings for one user on a small host: it listens on this machine only, never federates, keeps no presence
 * and few caches, drops media a day after it is uploaded (a song has been handed to the bridge by then), and lets the
 * bot send as fast as it likes (a list is one message per line).
 */
export function synapseConfig(options: SynapseOptions): string {
  const { paths, master, serverName } = options;
  const q = (value: string) => JSON.stringify(value);
  return `# Written by the cloud host at each start; edit src/cloud/provision.ts instead.
server_name: ${q(serverName)}
listeners:
  - port: ${options.port ?? 8008}
    tls: false
    type: http
    x_forwarded: false
    bind_addresses: ['127.0.0.1']
    resources:
      - names: [client]
        compress: false
database:
  name: sqlite3
  args:
    database: ${q(paths.synapseDb)}
log_config: ${q(paths.synapseLog)}
media_store_path: ${q(paths.mediaStore)}
signing_key_path: ${q(paths.synapseKey)}
registration_shared_secret: ${q(derive(master, 'synapse-registration'))}
macaroon_secret_key: ${q(derive(master, 'synapse-macaroon'))}
form_secret: ${q(derive(master, 'synapse-form'))}
report_stats: false
enable_registration: false
trusted_key_servers: []
suppress_key_server_warning: true
federation_domain_whitelist: []
app_service_config_files:
  - ${q(paths.bridgeRegistration)}
max_upload_size: 100M
media_retention:
  local_media_lifetime: 1d
  remote_media_lifetime: 1d
redaction_retention_period: 1h
presence:
  enabled: false
# One person on a homeserver of their own: Synapse's default (a message every 5 s after a burst of 10) made a long list,
# one message per line so each can be 👍'd, arrive over minutes. The runner keeps its own loop guard.
rc_message:
  per_second: 20
  burst_count: 200
caches:
  global_factor: ${options.cacheFactor ?? 0.25}
`;
}

export interface BridgeOptions {
  /** The homeserver's name, the part after the colon in a Matrix id. */
  domain: string;
  homeserverUrl: string;
  appserviceUrl: string;
  port: number;
  master: string;
  /** The Matrix account (localpart) that may use the bridge as its admin. */
  user: string;
  databaseUri: string;
  /** Chats the bridge makes rooms for as soon as it logs in. 0 means only chats with new activity. */
  initialChats?: number;
}

/** The appservice registration the homeserver reads: the same tokens the bridge's own config holds. */
export function bridgeRegistration(options: BridgeOptions): string {
  const q = (value: string) => JSON.stringify(value);
  const domain = options.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `id: gmessages
url: ${q(options.appserviceUrl)}
as_token: ${q(derive(options.master, 'bridge-as'))}
hs_token: ${q(derive(options.master, 'bridge-hs'))}
sender_localpart: ${q(derive(options.master, 'bridge-sender').slice(0, 32))}
rate_limited: false
namespaces:
  users:
    - regex: ${q(`^@gmessagesbot:${domain}$`)}
      exclusive: true
    - regex: ${q(`^@gmessages_.*:${domain}$`)}
      exclusive: true
de.sorunome.msc2409.push_ephemeral: true
receive_ephemeral: true
`;
}

type Scalar = string | number | boolean;

/**
 * Sets values in the bridge's generated example config (`mautrix-gmessages -e`) and returns the new text: the keys one level
 * under a top-level section, plus the lists `bridge.permissions` and `logging.writers`, which are replaced whole. Comments
 * elsewhere are kept. Throws, naming them, if any key to set is not there (the bridge's layout changed).
 */
export function patchBridgeConfig(text: string, options: BridgeOptions): string {
  const set: Record<string, Scalar> = {
    'homeserver.address': options.homeserverUrl,
    'homeserver.domain': options.domain,
    'appservice.address': options.appserviceUrl,
    'appservice.hostname': '127.0.0.1',
    'appservice.port': options.port,
    'appservice.as_token': derive(options.master, 'bridge-as'),
    'appservice.hs_token': derive(options.master, 'bridge-hs'),
    'database.type': 'sqlite3-fk-wal',
    'database.uri': options.databaseUri,
    'provisioning.allow_matrix_auth': true,
    'network.initial_chat_sync_count': options.initialChats ?? 0,
    'backfill.enabled': false,
    'logging.min_level': 'info',
  };
  const blocks: Record<string, (indent: string) => string[]> = {
    'bridge.permissions': (indent) => [`${indent}permissions:`, `${indent}${indent}${JSON.stringify(`@${options.user}:${options.domain}`)}: admin`],
    'logging.writers': (indent) => [`${indent}writers:`, `${indent}${indent}- type: stdout`, `${indent}${indent}  format: pretty`],
  };
  const lines = text.split('\n');
  const indent = lines.map((line) => /^(\s+)\S/.exec(line)).find((match, i) => match && !lines[i]!.trimStart().startsWith('#'))?.[1] ?? '    ';
  const format = (value: Scalar): string => (typeof value === 'string' ? JSON.stringify(value) : String(value));
  const applied = new Set<string>();
  const out: string[] = [];
  let section: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const top = /^([A-Za-z0-9_]+):\s*(#.*)?$/.exec(line);
    if (top) section = top[1];
    else if (/^\S/.test(line) && !line.startsWith('#')) section = undefined;
    const key = line.startsWith(indent) && !line.startsWith(indent + ' ') && !line.startsWith(indent + '\t') ? /^\s+([A-Za-z0-9_]+):/.exec(line)?.[1] : undefined;
    const path = section && key ? `${section}.${key}` : undefined;
    if (path && path in set) {
      out.push(`${indent}${key}: ${format(set[path]!)}`);
      applied.add(path);
    } else if (path && path in blocks) {
      out.push(...blocks[path]!(indent));
      applied.add(path);
      // Skip what belonged to the old block: blank lines, comments and anything indented further.
      while (i + 1 < lines.length && (!lines[i + 1]!.trim() || lines[i + 1]!.trimStart().startsWith('#') || lines[i + 1]!.startsWith(indent + indent))) i++;
    } else {
      out.push(line);
    }
  }
  const missing = [...Object.keys(set), ...Object.keys(blocks)].filter((path) => !applied.has(path));
  if (missing.length > 0) throw new Error(`the bridge's example config has no ${missing.join(', ')} (its layout may have changed)`);
  return out.join('\n');
}
