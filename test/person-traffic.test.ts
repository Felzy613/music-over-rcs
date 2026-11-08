import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { Drive } from '../src/archive/archiver.ts';
import type { Bot } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { parsePersonBudget, personBudgetOrDefault } from '../src/config.ts';
import type { DownloadedAudio } from '../src/audio-fetch.ts';
import { setUpLibrary } from '../src/library/setup.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { OWNER, personOf } from '../src/people.ts';
import { BOT_MARK, createRunner, type Runner } from '../src/runner.ts';
import { SETTINGS } from '../src/admin/settings.ts';
import type { Incoming, Reply } from '../src/types.ts';
import {
  TRAFFIC_ALERT_BYTES,
  addArchived,
  addSent,
  archivedThisMonth,
  monthlyAllowance,
  peopleTraffic,
  sendersThisMonth,
  sentByEveryone,
  sentCounter,
  sentShares,
  sentThisMonth,
  trafficProblem,
  trafficThisMonth,
} from '../src/usage.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';

const MB = 1048576;
const ALICE = personOf('alice');
const BOB = personOf('bob');
const OCT = new Date('2026-10-20T00:00:00Z');
const NOV = new Date('2026-11-02T00:00:00Z');

describe('what is sent, counted for each person', () => {
  test('the owner keeps the key every release before people used, and writes nothing else', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 1000, OCT);
    addSent(catalog, 500.4, OCT, 'owner');
    addSent(catalog, 7, OCT, OWNER);
    assert.equal(catalog.getState('usage.2026-10.sent_bytes'), '1507');
    assert.equal(catalog.getState('usage.2026-10.people'), undefined, 'no list of people appears for the owner alone');
    assert.deepEqual(sendersThisMonth(catalog, OCT), []);
    assert.equal(sentThisMonth(catalog, OCT), 1507);
    assert.equal(sentByEveryone(catalog, OCT), 1507);
    assert.deepEqual(sentShares(catalog, OCT), [{ id: 'owner', bytes: 1507 }]);
    assert.equal(trafficThisMonth(catalog, OCT), 1507);
  });

  test('a person has a count of their own, and the others and the owner are not touched', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 100, OCT);
    addSent(catalog, 2000, OCT, 'alice');
    addSent(catalog, 30, OCT, ALICE);
    addSent(catalog, 400, OCT, BOB);
    assert.equal(catalog.getState('usage.2026-10.alice.sent_bytes'), '2030');
    assert.equal(catalog.getState('usage.2026-10.bob.sent_bytes'), '400');
    assert.equal(catalog.getState('usage.2026-10.sent_bytes'), '100', 'the owner’s key keeps only the owner’s');
    assert.equal(sentThisMonth(catalog, OCT), 100);
    assert.equal(sentThisMonth(catalog, OCT, 'alice'), 2030);
    assert.equal(sentThisMonth(catalog, OCT, BOB), 400);
    assert.equal(sentThisMonth(catalog, OCT, 'carol'), 0);
    assert.deepEqual(sendersThisMonth(catalog, OCT), ['alice', 'bob']);
    assert.deepEqual(sentShares(catalog, OCT), [
      { id: 'owner', bytes: 100 },
      { id: 'alice', bytes: 2030 },
      { id: 'bob', bytes: 400 },
    ]);
    assert.equal(sentByEveryone(catalog, OCT), 2530, 'the host’s total is everybody’s together');
  });

  test('the list of people is written when a person first sends in a month, not each time, and nothing is counted for nothing', () => {
    const writes: string[] = [];
    const catalog = new Catalog(':memory:');
    const state = {
      getState: (key: string) => catalog.getState(key),
      setState: (key: string, value: string) => {
        writes.push(key);
        catalog.setState(key, value);
      },
    };
    addSent(state, 0, OCT, 'alice');
    addSent(state, -5, OCT, 'alice');
    assert.deepEqual(writes, [], 'a file of no bytes writes nothing, and does not make her a sender');
    addSent(state, 10, OCT, 'alice');
    addSent(state, 10, OCT, 'alice');
    addSent(state, 10, OCT, 'alice');
    assert.deepEqual(writes, ['usage.2026-10.people', 'usage.2026-10.alice.sent_bytes', 'usage.2026-10.alice.sent_bytes', 'usage.2026-10.alice.sent_bytes']);
    assert.equal(sentThisMonth(catalog, OCT, 'alice'), 30);
  });

  test('a month starts at nothing for everybody', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 1000, OCT);
    addSent(catalog, 2000, OCT, 'alice');
    addSent(catalog, 300, NOV, 'alice');
    assert.equal(sentByEveryone(catalog, OCT), 3000);
    assert.equal(sentByEveryone(catalog, NOV), 300);
    assert.deepEqual(sendersThisMonth(catalog, NOV), ['alice']);
    assert.equal(sentThisMonth(catalog, NOV), 0);
    assert.equal(sentThisMonth(catalog, new Date('2026-12-01T00:00:00Z'), 'alice'), 0);
    assert.deepEqual(sentShares(catalog, new Date('2026-12-01T00:00:00Z')), [{ id: 'owner', bytes: 0 }]);
  });

  test('a name that cannot be a person’s is refused instead of making a key that is somebody else’s', () => {
    const catalog = new Catalog(':memory:');
    for (const bad of ['Alice', 'a.b', 'a,b', 'x', 'me', 'gmessagesbot', '', 'sent_bytes', 'a b']) {
      assert.throws(() => addSent(catalog, 10, OCT, bad), /usage: /, bad);
      assert.throws(() => sentThisMonth(catalog, OCT, bad), /usage: /, bad);
      assert.throws(() => sentCounter(catalog, bad), /usage: /, bad);
    }
    assert.equal(sentByEveryone(catalog, OCT), 0);
  });

  test('every sender counts toward the alert, including someone who is no longer listed', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 1500 * MB, OCT);
    addSent(catalog, 1000 * MB, OCT, 'alice');
    addSent(catalog, 400 * MB, OCT, 'carol'); // left the list since: still sent this month
    addArchived(catalog, 99 * MB, OCT);
    assert.equal(trafficThisMonth(catalog, OCT), 2999 * MB);
    assert.equal(trafficProblem(catalog, OCT), undefined);
    addArchived(catalog, 1001 * MB, OCT);
    assert.equal(trafficThisMonth(catalog, OCT), TRAFFIC_ALERT_BYTES);
    assert.equal(
      trafficProblem(catalog, OCT),
      "The host has sent 4,000 MB this month (1,500 MB of songs for you, 1,000 MB for alice, 400 MB for carol, 1,100 MB of OneDrive copies); Render's free plan includes about 5,000 MB and charges past it. Lower PERSON_MAX_MB_PER_MONTH or ONEDRIVE_MAX_MB_PER_MONTH in Render, or ask for fewer albums until the month is over.",
    );
    assert.equal(trafficProblem(catalog, NOV), undefined, 'a new month starts at nothing');
  });

  test('with only the owner the alert says exactly what it always said', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 3000 * MB, OCT);
    addArchived(catalog, 1000 * MB, OCT);
    assert.equal(
      trafficProblem(catalog, OCT),
      "The host has sent 4,000 MB this month (3,000 MB of songs, 1,000 MB of OneDrive copies); Render's free plan includes about 5,000 MB and charges past it. Lower ONEDRIVE_MAX_MB_PER_MONTH in Render, or ask for fewer albums until the month is over.",
    );
  });

  test('the people besides the owner could alone tip the alert', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 100 * MB, OCT);
    addSent(catalog, 2000 * MB, OCT, 'alice');
    addSent(catalog, 1899 * MB, OCT, 'bob');
    assert.equal(trafficProblem(catalog, OCT), undefined, '3,999 MB');
    addSent(catalog, 1 * MB, OCT, 'bob');
    assert.match(trafficProblem(catalog, OCT) ?? '', /^The host has sent 4,000 MB this month \(100 MB of songs for you, 2,000 MB for alice, 1,900 MB for bob, 0 MB of OneDrive copies\)/);
  });

  test('the archive’s own count stays the owner’s alone', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 10, OCT, 'alice');
    assert.equal(archivedThisMonth(catalog, OCT), 0);
    addArchived(catalog, 5, OCT);
    assert.equal(archivedThisMonth(catalog, OCT), 5);
    assert.equal(sentThisMonth(catalog, OCT, 'alice'), 10);
  });
});

