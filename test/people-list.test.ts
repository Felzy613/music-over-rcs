import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_PEOPLE, PEOPLE_OBJECT, PeopleList, PeopleListError, checkNewName, mergePeople, readSavedPeople, serializePeople, typedName } from '../src/cloud/people-list.ts';
import { parsePeople } from '../src/people.ts';
import { FakeBucket } from './helpers/fake-bucket.ts';

const stored = (...entries: unknown[]): string => JSON.stringify({ version: 1, people: entries });
const ids = (list: ReadonlyArray<{ id: string }>): string[] => list.map((one) => one.id);

describe('reading the saved list', () => {
  test('nothing stored, or only spaces, is an empty list and nothing to say', () => {
    for (const text of [undefined, '', '  \n']) assert.deepEqual(readSavedPeople(text), { people: [], problems: [], damaged: false });
  });

  test('reads names as plain strings or as objects with the time they were added', () => {
    const read = readSavedPeople(stored('alice', { id: 'bob', addedAt: '2026-11-08T12:00:00.000Z' }, { id: 'carol', addedAt: 'yesterday' }));
    assert.deepEqual(read.people, [{ id: 'alice', addedAt: null }, { id: 'bob', addedAt: '2026-11-08T12:00:00.000Z' }, { id: 'carol', addedAt: null }]);
    assert.deepEqual([read.problems, read.damaged], [[], false]);
  });

  test('a name that cannot be used is left out with a line of its own, and the rest are kept', () => {
    const read = readSavedPeople(stored('alice', 'Bad Name', 'me', 'owner', 'gmessagesbot', 'a', 'x'.repeat(17), 'bob'));
    assert.deepEqual(ids(read.people), ['alice', 'bob']);
    assert.equal(read.problems.length, 6);
    assert.ok(read.problems.every((line) => line.startsWith('the saved list of people') && line.endsWith('; left out')));
    assert.equal(read.damaged, false);
  });

  test('the owner’s own Matrix account is not a name for a person', () => {
    const read = readSavedPeople(stored('dave', 'alice'), { reserved: ['dave'] });
    assert.deepEqual(ids(read.people), ['alice']);
    assert.match(read.problems[0]!, /"dave" is the owner's Matrix account/);
  });

  test('one stored entry can never become two names, whatever separators it holds', () => {
    // parsePeople splits on commas and spaces: a stored "alice,bob" or "alice bob" must not turn into two people nobody typed.
    for (const entry of ['alice,bob', 'alice bob', 'alice\nbob', ' alice', 'alice ', 'alice bob']) {
      const read = readSavedPeople(stored(entry));
      assert.deepEqual(read.people, [], JSON.stringify(entry));
      assert.equal(read.problems.length, 1, JSON.stringify(entry));
    }
  });

  test('something that is not a name (a number, null, a list, an object with no id) is left out', () => {
    const read = readSavedPeople(stored(7, null, ['alice'], { name: 'alice' }, { id: 5 }, true, 'bob'));
    assert.deepEqual(ids(read.people), ['bob']);
    assert.equal(read.problems.length, 6);
  });

  test('a name listed twice is kept once', () => {
    const read = readSavedPeople(stored('alice', { id: 'alice' }, 'bob'));
    assert.deepEqual(ids(read.people), ['alice', 'bob']);
    assert.match(read.problems[0]!, /"alice" is listed twice/);
  });

  test('no more than the most this host takes are read, and the rest are said to be left out', () => {
    const many = Array.from({ length: MAX_PEOPLE + 3 }, (_, i) => `person${i}`);
    const read = readSavedPeople(stored(...many));
    assert.equal(read.people.length, MAX_PEOPLE);
    assert.match(read.problems.at(-1)!, new RegExp(`more than ${MAX_PEOPLE} names`));
  });

  test('an object that cannot be read at all is damaged: nothing in it is used and one line says so', () => {
    for (const text of ['not json', '{"people": "alice"}', '[]', 'null', '{"version":1}', '{"people":', '"alice"', '7']) {
      const read = readSavedPeople(text);
      assert.deepEqual([read.people, read.damaged, read.problems.length], [[], true, 1], text);
      assert.ok(read.problems[0]!.includes(PEOPLE_OBJECT), text);
    }
  });

  test('an object far bigger than a list of names is damaged, whatever it holds', () => {
    const read = readSavedPeople(JSON.stringify({ people: ['alice'], padding: 'x'.repeat(20_000) }));
    assert.deepEqual([read.people, read.damaged], [[], true]);
  });

  test('a name that tries to be more than a name is not one: YAML and shell characters never get through', () => {
    const nasty = ['alice"\n  "@evil:localhost": admin', 'alice; rm -rf /', '$(id)', 'alice`id`', 'alice:admin', "alice'", 'al ice', '../alice', 'ALICE', 'alicé', 'alice\0', '-alice', '1alice'];
    const read = readSavedPeople(stored(...nasty));
    assert.deepEqual(read.people, []);
    assert.equal(read.problems.length, nasty.length);
  });
});

describe('writing it out', () => {
  test('serialises to the object the host reads, with nothing but the names and when they were added', () => {
    const text = serializePeople([{ id: 'alice', addedAt: '2026-11-08T12:00:00.000Z' }, { id: 'bob', addedAt: null }]);
    assert.deepEqual(JSON.parse(text), { version: 1, people: [{ id: 'alice', addedAt: '2026-11-08T12:00:00.000Z' }, { id: 'bob' }] });
    assert.deepEqual(readSavedPeople(text).people, [{ id: 'alice', addedAt: '2026-11-08T12:00:00.000Z' }, { id: 'bob', addedAt: null }]);
    assert.deepEqual(JSON.parse(serializePeople([])), { version: 1, people: [] });
  });
});

describe('the names from the environment and the saved list together', () => {
  const env = (names: string) => parsePeople(names).people;
  const saved = (...names: string[]) => names.map((id) => ({ id, addedAt: null }));

  test('the environment’s names come first, then the added ones, each once', () => {
    const merged = mergePeople(env('alice bob'), saved('carol', 'bob', 'dave'));
    assert.deepEqual(ids(merged.people), ['alice', 'bob', 'carol', 'dave']);
    assert.deepEqual(merged.added, ['carol', 'dave']);
    assert.deepEqual(merged.problems, []);
  });

  test('with nothing saved the result is the environment’s list, unchanged, whatever its size', () => {
    const big = env(Array.from({ length: MAX_PEOPLE + 4 }, (_, i) => `person${i}`).join(' '));
    const merged = mergePeople(big, []);
    assert.deepEqual(ids(merged.people), ids(big));
    assert.deepEqual([merged.added, merged.problems], [[], []]);
    assert.deepEqual(mergePeople([], []).people, []);
  });

  test('the added names stop at the most this host takes, counting the environment’s', () => {
    const merged = mergePeople(env('a1 a2 a3'), saved(...Array.from({ length: 12 }, (_, i) => `b${i}`)));
    assert.equal(merged.people.length, MAX_PEOPLE);
    assert.equal(merged.added.length, MAX_PEOPLE - 3);
    assert.equal(merged.problems.length, 12 - (MAX_PEOPLE - 3));
  });

  test('every name is checked again on the way through, so a bad one handed over is dropped and said', () => {
    const merged = mergePeople(env('alice'), [{ id: 'Bad Name', addedAt: null }, { id: 'dave', addedAt: null }, { id: 'bob', addedAt: null }], { reserved: ['dave'] });
    assert.deepEqual(ids(merged.people), ['alice', 'bob']);
    assert.deepEqual(merged.added, ['bob']);
    assert.ok(merged.problems.length >= 2);
  });
});

describe('a name as typed', () => {
  test('is trimmed and put in lower case, and anything else is for the checks to refuse', () => {
    assert.equal(typedName('  Alice '), 'alice');
    assert.equal(typedName(undefined), '');
    assert.equal(typedName(5), '');
    assert.equal(checkNewName(' Alice '), 'alice');
    assert.equal(checkNewName('bob7'), 'bob7');
  });

  test('is refused in plain words when it cannot be a person', () => {
    const refused = (raw: unknown, reserved: string[] = []): string => {
      try {
        checkNewName(raw, { reserved });
      } catch (err) {
        assert.ok(err instanceof PeopleListError);
        assert.equal(err.status, 400);
        return err.message;
      }
      return assert.fail(`${JSON.stringify(raw)} was accepted`);
    };
    assert.match(refused(''), /Type a name/);
    assert.match(refused(undefined), /Type a name/);
    assert.match(refused('alice bob'), /One name at a time/);
    assert.match(refused('alice,bob'), /One name at a time/);
    assert.match(refused('a'), /2 to 16 characters/);
    assert.match(refused('a'.repeat(17)), /2 to 16 characters/);
    assert.match(refused('1abc'), /lower-case letter first/);
    assert.match(refused('al-ice'), /lower-case letters or digits/);
    assert.match(refused('me'), /reserved for the owner/);
    assert.match(refused('owner'), /reserved for the owner/);
    assert.match(refused('gmessagesbot'), /bridge/);
    assert.match(refused('dave', ['dave']), /owner's Matrix account/);
    assert.doesNotMatch(refused('a'), /PEOPLE:|left out/, 'the words are for a person, not for a log');
  });
});

describe('the list in the bucket', () => {
  const make = (bucket = new FakeBucket(), options: { now?: () => Date; cacheMs?: number } = {}) => ({ bucket, list: new PeopleList({ store: bucket.s3, reserved: ['dave'], ...options }) });
  const objectIn = (bucket: FakeBucket) => bucket.objects.get(PEOPLE_OBJECT);

  test('adding the first name makes the object, with the time it was added', async () => {
    const { bucket, list } = make(new FakeBucket(), { now: () => new Date('2026-11-08T12:00:00Z') });
    const done = await list.add('alice');
    assert.deepEqual(done.person, { id: 'alice', addedAt: '2026-11-08T12:00:00.000Z' });
    assert.deepEqual(JSON.parse(objectIn(bucket)!.body), { version: 1, people: [{ id: 'alice', addedAt: '2026-11-08T12:00:00.000Z' }] });
    assert.deepEqual(ids((await list.read()).people), ['alice']);
  });

  test('a second name is added to the first, and a name already there is refused', async () => {
    const { list } = make();
    await list.add('alice');
    await list.add('bob');
    assert.deepEqual(ids((await list.read({ fresh: true })).people), ['alice', 'bob']);
    await assert.rejects(list.add('alice'), (err: PeopleListError) => err.status === 409 && /already added/.test(err.message));
    assert.deepEqual(ids((await list.read({ fresh: true })).people), ['alice', 'bob']);
  });

  test('removing a name takes only that name, and a name that is not there is a 404', async () => {
    const { bucket, list } = make();
    await list.add('alice');
    await list.add('bob');
    await list.remove('alice');
    assert.deepEqual(ids(JSON.parse(objectIn(bucket)!.body).people), ['bob']);
    await assert.rejects(list.remove('alice'), (err: PeopleListError) => err.status === 404);
    await list.remove('bob');
    assert.deepEqual(JSON.parse(objectIn(bucket)!.body), { version: 1, people: [] }, 'an empty list is written, not deleted');
  });

  test('two adds at once both land: one after the other, neither overwrites the other', async () => {
    const { list } = make();
    await Promise.all([list.add('alice'), list.add('bob'), list.add('carol')]);
    assert.deepEqual(ids((await list.read({ fresh: true })).people).sort(), ['alice', 'bob', 'carol']);
  });

  test('changes are made one at a time: the list never has two requests to the bucket in flight at once', async () => {
    const bucket = new FakeBucket();
    let inFlight = 0;
    let most = 0;
    const slow = <T>(work: () => Promise<T>) => async (): Promise<T> => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 3));
      try {
        return await work();
      } finally {
        inFlight--;
      }
    };
    const { get, put } = bucket.s3;
    bucket.s3.get = (key: string) => slow(() => get(key))();
    bucket.s3.put = (key: string, body: string | Uint8Array, condition = {}) => slow(() => put(key, body, condition))();
    const { list } = make(bucket);
    await Promise.all([list.add('alice'), list.add('bob'), list.add('carol'), list.read({ fresh: true }), list.remove('alice').catch(() => {})]);
    assert.equal(most, 1);
    assert.ok(ids((await list.read({ fresh: true })).people).includes('bob'));
  });

  test('the same name added twice at once is added once and refused once', async () => {
    const { list } = make();
    const results = await Promise.allSettled([list.add('alice'), list.add('alice')]);
    assert.deepEqual(results.map((one) => one.status).sort(), ['fulfilled', 'rejected']);
    assert.deepEqual(ids((await list.read({ fresh: true })).people), ['alice']);
  });

  test('a write that finds the object changed meanwhile reads it again and keeps the other change', async () => {
    const bucket = new FakeBucket();
    const { list } = make(bucket);
    await list.add('alice');
    // Somebody else (another copy of the console, say) changes the object between this one's read and its write, once.
    const real = bucket.s3.put;
    let raced = false;
    bucket.s3.put = async (key, body, condition) => {
      if (!raced && key === PEOPLE_OBJECT) {
        raced = true;
        await real(key, serializePeople([{ id: 'alice', addedAt: null }, { id: 'zed', addedAt: null }]));
      }
      return real(key, body, condition);
    };
    await list.add('bob');
    assert.deepEqual(ids((await list.read({ fresh: true })).people), ['alice', 'zed', 'bob']);
  });

  test('a list that keeps being changed elsewhere is given up on, saying nothing was lost', async () => {
    const bucket = new FakeBucket();
    const { list } = make(bucket);
    const real = bucket.s3.put;
    bucket.s3.put = async (key, body, condition) => {
      if (key === PEOPLE_OBJECT) await real(key, serializePeople([{ id: `x${bucket.objects.size}${Math.random().toString(36).slice(2, 6)}`, addedAt: null }]));
      return real(key, body, condition);
    };
    await assert.rejects(list.add('alice'), (err: PeopleListError) => err.status === 409 && /three times/.test(err.message));
  });

  test('a damaged object is never written over', async () => {
    const bucket = new FakeBucket();
    bucket.objects.set(PEOPLE_OBJECT, { body: 'not json at all', etag: '"x"' });
    const { list } = make(bucket);
    await assert.rejects(list.add('alice'), (err: PeopleListError) => err.status === 409 && /not valid JSON/.test(err.message) && /Nothing was changed/.test(err.message));
    await assert.rejects(list.remove('alice'), (err: PeopleListError) => err.status === 409);
    assert.equal(objectIn(bucket)!.body, 'not json at all');
    const read = await list.read();
    assert.deepEqual([read.damaged, read.people], [true, []]);
  });

  test('a bucket that cannot be read or written says so and changes nothing', async () => {
    const bucket = new FakeBucket();
    const { list } = make(bucket);
    await list.add('alice');
    const get = bucket.s3.get;
    bucket.s3.get = async () => {
      throw new Error('R2 refused reading config/people.json (HTTP 500)');
    };
    await assert.rejects(list.add('bob'), (err: PeopleListError) => err.status === 503 && /R2 refused reading/.test(err.message));
    await assert.rejects(list.read({ fresh: true }), (err: PeopleListError) => err.status === 503);
    bucket.s3.get = get;
    bucket.s3.put = async () => {
      throw new Error('R2 refused writing config/people.json (HTTP 503)');
    };
    await assert.rejects(list.add('bob'), (err: PeopleListError) => err.status === 503 && /nothing was changed/.test(err.message));
    assert.deepEqual(ids(JSON.parse(objectIn(bucket)!.body).people), ['alice']);
  });

  test('a read is reused for a little while, a fresh one is not, and a change shows at once', async () => {
    let clock = 1_000_000;
    const bucket = new FakeBucket();
    const { list } = make(bucket, { now: () => new Date(clock), cacheMs: 30_000 });
    let reads = 0;
    const get = bucket.s3.get;
    bucket.s3.get = async (key) => {
      reads++;
      return get(key);
    };
    await list.read();
    await list.read();
    assert.equal(reads, 1);
    await list.read({ fresh: true });
    assert.equal(reads, 2);
    clock += 31_000;
    await list.read();
    assert.equal(reads, 3);
    const before = reads;
    await list.add('alice');
    assert.deepEqual(ids((await list.read()).people), ['alice']);
    assert.equal(reads, before + 1, 'only the change’s own read: the answer after it came from what was written');
  });

  test('the saved limit is honoured', async () => {
    const { list } = make();
    await list.add('alice', { limit: 2 });
    await list.add('bob', { limit: 2 });
    await assert.rejects(list.add('carol', { limit: 2 }), (err: PeopleListError) => err.status === 409 && /the most people/.test(err.message));
  });

  test('writes only when something changes: a refused add and a read write nothing', async () => {
    const bucket = new FakeBucket();
    const { list } = make(bucket);
    let writes = 0;
    const put = bucket.s3.put;
    bucket.s3.put = async (key, body, condition) => {
      writes++;
      return put(key, body, condition);
    };
    await list.add('alice');
    assert.equal(writes, 1);
    await list.read({ fresh: true });
    await assert.rejects(list.add('alice'));
    await assert.rejects(list.remove('nobody'));
    assert.equal(writes, 1);
  });
});
