import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { hostRestarter } from '../src/cloud/host-restart.ts';
import { NO_BUCKET, PeopleDesk } from '../src/cloud/people-desk.ts';
import { MAX_PEOPLE, PEOPLE_OBJECT, PeopleList, PeopleListError, serializePeople } from '../src/cloud/people-list.ts';
import { FakeBucket } from './helpers/fake-bucket.ts';

// What the People tab does with the list: who is set in Render, who was added here, who is running, and the restart that sets a change up.

function make(options: { fromRender?: string[]; running?: string[]; bucket?: FakeBucket | null; hostPid?: string } = {}) {
  const bucket = options.bucket === null ? undefined : (options.bucket ?? new FakeBucket());
  const lines: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
  const timers: Array<() => void> = [];
  const restarter = hostRestarter(options.hostPid === undefined ? { HOST_PID: '4242' } : { HOST_PID: options.hostPid }, {
    kill: (pid, signal) => void signals.push({ pid, signal }),
    setTimer: (work) => void timers.push(work),
    ownPid: 77,
  });
  const desk = new PeopleDesk({
    fromRender: options.fromRender ?? [],
    running: options.running ?? [],
    reserved: ['dave'],
    list: bucket ? new PeopleList({ store: bucket.s3, reserved: ['dave'] }) : undefined,
    restarter,
    bootId: 1700000000000,
    log: (line) => lines.push(line),
  });
  return { desk, bucket, lines, signals, timers, restarter };
}
const states = (entries: Array<{ id: string; state: string; source: string }>) => entries.map((entry) => `${entry.id}:${entry.source}:${entry.state}`);

describe('what the People tab shows', () => {
  test('nobody besides the owner: an empty list that can be changed, and nothing waiting', async () => {
    const { desk } = make();
    const view = await desk.overview();
    assert.deepEqual([view.entries, view.canChange, view.whyNot, view.pendingRestart, view.max, view.bootId], [[], true, null, false, MAX_PEOPLE, 1700000000000]);
    assert.deepEqual(view.restart, { available: true, whyNot: null, pending: false });
  });

  test('names set in Render are Render’s, and are running', async () => {
    const { desk } = make({ fromRender: ['alice', 'bob'], running: ['alice', 'bob'] });
    const view = await desk.overview();
    assert.deepEqual(states(view.entries), ['alice:render:running', 'bob:render:running']);
    assert.equal(view.pendingRestart, false);
  });

  test('a name saved here and not running is waiting for the restart; one running and no longer saved is leaving at it', async () => {
    const bucket = new FakeBucket();
    bucket.objects.set(PEOPLE_OBJECT, { body: serializePeople([{ id: 'carol', addedAt: '2026-11-08T12:00:00.000Z' }, { id: 'dina', addedAt: null }]), etag: '"1"' });
    const { desk } = make({ bucket, fromRender: ['alice'], running: ['alice', 'carol', 'eve'] });
    const view = await desk.overview();
    assert.deepEqual(states(view.entries), ['alice:render:running', 'carol:console:running', 'dina:console:adding', 'eve:console:removing']);
    assert.equal(view.entries.find((entry) => entry.id === 'carol')!.addedAt, '2026-11-08T12:00:00.000Z');
    assert.equal(view.pendingRestart, true);
  });

  test('with no bucket the list cannot be changed and says why in plain words; PEOPLE still shows', async () => {
    const { desk } = make({ bucket: null, fromRender: ['alice'], running: ['alice'] });
    const view = await desk.overview();
    assert.equal(view.canChange, false);
    assert.equal(view.whyNot, NO_BUCKET);
    assert.match(view.whyNot!, /R2/);
    assert.match(view.whyNot!, /PEOPLE in Render still works/);
    assert.deepEqual(states(view.entries), ['alice:render:running']);
    await assert.rejects(desk.add('bob'), (err: PeopleListError) => err.status === 409 && err.message === NO_BUCKET);
    await assert.rejects(desk.remove('bob'), (err: PeopleListError) => err.status === 409 && err.message === NO_BUCKET);
    await assert.rejects(desk.restart(), (err: PeopleListError) => err.status === 409);
  });

  test('a bucket that cannot be read says so, shows who is running, and changes nothing', async () => {
    const bucket = new FakeBucket();
    bucket.s3.get = async () => {
      throw new Error('R2 refused reading config/people.json (HTTP 500)');
    };
    const { desk } = make({ bucket, running: ['alice'] });
    const view = await desk.overview();
    assert.equal(view.canChange, false);
    assert.match(view.whyNot!, /R2 refused reading/);
    assert.deepEqual(states(view.entries), ['alice:console:running']);
    assert.equal(view.pendingRestart, false);
    await assert.rejects(desk.add('bob'), (err: PeopleListError) => err.status === 503);
  });

  test('a damaged list says so and is not changed from here', async () => {
    const bucket = new FakeBucket();
    bucket.objects.set(PEOPLE_OBJECT, { body: '{{{', etag: '"1"' });
    const { desk } = make({ bucket });
    const view = await desk.overview();
    assert.equal(view.canChange, false);
    assert.match(view.whyNot!, /not valid JSON/);
    await assert.rejects(desk.add('alice'), (err: PeopleListError) => err.status === 409);
    assert.equal(bucket.objects.get(PEOPLE_OBJECT)!.body, '{{{');
  });

  test('a host that cannot restart itself says so, beside the list', async () => {
    const { desk } = make({ hostPid: '' });
    const view = await desk.overview();
    assert.equal(view.restart.available, false);
    assert.match(view.restart.whyNot!, /Restart the service in Render/);
    assert.equal(view.canChange, true, 'the list can still be kept');
  });

  test('the names from the environment are checked again: a bad one never reaches the page', () => {
    const { desk } = make({ fromRender: ['alice', 'Bad Name', 'dave', 'me'], running: ['alice', 'x'] });
    return desk.overview().then((view) => assert.deepEqual(states(view.entries), ['alice:render:running']));
  });
});

