import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AdminConsole, type ConnectDeps } from '../src/admin/console.ts';
import { Catalog } from '../src/catalog.ts';
import { createCloudWeb } from '../src/cloud/web.ts';

// The console's Connect page: linking Google Messages to the bridge, finding the "message yourself" chat, OneDrive's sign-in and a test
// alert, which used to be the standalone /pair page. The routes hand the work to the host (ConnectDeps); these tests stand in for it.

const TOKEN = 'connect-test-token-5521';
const basic = `Basic ${Buffer.from(`owner:${TOKEN}`).toString('base64')}`;

async function serve(server: Server): Promise<{ url: string; close(): Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

describe('the Connect page’s routes', () => {
  let catalog: Catalog;
  let admin: AdminConsole;
  let door: { url: string; close(): Promise<void> };
  let sent: string[];
  let roomsAsked: Array<string | undefined>;
  let chosen: string[];
  let logs: string[];
  let alerts: number;
  let pairLines: Array<{ at: string; text: string }>;
  let failPair: string | undefined;

  const connect = (extra: Partial<ConnectDeps> = {}): ConnectDeps => ({
    state: async () => ({ phase: 'setup', botEnabled: true, room: null, roomGone: null, bridge: { state: undefined, error: 'no Google Messages login yet' }, problems: [] }),
    pair: {
      send: async (text) => {
        if (failPair) throw new Error(failPair);
        sent.push(text);
      },
      log: async () => pairLines,
    },
    rooms: (phone) => {
      roomsAsked.push(phone);
      return phone === '15551234567' || phone === undefined ? ['!selfchat:localhost'] : [];
    },
    setRoom: (room) => void chosen.push(room),
    knownPhone: () => '5551234567',
    oneDrive: { status: () => ({ connected: false, login: { state: 'none' } }), start: async () => ({ state: 'pending', userCode: 'ABCD1234', verificationUri: 'https://microsoft.com/devicelogin' }) },
    testAlert: async () => void (alerts += 1),
    ...extra,
  });

  const make = async (deps: Partial<ConnectDeps> | null = {}) => {
    catalog = new Catalog(':memory:');
    sent = [];
    roomsAsked = [];
    chosen = [];
    logs = [];
    alerts = 0;
    pairLines = [];
    failPair = undefined;
    admin = new AdminConsole();
    admin.provide({ catalog, env: { ADMIN_TOKEN: TOKEN }, log: (line) => logs.push(line), ...(deps === null ? {} : { connect: connect(deps) }) });
    door = await serve(createCloudWeb({ adminToken: TOKEN, admin, status: () => ({}), pair: { send: async () => {}, log: async () => [] }, rooms: () => [], setRoom: () => {}, canImport: () => false, importCatalog: () => ({}) }));
  };
  beforeEach(async () => make());
  afterEach(async () => {
    await door.close();
    catalog.close();
  });

  const get = (path: string) => fetch(`${door.url}/admin/api/${path}`, { headers: { authorization: basic } });
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(`${door.url}/admin/api/${path}`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/json', 'x-admin-console': '1', ...headers }, body: JSON.stringify(body) });
  const json = async (res: Response) => (await res.json()) as any;

  test('says what is wrong before the host has provided it, and wants the password and the header like everything else', async () => {
    await door.close();
    catalog.close();
    await make(null);
    const res = await get('connect');
    assert.equal(res.status, 503);
    assert.match((await json(res)).error, /still starting/);
    assert.equal((await post('connect/start')).status, 503);
    await door.close();
    catalog.close();
    await make();
    assert.equal((await fetch(`${door.url}/admin/api/connect`)).status, 401);
    assert.equal((await fetch(`${door.url}/admin/api/connect/start`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: '{}' })).status, 403, 'no console header');
    assert.equal((await post('connect/start', {}, { origin: 'https://evil.example' })).status, 403);
    assert.deepEqual(sent, []);
  });

  test('shows where the setup stands, the number the chat was found under, and whether OneDrive and alerts are there', async () => {
    const d = await json(await get('connect'));
    assert.equal(d.state.phase, 'setup');
    assert.equal(d.state.bridge.error, 'no Google Messages login yet');
    assert.equal(d.phone, '5551234567');
    assert.deepEqual([d.oneDrive.connected, d.alerts], [false, true]);
    await door.close();
    catalog.close();
    await make({ oneDrive: undefined, testAlert: undefined, knownPhone: () => undefined });
    const bare = await json(await get('connect'));
    assert.deepEqual([bare.oneDrive, bare.alerts, bare.phone], [null, false, null]);
  });

  test('shows what the bridge’s bot has said, the newest sixty, and says so when it is not reachable yet', async () => {
    pairLines = Array.from({ length: 80 }, (_, i) => ({ at: '2026-11-08T12:00:00Z', text: `line ${i}` }));
    const d = await json(await get('connect/log'));
    assert.equal(d.lines.length, 60);
    assert.equal(d.lines.at(-1).text, 'line 79');
    await door.close();
    catalog.close();
    await make({ pair: { send: async () => {}, log: async () => { throw new Error('the homeserver is not ready yet'); } } });
    const down = await json(await get('connect/log'));
    assert.deepEqual([down.lines, down.error], [[], 'the homeserver is not ready yet']);
  });

  test('starts the Google Messages login by sending the bridge "login google", and records that', async () => {
    const res = await post('connect/start');
    assert.equal(res.status, 200);
    assert.deepEqual(sent, ['login google']);
    assert.deepEqual(admin.audit.list().map((e) => e.what), ['started the Google Messages login']);
    failPair = 'The homeserver is not ready yet; try again in a minute.';
    const down = await post('connect/start');
    assert.equal(down.status, 503);
    assert.match((await json(down)).error, /not ready yet/);
  });

  test('sends the pasted request to the bridge as it is, and never keeps, logs or answers with it', async () => {
    const secret = "curl 'https://messages.google.com/web/config' -H 'cookie: SID=supersecretcookievalue123; HSID=anothersecret456'\n  -H 'x-goog-api-key: AIzaSyFakeKeyForTheTest0000000000000'";
    const res = await post('connect/send', { text: secret });
    assert.equal(res.status, 200);
    assert.deepEqual(sent, [secret], 'the bridge gets it exactly as pasted');
    const everything = JSON.stringify(await res.clone().json()) + JSON.stringify(admin.audit.list()) + logs.join('\n') + (catalog.getState('admin.audit') ?? '');
    for (const leak of ['supersecretcookievalue123', 'anothersecret456', 'AIzaSyFake']) assert.ok(!everything.includes(leak), `${leak} must not be kept or logged`);
    assert.deepEqual(admin.audit.list().map((e) => [e.what, e.detail]), [['sent a pasted request to the bridge', `${secret.length} characters`]]);
  });

  test('refuses an empty paste and one too long to be a single request, and says so when the bridge cannot be reached', async () => {
    assert.equal((await post('connect/send', { text: '   ' })).status, 400);
    assert.equal((await post('connect/send', {})).status, 400);
    assert.equal((await post('connect/send', { text: 42 })).status, 400);
    assert.equal((await post('connect/send', { text: 'x'.repeat(20_001) })).status, 413);
    assert.deepEqual(sent, []);
    failPair = 'the bridge is not answering';
    assert.equal((await post('connect/send', { text: 'curl x' })).status, 503);
    assert.equal(admin.audit.list().length, 0, 'nothing sent, nothing recorded');
  });

  test('finds the chat: by the phone’s own numbers with no number given, or by a number written any way', async () => {
    assert.deepEqual((await json(await post('connect/rooms', {}))).rooms, ['!selfchat:localhost']);
    assert.deepEqual((await json(await post('connect/rooms', { phone: ' +1 (555) 123-4567 ' }))).rooms, ['!selfchat:localhost']);
    assert.deepEqual((await json(await post('connect/rooms', { phone: '5559998888' }))).rooms, []);
    assert.deepEqual(roomsAsked, [undefined, '15551234567', '5559998888']);
    const short = await post('connect/rooms', { phone: '12345' });
    assert.equal(short.status, 400);
    assert.match((await json(short)).error, /too short/);
    assert.equal(roomsAsked.length, 3);
  });

  test('chooses the chat the bot answers in, only an id that looks like one', async () => {
    for (const bad of ['', 'abc', '!nocolon', '!has space:server', '#alias:server', 42, undefined]) assert.equal((await post('connect/room', { room: bad })).status, 400, String(bad));
    assert.deepEqual(chosen, []);
    const done = await post('connect/room', { room: '!UPSiTkMHvYLPqbpIWT:localhost' });
    assert.equal(done.status, 200);
    assert.deepEqual(chosen, ['!UPSiTkMHvYLPqbpIWT:localhost']);
    assert.deepEqual(admin.audit.list().map((e) => [e.what, e.detail]), [['chose the chat the bot answers in', '!UPSiTkMHvYLPqbpIWT:localhost']]);
  });

  test('starts the OneDrive sign-in and hands back the code, or says it is not set up; leaves a test alert, or says it cannot', async () => {
    const started = await json(await post('connect/onedrive/start'));
    assert.deepEqual([started.login.state, started.login.userCode], ['pending', 'ABCD1234']);
    const alert = await json(await post('connect/test-alert'));
    assert.match(alert.message, /Worker mails it/);
    assert.equal(alerts, 1);
    assert.deepEqual(admin.audit.list().map((e) => e.what), ['left a test alert', 'started the OneDrive sign-in']);
    await door.close();
    catalog.close();
    await make({ oneDrive: undefined, testAlert: undefined });
    assert.equal((await post('connect/onedrive/start')).status, 404);
    assert.equal((await post('connect/test-alert')).status, 404);
  });

  test('the old addresses lead to the console: /pair to its Connect page and / to its front page', async () => {
    const pair = await fetch(`${door.url}/pair`, { headers: { authorization: basic }, redirect: 'manual' });
    assert.equal(pair.status, 302);
    assert.equal(pair.headers.get('location'), '/admin/#connect');
    const root = await fetch(`${door.url}/`, { headers: { authorization: basic }, redirect: 'manual' });
    assert.equal(root.headers.get('location'), '/admin/');
    assert.equal((await fetch(`${door.url}/pair`, { redirect: 'manual' })).status, 401, 'still behind the password');
    // The routes scripts use are still there.
    assert.equal((await fetch(`${door.url}/pair/log`, { headers: { authorization: basic } })).status, 200);
  });

  test('without a console the old page is still what / and /pair serve, and with nothing to serve they say not found', async () => {
    const page = await serve(createCloudWeb({ adminToken: TOKEN, pageHtml: '<!doctype html><title>old</title>', status: () => ({}), pair: { send: async () => {}, log: async () => [] }, rooms: () => [], setRoom: () => {}, canImport: () => false, importCatalog: () => ({}) }));
    const none = await serve(createCloudWeb({ adminToken: TOKEN, status: () => ({}), pair: { send: async () => {}, log: async () => [] }, rooms: () => [], setRoom: () => {}, canImport: () => false, importCatalog: () => ({}) }));
    try {
      assert.match(await (await fetch(`${page.url}/pair`, { headers: { authorization: basic } })).text(), /<title>old<\/title>/);
      assert.equal((await fetch(`${none.url}/pair`, { headers: { authorization: basic } })).status, 404);
    } finally {
      await page.close();
      await none.close();
    }
  });

  test('the page’s only outside links are the two it means to have: Google Messages for web, and the address Microsoft gives for its sign-in code', () => {
    const script = readFileSync(new URL('../src/admin/site/app.js', import.meta.url), 'utf8');
    const links = script.split('\n').filter((line) => line.includes('external: true'));
    assert.equal(links.length, 2, links.join('\n'));
    for (const line of links) assert.ok(line.includes("href: 'https://messages.google.com/web'") || line.includes('href: safe'), line);
    assert.match(script, /const SAFE_HOSTS = \['messages\.google\.com', 'microsoft\.com', 'microsoftonline\.com', 'live\.com', 'aka\.ms'\]/);
  });
});
