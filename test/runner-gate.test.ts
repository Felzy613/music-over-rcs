import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test, type TestContext } from 'node:test';
import type { DownloadedAudio } from '../src/audio-fetch.ts';
import type { Bot } from '../src/bot.ts';
import { createDeliveryGate, type DeliveryGate } from '../src/delivery-gate.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { createRunner, type ChatClient, type ResumePoint, type Runner } from '../src/runner.ts';
import type { Reply } from '../src/types.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `ready` holds (polling), or fails the test after three seconds. */
async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

/**
 * Two chats on one host: each its own mock homeserver (one person each), its own runner, and a gate they may share. What happened is
 * written to `events` in order: "ask:<person>:<text>" when the bot gets a request, "fetch:" when a download starts, "audio:" and
 * "zip:" when an upload starts, "text:" when a text goes out.
 */
describe('runners sharing one delivery gate', () => {
  let mocks: { A: MockMatrix; B: MockMatrix };
  before(async () => {
    mocks = { A: await startMockMatrix(), B: await startMockMatrix() };
  });
  after(async () => {
    await mocks.A.close();
    await mocks.B.close();
  });
  beforeEach(() => {
    mocks.A.reset();
    mocks.B.reset();
  });

  type Name = 'A' | 'B';
  interface Harness {
    events: string[];
    gate: DeliveryGate;
    /**
     * The most downloads, and the most uploads, under way at once on the whole host, and the most songs held in memory on it: fetched
     * (and so held whole) and not yet on their way to the phone. Only songs sent one by one are counted (not an album's zip).
     */
    flight: { fetching: number; mostFetching: number; uploading: number; mostUploading: number; held: number; mostHeld: number };
    /** Holds a download until `open(title)`; a title not held downloads in `fetchMs`. */
    hold(title: string): void;
    open(title: string): void;
    person(name: Name, options?: PersonOptions): Person;
  }
  interface Person {
    runner: Runner;
    mock: MockMatrix;
    ask(text: string): string;
    saved: ResumePoint[];
    logs: string[];
    failures: Array<{ ok: boolean; failures: number }>;
  }
  interface PersonOptions {
    gate?: DeliveryGate | null;
    songGapMs?: number;
    fetchMs?: number;
    downloadsAhead?: number;
    albumDownloads?: number;
    /** Sending an audio file fails, and so does the apology for it. */
    breakAudio?: boolean;
    /** The chat can't take a file (a zip): an album goes song by song. */
    noFiles?: boolean;
    withResume?: boolean;
    /** Whether the host has memory to spare for a download ahead (the cloud host's `memoryRoom`). */
    memoryRoom?: () => boolean;
  }

  function harness(t: TestContext): Harness {
    const events: string[] = [];
    const gate = createDeliveryGate();
    const flight = { fetching: 0, mostFetching: 0, uploading: 0, mostUploading: 0, held: 0, mostHeld: 0 };
    const held = new Map<string, { opened: Promise<void>; open: () => void }>();
    const runners: Runner[] = [];
    t.after(async () => {
      for (const one of held.values()) one.open();
      for (const runner of runners) await runner.stop({ abandon: true });
    });

    const person = (name: Name, options: PersonOptions = {}): Person => {
      const mock = mocks[name];
      const client = new MatrixClient({ token: mock.token, homeserver: mock.url });
      const logs: string[] = [];
      const saved: ResumePoint[] = [];
      const failures: Person['failures'] = [];
      const uploading = async <T>(send: () => Promise<T>): Promise<T> => {
        flight.uploading += 1;
        flight.mostUploading = Math.max(flight.mostUploading, flight.uploading);
        try {
          await sleep(3);
          return await send();
        } finally {
          flight.uploading -= 1;
        }
      };
      const chat: ChatClient = {
        listMessages: client.listMessages.bind(client),
        sendText: async (room, text) => {
          if (/FAIL/.test(text)) throw new Error('the chat is not taking this text');
          if (options.breakAudio && /couldn't send/.test(text)) throw new Error('the chat is not taking texts');
          events.push(`text:${name}:${text}`);
          return client.sendText(room, text);
        },
        sendAudio: async (room, audio) => {
          events.push(`audio:${name}:${audio.fileName}`);
          flight.held -= 1;
          if (options.breakAudio) throw new Error('the chat is not taking audio');
          return uploading(() => client.sendAudio(room, audio));
        },
        ...(options.noFiles
          ? {}
          : {
              sendFile: async (room: string, file: { data: Blob; fileName: string; mimeType: string; bytes: number }) => {
                events.push(`zip:${name}:${file.fileName}`);
                return uploading(() => client.sendFile(room, file));
              },
            }),
      };
      const bot: Bot = {
        handle: async (msg) => {
          const text = msg.text ?? '';
          events.push(`ask:${name}:${text}`);
          const all = /^all (\d+)$/.exec(text);
          if (all) return Array.from({ length: Number(all[1]) }, (_, i): Reply => ({ kind: 'audio', url: `https://music.test/${i + 1}.mp3`, title: `${name}${i + 1}` }));
          if (text === 'oops') return [{ kind: 'text', text: 'FAIL this text' }, { kind: 'audio', url: 'https://music.test/late.mp3', title: `${name}-late` }];
          if (text === 'song') return [{ kind: 'audio', url: 'https://music.test/single.mp3', title: `${name}-single` }];
          const album = /^album (\d+)$/.exec(text);
          if (album) {
            const songs = Array.from({ length: Number(album[1]) }, (_, i) => ({ number: i + 1, title: `${name}-album${i + 1}`, url: `https://music.test/album${i + 1}.mp3` }));
            return [{ kind: 'album', title: `${name} album`, artist: 'Band', songs }];
          }
          return [{ kind: 'text', text: `answer to ${text}` }];
        },
      };
      const runner = createRunner({
        chat,
        bot,
        chatID: mock.roomId,
        ...(options.gate === null ? {} : { gate: options.gate ?? gate, gateOwner: name }),
        fetchAudio: async (_url, title) => {
          events.push(`fetch:${name}:${title}`);
          flight.fetching += 1;
          flight.mostFetching = Math.max(flight.mostFetching, flight.fetching);
          try {
            const one = held.get(title ?? '');
            await (one ? one.opened : sleep(options.fetchMs ?? 4));
          } finally {
            flight.fetching -= 1;
          }
          flight.held += 1;
          flight.mostHeld = Math.max(flight.mostHeld, flight.held);
          const file: DownloadedAudio = { data: new Blob(['x']), fileName: `${title}.mp3`, mimeType: 'audio/mpeg', bytes: 1 };
          return file;
        },
        pollMs: 3,
        typingRefreshMs: 1_000_000,
        downloadsAhead: options.downloadsAhead ?? 1,
        ...(options.albumDownloads !== undefined ? { albumDownloads: options.albumDownloads } : {}),
        ...(options.memoryRoom ? { memoryRoom: options.memoryRoom } : {}),
        ...(options.songGapMs !== undefined ? { songGapMs: options.songGapMs } : {}),
        ...(options.withResume ? { resume: { load: () => undefined, save: (point: ResumePoint) => void saved.push(point) } } : {}),
        onPoll: (ok, count) => void failures.push({ ok, failures: count }),
        log: (line) => logs.push(line),
      });
      runners.push(runner);
      return { runner, mock, ask: (text) => mock.addMessage(mock.ghost, { msgtype: 'm.text', body: text }), saved, logs, failures };
    };

    return {
      events,
      gate,
      flight,
      hold(title) {
        let open!: () => void;
        const opened = new Promise<void>((resolve) => (open = resolve));
        held.set(title, { opened, open });
      },
      open: (title) => held.get(title)?.open(),
      person,
    };
  }

  const starting = (events: string[], prefix: string): string[] => events.filter((event) => event.startsWith(prefix));

  test("one chat's single song waits behind at most one file of another's 20-song `all`, and each chat's songs keep their order", async (t) => {
    const host = harness(t);
    const alice = host.person('A', { songGapMs: 15 });
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('all 20');
    const allSent = alice.runner.tick();
    await until(() => starting(host.events, 'audio:A:').length >= 3, 'the third song of the twenty');

    bob.ask('song');
    await bob.runner.tick(); // returns once B's song is sent
    const asked = host.events.indexOf('ask:B:song');
    const bobs = host.events.findIndex((event) => event.startsWith('audio:B:'));
    assert.ok(bobs > asked, "B's song went out after it was asked for");
    assert.ok(host.events.slice(asked, bobs).filter((event) => event.startsWith('audio:A:')).length <= 1, 'behind at most one of the other chat\'s files');
    assert.ok(starting(host.events, 'audio:A:').length < 20, 'and not behind the whole `all`');

    await allSent;
    assert.deepEqual(
      starting(host.events, 'audio:A:'),
      Array.from({ length: 20 }, (_, i) => `audio:A:A${i + 1}.mp3`),
      "A's songs arrive in the order asked",
    );
    assert.equal(host.flight.mostUploading, 1, 'one upload at a time on the whole host');
    assert.equal(host.flight.mostFetching, 1, 'and one download at a time, ahead ones included');
    assert.equal(host.gate.busy(), false, 'the gate is free again');
    assert.equal(mocks.B.uploads.length, 1);
    assert.equal(mocks.A.uploads.length, 20);
  });

  test("the gap between a chat's songs is waited outside the gate: the other chat's song goes during it", async (t) => {
    const host = harness(t);
    const alice = host.person('A', { songGapMs: 400 });
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('all 3');
    const allSent = alice.runner.tick();
    await until(() => starting(host.events, 'audio:A:').length === 1, 'the first song');
    await sleep(60); // A is now waiting out its gap
    assert.equal(host.gate.running(), undefined, 'and the gate is free');
    const before = Date.now();
    bob.ask('song');
    await bob.runner.tick();
    assert.ok(Date.now() - before < 300, "B's song did not wait for A's gap");
    assert.equal(starting(host.events, 'audio:A:').length, 1, 'A is still waiting out its gap');
    await allSent;
    assert.equal(starting(host.events, 'audio:A:').length, 3);
  });

  test("text answers stay instant, for both chats, while an album is on its way", async (t) => {
    const host = harness(t);
    const alice = host.person('A', { fetchMs: 25, albumDownloads: 1 });
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('album 6');
    const albumSent = alice.runner.tick();
    await until(() => starting(host.events, 'fetch:A:').length >= 2, "the album's second song to start");

    bob.ask('hello');
    alice.ask('hi');
    const alsoAnswered = alice.runner.tick();
    await bob.runner.tick();
    await until(() => host.events.includes('text:B:🎵 answer to hello') && host.events.includes('text:A:🎵 answer to hi'), 'both texts to be answered');
    assert.equal(starting(host.events, 'zip:A:').length, 0, 'the album is still on its way');
    assert.ok(starting(host.events, 'fetch:A:').length < 6);
    await albumSent;
    await alsoAnswered;
    assert.equal(starting(host.events, 'zip:A:').length, 1);
  });

  test("an album gives the gate to a chat that is waiting for it, between its songs, not after the whole album", async (t) => {
    const host = harness(t);
    const alice = host.person('A', { fetchMs: 25, albumDownloads: 1 });
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('album 6');
    const albumSent = alice.runner.tick();
    await until(() => starting(host.events, 'fetch:A:').length >= 2, "the album's second song to start");
    const fetchesWhenAsked = starting(host.events, 'fetch:A:').length;

    bob.ask('song');
    await bob.runner.tick();
    const bobs = host.events.findIndex((event) => event.startsWith('audio:B:'));
    assert.ok(bobs > 0);
    assert.equal(starting(host.events.slice(0, bobs), 'zip:A:').length, 0, "B's song went out before A's zip");
    const fetchesBefore = starting(host.events.slice(0, bobs), 'fetch:A:').length;
    assert.ok(fetchesBefore <= fetchesWhenAsked + 1, `B waited for ${fetchesBefore - fetchesWhenAsked} more of the album's downloads`);
    assert.ok(fetchesBefore < 6, 'not for the whole album');

    await albumSent;
    assert.equal(starting(host.events, 'fetch:A:').length, 6, 'and the album still came whole');
    assert.equal(starting(host.events, 'zip:A:').length, 1);
    assert.equal(host.flight.mostFetching, 1);
  });

  test("a song's downloads and its upload are not split by a whole file of the other chat", async (t) => {
    const host = harness(t);
    host.hold('A2');
    const alice = host.person('A');
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('all 3');
    const allSent = alice.runner.tick();
    // A's first song is up and its second is downloading (held) in A's second turn, which took the gate over at once: nobody else was
    // waiting, so A's turns follow each other as they do on a host with one chat.
    await until(() => host.events.includes('fetch:A:A2') && starting(host.events, 'audio:A:').length === 1, "A's second turn to be under way");
    await sleep(30);
    assert.equal(host.gate.running(), 'A');
    bob.ask('song');
    const bobSent = bob.runner.tick();
    await until(() => host.gate.pending('B') >= 2, "both halves of B's song to be waiting");
    host.open('A2');
    await bobSent;
    await allSent;
    const order = host.events.filter((event) => event.startsWith('audio:'));
    // B waits for A's second file, which had the gate already, but A's third (waiting by then) does not come between B's two halves.
    assert.deepEqual(order, ['audio:A:A1.mp3', 'audio:A:A2.mp3', 'audio:B:B-single.mp3', 'audio:A:A3.mp3'], "B's song went before A's third, not after it");
  });

  test("a chat that can't take a file gets an album song by song through the gate, in order, with the other chat's song in between", async (t) => {
    const host = harness(t);
    const alice = host.person('A', { noFiles: true, fetchMs: 15, songGapMs: 30 });
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('album 4');
    const albumSent = alice.runner.tick();
    await until(() => starting(host.events, 'audio:A:').length >= 1, "the album's first song");
    bob.ask('song');
    await bob.runner.tick();
    await albumSent;
    const order = host.events.filter((event) => event.startsWith('audio:'));
    assert.deepEqual(
      order.filter((event) => event.startsWith('audio:A:')),
      [1, 2, 3, 4].map((n) => `audio:A:A-album${n}.mp3`),
    );
    assert.ok(order.indexOf('audio:B:B-single.mp3') < order.indexOf('audio:A:A-album4.mp3'), "B's song did not wait for the whole album");
    assert.equal(starting(host.events, 'zip:').length, 0);
    assert.equal(host.flight.mostUploading, 1);
    assert.equal(host.flight.mostFetching, 1);
    assert.equal(host.gate.busy(), false);
  });

  test("an answer that fails before its songs does not wait in line at the gate for downloads it will never use", async (t) => {
    const host = harness(t);
    host.hold('A-single');
    const alice = host.person('A');
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('song');
    void alice.runner.tick();
    await until(() => host.events.includes('fetch:A:A-single'), "A's song to start downloading");
    bob.ask('oops');
    await Promise.race([bob.runner.tick(), sleep(1_000).then(() => assert.fail("B's answer waited for A's file"))]);
    assert.ok(bob.failures.some((poll) => !poll.ok), 'the failed text was reported');
    assert.equal(host.gate.pending('B'), 0);
    assert.equal(starting(host.events, 'fetch:B:').length, 0, 'and nothing was fetched for it');
    host.open('A-single');
    await alice.runner.stop();
    assert.equal(host.gate.busy(), false);
  });

  test('two albums asked for at once never download more than albumDownloads at a time between them', async (t) => {
    const host = harness(t);
    const alice = host.person('A', { fetchMs: 15, albumDownloads: 2 });
    const bob = host.person('B', { fetchMs: 15, albumDownloads: 2 });
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('album 5');
    bob.ask('album 5');
    await Promise.all([alice.runner.tick(), bob.runner.tick()]);
    assert.equal(starting(host.events, 'fetch:').length, 10);
    assert.ok(host.flight.mostFetching <= 2, `${host.flight.mostFetching} downloads at once`);
    assert.equal(host.flight.mostUploading, 1);
    assert.equal(starting(host.events, 'zip:').length, 2);
  });

  test('a unit that throws releases the gate: the other chat goes on, and the failure is counted as a failed send', async (t) => {
    const host = harness(t);
    const alice = host.person('A', { breakAudio: true });
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('all 3');
    bob.ask('song');
    await Promise.all([alice.runner.tick(), bob.runner.tick()]);
    assert.ok(alice.failures.some((poll) => !poll.ok), "A's failed send was reported");
    assert.equal(starting(host.events, 'audio:B:').length, 1, "B's song went out");
    assert.equal(host.gate.busy(), false);
    // And the gate is not wedged for the next request of the chat that failed.
    const aAfter = host.person('A');
    await aAfter.runner.prime();
    aAfter.ask('song');
    await aAfter.runner.tick();
    assert.equal(starting(host.events, 'audio:A:A-single').length, 1);
  });

  test('stop() with a file waiting at the gate waits for its turn and then sends it', async (t) => {
    const host = harness(t);
    host.hold('A-single');
    const alice = host.person('A');
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('song');
    void alice.runner.tick();
    await until(() => host.events.includes('fetch:A:A-single'), "A's song to start downloading");
    bob.ask('song');
    void bob.runner.tick();
    await until(() => host.gate.pending('B') > 0, "B's file to be waiting");

    let stopped = false;
    const stopping = bob.runner.stop().then(() => void (stopped = true));
    await sleep(40);
    assert.equal(stopped, false, 'B is stopping, but its song is still waiting behind the other');
    assert.equal(starting(host.events, 'fetch:B:').length, 0);
    host.open('A-single');
    await stopping;
    assert.equal(starting(host.events, 'audio:B:').length, 1, "B's song went out before it stopped");
    assert.ok(host.events.indexOf('audio:A:A-single.mp3') < host.events.indexOf('audio:B:B-single.mp3'), 'after the one that was ahead of it');
    await alice.runner.stop();
    assert.equal(host.gate.busy(), false);
  });

  test('stop({ abandon }) lets a file waiting at the gate go, without its answer counting as dealt with, and the other chat is not disturbed', async (t) => {
    const host = harness(t);
    host.hold('A-single');
    const alice = host.person('A');
    const bob = host.person('B', { withResume: true });
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('song');
    void alice.runner.tick();
    await until(() => host.events.includes('fetch:A:A-single'), "A's song to start downloading");
    const request = bob.ask('song');
    void bob.runner.tick();
    await until(() => host.gate.pending('B') > 0, "B's file to be waiting");

    await Promise.race([bob.runner.stop({ abandon: true }), sleep(500).then(() => assert.fail('stop({ abandon }) waited for the other chat'))]);
    assert.equal(host.gate.pending('B'), 0, 'nothing of B is left in the line');
    assert.equal(starting(host.events, 'fetch:B:').length, 0, "B's song was never fetched");
    assert.ok(
      bob.saved.every((point) => !point.ids.includes(request)),
      "B's request is not marked as dealt with, so a restart answers it",
    );
    host.open('A-single');
    await alice.runner.stop();
    assert.equal(starting(host.events, 'audio:A:').length, 1, "A's song went out");
    assert.equal(host.gate.busy(), false);
  });

  test('an announcement does not wait for the gate, and the chat keeps being read meanwhile', async (t) => {
    const host = harness(t);
    host.hold('A-single');
    const alice = host.person('A');
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('song');
    void alice.runner.tick();
    await until(() => host.events.includes('fetch:A:A-single'), "A's song to start downloading");
    assert.equal(host.gate.running(), 'A');

    await Promise.race([
      bob.runner.announce([{ kind: 'text', text: 'daily message' }, { kind: 'audio', url: 'https://music.test/daily.mp3', title: 'B-daily' }]),
      sleep(1_000).then(() => assert.fail('the announcement waited for the gate')),
    ]);
    assert.ok(host.events.includes('audio:B:B-daily.mp3'), 'it went out while the other file held the gate');
    bob.ask('hello');
    await bob.runner.tick();
    assert.ok(host.events.includes('text:B:🎵 answer to hello'), 'and B is still being read');
    host.open('A-single');
    await alice.runner.stop();
  });

  test('busy() is true for every runner while a file is under way on the shared gate, and not otherwise', async (t) => {
    const host = harness(t);
    host.hold('A-single');
    const alice = host.person('A');
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    assert.equal(alice.runner.busy(), false);
    assert.equal(bob.runner.busy(), false);
    alice.ask('song');
    void alice.runner.tick();
    await until(() => host.events.includes('fetch:A:A-single'), "A's song to start downloading");
    assert.equal(alice.runner.busy(), true);
    assert.equal(bob.runner.busy(), true, 'B has nothing to send, but the host is busy');
    host.open('A-single');
    await alice.runner.stop();
    assert.equal(alice.runner.busy(), false);
    assert.equal(bob.runner.busy(), false);
  });

  test("a chat alone on the host sends a song as soon as that song is in hand, however slow the downloads ahead of it are", async (t) => {
    const host = harness(t);
    host.hold('A2');
    host.hold('A3');
    const alice = host.person('A', { downloadsAhead: 3 });
    await alice.runner.prime();
    alice.ask('all 4');
    const sent = alice.runner.tick();
    // The second and third songs are still on their way (held), and the first goes out all the same.
    await until(() => starting(host.events, 'audio:A:').length === 1, 'the first song to go out while the next two are still downloading');
    assert.ok(host.events.includes('fetch:A:A3'), 'the third download had started');
    // The window slides as it always did: the fourth starts once the first is in hand, without waiting for the second and third.
    await until(() => host.events.includes('fetch:A:A4'), 'the fourth download to start while the second and third are held');
    assert.equal(starting(host.events, 'audio:A:').length, 1, 'and nothing else has gone out');
    host.open('A3');
    host.open('A2');
    await sent;
    assert.deepEqual(
      starting(host.events, 'audio:A:'),
      [1, 2, 3, 4].map((n) => `audio:A:A${n}.mp3`),
      'in the order asked',
    );
    assert.equal(host.gate.busy(), false);
  });

  test("a chat alone on the host is paced by its gap, not by its slowest download ahead", async (t) => {
    const host = harness(t);
    const alice = host.person('A', { downloadsAhead: 3, fetchMs: 160, songGapMs: 20 });
    await alice.runner.prime();
    alice.ask('all 6');
    const started = Date.now();
    await alice.runner.tick();
    const took = Date.now() - started;
    assert.equal(starting(host.events, 'audio:A:').length, 6);
    // Each download takes 160 ms and the window slides three wide, so the six songs are out after about 360 ms. If each song waited for
    // the downloads started ahead of it to finish (a turn that ends only when they are in hand), the same six would take about 800 ms.
    assert.ok(took < 580, `six songs took ${took} ms`);
  });

  test("a chat's downloads ahead keep the gate while it waits out its gap: another chat's file starts only once they are in hand", async (t) => {
    const host = harness(t);
    host.hold('A3');
    const alice = host.person('A', { downloadsAhead: 2, songGapMs: 600 });
    const bob = host.person('B');
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('all 4');
    const allSent = alice.runner.tick();
    await until(() => starting(host.events, 'audio:A:').length === 1 && host.events.includes('fetch:A:A3'), "A's first song to be up and its third download to be under way");
    bob.ask('song');
    const bobSent = bob.runner.tick();
    await until(() => host.events.includes('ask:B:song'), 'B to be asked');
    await sleep(120);
    assert.equal(starting(host.events, 'fetch:B:').length, 0, "B's download did not start while A's was still under way, though A is only waiting out its gap");
    assert.equal(host.gate.running(), 'A', 'the gate is still A\'s');
    host.open('A3');
    await bobSent;
    assert.equal(host.flight.mostUploading, 1);
    assert.ok(starting(host.events, 'audio:A:').length < 4, "B's song did not wait for the rest of A's");
    await allSent;
    assert.deepEqual(
      starting(host.events, 'audio:A:'),
      [1, 2, 3, 4].map((n) => `audio:A:A${n}.mp3`),
    );
    assert.equal(host.gate.busy(), false);
  });

  test("a chat does not download ahead while another chat is waiting for the gate: its next song is fetched in its own turn, and still sent", async (t) => {
    const host = harness(t);
    host.hold('B1');
    const alice = host.person('A', { downloadsAhead: 2 });
    const bob = host.person('B', { downloadsAhead: 2, songGapMs: 250 });
    await alice.runner.prime();
    await bob.runner.prime();
    bob.ask('all 3');
    const bobSent = bob.runner.tick();
    // Nobody else is waiting, so B's first turn starts its first two downloads ahead (the first is held).
    await until(() => host.events.includes('fetch:B:B1') && host.events.includes('fetch:B:B2'), "B's first two downloads to start");
    alice.ask('all 2');
    const aliceSent = alice.runner.tick();
    await until(() => host.gate.pending('A') >= 2, "A's turns to be waiting for the gate");
    host.open('B1');
    await until(() => host.events.includes('fetch:A:A1'), "A's turn to come");
    // B's first song was in hand and went out while A was waiting: B started no third download then (A's turn would have sat behind it,
    // and the finished song would have been held in memory for B's turn, which is after A's file), but fetches it in its own turn.
    assert.ok(host.events.indexOf('audio:B:B1.mp3') < host.events.indexOf('fetch:A:A1'), "B's first song went out before A's turn");
    assert.ok(!host.events.slice(0, host.events.indexOf('fetch:A:A1')).includes('fetch:B:B3'), "B's third download did not start while A was waiting");
    await bobSent;
    await aliceSent;
    assert.deepEqual(starting(host.events, 'audio:B:'), [1, 2, 3].map((n) => `audio:B:B${n}.mp3`), 'all three of B went out, in order, though the third was not fetched ahead');
    assert.deepEqual(starting(host.events, 'audio:A:'), [1, 2].map((n) => `audio:A:A${n}.mp3`));
    assert.deepEqual(bob.logs.filter((line) => /could not/.test(line)), []);
    assert.equal(host.gate.busy(), false);
  });

  test('two chats sending long lists at once hold no more fetched songs than one chat would: the downloads ahead wait for a quiet gate', async (t) => {
    const host = harness(t);
    const alice = host.person('A', { downloadsAhead: 1, fetchMs: 20 });
    const bob = host.person('B', { downloadsAhead: 1, fetchMs: 20 });
    await alice.runner.prime();
    await bob.runner.prime();
    alice.ask('all 6');
    bob.ask('all 6');
    await Promise.all([alice.runner.tick(), bob.runner.tick()]);
    assert.equal(starting(host.events, 'audio:A:').length, 6);
    assert.equal(starting(host.events, 'audio:B:').length, 6);
    assert.equal(host.flight.mostFetching, 1, 'one download at a time on the host');
    assert.equal(host.flight.mostHeld, 1, `at most one fetched song was held (${host.flight.mostHeld})`);
  });

  test('a host short of memory fetches each song in its own turn, one at a time, and sends them all in order', async (t) => {
    const host = harness(t);
    const alice = host.person('A', { downloadsAhead: 3, memoryRoom: () => false });
    await alice.runner.prime();
    alice.ask('all 4');
    await alice.runner.tick();
    // Each song is fetched when its turn comes (nothing is fetched ahead), so a fetch never starts before the song before it is on its way.
    const steps = host.events.filter((event) => event.startsWith('fetch:A:') || event.startsWith('audio:A:'));
    assert.deepEqual(
      steps,
      [1, 2, 3, 4].flatMap((n) => [`fetch:A:A${n}`, `audio:A:A${n}.mp3`]),
    );
    assert.equal(host.flight.mostFetching, 1);
    assert.equal(host.flight.mostHeld, 1);
    assert.equal(host.gate.busy(), false);
  });

  test('a host with memory to spare still fetches ahead when nobody else is waiting (memoryRoom true)', async (t) => {
    const host = harness(t);
    host.hold('A1');
    const alice = host.person('A', { downloadsAhead: 3, memoryRoom: () => true });
    await alice.runner.prime();
    alice.ask('all 4');
    const sent = alice.runner.tick();
    await until(() => host.events.includes('fetch:A:A3'), 'the third download to start while the first is held');
    assert.equal(starting(host.events, 'audio:A:').length, 0);
    host.open('A1');
    await sent;
    assert.deepEqual(starting(host.events, 'audio:A:'), [1, 2, 3, 4].map((n) => `audio:A:A${n}.mp3`));
  });

  test('a runner without a gate of its own to share behaves as it always did: songs in order, downloads ahead, busy while sending', async (t) => {
    const host = harness(t);
    const solo = host.person('A', { gate: null, downloadsAhead: 2 });
    await solo.runner.prime();
    assert.equal(solo.runner.busy(), false);
    solo.ask('all 4');
    const sent = solo.runner.tick();
    await until(() => host.events.includes('fetch:A:A1'), 'the first download');
    assert.equal(solo.runner.busy(), true);
    await sent;
    assert.equal(solo.runner.busy(), false);
    assert.deepEqual(
      starting(host.events, 'audio:A:'),
      [1, 2, 3, 4].map((n) => `audio:A:A${n}.mp3`),
    );
    // Two downloads ahead: the second starts before the first song has gone out.
    assert.ok(host.events.indexOf('fetch:A:A2') < host.events.indexOf('audio:A:A1.mp3'));
    assert.equal(host.flight.mostUploading, 1);
    assert.deepEqual(solo.failures.filter((poll) => !poll.ok), []);
  });
});
