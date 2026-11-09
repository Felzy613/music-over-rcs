import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { ensureToken, ensureTokenPatiently, peopleAccounts, personAccount, waitForHomeserver } from '../src/cloud/bootstrap.ts';
import { PENDING_REDACTIONS_KEY, Pairing, chatNumber, ownChatRooms, ownNumbers, sameNumber, selfChatRooms, simNumbers } from '../src/cloud/pairing.ts';
import { createCloudWeb, passwordIn, sameSecret, type CloudDeps } from '../src/cloud/web.ts';
import { MatrixClient, MatrixError } from '../src/matrix/client.ts';
import { OWNER, personOf } from '../src/people.ts';
import { addChat, addLogin, writeBridgeDb } from './helpers/bridge-db.ts';
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

  test('/ping is open and answers 500 on purpose, so a monitor that expects it only sees the running app', async () => {
    const res = await get('/ping');
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(await res.text(), /^pong/);
    assert.equal((await fetch(web.url + '/ping', { method: 'HEAD' })).status, 500);
    assert.equal((await fetch(web.url + '/ping', { method: 'POST' })).status, 401, 'only GET and HEAD, the rest needs the password');
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

  test('without an ADMIN_TOKEN nothing but /healthz and /ping answers', async () => {
    const closed = await serve(createCloudWeb({ ...deps(), adminToken: undefined }));
    try {
      assert.equal((await fetch(closed.url + '/healthz')).status, 200);
      assert.equal((await fetch(closed.url + '/ping')).status, 500);
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

  test('the test alert needs the password and the R2 settings, and leaves one alert', async () => {
    const left: string[] = [];
    const withAlerts = await serve(createCloudWeb({ ...deps(), testAlert: async () => void left.push('alert') }));
    try {
      assert.equal((await fetch(withAlerts.url + '/admin/test-alert', { method: 'POST' })).status, 401);
      assert.equal((await fetch(withAlerts.url + '/admin/test-alert', { method: 'POST', headers: { authorization: basic('open-sesame') } })).status, 200);
      assert.deepEqual(left, ['alert']);
    } finally {
      await withAlerts.close();
    }
    assert.equal((await post('/admin/test-alert', {})).status, 404, 'a host without the R2 settings has nowhere to leave it');
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

  test('patiently: an account that does not exist yet is waited for, and signing in then works', async () => {
    const catalog = new Catalog(':memory:');
    let refusals = 2;
    const waits: number[] = [];
    const logs: string[] = [];
    const flaky = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/login') && refusals-- > 0) return Response.json({ errcode: 'M_FORBIDDEN', error: 'Invalid username or password' }, { status: 403 });
      return fetch(url, init);
    }) as unknown as typeof fetch;
    const result = await ensureTokenPatiently({ env: { MATRIX_PASSWORD: mock.password }, state: catalog, homeserver: mock.url, fetch: flaky, log: (line) => logs.push(line) }, { sleep: async (ms) => void waits.push(ms) });
    assert.equal(result.token, mock.token);
    assert.deepEqual(waits, [3000, 3000]);
    assert.equal(logs.filter((line) => /does not exist yet/.test(line)).length, 1, 'said once, not at every try');
  });

  test('patiently: a password that is simply wrong ends in the same refusal after the allowed tries, and other errors are not retried', async () => {
    const waits: number[] = [];
    await assert.rejects(
      () => ensureTokenPatiently({ env: { MATRIX_PASSWORD: 'nope' }, state: new Catalog(':memory:'), homeserver: mock.url }, { attempts: 3, sleep: async (ms) => void waits.push(ms) }),
      /Invalid username or password/,
    );
    assert.equal(waits.length, 2);
    waits.length = 0;
    await assert.rejects(() => ensureTokenPatiently({ env: { MATRIX_ACCESS_TOKEN: 'syt_wrong' }, state: new Catalog(':memory:'), homeserver: mock.url }, { sleep: async (ms) => void waits.push(ms) }), /not accepted/);
    assert.deepEqual(waits, [], 'a rejected token is not waited on');
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

/** A homeserver of several accounts that needs no network: signing in with a password, and `whoami` by token. */
function fakeHomeserver(accounts: Record<string, { password: string; token: string }>, domain = 'localhost') {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === '/_matrix/client/v3/login') {
      const body = JSON.parse(String(init?.body)) as { identifier?: { user?: string }; password?: string };
      const user = body.identifier?.user ?? '';
      requests.push(`login:${user}`);
      const account = accounts[user];
      if (account && account.password === body.password) return Response.json({ user_id: `@${user}:${domain}`, access_token: account.token, device_id: 'DEVICE' });
      return Response.json({ errcode: 'M_FORBIDDEN', error: 'Invalid username or password' }, { status: 403 });
    }
    if (url.pathname === '/_matrix/client/v3/account/whoami') {
      const token = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace(/^Bearer /, '');
      requests.push(`whoami:${token}`);
      const user = Object.entries(accounts).find(([, account]) => account.token === token)?.[0];
      if (user) return Response.json({ user_id: `@${user}:${domain}` });
      return Response.json({ errcode: 'M_UNKNOWN_TOKEN', error: 'Unrecognised access token' }, { status: 401 });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

describe('a person’s own Matrix token', () => {
  const alice = personOf('alice');
  const bob = personOf('bob');
  const ACCOUNTS = { me: { password: 'owner-password', token: 'syt_owner' }, alice: { password: 'alice-password', token: 'syt_alice' }, bob: { password: 'bob-password', token: 'syt_bob' } };
  const accountOf = (person = alice) => personAccount(person, ACCOUNTS[person.id as 'alice' | 'bob'].password, 'localhost');
  /** The environment on the cloud host once the owner's chat is up: cloud-main.ts puts the OWNER'S token and room there. */
  const OWNERS_ENV = { MATRIX_ACCESS_TOKEN: 'syt_owner', MATRIX_ROOM_ID: '!owner:localhost', MATRIX_USER: 'me', MATRIX_PASSWORD: 'owner-password' };

  test('the account knows who it must be and where its token is kept', () => {
    assert.deepEqual(accountOf(alice), { user: 'alice', password: 'alice-password', userId: '@alice:localhost', stateKey: 'matrix.token:alice' });
    assert.equal(personAccount(bob, 'x', 'my.server').userId, '@bob:my.server');
    assert.throws(() => personAccount(OWNER, 'x', 'localhost'), /the owner's Matrix account comes from MATRIX_USER/);
  });

  test('the people the host handed over are read from PEOPLE and PEOPLE_PASSWORDS, each with their own account, and one without a password is left out', () => {
    const env = { PEOPLE: 'alice bob carol', PEOPLE_PASSWORDS: 'alice:pw-a,carol:pw-c', MATRIX_USER: 'me' };
    const { accounts, problems } = peopleAccounts(env, 'my.server');
    assert.deepEqual(accounts.map((one) => [one.person.id, one.person.owner, one.account]), [
      ['alice', false, { user: 'alice', password: 'pw-a', userId: '@alice:my.server', stateKey: 'matrix.token:alice' }],
      ['carol', false, { user: 'carol', password: 'pw-c', userId: '@carol:my.server', stateKey: 'matrix.token:carol' }],
    ]);
    assert.deepEqual(problems, ['PEOPLE: the host handed over no password for "bob"; left out']);
    assert.deepEqual(peopleAccounts({}, 'localhost'), { accounts: [], problems: [] }, 'no PEOPLE is only the owner');
    assert.deepEqual(peopleAccounts({ PEOPLE_PASSWORDS: 'alice:pw-a' }, 'localhost'), { accounts: [], problems: [] }, 'a password for no one listed is not a person');
    const bad = peopleAccounts({ PEOPLE: 'Nope alice', PEOPLE_PASSWORDS: 'alice:pw-a' }, 'localhost');
    assert.deepEqual(bad.accounts.map((one) => one.person.id), ['alice']);
    assert.equal(bad.problems.length, 1, 'and a name that cannot be used is said once');
  });

  test('signs in as the person, keeps the token under their own key, and the next start needs no password', async () => {
    const home = fakeHomeserver(ACCOUNTS);
    const catalog = new Catalog(':memory:');
    const logs: string[] = [];
    const first = await ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: accountOf(), log: (line) => logs.push(line) });
    assert.deepEqual(first, { token: 'syt_alice', userId: '@alice:localhost' });
    assert.equal(catalog.getState('matrix.token:alice'), 'syt_alice');
    assert.equal(catalog.getState('matrix.token'), undefined, 'the owner’s key is not touched');
    assert.deepEqual(logs, ['signed in to the homeserver as @alice:localhost']);
    const second = await ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: { ...accountOf(), password: '' } });
    assert.equal(second.token, 'syt_alice');
    assert.equal(home.requests.filter((request) => request.startsWith('login:')).length, 1);
  });

  test('ignores the owner’s MATRIX_ACCESS_TOKEN, MATRIX_USER and MATRIX_PASSWORD: the person’s client still signs in as the person', async () => {
    const home = fakeHomeserver(ACCOUNTS);
    const catalog = new Catalog(':memory:');
    const result = await ensureToken({ env: OWNERS_ENV, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: accountOf() });
    assert.deepEqual(result, { token: 'syt_alice', userId: '@alice:localhost' });
    assert.deepEqual(home.requests, ['login:alice', 'whoami:syt_alice'], 'the owner’s token was never even asked about, and the owner never signed in');
    // The same goes for the patient version the host uses, and for a person whose kept token is good.
    const patient = await ensureTokenPatiently({ env: OWNERS_ENV, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: accountOf() }, { sleep: async () => {} });
    assert.equal(patient.userId, '@alice:localhost');
    assert.ok(!home.requests.includes('whoami:syt_owner') && !home.requests.includes('login:me'));
    // And the owner, given the same environment, is still the owner.
    assert.deepEqual(await ensureToken({ env: OWNERS_ENV, state: new Catalog(':memory:'), homeserver: 'http://hs', fetch: home.fetch }), { token: 'syt_owner', userId: '@me:localhost' });
  });

  test('a kept token that turns out to be someone else’s is not used and is replaced by signing in again', async () => {
    const home = fakeHomeserver(ACCOUNTS);
    const catalog = new Catalog(':memory:');
    catalog.setState('matrix.token:alice', 'syt_owner');
    const logs: string[] = [];
    const result = await ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: accountOf(), log: (line) => logs.push(line) });
    assert.equal(result.token, 'syt_alice');
    assert.equal(catalog.getState('matrix.token:alice'), 'syt_alice');
    assert.ok(logs.includes('the Matrix token kept for alice belongs to another account; signing in again'));
    assert.ok(!logs.some((line) => line.includes('syt_')), 'no token is logged');
  });

  test('a kept token the homeserver no longer knows is replaced too', async () => {
    const home = fakeHomeserver(ACCOUNTS);
    const catalog = new Catalog(':memory:');
    catalog.setState('matrix.token:alice', 'syt_stale');
    const logs: string[] = [];
    assert.equal((await ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: accountOf(), log: (line) => logs.push(line) })).token, 'syt_alice');
    assert.ok(logs.includes('the Matrix token kept for alice is no longer accepted; signing in again'));
  });

  test('a sign-in that gives another account’s token is an error, and nothing is kept', async () => {
    for (const lie of ['the sign-in says another account', 'the token is another account’s']) {
      const home = fakeHomeserver(ACCOUNTS);
      const lying = (async (input: string | URL, init?: RequestInit) => {
        const res = await home.fetch(input, init);
        if (!String(input).endsWith('/login')) return res;
        const body = (await res.json()) as Record<string, string>;
        return Response.json(lie.startsWith('the sign-in') ? { ...body, user_id: '@bob:localhost' } : { ...body, access_token: 'syt_bob' });
      }) as typeof fetch;
      const catalog = new Catalog(':memory:');
      await assert.rejects(() => ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: lying, account: accountOf() }), /gave a token for an account other than @alice:localhost; it is not used or kept/, lie);
      assert.equal(catalog.getState('matrix.token:alice'), undefined, lie);
      assert.equal(catalog.getState('matrix.token'), undefined, lie);
    }
  });

  test('a person’s token is never kept where the owner’s is', async () => {
    const home = fakeHomeserver(ACCOUNTS);
    const catalog = new Catalog(':memory:');
    catalog.setState('matrix.token', 'syt_owner');
    await assert.rejects(() => ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: { ...accountOf(), stateKey: 'matrix.token' } }), /cannot be kept where the owner's is/);
    assert.equal(catalog.getState('matrix.token'), 'syt_owner');
    assert.deepEqual(home.requests, [], 'and nothing was asked of the homeserver');
  });

  test('two people each get their own token and the owner keeps theirs', async () => {
    const home = fakeHomeserver(ACCOUNTS);
    const catalog = new Catalog(':memory:');
    const owner = await ensureToken({ env: { MATRIX_USER: 'me', MATRIX_PASSWORD: 'owner-password' }, state: catalog, homeserver: 'http://hs', fetch: home.fetch });
    const forAlice = await ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: accountOf(alice) });
    const forBob = await ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: accountOf(bob) });
    assert.deepEqual([owner.userId, forAlice.userId, forBob.userId], ['@me:localhost', '@alice:localhost', '@bob:localhost']);
    assert.deepEqual([catalog.getState('matrix.token'), catalog.getState('matrix.token:alice'), catalog.getState('matrix.token:bob')], ['syt_owner', 'syt_alice', 'syt_bob']);
    // A restart finds all three where they were.
    const again = await Promise.all([
      ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch }),
      ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: accountOf(alice) }),
      ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: accountOf(bob) }),
    ]);
    assert.deepEqual(again.map((one) => one.token), ['syt_owner', 'syt_alice', 'syt_bob']);
    assert.equal(home.requests.filter((request) => request.startsWith('login:')).length, 3);
  });

  test('with no password it says whose sign-in is missing, and a wrong one is the homeserver’s refusal and keeps nothing', async () => {
    const home = fakeHomeserver(ACCOUNTS);
    const catalog = new Catalog(':memory:');
    await assert.rejects(() => ensureToken({ env: OWNERS_ENV, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: { ...accountOf(), password: '' } }), /No Matrix sign-in for alice/);
    await assert.rejects(
      () => ensureToken({ env: {}, state: catalog, homeserver: 'http://hs', fetch: home.fetch, account: { ...accountOf(), password: 'nope' } }),
      (err: unknown) => err instanceof MatrixError && err.status === 403,
    );
    assert.equal(catalog.getState('matrix.token:alice'), undefined);
  });

  test('patiently: an account the host has not made yet is waited for, as for the owner, and the error is not hidden by a mix-up', async () => {
    const home = fakeHomeserver(ACCOUNTS);
    let refusals = 2;
    const flaky = (async (input: string | URL, init?: RequestInit) => (String(input).endsWith('/login') && refusals-- > 0 ? Response.json({ errcode: 'M_FORBIDDEN', error: 'Invalid username or password' }, { status: 403 }) : home.fetch(input, init))) as typeof fetch;
    const waits: number[] = [];
    const result = await ensureTokenPatiently({ env: OWNERS_ENV, state: new Catalog(':memory:'), homeserver: 'http://hs', fetch: flaky, account: accountOf() }, { sleep: async (ms) => void waits.push(ms) });
    assert.equal(result.userId, '@alice:localhost');
    assert.deepEqual(waits, [3000, 3000]);
    // A sign-in that gives the wrong account is not waited on: it will not improve.
    const wrong = { ...accountOf(), userId: '@carol:localhost' };
    waits.length = 0;
    await assert.rejects(() => ensureTokenPatiently({ env: {}, state: new Catalog(':memory:'), homeserver: 'http://hs', fetch: home.fetch, account: wrong }, { sleep: async (ms) => void waits.push(ms) }), /other than @carol:localhost/);
    assert.deepEqual(waits, []);
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

// 2026-11-08, "ari": a new person has no chat with the bridge's bot until their Connect page is first opened. The page asked for it from several
// requests at once (it reads the bridge's answers every few seconds while the first, slow one is still making the chat), each made a chat of its
// own, and the bridge answered commands without its prefix in only one of them, which was not the one the window used.
describe('a window to the bridge bot for a person who has no chat with it yet', () => {
  const BOT = '@gmessagesbot:localhost';
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const fake = (existing: string[] = [], failFirstCreate = false) => {
    const seen = { created: 0, sent: [] as Array<{ room: string; body: string }> };
    const matrix = {
      async listRooms() {
        await wait(25);
        return existing.map((id) => ({ id, name: '', members: 2, heroes: [BOT], invited: false }));
      },
      async createDirectRoom() {
        seen.created++;
        await wait(60);
        if (failFirstCreate && seen.created === 1) throw new Error('the homeserver is busy');
        return `!chat${seen.created}:localhost`;
      },
      async pollEvents() {
        return [];
      },
      async sendText(room: string, body: string) {
        seen.sent.push({ room, body });
        return `$event${seen.sent.length}`;
      },
      async redact() {},
    } as unknown as MatrixClient;
    return { matrix, seen };
  };
  const windowFor = (matrix: MatrixClient, extra: { commandPrefix?: string; log?: (line: string) => void } = {}) => new Pairing({ matrix, botId: BOT, userId: '@ari:localhost', ...extra });

  test('several requests at the same moment make one chat with the bot, and all use it', async () => {
    const { matrix, seen } = fake();
    const p = windowFor(matrix);
    await Promise.all([p.log(), p.log(), p.send('login google'), p.log(), p.send('help')]);
    assert.equal(seen.created, 1, 'one chat, not one for each request');
    assert.deepEqual([...new Set(seen.sent.map((one) => one.room))], ['!chat1:localhost']);
    await p.send('later');
    assert.equal(seen.created, 1);
  });

  test('a first try that fails does not stick: the next one asks again', async () => {
    const { matrix, seen } = fake([], true);
    const p = windowFor(matrix);
    await assert.rejects(() => p.send('login google'), /busy/);
    await p.send('login google');
    assert.equal(seen.created, 2);
    assert.equal(seen.sent.length, 1);
  });

  test('with the bridge\'s prefix everything is sent as a command, a pasted request too, and a message that has it is not doubled', async () => {
    const { matrix, seen } = fake();
    const p = windowFor(matrix, { commandPrefix: '!gm' });
    await p.send('login google');
    await p.send("curl 'https://messages.google.com/web/config' \\\n  -H 'cookie: SID=abc'");
    await p.send('!gm logout');
    assert.deepEqual(
      seen.sent.map((one) => one.body),
      ['!gm login google', "!gm curl 'https://messages.google.com/web/config' -H 'cookie: SID=abc'", '!gm logout'],
    );
  });

  test('without a prefix (the owner\'s window) messages go exactly as typed', async () => {
    const { matrix, seen } = fake();
    await windowFor(matrix).send('login google');
    assert.deepEqual(seen.sent.map((one) => one.body), ['login google']);
  });

  test('when there are several chats with the bot already it uses the first and says so', async () => {
    const { matrix, seen } = fake(['!a:localhost', '!b:localhost']);
    const lines: string[] = [];
    const p = windowFor(matrix, { commandPrefix: '!gm', log: (line) => lines.push(line) });
    await p.send('login google');
    assert.equal(seen.created, 0);
    assert.equal(seen.sent[0]?.room, '!a:localhost');
    assert.ok(lines.some((line) => /2 chats with the bridge's bot/.test(line)), lines.join(' | '));
  });

  test('it says what it did in the log, naming only short commands and never what was pasted', async () => {
    const { matrix } = fake();
    const lines: string[] = [];
    const p = windowFor(matrix, { log: (line) => lines.push(line) });
    await p.send('login google');
    await p.send("curl 'https://messages.google.com/web/config' -H 'cookie: SID=SECRETVALUE'");
    const said = lines.join('\n');
    assert.match(said, /sent "login google" to the bridge's bot in !chat1:localhost/);
    assert.match(said, /sent \d+ characters to the bridge's bot/);
    assert.ok(!said.includes('SECRETVALUE') && !said.includes('cookie'), said);
  });
});

describe('pasted requests are taken out of the chat even across a restart', () => {
  let mock: MockMatrix;
  before(async () => {
    mock = await startMockMatrix();
  });
  after(async () => mock.close());
  beforeEach(() => mock.reset());

  const COOKIES = "curl 'https://messages.google.com/web/config' \\\n  -H 'cookie: SID=abc; SAPISID=def' \\\n  -H 'x: y'";
  const store = () => {
    const values = new Map<string, string>();
    return { values, getState: (key: string) => values.get(key), setState: (key: string, value: string) => void values.set(key, value) };
  };
  const pending = (state: ReturnType<typeof store>) => JSON.parse(state.values.get(PENDING_REDACTIONS_KEY) ?? '[]') as Array<{ user: string; room: string; event: string; due: number }>;
  const make = (state: ReturnType<typeof store> | undefined, options: { redactAfterMs?: number; retryAfterMs?: number; matrix?: MatrixClient; userId?: string; log?: (line: string) => void } = {}) =>
    new Pairing({ matrix: options.matrix ?? new MatrixClient({ token: mock.token, homeserver: mock.url }), botId: mock.botUser, userId: options.userId ?? mock.userId, redactAfterMs: options.redactAfterMs ?? 20, ...(state ? { state } : {}), ...(options.retryAfterMs ? { retryAfterMs: options.retryAfterMs } : {}), ...(options.log ? { log: options.log } : {}) });
  const until = async (ready: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!ready()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };

  test('a paste waiting to be deleted is remembered, and forgotten once it is deleted', async () => {
    const state = store();
    const p = make(state, { redactAfterMs: 60 });
    await p.send(COOKIES);
    const [entry] = pending(state);
    assert.deepEqual([entry!.user, entry!.room, entry!.event], [mock.userId, mock.botRoomId, mock.sent.at(-1)!.eventId]);
    assert.ok(entry!.due > Date.now() - 1000 && entry!.due <= Date.now() + 60, 'due a moment from now');
    assert.deepEqual(mock.redactions, [], 'not yet');
    await until(() => mock.redactions.length === 1, 'the redaction');
    assert.deepEqual(mock.redactions, [entry!.event]);
    await until(() => pending(state).length === 0, 'it to be forgotten');
  });

  test('a restart inside the minute: the next start deletes the paste the old one could not', async () => {
    const state = store();
    // The first process pastes and ends before the minute is up (its timer never fires).
    const first = make(state, { redactAfterMs: 60_000 });
    await first.send(COOKIES);
    const [entry] = pending(state);
    assert.deepEqual(mock.redactions, []);
    // The next start: the same account, a new Pairing over the same state. The paste's time has come by then.
    state.setState(PENDING_REDACTIONS_KEY, JSON.stringify([{ ...entry, due: Date.now() - 1 }]));
    make(state);
    await until(() => mock.redactions.length === 1, 'the redaction at the next start');
    assert.deepEqual(mock.redactions, [entry!.event]);
    await until(() => pending(state).length === 0, 'it to be forgotten');
  });

  test('a restart before its time still waits for its time, and then deletes it', async () => {
    const state = store();
    const first = make(state, { redactAfterMs: 60_000 });
    await first.send(COOKIES);
    const [entry] = pending(state);
    state.setState(PENDING_REDACTIONS_KEY, JSON.stringify([{ ...entry, due: Date.now() + 80 }]));
    make(state);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(mock.redactions, [], 'not before its time');
    await until(() => mock.redactions.length === 1, 'the redaction when due');
  });

  test('each account deletes only its own pastes: a person’s window never touches the owner’s', async () => {
    const state = store();
    const mine = { user: mock.userId, room: mock.botRoomId, event: '$mine:localhost', due: Date.now() - 1 };
    const theirs = { user: '@alice:localhost', room: '!alice-dm:localhost', event: '$hers:localhost', due: Date.now() - 1 };
    state.setState(PENDING_REDACTIONS_KEY, JSON.stringify([theirs, mine]));
    make(state);
    await until(() => mock.redactions.length === 1, 'the redaction');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(mock.redactions, ['$mine:localhost']);
    assert.deepEqual(pending(state), [theirs], 'hers is still waiting for her window');
  });

  test('a paste that cannot be deleted for good (the room is gone) is dropped and said; one that may pass (the homeserver is busy) stays for the next start', async () => {
    const state = store();
    const lines: string[] = [];
    const gone = { ...{ user: mock.userId, room: mock.botRoomId, event: '$gone:localhost' }, due: Date.now() - 1 };
    const busy = { user: mock.userId, room: mock.botRoomId, event: '$busy:localhost', due: Date.now() - 1 };
    state.setState(PENDING_REDACTIONS_KEY, JSON.stringify([gone, busy]));
    const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
    matrix.redact = async (_room: string, event: string) => {
      throw event === '$gone:localhost' ? new MatrixError('You are not in that room', 403, 'M_FORBIDDEN', '') : new MatrixError('Too many requests', 429, 'M_LIMIT_EXCEEDED', '');
    };
    make(state, { matrix, log: (line) => lines.push(line), retryAfterMs: 1_000_000 });
    await until(() => pending(state).length === 1, 'the refused one to be dropped');
    assert.deepEqual(pending(state).map((one) => one.event), ['$busy:localhost']);
    assert.equal(lines.filter((line) => /could not delete the pasted request from the chat: You are not in that room/.test(line)).length, 1);
    assert.ok(lines.some((line) => /Too many requests/.test(line)));
  });

  test('a redaction that fails for a while is tried again, and then done', async () => {
    const state = store();
    let tries = 0;
    const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
    const real = matrix.redact.bind(matrix);
    matrix.redact = async (room: string, event: string) => {
      if (++tries < 3) throw new MatrixError('Service unavailable', 503, 'M_UNKNOWN', '');
      return real(room, event);
    };
    const p = make(state, { matrix, retryAfterMs: 10, redactAfterMs: 5 });
    await p.send(COOKIES);
    await until(() => mock.redactions.length === 1, 'the third try');
    assert.equal(tries, 3);
    await until(() => pending(state).length === 0, 'it to be forgotten');
  });

  test('a token the homeserver no longer knows leaves the paste remembered, for the account’s next sign-in', async () => {
    const state = store();
    const stale = new MatrixClient({ token: 'syt_old', homeserver: mock.url });
    // Sending itself needs a valid token, so the paste is written the way a start that had one would have left it.
    state.setState(PENDING_REDACTIONS_KEY, JSON.stringify([{ user: mock.userId, room: mock.botRoomId, event: '$stale:localhost', due: Date.now() - 1 }]));
    make(state, { matrix: stale, retryAfterMs: 1_000_000 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(mock.redactions, []);
    assert.equal(pending(state).length, 1, '401 is not a refusal for good');
  });

  test('with no state it is as it was: one try, nothing remembered', async () => {
    const lines: string[] = [];
    let tries = 0;
    const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
    matrix.redact = async () => {
      tries++;
      throw new MatrixError('Service unavailable', 503, 'M_UNKNOWN', '');
    };
    const p = make(undefined, { matrix, log: (line) => lines.push(line), retryAfterMs: 5, redactAfterMs: 5 });
    await p.send(COOKIES);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(tries, 1);
    // The window now also logs that it sent something (its size only); the failure is still said once.
    assert.deepEqual(lines.filter((line) => /could not delete/.test(line)), ['could not delete the pasted request from the chat: Service unavailable']);
  });

  test('a state that cannot be written is said, and the paste is still deleted on time', async () => {
    const lines: string[] = [];
    const state = { getState: () => undefined, setState: () => { throw new Error('database is locked'); } };
    const p = make(state as never, { log: (line) => lines.push(line), redactAfterMs: 10 });
    await p.send(COOKIES);
    await until(() => mock.redactions.length === 1, 'the redaction');
    assert.ok(lines.some((line) => /could not remember the pasted request to delete it later: database is locked/.test(line)), lines.join('\n'));
  });

  test('damaged or foreign state is ignored, and at most 50 are kept', async () => {
    const state = store();
    state.setState(PENDING_REDACTIONS_KEY, '{not json');
    const p = make(state, { redactAfterMs: 1_000_000 });
    await p.send(COOKIES);
    assert.equal(pending(state).length, 1, 'a damaged value is replaced');
    state.setState(PENDING_REDACTIONS_KEY, JSON.stringify([42, null, { user: 1 }, { user: mock.userId, room: 'r', event: 'e' }]));
    await p.send(COOKIES);
    assert.equal(pending(state).length, 1, 'entries that are not pastes are dropped');
    const many = Array.from({ length: 60 }, (_, i) => ({ user: '@other:localhost', room: '!r:localhost', event: `$e${i}`, due: Date.now() + 1_000_000 }));
    state.setState(PENDING_REDACTIONS_KEY, JSON.stringify(many));
    await p.send(COOKIES);
    const kept = pending(state);
    assert.equal(kept.length, 50);
    assert.equal(kept.at(-1)!.user, mock.userId, 'the newest is kept');
  });
});

describe('one window to the bridge for each Matrix account', () => {
  const owner: MockMatrix[] = [];
  after(async () => {
    for (const one of owner) await one.close();
  });

  test('each opens its own chat with the bridge’s bot when it has none, with its own token: another account’s token is refused', async () => {
    const ownerMock = await startMockMatrix(0, { eventPrefix: 'o' });
    const aliceMock = await startMockMatrix(0, { eventPrefix: 'a', user: 'alice', token: 'syt_alice_token' });
    owner.push(ownerMock, aliceMock);
    // Neither has a chat with the bot yet.
    for (const one of [ownerMock, aliceMock]) one.rooms.splice(0, one.rooms.length, ...one.rooms.filter((room) => room.id !== one.botRoomId));
    const ownerWindow = new Pairing({ matrix: new MatrixClient({ token: ownerMock.token, homeserver: ownerMock.url }), botId: ownerMock.botUser, userId: ownerMock.userId });
    const aliceWindow = new Pairing({ matrix: new MatrixClient({ token: aliceMock.token, homeserver: aliceMock.url }), botId: aliceMock.botUser, userId: aliceMock.userId });
    // Opening the window finds the chat with the bot, or makes it (what the mock makes cannot be posted in, so this only reads).
    await aliceWindow.log();
    assert.equal(aliceMock.created.length, 1, 'alice’s account made a chat with the bot');
    assert.deepEqual(aliceMock.created[0]!.invite, [aliceMock.botUser]);
    assert.equal(aliceMock.created[0]!.is_direct, true);
    assert.equal(ownerMock.created.length, 0, 'the owner’s was not touched');
    await ownerWindow.log();
    assert.equal(ownerMock.created.length, 1);
    assert.deepEqual(ownerMock.created[0]!.invite, [ownerMock.botUser]);
    assert.equal(aliceMock.created.length, 1);
    // A window that carries the owner's token to alice's homeserver account is refused: nothing is posted as alice.
    const crossed = new Pairing({ matrix: new MatrixClient({ token: ownerMock.token, homeserver: aliceMock.url }), botId: aliceMock.botUser, userId: ownerMock.userId });
    await assert.rejects(() => crossed.log(), (err: unknown) => err instanceof MatrixError && err.status === 401);
    assert.equal(aliceMock.created.length, 1);
    assert.deepEqual(aliceMock.sent.map((event) => event.content.body), []);
  });

  test('with a chat with the bot already there, each uses its own and says what it was told as itself', async () => {
    const ownerMock = await startMockMatrix(0, { eventPrefix: 'o' });
    const aliceMock = await startMockMatrix(0, { eventPrefix: 'a', user: 'alice', token: 'syt_alice_token' });
    owner.push(ownerMock, aliceMock);
    const windows = [ownerMock, aliceMock].map((one) => ({ one, window: new Pairing({ matrix: new MatrixClient({ token: one.token, homeserver: one.url }), botId: one.botUser, userId: one.userId }) }));
    for (const { one, window } of windows) {
      await window.send(`login google (${one.userId})`);
      assert.deepEqual(one.created, [], 'no new chat');
      assert.deepEqual(one.sent.map((event) => event.content.body), [`login google (${one.userId})`]);
    }
    // What the bridge's bot says to one is not shown in the other's window.
    ownerMock.addMessage(ownerMock.botUser, { msgtype: 'm.notice', body: 'for the owner' }, ownerMock.botRoomId);
    aliceMock.addMessage(aliceMock.botUser, { msgtype: 'm.notice', body: 'for alice' }, aliceMock.botRoomId);
    assert.deepEqual((await windows[0]!.window.log()).map((line) => line.text), ['for the owner']);
    assert.deepEqual((await windows[1]!.window.log()).map((line) => line.text), ['for alice']);
  });
});

describe('finding the self-chat in the bridge database', () => {
  const LOGIN = 'owner@gmail.com/1700000000001';

  /** A bridge database with the tables (and columns) the finder reads, as mautrix-gmessages makes them. */
  function bridgeDb(dir: string, options: { sims?: Record<string, unknown>; logins?: Array<{ id: string; user: string; metadata: string }> } = {}): string {
    const path = join(dir, 'bridge.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE user_login (bridge_id TEXT, user_mxid TEXT, id TEXT, remote_name TEXT, metadata TEXT);
      CREATE TABLE portal (bridge_id TEXT, id TEXT, receiver TEXT, mxid TEXT);
      CREATE TABLE gmessages_direct_conversation (bridge_id TEXT, login_id TEXT, phone_number TEXT, portal_id TEXT, last_message_ts INTEGER)`);
    const logins = options.logins ?? [{ id: LOGIN, user: '@me:localhost', metadata: JSON.stringify({ session: { secret: 'x' }, sim_metadata: options.sims ?? {} }) }];
    for (const login of logins) db.prepare("INSERT INTO user_login VALUES ('gmessages', ?, ?, '', ?)").run(login.user, login.id, login.metadata);
    db.exec(`INSERT INTO portal VALUES
      ('gmessages', '1.1', '${LOGIN}', '!friend:localhost'),
      ('gmessages', '1.166', '${LOGIN}', '!old-self:localhost'),
      ('gmessages', '1.170', '${LOGIN}', '!self:localhost'),
      ('gmessages', '1.180', '${LOGIN}', NULL),
      ('gmessages', '1.190', '${LOGIN}', '!group:localhost')`);
    db.exec(`INSERT INTO gmessages_direct_conversation VALUES
      ('gmessages', '${LOGIN}', '+15559998888', '1.1', 300),
      ('gmessages', '${LOGIN}', '+15551234567', '1.170', 200),
      ('gmessages', '${LOGIN}', '+15551234567', '1.166', 100),
      ('gmessages', '${LOGIN}', '+15551234567', '1.180', 400)`);
    db.close();
    return path;
  }
  const sim = (number: string) => ({ SIMData: { carrierName: 'Carrier', formattedPhoneNumber: number }, SIMParticipant: { ID: '1' } });

  test('lists the rooms of the chat with a phone number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      const path = bridgeDb(dir);
      assert.deepEqual(selfChatRooms(path, '5551234567'), ['!self:localhost', '!old-self:localhost'], 'newest first; a chat with no room yet is left out');
      assert.deepEqual(selfChatRooms(path, '+1 555 123 4567'), ['!self:localhost', '!old-self:localhost']);
      assert.deepEqual(selfChatRooms(path, '5550000000'), []);
      assert.deepEqual(selfChatRooms(path, '123'), [], 'too short to be a number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('finds your own chat with no number typed: the chat with the number Google Messages gives for the phone’s SIM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      const path = bridgeDb(dir, { sims: { '1': sim('(555) 123-4567') } });
      assert.deepEqual(ownChatRooms(path), ['!self:localhost', '!old-self:localhost']);
      assert.deepEqual(ownChatRooms(path, { userId: '@me:localhost' }), ['!self:localhost', '!old-self:localhost']);
      assert.deepEqual(ownChatRooms(path, { userId: '@someone-else:localhost' }), [], 'only the logins of the bot’s own account');
      assert.equal(chatNumber(path, '!self:localhost'), '+15551234567');
      assert.equal(chatNumber(path, '!group:localhost'), undefined, 'not a one-to-one chat');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a SIM that does not say its number: the number of the chat used before finds it, and nothing else does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      const path = bridgeDb(dir, { sims: { '1': { SIMData: { carrierName: 'Carrier' } } } });
      assert.deepEqual(ownChatRooms(path), [], 'no number, no guess');
      assert.deepEqual(ownChatRooms(path, { known: ['+15551234567'] }), ['!self:localhost', '!old-self:localhost']);
      assert.deepEqual(ownChatRooms(bridgeDb(mkdtempSync(join(dir, 'x-')), { logins: [{ id: LOGIN, user: '@me:localhost', metadata: 'not json' }] }), { known: ['5551234567'] }), [
        '!self:localhost',
        '!old-self:localhost',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a chat is only taken for a login that has it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      const path = bridgeDb(dir, { logins: [{ id: 'another@gmail.com/1', user: '@me:localhost', metadata: JSON.stringify({ sim_metadata: { '1': sim('+1 555 123 4567') } }) }] });
      assert.deepEqual(ownChatRooms(path), [], 'the chats belong to a login that is not there any more');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the same number, however it is written', () => {
    assert.equal(sameNumber('+1 (555) 123-4567', '5551234567'), true);
    assert.equal(sameNumber('+15551234567', '+1 555 123 4567'), true);
    assert.equal(sameNumber('+972 54-123-4567', '054-123-4567'), true, 'a trunk 0 is not part of the number');
    assert.equal(sameNumber('00972541234567', '+972541234567'), true, 'nor an international 00');
    assert.equal(sameNumber('+15551234567', '+15551234568'), false);
    assert.equal(sameNumber('+15551234567', '1234567'), false, 'seven digits are too few to say');
    assert.equal(sameNumber('', ''), false);
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

describe('finding each person’s own chat in the bridge database', () => {
  const OWNER = { login: 'owner@gmail.com/1', user: '@me:localhost', phone: '+15551110001' };
  const ALICE = { login: 'alice@gmail.com/1', user: '@alice:localhost', phone: '+15552220002' };
  const BOB = { login: 'bob@gmail.com/1', user: '@bob:localhost', phone: '+15553330003' };

  /** A database with three people, each with a login, a SIM that reports its number, and a chat with themself. */
  function threePeople(dir: string): string {
    return writeBridgeDb(
      dir,
      [OWNER, ALICE, BOB].map((one, index) => ({
        login: one.login,
        user: one.user,
        sims: [one.phone],
        chats: [{ phone: one.phone, room: `!${one.user.slice(1, one.user.indexOf(':'))}-room:localhost`, at: 100 + index }],
      })),
    );
  }

  test('with an account named, only that account’s logins are looked at: each person finds their own chat and never another’s', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      const path = threePeople(dir);
      assert.deepEqual(ownChatRooms(path, { userId: OWNER.user }), ['!me-room:localhost']);
      assert.deepEqual(ownChatRooms(path, { userId: ALICE.user }), ['!alice-room:localhost']);
      assert.deepEqual(ownChatRooms(path, { userId: BOB.user }), ['!bob-room:localhost']);
      // Another person's number, however it is offered as a known one, does not make their chat yours.
      assert.deepEqual(ownChatRooms(path, { userId: ALICE.user, known: [OWNER.phone] }), ['!alice-room:localhost']);
      assert.deepEqual(ownChatRooms(path, { userId: '@carol:localhost', known: [OWNER.phone, ALICE.phone] }), [], 'an account with no login finds nothing');
      // Nobody named is the old behaviour (every account's), which is why a person's search always names one.
      assert.deepEqual(ownChatRooms(path).sort(), ['!alice-room:localhost', '!bob-room:localhost', '!me-room:localhost']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an account that came out empty finds nothing, not everybody’s chats', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      const path = threePeople(dir);
      assert.deepEqual(ownChatRooms(path, { userId: '' }), []);
      assert.deepEqual(ownChatRooms(path, { userId: '', known: [OWNER.phone] }), []);
      assert.deepEqual(selfChatRooms(path, OWNER.phone, { userId: '' }), []);
      assert.deepEqual(simNumbers(path, ''), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the chats with a number can be asked for among one account’s logins only; asked for with no account they are as they always were', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      const path = threePeople(dir);
      assert.deepEqual(selfChatRooms(path, ALICE.phone), ['!alice-room:localhost']);
      assert.deepEqual(selfChatRooms(path, ALICE.phone, { userId: ALICE.user }), ['!alice-room:localhost']);
      assert.deepEqual(selfChatRooms(path, ALICE.phone, { userId: BOB.user }), [], 'bob has no chat with her number');
      assert.deepEqual(selfChatRooms(path, '12345', { userId: ALICE.user }), [], 'too short to be a number');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the SIM numbers Google Messages gave are each account’s own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      const path = threePeople(dir);
      assert.deepEqual(simNumbers(path, ALICE.user), [ALICE.phone]);
      assert.deepEqual(simNumbers(path, BOB.user), [BOB.phone]);
      assert.deepEqual(simNumbers(path, '@carol:localhost'), []);
      const silent = writeBridgeDb(mkdtempSync(join(dir, 's-')), [{ login: 'dan@gmail.com/1', user: '@dan:localhost', sims: [] }]);
      assert.deepEqual(simNumbers(silent, '@dan:localhost'), [], 'a SIM that does not say its number');
      assert.throws(() => simNumbers(join(dir, 'missing.db'), ALICE.user));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ownNumbers (exported for the onboarding gate) says, for each login, the numbers its SIMs gave: none for a login that gave none or whose settings cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      const path = threePeople(dir);
      addLogin(path, { login: 'alice@gmail.com/2', user: ALICE.user, sims: [] });
      addLogin(path, { login: 'alice@gmail.com/3', user: ALICE.user, sims: ['+15559990009', '+15559990010'] });
      const db = new DatabaseSync(path);
      try {
        db.prepare("INSERT INTO user_login VALUES ('gmessages', ?, 'alice@gmail.com/4', '', 'not json at all')").run(ALICE.user);
        const hers = ownNumbers(db, ALICE.user);
        assert.deepEqual([...hers.keys()].sort(), ['alice@gmail.com/1', 'alice@gmail.com/2', 'alice@gmail.com/3', 'alice@gmail.com/4']);
        assert.deepEqual(hers.get('alice@gmail.com/1'), [ALICE.phone]);
        assert.deepEqual(hers.get('alice@gmail.com/2'), [], 'a SIM that gives no number');
        assert.deepEqual(hers.get('alice@gmail.com/3'), ['+15559990009', '+15559990010']);
        assert.deepEqual(hers.get('alice@gmail.com/4'), [], 'settings that cannot be read');
        assert.deepEqual([...ownNumbers(db, BOB.user).keys()], [BOB.login], 'one account’s logins only');
        assert.equal(ownNumbers(db, undefined).size, 3 + 3, 'with no account, everybody’s');
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a SIM that gives a number which is not the number of the chat: the chat is never found (the onboarding gate’s proof does not arrive)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bridge-db-'));
    try {
      // Alice's SIM says +1 555 222 0002, but the bridge made her self-chat under a different number (another line, a short number).
      const path = writeBridgeDb(dir, [{ login: ALICE.login, user: ALICE.user, sims: [ALICE.phone], chats: [{ phone: '+15557770007', room: '!elsewhere:localhost', at: 1 }] }]);
      assert.deepEqual(simNumbers(path, ALICE.user), [ALICE.phone], 'a number exists, so the presence check alone would pass');
      assert.deepEqual(ownChatRooms(path, { userId: ALICE.user }), [], 'but her chat is not found, so she is not set up');
      addChat(path, ALICE.login, { phone: ALICE.phone, room: '!hers:localhost', at: 2 });
      assert.deepEqual(ownChatRooms(path, { userId: ALICE.user }), ['!hers:localhost'], 'it is found once the chat with her own number is there');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
