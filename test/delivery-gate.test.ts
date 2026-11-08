import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createDeliveryGate, GateAborted, isGateAborted } from '../src/delivery-gate.ts';

/** A unit of work that ends when the test says so, and writes its start and end in `log`. */
function job(log: string[], name: string) {
  let finish!: (value?: string) => void;
  let fail!: (reason: Error) => void;
  const ended = new Promise<string>((resolve, reject) => {
    finish = (value) => resolve(value ?? name);
    fail = reject;
  });
  return {
    work: async (): Promise<string> => {
      log.push(`start ${name}`);
      try {
        return await ended;
      } finally {
        log.push(`end ${name}`);
      }
    },
    finish,
    fail,
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('the delivery gate', () => {
  test('runs one unit at a time and gives each its result', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const a = job(log, 'a');
    const b = job(log, 'b');
    const first = gate.run('x', a.work);
    const second = gate.run('x', b.work);
    await settle();
    assert.deepEqual(log, ['start a'], 'the second waits');
    a.finish('one');
    assert.equal(await first, 'one');
    await settle();
    assert.deepEqual(log, ['start a', 'end a', 'start b']);
    b.finish('two');
    assert.equal(await second, 'two');
    assert.equal(gate.busy(), false);
  });

  test('starts a unit at once, in the same call, when the gate is free', () => {
    const gate = createDeliveryGate();
    let started = false;
    void gate.run('x', async () => void (started = true));
    assert.equal(started, true);
  });

  test('takes work that is not a promise too', async () => {
    const gate = createDeliveryGate();
    assert.equal(await gate.run('x', () => 7), 7);
  });

  test('serves one owner first come, first served', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const jobs = ['a', 'b', 'c', 'd'].map((name) => job(log, name));
    const runs = jobs.map((one) => gate.run('x', one.work));
    for (const one of jobs) {
      await settle();
      one.finish();
    }
    await Promise.all(runs);
    assert.deepEqual(
      log.filter((line) => line.startsWith('start')),
      ['start a', 'start b', 'start c', 'start d'],
    );
  });

  test('serves owners round-robin: one that waits sits behind at most one unit of another owner', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const a = ['a1', 'a2', 'a3', 'a4'].map((name) => job(log, name));
    const b = job(log, 'b1');
    const runs = a.map((one) => gate.run('alice', one.work));
    await settle();
    runs.push(gate.run('bob', b.work)); // arrives while a1 runs, behind a2..a4 in arrival order
    for (const one of [a[0]!, b, a[1]!, a[2]!, a[3]!]) {
      await settle();
      one.finish();
    }
    await Promise.all(runs);
    assert.deepEqual(
      log.filter((line) => line.startsWith('start')),
      ['start a1', 'start b1', 'start a2', 'start a3', 'start a4'],
    );
  });

  test('three owners take turns, and an owner that has just had a unit goes to the back', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const names = ['a1', 'a2', 'b1', 'b2', 'c1'];
    const all = new Map(names.map((name) => [name, job(log, name)]));
    const runs = [
      gate.run('a', all.get('a1')!.work),
      gate.run('a', all.get('a2')!.work),
      gate.run('b', all.get('b1')!.work),
      gate.run('b', all.get('b2')!.work),
      gate.run('c', all.get('c1')!.work),
    ];
    for (const name of ['a1', 'b1', 'c1', 'a2', 'b2']) {
      await settle();
      all.get(name)!.finish();
    }
    await Promise.all(runs);
    assert.deepEqual(
      log.filter((line) => line.startsWith('start')),
      ['start a1', 'start b1', 'start c1', 'start a2', 'start b2'],
    );
  });

  test('an owner that was idle between its units (a gap) does not lose its place in line, and does not hold the gate', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const a1 = job(log, 'a1');
    const b1 = job(log, 'b1');
    const a2 = job(log, 'a2');
    const first = gate.run('alice', a1.work);
    a1.finish();
    await first;
    // alice is waiting out a gap: bob finds the gate free and goes at once.
    const second = gate.run('bob', b1.work);
    assert.deepEqual(log, ['start a1', 'end a1', 'start b1']);
    const third = gate.run('alice', a2.work); // behind bob's unit
    await settle();
    assert.deepEqual(log.slice(-1), ['start b1']);
    b1.finish();
    await second;
    await settle();
    assert.deepEqual(log.slice(-1), ['start a2']);
    a2.finish();
    await third;
  });

  test('a first half does not cost its owner its turn: the owner\'s next unit, if already waiting, goes next', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const pre = job(log, 'alice-pre');
    const song = job(log, 'alice-song');
    const bob = job(log, 'bob');
    const next = job(log, 'alice-next');
    const runs = [
      gate.run('alice', pre.work, { first: true }),
      gate.run('alice', song.work),
      gate.run('bob', bob.work),
      gate.run('alice', next.work),
    ];
    for (const one of [pre, song, bob, next]) {
      await settle();
      one.finish();
    }
    await Promise.all(runs);
    assert.deepEqual(
      log.filter((line) => line.startsWith('start')),
      ['start alice-pre', 'start alice-song', 'start bob', 'start alice-next'],
    );
  });

  test('a first half with nothing of its owner waiting behind it gives the gate to whoever waits', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const pre = job(log, 'alice-pre');
    const bob = job(log, 'bob');
    const song = job(log, 'alice-song');
    const runs = [gate.run('alice', pre.work, { first: true }), gate.run('bob', bob.work)];
    await settle();
    pre.finish();
    await settle();
    runs.push(gate.run('alice', song.work)); // the song's turn comes after bob's unit, which is now running
    bob.finish();
    await settle();
    song.finish();
    await Promise.all(runs);
    assert.deepEqual(
      log.filter((line) => line.startsWith('start')),
      ['start alice-pre', 'start bob', 'start alice-song'],
    );
  });

  test('a unit that rejects, throws, or throws before returning a promise releases the gate and fails only itself', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const bad = job(log, 'bad');
    const failing = gate.run('x', bad.work);
    const thrower = gate.run('x', () => {
      throw new Error('sync boom');
    });
    const fine = gate.run('y', async () => 'fine');
    await settle();
    bad.fail(new Error('async boom'));
    await assert.rejects(failing, /async boom/);
    await assert.rejects(thrower, /sync boom/);
    assert.equal(await fine, 'fine');
    assert.equal(gate.busy(), false);
    assert.equal(await gate.run('x', async () => 'again'), 'again', 'and the gate still works');
  });

  test('says whether it is busy, whose unit is running, and how many wait', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    assert.equal(gate.busy(), false);
    assert.equal(gate.running(), undefined);
    assert.equal(gate.pending(), 0);
    const a = job(log, 'a');
    const b = job(log, 'b');
    const c = job(log, 'c');
    const runs = [gate.run('alice', a.work), gate.run('alice', b.work), gate.run('bob', c.work)];
    assert.equal(gate.busy(), true);
    assert.equal(gate.running(), 'alice');
    assert.equal(gate.pending(), 2);
    assert.equal(gate.pending('alice'), 1);
    assert.equal(gate.pending('bob'), 1);
    assert.equal(gate.pending('carol'), 0);
    assert.equal(gate.contended('alice'), true, 'bob waits');
    assert.equal(gate.contended('bob'), true, 'alice waits');
    assert.equal(gate.contended('carol'), true);
    a.finish();
    await settle();
    assert.equal(gate.running(), 'bob');
    assert.equal(gate.pending(), 1);
    assert.equal(gate.contended('bob'), true);
    assert.equal(gate.contended('alice'), false, 'only alice herself waits');
    c.finish();
    await settle();
    b.finish();
    await Promise.all(runs);
    assert.equal(gate.busy(), false);
    assert.equal(gate.pending(), 0);
    assert.equal(gate.contended('alice'), false);
  });

  test('a waiting unit whose signal aborts leaves the line and fails with GateAborted; the others are not disturbed', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const holder = job(log, 'holder');
    const waiter = job(log, 'waiter');
    const after = job(log, 'after');
    const quit = new AbortController();
    const running = gate.run('bob', holder.work);
    const giving = gate.run('alice', waiter.work, { signal: quit.signal });
    const staying = gate.run('carol', after.work);
    assert.equal(gate.pending('alice'), 1);
    quit.abort();
    await assert.rejects(giving, (err: unknown) => isGateAborted(err) && err instanceof GateAborted);
    assert.equal(gate.pending('alice'), 0);
    assert.equal(gate.contended('bob'), true, 'carol still waits');
    assert.equal(gate.contended('carol'), false, 'and nobody else does');
    holder.finish();
    await running;
    await settle();
    assert.deepEqual(log, ['start holder', 'end holder', 'start after'], 'the given-up unit never ran');
    after.finish();
    await staying;
    assert.equal(gate.busy(), false);
  });

  test('a unit that has started is not interrupted by its signal, and an already aborted signal never queues', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const one = job(log, 'one');
    const quit = new AbortController();
    const running = gate.run('alice', one.work, { signal: quit.signal });
    quit.abort();
    await settle();
    assert.deepEqual(log, ['start one'], 'still running');
    one.finish();
    assert.equal(await running, 'one');

    let started = false;
    await assert.rejects(
      gate.run('alice', async () => void (started = true), { signal: quit.signal }),
      (err: unknown) => isGateAborted(err),
    );
    assert.equal(started, false);
    assert.equal(gate.busy(), false);
  });

  test('a signal that aborts after its unit has ended does nothing', async () => {
    const gate = createDeliveryGate();
    const quit = new AbortController();
    assert.equal(await gate.run('alice', async () => 'done', { signal: quit.signal }), 'done');
    quit.abort();
    assert.equal(await gate.run('alice', async () => 'again'), 'again');
  });

  /** Something a unit started, which the test ends when it says so. */
  function pending() {
    let done!: () => void;
    const promise = new Promise<void>((resolve) => (done = resolve));
    return { promise, done };
  }

  test('a unit with something still under way when its work ends keeps the gate, and gives its result, only when that is done', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const ahead = pending();
    const one = job(log, 'alice-one');
    const bob = job(log, 'bob');
    const resultOf: string[] = [];
    const run = gate.run('alice', one.work, { settle: () => ahead.promise }).then((value) => void resultOf.push(value));
    const other = gate.run('bob', bob.work);
    one.finish();
    await settle();
    assert.deepEqual(log, ['start alice-one', 'end alice-one'], 'its work has ended and bob has not started');
    assert.equal(gate.running(), 'alice');
    assert.equal(gate.busy(), true);
    assert.deepEqual(resultOf, [], 'and its result is not known yet');
    ahead.done();
    await run;
    await settle();
    assert.deepEqual(resultOf, ['alice-one']);
    assert.deepEqual(log, ['start alice-one', 'end alice-one', 'start bob']);
    bob.finish();
    await other;
    assert.equal(gate.busy(), false);
  });

  test("while nobody else waits, the owner's next unit takes the gate over from a unit that is only waiting for what it started", async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const ahead = pending();
    const one = job(log, 'alice-one');
    const two = job(log, 'alice-two');
    const bob = job(log, 'bob');
    const first = gate.run('alice', one.work, { settle: () => ahead.promise });
    one.finish();
    await settle();
    assert.equal(gate.running(), 'alice');
    // Alice's next unit arrives while the first only waits: it starts at once, in the very call.
    const second = gate.run('alice', two.work);
    assert.deepEqual(log, ['start alice-one', 'end alice-one', 'start alice-two']);
    assert.equal(gate.pending('alice'), 0);
    // What the first was waiting for ending does not free the gate: the second has it.
    const other = gate.run('bob', bob.work);
    ahead.done();
    await first;
    await settle();
    assert.equal(gate.running(), 'alice', "the first's wait ending did not release the gate under the second");
    assert.deepEqual(log, ['start alice-one', 'end alice-one', 'start alice-two']);
    two.finish();
    await second;
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith('start')), ['start alice-one', 'start alice-two', 'start bob']);
    bob.finish();
    await other;
    assert.equal(gate.busy(), false);
  });

  test("a unit that takes over keeps the gate for what the one before it started too, though it has nothing of its own", async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const ahead = pending();
    const one = job(log, 'alice-one');
    const two = job(log, 'alice-two');
    const bob = job(log, 'bob');
    const first = gate.run('alice', one.work, { settle: () => ahead.promise });
    one.finish();
    await settle();
    const second = gate.run('alice', two.work); // takes over; no settle of its own
    const other = gate.run('bob', bob.work);
    two.finish();
    await settle();
    assert.deepEqual(log, ['start alice-one', 'end alice-one', 'start alice-two', 'end alice-two'], 'the second is done and bob does not start');
    assert.equal(gate.running(), 'alice');
    ahead.done();
    await Promise.all([first, second]);
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith('start')), ['start alice-one', 'start alice-two', 'start bob']);
    bob.finish();
    await other;
    assert.equal(gate.busy(), false);
  });

  test("with another owner waiting, the owner's next unit does not take over: the one waiting goes first, once what was started is done", async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const ahead = pending();
    const one = job(log, 'alice-one');
    const two = job(log, 'alice-two');
    const bob = job(log, 'bob');
    const first = gate.run('alice', one.work, { settle: () => ahead.promise });
    const other = gate.run('bob', bob.work);
    const second = gate.run('alice', two.work);
    one.finish();
    await settle();
    assert.deepEqual(log, ['start alice-one', 'end alice-one'], 'neither bob nor the second unit starts while the first has something under way');
    assert.equal(gate.running(), 'alice');
    ahead.done();
    await first;
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith('start')), ['start alice-one', 'start bob'], 'then bob, who was waiting');
    bob.finish();
    await other;
    await settle();
    two.finish();
    await second;
    assert.deepEqual(log.filter((line) => line.startsWith('start')), ['start alice-one', 'start bob', 'start alice-two']);
    assert.equal(gate.busy(), false);
  });

  test("another owner who arrives while a unit only waits for what it started waits for that, and the owner's later unit does not jump ahead of it", async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const ahead = pending();
    const one = job(log, 'alice-one');
    const two = job(log, 'alice-two');
    const bob = job(log, 'bob');
    const first = gate.run('alice', one.work, { settle: () => ahead.promise });
    one.finish();
    await settle();
    const other = gate.run('bob', bob.work);
    const second = gate.run('alice', two.work); // arrives after bob: bob is waiting, so no take-over
    await settle();
    assert.deepEqual(log, ['start alice-one', 'end alice-one']);
    ahead.done();
    await first;
    await settle();
    bob.finish();
    await other;
    await settle();
    two.finish();
    await second;
    assert.deepEqual(log.filter((line) => line.startsWith('start')), ['start alice-one', 'start bob', 'start alice-two']);
  });

  test('what a unit waits for failing, or a unit failing, still frees the gate once the wait is over, and the unit fails alone', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const ahead = pending();
    const bad = job(log, 'bad');
    const bob = job(log, 'bob');
    const failing = gate.run('alice', bad.work, { settle: () => ahead.promise.then(() => Promise.reject(new Error('the download failed'))) });
    const other = gate.run('bob', bob.work);
    bad.fail(new Error('the unit failed'));
    await settle();
    assert.deepEqual(log, ['start bad', 'end bad'], 'a failed unit still keeps the gate for what it started');
    ahead.done();
    await assert.rejects(failing, /the unit failed/);
    bob.finish();
    assert.equal(await other, 'bob');
    // A wait that throws, or fails, is not the unit's failure.
    assert.equal(await gate.run('alice', async () => 'fine', { settle: () => Promise.reject(new Error('late')) }), 'fine');
    assert.equal(
      await gate.run('alice', async () => 'also fine', {
        settle: () => {
          throw new Error('sync');
        },
      }),
      'also fine',
    );
    assert.equal(gate.busy(), false);
    assert.equal(await gate.run('bob', async () => 'and the gate works'), 'and the gate works');
  });

  test('a first half that only waits for what it started and is followed by the same owner takes the song over with nobody in between', async () => {
    const gate = createDeliveryGate();
    const log: string[] = [];
    const ahead = pending();
    const pre = job(log, 'alice-pre');
    const song = job(log, 'alice-song');
    const bob = job(log, 'bob');
    const first = gate.run('alice', pre.work, { first: true, settle: () => ahead.promise });
    pre.finish();
    await settle();
    const second = gate.run('alice', song.work);
    assert.deepEqual(log, ['start alice-pre', 'end alice-pre', 'start alice-song'], "the song's turn starts while the downloads are on their way");
    const other = gate.run('bob', bob.work);
    song.finish();
    await settle();
    assert.deepEqual(log.filter((line) => line.startsWith('start bob')), [], 'bob still waits for the downloads started ahead');
    ahead.done();
    await Promise.all([first, second]);
    await settle();
    bob.finish();
    await other;
    assert.deepEqual(log.filter((line) => line.startsWith('start')), ['start alice-pre', 'start alice-song', 'start bob']);
    assert.equal(gate.busy(), false);
  });
});