describe('each person’s Matrix client counts its own uploads', () => {
  let mocks: { owner: MockMatrix; alice: MockMatrix; bob: MockMatrix };
  before(async () => {
    mocks = { owner: await startMockMatrix(), alice: await startMockMatrix(), bob: await startMockMatrix() };
  });
  after(async () => {
    await Promise.all(Object.values(mocks).map((mock) => mock.close()));
  });

  test('a file uploaded by a person’s client lands in that person’s count, and only there', async () => {
    const catalog = new Catalog(':memory:');
    const clients = {
      owner: new MatrixClient({ token: mocks.owner.token, homeserver: mocks.owner.url, onUpload: sentCounter(catalog) }),
      alice: new MatrixClient({ token: mocks.alice.token, homeserver: mocks.alice.url, onUpload: sentCounter(catalog, ALICE) }),
      bob: new MatrixClient({ token: mocks.bob.token, homeserver: mocks.bob.url, onUpload: sentCounter(catalog, 'bob') }),
    };
    const audio = (bytes: number) => ({ data: new Blob([new Uint8Array(bytes)]), fileName: 'a.mp3', mimeType: 'audio/mpeg', bytes });
    await clients.owner.sendAudio(mocks.owner.roomId, audio(1000) as never);
    await clients.alice.sendAudio(mocks.alice.roomId, audio(2000) as never);
    await clients.alice.sendAudio(mocks.alice.roomId, audio(300) as never);
    await clients.bob.sendAudio(mocks.bob.roomId, audio(40) as never);
    assert.equal(sentThisMonth(catalog), 1000);
    assert.equal(sentThisMonth(catalog, new Date(), 'alice'), 2300);
    assert.equal(sentThisMonth(catalog, new Date(), 'bob'), 40);
    assert.equal(sentByEveryone(catalog), 3340);
  });

  test('the counter uses the clock it is given, once per file', () => {
    const catalog = new Catalog(':memory:');
    let now = OCT;
    const count = sentCounter(catalog, ALICE, () => now);
    count(10);
    now = NOV;
    count(20);
    count(0);
    assert.equal(sentThisMonth(catalog, OCT, 'alice'), 10);
    assert.equal(sentThisMonth(catalog, NOV, 'alice'), 20);
  });
});

