import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AdminConsole } from '../src/admin/console.ts';
import { Catalog } from '../src/catalog.ts';
import { hostRestarter } from '../src/cloud/host-restart.ts';
import { PeopleDesk } from '../src/cloud/people-desk.ts';
import { PEOPLE_OBJECT, PeopleList } from '../src/cloud/people-list.ts';
import { createCloudWeb } from '../src/cloud/web.ts';
import { FakeBucket } from './helpers/fake-bucket.ts';

// The People tab's routes: add, remove and restart. They go through the console's own checks (the password, the console header, the same
// site, JSON, sixty changes a minute) and hand the work to the desk (src/cloud/people-desk.ts), which these tests build over a bucket in memory.

const TOKEN = 'people-console-token-7731';
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

describe('the People tab’s routes', () => {
  let catalog: Catalog;
  let admin: AdminConsole;
  let door: { url: string; close(): Promise<void> };
  let bucket: FakeBucket;
  let signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }>;
  let timers: Array<() => void>;
  let logs: string[];
  let running: string[];
  let fromRender: string[];
  let status: () => Record<string, unknown>;

  const make = async (options: { noBucket?: boolean; noDesk?: boolean; hostPid?: string } = {}) => {
    catalog = new Catalog(':memory:');
    bucket = new FakeBucket();
    signals = [];
    timers = [];
    logs = [];
    admin = new AdminConsole();
    const desk = new PeopleDesk({
      fromRender,
      running,
      reserved: ['me'],
      list: options.noBucket ? undefined : new PeopleList({ store: bucket.s3, reserved: ['me'] }),
      restarter: hostRestarter({ HOST_PID: options.hostPid ?? '4242' }, { kill: (pid, signal) => void signals.push({ pid, signal }), setTimer: (work) => void timers.push(work), ownPid: 1 }),
      bootId: 1234,
      log: (line) => logs.push(line),
    });
    admin.provide({
      catalog,
      env: { ADMIN_TOKEN: TOKEN, SECRET_KEY: 'the-master-secret-value', R2_SECRET_ACCESS_KEY: 'r2-secret-value' },
      log: (line) => logs.push(line),
      status: () => status(),
      ...(options.noDesk ? {} : { people: desk }),
    });
    door = await serve(createCloudWeb({ adminToken: TOKEN, admin, status: () => ({}), pair: { send: async () => {}, log: async () => [] }, rooms: () => [], setRoom: () => {}, canImport: () => false, importCatalog: () => ({}) }));
  };
  beforeEach(async () => {
    running = [];
    fromRender = [];
    status = () => ({ people: [], sentThisMonthMb: 0, sentTotalThisMonthMb: 0 });
    await make();
  });
  afterEach(async () => {
    await door.close();
    catalog.close();
  });
  const remake = async (options: Parameters<typeof make>[0] = {}) => {
    await door.close();
    catalog.close();
    await make(options);
  };

  const get = (path: string) => fetch(`${door.url}/admin/api/${path}`, { headers: { authorization: basic } });
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(`${door.url}/admin/api/${path}`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/json', 'x-admin-console': '1', ...headers }, body: JSON.stringify(body) });
  const json = async (res: Response) => (await res.json()) as any;
  const saved = (): string[] => (bucket.objects.has(PEOPLE_OBJECT) ? JSON.parse(bucket.objects.get(PEOPLE_OBJECT)!.body).people.map((one: { id: string }) => one.id) : []);

  describe('every one of them wants what every change wants', () => {
    for (const route of ['people/add', 'people/remove', 'people/restart']) {
      test(`${route}: the password, the console header, the same site, and JSON; nothing is changed without them`, async () => {
        const body = JSON.stringify({ name: 'alice', confirm: true });
        assert.equal((await fetch(`${door.url}/admin/api/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-console': '1' }, body })).status, 401, 'no password');
        assert.equal((await fetch(`${door.url}/admin/api/${route}`, { method: 'POST', headers: { authorization: basic, 'content-type': 'application/json' }, body })).status, 403, 'no console header');
        assert.equal((await post(route, { name: 'alice', confirm: true }, { origin: 'https://evil.example' })).status, 403, 'another site');
        assert.equal((await post(route, { name: 'alice', confirm: true }, { 'sec-fetch-site': 'cross-site' })).status, 403, 'a browser says cross-site');
        assert.equal((await fetch(`${door.url}/admin/api/${route}`, { method: 'POST', headers: { authorization: basic, 'x-admin-console': '1', 'content-type': 'text/plain' }, body })).status, 415, 'not JSON');
        assert.equal((await fetch(`${door.url}/admin/api/${route}`, { method: 'GET', headers: { authorization: basic } })).status, 404, 'a GET changes nothing');
        assert.deepEqual([saved(), signals, timers.length], [[], [], 0]);
      });
    }

    test('they are counted with the other changes: sixty a minute', async () => {
      let limited = 0;
      for (let i = 0; i < 65; i++) if ((await post('people/add', { name: '' })).status === 429) limited++;
      assert.equal(limited, 5);
    });

    test('before the host has provided the list they say it is starting, and the page can still be read', async () => {
      await remake({ noDesk: true });
      for (const route of ['people/add', 'people/remove', 'people/restart']) assert.equal((await post(route, { name: 'alice', confirm: true })).status, 503, route);
      const view = await json(await get('people'));
      assert.equal(view.manage, null);
      assert.deepEqual(view.people, []);
    });
  });

  describe('adding', () => {
    test('saves the name, says what comes next, and records who was added and nothing else', async () => {
      const res = await post('people/add', { name: ' Alice ' });
      assert.equal(res.status, 200);
      const done = await json(res);
      assert.deepEqual([done.ok, done.id, done.pendingRestart, done.restartAvailable], [true, 'alice', true, true]);
      assert.match(done.message, /alice is saved/);
      assert.match(done.message, /Connect tab/);
      assert.deepEqual(saved(), ['alice']);
      assert.deepEqual([signals, timers.length], [[], 0], 'adding restarts nothing by itself');
      const audit = (await json(await get('audit'))).entries;
      assert.equal(audit.length, 1);
      assert.deepEqual([audit[0].what, audit[0].detail], ['added a person', 'alice']);
      const everything = JSON.stringify(audit) + logs.join('\n') + JSON.stringify(done);
      for (const secret of ['the-master-secret-value', 'r2-secret-value', TOKEN, 'password', 'token']) assert.ok(!everything.toLowerCase().includes(secret.toLowerCase()), `${secret} in the record`);
    });

    test('a bad name is a 400 in plain words, a name already there a 409, and nothing is saved or recorded', async () => {
      fromRender = ['zed'];
      running = ['zed'];
      await remake();
      for (const [name, status, pattern] of [['', 400, /Type a name/], ['A', 400, /2 to 16/], ['two names', 400, /One name at a time/], ['me', 400, /reserved/], ['gmessagesx', 400, /bridge/], ['zed', 409, /already set in the PEOPLE variable/]] as const) {
        const res = await post('people/add', { name });
        assert.equal(res.status, status, name);
        assert.match((await json(res)).error, pattern, name);
      }
      assert.equal((await post('people/add', {})).status, 400);
      assert.equal((await post('people/add', { name: 42 })).status, 400);
      await post('people/add', { name: 'alice' });
      const again = await post('people/add', { name: 'alice' });
      assert.equal(again.status, 409);
      assert.match((await json(again)).error, /already added/);
      assert.deepEqual(saved(), ['alice']);
      assert.equal((await json(await get('audit'))).entries.length, 1, 'only the one that worked');
    });

    test('without the bucket it cannot save and says why in plain words; PEOPLE in Render is what works', async () => {
      await remake({ noBucket: true });
      const res = await post('people/add', { name: 'alice' });
      assert.equal(res.status, 409);
      const said = (await json(res)).error;
      assert.match(said, /R2 settings/);
      assert.match(said, /PEOPLE in Render still works/);
      assert.equal((await json(await get('audit'))).entries.length, 0);
    });

    test('several at once all land, none overwrites another', async () => {
      const results = await Promise.all(['alice', 'bob', 'carol', 'dina', 'erin'].map((name) => post('people/add', { name })));
      assert.deepEqual(results.map((res) => res.status), [200, 200, 200, 200, 200]);
      assert.deepEqual(saved().sort(), ['alice', 'bob', 'carol', 'dina', 'erin']);
      assert.equal((await json(await get('audit'))).entries.length, 5);
    });

    test('a bucket that fails is a 503 that says nothing was changed', async () => {
      bucket.s3.put = async () => {
        throw new Error('R2 refused writing config/people.json (HTTP 503)');
      };
      const res = await post('people/add', { name: 'alice' });
      assert.equal(res.status, 503);
      assert.match((await json(res)).error, /nothing was changed/);
      assert.equal((await json(await get('audit'))).entries.length, 0);
    });
  });

  describe('removing', () => {
    test('wants the confirmation in the request itself; without it nothing is changed', async () => {
      await post('people/add', { name: 'alice' });
      const res = await post('people/remove', { name: 'alice' });
      assert.equal(res.status, 400);
      assert.match((await json(res)).error, /Confirm first/);
      assert.equal((await post('people/remove', { name: 'alice', confirm: 'yes' })).status, 400, 'only true is a yes');
      assert.deepEqual(saved(), ['alice']);
    });

    test('takes a name added here out; a restart is needed only if they were running', async () => {
      running = ['alice'];
      await remake();
      await post('people/add', { name: 'alice' });
      await post('people/add', { name: 'bob' });
      const done = await json(await post('people/remove', { name: 'alice', confirm: true }));
      assert.deepEqual([done.ok, done.id, done.wasRunning, done.pendingRestart], [true, 'alice', true, true]);
      assert.match(done.message, /restart/);
      const quiet = await json(await post('people/remove', { name: 'bob', confirm: true }));
      assert.deepEqual([quiet.wasRunning, quiet.pendingRestart], [false, true], 'alice is still leaving');
      assert.deepEqual(saved(), []);
      const audit = (await json(await get('audit'))).entries.map((entry: { what: string; detail: string }) => [entry.what, entry.detail]);
      assert.deepEqual(audit.filter((entry: string[]) => entry[0] === 'removed a person'), [['removed a person', 'bob'], ['removed a person', 'alice']]);
    });

    test('a name set in Render cannot be removed here, and a name nobody has is a 404', async () => {
      fromRender = ['zed'];
      running = ['zed'];
      await remake();
      const render = await post('people/remove', { name: 'zed', confirm: true });
      assert.equal(render.status, 409);
      assert.match((await json(render)).error, /set in the PEOPLE variable in Render/);
      assert.equal((await post('people/remove', { name: 'nobody', confirm: true })).status, 404);
      assert.equal((await post('people/remove', { name: '', confirm: true })).status, 400);
      assert.equal((await json(await get('audit'))).entries.length, 0);
    });
  });

  describe('restarting', () => {
    test('never without the confirmation in the request: it answers 400 and signals nothing', async () => {
      await post('people/add', { name: 'alice' });
      for (const body of [{}, { confirm: false }, { confirm: 'true' }, { confirm: 1 }, { restart: true }]) {
        const res = await post('people/restart', body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match((await json(res)).error, /Confirm the restart/);
      }
      assert.deepEqual([signals, timers.length], [[], 0]);
    });

    test('answers the page first; the host is asked a few seconds later', async () => {
      await post('people/add', { name: 'alice' });
      const res = await post('people/restart', { confirm: true });
      assert.equal(res.status, 200);
      const done = await json(res);
      assert.deepEqual([done.ok, done.inSeconds], [true, 3]);
      // The answer is in the page's hands and the signal has not gone: it goes when the timer fires.
      assert.deepEqual(signals, [{ pid: 4242, signal: 0 }]);
      assert.equal(timers.length, 1);
      timers[0]!();
      assert.deepEqual(signals.at(-1), { pid: 4242, signal: 'SIGUSR2' });
      const audit = (await json(await get('audit'))).entries;
      assert.deepEqual(audit.map((entry: { what: string }) => entry.what), ['restarted the host', 'added a person']);
      assert.ok(logs.some((line) => /being restarted to apply the list of people/.test(line)));
    });

    test('only once: while one is on its way a second is a 409, and so are changes to the list', async () => {
      await post('people/add', { name: 'alice' });
      assert.equal((await post('people/restart', { confirm: true })).status, 200);
      const second = await post('people/restart', { confirm: true });
      assert.equal(second.status, 409);
      assert.match((await json(second)).error, /already on its way/);
      assert.equal((await post('people/add', { name: 'bob' })).status, 409);
      assert.equal((await post('people/remove', { name: 'alice', confirm: true })).status, 409);
      assert.equal(timers.length, 1);
      assert.equal((await json(await get('audit'))).entries.filter((entry: { what: string }) => entry.what === 'restarted the host').length, 1);
    });

    test('three at once make one restart', async () => {
      await post('people/add', { name: 'alice' });
      const results = await Promise.all([post('people/restart', { confirm: true }), post('people/restart', { confirm: true }), post('people/restart', { confirm: true })]);
      assert.deepEqual(results.map((res) => res.status).sort(), [200, 409, 409]);
      assert.equal(timers.length, 1);
    });

    test('nothing waiting is a 409, not a restart', async () => {
      const res = await post('people/restart', { confirm: true });
      assert.equal(res.status, 409);
      assert.match((await json(res)).error, /Nothing is waiting/);
      assert.deepEqual([signals, timers.length], [[], 0]);
    });

    test('a host that cannot restart itself says to restart the service in Render', async () => {
      await remake({ hostPid: '' });
      await post('people/add', { name: 'alice' });
      const res = await post('people/restart', { confirm: true });
      assert.equal(res.status, 409);
      assert.match((await json(res)).error, /Render/);
      assert.equal(timers.length, 0);
    });
  });

  describe('what the tab reads', () => {
    test('the list beside the people who are running: who is set in Render, who was added, who waits, and the restart', async () => {
      fromRender = ['zed'];
      running = ['zed', 'alice'];
      status = () => ({ people: [{ id: 'zed', phase: 'running' }, { id: 'alice', phase: 'setup', bridge: { state: 'CONNECTED' } }], sentThisMonthMb: 1, sentTotalThisMonthMb: 2 });
      await remake();
      await post('people/add', { name: 'alice' });
      await post('people/add', { name: 'bob' });
      const view = await json(await get('people'));
      assert.deepEqual(view.people.map((one: { id: string }) => one.id), ['zed', 'alice']);
      assert.deepEqual(view.manage.entries.map((entry: { id: string; source: string; state: string }) => `${entry.id}:${entry.source}:${entry.state}`), ['zed:render:running', 'alice:console:running', 'bob:console:adding']);
      assert.deepEqual([view.manage.canChange, view.manage.pendingRestart, view.manage.bootId, view.manage.restart], [true, true, 1234, { available: true, whyNot: null, pending: false }]);
    });

    test('says plainly when the list cannot be read, and the rest of the tab still reads', async () => {
      bucket.s3.get = async () => {
        throw new Error('R2 refused reading config/people.json (HTTP 500)');
      };
      const view = await json(await get('people'));
      assert.equal(view.manage.canChange, false);
      assert.match(view.manage.whyNot, /R2 refused reading/);
      assert.deepEqual(view.people, []);
    });

    test('no secret is in anything the routes say', async () => {
      await post('people/add', { name: 'alice' });
      const everything = [await (await get('people')).text(), await (await post('people/restart', { confirm: true })).text(), await (await get('audit')).text(), logs.join('\n')].join('\n');
      for (const secret of ['the-master-secret-value', 'r2-secret-value', TOKEN]) assert.ok(!everything.includes(secret), secret);
    });
  });
});

describe('the page', () => {
  const page = readFileSync(new URL('../src/admin/site/app.js', import.meta.url), 'utf8');

  test('builds everything with textContent: no innerHTML, outerHTML, document.write or eval', () => {
    assert.doesNotMatch(page, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  });

  test('no longer tells the owner to put names in PEOPLE in Render to add someone', () => {
    // The only mentions left are of names "set in Render" that the page cannot remove.
    assert.doesNotMatch(page, /put their name[^']*in PEOPLE/i);
    assert.doesNotMatch(page, /To add someone, put/);
    assert.doesNotMatch(page, /Add: put their name in PEOPLE/);
    assert.doesNotMatch(page, /Then take them out of PEOPLE in Render/);
    assert.doesNotMatch(page, /before ' \+ who \+ ' is taken out of PEOPLE/);
  });

  test('asks the owner’s confirmation in the page for adding, removing and restarting, in the words the owner was promised', () => {
    assert.match(page, /This restarts the bot for about a minute\. Continue\?/);
    assert.match(page, /log .*out of Google first/i);
    assert.match(page, /people\/add/);
    assert.match(page, /people\/remove/);
    assert.match(page, /people\/restart/);
    assert.match(page, /set in Render/);
  });

  test('says the rule for a name in plain words', () => {
    assert.match(page, /lower-case letters and digits, 2 to 16/);
    assert.match(page, /"me" or "owner"/);
    assert.match(page, /"gmessages"/);
  });
});
