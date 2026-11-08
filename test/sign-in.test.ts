import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AdminAccount, Sessions, sessionBinding } from '../src/admin/account.ts';
import { AdminConsole } from '../src/admin/console.ts';
import { SignIn, safeNext } from '../src/admin/sign-in.ts';
import { Catalog } from '../src/catalog.ts';
import { createCloudWeb } from '../src/cloud/web.ts';

// Signing in to the pages: a real sign-in page, the owner's own user name and password kept in the database (as a salted hash), a
// session cookie, and the ADMIN_TOKEN from Render as the recovery way in and the machine password.

const TOKEN = 'render-admin-token-91c4';
const PASSWORD = 'correct horse battery staple';

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

describe('the owner’s account', () => {
  let catalog: Catalog;
  beforeEach(() => void (catalog = new Catalog(':memory:')));
  afterEach(() => catalog.close());

  test('a user name and password have to be fit: long enough, not the same, not the host’s token', () => {
    assert.equal(AdminAccount.problem('dave', PASSWORD, TOKEN), undefined);
    assert.match(AdminAccount.problem('ab', PASSWORD) ?? '', /3 to 64/);
    assert.match(AdminAccount.problem('x'.repeat(65), PASSWORD) ?? '', /3 to 64/);
    assert.match(AdminAccount.problem('da\u0000ve', PASSWORD) ?? '', /control characters/);
    assert.match(AdminAccount.problem('dave', 'short') ?? '', /at least 12/);
    assert.match(AdminAccount.problem('dave', 'x'.repeat(201)) ?? '', /at most 200/);
    assert.match(AdminAccount.problem('same-as-the-name', 'Same-As-The-Name') ?? '', /same as the user name/);
    assert.match(AdminAccount.problem('dave', TOKEN, TOKEN) ?? '', /ADMIN_TOKEN/);
  });

  test('keeps only a salted hash in the database, checks both the name and the password, and survives a restart', async () => {
    const account = new AdminAccount({ state: catalog, now: () => 1234 });
    assert.equal(account.isSet, false);
    assert.equal(await account.verify('dave', PASSWORD), false, 'nothing is set yet');
    await account.set(' dave ', PASSWORD);
    assert.deepEqual([account.isSet, account.user, account.changedAt], [true, 'dave', 1234]);

    const stored = catalog.getState('admin.account')!;
    assert.ok(!stored.includes(PASSWORD), 'the password is not kept');
    const record = JSON.parse(stored);
    assert.deepEqual(Object.keys(record).sort(), ['changedAt', 'cost', 'hash', 'salt', 'user']);
    assert.equal(Buffer.from(record.hash, 'base64').length, 32);
    assert.ok(!stored.toLowerCase().includes('horse'));

    assert.equal(await account.verify('dave', PASSWORD), true);
    assert.equal(await account.verify('dave', 'correct horse battery stapl'), false, 'one character short');
    assert.equal(await account.verify('someone', PASSWORD), false, 'the right password with another name');
    assert.equal(await account.verify('', ''), false);
    assert.equal(await account.verifyPassword(PASSWORD), true);
    assert.equal(await account.verifyPassword('nope'), false);
    assert.equal(await account.verify('dave', 'x'.repeat(5000)), false, 'an endless password is not hashed');

    const reborn = new AdminAccount({ state: catalog });
    assert.equal(reborn.user, 'dave');
    assert.equal(await reborn.verify('dave', PASSWORD), true);
    await reborn.set('dave', 'a different long password');
    assert.equal(await reborn.verify('dave', PASSWORD), false);
    assert.notEqual(JSON.parse(catalog.getState('admin.account')!).salt, record.salt, 'each change has its own salt');

    assert.equal(reborn.clear(), true);
    assert.equal(reborn.clear(), false);
    assert.equal(new AdminAccount({ state: catalog }).isSet, false);
  });

  test('several checks at once all finish, one hash at a time', async () => {
    const account = new AdminAccount();
    await account.set('dave', PASSWORD);
    const answers = await Promise.all([1, 2, 3, 4, 5].map((i) => account.verify('dave', i % 2 ? PASSWORD : 'wrong password here')));
    assert.deepEqual(answers, [true, false, true, false, true]);
  });

  test('a damaged record is no account at all', () => {
    catalog.setState('admin.account', '{"user":"dave"}');
    assert.equal(new AdminAccount({ state: catalog }).isSet, false);
    catalog.setState('admin.account', 'not json');
    assert.equal(new AdminAccount({ state: catalog }).isSet, false);
  });
});