describe('a person’s monthly share', () => {
  test('is a number of MB, 1,000 unless set, or unlimited; a typo never lifts the limit', () => {
    assert.equal(parsePersonBudget(undefined), 1000 * MB);
    assert.equal(parsePersonBudget(''), 1000 * MB);
    assert.equal(parsePersonBudget('250'), 250 * MB);
    assert.equal(parsePersonBudget(' 0 '), 0);
    assert.equal(parsePersonBudget('Unlimited'), undefined);
    assert.ok(parsePersonBudget('lots') instanceof Error);
    assert.match((parsePersonBudget('-5') as Error).message, /PERSON_MAX_MB_PER_MONTH/);
    const warned: string[] = [];
    assert.equal(personBudgetOrDefault('lots', (line) => void warned.push(line)), 1000 * MB, 'the default, not no limit');
    assert.match(warned.join(), /PERSON_MAX_MB_PER_MONTH must be a number of MB or "unlimited" \(got "lots"\); using 1000 MB/);
    assert.equal(personBudgetOrDefault('300'), 300 * MB);
    assert.equal(personBudgetOrDefault('unlimited'), undefined);
  });

  test('the setting is listed for the console', () => {
    const spec = SETTINGS.find((one) => one.key === 'PERSON_MAX_MB_PER_MONTH');
    assert.ok(spec, 'listed');
    assert.equal(spec.default, '1000');
    assert.ok(!spec.secret);
  });

  test('says nothing while there is room, and from the cap on says so, in the bot’s own voice, with the numbers', () => {
    const catalog = new Catalog(':memory:');
    let now = OCT;
    const allowance = monthlyAllowance({ state: catalog, person: ALICE, maxBytes: 100 * MB, now: () => now });
    assert.equal(allowance(), undefined);
    addSent(catalog, 99 * MB, OCT, 'alice');
    assert.equal(allowance(), undefined, 'one MB short of it');
    addSent(catalog, 1 * MB, OCT, 'alice');
    const refusal = allowance();
    assert.ok(refusal?.startsWith(BOT_MARK), 'it starts with the bot’s mark, as every message does');
    assert.match(refusal!, /used this month's share of songs \(100 of 100 MB\)/);
    assert.match(refusal!, /no more songs or albums until next month/);
    assert.match(refusal!, /Searching and browsing still work/);
    now = NOV;
    assert.equal(allowance(), undefined, 'a new month, a new share');
  });

  test('a cap can be read afresh each time, none at all means no limit, and zero means nothing may be sent', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 10 * MB, OCT, 'alice');
    let cap: number | undefined = 100 * MB;
    const live = monthlyAllowance({ state: catalog, person: 'alice', maxBytes: () => cap, now: () => OCT });
    assert.equal(live(), undefined);
    cap = 5 * MB;
    assert.match(live() ?? '', /\(10 of 5 MB\)/);
    cap = undefined;
    assert.equal(live(), undefined);
    assert.match(monthlyAllowance({ state: catalog, person: 'bob', maxBytes: 0, now: () => OCT })() ?? '', /\(0 of 0 MB\)/);
  });

  test('is each person’s own: one person’s use is not another’s', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 500 * MB, OCT, 'alice');
    const forAlice = monthlyAllowance({ state: catalog, person: ALICE, maxBytes: 100 * MB, now: () => OCT });
    const forBob = monthlyAllowance({ state: catalog, person: BOB, maxBytes: 100 * MB, now: () => OCT });
    assert.ok(forAlice());
    assert.equal(forBob(), undefined);
  });

  test('the owner has no cap, whatever has been sent and whatever limit is passed', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 4000 * MB, OCT);
    assert.equal(monthlyAllowance({ state: catalog, person: OWNER, maxBytes: 1, now: () => OCT })(), undefined);
    assert.equal(monthlyAllowance({ state: catalog, person: 'owner', maxBytes: 0, now: () => OCT })(), undefined);
  });

  test('/status lists each person with what they were sent this month and their cap', () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 1234 * MB, OCT, 'alice');
    assert.deepEqual(peopleTraffic(catalog, [ALICE, BOB], 1000 * MB, OCT), [
      { id: 'alice', sentThisMonthMb: 1234, monthlyLimitMb: 1000 },
      { id: 'bob', sentThisMonthMb: 0, monthlyLimitMb: 1000 },
    ]);
    assert.deepEqual(peopleTraffic(catalog, [ALICE], undefined, OCT), [{ id: 'alice', sentThisMonthMb: 1234, monthlyLimitMb: null }]);
    assert.deepEqual(peopleTraffic(catalog, [], 1000 * MB, OCT), [], 'no one but the owner');
  });

  test('the host reports it additively: the owner’s fields stay, the people and the total are new', () => {
    const main = readFileSync(new URL('../src/cloud-main.ts', import.meta.url), 'utf8');
    assert.match(main, /sentThisMonthMb: Math\.round\(sentThisMonth\(catalog\) \/ 1048576\)/, 'the owner’s own figure is where it was');
    assert.match(main, /sentTotalThisMonthMb: Math\.round\(sentByEveryone\(catalog\) \/ 1048576\)/);
    assert.match(main, /people: peopleTraffic\(catalog, configuredPeople, personBudget\)/);
    assert.match(main, /personBudgetOrDefault\(env\.PERSON_MAX_MB_PER_MONTH/);
  });
});

