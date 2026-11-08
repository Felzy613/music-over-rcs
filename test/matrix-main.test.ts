import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { STARTUP_TEXT } from '../src/startup-message.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';
import { listen, type Listening } from './helpers/servers.ts';

// `npm run matrix` (src/matrix-main.ts) is now only an entry point over src/host.ts: one host and the owner's one chat, read from
// MATRIX_ACCESS_TOKEN and MATRIX_ROOM_ID, which is also how the cloud host's cloud-main.ts starts it (it sets them and imports the file).
// This runs the file for real, as a process, against a mock homeserver and a mock bridge, from a folder with no .env.

const ENTRY = fileURLToPath(new URL('../src/matrix-main.ts', import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(ready: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

describe('npm run matrix (src/matrix-main.ts)', () => {
  let mock: MockMatrix;
  let bridge: Listening;
  let folder: string;
  const running: ChildProcess[] = [];
  const folders: string[] = [];

  before(async () => {
    mock = await startMockMatrix();
    // The bridge's provisioning API with no Google login yet: nothing to restart, nothing to wait for, and no look at the internet.
    bridge = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ logins: [] }));
    });
  });
  after(async () => {
    for (const child of running) child.kill('SIGKILL');
    for (const one of folders) rmSync(one, { recursive: true, force: true });
    await mock.close();
    await bridge.close();
  });
  beforeEach(() => {
    mock.reset();
    folder = mkdtempSync(join(tmpdir(), 'matrix-main-'));
    folders.push(folder);
  });

  /** Runs the entry with exactly this environment (nothing of this process's, so no real service is reached). */
  function run(env: Record<string, string>) {
    const output = { out: '', err: '' };
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], {
      cwd: folder,
      env: { PATH: process.env.PATH ?? '', CATALOG_DB: join(folder, 'catalog.db'), ...env },
    });
    running.push(child);
    child.stdout.on('data', (chunk: Buffer) => (output.out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output.err += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    return { child, output, exited };
  }

  const working = (): Record<string, string> => ({
    MATRIX_HOMESERVER: mock.url,
    MATRIX_ACCESS_TOKEN: mock.token,
    MATRIX_ROOM_ID: mock.roomId,
    BRIDGE_URL: bridge.url,
    BRIDGE_AUTO_RESTART: 'off',
    YOUTUBE_MUSIC: 'off',
    MUSIC_TABLE: 'off',
    ZEMER_RELEASES: 'off',
    PREFETCH_MB: 'off',
    SONG_GAP_SECONDS: 'off',
    MATRIX_SYNC_WAIT_MS: '0',
    MATRIX_POLL_MS: '500',
    STARTUP_MESSAGE: 'once',
  });

  test('signs in, joins the chat, says hello once, answers, and shuts down on SIGTERM', async () => {
    const { child, output, exited } = run(working());
    await until(() => /signed in as @me:localhost, watching room !portal:localhost, 0 tracks in .*catalog\.db, Zemer off, music-table\.com off, no songs kept ready\. Text "search" and a song name in that chat\./.test(output.out), `the start-up line in ${output.out}${output.err}`);
    assert.ok(mock.joinedViaApi.includes(mock.roomId), 'it joined the room');
    await until(() => mock.sent.some((event) => String(event.content.body).includes(STARTUP_TEXT)), 'the hello');
    mock.addMessage(mock.ghost, { msgtype: 'm.text', body: 'help' });
    await until(() => mock.sent.some((event) => /Start each message with a command/.test(String(event.content.body))), 'the help');
    assert.doesNotMatch(output.out, /\[owner\]/, 'the owner’s lines carry no tag');
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    assert.match(output.out, /shutting down/);
  });

  test('keeps the owner’s state under the old keys, in the catalog file', async () => {
    const { child, exited } = run(working());
    await until(() => mock.sent.some((event) => String(event.content.body).includes(STARTUP_TEXT)), 'the hello');
    child.kill('SIGTERM');
    assert.equal(await exited, 0);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(folder, 'catalog.db'), { readOnly: true });
    const keys = (db.prepare('SELECT key FROM state').all() as Array<{ key: string }>).map((row) => row.key);
    db.close();
    assert.ok(keys.includes('hello.sent'), keys.join(', '));
    assert.ok(keys.includes('chat.resume'), keys.join(', '));
    assert.equal(keys.filter((key) => key.endsWith(':owner')).length, 0, 'no suffixed key for the owner');
  });

  test('without its settings it says what is missing and exits', async () => {
    const { output, exited } = run({ BRIDGE_AUTO_RESTART: 'off' });
    assert.equal(await exited, 1);
    assert.match(output.err, /MATRIX_ACCESS_TOKEN is not set/);
    assert.match(output.err, /MATRIX_ROOM_ID is not set/);
  });

  test('a token the homeserver refuses stops it with a word on what to do', async () => {
    const { output, exited } = run({ ...working(), MATRIX_ACCESS_TOKEN: 'not-the-token' });
    assert.equal(await exited, 1);
    assert.match(output.err, /rejected the access token/);
  });

  test('a room it cannot join stops it, so the host can wait for a new chat', async () => {
    mock.goneRooms.push(mock.roomId);
    const { output, exited } = run(working());
    assert.equal(await exited, 1);
    assert.ok(output.err.length > 0);
    assert.equal(mock.sent.length, 0);
  });

  test('its source is only the entry: the assembly lives in src/host.ts, and the cloud host still imports this file', () => {
    const entry = readFileSync(ENTRY, 'utf8');
    assert.match(entry, /from '\.\/host\.ts'/);
    assert.ok(entry.split('\n').length < 80, 'a thin entry');
    const cloud = readFileSync(new URL('../src/cloud-main.ts', import.meta.url), 'utf8');
    assert.match(cloud, /await import\('\.\/matrix-main\.ts'\)/);
  });
});
