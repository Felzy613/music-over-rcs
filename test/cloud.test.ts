import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { ensureToken, waitForHomeserver } from '../src/cloud/bootstrap.ts';
import { Pairing, selfChatRooms } from '../src/cloud/pairing.ts';
import { createCloudWeb, passwordIn, sameSecret, type CloudDeps } from '../src/cloud/web.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';
import type { Listening } from './helpers/servers.ts';

/** Starts an already-built server on a free local port. */
async function serve(server: Server): Promise<Listening> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const basic = (password: string, user = 'admin') => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('the cloud web door', () => {
  let web: Listening;
  let calls: string[];
  let canImport = true;
  const deps = (): CloudDeps => ({
    adminToken: 'open-sesame',
    pageHtml: '<!doctype html><title>setup</title>',
    status: () => ({ phase: 'setup' }),
    pair: {
      send: async (text) => void calls.push(`send:${text}`),
      log: async () => [{ at: '2026-10-13T00:00:00Z', text: 'Open the page' }],
    },
    rooms: (phone) => (phone.endsWith('5551234') ? ['!self:localhost'] : []),
    setRoom: (room) => void calls.push(`room:${room}`),
    canImport: () => canImport,
    importCatalog: (path) => {
      calls.push(`import:${existsSync(path)}`);
      return { tracks: 3 };
    },
  });
  const get = (path: string, authorization?: string) => fetch(web.url + path, { headers: authorization ? { authorization } : {} });
  const post = (path: string, body: unknown, authorization = basic('open-sesame')) =>
    fetch(web.url + path, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  before(async () => {
    web = await serve(createCloudWeb(deps()));
  });
  after(async () => web.close());
  beforeEach(() => {
    calls = [];
    canImport = true;
  });

  test('/healthz is open and says nothing about the bot', async () => {
    const res = await get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal((await fetch(web.url + '/healthz', { method: 'HEAD' })).status, 200);
  });

  test('everything else needs the password, as Basic (any user name) or Bearer', async () => {
    assert.equal((await get('/status')).status, 401);
    const wrong = await get('/status', basic('nope'));
    assert.equal(wrong.status, 401);
    assert.match(wrong.headers.get('www-authenticate') ?? '', /^Basic realm=/);
    assert.deepEqual(await (await get('/status', basic('open-sesame', 'anyone'))).json(), { phase: 'setup' });
    assert.equal((await get('/status', 'Bearer open-sesame')).status, 200);
    assert.equal((await get('/status', 'Bearer open-sesame-and-more')).status, 401);
    assert.equal((await get('/nothing-here', basic('open-sesame'))).status, 404);
  });

  test('without an ADMIN_TOKEN nothing but /healthz answers', async () => {
    const closed = await serve(createCloudWeb({ ...deps(), adminToken: undefined }));
    try {
      assert.equal((await fetch(closed.url + '/healthz')).status, 200);
      assert.equal((await fetch(closed.url + '/status', { headers: { authorization: basic('') } })).status, 503);
      assert.equal((await fetch(closed.url + '/pair')).status, 503);
    } finally {
      await closed.close();
    }
  });

  test('serves the setup page, never cached', async () => {
    const res = await get('/pair', basic('open-sesame'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /setup/);
  });

  test('pairing: sends what was typed or pasted, shows what the bridge said, and refuses empty or huge input', async () => {
    assert.equal((await post('/pair/send', { text: 'login google' })).status, 200);
    assert.deepEqual(calls, ['send:login google']);
    assert.deepEqual(await (await get('/pair/log', basic('open-sesame'))).json(), { lines: [{ at: '2026-10-13T00:00:00Z', text: 'Open the page' }] });
    assert.equal((await post('/pair/send', { text: '  ' })).status, 400);
    assert.equal((await post('/pair/send', { text: 'x'.repeat(20_001) })).status, 413);
    assert.equal((await post('/pair/send', 'not json')).status, 400);
    assert.equal((await post('/pair/send', { text: 'login google' }, basic('wrong'))).status, 401);
    assert.deepEqual(calls, ['send:login google'], 'a wrong password sends nothing');
  });

  test('finds the chat by phone number and only accepts something shaped like a room id', async () => {
    assert.deepEqual(await (await get('/setup/rooms?phone=555-0000', basic('open-sesame'))).json(), { rooms: [] }, 'a number with no chat yet is an empty list, not an error');
    assert.deepEqual(await (await get('/setup/rooms?phone=555-555-1234', basic('open-sesame'))).json(), { rooms: ['!self:localhost'] });
    assert.equal((await get('/setup/rooms?phone=12', basic('open-sesame'))).status, 400);
    assert.equal((await post('/setup/room', { room: '!self:localhost' })).status, 200);
    for (const room of ['', 'self', '!no colon', '!a:b c', 5, undefined]) assert.equal((await post('/setup/room', { room })).status, 400, `room ${String(room)}`);
    assert.deepEqual(calls, ['room:!self:localhost']);
  });

  test('a catalog upload must be a SQLite file, is read and then deleted, and can be switched off', async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('mors-import-')).length;
    const database = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]);
    const ok = await fetch(web.url + '/admin/import-catalog', { method: 'POST', headers: { authorization: basic('open-sesame') }, body: database });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, imported: { tracks: 3 } });
    assert.deepEqual(calls, ['import:true']);

    const notDb = await fetch(web.url + '/admin/import-catalog', { method: 'POST', headers: { authorization: basic('open-sesame') }, body: 'hello' });
    assert.equal(notDb.status, 400);
    canImport = false;
    const off = await fetch(web.url + '/admin/import-catalog', { method: 'POST', headers: { authorization: basic('open-sesame') }, body: database });
    assert.equal(off.status, 403);
    assert.deepEqual(calls, ['import:true'], 'nothing was imported by the refused ones');
    assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith('mors-import-')).length, before, 'no upload is left on disk');
  });

  test('OneDrive routes: a status, and starting a sign-in; both need the password; a host without OneDrive says so', async () => {
    const withDrive = await serve(
      createCloudWeb({
        ...deps(),
        oneDrive: { status: () => ({ connected: false, login: { state: 'idle' } }), start: async () => ({ state: 'pending', userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin' }) },
      }),
    );
    try {
      const authorized = { authorization: basic('open-sesame') };
      assert.deepEqual(await (await fetch(withDrive.url + '/onedrive/status', { headers: authorized })).json(), { connected: false, login: { state: 'idle' } });
      assert.equal((await fetch(withDrive.url + '/onedrive/status')).status, 401);
      const started = await fetch(withDrive.url + '/onedrive/start', { method: 'POST', headers: authorized });
      assert.equal(((await started.json()) as { userCode: string }).userCode, 'ABCD-EFGH');
      assert.equal((await fetch(withDrive.url + '/onedrive/start', { method: 'POST' })).status, 401);
      assert.equal((await fetch(withDrive.url + '/onedrive/start', { headers: authorized })).status, 404, 'starting a sign-in is a POST');
    } finally {
      await withDrive.close();
    }
    assert.equal((await get('/onedrive/status', basic('open-sesame'))).status, 404, 'no OneDrive set up on this host');
  });

  test('passwords compare by value and are read from either header', () => {
    assert.equal(sameSecret('a', 'a'), true);
    assert.equal(sameSecret('a', 'b'), false);
    assert.equal(sameSecret('', 'x'), false);
    assert.equal(passwordIn(basic('pw')), 'pw');
    assert.equal(passwordIn(basic('pa:ss')), 'pa:ss');
    assert.equal(passwordIn('Bearer tok'), 'tok');
    assert.equal(passwordIn('Digest abc'), undefined);
    assert.equal(passwordIn(undefined), undefined);
    assert.equal(passwordIn('Basic'), undefined);
  });
});

describe('starting up on a cloud host', () => {
  let mock: MockMatrix;
  before(async () => {
    mock = await startMockMatrix();
  });
  after(async () => mock.close());
  beforeEach(() => mock.reset());

  test('waits until the homeserver answers', async () => {
    let tries = 0;
    const fakeFetch = (async () => {
      tries += 1;
      if (tries < 3) throw new Error('connection refused');
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    await waitForHomeserver('http://127.0.0.1:8008', { fetch: fakeFetch, sleep: async () => {}, intervalMs: 1000 });
    assert.equal(tries, 3);
  });

  test('stops waiting when asked to', async () => {
    let stopped = false;
    const fakeFetch = (async () => {
      stopped = true;
      throw new Error('down');
    }) as typeof fetch;
    await waitForHomeserver('http://127.0.0.1:8008', { fetch: fakeFetch, sleep: async () => {}, stopped: () => stopped });
    assert.equal(stopped, true);
  });

  test('signs in once with the password and keeps the token for the next start', async () => {
    const catalog = new Catalog(':memory:');
    const first = await ensureToken({ env: { MATRIX_USER: 'me', MATRIX_PASSWORD: mock.password }, state: catalog, homeserver: mock.url });
    assert.deepEqual(first, { token: mock.token, userId: mock.userId });
    assert.equal(catalog.getState('matrix.token'), mock.token);
    // The next start needs no password.
    const second = await ensureToken({ env: {}, state: catalog, homeserver: mock.url });
    assert.equal(second.token, mock.token);
    assert.equal(mock.requests.filter((r) => r.path === '/_matrix/client/v3/login').length, 1);
  });

  test('a kept token the homeserver no longer knows is replaced by signing in again', async () => {
    const catalog = new Catalog(':memory:');
    catalog.setState('matrix.token', 'syt_stale');
    const result = await ensureToken({ env: { MATRIX_PASSWORD: mock.password }, state: catalog, homeserver: mock.url });
    assert.equal(result.token, mock.token);
    assert.equal(catalog.getState('matrix.token'), mock.token);
  });

  test('MATRIX_ACCESS_TOKEN wins, and a wrong one is an error rather than a silent sign-in', async () => {
    const catalog = new Catalog(':memory:');
    assert.equal((await ensureToken({ env: { MATRIX_ACCESS_TOKEN: mock.token }, state: catalog, homeserver: mock.url })).userId, mock.userId);
    await assert.rejects(() => ensureToken({ env: { MATRIX_ACCESS_TOKEN: 'syt_wrong', MATRIX_PASSWORD: mock.password }, state: catalog, homeserver: mock.url }), /not accepted/);
  });

  test('with no token and no password it says what to set', async () => {
    await assert.rejects(() => ensureToken({ env: {}, state: new Catalog(':memory:'), homeserver: mock.url }), /MATRIX_PASSWORD/);
  });

  test('a wrong password is the homeserver’s refusal, not a stored token', async () => {
    const catalog = new Catalog(':memory:');
    await assert.rejects(() => ensureToken({ env: { MATRIX_PASSWORD: 'nope' }, state: catalog, homeserver: mock.url }));
    assert.equal(catalog.getState('matrix.token'), undefined);
  });
});

describe('pairing through the bridge bot', () => {
  let mock: MockMatrix;
  before(async () => {
    mock = await startMockMatrix();
  });
  after(async () => mock.close());
  beforeEach(() => mock.reset());

  const pairing = (redactAfterMs = 20) =>
    new Pairing({ matrix: new MatrixClient({ token: mock.token, homeserver: mock.url }), botId: mock.botUser, userId: mock.userId, redactAfterMs });

  test('sends a command to the bot chat and shows what the bot answers', async () => {
    mock.botReplies = true;
    const p = pairing();
    await p.send('login google');
    const lines = await p.log();
    assert.equal(mock.sent.at(-1)?.content.body, 'login google');
    assert.deepEqual(lines.map((line) => line.text), ['You said: login google']);
    mock.addMessage(mock.botUser, { msgtype: 'm.notice', body: 'Waiting for the emoji' }, mock.botRoomId);
    assert.deepEqual((await p.log()).map((line) => line.text), ['You said: login google', 'Waiting for the emoji'], 'new lines are added, old ones kept');
  });

  test('a pasted multi-line request goes as one message and is deleted from the chat soon after', async () => {
    const p = pairing(20);
    await p.send("curl 'https://messages.google.com/web/config' \\\n  -H 'cookie: SID=abc; SAPISID=def' \\\n  -H 'x: y'");
    const sent = mock.sent.at(-1)!;
    assert.match(String(sent.content.body), /^curl 'https:\/\/messages\.google\.com\/web\/config' -H 'cookie: SID=abc; SAPISID=def' -H 'x: y'$/);
    assert.equal(mock.sent.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(mock.redactions, [sent.eventId]);
  });

  test('a short command is left in the chat', async () => {
    const p = pairing(10);
    await p.send('help');
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(mock.redactions, []);
  });

  test('what was said before the page opened is not shown', async () => {
    mock.addMessage(mock.botUser, { msgtype: 'm.notice', body: 'an old notice' }, mock.botRoomId);
    const p = pairing();
    assert.deepEqual(await p.log(), []);
  });
});

describe('finding the self-chat in the bridge database', () => {
  test('lists the rooms of the chat with a phone number, by its last digits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      const path = join(dir, 'bridge.db');
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE portal (id TEXT, mxid TEXT); CREATE TABLE gmessages_direct_conversation (portal_id TEXT, phone_number TEXT)');
      db.exec("INSERT INTO portal VALUES ('p1', '!mine:localhost'), ('p2', '!other:localhost'), ('p3', NULL)");
      db.exec("INSERT INTO gmessages_direct_conversation VALUES ('p1', '+1 (555) 123-4567'), ('p2', '+15559998888'), ('p3', '+15551234567')");
      db.close();
      assert.deepEqual(selfChatRooms(path, '5551234567'), ['!mine:localhost']);
      assert.deepEqual(selfChatRooms(path, '+1 555 123 4567'), ['!mine:localhost']);
      assert.deepEqual(selfChatRooms(path, '5550000000'), []);
      assert.deepEqual(selfChatRooms(path, '123'), [], 'too short to be a number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a bridge that has not made its database yet is an error the page can show', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      assert.throws(() => selfChatRooms(join(dir, 'missing.db'), '5551234567'));
      writeFileSync(join(dir, 'empty.db'), '');
      assert.throws(() => selfChatRooms(join(dir, 'empty.db'), '5551234567'), /no such table/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
