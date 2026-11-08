import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Catalog, choicesIn, resumeIn } from '../src/catalog.ts';
import { formatPeoplePasswords, OWNER, OWNER_ID, parsePeople, parsePeoplePasswords, peopleFromEnv, personIdProblem, personOf, scoped, tagLine, type Person } from '../src/people.ts';

const ids = (people: Person[]): string[] => people.map((person) => person.id);

describe('the owner', () => {
  test('has the id "owner", the empty chat and the legacy keys', () => {
    assert.deepEqual({ ...OWNER }, { id: 'owner', owner: true, chat: '' });
    assert.equal(OWNER.id, OWNER_ID);
    assert.ok(Object.isFrozen(OWNER), 'nothing can turn the owner into someone else');
  });
});

describe('PEOPLE', () => {
  test('nothing set, empty or blank is no one but the owner, and no complaint', () => {
    for (const raw of [undefined, '', '   ', '\n', ' , ,, ']) assert.deepEqual(parsePeople(raw), { people: [], problems: [] }, JSON.stringify(raw));
  });

  test('names are separated by commas or spaces, and keep the order given', () => {
    assert.deepEqual(ids(parsePeople('alice').people), ['alice']);
    assert.deepEqual(ids(parsePeople('alice,bob').people), ['alice', 'bob']);
    assert.deepEqual(ids(parsePeople('alice bob').people), ['alice', 'bob']);
    assert.deepEqual(ids(parsePeople('  zed ,  bob\talice\n, carol7 ').people), ['zed', 'bob', 'alice', 'carol7']);
    assert.equal(parsePeople('alice, bob').problems.length, 0);
  });

  test('a person is not the owner and has a chat of their own: their id', () => {
    const [alice] = parsePeople('alice').people;
    assert.deepEqual({ ...alice }, { id: 'alice', owner: false, chat: 'alice' });
    assert.ok(Object.isFrozen(alice));
    assert.deepEqual({ ...personOf('bob') }, { id: 'bob', owner: false, chat: 'bob' });
  });

  test('a name is 2 to 16 characters: a lower-case letter, then lower-case letters or digits', () => {
    const fine = ['ab', 'a1', 'alice', 'zed99', 'abcdefghijklmnop'];
    assert.equal('abcdefghijklmnop'.length, 16);
    assert.deepEqual(ids(parsePeople(fine.join(' ')).people), fine);
    const bad = ['a', 'abcdefghijklmnopq', '1abc', '9', 'Alice', 'ALICE', 'al-ice', 'al_ice', 'al.ice', '@alice', 'alice:2', 'ali/ce', 'élise', 'אבא'];
    for (const name of bad) {
      const parsed = parsePeople(name);
      assert.deepEqual(parsed.people, [], `${name} is refused`);
      assert.equal(parsed.problems.length, 1, name);
      assert.match(parsed.problems[0]!, /^PEOPLE: .*is not a usable name: use 2 to 16 characters/, name);
      assert.ok(personIdProblem(name), name);
    }
  });

  test('"me" and "owner" are the owner\'s, and nothing starting with "gmessages" is anyone\'s (the bridge\'s accounts)', () => {
    for (const name of ['me', 'owner']) {
      const parsed = parsePeople(`alice ${name} bob`);
      assert.deepEqual(ids(parsed.people), ['alice', 'bob'], 'the rest are kept');
      assert.deepEqual(parsed.problems, [`PEOPLE: "${name}" is reserved for the owner; left out`]);
    }
    for (const name of ['gmessages', 'gmessagesbot', 'gmessages1', 'gmessagesalice']) {
      const parsed = parsePeople(name);
      assert.deepEqual(parsed.people, [], name);
      assert.match(parsed.problems[0]!, /reserved: names starting with "gmessages" belong to the Google Messages bridge; left out$/, name);
    }
    assert.deepEqual(ids(parsePeople('gmessage').people), ['gmessage'], 'only the bridge\'s own prefix');
  });

  test('the owner\'s Matrix account (MATRIX_USER) is taken, whatever its case', () => {
    const parsed = parsePeople('dave alice', { reserved: ['Dave'] });
    assert.deepEqual(ids(parsed.people), ['alice']);
    assert.deepEqual(parsed.problems, ['PEOPLE: "dave" is the owner\'s Matrix account; left out']);
    assert.deepEqual(ids(parsePeople('dave', { reserved: [] }).people), ['dave']);
    assert.deepEqual(ids(parsePeople('dave', { reserved: ['', '  '] }).people), ['dave'], 'a blank account reserves nothing');
  });

  test('peopleFromEnv reads PEOPLE and keeps MATRIX_USER for the owner', () => {
    assert.deepEqual(peopleFromEnv({}), { people: [], problems: [] });
    assert.deepEqual(ids(peopleFromEnv({ PEOPLE: 'alice, bob' }).people), ['alice', 'bob']);
    const parsed = peopleFromEnv({ PEOPLE: 'dave alice', MATRIX_USER: 'dave' });
    assert.deepEqual(ids(parsed.people), ['alice']);
    assert.equal(parsed.problems.length, 1);
  });

  test('a name listed twice is kept once; the second is told', () => {
    const parsed = parsePeople('alice bob alice, alice');
    assert.deepEqual(ids(parsed.people), ['alice', 'bob']);
    assert.deepEqual(parsed.problems, ['PEOPLE: "alice" is listed twice; left out', 'PEOPLE: "alice" is listed twice; left out']);
  });

  test('bad input never throws: each bad name is left out and described, the good ones stay', () => {
    const parsed = parsePeople('alice Bob me gmessagesbot x carol alice');
    assert.deepEqual(ids(parsed.people), ['alice', 'carol']);
    assert.equal(parsed.problems.length, 5);
    assert.ok(parsed.problems.every((line) => line.startsWith('PEOPLE: ') && line.endsWith('; left out') && !line.includes('\n')));
  });

  test('a long or odd name is quoted and cut in the message, so it cannot fill or garble a log line', () => {
    const long = 'x'.repeat(500);
    const [line] = parsePeople(long).problems;
    assert.ok(line!.length < 250, 'cut');
    assert.match(line!, /"x{40}…" is not a usable name/);
    const [odd] = parsePeople('a"b\\c').problems;
    assert.match(odd!, /"a\\"b\\\\c" is not a usable name/);
  });

  test('personOf refuses what the list would, with the same words', () => {
    for (const name of ['me', 'owner', 'gmessagesbot', 'Alice', 'a', '']) assert.throws(() => personOf(name), /^Error: PEOPLE: /, name);
    assert.throws(() => personOf('dave', ['dave']), /owner's Matrix account/);
    assert.equal(personIdProblem('alice'), undefined);
  });
});

describe('scoped keys', () => {
  const alice = personOf('alice');
  const bob = personOf('bob');

  test('the owner keeps the key as it always was; anyone else gets it with their id', () => {
    assert.equal(scoped('chat.view', OWNER), 'chat.view');
    assert.equal(scoped('chat.view'), 'chat.view', 'the owner is the default');
    assert.equal(scoped('chat.choices', alice), 'chat.choices:alice');
    assert.equal(scoped('chat.resume', bob), 'chat.resume:bob');
    assert.notEqual(scoped('chat.view', alice), scoped('chat.view', bob));
    assert.notEqual(scoped('chat.view', alice), scoped('chat.view', OWNER));
  });

  test('no one\'s key is another\'s: ids have no colon, so base:id cannot be read two ways', () => {
    const seen = new Set<string>();
    for (const person of [OWNER, alice, bob, personOf('ab'), personOf('a1')]) {
      for (const base of ['chat.view', 'chat.choices', 'chat.resume', 'matrix.room', 'hello.sent']) {
        const key = scoped(base, person);
        assert.ok(!seen.has(key), key);
        seen.add(key);
      }
    }
  });

  test('picks and the resume point, stored under scoped keys, stay each person\'s own', () => {
    const catalog = new Catalog(':memory:');
    const choices = (person: Person) => choicesIn(catalog, scoped('chat.choices', person));
    const resume = (person: Person) => resumeIn(catalog, scoped('chat.resume', person));

    choices(OWNER).save({ chips: [{ label: '1. A', postback: 'play:1' }], at: 5, validMs: 60_000 });
    choices(alice).save({ chips: [{ label: '1. B', postback: 'play:2' }], at: 6, validMs: 60_000 });
    assert.equal(choices(OWNER).load()?.chips[0]?.postback, 'play:1');
    assert.equal(choices(alice).load()?.chips[0]?.postback, 'play:2');
    assert.equal(choices(bob).load(), undefined);
    choices(alice).save(undefined);
    assert.equal(choices(alice).load(), undefined);
    assert.equal(choices(OWNER).load()?.chips[0]?.postback, 'play:1', 'one person clearing theirs leaves the other\'s');

    resume(OWNER).save({ at: 100, ids: ['$o'] });
    resume(alice).save({ at: 200, ids: ['$a'] });
    assert.deepEqual(resume(OWNER).load(), { at: 100, ids: ['$o'] });
    assert.deepEqual(resume(alice).load(), { at: 200, ids: ['$a'] });
    assert.equal(resume(bob).load(), undefined);
    assert.equal(catalog.getState('chat.resume'), JSON.stringify({ at: 100, ids: ['$o'] }), 'the owner\'s is under the legacy key');
    assert.equal(catalog.getState('chat.choices:alice'), '', 'and a person\'s under theirs');
  });
});

describe('PEOPLE_PASSWORDS', () => {
  const HEX_A = 'a'.repeat(64);
  const HEX_B = '0123456789abcdef'.repeat(4);

  test('is name:password pairs separated by commas, and reads back what was written, in order', () => {
    const text = formatPeoplePasswords([{ id: 'alice', password: HEX_A }, { id: 'bob', password: HEX_B }]);
    assert.equal(text, `alice:${HEX_A},bob:${HEX_B}`);
    assert.deepEqual([...parsePeoplePasswords(text)], [['alice', HEX_A], ['bob', HEX_B]]);
    assert.equal(formatPeoplePasswords([]), '');
    assert.equal(parsePeoplePasswords(formatPeoplePasswords([])).size, 0);
  });

  test('nothing, or empty, is no passwords', () => {
    assert.equal(parsePeoplePasswords(undefined).size, 0);
    assert.equal(parsePeoplePasswords('').size, 0);
    assert.equal(parsePeoplePasswords(' , ,').size, 0);
  });

  test('a password may hold a colon (the name is what comes before the first), but never a comma or a space', () => {
    assert.deepEqual([...parsePeoplePasswords('alice:ab:cd')], [['alice', 'ab:cd']]);
    for (const password of ['', 'a b', 'a,b', 'a\nb']) assert.throws(() => formatPeoplePasswords([{ id: 'alice', password }]), /PEOPLE_PASSWORDS: the password for "alice" is empty or has a comma or a space/, JSON.stringify(password));
  });

  test('is read leniently: a damaged pair costs that person their sign-in and nobody else', () => {
    const parsed = parsePeoplePasswords(` alice : ${HEX_A} ,nopassword,:nobody,Bad:${HEX_B},bob:,carol:two words,dave:${HEX_B},alice:later`);
    assert.deepEqual([...parsed], [['alice', HEX_A], ['dave', HEX_B]], 'the first of a repeated name wins');
  });

  test('refuses to write a name that could not be a person, without saying the password', () => {
    for (const id of ['me', 'owner', 'gmessagesbot', 'Alice', 'a:b', '']) {
      assert.throws(
        () => formatPeoplePasswords([{ id, password: HEX_A }]),
        (err: unknown) => err instanceof Error && /^PEOPLE_PASSWORDS: /.test(err.message) && !err.message.includes(HEX_A),
        JSON.stringify(id),
      );
    }
  });
});

describe('log lines for a person’s chat', () => {
  const alice = personOf('alice');

  test('the owner’s lines are exactly as they were', () => {
    for (const line of ['<- "search blue"', 'timeline: "search blue" phone→seen 0.2s', 'song: "Blue" 3.1 MB', 'album: "Horizons" 2 songs', '']) assert.equal(tagLine(OWNER, line), line);
  });

  test('anyone else’s say whose they are, after the first word of a timeline, song or album line so a search for that word still finds them', () => {
    assert.equal(tagLine(alice, '<- "search blue"'), '[alice] <- "search blue"');
    assert.equal(tagLine(alice, 'timeline: "search blue" · bot 1.0s'), 'timeline: [alice] "search blue" · bot 1.0s');
    assert.equal(tagLine(alice, 'song: "Blue" 3.1 MB'), 'song: [alice] "Blue" 3.1 MB');
    assert.equal(tagLine(alice, 'album: "Horizons" 2 songs'), 'album: [alice] "Horizons" 2 songs');
    assert.equal(tagLine(alice, 'timelines are long'), '[alice] timelines are long', 'only the exact first word');
  });
});
