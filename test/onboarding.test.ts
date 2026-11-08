import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { LINKED_KEY, NUMBER_GRACE_MS, ONBOARDING_GRACE_MS, Onboarding, PROVED_KEY, loginKind, type Seen } from '../src/cloud/onboarding.ts';
import { OWNER, personOf } from '../src/people.ts';

// The gate a second person goes through (src/cloud/onboarding.ts): a connected login is not enough, because a login that tells the bridge no
// phone number makes it keep EVERY chat (the self-chat-only patch fails open), which is what got the service suspended on 2026-10-29. A person is
// onboarded once their own chat has actually arrived, within a few minutes of linking. The clock is a fake one, so a few minutes take no time.

const MINUTE = 60_000;
const alice = personOf('alice');
const bob = personOf('bob');

function gate(options: { person?: typeof alice; graceMs?: number } = {}) {
  const catalog = new Catalog(':memory:');
  const writes: string[] = [];
  const state = {
    getState: (key: string) => catalog.getState(key),
    setState: (key: string, value: string) => {
      writes.push(key);
      catalog.setState(key, value);
    },
  };
  let now = Date.parse('2026-11-08T12:00:00Z');
  const onboarding = (person = options.person ?? alice) => new Onboarding({ state, person, now: () => now, ...(options.graceMs ? { graceMs: options.graceMs } : {}) });
  return { catalog, writes, onboarding, advance: (ms: number) => (now += ms), now: () => now };
}

const linked = (extra: Partial<Seen> = {}): Seen => ({ login: 'linked', simNumber: true, chatFound: false, ...extra });

describe('what the bridge says of a login', () => {
  test('no login at all, a bridge that did not answer, a connected login, and any other state are told apart', () => {
    assert.equal(loginKind({ state: undefined }), 'none');
    assert.equal(loginKind({ state: undefined, error: 'the bridge answered HTTP 500' }), 'unknown', 'an answer that is an error is not "no login"');
    assert.equal(loginKind({ state: undefined, error: 'this account is not signed in yet' }), 'unknown');
    assert.equal(loginKind({ state: 'CONNECTED' }), 'linked');
    assert.equal(loginKind({ state: 'BACKFILLING' }), 'linked');
    for (const state of ['CONNECTING', 'TRANSIENT_DISCONNECT', 'BAD_CREDENTIALS', 'LOGGED_OUT', 'UNKNOWN_ERROR']) assert.equal(loginKind({ state }), 'other', state);
  });
});

