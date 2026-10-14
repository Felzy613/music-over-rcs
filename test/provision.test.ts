import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bridgeRegistration, derive, patchBridgeConfig, pathsFor, synapseConfig, SYNAPSE_LOG_CONFIG, type BridgeOptions } from '../src/cloud/provision.ts';

/** The shape of the bridge's generated example config (`mautrix-gmessages -e`), with made-up values. */
const EXAMPLE = `# Network-specific config options
network:
    # Displayname template
    displayname_template: "{{or .FullName .PhoneNumber}}"
    # How many chats to sync.
    initial_chat_sync_count: 25
    ping_interval: 15m

# Config options that affect the central bridge module.
bridge:
    command_prefix: '!gm'
    cleanup_on_logout:
        enabled: false
    relay:
        enabled: false
    # Permissions for using the bridge.
    #     user - Access to using the bridge
    #     admin - Full access
    permissions:
        "*": relay
        "example.com": user
        "@admin:example.com": admin

# Config for the bridge's database.
database:
    # The database type.
    type: "postgres"
    uri: postgres://user:password@host/database?sslmode=disable
    max_open_conns: 5

# Homeserver details.
homeserver:
    address: https://example.com
    domain: example.com
    software: standard

# Application service host/registration related details.
appservice:
    address: http://localhost:29336
    public_address: https://bridge.example.com
    hostname: 0.0.0.0
    port: 29336
    id: gmessages
    as_token: "This value is generated when generating the registration"
    hs_token: "This value is generated when generating the registration"

provisioning:
    shared_secret: generate
    allow_matrix_auth: false
    debug_endpoints: false

backfill:
    # Whether to do backfilling at all.
    enabled: true
    max_initial_messages: 50
    threads:
        max_initial_messages: 50
    queue:
        enabled: false

encryption:
    allow: false
    default: false

logging:
    min_level: debug
    writers:
        - type: stdout
          format: pretty-colored
        - type: file
          format: json
          filename: ./logs/bridge.log
`;

const OPTIONS: BridgeOptions = {
  domain: 'localhost',
  homeserverUrl: 'http://127.0.0.1:8008',
  appserviceUrl: 'http://127.0.0.1:29336',
  port: 29336,
  master: 'a-master-secret-for-tests',
  user: 'me',
  databaseUri: 'file:/data/gmessages/mautrix-gmessages.db?_txlock=immediate',
};

describe('derived secrets', () => {
  test('are the same every time for one master secret, differ by purpose and by master, and are 64 hex characters', () => {
    assert.equal(derive('m', 'a'), derive('m', 'a'));
    assert.notEqual(derive('m', 'a'), derive('m', 'b'));
    assert.notEqual(derive('m', 'a'), derive('n', 'a'));
    assert.match(derive('m', 'a'), /^[0-9a-f]{64}$/);
  });
});