describe('a person over their share, in the runner', () => {
  let mock: MockMatrix;
  let other: MockMatrix;
  before(async () => {
    mock = await startMockMatrix();
    other = await startMockMatrix();
  });
  after(async () => {
    await mock.close();
    await other.close();
  });
  beforeEach(() => {
    mock.reset();
    other.reset();
  });

  interface Harness {
    runner: Runner;
    asked: Incoming[];
    fetched: string[];
    logs: string[];
    ask(text: string): string;
  }

  /** A bot that answers a few words, and a runner over a mock homeserver; `allowance` is what the runner is given. */
  function setUp(room: MockMatrix, catalog: Catalog, options: { person?: string; allowance?: () => string | undefined; songBytes?: number } = {}): Harness {
    const asked: Incoming[] = [];
    const fetched: string[] = [];
    const logs: string[] = [];
    const songBytes = options.songBytes ?? 1000;
    const client = new MatrixClient({ token: room.token, homeserver: room.url, onUpload: sentCounter(catalog, options.person ?? 'owner') });
    const bot: Bot = {
      handle: async (msg): Promise<Reply[]> => {
        asked.push(msg);
        if (msg.postback === 'play:1') return [{ kind: 'audio', url: 'https://music.test/one.mp3', title: 'One' }];
        // The runner takes a word-for-word repeat within 20 seconds for an echo, so a song is asked for as "song 1", "song 2"...
        if (/^song( \d+)?$/.test(msg.text ?? '')) return [{ kind: 'audio', url: `https://music.test/${msg.text!.replace(' ', '')}.mp3`, title: 'Song' }];
        switch (msg.text) {
          case 'hello':
            return [{ kind: 'text', text: 'hi there' }];
          case 'card':
            return [
              { kind: 'text', text: 'Here you go' },
              { kind: 'audio', url: 'https://music.test/card.mp3', title: 'Card' },
            ];
          case 'album':
            return [
              {
                kind: 'album',
                title: 'Album',
                artist: 'Band',
                songs: [
                  { number: 1, title: 'A', url: 'https://music.test/a.mp3' },
                  { number: 2, title: 'B', url: 'https://music.test/b.mp3' },
                ],
              },
            ];
          case 'menu':
            return [
              { kind: 'text', text: 'One — Band', postback: 'play:1', chips: [{ label: '1', postback: 'play:1' }] },
              { kind: 'text', text: 'Tap 👍 on a song.', chips: [{ label: '1', postback: 'play:1' }] },
            ];
          default:
            return [{ kind: 'text', text: `no idea about ${msg.text}` }];
        }
      },
    };
    const runner = createRunner({
      chat: client,
      bot,
      chatID: room.roomId,
      fetchAudio: async (_url, title): Promise<DownloadedAudio> => {
        fetched.push(title ?? '');
        return { data: new Blob([new Uint8Array(songBytes)]), fileName: `${title}.mp3`, mimeType: 'audio/mpeg', bytes: songBytes };
      },
      pollMs: 5,
      typingRefreshMs: 1_000_000,
      ...(options.allowance ? { allowance: options.allowance } : {}),
      log: (line) => logs.push(line),
    });
    return { runner, asked, fetched, logs, ask: (text) => room.addMessage(room.ghost, { msgtype: 'm.text', body: text }) };
  }

  const bodies = (room: MockMatrix): string[] => room.sent.map((one) => String(one.content.body));

  test('a song asked for after the share is used up is answered with a plain marked text: nothing is fetched or uploaded', async () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 100 * MB, new Date(), 'alice');
    const h = setUp(mock, catalog, { person: 'alice', allowance: monthlyAllowance({ state: catalog, person: ALICE, maxBytes: 100 * MB }) });
    await h.runner.prime();
    h.ask('song');
    await h.runner.tick();
    const [refusal, ...rest] = mock.sent;
    assert.deepEqual(rest, [], 'one message');
    assert.equal(refusal?.content.msgtype, 'm.text');
    assert.ok(String(refusal?.content.body).startsWith(BOT_MARK), 'the loop guard’s mark is on it');
    assert.match(String(refusal?.content.body), /used this month's share of songs \(100 of 100 MB\)/);
    assert.deepEqual(h.fetched, [], 'no download was started');
    assert.equal(mock.uploads.length, 0);
    assert.ok(h.logs.some((line) => /share is used up/.test(line)));
    assert.equal(h.runner.busy(), false);
  });

  test('the same song while there is room is sent, and the first one over the cap is the first one refused', async () => {
    const catalog = new Catalog(':memory:');
    const h = setUp(mock, catalog, { person: 'alice', songBytes: 1000, allowance: monthlyAllowance({ state: catalog, person: ALICE, maxBytes: 1500 }) });
    await h.runner.prime();
    for (const text of ['song 1', 'song 2', 'song 3']) {
      h.ask(text);
      await h.runner.tick();
    }
    assert.equal(mock.uploads.length, 2, '0 and then 1,000 of 1,500 were used: two songs went');
    assert.equal(sentThisMonth(catalog, new Date(), 'alice'), 2000);
    assert.deepEqual(h.fetched, ['Song', 'Song']);
    assert.match(bodies(mock).at(-1) ?? '', /^🎵 You've used this month's share of songs/, 'the last message is the refusal');
  });

  test('text answers are never refused, before and after the cap, and do not even ask', async () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 500 * MB, new Date(), 'alice');
    let asks = 0;
    const cap = monthlyAllowance({ state: catalog, person: ALICE, maxBytes: 100 * MB });
    const h = setUp(mock, catalog, {
      person: 'alice',
      allowance: () => {
        asks += 1;
        return cap();
      },
    });
    await h.runner.prime();
    h.ask('hello');
    h.ask('what is this');
    await h.runner.tick();
    assert.deepEqual(bodies(mock), ['🎵 hi there', '🎵 no idea about what is this']);
    assert.equal(asks, 0, 'a text-only answer is not held to the share');
    h.ask('menu');
    await h.runner.tick();
    assert.equal(asks, 0);
    assert.equal(mock.sent.length, 4, 'a menu is a text answer too');
  });

  test('an answer with a card and a song in it is refused whole, an album is refused, and the options already on screen stay pickable', async () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 500 * MB, new Date(), 'alice');
    const h = setUp(mock, catalog, { person: 'alice', allowance: monthlyAllowance({ state: catalog, person: ALICE, maxBytes: 100 * MB }) });
    await h.runner.prime();
    h.ask('menu');
    await h.runner.tick();
    const menu = mock.sent.length;
    h.ask('card');
    await h.runner.tick();
    assert.equal(mock.sent.length, menu + 1, 'only the refusal: not "Here you go" and then the refusal');
    assert.match(bodies(mock).at(-1) ?? '', /^🎵 You've used this month's share/);
    h.ask('album');
    await h.runner.tick();
    assert.equal(mock.sent.length, menu + 2);
    assert.equal(mock.uploads.length, 0, 'no song and no zip');
    assert.deepEqual(h.fetched, []);
    // The refusals carried no options of their own, so the menu before them is still the one a pick comes from.
    mock.addReaction(mock.ghost, mock.sent[0]!.eventId, '👍');
    await h.runner.tick();
    assert.deepEqual(h.asked.at(-1)?.postback, 'play:1', 'a 👍 on the menu’s line still reached the bot');
    assert.equal(mock.uploads.length, 0, 'and it was refused too, being a song');
    assert.equal(mock.sent.length, menu + 3);
  });

  test('a 👍 on a song of a menu is held to the share as well', async () => {
    const catalog = new Catalog(':memory:');
    const h = setUp(mock, catalog, { person: 'alice', songBytes: 2000, allowance: monthlyAllowance({ state: catalog, person: ALICE, maxBytes: 1500 }) });
    await h.runner.prime();
    h.ask('menu');
    await h.runner.tick();
    const line = mock.sent[0]!.eventId;
    mock.addReaction(mock.ghost, line, '👍');
    await h.runner.tick();
    assert.equal(mock.uploads.length, 1, 'with room, the song comes');
    mock.addReaction(mock.ghost, line, '👍🏽');
    await h.runner.tick();
    assert.equal(mock.uploads.length, 1, 'over the cap, it does not');
    assert.match(bodies(mock).at(-1) ?? '', /^🎵 You've used this month's share of songs/);
  });

  test('an album is sent while there is room', async () => {
    const catalog = new Catalog(':memory:');
    const h = setUp(mock, catalog, { person: 'alice', songBytes: 1000, allowance: monthlyAllowance({ state: catalog, person: ALICE, maxBytes: 1_000_000 }) });
    await h.runner.prime();
    h.ask('album');
    await h.runner.tick();
    assert.deepEqual(h.fetched.sort(), ['A', 'B']);
    assert.equal(mock.uploads.length, 1, 'one zip');
    assert.ok(sentThisMonth(catalog, new Date(), 'alice') > 2000, 'the zip counts toward the share');
  });

  test('a share that cannot be read does not stop the songs', async () => {
    const catalog = new Catalog(':memory:');
    const h = setUp(mock, catalog, {
      person: 'alice',
      allowance: () => {
        throw new Error('database is locked');
      },
    });
    await h.runner.prime();
    h.ask('song');
    await h.runner.tick();
    assert.equal(mock.uploads.length, 1);
    assert.ok(h.logs.some((line) => /could not read this month's share: database is locked/.test(line)));
  });

  test('with no allowance, as the owner’s runner has, any amount is sent', async () => {
    const catalog = new Catalog(':memory:');
    addSent(catalog, 9000 * MB);
    const h = setUp(mock, catalog);
    await h.runner.prime();
    h.ask('song 1');
    h.ask('song 2');
    await h.runner.tick();
    assert.equal(mock.uploads.length, 2);
    assert.ok(!bodies(mock).some((body) => /share of songs/.test(body)));
  });

  test('two people on one host are held to their own shares, and the owner to none', async () => {
    const catalog = new Catalog(':memory:');
    const alice = setUp(mock, catalog, { person: 'alice', songBytes: 1000, allowance: monthlyAllowance({ state: catalog, person: ALICE, maxBytes: 1500 }) });
    const bob = setUp(other, catalog, { person: 'bob', songBytes: 1000, allowance: monthlyAllowance({ state: catalog, person: BOB, maxBytes: 1500 }) });
    await alice.runner.prime();
    await bob.runner.prime();
    for (let i = 1; i <= 3; i += 1) {
      alice.ask(`song ${i}`);
      await alice.runner.tick();
    }
    assert.equal(mock.uploads.length, 2, 'alice used her share');
    assert.match(bodies(mock).at(-1) ?? '', /share of songs/);

    bob.ask('song');
    await bob.runner.tick();
    assert.equal(other.uploads.length, 1, 'bob’s share is his own: he is not held to alice’s use');
    assert.ok(!bodies(other).some((body) => /share of songs/.test(body)));

    const now = new Date();
    assert.equal(sentThisMonth(catalog, now, 'alice'), 2000);
    assert.equal(sentThisMonth(catalog, now, 'bob'), 1000);
    assert.equal(sentThisMonth(catalog, now), 0, 'and the owner’s count is untouched by either');
    assert.equal(sentByEveryone(catalog, now), 3000);
  });
});

