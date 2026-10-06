import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createWebhook, type UserEvent } from '../src/rbm/webhook.ts';
import { signedCall, signedRaw } from './helpers/signing.ts';

const TOKEN = 'client-token-123';
const EVENT: UserEvent = {
  agentId: 'bot@rbm.goog',
  senderPhoneNumber: '+15551234567',
  messageId: 'u1',
  sendTime: '2026-01-01T00:00:00Z',
  text: 'hello',
};

function setup(onEvent?: (event: UserEvent) => Promise<void> | void) {
  const received: UserEvent[] = [];
  const logs: string[] = [];
  const webhook = createWebhook({
    clientToken: TOKEN,
    onEvent:
      onEvent ??
      ((event) => {
        received.push(event);
      }),
    log: (line) => logs.push(line),
  });
  return { webhook, received, logs };
}

describe('webhook verification handshake', () => {
  test('echoes the secret when the client token matches', async () => {
    const { webhook } = setup();
    const res = await webhook.handle({
      headers: { 'x-goog-webhook-type': 'verification' },
      body: JSON.stringify({ clientToken: TOKEN, secret: 'abc123' }),
    });
    assert.deepEqual(res, { status: 200, body: 'abc123' });
  });

  test('is recognised from the body when the header is absent', async () => {
    const { webhook } = setup();
    const res = await webhook.handle({ headers: {}, body: JSON.stringify({ clientToken: TOKEN, secret: 'xyz' }) });
    assert.deepEqual(res, { status: 200, body: 'xyz' });
  });

  test('refuses a different client token and does not reveal the secret', async () => {
    const { webhook } = setup();
    const res = await webhook.handle({
      headers: { 'x-goog-webhook-type': 'verification' },
      body: JSON.stringify({ clientToken: 'wrong', secret: 'abc123' }),
    });
    assert.equal(res.status, 403);
    assert.ok(!res.body.includes('abc123'));
  });

  test('refuses a verification call with missing fields', async () => {
    const { webhook } = setup();
    const res = await webhook.handle({ headers: { 'x-goog-webhook-type': 'verification' }, body: '{}' });
    assert.equal(res.status, 403);
  });
});

describe('webhook message delivery', () => {
  test('acknowledges and passes the decoded event on', async () => {
    const { webhook, received } = setup();
    const call = signedCall(TOKEN, EVENT);
    assert.deepEqual(await webhook.handle(call), { status: 200, body: '' });
    await webhook.idle();
    assert.deepEqual(received, [EVENT]);
  });

  test('rejects wrong-token signatures, tampered payloads and missing signatures', async () => {
    const { webhook, received } = setup();
    const good = signedCall(TOKEN, EVENT);
    const forged = signedCall(TOKEN, { ...EVENT, text: 'tampered' });
    const { 'x-goog-signature': _dropped, ...unsignedHeaders } = good.headers;

    const attempts = {
      'signed with another token': signedCall('someone-else', EVENT),
      'payload swapped under a valid signature': { headers: good.headers, body: forged.body },
      'no signature': { headers: unsignedHeaders, body: good.body },
    };
    for (const [name, call] of Object.entries(attempts)) {
      assert.equal((await webhook.handle(call)).status, 401, name);
    }
    await webhook.idle();
    assert.deepEqual(received, []);
  });

  test('answers 400 to malformed bodies', async () => {
    const { webhook } = setup();
    for (const body of ['not json', '"text"', '{}', '[]']) {
      assert.equal((await webhook.handle({ headers: {}, body })).status, 400, body);
    }
  });

  test('acknowledges before slow processing finishes', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const { webhook } = setup(async () => {
      await gate;
      finished = true;
    });

    const res = await webhook.handle(signedCall(TOKEN, EVENT));
    assert.equal(res.status, 200);
    assert.equal(finished, false);

    release();
    await webhook.idle();
    assert.equal(finished, true);
  });

  test('a failing handler never breaks the acknowledgement', async () => {
    const { webhook, logs } = setup(() => {
      throw new Error('boom');
    });
    assert.equal((await webhook.handle(signedCall(TOKEN, EVENT))).status, 200);
    await webhook.idle();
    assert.ok(logs.some((line) => line.includes('boom')));
  });

  test('a signed payload that is not JSON is acknowledged and ignored', async () => {
    const { webhook, received, logs } = setup();
    assert.equal((await webhook.handle(signedRaw(TOKEN, 'not json at all'))).status, 200);
    await webhook.idle();
    assert.deepEqual(received, []);
    assert.ok(logs.some((line) => line.includes('not JSON')));
  });
});
