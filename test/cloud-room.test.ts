import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { RoomWatch, roomUnusable, watchJoinedRoom } from '../src/cloud/room.ts';
import { Health } from '../src/health.ts';
import { MatrixClient, MatrixError } from '../src/matrix/client.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';

/** On 2026-10-19 the chat was deleted on the phone and the bridge deleted its room: the bot must wait for a new one, not restart for hours. */
describe('the bot’s chat room is gone', () => {
  let mock: MockMatrix;
  before(async () => {
    mock = await startMockMatrix();
  });
  after(() => mock.close());
  beforeEach(() => mock.reset());

  const OLD = '!old:localhost';

  async function until(ready: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!ready()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  /** A watch over the mock homeserver whose waits the test lets go of by hand. */
  function setup(rooms: string[], options: { enabled?: boolean; found?: string[] | (() => string[]) } = {}) {
    const state = { rooms, enabled: options.enabled ?? true, stopped: false, found: options.found ?? [], finds: 0, kept: [] as string[] };
    const waits: Array<() => void> = [];
    const logs: string[] = [];
    const told: string[] = [];
    const health = new Health({ notify: async (_title, message) => void told.push(message), log: (line) => logs.push(line) });
    const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
    const watch = new RoomWatch({
      rooms: () => state.rooms,
      find: () => {
        state.finds++;
        return typeof state.found === 'function' ? state.found() : state.found;
      },
      found: (room) => void state.kept.push(room),
      enabled: () => state.enabled,
      join: (room) => matrix.joinRoom(room),
      wait: () => new Promise<void>((resolve) => waits.push(resolve)),
      stopped: () => state.stopped,
      health,
      log: (line) => logs.push(line),
    });
    let result: { room: string | undefined } | undefined;
    const ready = watch.ready().then((room) => void (result = { room }));
    /** Waits until the watch is waiting, then lets that wait end (a chat was chosen, or a minute went by). */
    const pass = async (): Promise<void> => {
      await until(() => waits.length > 0, 'the watch to wait');
      waits.shift()!();
    };
    return { state, watch, health, logs, told, ready, pass, result: () => result, waiting: () => waits.length > 0 };
  }

  test('a room the homeserver no longer knows is waited on, not failed, and the owner is told once', async () => {
    mock.goneRooms.push(OLD);
    const { watch, logs, told, pass, result } = setup([OLD]);
    await until(() => watch.report().state === 'gone', 'the room to be found gone');
    assert.deepEqual(watch.report().gone, [OLD]);
    assert.equal(told.length, 1);
    assert.match(told[0]!, /chat room is gone/);
    assert.match(told[0]!, /!old:localhost/);
    assert.match(told[0]!, /text yourself once/, 'it says the bot finds the chat once the owner texts themself');
    assert.match(told[0]!, /\/pair/, 'and where to choose the chat if it does not');
    // A few more minutes of the same: still waiting, still the one alert, one line in the log.
    for (let i = 0; i < 3; i++) await pass();
    await until(() => watch.report().state === 'gone', 'still gone');
    assert.equal(told.length, 1, 'not told again');
    assert.equal(result(), undefined, 'and not given up');
    assert.equal(logs.filter((line) => /cannot be joined/.test(line)).length, 1);
    assert.ok(watch.report().since, 'since when is kept for /status');
  });

  test('choosing the new chat joins it, says it is fixed, and clears the problem', async () => {
    mock.goneRooms.push(OLD);
    const { state, watch, health, told, ready, pass, result } = setup([OLD]);
    await until(() => watch.report().state === 'gone', 'the room to be found gone');
    assert.equal(health.has('room'), true);

    state.rooms = [mock.roomId]; // chosen on the /pair page
    await pass();
    await ready;
    assert.equal(result()?.room, mock.roomId);
    assert.equal(watch.report().state, 'joined');
    assert.deepEqual(mock.joinedViaApi.slice(-1), [mock.roomId]);
    assert.equal(health.has('room'), false);
    assert.equal(told.length, 2);
    assert.match(told[1]!, /Fixed/);
  });

  test('a stale MATRIX_ROOM_ID is passed over for the chat chosen on the setup page', async () => {
    mock.goneRooms.push(OLD);
    const { watch, logs, told, ready, result } = setup([OLD, mock.roomId]);
    await ready;
    assert.equal(result()?.room, mock.roomId);
    assert.equal(watch.report().state, 'joined');
    assert.ok(logs.some((line) => line.includes(`using ${mock.roomId}`) && line.includes(OLD)));
    assert.deepEqual(told, [], 'nothing to report: the bot has a room');
  });

  test('a room that comes back by itself is noticed at the next look', async () => {
    mock.goneRooms.push(mock.roomId);
    const { watch, told, ready, pass, result } = setup([mock.roomId]);
    await until(() => watch.report().state === 'gone', 'the room to be found gone');
    mock.goneRooms.length = 0;
    await pass();
    await ready;
    assert.equal(result()?.room, mock.roomId);
    assert.equal(told.length, 2);
  });

  test('a failure that is not about the room is still a failure, for the supervisor to restart', async () => {
    const health = new Health({ notify: async () => {} });
    const watch = (join: () => Promise<void>) =>
      new RoomWatch({ rooms: () => ['!any:localhost'], enabled: () => true, join, wait: () => new Promise<void>(() => {}), stopped: () => false, health, log: () => {} });
    await assert.rejects(watch(() => Promise.reject(new MatrixError('sync is broken', 500, 'M_UNKNOWN', ''))).ready(), /sync is broken/);
    await assert.rejects(watch(() => Promise.reject(new TypeError('fetch failed'))).ready(), /fetch failed/);
    await assert.rejects(watch(() => Promise.reject(new MatrixError('bad token', 401, 'M_UNKNOWN_TOKEN', ''))).ready(), /bad token/);
  });

  test('no chat chosen yet is waited on quietly, and a bot switched off does not join anything', async () => {
    const { state, watch, told, logs, ready, pass, result } = setup([], { enabled: false });
    await until(() => watch.report().state === 'unchosen', 'the first look');
    state.rooms = [mock.roomId];
    await pass(); // chosen, but BOT_ENABLED is off
    await until(() => watch.report().state === 'unchosen', 'the second look');
    assert.deepEqual(mock.joinedViaApi, []);
    assert.equal(result(), undefined);

    state.enabled = true;
    await pass();
    await ready;
    assert.equal(result()?.room, mock.roomId);
    assert.deepEqual(told, [], 'an unchosen chat is not a problem');
    assert.equal(logs.filter((line) => /no chat chosen yet/.test(line)).length, 0, 'it says nothing while the bot is switched off');
  });

  test('says no chat is chosen yet, when the bot is on', async () => {
    const { state, logs, ready, pass, result } = setup([]);
    await until(() => logs.some((line) => /no chat chosen yet/.test(line)), 'the note');
    state.rooms = [mock.roomId];
    await pass();
    await ready;
    assert.equal(result()?.room, mock.roomId);
  });

  test('stops waiting when the host is stopping', async () => {
    mock.goneRooms.push(OLD);
    const { state, watch, ready, pass, result } = setup([OLD]);
    await until(() => watch.report().state === 'gone', 'the room to be found gone');
    state.stopped = true;
    await pass();
    await ready;
    assert.deepEqual(result(), { room: undefined });
  });

  describe('finding the owner’s own chat by itself (2026-10-22: deleted on the phone, and nobody chose it again)', () => {
    test('the deleted chat’s new room is taken as soon as the bridge has it, with nobody choosing it', async () => {
      mock.goneRooms.push(OLD, '!also-old:localhost');
      const { state, watch, health, logs, told, ready, pass, result } = setup([OLD], { found: ['!also-old:localhost'] });
      await until(() => watch.report().state === 'gone', 'the rooms to be found gone');
      assert.deepEqual(watch.report().gone, [OLD, '!also-old:localhost'], 'a found room that is gone too is reported with the rest');
      assert.equal(health.has('room'), true);

      state.found = [mock.roomId, OLD]; // the owner texted themself, and the bridge made the chat's new room
      await pass();
      await ready;
      assert.equal(result()?.room, mock.roomId);
      assert.deepEqual(state.kept, [mock.roomId], 'kept as the chat chosen');
      assert.equal(watch.report().room, mock.roomId);
      assert.ok(logs.some((line) => line.startsWith(`found your chat by itself: ${mock.roomId}`) && line.includes(OLD)));
      assert.equal(told.length, 2);
      assert.match(told[1]!, /Fixed/);
    });

    test('with no chat chosen at all (a new pairing), the own chat is found and joined', async () => {
      const { state, ready, result } = setup([], { found: [mock.roomId] });
      await ready;
      assert.equal(result()?.room, mock.roomId);
      assert.deepEqual(state.kept, [mock.roomId]);
      assert.deepEqual(mock.joinedViaApi, [mock.roomId]);
    });

    test('a chat that was given and still works is kept: nothing is looked for', async () => {
      const { state, ready, result } = setup([mock.roomId], { found: ['!other:localhost'] });
      await ready;
      assert.equal(result()?.room, mock.roomId);
      assert.equal(state.finds, 0);
      assert.deepEqual(state.kept, [], 'a given room is not saved again');
    });

    test('nothing chosen and nothing found yet: waits, and takes the chat once the owner texts themself', async () => {
      const { state, watch, logs, told, ready, pass, result } = setup([]);
      await until(() => logs.some((line) => /no chat chosen yet: text yourself once/.test(line)), 'the note');
      assert.equal(watch.report().state, 'unchosen');
      state.found = [mock.roomId];
      await pass();
      await ready;
      assert.equal(result()?.room, mock.roomId);
      assert.deepEqual(told, [], 'no chat yet is not a problem to mail');
    });

    test('a bridge database that cannot be read yet is said once, and counts as nothing found', async () => {
      let broken = true;
      const { logs, ready, pass, result } = setup([], {
        found: () => {
          if (broken) throw new Error('no such table: gmessages_direct_conversation');
          return [mock.roomId];
        },
      });
      await pass();
      await pass();
      assert.equal(logs.filter((line) => /could not look for your chat in the bridge's database: no such table/.test(line)).length, 1);
      broken = false;
      await pass();
      await ready;
      assert.equal(result()?.room, mock.roomId);
    });
  });

  test('the homeserver asking to slow down (HTTP 429) is waited out, not a crash (2026-10-25: it failed every start)', async () => {
    const logs: string[] = [];
    const waits: Array<() => void> = [];
    let busy = 3;
    const joins: string[] = [];
    const told: string[] = [];
    const health = new Health({ notify: async (_title, message) => void told.push(message) });
    const watch = new RoomWatch({
      rooms: () => [OLD, '!chosen:localhost'],
      find: () => ['!found:localhost'],
      enabled: () => true,
      join: async (room) => {
        joins.push(room);
        if (busy-- > 0) throw new MatrixError('Too Many Requests', 429, 'M_LIMIT_EXCEEDED', '{"retry_after_ms":60000}');
      },
      wait: () => new Promise<void>((resolve) => waits.push(resolve)),
      stopped: () => false,
      health,
      log: (line) => logs.push(line),
    });
    let room: string | undefined;
    const ready = watch.ready().then((joined) => void (room = joined));
    for (let i = 0; i < 3; i++) {
      await until(() => waits.length > 0, 'the watch to wait');
      waits.shift()!();
    }
    await ready;
    assert.equal(room, OLD, 'the fourth try got through');
    assert.deepEqual(joins, [OLD, OLD, OLD, OLD], 'one join per minute while the homeserver says no, and nothing looked for meanwhile');
    assert.equal(logs.filter((line) => /slow down \(HTTP 429\)/.test(line)).length, 1, 'said once');
    assert.deepEqual(told, [], 'a busy homeserver says nothing about the chat');
  });

  test('which failed joins mean the room is unusable', () => {
    assert.equal(roomUnusable(new MatrixError("Can't join remote room", 404, 'M_UNKNOWN', '')), true);
    assert.equal(roomUnusable(new MatrixError('You are not invited to this room.', 403, 'M_FORBIDDEN', '')), true);
    assert.equal(roomUnusable(new MatrixError('boom', 500, 'M_UNKNOWN', '')), false);
    assert.equal(roomUnusable(new MatrixError('slow down', 429, 'M_LIMIT_EXCEEDED', '')), false);
    assert.equal(roomUnusable(new MatrixError('bad token', 401, 'M_UNKNOWN_TOKEN', '')), false);
    assert.equal(roomUnusable(new Error('fetch failed')), false);
  });

  describe('while the bot is running', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    test('a room the bot still has is left alone', async () => {
      const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
      let gone = 0;
      const stop = watchJoinedRoom({ join: () => matrix.joinRoom(mock.roomId), onGone: () => void gone++, everyMs: 5, log: () => {} });
      await until(() => mock.joinedViaApi.length >= 3, 'a few looks at the room');
      stop();
      assert.equal(gone, 0);
    });

    test('a room the homeserver forgets (the chat was deleted on the phone) is reported once, and the looking stops', async () => {
      const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
      let gone = 0;
      const stop = watchJoinedRoom({ join: () => matrix.joinRoom(mock.roomId), onGone: () => void gone++, everyMs: 5, log: () => {} });
      await until(() => mock.joinedViaApi.length >= 1, 'the first look');
      mock.goneRooms.push(mock.roomId);
      await until(() => gone === 1, 'the room to be found gone');
      const looks = mock.requests.length;
      await sleep(40);
      assert.equal(gone, 1, 'once');
      assert.equal(mock.requests.length, looks, 'and no more looks');
      stop();
    });

    test('the homeserver having a moment is not the room being gone', async () => {
      const logs: string[] = [];
      let gone = 0;
      let looks = 0;
      const stop = watchJoinedRoom({
        join: async () => {
          looks++;
          throw new MatrixError('sync is broken', 500, 'M_UNKNOWN', '');
        },
        onGone: () => void gone++,
        everyMs: 5,
        log: (line) => logs.push(line),
      });
      await until(() => looks >= 3, 'a few looks');
      stop();
      assert.equal(gone, 0);
      assert.match(logs[0] ?? '', /could not check the chat room: sync is broken/);
    });

    test('looks do not pile up behind a slow homeserver, and stopping ends them', async () => {
      let looks = 0;
      let open!: () => void;
      const stuck = new Promise<void>((resolve) => (open = resolve));
      const stop = watchJoinedRoom({ join: () => (looks++, stuck), onGone: () => {}, everyMs: 3, log: () => {} });
      await sleep(40);
      assert.equal(looks, 1, 'one look at a time');
      stop();
      open();
      await sleep(20);
      assert.equal(looks, 1, 'none after stopping');
    });
  });

  test('the setup page reads the field /status writes', () => {
    const page = readFileSync(new URL('../src/cloud/pair.html', import.meta.url), 'utf8');
    const main = readFileSync(new URL('../src/cloud-main.ts', import.meta.url), 'utf8');
    for (const name of ['roomGone', 'room-missing']) {
      assert.ok(page.includes(name), `the page knows ${name}`);
      assert.ok(main.includes(name), `cloud-main reports ${name}`);
    }
  });
});