describe('the browsers that are signed in', () => {
  test('a session is a random token of which only the hash is kept; it ends when asked, and after two weeks', () => {
    const catalog = new Catalog(':memory:');
    let clock = 1_000_000;
    const sessions = new Sessions({ state: catalog, now: () => clock });
    const { token, maxAgeSeconds } = sessions.create();
    assert.equal(maxAgeSeconds, 14 * 24 * 3600);
    assert.ok(token.length >= 40);
    assert.equal(sessions.valid(token), true);
    assert.equal(sessions.valid(`${token}x`), false);
    assert.equal(sessions.valid(undefined), false);
    assert.ok(!catalog.getState('admin.sessions')!.includes(token), 'the token itself is not kept');

    assert.equal(new Sessions({ state: catalog, now: () => clock }).valid(token), true, 'kept across a restart');
    assert.deepEqual(sessions.list(token).map((s) => s.current), [true]);
    assert.deepEqual(sessions.list('other').map((s) => s.current), [false]);

    clock += 14 * 24 * 3600_000 + 1;
    assert.equal(sessions.valid(token), false, 'two weeks is the end');
    assert.equal(new Sessions({ state: catalog, now: () => clock }).valid(token), false);

    const fresh = sessions.create().token;
    sessions.revoke(fresh);
    assert.equal(sessions.valid(fresh), false);
    const a = sessions.create().token;
    const b = sessions.create().token;
    assert.equal(sessions.revokeAll(), 2);
    assert.deepEqual([sessions.valid(a), sessions.valid(b)], [false, false]);
    catalog.close();
  });

  test('a session ends when the ADMIN_TOKEN it was opened under is changed', () => {
    const catalog = new Catalog(':memory:');
    const first = new Sessions({ state: catalog, binding: sessionBinding('the-first-token-value') });
    const { token } = first.create();
    assert.equal(new Sessions({ state: catalog, binding: sessionBinding('the-first-token-value') }).valid(token), true, 'the same token: still signed in after a restart');
    assert.equal(new Sessions({ state: catalog, binding: sessionBinding('a-new-token-after-a-leak') }).valid(token), false, 'a rotated token signs every browser out');
    assert.equal(new Sessions({ state: catalog, binding: sessionBinding(undefined) }).valid(token), false, 'and so does removing it');
    assert.notEqual(sessionBinding('a'), sessionBinding('b'));
    assert.ok(!catalog.getState('admin.sessions')!.includes('the-first-token-value'), 'the token is not in what is kept');
    catalog.close();
  });

  test('keeps at most ten, the oldest going first', () => {
    let clock = 5;
    const sessions = new Sessions({ now: () => (clock += 1) });
    const tokens = Array.from({ length: 12 }, () => sessions.create().token);
    assert.equal(sessions.list().length, 10);
    assert.deepEqual([sessions.valid(tokens[0]), sessions.valid(tokens[1]), sessions.valid(tokens[11])], [false, false, true]);
  });
});

describe('where to go after signing in', () => {
  test('only a path on this site, never another address or the sign-in page', () => {
    assert.equal(safeNext('/pair'), '/pair');
    assert.equal(safeNext('/admin/api/overview?x=1&y=%20'), '/admin/api/overview?x=1&y=%20');
    for (const bad of ['//evil.example/x', 'https://evil.example', 'javascript:alert(1)', '/\\evil', '', undefined, 42, '/login', '/login?next=/x', '/admin/\n', '/a b']) assert.equal(safeNext(bad), '/admin/', String(bad));
  });
});

