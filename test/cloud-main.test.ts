import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeBridgeDb } from './helpers/bridge-db.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';
import { listen, readBuffer, type Listening } from './helpers/servers.ts';

// The cloud host's entry (src/cloud-main.ts) run for real, as a process, against mock homeservers (behind one address, as the real one is), a
// mock bridge and a bridge-database fixture, from a folder with no .env. With nobody in PEOPLE it starts exactly as it always did (the owner's
// room is joined, and matrix-main.ts is imported); with people the host is built before any room is joined and each person's chat is added when
// their own room is.

const ENTRY = fileURLToPath(new URL('../src/cloud-main.ts', import.meta.url));
const ADMIN = 'cloud-main-test-token';
const OWNER_ROOM = '!owner-portal:localhost';
const ALICE_ROOM = '!alice-portal:localhost';
const OWNER_PHONE = '+15551110001';
const ALICE_PHONE = '+15552220002';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(ready: () => boolean | Promise<boolean>, what: string | (() => string), ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${typeof what === 'string' ? what : what()}`);
    await sleep(15);
  }
}

/** One address for several accounts' homeservers: a request goes to the account whose token (or sign-in name) it carries, as on the real one. */
async function oneAddress(targets: MockMatrix[]): Promise<Listening> {
  return listen(async (req, res) => {
    const body = await readBuffer(req);
    const bearer = req.headers.authorization ?? '';
    let target = targets.find((one) => bearer === `Bearer ${one.token}`);
    if (!target && (req.url ?? '').includes('/login')) {
      const name = (JSON.parse(body.toString('utf8') || '{}') as { identifier?: { user?: string } }).identifier?.user;
      target = targets.find((one) => one.userId === `@${name}:localhost`);
    }
    target ??= targets[0]!;
    const headers: Record<string, string> = {};
    for (const name of ['authorization', 'content-type']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    const answer = await fetch(target.url + (req.url ?? '/'), { method: req.method ?? 'GET', headers, ...(body.length > 0 ? { body } : {}) });
    res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') ?? 'application/json' });
    res.end(Buffer.from(await answer.arrayBuffer()));
  });
}

describe('the cloud host’s entry (src/cloud-main.ts)', () => {
  let ownerMock: MockMatrix;
  let aliceMock: MockMatrix;
  let homeserver: Listening;
  let bridge: Listening;
  let asked: Array<{ user: string | null; auth: string | undefined }>;
  let folder: string;
  const running: ChildProcess[] = [];
  const folders: string[] = [];

  before(async () => {
    ownerMock = await startMockMatrix(0, { eventPrefix: 'o', roomId: OWNER_ROOM });
    aliceMock = await startMockMatrix(0, { eventPrefix: 'a', roomId: ALICE_ROOM, user: 'alice', token: 'syt_alice_token' });
    homeserver = await oneAddress([ownerMock, aliceMock]);
    // The bridge's provisioning API: everybody's Google login is connected. What it is asked, and with whose token, is kept.
    asked = [];
    bridge = await listen((req, res) => {
      const url = new URL(req.url ?? '/', 'http://bridge');
      asked.push({ user: url.searchParams.get('user_id'), auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ logins: [{ state: { state_event: 'CONNECTED' } }] }));
    });
  });
  after(async () => {
    for (const child of running) child.kill('SIGKILL');
    for (const one of folders) rmSync(one, { recursive: true, force: true });
    await Promise.all([ownerMock.close(), aliceMock.close(), homeserver.close(), bridge.close()]);
  });
  beforeEach(() => {
    ownerMock.reset();
    aliceMock.reset();
    asked.length = 0;
    folder = mkdtempSync(join(tmpdir(), 'cloud-main-'));
    folders.push(folder);
  });

  /** The bridge's database with the owner's login and chat, and alice's unless told otherwise. */
  const bridgeDatabase = (options: { alice?: boolean; aliceChat?: boolean; ownerChat?: boolean; aliceSims?: string[] } = {}): string =>
    writeBridgeDb(folder, [
      { login: 'owner@gmail.com/1', user: '@me:localhost', sims: [OWNER_PHONE], chats: options.ownerChat === false ? [] : [{ phone: OWNER_PHONE, room: OWNER_ROOM, at: 100 }] },
      ...(options.alice === false ? [] : [{ login: 'alice@gmail.com/1', user: '@alice:localhost', sims: options.aliceSims ?? [ALICE_PHONE], chats: options.aliceChat === false ? [] : [{ phone: ALICE_PHONE, room: ALICE_ROOM, at: 100 }] }]),
    ]);

  const baseEnv = (bridgeDb: string): Record<string, string> => ({
    CATALOG_DB: join(folder, 'catalog.db'),
    MATRIX_HOMESERVER: homeserver.url,
    MATRIX_ACCESS_TOKEN: ownerMock.token,
    MATRIX_ROOM_ID: OWNER_ROOM,
    BRIDGE_URL: bridge.url,
    BRIDGE_DB: bridgeDb,
    BRIDGE_AUTO_RESTART: 'off',
    ADMIN_TOKEN: ADMIN,
    PORT: '0',
    HOST: '127.0.0.1',
    YOUTUBE_MUSIC: 'off',
    MUSIC_TABLE: 'off',
    ZEMER_RELEASES: 'off',
    PREFETCH_MB: 'off',
    SONG_GAP_SECONDS: 'off',
    MATRIX_SYNC_WAIT_MS: '0',
    MATRIX_POLL_MS: '500',
    STARTUP_MESSAGE: 'off',
  });

  /** Runs the entry with exactly this environment (nothing of this process's, so no real service is reached). */
  function run(env: Record<string, string>) {
    const output = { out: '', err: '' };
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY], { cwd: folder, env: { PATH: process.env.PATH ?? '', ...env } });
    running.push(child);
    child.stdout.on('data', (chunk: Buffer) => (output.out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output.err += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${/web door open on port (\d+)/.exec(output.out)?.[1]}${path}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, ...(init.headers ?? {}) } });
    const json = async (path: string): Promise<Record<string, any>> => (await api(path)).json() as Promise<Record<string, any>>;
    const post = (path: string, body: unknown) => api(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-console': '1' }, body: JSON.stringify(body) });
    return { child, output, exited, api, json, post, status: () => json('/status') };
  }

  const bodies = (mock: MockMatrix): string[] => mock.sent.map((event) => String(event.content.body ?? ''));
  const answersHelp = async (mock: MockMatrix, whose: string): Promise<void> => {
    mock.addMessage(mock.ghost, { msgtype: 'm.text', body: 'help' });
    await until(() => bodies(mock).some((text) => /Start each message with a command/.test(text)), `${whose} to be answered`);
  };
  const state = (key?: string): string[] | string | undefined => {
    const db = new DatabaseSync(join(folder, 'catalog.db'), { readOnly: true });
    try {
      if (key === undefined) return (db.prepare('SELECT key FROM state').all() as Array<{ key: string }>).map((row) => row.key);
      return (db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    } finally {
      db.close();
    }
  };

  describe('with nobody in PEOPLE: the owner’s start as it always was', () => {
    test('opens the door, signs in, joins the owner’s room, imports the bot, and /status has the owner’s fields', async () => {
      const db = bridgeDatabase({ alice: false });
      const { child, output, exited, status, json } = run(baseEnv(db));
      await until(() => /signed in as @me:localhost, watching room !owner-portal:localhost/.test(output.out), () => `the bot to start in ${output.out}${output.err}`);
      assert.ok(output.out.indexOf('web door open') < output.out.indexOf('signed in as @me:localhost'), 'the door first');
      assert.ok(ownerMock.joinedViaApi.includes(OWNER_ROOM));
      assert.deepEqual(aliceMock.requests, [], 'no one else was ever asked anything');
      await answersHelp(ownerMock, 'the owner');

      const report = await status();
      assert.deepEqual(
        Object.keys(report).sort(),
        ['botEnabled', 'bridge', 'memory', 'memoryMb', 'node', 'people', 'phase', 'problems', 'room', 'roomGone', 'sentThisMonthMb', 'sentTotalThisMonthMb', 'timings', 'tracks', 'uptimeSeconds'],
        'the fields /status always had, and the two additions',
      );
      assert.deepEqual([report.phase, report.botEnabled, report.room, report.roomGone, report.people, report.problems], ['running', true, OWNER_ROOM, null, [], []]);
      assert.equal(report.bridge.state, 'CONNECTED');
      assert.ok(asked.length > 0 && asked.every((entry) => entry.user === '@me:localhost' && entry.auth === `Bearer ${ownerMock.token}`), 'the bridge is asked about the owner only');
      // The Connect page's state is the owner's, with no selector to draw.
      const connect = await json('/admin/api/connect');
      assert.deepEqual(Object.keys(connect.state).sort(), ['botEnabled', 'bridge', 'phase', 'problems', 'room', 'roomGone']);
      assert.equal(connect.phone, OWNER_PHONE);

      assert.doesNotMatch(output.out, /\[[a-z0-9]+\] /, 'no line is tagged with a person');
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
      assert.equal((output.out.match(/shutting down/g) ?? []).length, 1);
      const keys = state() as string[];
      assert.equal(state('matrix.phone'), OWNER_PHONE);
      assert.deepEqual(keys.filter((key) => /:(owner|alice)$/.test(key) || key.startsWith('matrix.token:')), [], 'no person’s key');
    });

    test('an owner’s room that is gone is waited on with the door up, not failed', async () => {
      const db = bridgeDatabase({ alice: false, ownerChat: false });
      ownerMock.goneRooms.push(OWNER_ROOM);
      const { child, output, exited, status } = run(baseEnv(db));
      await until(async () => ((await status().catch(() => ({}))) as Record<string, unknown>).phase === 'room-missing', () => `room-missing in ${output.out}${output.err}`);
      const report = await status();
      assert.deepEqual(report.roomGone.rooms, [OWNER_ROOM]);
      assert.equal(report.room, OWNER_ROOM);
      assert.doesNotMatch(output.out, /watching room/, 'the bot did not start');
      assert.equal(child.exitCode, null, 'still running');
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
    });
  });

  describe('with a person in PEOPLE: the host first, then each chat when its own room is joined', () => {
    const withAlice = (db: string): Record<string, string> => ({ ...baseEnv(db), PEOPLE: 'alice', PEOPLE_PASSWORDS: `alice:${aliceMock.password}` });

    test('both are answered in their own chat, /status lists alice beside the owner’s unchanged fields, and the state is kept apart', async () => {
      const db = bridgeDatabase();
      const { child, output, exited, status } = run(withAlice(db));
      await until(
        () => /signed in as @me:localhost, watching room !owner-portal:localhost/.test(output.out) && /\[alice\] signed in as @alice:localhost, watching room !alice-portal:localhost/.test(output.out),
        `both chats in ${output.out}${output.err}`,
      );
      await answersHelp(ownerMock, 'the owner');
      await answersHelp(aliceMock, 'alice');
      assert.ok(ownerMock.joinedViaApi.every((room) => room === OWNER_ROOM));
      assert.ok(aliceMock.joinedViaApi.every((room) => room === ALICE_ROOM));
      assert.ok(bodies(ownerMock).every((text) => !/alice/i.test(text)));

      const report = await status();
      assert.deepEqual([report.phase, report.botEnabled, report.room, report.roomGone], ['running', true, OWNER_ROOM, null], 'the owner’s fields are the owner’s');
      assert.deepEqual(report.problems, []);
      assert.equal(report.bridge.state, 'CONNECTED');
      assert.equal(report.people.length, 1);
      const [one] = report.people;
      assert.deepEqual(
        { id: one.id, phase: one.phase, roomMissing: one.roomMissing, room: one.room, roomGone: one.roomGone, error: one.error, simNumber: one.simNumber, sentThisMonthMb: one.sentThisMonthMb, monthlyLimitMb: one.monthlyLimitMb, problems: one.problems },
        { id: 'alice', phase: 'running', roomMissing: false, room: ALICE_ROOM, roomGone: null, error: null, simNumber: true, sentThisMonthMb: 0, monthlyLimitMb: 1000, problems: [] },
      );
      assert.equal(one.bridge.state, 'CONNECTED');
      // The gate: linked, her phone gave its number, and her own chat has arrived.
      assert.deepEqual([one.onboarding.step, one.onboarding.onboarded, one.onboarding.warn], ['onboarded', true, false]);
      // The bridge was asked about alice with alice's own token and account, and about the owner with the owner's: never one with the other's.
      assert.ok(asked.some((entry) => entry.user === '@alice:localhost' && entry.auth === 'Bearer syt_alice_token'), JSON.stringify(asked));
      assert.ok(asked.every((entry) => (entry.user === '@alice:localhost') === (entry.auth === 'Bearer syt_alice_token')), JSON.stringify(asked));

      child.kill('SIGTERM');
      assert.equal(await exited, 0);
      assert.match(output.out, /shutting down/);
      const keys = state() as string[];
      for (const key of ['matrix.room:alice', 'matrix.phone:alice', 'matrix.token:alice', 'chat.resume:alice', 'chat.resume']) assert.ok(keys.includes(key), `${key} in ${keys.join(', ')}`);
      assert.equal(state('matrix.room:alice'), ALICE_ROOM);
      assert.equal(state('matrix.phone:alice'), ALICE_PHONE);
      assert.equal(state('matrix.phone'), OWNER_PHONE);
      assert.notEqual(state('matrix.token:alice'), ownerMock.token, 'alice’s token is hers');
      assert.deepEqual(keys.filter((key) => /:owner$/.test(key)), []);
      assert.ok(keys.includes('onboarding.linked:alice') && keys.includes('onboarding.proved:alice'), keys.join(', '));
      assert.deepEqual(keys.filter((key) => /^onboarding\.[a-z]+$/.test(key)), [], 'the owner has no record of the gate');
    });

    test('the Connect page and the older routes reach alice’s own window to the bridge, and never the owner’s', async () => {
      const db = bridgeDatabase();
      const { child, output, exited, json, post } = run(withAlice(db));
      await until(() => /\[alice\] signed in as @alice:localhost/.test(output.out) && /Z signed in as @me:localhost/.test(output.out), () => `both chats in ${output.out}${output.err}`);

      const owners = await json('/admin/api/connect');
      assert.deepEqual(owners.state.people, [{ id: 'alice', phase: 'running' }], 'the owner’s page can draw its selector');
      assert.equal(owners.state.phase, 'running');
      const hers = await json('/admin/api/connect?person=alice');
      assert.deepEqual([hers.state.person, hers.state.phase, hers.state.room, hers.state.error, hers.phone, hers.oneDrive, hers.alerts], ['alice', 'running', ALICE_ROOM, null, ALICE_PHONE, null, false]);
      assert.deepEqual(hers.people, ['alice'], 'the page is told who else there is');
      assert.deepEqual([hers.state.simNumber, hers.state.onboarding.step, hers.state.onboarding.onboarded], [true, 'onboarded', true]);
      assert.deepEqual(Object.keys(owners.state).sort(), ['botEnabled', 'bridge', 'people', 'phase', 'problems', 'room', 'roomGone'], 'the owner’s state has no gate in it');
      // The console's People view: read only, one entry, nothing of any secret.
      const people = await json('/admin/api/people');
      assert.deepEqual(people.people.map((one: { id: string; simNumber: boolean; phase: string; bridge: string }) => [one.id, one.simNumber, one.phase, one.bridge]), [['alice', true, 'running', 'CONNECTED']]);
      assert.ok(!JSON.stringify(people).includes(aliceMock.password) && !JSON.stringify(people).includes('syt_alice_token'));
      assert.equal(hers.state.bridge.state, 'CONNECTED');
      assert.equal((await (await fetch(`http://127.0.0.1:${/web door open on port (\d+)/.exec(output.out)?.[1]}/admin/api/connect?person=mallory`, { headers: { authorization: `Bearer ${ADMIN}` } })).status), 404);

      assert.equal((await post('/admin/api/connect/start', { person: 'alice' })).status, 200);
      await until(() => bodies(aliceMock).includes('login google'), 'alice’s window to say it');
      assert.deepEqual(bodies(ownerMock).filter((text) => text === 'login google'), [], 'the owner’s account said nothing');
      assert.equal((await post('/pair/send', { text: 'help', person: 'alice' })).status, 200);
      assert.equal((await post('/pair/send', { text: 'login google' })).status, 200);
      await until(() => bodies(ownerMock).includes('login google'), 'the owner’s window to say it');
      assert.equal(bodies(aliceMock).filter((text) => text === 'login google').length, 1, 'and not alice’s');
      assert.equal((await post('/pair/send', { text: 'x', person: 'mallory' })).status, 400);
      assert.deepEqual((await json('/pair/log?person=alice')).lines.map((line: { text: string }) => line.text), []);

      child.kill('SIGTERM');
      assert.equal(await exited, 0);
    });

    test('the owner’s room gone does not keep alice from being answered: the host does not wait for a room', async () => {
      const db = bridgeDatabase({ ownerChat: false });
      ownerMock.goneRooms.push(OWNER_ROOM);
      const { child, output, exited, status } = run(withAlice(db));
      await until(() => /\[alice\] signed in as @alice:localhost, watching room !alice-portal:localhost/.test(output.out), () => `alice’s chat in ${output.out}${output.err}`);
      await answersHelp(aliceMock, 'alice');
      await until(async () => (await status()).phase === 'room-missing', 'the owner to be waiting');
      const report = await status();
      assert.deepEqual(report.roomGone.rooms, [OWNER_ROOM]);
      assert.equal(report.people[0].phase, 'running');
      assert.deepEqual(report.people[0].problems, [], 'the owner’s alert is the owner’s');
      assert.equal(report.problems.length, 1);
      assert.equal(report.problems[0].key, 'room');
      assert.doesNotMatch(output.out, /Z signed in as @me:localhost, watching room/, 'the owner’s chat did not start');
      assert.equal(child.exitCode, null, 'and nothing ended');
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
    });

    test('alice’s room gone is alice’s alone: her phase and her alert are in her entry, the owner is answered and has no problem listed', async () => {
      const db = bridgeDatabase();
      aliceMock.goneRooms.push(ALICE_ROOM);
      const { child, output, exited, status } = run(withAlice(db));
      await until(() => /Z signed in as @me:localhost, watching room !owner-portal:localhost/.test(output.out), () => `the owner’s chat in ${output.out}${output.err}`);
      await answersHelp(ownerMock, 'the owner');
      await until(async () => (await status()).people[0].phase === 'room-missing', 'alice to be waiting');
      const report = await status();
      assert.deepEqual([report.phase, report.room, report.roomGone, report.problems], ['running', OWNER_ROOM, null, []], 'the owner’s fields do not carry her trouble');
      const [one] = report.people;
      assert.deepEqual([one.phase, one.roomMissing, one.roomGone.rooms], ['room-missing', true, [ALICE_ROOM]]);
      assert.deepEqual(one.problems.map((problem: { key: string }) => problem.key), ['room:alice']);
      assert.match(one.problems[0].message, /^alice's chat room is gone \(!alice-portal:localhost\)/);
      assert.equal(output.out.includes('stopped'), false);
      // The Connect page: her state names her trouble, the owner's does not.
      const hers = (await (await fetch(`http://127.0.0.1:${/web door open on port (\d+)/.exec(output.out)?.[1]}/admin/api/connect?person=alice`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as Record<string, any>;
      assert.equal(hers.state.phase, 'room-missing');
      assert.deepEqual(hers.state.roomGone.rooms, [ALICE_ROOM]);
      assert.deepEqual(hers.state.problems.map((problem: { key: string }) => problem.key), ['room:alice']);
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
    });

    test('alice’s account that cannot be signed in does not keep the owner from being answered, and /status says where she is', async () => {
      const db = bridgeDatabase();
      const { child, output, exited, status } = run({ ...withAlice(db), PEOPLE_PASSWORDS: 'alice:the-wrong-password' });
      await until(() => /Z signed in as @me:localhost, watching room !owner-portal:localhost/.test(output.out), () => `the owner’s chat in ${output.out}${output.err}`);
      await answersHelp(ownerMock, 'the owner');
      const report = await status();
      assert.equal(report.phase, 'running');
      assert.equal(report.people[0].id, 'alice');
      assert.equal(report.people[0].phase, 'starting');
      assert.equal(report.people[0].bridge.state, undefined);
      assert.deepEqual(aliceMock.joinedViaApi, []);
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
    });

    test('a person the host handed no password for is said once and left out; the owner is answered', async () => {
      const db = bridgeDatabase();
      const { PEOPLE_PASSWORDS: _unused, ...env } = withAlice(db);
      const { child, output, exited, status } = run(env);
      await until(() => /Z signed in as @me:localhost, watching room !owner-portal:localhost/.test(output.out), () => `the owner’s chat in ${output.out}${output.err}`);
      await answersHelp(ownerMock, 'the owner');
      await until(async () => (await status()).people[0].error !== null, 'the reason to be reported');
      const report = await status();
      assert.match(report.people[0].error, /handed over no Matrix password for alice/);
      assert.equal(report.people[0].phase, 'starting');
      assert.equal((output.out.match(/handed over no password for "alice"/g) ?? []).length, 1, 'said once at the start');
      assert.deepEqual(aliceMock.requests.filter((request) => request.path.includes('/login')), [], 'no sign-in was tried');
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
    });

    test('alice linked with a number but has not texted herself yet: /status and her Connect page say she is waiting, the owner is untouched', async () => {
      const db = bridgeDatabase({ aliceChat: false });
      const { child, output, exited, status, json } = run(withAlice(db));
      await until(() => /Z signed in as @me:localhost, watching room !owner-portal:localhost/.test(output.out), () => `the owner’s chat in ${output.out}${output.err}`);
      await until(async () => (await status()).people[0].phase === 'setup', 'alice to be waiting for her chat');
      const report = await status();
      const [one] = report.people;
      assert.deepEqual([one.simNumber, one.onboarding.step, one.onboarding.onboarded, one.onboarding.warn], [true, 'waiting-for-chat', false, false]);
      assert.match(one.onboarding.message, /Waiting for alice to text themself once/);
      assert.deepEqual([report.phase, report.problems], ['running', []], 'the gate raises nothing against the owner');
      const hers = await json('/admin/api/connect?person=alice');
      assert.deepEqual([hers.state.simNumber, hers.state.onboarding.step], [true, 'waiting-for-chat']);
      const people = await json('/admin/api/people');
      assert.deepEqual(people.people.map((p: { onboarding: { step: string } }) => p.onboarding.step), ['waiting-for-chat']);
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
      assert.ok((state('onboarding.linked:alice') as string).length > 0);
      assert.equal(state('onboarding.proved:alice'), undefined);
    });

    test('alice’s login reports no phone number: /status, her Connect page and the People view warn at once', async () => {
      const db = bridgeDatabase({ aliceChat: false, aliceSims: [] });
      const { child, output, exited, status, json } = run(withAlice(db));
      await until(() => /Z signed in as @me:localhost, watching room !owner-portal:localhost/.test(output.out), () => `the owner’s chat in ${output.out}${output.err}`);
      await until(async () => (await status()).people[0].simNumber === false, 'the number to be reported missing');
      const [one] = (await status()).people;
      assert.deepEqual([one.simNumber, one.onboarding.step, one.onboarding.warn, one.onboarding.onboarded], [false, 'no-number', true, false]);
      assert.match(one.onboarding.message, /unlink alice/);
      const hers = await json('/admin/api/connect?person=alice');
      assert.deepEqual([hers.state.simNumber, hers.state.onboarding.step, hers.state.onboarding.warn], [false, 'no-number', true]);
      const people = await json('/admin/api/people');
      assert.deepEqual([people.people[0].simNumber, people.people[0].onboarding.warn], [false, true]);
      assert.equal((await status()).phase, 'running');
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
    });

    test('a request pasted for alice is taken out of her chat with the bot even if the host is killed in the minute: the next start does it', async () => {
      const db = bridgeDatabase();
      const COOKIES = "curl 'https://messages.google.com/web/config' \\\n  -H 'cookie: SID=alicecookie; SAPISID=alicesapisid' \\\n  -H 'x: y'";
      const first = run(withAlice(db));
      await until(() => /\[alice\] signed in as @alice:localhost, watching room !alice-portal:localhost/.test(first.output.out), () => `alice’s chat in ${first.output.out}${first.output.err}`);
      assert.equal((await first.post('/admin/api/connect/send', { person: 'alice', text: COOKIES })).status, 200);
      await until(() => aliceMock.sent.some((event) => String(event.content.body ?? '').includes('SAPISID=alicesapisid')), 'the paste to be sent as alice');
      const pasteEvent = aliceMock.sent.find((event) => String(event.content.body ?? '').includes('SAPISID'))!.eventId;
      assert.deepEqual(aliceMock.redactions, [], 'the minute is not up');
      first.child.kill('SIGKILL');
      await first.exited;
      const kept = JSON.parse(state('pair.redactions') as string) as Array<{ user: string; event: string; due: number }>;
      assert.deepEqual(kept.map((one) => [one.user, one.event]), [['@alice:localhost', pasteEvent]], 'remembered under her account');
      assert.ok(!(state('pair.redactions') as string).includes('alicecookie'), 'the request itself is never kept in the state');
      // The minute passes while the host is down.
      const db2 = new DatabaseSync(join(folder, 'catalog.db'));
      db2.prepare('UPDATE state SET value = ? WHERE key = ?').run(JSON.stringify(kept.map((one) => ({ ...one, due: Date.now() - 1000 }))), 'pair.redactions');
      db2.close();
      const next = run(withAlice(db));
      await until(() => aliceMock.redactions.includes(pasteEvent), () => `the paste to be deleted in ${next.output.out}${next.output.err}`);
      assert.deepEqual(ownerMock.redactions, [], 'the owner’s account redacted nothing');
      await until(() => (state('pair.redactions') as string) === '[]', 'it to be forgotten');
      assert.ok(!(next.output.out + next.output.err).includes('alicecookie'), 'and never logged');
      next.child.kill('SIGTERM');
      assert.equal(await next.exited, 0);
    });

    test('alice linked Google Messages but has not texted herself yet: choosing her chat on the older route starts it, and not the owner’s', async () => {
      const db = bridgeDatabase({ aliceChat: false });
      const { child, output, exited, post, status } = run(withAlice(db));
      await until(() => /Z signed in as @me:localhost, watching room !owner-portal:localhost/.test(output.out), () => `the owner’s chat in ${output.out}${output.err}`);
      await until(async () => (await status()).people[0].phase === 'setup', 'alice to be waiting for her chat');
      assert.equal((await post('/setup/room', { room: OWNER_ROOM, person: 'alice' })).status, 409, 'the owner’s chat is not hers to choose');
      assert.equal((await post('/setup/room', { room: ALICE_ROOM, person: 'alice' })).status, 200);
      await until(() => /\[alice\] signed in as @alice:localhost, watching room !alice-portal:localhost/.test(output.out), () => `alice’s chat in ${output.out}${output.err}`);
      await answersHelp(aliceMock, 'alice');
      child.kill('SIGTERM');
      assert.equal(await exited, 0);
      assert.equal(state('matrix.room:alice'), ALICE_ROOM);
      assert.equal(state('matrix.room'), undefined, 'the owner’s room is the one given in MATRIX_ROOM_ID, and is not rewritten');
    });
  });
});