describe('adding a person', () => {
  test('saves the name, says a restart is needed, and logs it; nothing is signalled', async () => {
    const { desk, bucket, lines, signals } = make();
    const done = await desk.add('  Alice ');
    assert.deepEqual(done, { id: 'alice', pendingRestart: true, restartAvailable: true });
    assert.deepEqual(JSON.parse(bucket!.objects.get(PEOPLE_OBJECT)!.body).people.map((one: { id: string }) => one.id), ['alice']);
    assert.deepEqual(signals, []);
    assert.deepEqual(lines, ['people: alice added from the console; they are set up at the next restart']);
    assert.deepEqual(states((await desk.overview()).entries), ['alice:console:adding']);
  });

  test('refuses what cannot be a name, in plain words, and writes nothing', async () => {
    const { desk, bucket } = make();
    for (const [name, pattern] of [['', /Type a name/], ['a', /2 to 16/], ['Alice Smith', /One name at a time/], ['me', /reserved/], ['owner', /reserved/], ['gmessagesbot', /bridge/], ['dave', /owner's Matrix account/], ['al-ice', /lower-case/], [42, /Type a name/], [null, /Type a name/]] as const) {
      await assert.rejects(desk.add(name), (err: PeopleListError) => err.status === 400 && pattern.test(err.message), String(name));
    }
    assert.equal(bucket!.objects.size, 0);
  });

  test('a name already set in Render, or already added, is a 409', async () => {
    const { desk } = make({ fromRender: ['alice'], running: ['alice'] });
    await assert.rejects(desk.add('alice'), (err: PeopleListError) => err.status === 409 && /already set in the PEOPLE variable/.test(err.message));
    await desk.add('bob');
    await assert.rejects(desk.add('bob'), (err: PeopleListError) => err.status === 409 && /already added/.test(err.message));
  });

  test('stops at the most this host takes, counting the names in Render', async () => {
    const fromRender = ['r1', 'r2', 'r3'];
    const { desk } = make({ fromRender, running: fromRender });
    for (let i = 0; i < MAX_PEOPLE - fromRender.length; i++) await desk.add(`added${i}`);
    await assert.rejects(desk.add('onemore'), (err: PeopleListError) => err.status === 409 && /the most people/.test(err.message));
  });

  test('two adds at once both land', async () => {
    const { desk } = make();
    await Promise.all([desk.add('alice'), desk.add('bob'), desk.add('carol')]);
    assert.deepEqual((await desk.overview()).entries.map((entry) => entry.id).sort(), ['alice', 'bob', 'carol']);
  });

  test('is refused while a restart is on its way', async () => {
    const { desk } = make();
    await desk.add('alice');
    await desk.restart();
    await assert.rejects(desk.add('bob'), (err: PeopleListError) => err.status === 409 && /restart is on its way/.test(err.message));
    await assert.rejects(desk.remove('alice'), (err: PeopleListError) => err.status === 409);
  });
});

describe('removing a person', () => {
  test('a name added here is taken out of the list; a restart is needed if they were running', async () => {
    const { desk, bucket, lines } = make({ running: ['alice', 'bob'] });
    await desk.add('alice');
    await desk.add('bob');
    const done = await desk.remove('Alice');
    assert.deepEqual(done, { id: 'alice', wasRunning: true, pendingRestart: true, restartAvailable: true });
    assert.deepEqual(JSON.parse(bucket!.objects.get(PEOPLE_OBJECT)!.body).people.map((one: { id: string }) => one.id), ['bob']);
    assert.ok(lines.includes("people: alice removed from the console's list; they leave at the next restart"));
    assert.deepEqual(states((await desk.overview()).entries), ['bob:console:running', 'alice:console:removing']);
  });

  test('a name saved but never started needs no restart to go', async () => {
    const { desk } = make();
    await desk.add('alice');
    const done = await desk.remove('alice');
    assert.deepEqual(done, { id: 'alice', wasRunning: false, pendingRestart: false, restartAvailable: true });
    assert.equal((await desk.overview()).pendingRestart, false);
  });

  test('a name set in Render cannot be removed from here: the page cannot change Render', async () => {
    const { desk, bucket } = make({ fromRender: ['alice'], running: ['alice'] });
    await assert.rejects(desk.remove('alice'), (err: PeopleListError) => err.status === 409 && /set in the PEOPLE variable in Render/.test(err.message) && /cannot change Render/.test(err.message));
    assert.equal(bucket!.objects.size, 0, 'nothing was written');
    assert.deepEqual(states((await desk.overview()).entries), ['alice:render:running']);
  });

  test('a name that is not there is a 404, and nonsense is a 400', async () => {
    const { desk } = make();
    await assert.rejects(desk.remove('nobody'), (err: PeopleListError) => err.status === 404);
    for (const bad of ['', 'a b', 'a,b', undefined, 5]) await assert.rejects(desk.remove(bad), (err: PeopleListError) => err.status === 400, String(bad));
  });

  test('a name set in Render AND saved here is still Render’s: removing it here does nothing it could not undo', async () => {
    const bucket = new FakeBucket();
    bucket.objects.set(PEOPLE_OBJECT, { body: serializePeople([{ id: 'alice', addedAt: null }]), etag: '"1"' });
    const { desk } = make({ bucket, fromRender: ['alice'], running: ['alice'] });
    const view = await desk.overview();
    assert.deepEqual(states(view.entries), ['alice:render:running'], 'shown once, as Render’s');
    await assert.rejects(desk.remove('alice'), (err: PeopleListError) => err.status === 409);
  });
});

describe('restarting to set the change up', () => {
  test('asks the host once the list differs from who is running; the signal goes later, not now', async () => {
    const { desk, signals, timers } = make();
    await desk.add('alice');
    const done = await desk.restart();
    assert.equal(done.inSeconds, 3);
    assert.deepEqual(signals, [{ pid: 4242, signal: 0 }], 'only the is-it-there question so far');
    assert.equal(timers.length, 1);
    timers[0]!();
    assert.deepEqual(signals.at(-1), { pid: 4242, signal: 'SIGUSR2' });
  });

  test('once only: a second request while one is on its way is a 409', async () => {
    const { desk, timers } = make();
    await desk.add('alice');
    await desk.restart();
    await assert.rejects(desk.restart(), (err: PeopleListError) => err.status === 409);
    await assert.rejects(Promise.all([desk.restart(), desk.restart()]));
    assert.equal(timers.length, 1);
  });

  test('two requests at once still signal once', async () => {
    const { desk, timers } = make();
    await desk.add('alice');
    const results = await Promise.allSettled([desk.restart(), desk.restart(), desk.restart()]);
    assert.equal(results.filter((one) => one.status === 'fulfilled').length, 1);
    assert.equal(timers.length, 1);
  });

  test('is refused when nothing is waiting: the endpoint is for applying the list, not for bouncing the host', async () => {
    const { desk, signals, timers } = make({ fromRender: ['alice'], running: ['alice'] });
    await assert.rejects(desk.restart(), (err: PeopleListError) => err.status === 409 && /Nothing is waiting/.test(err.message));
    await desk.add('bob');
    await desk.remove('bob');
    await assert.rejects(desk.restart(), (err: PeopleListError) => err.status === 409 && /Nothing is waiting/.test(err.message));
    assert.deepEqual([signals, timers], [[], []]);
  });

  test('is refused when the host cannot restart itself, and says to restart the service in Render', async () => {
    const { desk, timers } = make({ hostPid: '' });
    await desk.add('alice');
    await assert.rejects(desk.restart(), (err: PeopleListError) => err.status === 409 && /Render/.test(err.message));
    assert.equal(timers.length, 0);
  });

  test('is refused while the list cannot be read: a restart on a guess would drop people', async () => {
    const bucket = new FakeBucket();
    const { desk, timers } = make({ bucket });
    await desk.add('alice');
    bucket.s3.get = async () => {
      throw new Error('R2 refused reading config/people.json (HTTP 500)');
    };
    await assert.rejects(desk.restart(), (err: PeopleListError) => err.status === 409 && /not asked for while the list cannot be read/.test(err.message));
    assert.equal(timers.length, 0);
  });

  test('looks at the list afresh, not at what it remembered', async () => {
    const bucket = new FakeBucket();
    const { desk, timers } = make({ bucket, running: ['alice'] });
    await desk.overview(); // remembered: nothing differs
    bucket.objects.set(PEOPLE_OBJECT, { body: serializePeople([]), etag: '"9"' }); // alice was removed elsewhere (another copy of the console)
    await desk.restart();
    assert.equal(timers.length, 1);
  });
});