describe('the onboarding gate for a person besides the owner', () => {
  test('is for people only: the owner is refused', () => {
    const { catalog } = gate();
    assert.throws(() => new Onboarding({ state: catalog, person: OWNER }), /owner is not run through the onboarding gate/);
  });

  test('a login that is not connected is not linked: nothing is written and nobody is warned', () => {
    const { onboarding, writes } = gate();
    for (const login of ['none', 'unknown', 'other'] as const) {
      const report = onboarding().evaluate({ login, simNumber: false, chatFound: false });
      assert.deepEqual([report.step, report.onboarded, report.warn, report.linkedSince, report.provedAt], ['not-linked', false, false, null, null], login);
    }
    assert.match(onboarding().evaluate({ login: 'none', simNumber: null, chatFound: false }).message, /^alice's Google Messages is not linked yet/);
    assert.match(onboarding().evaluate({ login: 'unknown', simNumber: null, chatFound: false }).message, /bridge did not answer/);
    assert.match(onboarding().evaluate({ login: 'other', simNumber: null, chatFound: false }).message, /not connected to the bridge/);
    assert.deepEqual(writes, []);
  });

  test('linked, the phone gave its number, the chat not here yet: it waits, and says by when the chat has to arrive', () => {
    const { onboarding, advance } = gate();
    const first = onboarding().evaluate(linked());
    assert.equal(first.step, 'waiting-for-chat');
    assert.equal(first.onboarded, false);
    assert.equal(first.warn, false);
    assert.equal(first.linkedSince, '2026-11-08T12:00:00.000Z');
    assert.equal(first.chatDueBy, '2026-11-08T12:10:00.000Z');
    assert.match(first.message, /Waiting for alice to text themself once from their phone/);
    assert.match(first.message, /within 10 minutes of linking \(by 12:10 UTC\)/);
    advance(ONBOARDING_GRACE_MS);
    assert.equal(onboarding().evaluate(linked()).step, 'waiting-for-chat', 'the last moment of the window is still inside it');
  });

  test('past the window with no chat: it says to unlink, names the limit, and warns', () => {
    const { onboarding, advance } = gate();
    onboarding().evaluate(linked());
    advance(ONBOARDING_GRACE_MS + MINUTE);
    const report = onboarding().evaluate(linked());
    assert.deepEqual([report.step, report.onboarded, report.warn], ['chat-missing', false, true]);
    assert.equal(report.chatDueBy, '2026-11-08T12:10:00.000Z');
    assert.match(report.message, /alice's own chat has not arrived 11 minutes after linking/);
    assert.match(report.message, /does not match their chat, and this host cannot set them up: unlink alice \(below\) and take them out of PEOPLE/);
    assert.match(report.message, /GMESSAGES_ALL_CHATS=1, is for the whole host and would bring every chat of everyone back/);
    assert.match(report.message, /2026-10-29/);
  });

  test('a chat that arrives, even late, onboards them, and the proof is kept', () => {
    const { onboarding, advance, catalog } = gate();
    onboarding().evaluate(linked());
    advance(ONBOARDING_GRACE_MS * 3);
    assert.equal(onboarding().evaluate(linked()).step, 'chat-missing');
    const report = onboarding().evaluate(linked({ chatFound: true }));
    assert.deepEqual([report.step, report.onboarded, report.warn], ['onboarded', true, false]);
    assert.equal(report.provedAt, new Date(Date.parse('2026-11-08T12:00:00Z') + ONBOARDING_GRACE_MS * 3).toISOString());
    assert.equal(catalog.getState(`${PROVED_KEY}:alice`), report.provedAt);
    // The chat deleted on the phone later is the room watch's to report; it does not un-onboard them or tell the owner to unlink.
    const later = onboarding().evaluate(linked({ chatFound: false }));
    assert.deepEqual([later.step, later.warn, later.provedAt], ['onboarded', false, report.provedAt]);
  });

  test('no phone number: warned at once, gently in the first minutes (the number can come a moment after linking) and plainly after', () => {
    const { onboarding, advance } = gate();
    const young = onboarding().evaluate(linked({ simNumber: false }));
    assert.deepEqual([young.step, young.warn, young.onboarded], ['no-number', true, false]);
    assert.match(young.message, /has not told the bridge alice's phone number yet\. Give it a minute or two/);
    advance(NUMBER_GRACE_MS);
    const old = onboarding().evaluate(linked({ simNumber: false }));
    assert.equal(old.step, 'no-number');
    assert.match(old.message, /The bridge has no phone number for alice's phone/);
    assert.match(old.message, /copies ALL of their chats onto this host/);
    assert.match(old.message, /Unlink alice now \(below\)/);
    assert.match(old.message, /2026-10-29/);
  });

  test('no phone number comes first: even a chat that arrived, or a person set up before, is warned about it', () => {
    const { onboarding } = gate();
    const found = onboarding().evaluate(linked({ simNumber: false, chatFound: true }));
    assert.deepEqual([found.step, found.warn, found.onboarded], ['no-number', true, false], 'the chat of a login that keeps every chat proves nothing');
    const ok = onboarding().evaluate(linked({ chatFound: true }));
    assert.equal(ok.step, 'onboarded');
    const phoneChanged = onboarding().evaluate(linked({ simNumber: false }));
    assert.deepEqual([phoneChanged.step, phoneChanged.warn, phoneChanged.onboarded], ['no-number', true, false], 'a new phone with no number is caught after they were set up');
  });

  test('a number that cannot be read is not taken for a missing one', () => {
    const { onboarding } = gate();
    const report = onboarding().evaluate(linked({ simNumber: null }));
    assert.deepEqual([report.step, report.warn], ['waiting-for-chat', false]);
  });

  test('a person who was set up stays set up while their login is only disconnected, with nothing written', () => {
    const { onboarding, writes } = gate();
    onboarding().evaluate(linked({ chatFound: true }));
    writes.length = 0;
    for (const login of ['other', 'unknown'] as const) {
      const report = onboarding().evaluate({ login, simNumber: null, chatFound: false });
      assert.deepEqual([report.step, report.onboarded, report.warn], ['onboarded', true, false], login);
      assert.match(report.message, /Google Messages is not connected right now/);
    }
    assert.deepEqual(writes, []);
  });

  test('a login the bridge says is gone altogether (an unlink) forgets how far they got: they start again', () => {
    const { onboarding, catalog, advance } = gate();
    onboarding().evaluate(linked({ chatFound: true }));
    assert.ok(catalog.getState(`${LINKED_KEY}:alice`) && catalog.getState(`${PROVED_KEY}:alice`));
    advance(5 * MINUTE);
    const gone = onboarding().evaluate({ login: 'none', simNumber: false, chatFound: false });
    assert.deepEqual([gone.step, gone.onboarded, gone.linkedSince, gone.provedAt], ['not-linked', false, null, null]);
    assert.ok(!catalog.getState(`${LINKED_KEY}:alice`) && !catalog.getState(`${PROVED_KEY}:alice`));
    // Back on another phone: a new window, no old proof.
    advance(MINUTE);
    const again = onboarding().evaluate(linked());
    assert.equal(again.step, 'waiting-for-chat');
    assert.equal(again.linkedSince, new Date(Date.parse('2026-11-08T12:00:00Z') + 6 * MINUTE).toISOString());
  });

  test('every fact is written once: looking again every few seconds costs the database nothing', () => {
    const { onboarding, writes, advance } = gate();
    for (let i = 0; i < 30; i += 1) {
      onboarding().evaluate(linked());
      advance(5_000);
    }
    assert.deepEqual(writes, [`${LINKED_KEY}:alice`]);
    for (let i = 0; i < 30; i += 1) onboarding().evaluate(linked({ chatFound: true }));
    assert.deepEqual(writes, [`${LINKED_KEY}:alice`, `${PROVED_KEY}:alice`]);
    for (let i = 0; i < 5; i += 1) onboarding().evaluate({ login: 'none', simNumber: false, chatFound: false });
    assert.deepEqual(writes, [`${LINKED_KEY}:alice`, `${PROVED_KEY}:alice`, `${LINKED_KEY}:alice`, `${PROVED_KEY}:alice`], 'forgetting is written once too');
  });

  test('what was kept survives a restart (a new gate over the same state), and a damaged time is replaced', () => {
    const { onboarding, catalog, advance } = gate();
    onboarding().evaluate(linked());
    advance(4 * MINUTE);
    assert.equal(onboarding().evaluate(linked()).linkedSince, '2026-11-08T12:00:00.000Z', 'a new gate reads the same time');
    catalog.setState(`${LINKED_KEY}:alice`, 'yesterday-ish');
    const repaired = onboarding().evaluate(linked());
    assert.equal(repaired.linkedSince, new Date(Date.parse('2026-11-08T12:00:00Z') + 4 * MINUTE).toISOString());
  });

  test('each person has their own record: one person’s link, proof and unlink never touch another’s', () => {
    const { onboarding, catalog } = gate();
    onboarding(alice).evaluate(linked({ chatFound: true }));
    onboarding(bob).evaluate(linked());
    assert.ok(catalog.getState(`${PROVED_KEY}:alice`));
    assert.ok(!catalog.getState(`${PROVED_KEY}:bob`));
    assert.equal(onboarding(bob).evaluate(linked()).step, 'waiting-for-chat');
    onboarding(bob).evaluate({ login: 'none', simNumber: false, chatFound: false });
    assert.ok(catalog.getState(`${PROVED_KEY}:alice`), 'alice keeps hers');
    assert.equal(onboarding(alice).evaluate({ login: 'other', simNumber: null, chatFound: false }).onboarded, true);
    assert.equal(catalog.getState(LINKED_KEY), undefined, 'the plain (owner) keys are never used');
    assert.equal(catalog.getState(PROVED_KEY), undefined);
  });

  test('the window can be set shorter', () => {
    const { onboarding, advance } = gate({ graceMs: 2 * MINUTE });
    onboarding().evaluate(linked());
    assert.match(onboarding().evaluate(linked()).message, /within 2 minutes of linking/);
    advance(3 * MINUTE);
    assert.equal(onboarding().evaluate(linked()).step, 'chat-missing');
  });
});