describe('a person’s songs are not saved to the owner’s OneDrive', () => {
  class FakeDrive implements Drive {
    files = new Map<string, Uint8Array>();
    uploads: string[] = [];
    connected = () => true;
    exists = async (path: string) => this.files.has(path);
    upload = async (path: string, data: Uint8Array | Blob) => {
      this.uploads.push(path);
      this.files.set(path, data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data);
    };
  }
  const MPEG = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, ...Array.from({ length: 400 }, (_, i) => i % 251)]);
  const raw = async (): Promise<DownloadedAudio> => ({ data: new Blob([MPEG], { type: 'audio/mpeg' }), fileName: 'raw.mp3', mimeType: 'audio/mpeg', bytes: MPEG.length });

  function library() {
    const catalog = new Catalog(':memory:');
    const url = 'https://x.test/derech';
    catalog.add({ title: 'Derech', artist: 'Ishay Ribo', url });
    const drive = new FakeDrive();
    const lib = setUpLibrary({
      catalog,
      musicTable: undefined,
      audio: { checkAudio: async () => ({ ok: true }) as never, fetchAudio: raw },
      dbPath: ':memory:',
      digestAt: undefined,
      prefetchMb: 0,
      cloudFolder: drive,
      log: () => {},
    });
    return { catalog, drive, lib, url };
  }

  test('a person’s songs are tagged and sent as the owner’s are, but never queued for the owner’s drive or counted in its allowance', async () => {
    const { catalog, drive, lib, url } = library();
    // The real archive: whatever is offered would be queued, and `idle()` would then wait out its delay before the upload.
    const alice = await lib.forPerson(ALICE).fetchAudio(url, 'Derech');
    const bob = await lib.forPerson(BOB).fetchAudio(url, 'Derech');
    await lib.archive!.idle(); // returns at once: nothing was queued
    assert.deepEqual(drive.uploads, [], 'nothing of theirs reached the owner’s drive');
    assert.equal(archivedThisMonth(catalog), 0, 'and none of its monthly allowance was used');
    assert.match(alice.fileName, /Ishay Ribo - Derech/, 'they still get the named, tagged file');
    assert.ok(alice.bytes > MPEG.length, 'the tags were written in');
    assert.equal(bob.fileName, alice.fileName);

    const offered: string[] = [];
    lib.archive!.offer = (u) => void offered.push(u);
    const owner = await lib.forPerson(OWNER).fetchAudio(url, 'Derech');
    assert.deepEqual(offered, [url], 'the owner’s is still offered');
    assert.equal(owner.fileName, alice.fileName);
    assert.equal(lib.forPerson(OWNER).fetchAudio, lib.fetchAudio, 'the library’s own is the owner’s');
  });

  test('a person’s song is not offered even right after the owner’s same song', async () => {
    const { lib, url } = library();
    const offered: string[] = [];
    lib.archive!.offer = (u) => void offered.push(u);
    await lib.fetchAudio(url, 'Derech');
    await lib.forPerson(ALICE).fetchAudio(url, 'Derech');
    await lib.forPerson(BOB).fetchAudio(url, 'Derech');
    assert.deepEqual(offered, [url], 'offered once, for the owner');
  });

  test('without a OneDrive there is nothing to offer to, for anyone', async () => {
    const lib = setUpLibrary({ catalog: new Catalog(':memory:'), musicTable: undefined, audio: { checkAudio: async () => ({ ok: true }) as never, fetchAudio: raw }, dbPath: ':memory:', digestAt: undefined, prefetchMb: 0, log: () => {} });
    assert.equal(lib.archive, undefined);
    assert.ok((await lib.forPerson(ALICE).fetchAudio('https://x.test/a')).bytes > 0);
    assert.ok((await lib.forPerson(OWNER).fetchAudio('https://x.test/a')).bytes > 0);
  });
});
