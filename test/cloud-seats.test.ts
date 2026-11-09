import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { AdminConsole } from '../src/admin/console.ts';
import { Catalog } from '../src/catalog.ts';
import { SeatImpossible, Seats, type Seat, type SeatsDeps } from '../src/cloud/seats.ts';
import { loadMatrixHostConfig } from '../src/config.ts';
import { startHost, type Host } from '../src/host.ts';
import { MatrixError } from '../src/matrix/client.ts';
import { personOf, type Person } from '../src/people.ts';
import { addChat, addLogin, deleteRoom, writeBridgeDb } from './helpers/bridge-db.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';
import { startMockMusicTable, type MockMusicTable } from './helpers/mock-music-table.ts';
import { listen, type Listening } from './helpers/servers.ts';

// The cloud host's seats (src/cloud/seats.ts): one for each person who uses the bot, the owner first. What these pin is that they are independent:
// the host is there before any room is, each person's chat starts when their own room is joined, a person's account that can't be signed in, room
// deleted on the phone or chat that goes away never stops another's, and nobody's runner can end up in somebody else's room. Two mock
// homeservers stand for the two accounts; the bridge's database is a fixture with a login for each.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const OWNER_ROOM = '!owner-portal:localhost';
const ALICE_ROOM = '!alice-portal:localhost';
const OWNER_PHONE = '+15551110001';
const ALICE_PHONE = '+15552220002';
const OWNER_LOGIN = 'owner@gmail.com/1';
const ALICE_LOGIN = 'alice@gmail.com/1';
const OWNER_USER = '@me:localhost';
const ALICE_USER = '@alice:localhost';
const alice = personOf('alice');
const bob = personOf('bob');

