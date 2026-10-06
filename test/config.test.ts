import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadBeeperConfig, loadConfig, loadMatrixConfig, parseArchiveDir } from '../src/config.ts';

const valid = {
  RBM_AGENT_ID: 'bot@rbm.goog',
  RBM_CLIENT_TOKEN: 'token',
  GOOGLE_APPLICATION_CREDENTIALS: 'keys/key.json',
};

describe('loadConfig', () => {
  test('applies defaults', () => {
    const config = loadConfig(valid);
    assert.equal(config.port, 8787);
    assert.equal(config.region, 'us');
    assert.equal(config.dbPath, 'data/catalog.db');
    assert.equal(config.trafficType, undefined);
    assert.equal(config.allowedSenders, undefined);
  });

  test('reads and normalises the optional settings', () => {
    const config = loadConfig({
      ...valid,
      RBM_REGION: 'Europe',
      PORT: '9000',
      CATALOG_DB: 'other.db',
      RBM_MESSAGE_TRAFFIC_TYPE: 'transaction',
      ALLOWED_SENDERS: '+15551234567, +447700900123',
    });
    assert.equal(config.region, 'europe');
    assert.equal(config.port, 9000);
    assert.equal(config.dbPath, 'other.db');
    assert.equal(config.trafficType, 'TRANSACTION');
    assert.deepEqual([...(config.allowedSenders ?? [])], ['+15551234567', '+447700900123']);
  });

  test('reports every problem at once', () => {
    assert.throws(
      () => loadConfig({ RBM_REGION: 'mars', PORT: '0', ALLOWED_SENDERS: '555', RBM_MESSAGE_TRAFFIC_TYPE: 'SPAM' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        for (const needle of [
          'RBM_AGENT_ID is not set',
          'RBM_CLIENT_TOKEN is not set',
          'GOOGLE_APPLICATION_CREDENTIALS is not set',
          'RBM_REGION',
          'PORT',
          'ALLOWED_SENDERS',
          'RBM_MESSAGE_TRAFFIC_TYPE',
        ]) {
          assert.ok(err.message.includes(needle), `missing "${needle}" in:\n${err.message}`);
        }
        return true;
      },
    );
  });

  test('the client token is optional for scripts that only call the API', () => {
    const { RBM_CLIENT_TOKEN: _unused, ...withoutToken } = valid;
    assert.equal(loadConfig(withoutToken, { webhook: false }).clientToken, '');
    assert.throws(() => loadConfig(withoutToken), /RBM_CLIENT_TOKEN is not set/);
  });
});

describe('loadBeeperConfig', () => {
  const beeper = { BEEPER_ACCESS_TOKEN: 'token', BEEPER_CHAT_ID: '!chat:beeper.local' };

  test('applies defaults', () => {
    assert.deepEqual(loadBeeperConfig(beeper), {
      token: 'token',
      chatID: '!chat:beeper.local',
      baseUrl: 'http://localhost:23373',
      pollMs: 1500,
      dbPath: 'data/catalog.db',
      maxDownloadMb: 100,
      digestAt: { hour: 9, minute: 0 },
      prefetchMb: Number.POSITIVE_INFINITY,
      archiveDir: undefined,
      quiet: { from: { hour: 22, minute: 0 }, to: { hour: 7, minute: 0 } },
      songGapMs: 15_000,
    });
  });

  test('reads the optional settings and trims a trailing slash from the URL', () => {
    const config = loadBeeperConfig({
      ...beeper,
      BEEPER_API_URL: 'http://127.0.0.1:9000/',
      BEEPER_POLL_MS: '3000',
      MAX_DOWNLOAD_MB: '50',
      CATALOG_DB: 'other.db',
    });
    assert.equal(config.baseUrl, 'http://127.0.0.1:9000');
    assert.equal(config.pollMs, 3000);
    assert.equal(config.maxDownloadMb, 50);
    assert.equal(config.dbPath, 'other.db');
  });

  test('reports every problem at once', () => {
    assert.throws(
      () => loadBeeperConfig({ BEEPER_API_URL: 'ftp://x', BEEPER_POLL_MS: '10', MAX_DOWNLOAD_MB: '0' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        for (const needle of [
          'BEEPER_ACCESS_TOKEN is not set',
          'BEEPER_CHAT_ID is not set',
          'BEEPER_API_URL',
          'BEEPER_POLL_MS',
          'MAX_DOWNLOAD_MB',
        ]) {
          assert.ok(err.message.includes(needle), `missing "${needle}" in:\n${err.message}`);
        }
        return true;
      },
    );
  });

  test('the daily message time and the space for songs kept ready are read and checked', () => {
    const base = { BEEPER_ACCESS_TOKEN: 'token', BEEPER_CHAT_ID: 'chat' };
    assert.deepEqual(loadBeeperConfig({ ...base, DIGEST_TIME: '7:30' }).digestAt, { hour: 7, minute: 30 });
    assert.equal(loadBeeperConfig({ ...base, DIGEST_TIME: 'off' }).digestAt, undefined);
    assert.equal(loadBeeperConfig({ ...base, PREFETCH_MB: '0' }).prefetchMb, 0);
    assert.equal(loadBeeperConfig({ ...base, PREFETCH_MB: 'off' }).prefetchMb, 0);
    assert.equal(loadBeeperConfig({ ...base, PREFETCH_MB: 'unlimited' }).prefetchMb, Number.POSITIVE_INFINITY);
    assert.equal(loadBeeperConfig({ ...base, PREFETCH_MB: '30000' }).prefetchMb, 30_000, 'a limit, if you want one');
    assert.throws(() => loadBeeperConfig({ ...base, DIGEST_TIME: '25:00' }), /DIGEST_TIME must look like 09:00/);
    assert.throws(() => loadBeeperConfig({ ...base, DIGEST_TIME: 'morning' }), /DIGEST_TIME/);
    assert.throws(() => loadBeeperConfig({ ...base, PREFETCH_MB: '-5' }), /PREFETCH_MB must be "unlimited" \(the default\), a number of MB, or 0 for none/);
    assert.deepEqual(loadBeeperConfig({ ...base, QUIET_HOURS: '23:30-6:15' }).quiet, { from: { hour: 23, minute: 30 }, to: { hour: 6, minute: 15 } });
    assert.equal(loadBeeperConfig({ ...base, QUIET_HOURS: 'off' }).quiet, undefined);
    assert.throws(() => loadBeeperConfig({ ...base, QUIET_HOURS: 'nights' }), /QUIET_HOURS must look like 22:00-07:00/);
    assert.equal(loadBeeperConfig({ ...base, SONGS_ARCHIVE_DIR: '/Volumes/Music Drive/Music/Music over RCS/' }).archiveDir, '/Volumes/Music Drive/Music/Music over RCS');
    assert.equal(parseArchiveDir('~/Music/Kept', '/Users/someone'), '/Users/someone/Music/Kept');
    assert.equal(parseArchiveDir('  '), undefined);
    assert.throws(() => loadBeeperConfig({ ...base, SONGS_ARCHIVE_DIR: 'Music/Kept' }), /SONGS_ARCHIVE_DIR must be a full path/);
    assert.equal(loadBeeperConfig({ ...base, SONG_GAP_SECONDS: '20' }).songGapMs, 20_000);
    assert.equal(loadBeeperConfig({ ...base, SONG_GAP_SECONDS: 'off' }).songGapMs, 0);
    assert.equal(loadBeeperConfig({ ...base, SONG_GAP_SECONDS: '0' }).songGapMs, 0);
    assert.throws(() => loadBeeperConfig({ ...base, SONG_GAP_SECONDS: 'soon' }), /SONG_GAP_SECONDS must be a number of seconds from 0 to 300/);
    assert.throws(() => loadBeeperConfig({ ...base, SONG_GAP_SECONDS: '900' }), /SONG_GAP_SECONDS/);
  });

  test('the chat is optional for the script that lists chats', () => {
    assert.equal(loadBeeperConfig({ BEEPER_ACCESS_TOKEN: 'token' }, { chat: false }).chatID, '');
    assert.throws(() => loadBeeperConfig({ BEEPER_ACCESS_TOKEN: 'token' }), /BEEPER_CHAT_ID is not set/);
  });
});

describe('loadMatrixConfig', () => {
  const matrix = { MATRIX_ACCESS_TOKEN: 'token', MATRIX_ROOM_ID: '!room:localhost' };

  test('applies defaults', () => {
    assert.deepEqual(loadMatrixConfig(matrix), {
      homeserver: 'http://127.0.0.1:8008',
      token: 'token',
      roomID: '!room:localhost',
      bridgeUrl: 'http://127.0.0.1:29336',
      pollMs: 1500,
      dbPath: 'data/catalog.db',
      maxDownloadMb: 100,
      digestAt: { hour: 9, minute: 0 },
      prefetchMb: Number.POSITIVE_INFINITY,
      archiveDir: undefined,
      quiet: { from: { hour: 22, minute: 0 }, to: { hour: 7, minute: 0 } },
      songGapMs: 15_000,
    });
  });

  test('reads the optional settings and trims a trailing slash from the URL', () => {
    const config = loadMatrixConfig({
      ...matrix,
      MATRIX_HOMESERVER: 'http://localhost:9008/',
      MATRIX_POLL_MS: '2500',
      MAX_DOWNLOAD_MB: '25',
      CATALOG_DB: 'other.db',
    });
    assert.equal(config.homeserver, 'http://localhost:9008');
    assert.equal(config.pollMs, 2500);
    assert.equal(config.maxDownloadMb, 25);
    assert.equal(config.dbPath, 'other.db');
  });

  test('reports every problem at once, with the next step', () => {
    assert.throws(
      () => loadMatrixConfig({ MATRIX_HOMESERVER: 'nope', MATRIX_POLL_MS: '5' }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        for (const needle of [
          'MATRIX_ACCESS_TOKEN is not set (run `npm run matrix-login`',
          'MATRIX_ROOM_ID is not set (run `npm run matrix-rooms`',
          'MATRIX_HOMESERVER',
          'MATRIX_POLL_MS',
        ]) {
          assert.ok(err.message.includes(needle), `missing "${needle}" in:\n${err.message}`);
        }
        return true;
      },
    );
  });

  test('the room is optional for scripts that do not watch one', () => {
    assert.equal(loadMatrixConfig({ MATRIX_ACCESS_TOKEN: 'token' }, { room: false }).roomID, '');
    assert.throws(() => loadMatrixConfig({ MATRIX_ACCESS_TOKEN: 'token' }), /MATRIX_ROOM_ID is not set/);
  });
});