describe('the sign-in page and the door behind it', () => {
  let catalog: Catalog;
  let account: AdminAccount;
  let sessions: Sessions;
  let signIn: SignIn;
  let admin: AdminConsole;
  let door: { url: string; close(): Promise<void> };
  let clock: number;
  let logs: string[];

  const make = async (withToken = true) => {
    const token = withToken ? TOKEN : undefined;
    catalog = new Catalog(':memory:');
    clock = Date.parse('2026-11-07T12:00:00Z');
    logs = [];
    account = new AdminAccount({ state: catalog, now: () => clock });
    sessions = new Sessions({ state: catalog, now: () => clock });
    signIn = new SignIn({ token, account, sessions, now: () => clock, log: (line) => logs.push(line) });
    admin = new AdminConsole({ now: () => clock });
    admin.provide({ catalog, env: token ? { ADMIN_TOKEN: token } : {}, status: () => ({ phase: 'running' }), startedAt: clock, log: () => {}, signIn });
    door = await serve(
      createCloudWeb({ adminToken: token, signIn, admin, pageHtml: '<!doctype html><title>setup</title>', status: () => ({ phase: 'running' }), pair: { send: async () => {}, log: async () => [] }, rooms: () => [], setRoom: () => {}, canImport: () => false, importCatalog: () => ({}) }),
    );
  };
  beforeEach(async () => make());
  afterEach(async () => {
    await door.close();
    catalog.close();
  });

  const html = { accept: 'text/html,application/xhtml+xml' };
  const page = (headers: Record<string, string> = {}) => ({ 'content-type': 'application/json', 'x-admin-console': '1', ...headers });
  const login = (body: unknown, headers: Record<string, string> = {}) => fetch(`${door.url}/login`, { method: 'POST', headers: page(headers), body: JSON.stringify(body) });
  const cookieFrom = (res: Response): string => (res.headers.getSetCookie()[0] ?? '').split(';')[0]!;
  const json = async (res: Response) => (await res.json()) as any;
  const signedIn = async (user = 'anyone', password = TOKEN): Promise<string> => {
    const res = await login({ user, password });
    assert.equal(res.status, 200);
    return cookieFrom(res);
  };

  test('a browser that is not signed in is sent to the sign-in page, which brings it back; anything else is told how to sign in', async () => {
    for (const path of ['/admin/', '/pair', '/', '/admin/api/overview?x=1']) {
      const res = await fetch(door.url + path, { headers: html, redirect: 'manual' });
      assert.equal(res.status, 302, path);
      assert.equal(res.headers.get('location'), `/login?next=${encodeURIComponent(path === '/' ? '/' : path)}`);
    }
    const api = await fetch(`${door.url}/admin/api/overview`);
    assert.equal(api.status, 401);
    assert.match(api.headers.get('www-authenticate') ?? '', /^Bearer/);
    assert.doesNotMatch(api.headers.get('www-authenticate') ?? '', /Basic/, 'no password box from the browser: the page is the way in');
    assert.match((await json(api)).error, /sign in at \/login/);
    assert.equal((await fetch(`${door.url}/admin/`, { method: 'POST', headers: html })).status, 401, 'only a page request is sent on');
    assert.equal((await fetch(`${door.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${door.url}/ping`)).status, 500);
  });

  test('the sign-in page and its two files are open, with a policy that allows no inline script', async () => {
    const res = await fetch(`${door.url}/login`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    const policy = res.headers.get('content-security-policy') ?? '';
    assert.match(policy, /script-src 'self'/);
    assert.doesNotMatch(policy, /unsafe-/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const body = await res.text();
    assert.match(body, /type="password"/);
    assert.match(body, /autocomplete="current-password"/);
    assert.doesNotMatch(body, /<script>|onclick=|<style/i);
    assert.match((await fetch(`${door.url}/login.js`)).headers.get('content-type') ?? '', /javascript/);
    assert.equal((await fetch(`${door.url}/login.css`)).status, 200);
    const script = readFileSync(new URL('../src/admin/site/login.js', import.meta.url), 'utf8');
    assert.doesNotMatch(script, /innerHTML|outerHTML|document\.write|\beval\(/);
  });

  test('the host’s token signs in with any user name, and the cookie it gets opens the pages', async () => {
    const res = await login({ user: 'whoever', password: TOKEN, next: '/pair' });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual([body.ok, body.next], [true, '/pair']);
    const setCookie = res.headers.getSetCookie()[0]!;
    assert.match(setCookie, /^mors_session=[\w-]{40,}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1209600$/);
    assert.doesNotMatch(setCookie, /Secure/, 'over plain http (a local run) the cookie is not Secure');
    const cookie = cookieFrom(res);
    for (const path of ['/admin/api/overview', '/status', '/admin/', '/pair']) assert.equal((await fetch(door.url + path, { headers: { cookie } })).status, 200, path);
    assert.ok(logs.some((line) => /signed in/.test(line)));
    assert.ok(logs.every((line) => !line.includes(TOKEN)), 'the password is never logged');

    const secure = await login({ user: 'x', password: TOKEN }, { 'x-forwarded-proto': 'https' });
    assert.match(secure.headers.getSetCookie()[0]!, /; Secure$/, 'behind https the cookie is Secure');
  });

  test('a wrong password is refused with one message whichever part is wrong, and sets no cookie', async () => {
    await account.set('dave', PASSWORD);
    for (const body of [{ user: 'dave', password: 'wrong password here' }, { user: 'someone', password: PASSWORD }, { user: '', password: '' }, {}, { user: 'dave', password: 42 }]) {
      const res = await login(body);
      assert.equal(res.status, 401, JSON.stringify(body));
      assert.equal(res.headers.getSetCookie().length, 0);
      assert.equal((await json(res)).error, 'That user name and password do not match.');
    }
    assert.equal((await fetch(`${door.url}/status`, { headers: { cookie: 'mors_session=not-a-session' } })).status, 401);
    assert.ok(logs.some((line) => /wrong user name or password/.test(line)));
  });

  test('the owner’s own user name and password sign in, and the token still does', async () => {
    await account.set('dave', PASSWORD);
    const mine = await login({ user: ' dave ', password: PASSWORD });
    assert.equal(mine.status, 200);
    assert.equal((await fetch(`${door.url}/status`, { headers: { cookie: cookieFrom(mine) } })).status, 200);
    assert.equal((await login({ user: 'anyone', password: TOKEN })).status, 200, 'the recovery way in');
    assert.equal((await fetch(`${door.url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200, 'a script or the Worker');
    assert.equal((await fetch(`${door.url}/status`, { headers: { authorization: `Basic ${Buffer.from(`x:${TOKEN}`).toString('base64')}` } })).status, 200);
    assert.equal((await fetch(`${door.url}/status`, { headers: { authorization: `Basic ${Buffer.from(`dave:${PASSWORD}`).toString('base64')}` } })).status, 401, 'the account signs in on the page only, where a slow hash is once a fortnight');
    assert.equal((await fetch(`${door.url}/status`, { headers: { authorization: `Bearer ${PASSWORD}` } })).status, 401);
  });

  test('signing in and out only from the page itself: the header, JSON and the same site', async () => {
    const body = JSON.stringify({ user: 'x', password: TOKEN });
    const raw = (headers: Record<string, string>) => fetch(`${door.url}/login`, { method: 'POST', headers, body });
    assert.equal((await raw({ 'content-type': 'application/json' })).status, 403, 'no header');
    assert.equal((await raw({ ...page(), origin: 'https://evil.example' })).status, 403);
    assert.equal((await raw({ ...page(), 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await raw({ ...page(), 'content-type': 'text/plain' })).status, 415);
    assert.equal((await fetch(`${door.url}/login`, { method: 'POST', headers: page(), body: 'not json' })).status, 400);
    assert.equal((await fetch(`${door.url}/login`, { method: 'POST', headers: page(), body: JSON.stringify({ password: 'x'.repeat(5000) }) })).status, 413);
    assert.equal((await raw({ ...page(), origin: door.url })).status, 200);
    assert.equal((await fetch(`${door.url}/logout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal(sessions.list().length, 1, 'only the good sign-in opened a session');
  });

  test('where it goes next is a path on this site, never another address', async () => {
    assert.equal((await json(await login({ user: 'x', password: TOKEN, next: '//evil.example' }))).next, '/admin/');
    assert.equal((await json(await login({ user: 'x', password: TOKEN, next: 'https://evil.example' }))).next, '/admin/');
    assert.equal((await json(await login({ user: 'x', password: TOKEN }))).next, '/admin/');
  });

  test('signing out ends that session, and a signed-in browser that opens the sign-in page is sent on', async () => {
    const cookie = await signedIn();
    const again = await fetch(`${door.url}/login?next=/pair`, { headers: { cookie, ...html }, redirect: 'manual' });
    assert.equal(again.status, 302);
    assert.equal(again.headers.get('location'), '/pair');
    const out = await fetch(`${door.url}/logout`, { method: 'POST', headers: page({ cookie }), body: '{}' });
    assert.equal(out.status, 200);
    assert.match(out.headers.getSetCookie()[0]!, /^mors_session=; .*Max-Age=0/);
    assert.equal((await fetch(`${door.url}/status`, { headers: { cookie } })).status, 401, 'the old cookie is dead, even if the browser kept it');
  });

  test('the older routes that change something refuse the session cookie from another site, and still take a script’s token', async () => {
    const cookie = await signedIn();
    const send = (headers: Record<string, string>) => fetch(`${door.url}/pair/send`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ text: 'login google' }) });
    assert.equal((await send({ cookie })).status, 200, 'a script with the cookie and no Origin');
    assert.equal((await send({ cookie, origin: door.url })).status, 200, 'the page itself');
    assert.equal((await send({ cookie, origin: 'https://evil.example' })).status, 403);
    assert.equal((await send({ cookie, 'sec-fetch-site': 'same-site' })).status, 403, 'a sibling site is another site');
    assert.equal((await send({ cookie, 'sec-fetch-site': 'cross-site', origin: door.url })).status, 403);
    assert.equal((await fetch(`${door.url}/setup/room`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ room: '!abc:localhost' }) })).status, 403);
    assert.equal((await send({ authorization: `Bearer ${TOKEN}`, origin: 'https://other.example' })).status, 200, 'the token as a header is not ambient: the Worker and scripts are unaffected');
    assert.equal((await fetch(`${door.url}/status`, { headers: { cookie, origin: 'https://evil.example' } })).status, 200, 'reading is not blocked');
  });

  test('wrong guesses are limited for the whole host, and the limit passes', async () => {
    for (let i = 0; i < 8; i += 1) assert.equal((await login({ user: 'x', password: 'wrong' })).status, 401);
    const blocked = await login({ user: 'x', password: 'wrong' });
    assert.equal(blocked.status, 429);
    assert.match((await json(blocked)).error, /Wait a minute/);
    assert.equal((await login({ user: 'x', password: TOKEN })).status, 429, 'even the right one, while the limit holds');
    assert.equal((await fetch(`${door.url}/status`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200, 'a script with the token is not held up');
    clock += 61_000;
    assert.equal((await login({ user: 'x', password: TOKEN })).status, 200);
  });

  test('with no ADMIN_TOKEN and no account nothing can sign in, and making an account opens the door', async () => {
    await door.close();
    catalog.close();
    await make(false);
    assert.equal((await fetch(`${door.url}/status`)).status, 503);
    const res = await login({ user: 'dave', password: PASSWORD });
    assert.equal(res.status, 503);
    assert.match((await json(res)).error, /Nothing is set up/);
    assert.equal((await fetch(`${door.url}/healthz`)).status, 200);
    await account.set('dave', PASSWORD);
    assert.equal((await login({ user: 'dave', password: PASSWORD })).status, 200);
  });

  describe('on the console’s Account page', () => {
    const call = (path: string, body: unknown, cookie: string) => fetch(`${door.url}/admin/api/${path}`, { method: 'POST', headers: page({ cookie }), body: JSON.stringify(body) });
    const read = async (path: string, cookie: string) => json(await fetch(`${door.url}/admin/api/${path}`, { headers: { cookie } }));

    test('shows who is set and which browsers are signed in, and never the hash', async () => {
      const cookie = await signedIn();
      let d = await read('account', cookie);
      assert.deepEqual([d.set, d.user, d.tokenSet, d.sessions.length, d.sessions[0].current], [false, null, true, 1, true]);
      assert.equal(d.policy.minPasswordChars, 12);
      await account.set('dave', PASSWORD);
      d = await read('account', cookie);
      assert.equal(d.user, 'dave');
      const text = JSON.stringify(d);
      assert.ok(!/salt|hash|scrypt/i.test(text) && !text.includes(PASSWORD));
    });

    test('setting them needs the current password (the token the first time), and the new ones have to be fit', async () => {
      const cookie = await signedIn();
      const wrong = await call('account/set', { user: 'dave', password: PASSWORD, current: 'not the token' }, cookie);
      assert.equal(wrong.status, 403);
      assert.equal(account.isSet, false);
      assert.equal((await call('account/set', { user: 'dave', password: PASSWORD }, cookie)).status, 403, 'no current password at all');
      assert.equal((await call('account/set', { user: 'dave', password: 'short', current: TOKEN }, cookie)).status, 400);
      assert.equal((await call('account/set', { user: 'dave', password: TOKEN, current: TOKEN }, cookie)).status, 400, 'not the host’s token');
      assert.equal((await call('account/set', { user: 'ab', password: PASSWORD, current: TOKEN }, cookie)).status, 400);
      assert.equal(account.isSet, false);
      assert.equal(admin.audit.list().length, 0);
    });

    test('a change keeps only the hash, signs every browser out, and the new password signs in; the old one does not', async () => {
      const cookie = await signedIn();
      const other = await signedIn('someone-else');
      const done = await call('account/set', { user: 'dave', password: PASSWORD, current: TOKEN }, cookie);
      assert.equal(done.status, 200);
      assert.match((await json(done)).message, /sign in as dave/);
      assert.deepEqual([account.user, await account.verify('dave', PASSWORD)], ['dave', true]);
      for (const old of [cookie, other]) assert.equal((await fetch(`${door.url}/status`, { headers: { cookie: old } })).status, 401, 'every browser signs in again');
      assert.equal((await login({ user: 'dave', password: PASSWORD })).status, 200);
      assert.equal((await login({ user: 'dave', password: 'correct horse battery stapl' })).status, 401);

      const fresh = await signedIn('dave', PASSWORD);
      const again = await call('account/set', { user: 'dave2', password: 'another long password!', current: PASSWORD }, fresh);
      assert.equal(again.status, 200, 'now the current password is the account’s');
      assert.equal((await call('account/set', { user: 'dave3', password: 'yet another long one', current: PASSWORD }, await signedIn('dave2', 'another long password!'))).status, 403, 'the old one is no longer current');

      const entries = admin.audit.list();
      assert.deepEqual(entries.map((e) => [e.what, e.from, e.to]), [['change sign-in', 'dave', 'dave2'], ['change sign-in', 'ADMIN_TOKEN only', 'dave']]);
      const everything = JSON.stringify(entries) + logs.join('\n') + catalog.getState('admin.audit')!;
      for (const secret of [PASSWORD, 'another long password!', TOKEN]) assert.ok(!everything.includes(secret), 'no password in the record or the log');
    });

    test('removing them needs the password, and is refused when the host has no ADMIN_TOKEN to fall back on', async () => {
      await account.set('dave', PASSWORD);
      const cookie = await signedIn('dave', PASSWORD);
      assert.equal((await call('account/clear', { current: 'wrong password!!' }, cookie)).status, 403);
      assert.equal(account.isSet, true);
      assert.equal((await call('account/clear', { current: PASSWORD }, cookie)).status, 200);
      assert.equal(account.isSet, false);
      assert.equal((await fetch(`${door.url}/status`, { headers: { cookie } })).status, 401, 'signed out by it');
      assert.equal((await login({ user: 'x', password: TOKEN })).status, 200);
      assert.equal((await call('account/clear', { current: TOKEN }, await signedIn())).status, 404, 'nothing to remove');
      assert.deepEqual(admin.audit.list().map((e) => e.what), ['remove own sign-in']);

      await door.close();
      catalog.close();
      await make(false);
      await account.set('dave', PASSWORD);
      const alone = await signedIn('dave', PASSWORD);
      const refused = await call('account/clear', { current: PASSWORD }, alone);
      assert.equal(refused.status, 409);
      assert.match((await json(refused)).error, /no way in/);
      assert.equal(account.isSet, true);
    });

    test('signing out everywhere ends every session', async () => {
      const mine = await signedIn();
      const other = await signedIn();
      assert.equal((await call('account/signout-all', {}, mine)).status, 200);
      for (const cookie of [mine, other]) assert.equal((await fetch(`${door.url}/status`, { headers: { cookie } })).status, 401);
      assert.deepEqual(admin.audit.list().map((e) => e.what), ['signed out everywhere']);
    });

    test('is guarded like every other change: the header, the same site, and a wrong password counts against the limit', async () => {
      const cookie = await signedIn();
      const bare = await fetch(`${door.url}/admin/api/account/set`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ user: 'dave', password: PASSWORD, current: TOKEN }) });
      assert.equal(bare.status, 403);
      const foreign = await fetch(`${door.url}/admin/api/account/set`, { method: 'POST', headers: page({ cookie, origin: 'https://evil.example' }), body: JSON.stringify({ user: 'dave', password: PASSWORD, current: TOKEN }) });
      assert.equal(foreign.status, 403);
      assert.equal(account.isSet, false);
      for (let i = 0; i < 8; i += 1) assert.equal((await call('account/set', { user: 'dave', password: PASSWORD, current: `wrong ${i}` }, cookie)).status, 403);
      const limited = await call('account/set', { user: 'dave', password: PASSWORD, current: TOKEN }, cookie);
      assert.equal(limited.status, 429, 'guessing the current password is limited, like signing in');
      assert.equal(account.isSet, false);
    });
  });
});