describe('patching the bridge config', () => {
  const patched = patchBridgeConfig(EXAMPLE, OPTIONS);
  const line = (text: string) => patched.split('\n').find((candidate) => candidate.trim().startsWith(text));

  test('points the bridge at the local homeserver and itself, on this machine only', () => {
    assert.equal(line('address: "http://127.0.0.1:8008"'), '    address: "http://127.0.0.1:8008"');
    assert.ok(patched.includes('    domain: "localhost"'));
    assert.ok(patched.includes('    address: "http://127.0.0.1:29336"'));
    assert.ok(patched.includes('    hostname: "127.0.0.1"'));
    assert.ok(patched.includes('    port: 29336'));
    assert.ok(!patched.includes('0.0.0.0'));
  });

  test('uses SQLite on the data disk and the derived tokens, which match the registration', () => {
    assert.ok(patched.includes('    type: "sqlite3-fk-wal"'));
    assert.ok(patched.includes('    uri: "file:/data/gmessages/mautrix-gmessages.db?_txlock=immediate"'));
    assert.ok(patched.includes(`    as_token: "${derive(OPTIONS.master, 'bridge-as')}"`));
    assert.ok(patched.includes(`    hs_token: "${derive(OPTIONS.master, 'bridge-hs')}"`));
    const registration = bridgeRegistration(OPTIONS);
    assert.ok(registration.includes(`as_token: "${derive(OPTIONS.master, 'bridge-as')}"`));
    assert.ok(registration.includes(`hs_token: "${derive(OPTIONS.master, 'bridge-hs')}"`));
  });

  test('turns on Matrix-token auth for the provisioning API, off backfill, and the initial chats down to none', () => {
    assert.ok(patched.includes('    allow_matrix_auth: true'));
    assert.ok(patched.includes('    initial_chat_sync_count: 0'));
    assert.match(patched, /backfill:\n {4}# Whether to do backfilling at all\.\n {4}enabled: false/);
    assert.ok(patched.includes('        max_initial_messages: 50'), 'a nested key of the same name is left alone');
    assert.ok(patched.includes('        enabled: false'), 'nested enabled keys are left alone');
  });

  test('lets only the bot’s account administer the bridge, and logs to the console only', () => {
    assert.match(patched, /permissions:\n {8}"@me:localhost": admin\n/);
    assert.ok(!patched.includes('"*": relay'));
    assert.ok(!patched.includes('@admin:example.com'));
    assert.match(patched, /writers:\n {8}- type: stdout\n {10}format: pretty\n?$/);
    assert.ok(!patched.includes('bridge.log'));
    assert.ok(patched.includes('    min_level: "info"'));
  });

  test('keeps the rest, comments included', () => {
    assert.ok(patched.includes('# Config options that affect the central bridge module.'));
    assert.ok(patched.includes("    command_prefix: '!gm'"));
    assert.ok(patched.includes('    public_address: https://bridge.example.com'));
    assert.ok(patched.includes('    shared_secret: generate'));
    assert.ok(patched.includes('    ping_interval: 15m'));
  });

  test('is stable: patching its own output changes nothing', () => {
    assert.equal(patchBridgeConfig(patched, OPTIONS), patched);
  });

  test('says which keys are missing when the example config has a different layout', () => {
    assert.throws(() => patchBridgeConfig(EXAMPLE.replace('allow_matrix_auth', 'allow_matrix_authentication'), OPTIONS), /no provisioning\.allow_matrix_auth/);
    assert.throws(() => patchBridgeConfig('homeserver:\n    address: x\n', OPTIONS), /no .*database\.type/);
  });
});

describe('the registration', () => {
  test('claims the bot and its ghost users on this homeserver, exclusively, and escapes the domain', () => {
    const registration = bridgeRegistration({ ...OPTIONS, domain: 'my.server' });
    assert.ok(registration.includes('"^@gmessagesbot:my\\\\.server$"'));
    assert.ok(registration.includes('"^@gmessages_.*:my\\\\.server$"'));
    assert.equal(registration.match(/exclusive: true/g)?.length, 2);
    assert.ok(registration.includes('url: "http://127.0.0.1:29336"'));
    assert.match(registration, /sender_localpart: "[0-9a-f]{32}"/);
  });
});

describe('the homeserver config', () => {
  const paths = pathsFor('/data');
  const text = synapseConfig({ serverName: 'localhost', paths, master: OPTIONS.master });

  test('listens on this machine only, does not federate, allows no sign-ups, and loads the bridge’s registration', () => {
    assert.ok(text.includes("bind_addresses: ['127.0.0.1']"));
    assert.ok(!text.includes('federation]') && text.includes('names: [client]'));
    assert.ok(text.includes('federation_domain_whitelist: []'));
    assert.ok(text.includes('enable_registration: false'));
    assert.ok(text.includes('"/data/gmessages/registration.yaml"'));
  });

  test('keeps everything on the data disk and stays small', () => {
    assert.ok(text.includes('database: "/data/synapse/homeserver.db"'));
    assert.ok(text.includes('media_store_path: "/data/synapse/media_store"'));
    assert.ok(text.includes('local_media_lifetime: 1d'));
    assert.ok(text.includes('global_factor: 0.25'));
    assert.match(text, /presence:\n {2}enabled: false/);
  });

  test('has secrets derived from the master, the same each time', () => {
    assert.equal(text, synapseConfig({ serverName: 'localhost', paths, master: OPTIONS.master }));
    assert.notEqual(text, synapseConfig({ serverName: 'localhost', paths, master: 'another master' }));
    assert.ok(text.includes(derive(OPTIONS.master, 'synapse-registration')));
  });

  test('logs only warnings to the console', () => {
    assert.match(SYNAPSE_LOG_CONFIG, /root:\n {2}level: WARNING/);
  });
});
