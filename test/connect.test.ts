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
    const done = await post('connect/room', { room: '!selfchat:localhost' });
    assert.equal(done.status, 200);
    assert.deepEqual(chosen, ['!selfchat:localhost']);
    assert.deepEqual(admin.audit.list().map((e) => [e.what, e.detail]), [['chose the chat the bot answers in', '!selfchat:localhost']]);
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

// Other people use the bot besides the owner (PEOPLE): each links their own Google Messages through the owner's console, with their own Matrix account
// and chat. Every Connect route takes a `person`; none means the owner, exactly as before.
describe('the Connect page’s routes for the people besides the owner', () => {
  let catalog: Catalog;
  let admin: AdminConsole;
  let door: { url: string; close(): Promise<void> };
  let calls: Array<[string, ...unknown[]]>;
  let logs: string[];
  let setRoomFails: string | undefined;

  const connect = (people: Array<{ id: string }> | null): ConnectDeps => ({
    state: async (...args) => (calls.push(['state', ...args]), { phase: args[0] ? 'setup' : 'running', botEnabled: true }),
    pair: {
      send: async (...args) => void calls.push(['send', ...args]),
      log: async (...args) => (calls.push(['log', ...args]), [{ at: '2026-11-08T12:00:00Z', text: `for ${args[0] ?? 'the owner'}` }]),
    },
    rooms: (...args) => (calls.push(['rooms', ...args]), ['!selfchat:localhost']),
    setRoom: (...args) => {
      calls.push(['setRoom', ...args]);
      if (setRoomFails) throw new Error(setRoomFails);
    },
    knownPhone: (...args) => (calls.push(['knownPhone', ...args]), args[0] ? '5552220002' : '5551110001'),
    oneDrive: { status: () => ({ connected: false }), start: async () => (calls.push(['onedrive']), { state: 'pending' }) },
    testAlert: async () => void calls.push(['alert']),
    ...(people ? { people: () => people } : {}),
  });

  const make = async (people: Array<{ id: string }> | null = [{ id: 'alice' }, { id: 'bob' }]) => {
    catalog = new Catalog(':memory:');
    calls = [];
    logs = [];
    setRoomFails = undefined;
    admin = new AdminConsole();
    admin.provide({ catalog, env: { ADMIN_TOKEN: TOKEN }, log: (line) => logs.push(line), connect: connect(people) });
    door = await serve(createCloudWeb({ adminToken: TOKEN, admin, status: () => ({}), pair: { send: async () => {}, log: async () => [] }, rooms: () => [], setRoom: () => {}, canImport: () => false, importCatalog: () => ({}) }));
  };
  beforeEach(async () => make());
  afterEach(async () => {
    await door.close();
    catalog.close();
  });

  const get = (path: string) => fetch(`${door.url}/admin/api/${path}`, { headers: { authorization: basic } });
  const post = (path: string, body: unknown = {}) => fetch(`${door.url}/admin/api/${path}`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/json', 'x-admin-console': '1' }, body: JSON.stringify(body) });
  const json = async (res: Response) => (await res.json()) as any;

  test('reading with no person, or the owner, is the owner’s page as it was: nothing is asked of any person', async () => {
    const plain = await json(await get('connect'));
    assert.deepEqual(calls, [['state'], ['knownPhone']], 'called with no person at all');
    assert.deepEqual([plain.state.phase, plain.phone, plain.oneDrive.connected, plain.alerts, 'person' in plain], ['running', '5551110001', false, true, false]);
    calls = [];
    const named = await json(await get('connect?person=owner'));
    assert.deepEqual(calls, [['state'], ['knownPhone']]);
    assert.equal(named.phone, '5551110001');
    calls = [];
    await get('connect/log');
    assert.deepEqual(calls, [['log']]);
  });

  test('the page is told who else there is (so it can draw its selector whoever is selected), and only when there is anybody', async () => {
    assert.deepEqual((await json(await get('connect'))).people, ['alice', 'bob']);
    assert.deepEqual((await json(await get('connect?person=bob'))).people, ['alice', 'bob']);
    for (const none of [null, []]) {
      await door.close();
      catalog.close();
      await make(none);
      assert.equal('people' in (await json(await get('connect'))), false, 'the owner’s page on a host with nobody else is as it was');
    }
  });

  test('reading for a person is their state, their number and their log; OneDrive and the test alert are not theirs', async () => {
    const d = await json(await get('connect?person=alice'));
    assert.deepEqual(calls, [['state', 'alice'], ['knownPhone', 'alice']]);
    assert.deepEqual([d.person, d.state.phase, d.phone, d.oneDrive, d.alerts], ['alice', 'setup', '5552220002', null, false]);
    calls = [];
    const log = await json(await get('connect/log?person=bob'));
    assert.deepEqual(calls, [['log', 'bob']]);
    assert.deepEqual(log.lines.map((line: { text: string }) => line.text), ['for bob']);
  });

  test('a name nobody has is refused when reading (404) and when changing (400), and nothing is asked or sent', async () => {
    for (const path of ['connect?person=mallory', 'connect/log?person=mallory', 'connect?person=ALICE', 'connect?person=alice%20']) assert.equal((await get(path)).status, 404, path);
    for (const [path, body] of [
      ['connect/start', { person: 'mallory' }],
      ['connect/send', { person: 'mallory', text: 'curl x' }],
      ['connect/rooms', { person: 'mallory' }],
      ['connect/room', { person: 'mallory', room: '!a:localhost' }],
      ['connect/start', { person: 42 }],
      ['connect/start', { person: ['alice'] }],
    ] as Array<[string, unknown]>) {
      const res = await post(path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.match((await json(res)).error, /Nobody is called that/);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(admin.audit.list(), []);
  });

  test('starting the login for a person sends the bridge "login google" as them, and the record names them', async () => {
    assert.equal((await post('connect/start', { person: 'alice' })).status, 200);
    assert.deepEqual(calls, [['send', 'login google', 'alice']]);
    assert.deepEqual(admin.audit.list().map((e) => [e.what, e.detail]), [['started the Google Messages login', 'for alice']]);
    calls = [];
    assert.equal((await post('connect/start', { person: 'owner' })).status, 200);
    assert.equal((await post('connect/start', {})).status, 200);
    assert.deepEqual(calls, [['send', 'login google'], ['send', 'login google']], 'the owner’s call has no person in it');
    assert.deepEqual(admin.audit.list().slice(0, 2).map((e) => e.detail), [undefined, undefined], 'the owner’s records say nothing of a person (newest first)');
  });

  test('a pasted request for a person goes to their window as typed, and is never kept, logged, recorded or answered with', async () => {
    const secret = "curl 'https://messages.google.com/web/config' -H 'cookie: SID=alicesecretcookie123; HSID=alicesecret456'";
    const res = await post('connect/send', { person: 'alice', text: secret });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [['send', secret, 'alice']]);
    const everything = JSON.stringify(await res.clone().json()) + JSON.stringify(admin.audit.list()) + logs.join('\n') + (catalog.getState('admin.audit') ?? '');
    for (const leak of ['alicesecretcookie123', 'alicesecret456']) assert.ok(!everything.includes(leak), `${leak} must not be kept or logged`);
    assert.deepEqual(admin.audit.list().map((e) => [e.what, e.detail]), [['sent a pasted request to the bridge', `${secret.length} characters, for alice`]]);
    // The same limits as for the owner.
    assert.equal((await post('connect/send', { person: 'alice', text: ' ' })).status, 400);
    assert.equal((await post('connect/send', { person: 'alice', text: 'x'.repeat(20_001) })).status, 413);
    assert.equal(calls.length, 1);
  });

  test('finding and choosing a person’s chat is about their own chat, and the choice is recorded with their name', async () => {
    assert.deepEqual((await json(await post('connect/rooms', { person: 'alice', phone: '(555) 222-0002' }))).rooms, ['!selfchat:localhost']);
    assert.deepEqual(calls, [['rooms', '5552220002', 'alice']]);
    calls = [];
    await post('connect/rooms', { person: 'bob' });
    assert.deepEqual(calls, [['rooms', undefined, 'bob']]);
    calls = [];
    await post('connect/rooms', {});
    assert.deepEqual(calls, [['rooms', undefined]], 'the owner’s call has no person in it');
    calls = [];
    const done = await json(await post('connect/room', { person: 'alice', room: '!alice:localhost' }));
    assert.match(done.message, /answering alice/);
    assert.deepEqual(calls, [['setRoom', '!alice:localhost', 'alice']]);
    assert.deepEqual(admin.audit.list().map((e) => [e.what, e.detail]), [['chose the chat the bot answers in', '!alice:localhost, for alice']]);
    calls = [];
    await post('connect/room', { room: '!owner:localhost' });
    assert.deepEqual(calls, [['setRoom', '!owner:localhost']]);
    assert.equal(admin.audit.list()[0]!.detail, '!owner:localhost', 'the owner’s record is as it was (newest first)');
  });

  test('a chat the host will not take for that person (it is somebody else’s) is a conflict that says why, and is not recorded', async () => {
    setRoomFails = "That chat is the owner's, not alice's: each person's bot answers only in their own chat.";
    const res = await post('connect/room', { person: 'alice', room: '!owners:localhost' });
    assert.equal(res.status, 409);
    assert.match((await json(res)).error, /That chat is the owner's, not alice's/);
    assert.deepEqual(admin.audit.list(), []);
  });

  test('OneDrive’s sign-in and the test alert are the owner’s: asked for a person they are refused and do nothing', async () => {
    assert.equal((await post('connect/onedrive/start', { person: 'alice' })).status, 400);
    assert.equal((await post('connect/test-alert', { person: 'alice' })).status, 400);
    assert.deepEqual(calls, []);
    assert.equal((await post('connect/onedrive/start')).status, 200);
    assert.equal((await post('connect/test-alert', { person: 'owner' })).status, 200);
    assert.deepEqual(calls, [['onedrive'], ['alert']]);
  });

  test('on a host with nobody besides the owner a person is just a name nobody has', async () => {
    await door.close();
    catalog.close();
    await make(null);
    assert.equal((await get('connect?person=alice')).status, 404);
    assert.equal((await post('connect/start', { person: 'alice' })).status, 400);
    assert.deepEqual(calls, []);
    assert.equal((await get('connect')).status, 200);
    await door.close();
    catalog.close();
    await make([]);
    assert.equal((await get('connect?person=alice')).status, 404);
  });
});

describe('the older routes for scripts take the same optional person', () => {
  let door: { url: string; close(): Promise<void> };
  let calls: Array<[string, ...unknown[]]>;
  let failRoom: string | undefined;

  beforeEach(async () => {
    calls = [];
    failRoom = undefined;
    door = await serve(
      createCloudWeb({
        adminToken: TOKEN,
        status: () => ({}),
        pair: { send: async (...args) => void calls.push(['send', ...args]), log: async (...args) => (calls.push(['log', ...args]), []) },
        rooms: (...args) => (calls.push(['rooms', ...args]), ['!selfchat:localhost']),
        setRoom: (...args) => {
          calls.push(['setRoom', ...args]);
          if (failRoom) throw new Error(failRoom);
        },
        people: () => [{ id: 'alice' }],
        canImport: () => false,
        importCatalog: () => ({}),
      }),
    );
  });
  afterEach(async () => door.close());

  const get = (path: string) => fetch(`${door.url}${path}`, { headers: { authorization: basic } });
  const post = (path: string, body: unknown) => fetch(`${door.url}${path}`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('with no person they are the owner’s, called as they always were', async () => {
    assert.equal((await get('/pair/log')).status, 200);
    assert.equal((await post('/pair/send', { text: 'login google' })).status, 200);
    assert.equal((await get('/setup/rooms?phone=5551110001')).status, 200);
    assert.equal((await post('/setup/room', { room: '!a:localhost' })).status, 200);
    assert.equal((await get('/pair/log?person=owner')).status, 200);
    assert.deepEqual(calls, [['log'], ['send', 'login google'], ['rooms', '5551110001'], ['setRoom', '!a:localhost'], ['log']]);
  });

  test('with a person they are that person’s window, rooms and chat', async () => {
    assert.equal((await get('/pair/log?person=alice')).status, 200);
    assert.equal((await post('/pair/send', { text: 'login google', person: 'alice' })).status, 200);
    const rooms = await get('/setup/rooms?phone=5552220002&person=alice');
    assert.deepEqual(((await rooms.json()) as { rooms: string[] }).rooms, ['!selfchat:localhost']);
    assert.equal((await post('/setup/room', { room: '!alice:localhost', person: 'alice' })).status, 200);
    assert.deepEqual(calls, [['log', 'alice'], ['send', 'login google', 'alice'], ['rooms', '5552220002', 'alice'], ['setRoom', '!alice:localhost', 'alice']]);
  });

  test('a name nobody has is refused (404 reading, 400 changing) before anything is done', async () => {
    assert.equal((await get('/pair/log?person=mallory')).status, 404);
    assert.equal((await get('/setup/rooms?phone=5552220002&person=mallory')).status, 404);
    assert.equal((await post('/pair/send', { text: 'x', person: 'mallory' })).status, 400);
    assert.equal((await post('/setup/room', { room: '!a:localhost', person: 'mallory' })).status, 400);
    assert.deepEqual(calls, []);
  });

  test('a chat the host will not take is a conflict that says why', async () => {
    failRoom = "That chat is alice's, not the owner's.";
    const res = await post('/setup/room', { room: '!alice:localhost' });
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /That chat is alice's/);
  });
});

describe('the old /pair address leads to the right Connect page', () => {
  let door: { url: string; close(): Promise<void> };
  beforeEach(async () => {
    door = await serve(createCloudWeb({ adminToken: TOKEN, admin: new AdminConsole(), status: () => ({}), pair: { send: async () => {}, log: async () => [] }, rooms: () => [], setRoom: () => {}, people: () => [{ id: 'alice' }], canImport: () => false, importCatalog: () => ({}) }));
  });
  afterEach(async () => door.close());
  const get = (path: string, headers: Record<string, string> = { authorization: basic }) => fetch(`${door.url}${path}`, { headers, redirect: 'manual' });

  test('/pair is the owner’s page, /pair?person=alice is alice’s, and a name nobody has is a 404 that goes nowhere', async () => {
    assert.equal((await get('/pair')).headers.get('location'), '/admin/#connect');
    assert.equal((await get('/pair?person=owner')).headers.get('location'), '/admin/#connect');
    assert.equal((await get('/pair?person=alice')).headers.get('location'), '/admin/#connect:alice');
    assert.equal((await get('/')).headers.get('location'), '/admin/');
    const nobody = await get('/pair?person=mallory');
    assert.equal(nobody.status, 404);
    assert.equal(nobody.headers.get('location'), null);
    assert.equal((await get('/pair?person=%2Fadmin%2Fevil')).status, 404, 'nothing the visitor typed is put in the address');
  });

  test('every route that takes a person wants the owner’s password first: no credential gets anybody else in', async () => {
    for (const path of ['/pair?person=alice', '/pair/log?person=alice', '/setup/rooms?phone=5552220002&person=alice', '/admin/api/connect?person=alice', '/admin/api/connect/log?person=alice', '/admin/api/people', '/status']) {
      const res = await get(path, {});
      assert.equal(res.status, 401, path);
      assert.equal((await get(path, { authorization: 'Bearer not-the-password' })).status, 401, path);
    }
    for (const path of ['/pair/send', '/setup/room', '/admin/api/connect/send', '/admin/api/connect/start']) {
      const res = await fetch(`${door.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-console': '1' }, body: JSON.stringify({ person: 'alice', text: 'x', room: '!a:b' }) });
      assert.equal(res.status, 401, path);
    }
  });
});

describe('the People view of the console', () => {
  let catalog: Catalog;
  let admin: AdminConsole;
  let door: { url: string; close(): Promise<void> };

  const alice = {
    id: 'alice',
    phase: 'setup',
    roomMissing: false,
    room: null,
    roomGone: null,
    error: null,
    bridge: { state: 'CONNECTED' },
    simNumber: true,
    onboarding: { step: 'waiting-for-chat', onboarded: false, warn: false, linkedSince: '2026-11-08T12:00:00.000Z', provedAt: null, chatDueBy: '2026-11-08T12:10:00.000Z', message: 'alice is linked. Waiting for alice to text themself once.' },
    problems: [],
    sentThisMonthMb: 12,
    monthlyLimitMb: 1000,
  };
  const bob = {
    id: 'bob',
    phase: 'running',
    roomMissing: false,
    room: '!bob:localhost',
    roomGone: null,
    error: null,
    bridge: { state: 'CONNECTED' },
    simNumber: false,
    onboarding: { step: 'no-number', onboarded: false, warn: true, message: "The bridge has no phone number for bob's phone." },
    problems: [{ key: 'bridge:bob', message: "bob's Google Messages is not connected to the bridge", since: '2026-11-08T11:00:00.000Z' }],
    sentThisMonthMb: null,
    monthlyLimitMb: null,
  };

  const make = async (status: (() => Record<string, unknown>) | null) => {
    catalog = new Catalog(':memory:');
    admin = new AdminConsole();
    admin.provide({ catalog, env: { ADMIN_TOKEN: TOKEN }, log: () => {}, ...(status ? { status } : {}) });
    door = await serve(createCloudWeb({ adminToken: TOKEN, admin, status: () => ({}), pair: { send: async () => {}, log: async () => [] }, rooms: () => [], setRoom: () => {}, canImport: () => false, importCatalog: () => ({}) }));
  };
  afterEach(async () => {
    await door.close();
    catalog.close();
  });
  const get = (path: string) => fetch(`${door.url}/admin/api/${path}`, { headers: { authorization: basic } });
  const json = async (res: Response) => (await res.json()) as any;

  test('lists each person: where they stand, their login, their phone number, the gate, what they were sent, their problems', async () => {
    await make(() => ({ phase: 'running', sentThisMonthMb: 1900, sentTotalThisMonthMb: 1912, people: [alice, bob] }));
    const d = await json(await get('people'));
    assert.equal(d.people.length, 2);
    assert.deepEqual(d.people[0], {
      id: 'alice',
      phase: 'setup',
      roomMissing: false,
      room: null,
      bridge: 'CONNECTED',
      bridgeError: null,
      simNumber: true,
      onboarding: { step: 'waiting-for-chat', onboarded: false, warn: false, message: 'alice is linked. Waiting for alice to text themself once.', chatDueBy: '2026-11-08T12:10:00.000Z' },
      sentThisMonthMb: 12,
      monthlyLimitMb: 1000,
      problems: [],
      error: null,
    });
    assert.deepEqual([d.people[1].id, d.people[1].simNumber, d.people[1].onboarding.warn, d.people[1].sentThisMonthMb, d.people[1].monthlyLimitMb], ['bob', false, true, null, null]);
    assert.deepEqual(d.people[1].problems, [{ message: "bob's Google Messages is not connected to the bridge", since: '2026-11-08T11:00:00.000Z' }]);
    assert.equal(d.ownerSentThisMonthMb, 1900);
    assert.equal(d.totalSentThisMonthMb, 1912);
  });

  test('is read only and shows nothing the host’s report may hold besides: only those fields, as text and numbers', async () => {
    const leaky = { ...alice, token: 'syt_alice_secret_token', password: 'alice-matrix-password-123', bridge: { state: 'CONNECTED', session: 'google-cookie-SID=abc', token: 'syt_x' }, onboarding: { ...alice.onboarding, cookies: 'SAPISID=zzz' }, problems: [{ key: 'k', message: 'm', since: 's', detail: 'alice-matrix-password-123' }] };
    await make(() => ({ people: [leaky], PEOPLE_PASSWORDS: 'alice:alice-matrix-password-123', secretKey: 'master', edge: { lease: 'x' } }));
    const text = await (await get('people')).text();
    for (const leak of ['syt_alice_secret_token', 'alice-matrix-password-123', 'google-cookie', 'syt_x', 'SAPISID', 'master']) assert.ok(!text.includes(leak), `${leak} must not reach the page`);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await fetch(`${door.url}/admin/api/people`, { method, headers: { authorization: basic, 'content-type': 'application/json', 'x-admin-console': '1' }, body: '{}' });
      assert.ok(res.status === 404 || res.status === 405, `${method} /people answers ${res.status}: there is nothing to change`);
    }
    assert.deepEqual(admin.audit.list(), []);
  });

  test('a host with nobody else (no list, or an empty one) says so, and a host that has not provided its status yet says it is starting', async () => {
    await make(() => ({ phase: 'running' }));
    assert.deepEqual((await json(await get('people'))).people, []);
    await door.close();
    catalog.close();
    await make(() => ({ people: [] }));
    assert.deepEqual((await json(await get('people'))).people, []);
    await door.close();
    catalog.close();
    await make(() => ({ people: 'not a list' }));
    assert.deepEqual((await json(await get('people'))).people, []);
    await door.close();
    catalog.close();
    await make(null);
    const res = await get('people');
    assert.equal(res.status, 503);
    assert.match((await json(res)).error, /still starting/);
  });

  test('text from the report is cleaned of control characters and cut, like everything else the page shows', async () => {
    await make(() => ({ people: [{ ...alice, id: 'alice', error: `bad\u0000\u001b[31m${'x'.repeat(1000)}`, onboarding: { ...alice.onboarding, message: 'a'.repeat(5000) } }] }));
    const one = (await json(await get('people'))).people[0];
    assert.ok(!/[\u0000-\u001f]/.test(one.error));
    assert.ok(one.error.length <= 300);
    assert.ok(one.onboarding.message.length <= 800);
  });

  test('the page knows the fields the host reports, the People tab and the person in the address', async () => {
    await make(() => ({}));
    const page = readFileSync(new URL('../src/admin/site/app.js', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/cloud-main.ts', import.meta.url), 'utf8');
    for (const name of ['onboarding', 'simNumber', 'chat-missing', 'no-number', 'waiting-for-chat']) assert.ok(page.includes(name), `the page knows ${name}`);
    for (const name of ['onboarding', 'simNumber']) assert.ok(main.includes(name), `cloud-main reports ${name}`);
    assert.match(page, /\['people', 'People'\]/);
    assert.match(page, /#connect:\$\{/);
    assert.ok(!/api\('people', \{/.test(page), 'the People page changes things only through people/add, people/remove and people/restart');
  });
});