describe('the seats of the people on the cloud host', () => {
  let ownerMock: MockMatrix;
  let aliceMock: MockMatrix;
  let bridge: Listening;
  let site: MockMusicTable;
  let dir: string;
  let dbPath: string;
  let catalog: Catalog;
  let host: Host | undefined;
  let seats: Seats | undefined;
  let logs: string[];
  let told: string[];
  let signIns: string[];

  before(async () => {
    ownerMock = await startMockMatrix(0, { eventPrefix: 'o', roomId: OWNER_ROOM });
    aliceMock = await startMockMatrix(0, { eventPrefix: 'a', roomId: ALICE_ROOM });
    site = await startMockMusicTable([]);
    // The bridge's provisioning API with no Google login: nothing to restart, nothing to wait for.
    bridge = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ logins: [] }));
    });
  });
  after(async () => {
    await Promise.all([ownerMock.close(), aliceMock.close(), bridge.close(), site.close()]);
  });
  beforeEach(() => {
    for (const mock of [ownerMock, aliceMock]) {
      mock.reset();
      mock.rooms.length = 2;
    }
    dir = mkdtempSync(join(tmpdir(), 'seats-'));
    catalog = new Catalog(':memory:');
    host = undefined;
    seats = undefined;
    logs = [];
    told = [];
    signIns = [];
  });
  afterEach(async () => {
    await seats?.stop();
    await host?.stop();
    catalog.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A bridge database with a login for the owner and one for alice, each with a "message yourself" chat in the room of their own. */
  const bothLinked = (): string =>
    writeBridgeDb(dir, [
      { login: OWNER_LOGIN, user: OWNER_USER, sims: [OWNER_PHONE], chats: [{ phone: OWNER_PHONE, room: OWNER_ROOM, at: 100 }] },
      { login: ALICE_LOGIN, user: ALICE_USER, sims: [ALICE_PHONE], chats: [{ phone: ALICE_PHONE, room: ALICE_ROOM, at: 100 }] },
    ]);
  /** The same, but nobody has texted themself yet: the logins are there, the chats are not. */
  const linkedNoChats = (): string =>
    writeBridgeDb(dir, [
      { login: OWNER_LOGIN, user: OWNER_USER, sims: [OWNER_PHONE] },
      { login: ALICE_LOGIN, user: ALICE_USER, sims: [ALICE_PHONE] },
    ]);

  const baseEnv = (): NodeJS.ProcessEnv => ({
    YOUTUBE_MUSIC: 'off',
    MUSIC_TABLE: 'off',
    ZEMER_RELEASES: 'off',
    PREFETCH_MB: 'off',
    SONG_GAP_SECONDS: 'off',
    MATRIX_SYNC_WAIT_MS: '0',
    BRIDGE_URL: bridge.url,
    BRIDGE_AUTO_RESTART: 'off',
  });

  async function startTheHost(env: NodeJS.ProcessEnv = {}): Promise<Host> {
    const merged = { ...baseEnv(), ...env };
    const config = { ...loadMatrixHostConfig(merged), pollMs: 20, dbPath: ':memory:' };
    host = await startHost({
      env: merged,
      config,
      catalog,
      admin: new AdminConsole(),
      notify: async (_title, message) => void told.push(message),
      extensions: [],
      online: async () => true,
      log: (line) => logs.push(line),
    });
    return host;
  }

  /** The seats for the owner and `people`, over the two mock homeservers, with the host already built (or not, for `host: false`). */
  function makeSeats(over: Partial<SeatsDeps> & { people?: Person[]; env?: NodeJS.ProcessEnv } = {}): Seats {
    const { env, ...rest } = over;
    seats = new Seats({
      people: [alice],
      env: { ...baseEnv(), ...env },
      state: catalog,
      bridgeDb: dbPath,
      log: (line) => logs.push(line),
      homeserver: (person) => (person.owner ? ownerMock.url : aliceMock.url),
      enabled: () => true,
      host: () => host,
      health: () => host!.health,
      signIn: async (person) => {
        signIns.push(person.id);
        return person.owner ? { token: ownerMock.token, userId: OWNER_USER } : { token: aliceMock.token, userId: ALICE_USER };
      },
      retryMs: 30,
      waitMs: 40,
      roomCheckEveryMs: 20,
      ...rest,
    });
    return seats;
  }

  const type = (mock: MockMatrix, text: string): string => mock.addMessage(mock.ghost, { msgtype: 'm.text', body: text });
  const bodies = (mock: MockMatrix): string[] => mock.sent.map((event) => String(event.content.body ?? ''));
  const answersHelp = async (mock: MockMatrix, whose: string): Promise<void> => {
    const before = mock.sent.length;
    type(mock, 'help');
    await until(() => mock.sent.length > before && bodies(mock).some((text) => /Start each message with a command/.test(text)), `${whose} to be answered`);
  };
  const seat = (id: string): Seat => seats!.get(id)!;
  const joinedRoom = (mock: MockMatrix, room: string): boolean => mock.requests.some((request) => request.path.includes(encodeURIComponent(room)));

  describe('bringing the chats up', () => {
    test('each person’s chat starts when their own room is joined, in their own room, with their own state keys', async () => {
      dbPath = bothLinked();
      await startTheHost();
      makeSeats().runAll();
      await until(() => host!.chats.size === 2, 'both chats');
      assert.deepEqual([seat('owner').report().phase, seat('alice').report().phase], ['running', 'running']);
      assert.equal(host!.chats.get('owner')!.roomID, OWNER_ROOM);
      assert.equal(host!.chats.get('alice')!.roomID, ALICE_ROOM);
      // The rooms were found by themselves, and kept: the owner's under the old keys, alice's under hers.
      assert.equal(catalog.getState('matrix.room'), OWNER_ROOM);
      assert.equal(catalog.getState('matrix.room:alice'), ALICE_ROOM);
      assert.equal(catalog.getState('matrix.phone'), OWNER_PHONE);
      assert.equal(catalog.getState('matrix.phone:alice'), ALICE_PHONE);
      assert.equal(catalog.getState('matrix.room:owner'), undefined, 'the owner has no suffixed key');
      assert.equal(catalog.getState('matrix.phone:owner'), undefined);
      // Each is answered in their own room, by their own account, and never in the other's.
      await answersHelp(ownerMock, 'the owner');
      await answersHelp(aliceMock, 'alice');
      assert.ok(ownerMock.joinedViaApi.every((room) => room === OWNER_ROOM), ownerMock.joinedViaApi.join(', '));
      assert.ok(aliceMock.joinedViaApi.every((room) => room === ALICE_ROOM), aliceMock.joinedViaApi.join(', '));
      assert.ok(logs.some((line) => /^\[alice\] signed in as @alice:localhost, watching room !alice-portal:localhost/.test(line)));
      assert.ok(logs.some((line) => /^signed in as @me:localhost, watching room !owner-portal:localhost/.test(line)));
    });

    test('an owner whose session was opened by the start-up (cloud-main does) is not signed in again', async () => {
      dbPath = bothLinked();
      await startTheHost();
      const made = makeSeats();
      made.owner.open(ownerMock.token, OWNER_USER, ownerMock.url);
      made.owner.phase = 'setup';
      made.runAll();
      await until(() => host!.chats.size === 2, 'both chats');
      assert.deepEqual(signIns, ['alice'], 'only alice was signed in by the seat');
    });

    test('the digest time follows the person’s place in PEOPLE, not the order their rooms were joined in', async () => {
      dbPath = bothLinked();
      await startTheHost({ DIGEST_TIME: '09:00', MUSIC_TABLE_URL: site.url, MUSIC_TABLE: '1' });
      // bob is listed first but never gets signed in; alice is second, so she is the second person to be sent the daily message.
      makeSeats({
        people: [bob, alice],
        signIn: async (person) => {
          if (person.id === 'bob') throw new SeatImpossible('no password for bob');
          return person.owner ? { token: ownerMock.token, userId: OWNER_USER } : { token: aliceMock.token, userId: ALICE_USER };
        },
      }).runAll();
      await until(() => host!.chats.has('alice') && host!.library.jobs !== undefined, 'alice’s chat and the jobs');
      const people = host!.library.jobs!.report().people;
      assert.deepEqual(people.map((one) => [one.id, one.digest.at]), [['alice', '09:10']]);
    });

    test('a bot that is switched off signs the accounts in for the setup page but starts no chat', async () => {
      dbPath = bothLinked();
      makeSeats({ enabled: () => false, host: () => undefined, health: () => ({ problem() {}, ok() {} }) }).runAll();
      await until(() => seat('owner').session !== undefined && seat('alice').session !== undefined, 'both accounts signed in');
      await sleep(120);
      assert.deepEqual([ownerMock.joinedViaApi, aliceMock.joinedViaApi], [[], []], 'no room joined');
      assert.deepEqual([seat('owner').phase, seat('alice').phase], ['setup', 'setup']);
      assert.ok(seat('alice').session!.pairing, 'alice’s window to the bridge is there for the setup page');
    });

    test('stopping ends every seat’s loop at once, whatever it is waiting for', async () => {
      dbPath = linkedNoChats();
      await startTheHost();
      const made = makeSeats({ waitMs: 60_000, retryMs: 60_000 });
      made.runAll();
      await until(() => seat('alice').watch !== undefined && seat('owner').watch !== undefined, 'both to be waiting');
      const started = Date.now();
      await made.stop();
      assert.ok(Date.now() - started < 1_000, 'it did not wait out the minute');
      const joins = [ownerMock, aliceMock].map((mock) => mock.requests.length);
      await sleep(80);
      assert.deepEqual([ownerMock, aliceMock].map((mock) => mock.requests.length), joins, 'and nothing is asked afterwards');
    });
  });

  describe('nobody waits for anybody', () => {
    test('the owner’s chat being gone does not keep alice from being answered, and its new room is taken when it comes', async () => {
      dbPath = writeBridgeDb(dir, [
        { login: OWNER_LOGIN, user: OWNER_USER, sims: [OWNER_PHONE] },
        { login: ALICE_LOGIN, user: ALICE_USER, sims: [ALICE_PHONE], chats: [{ phone: ALICE_PHONE, room: ALICE_ROOM, at: 100 }] },
      ]);
      const OLD = '!owner-old:localhost';
      catalog.setState('matrix.room', OLD);
      ownerMock.goneRooms.push(OLD);
      await startTheHost();
      makeSeats().runAll();
      await until(() => host!.chats.has('alice'), 'alice’s chat, with the owner’s room gone');
      await answersHelp(aliceMock, 'alice');
      await until(() => seat('owner').report().phase === 'room-missing', 'the owner to be waiting');
      assert.deepEqual(seat('owner').report().roomGone?.rooms, [OLD]);
      assert.equal(host!.chats.has('owner'), false);
      assert.equal(host!.health.has('room'), true, 'the owner’s problem is kept under room');
      assert.equal(host!.health.has('room:alice'), false, 'and alice has none');
      assert.equal(told.length, 1);
      assert.match(told[0]!, /^The bot's chat room is gone \(!owner-old:localhost\)/, 'the owner’s alert is worded as it always was');

      // The owner texts themself: the bridge makes the chat's room, and the owner is answered without anyone choosing it.
      addChat(dbPath, OWNER_LOGIN, { phone: OWNER_PHONE, room: OWNER_ROOM, at: 200 });
      await until(() => host!.chats.has('owner'), 'the owner’s chat');
      await answersHelp(ownerMock, 'the owner');
      assert.equal(catalog.getState('matrix.room'), OWNER_ROOM, 'kept as the chat chosen');
      assert.equal(host!.health.has('room'), false);
      assert.match(told.at(-1)!, /^Fixed: the bot has its chat room again/);
    });

    test('alice’s room deleted on her phone takes only her chat off, names her in the alert, and is taken again when the bridge makes it', async () => {
      dbPath = bothLinked();
      await startTheHost();
      makeSeats().runAll();
      await until(() => host!.chats.size === 2, 'both chats');
      const sentBefore = ownerMock.sent.length;

      aliceMock.goneRooms.push(ALICE_ROOM);
      deleteRoom(dbPath, ALICE_ROOM);
      await until(() => !host!.chats.has('alice'), 'alice’s chat to leave');
      await until(() => seat('alice').report().phase === 'room-missing', 'alice to be waiting');
      assert.deepEqual(seat('alice').report().roomGone?.rooms, [ALICE_ROOM]);
      assert.equal(host!.health.has('room:alice'), true);
      assert.equal(host!.health.has('room'), false, 'the owner’s key is untouched');
      assert.match(told.at(-1)!, /^alice's chat room is gone \(!alice-portal:localhost\)/);
      assert.match(told.at(-1)!, /alice needs to text themself once/);
      assert.match(told.at(-1)!, /Nobody else's chat is affected/);
      assert.ok(logs.some((line) => /^\[alice\] the chat room !alice-portal:localhost is gone/.test(line)));
      // The owner never noticed: still there, still answered.
      assert.equal(seat('owner').report().phase, 'running');
      assert.equal(host!.chats.has('owner'), true);
      await answersHelp(ownerMock, 'the owner');
      assert.ok(ownerMock.sent.length > sentBefore);
      assert.ok(ownerMock.joinedViaApi.every((room) => room === OWNER_ROOM));

      // She texts herself again: the bridge makes a new room, and it is found by itself.
      const NEW = '!alice-new:localhost';
      aliceMock.rooms.push({ id: NEW, name: 'Me', members: 2, heroes: [] });
      addChat(dbPath, ALICE_LOGIN, { phone: ALICE_PHONE, room: NEW, at: 300 });
      await until(() => host!.chats.get('alice')?.roomID === NEW, 'alice’s chat in the new room');
      assert.equal(catalog.getState('matrix.room:alice'), NEW);
      assert.equal(host!.health.has('room:alice'), false);
      assert.match(told.at(-1)!, /^Fixed: the bot has alice's chat room again and is answering there\./);
      assert.equal(seat('alice').report().phase, 'running');
    });

    test('the owner’s room deleted while running takes only the owner’s chat off (no process ends), and alice goes on', async () => {
      dbPath = bothLinked();
      await startTheHost();
      makeSeats().runAll();
      await until(() => host!.chats.size === 2, 'both chats');
      ownerMock.goneRooms.push(OWNER_ROOM);
      deleteRoom(dbPath, OWNER_ROOM);
      await until(() => !host!.chats.has('owner'), 'the owner’s chat to leave');
      await until(() => seat('owner').report().phase === 'room-missing', 'the owner to be waiting');
      assert.equal(host!.health.has('room'), true);
      assert.equal(host!.chats.has('alice'), true);
      await answersHelp(aliceMock, 'alice');
    });

    test('an account that cannot be signed in is tried again and said, and never stops the others', async () => {
      dbPath = bothLinked();
      await startTheHost();
      let aliceTries = 0;
      makeSeats({
        signIn: async (person) => {
          if (person.owner) return { token: ownerMock.token, userId: OWNER_USER };
          if (++aliceTries <= 3) throw new Error('the homeserver refused the password');
          return { token: aliceMock.token, userId: ALICE_USER };
        },
      }).runAll();
      await until(() => host!.chats.has('owner'), 'the owner’s chat');
      await answersHelp(ownerMock, 'the owner');
      await until(() => aliceTries >= 1 && seat('alice').report().error !== null, 'alice’s trouble to be reported');
      assert.equal(seat('alice').report().error, 'the homeserver refused the password');
      assert.equal(seat('alice').report().phase, 'starting');
      assert.equal(host!.chats.has('alice'), false);
      assert.ok(logs.some((line) => /^\[alice\] could not sign alice in: the homeserver refused the password; trying again in a minute/.test(line)));
      await until(() => host!.chats.has('alice'), 'alice to get in once the account works');
      assert.equal(aliceTries, 4);
      assert.equal(seat('alice').report().error, null);
      await answersHelp(aliceMock, 'alice');
    });

    test('a person the host has no password for is not retried, and the owner is untouched', async () => {
      dbPath = bothLinked();
      await startTheHost();
      let tries = 0;
      makeSeats({
        signIn: async (person) => {
          if (person.owner) return { token: ownerMock.token, userId: OWNER_USER };
          tries++;
          throw new SeatImpossible('The host handed over no Matrix password for alice');
        },
      }).runAll();
      await until(() => host!.chats.has('owner'), 'the owner’s chat');
      await until(() => seat('alice').report().error !== null, 'the reason');
      await sleep(150);
      assert.equal(tries, 1, 'once');
      assert.match(seat('alice').report().error!, /no Matrix password for alice/);
      assert.equal(host!.chats.has('alice'), false);
    });

    test('a token the homeserver no longer knows is replaced by signing in again, not by giving up', async () => {
      dbPath = bothLinked();
      await startTheHost();
      let tries = 0;
      makeSeats({
        people: [],
        signIn: async () => {
          tries++;
          return { token: tries === 1 ? 'syt_old_token' : ownerMock.token, userId: OWNER_USER };
        },
      }).runAll();
      await until(() => host!.chats.has('owner'), 'the owner’s chat with a fresh token');
      assert.equal(tries, 2);
      assert.ok(logs.some((line) => /no longer accepts the token; signing in again/.test(line)));
      await answersHelp(ownerMock, 'the owner');
    });

    test('a chat that cannot start is tried again, and the seat does not give up', async () => {
      dbPath = bothLinked();
      await startTheHost();
      ownerMock.failSync = true;
      makeSeats({ people: [] }).runAll();
      await until(() => logs.some((line) => /could not start the chat in !owner-portal:localhost/.test(line)), 'the failure to be said');
      assert.equal(host!.chats.has('owner'), false);
      assert.notEqual(seat('owner').report().phase, 'running');
      ownerMock.failSync = false;
      await until(() => host!.chats.has('owner'), 'the chat once the homeserver answers');
      await answersHelp(ownerMock, 'the owner');
    });
  });

  describe('nobody’s runner binds to somebody else’s room', () => {
    test('the owner’s room deleted: the owner never joins alice’s, even where the homeserver would let their account in', async () => {
      dbPath = bothLinked();
      // A homeserver on which the owner's account could join alice's room (as if one account were in both): only the search must keep it out.
      ownerMock.rooms.push({ id: ALICE_ROOM, name: 'Me', members: 2, heroes: [] });
      await startTheHost();
      makeSeats().runAll();
      await until(() => host!.chats.size === 2, 'both chats');

      ownerMock.goneRooms.push(OWNER_ROOM);
      deleteRoom(dbPath, OWNER_ROOM);
      await until(() => seat('owner').report().phase === 'room-missing', 'the owner to be waiting');
      await sleep(250); // several looks for the owner's chat
      assert.equal(joinedRoom(ownerMock, ALICE_ROOM), false, 'the owner’s account was never sent to alice’s room');
      assert.equal(host!.chats.get('owner'), undefined);
      assert.equal(seat('owner').report().phase, 'room-missing');
      assert.equal(host!.chats.get('alice')?.roomID, ALICE_ROOM);
      await answersHelp(aliceMock, 'alice');
      assert.ok(aliceMock.sent.every((event) => !/owner/i.test(String(event.content.body))), 'and alice was told nothing of the owner’s');

      // The owner texts themself: their own new room is the one taken.
      const NEW = '!owner-new:localhost';
      ownerMock.rooms.push({ id: NEW, name: 'Me', members: 2, heroes: [] });
      addChat(dbPath, OWNER_LOGIN, { phone: OWNER_PHONE, room: NEW, at: 400 });
      await until(() => host!.chats.get('owner')?.roomID === NEW, 'the owner’s chat in their new room');
      assert.equal(joinedRoom(ownerMock, ALICE_ROOM), false);
    });

    test('alice’s room deleted: alice never joins the owner’s', async () => {
      dbPath = bothLinked();
      aliceMock.rooms.push({ id: OWNER_ROOM, name: 'Me', members: 2, heroes: [] });
      await startTheHost();
      makeSeats().runAll();
      await until(() => host!.chats.size === 2, 'both chats');
      aliceMock.goneRooms.push(ALICE_ROOM);
      deleteRoom(dbPath, ALICE_ROOM);
      await until(() => seat('alice').report().phase === 'room-missing', 'alice to be waiting');
      await sleep(250);
      assert.equal(joinedRoom(aliceMock, OWNER_ROOM), false);
      assert.equal(host!.chats.has('alice'), false);
      assert.equal(host!.chats.get('owner')?.roomID, OWNER_ROOM);
    });

    test('a person finds rooms only among their own logins, and an empty account finds nothing', () => {
      dbPath = bothLinked();
      const made = makeSeats();
      made.owner.open(ownerMock.token, OWNER_USER, ownerMock.url);
      made.get('alice')!.open(aliceMock.token, ALICE_USER, aliceMock.url);
      assert.deepEqual(made.owner.findRooms(), [OWNER_ROOM]);
      assert.deepEqual(made.get('alice')!.findRooms(), [ALICE_ROOM]);
      // A number typed for alice is looked for among her logins only; the owner's own number finds nothing there.
      assert.deepEqual(made.get('alice')!.rooms(ALICE_PHONE), [ALICE_ROOM]);
      assert.deepEqual(made.get('alice')!.rooms(OWNER_PHONE), []);
      // A number typed for the owner is looked up as it always was, among the bridge's chats.
      assert.deepEqual(made.owner.rooms(ALICE_PHONE), [ALICE_ROOM]);
      assert.deepEqual(made.owner.rooms(OWNER_PHONE), [OWNER_ROOM]);
      // Not signed in: nothing is found for them.
      const bobSeat = makeSeats({ people: [bob] }).get('bob')!;
      assert.deepEqual(bobSeat.findRooms(), []);
      assert.deepEqual(bobSeat.rooms(ALICE_PHONE), []);
    });

    test('MATRIX_ROOM_ID is the owner’s alone; a person’s room is only the one chosen for them', () => {
      dbPath = bothLinked();
      const made = makeSeats({ env: { MATRIX_ROOM_ID: '!from-env:localhost' } });
      catalog.setState('matrix.room', OWNER_ROOM);
      assert.deepEqual(made.owner.roomsChosen(), ['!from-env:localhost', OWNER_ROOM]);
      assert.deepEqual(made.get('alice')!.roomsChosen(), []);
      catalog.setState('matrix.room:alice', ALICE_ROOM);
      assert.deepEqual(made.get('alice')!.roomsChosen(), [ALICE_ROOM]);
      assert.deepEqual(made.owner.roomsChosen(), ['!from-env:localhost', OWNER_ROOM], 'alice’s choice is not the owner’s');
    });
  });

  describe('choosing a chat', () => {
    test('a chat chosen for alice is kept under her key and wakes her wait; the owner’s key is untouched', async () => {
      dbPath = linkedNoChats();
      await startTheHost();
      const made = makeSeats({ waitMs: 60_000 });
      made.runAll();
      await until(() => seat('alice').watch !== undefined && seat('alice').session !== undefined, 'alice to be waiting');
      await sleep(40);
      assert.equal(host!.chats.has('alice'), false);
      const started = Date.now();
      made.choose(seat('alice'), ALICE_ROOM);
      await until(() => host!.chats.has('alice'), 'alice’s chat, woken by the choice');
      assert.ok(Date.now() - started < 3_000, 'at once, not after the minute');
      assert.equal(catalog.getState('matrix.room:alice'), ALICE_ROOM);
      assert.equal(catalog.getState('matrix.room'), undefined);
      assert.ok(logs.some((line) => line === `[alice] chat chosen: ${ALICE_ROOM}`));
      await answersHelp(aliceMock, 'alice');
    });

    test('the owner’s choice keeps the old log line', async () => {
      dbPath = linkedNoChats();
      const made = makeSeats();
      made.choose(made.owner, OWNER_ROOM);
      assert.ok(logs.includes(`chat chosen: ${OWNER_ROOM}`));
      assert.equal(catalog.getState('matrix.room'), OWNER_ROOM);
    });

    test('a room that is another person’s chat cannot be chosen, either way round', async () => {
      dbPath = bothLinked();
      await startTheHost();
      const made = makeSeats();
      made.runAll();
      await until(() => host!.chats.size === 2, 'both chats');
      assert.throws(() => made.choose(seat('alice'), OWNER_ROOM), /That chat is the owner's, not alice's/);
      assert.throws(() => made.choose(seat('owner'), ALICE_ROOM), /That chat is alice's, not the owner's/);
      assert.equal(catalog.getState('matrix.room:alice'), ALICE_ROOM, 'unchanged');
      assert.equal(catalog.getState('matrix.room'), OWNER_ROOM, 'unchanged');
    });

    test('a person who is not listed has no seat', () => {
      dbPath = bothLinked();
      const made = makeSeats();
      assert.equal(made.get('mallory'), undefined);
      assert.equal(made.get(undefined), made.owner);
      assert.equal(made.get('owner'), made.owner);
      assert.equal(made.get('alice')?.person.id, 'alice');
    });
  });

  describe('linking Google Messages, each with their own account', () => {
    test('a person’s window to the bridge is their own: it talks as them, to the bridge’s bot, on their own homeserver account', async () => {
      dbPath = bothLinked();
      const made = makeSeats();
      made.owner.open(ownerMock.token, OWNER_USER, ownerMock.url);
      made.get('alice')!.open(aliceMock.token, ALICE_USER, aliceMock.url);
      await made.get('alice')!.session!.pairing.send('login google');
      // A person's commands carry the bridge's prefix (so any chat with the bot answers); the owner's go as typed.
      assert.deepEqual(bodies(aliceMock), ['!gm login google']);
      assert.deepEqual(bodies(ownerMock), [], 'the owner’s account said nothing');
      await made.owner.session!.pairing.send('help');
      assert.deepEqual(bodies(ownerMock), ['help']);
      assert.deepEqual(bodies(aliceMock), ['!gm login google']);
    });

    test('what the bridge says of a person’s login is asked with their own token and account', async () => {
      dbPath = bothLinked();
      const seen: Array<{ user: string | null; auth: string | undefined }> = [];
      const answering = await listen((req, res) => {
        const url = new URL(req.url ?? '/', 'http://bridge');
        seen.push({ user: url.searchParams.get('user_id'), auth: req.headers.authorization });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ logins: [{ state: { state_event: 'CONNECTED' } }] }));
      });
      try {
        const made = makeSeats();
        assert.deepEqual(await made.get('alice')!.bridge(answering.url), { state: undefined, error: 'this account is not signed in yet' });
        made.get('alice')!.open('syt_alice', ALICE_USER, aliceMock.url);
        const status = await made.get('alice')!.bridge(answering.url);
        assert.equal(status.state, 'CONNECTED');
        assert.deepEqual(seen, [{ user: ALICE_USER, auth: 'Bearer syt_alice' }]);
        const down = await made.get('alice')!.bridge('http://127.0.0.1:1');
        assert.equal(down.state, undefined, 'a bridge that does not answer is said, not thrown');
        assert.ok(down.error);
      } finally {
        await answering.close();
      }
    });

    test('whether a person’s SIM reports its number is read from their own login only', () => {
      dbPath = writeBridgeDb(dir, [
        { login: OWNER_LOGIN, user: OWNER_USER, sims: [OWNER_PHONE] },
        { login: ALICE_LOGIN, user: ALICE_USER, sims: [] },
      ]);
      const made = makeSeats();
      assert.equal(made.get('alice')!.hasSimNumber(), null, 'unknown until she is signed in');
      made.owner.open(ownerMock.token, OWNER_USER, ownerMock.url);
      made.get('alice')!.open(aliceMock.token, ALICE_USER, aliceMock.url);
      assert.equal(made.owner.hasSimNumber(), true);
      assert.equal(made.get('alice')!.hasSimNumber(), false, 'the owner’s number is not hers');
      addLogin(dbPath, { login: 'alice@gmail.com/2', user: ALICE_USER, sims: [ALICE_PHONE] });
      assert.equal(made.get('alice')!.hasSimNumber(), true);
      const unreadable = makeSeats({ bridgeDb: join(dir, 'missing.db'), people: [alice] }).get('alice')!;
      unreadable.open(aliceMock.token, ALICE_USER, aliceMock.url);
      assert.equal(unreadable.hasSimNumber(), null, 'a bridge database that is not there yet is not an answer');
    });
  });

  describe('the onboarding gate: a person is set up once their own chat has arrived', () => {
    const CONNECTED = { state: 'CONNECTED' };
    const aliceSeat = (): Seat => {
      const made = makeSeats();
      made.owner.open(ownerMock.token, OWNER_USER, ownerMock.url);
      made.get('alice')!.open(aliceMock.token, ALICE_USER, aliceMock.url);
      return made.get('alice')!;
    };
    const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

    test('the owner is not run through it', () => {
      dbPath = bothLinked();
      const made = makeSeats();
      made.owner.open(ownerMock.token, OWNER_USER, ownerMock.url);
      assert.equal(made.owner.onboarding(CONNECTED), undefined);
      assert.deepEqual(catalog.getState('onboarding.linked'), undefined);
    });

    test('linked, with a number, and no chat yet: waiting, and the time of linking is kept once', () => {
      dbPath = linkedNoChats();
      const one = aliceSeat();
      assert.equal(one.onboarding({ state: undefined, error: 'this account is not signed in yet' })!.step, 'not-linked');
      const waiting = one.onboarding(CONNECTED)!;
      assert.deepEqual([waiting.step, waiting.onboarded, waiting.warn], ['waiting-for-chat', false, false]);
      const kept = catalog.getState('onboarding.linked:alice');
      assert.ok(kept && waiting.linkedSince === kept);
      one.onboarding(CONNECTED);
      assert.equal(catalog.getState('onboarding.linked:alice'), kept, 'not written again');
      assert.deepEqual([catalog.getState('onboarding.proved:alice'), catalog.getState('onboarding.linked'), catalog.getState('onboarding.proved')], [undefined, undefined, undefined], 'no proof, and nothing of the owner’s keys');
    });

    test('the chat arrives (she texts herself and the bridge makes the room): onboarded, and the proof is kept', () => {
      dbPath = linkedNoChats();
      const one = aliceSeat();
      assert.equal(one.onboarding(CONNECTED)!.step, 'waiting-for-chat');
      addChat(dbPath, ALICE_LOGIN, { phone: ALICE_PHONE, room: ALICE_ROOM, at: 200 });
      const report = one.onboarding(CONNECTED)!;
      assert.deepEqual([report.step, report.onboarded, report.warn], ['onboarded', true, false]);
      assert.equal(catalog.getState('onboarding.proved:alice'), report.provedAt);
      // The chat deleted on the phone later is the room watch's to say; it is not a reason to tell the owner to unlink her.
      deleteRoom(dbPath, ALICE_ROOM);
      assert.deepEqual([one.onboarding(CONNECTED)!.step, one.onboarding(CONNECTED)!.warn], ['onboarded', false]);
    });

    test('the owner’s chat is not hers: the owner texting themself does not set alice up', () => {
      dbPath = writeBridgeDb(dir, [
        { login: OWNER_LOGIN, user: OWNER_USER, sims: [OWNER_PHONE], chats: [{ phone: OWNER_PHONE, room: OWNER_ROOM, at: 100 }] },
        { login: ALICE_LOGIN, user: ALICE_USER, sims: [ALICE_PHONE] },
      ]);
      const one = aliceSeat();
      assert.equal(one.onboarding(CONNECTED)!.step, 'waiting-for-chat');
    });

    test('a login that reports no number is warned about at once, whatever else is true: it would keep every chat she has', () => {
      dbPath = writeBridgeDb(dir, [{ login: OWNER_LOGIN, user: OWNER_USER, sims: [OWNER_PHONE] }, { login: ALICE_LOGIN, user: ALICE_USER, sims: [], chats: [{ phone: ALICE_PHONE, room: ALICE_ROOM, at: 100 }] }]);
      const one = aliceSeat();
      assert.equal(one.hasSimNumber(), false);
      const report = one.onboarding(CONNECTED)!;
      assert.deepEqual([report.step, report.warn, report.onboarded], ['no-number', true, false], 'her chat is there, but a login with no number keeps all of them');
      assert.match(report.message, /unlink alice \(below\)/);
      assert.equal(catalog.getState('onboarding.proved:alice'), undefined);
      // The owner's login has a number: nobody confuses the two.
      assert.equal(seats!.owner.hasSimNumber(), true);
    });

    test('a number that exists but does not match her chat: the chat never arrives, and after the few minutes it says to unlink her and why', () => {
      dbPath = writeBridgeDb(dir, [{ login: OWNER_LOGIN, user: OWNER_USER, sims: [OWNER_PHONE] }, { login: ALICE_LOGIN, user: ALICE_USER, sims: [ALICE_PHONE], chats: [{ phone: '+15557770007', room: '!elsewhere:localhost', at: 100 }] }]);
      const one = aliceSeat();
      assert.equal(one.hasSimNumber(), true, 'the presence check alone would pass');
      assert.equal(one.onboarding(CONNECTED)!.step, 'waiting-for-chat');
      catalog.setState('onboarding.linked:alice', minutesAgo(11));
      const report = one.onboarding(CONNECTED)!;
      assert.deepEqual([report.step, report.warn, report.onboarded], ['chat-missing', true, false]);
      assert.match(report.message, /unlink alice \(below\) and take them out of PEOPLE/);
      assert.match(report.message, /GMESSAGES_ALL_CHATS=1/);
    });

    test('a bridge database that cannot be read is not proof and not a missing number', () => {
      dbPath = join(dir, 'not-there.db');
      const one = aliceSeat();
      assert.equal(one.hasSimNumber(), null);
      assert.equal(one.onboarding(CONNECTED)!.step, 'waiting-for-chat');
    });

    test('her chat already running on the host counts as arrived', async () => {
      dbPath = bothLinked();
      await startTheHost();
      makeSeats().runAll();
      await until(() => host!.chats.has('alice') && host!.chats.has('owner'), 'both chats');
      const report = seat('alice').onboarding(CONNECTED)!;
      assert.deepEqual([report.step, report.onboarded], ['onboarded', true]);
    });

    test('unlinked on purpose (the bridge says no login at all): she starts again', () => {
      dbPath = linkedNoChats();
      const one = aliceSeat();
      one.onboarding(CONNECTED);
      addChat(dbPath, ALICE_LOGIN, { phone: ALICE_PHONE, room: ALICE_ROOM, at: 200 });
      assert.equal(one.onboarding(CONNECTED)!.onboarded, true);
      const gone = one.onboarding({ state: undefined })!;
      assert.deepEqual([gone.step, gone.onboarded, gone.provedAt], ['not-linked', false, null]);
      assert.deepEqual([catalog.getState('onboarding.linked:alice'), catalog.getState('onboarding.proved:alice')], ['', '']);
    });
  });

  describe('the pasted request in her window is taken back out even if the host restarts first', () => {
    const COOKIES = "curl 'https://messages.google.com/web/config' \\\n  -H 'cookie: SID=alicecookie; SAPISID=alicesapisid' \\\n  -H 'x: y'";

    test('the paste is remembered in the host’s state under her account; the next start with her signed in again deletes it, and the owner’s window leaves it alone', async () => {
      dbPath = bothLinked();
      const first = makeSeats();
      first.owner.open(ownerMock.token, OWNER_USER, ownerMock.url);
      first.get('alice')!.open(aliceMock.token, ALICE_USER, aliceMock.url);
      await first.get('alice')!.session!.pairing.send(COOKIES);
      const [kept] = JSON.parse(catalog.getState('pair.redactions') ?? '[]') as Array<{ user: string; room: string; event: string; due: number }>;
      assert.equal(kept!.user, ALICE_USER);
      assert.equal(kept!.event, aliceMock.sent.at(-1)!.eventId);
      assert.deepEqual(aliceMock.redactions, [], 'the minute is not up');
      // The host restarts before the minute is up: nothing was redacted by the old process. The next one opens the same two accounts.
      catalog.setState('pair.redactions', JSON.stringify([{ ...kept, due: Date.now() - 1 }]));
      await first.stop();
      const next = makeSeats();
      next.owner.open(ownerMock.token, OWNER_USER, ownerMock.url);
      assert.deepEqual(aliceMock.redactions, [], 'the owner’s window does not redact what is hers');
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(aliceMock.redactions, []);
      next.get('alice')!.open(aliceMock.token, ALICE_USER, aliceMock.url);
      await until(() => aliceMock.redactions.length === 1, 'her paste to be deleted');
      assert.deepEqual(aliceMock.redactions, [kept!.event]);
      assert.deepEqual(ownerMock.redactions, []);
      await until(() => JSON.parse(catalog.getState('pair.redactions') ?? '[]').length === 0, 'it to be forgotten');
      assert.ok(!logs.join('\n').includes('alicecookie'), 'the request is never logged');
    });
  });

  test('a sign-in failure that is not the account’s (the homeserver’s) is said the same way and retried', async () => {
    dbPath = bothLinked();
    await startTheHost();
    let tries = 0;
    makeSeats({
      people: [],
      signIn: async () => {
        if (++tries === 1) throw new MatrixError('Service unavailable', 503, 'M_UNKNOWN', '');
        return { token: ownerMock.token, userId: OWNER_USER };
      },
    }).runAll();
    await until(() => host!.chats.has('owner'), 'the owner’s chat');
    assert.ok(logs.some((line) => /^could not sign the owner in: Service unavailable; trying again in a minute/.test(line)), logs.join('\n'));
  });
});
