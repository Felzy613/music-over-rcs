import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { RbmClient, RbmError, ServiceAccountAuth, type RbmClientOptions } from '../src/rbm/client.ts';
import { startMockRbm, type MockRbm } from './helpers/mock-rbm.ts';

const PHONE = '+15551234567';
const AGENT = 'music_bot@rbm.goog';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('RbmClient', () => {
  let mock: MockRbm;
  before(async () => {
    mock = await startMockRbm();
  });
  after(() => mock.close());
  beforeEach(() => {
    mock.requests.length = 0;
    mock.tokenRequests.length = 0;
  });

  const newClient = (extra: Partial<RbmClientOptions> = {}) =>
    new RbmClient({
      agentId: AGENT,
      apiBase: `${mock.url}/v1`,
      testersUrl: `${mock.url}/v1/testers`,
      auth: new ServiceAccountAuth(mock.serviceAccountKey),
      ...extra,
    });

  test('sendText posts a content message to the phone with bearer auth', async () => {
    await newClient().sendText(PHONE, 'hello');
    assert.equal(mock.requests.length, 1);
    const req = mock.requests[0]!;
    assert.equal(req.method, 'POST');
    assert.equal(req.path, `/v1/phones/${PHONE}/agentMessages`);
    assert.equal(req.query.get('agentId'), AGENT);
    assert.match(req.query.get('messageId') ?? '', UUID);
    assert.match(req.authorization ?? '', /^Bearer tok-\d+$/);
    assert.deepEqual(req.body, { contentMessage: { text: 'hello' } });
    assert.equal(mock.tokenRequests[0]?.claims.scope, 'https://www.googleapis.com/auth/rcsbusinessmessaging');
  });

  test('every message gets its own messageId', async () => {
    const client = newClient();
    await client.sendText(PHONE, 'one');
    await client.sendText(PHONE, 'two');
    assert.equal(new Set(mock.requests.map((r) => r.query.get('messageId'))).size, 2);
  });

  test('sendText adds suggestion chips', async () => {
    await newClient().sendText(PHONE, 'Which one?', [{ label: '1. Blue Horizon', postback: 'play:1' }]);
    assert.deepEqual(mock.requests[0]?.body.contentMessage.suggestions, [
      { reply: { text: '1. Blue Horizon', postbackData: 'play:1' } },
    ]);
  });

  test('sendAudio references the file by public URL', async () => {
    await newClient().sendAudio(PHONE, 'https://cdn.example.test/a.mp3');
    assert.deepEqual(mock.requests[0]?.body, {
      contentMessage: { contentInfo: { fileUrl: 'https://cdn.example.test/a.mp3', forceRefresh: false } },
    });
  });

  test('send() maps replies onto the right call', async () => {
    const client = newClient();
    await client.send(PHONE, { kind: 'text', text: 'hi' });
    await client.send(PHONE, { kind: 'audio', url: 'https://cdn.example.test/a.mp3' });
    assert.equal(mock.requests[0]?.body.contentMessage.text, 'hi');
    assert.equal(mock.requests[1]?.body.contentMessage.contentInfo.fileUrl, 'https://cdn.example.test/a.mp3');
  });

  test('messageTrafficType sits next to contentMessage, and only when configured', async () => {
    await newClient({ trafficType: 'TRANSACTION' }).sendText(PHONE, 'hi');
    await newClient().sendText(PHONE, 'hi');
    assert.equal(mock.requests[0]?.body.messageTrafficType, 'TRANSACTION');
    assert.equal(mock.requests[0]?.body.contentMessage.messageTrafficType, undefined);
    assert.equal('messageTrafficType' in (mock.requests[1]?.body ?? {}), false);
  });

  test('sendEvent sends a typing indicator and a read receipt', async () => {
    const client = newClient();
    await client.sendEvent(PHONE, 'IS_TYPING');
    await client.sendEvent(PHONE, 'READ', 'user-msg-1');
    const [typing, read] = mock.requests;
    assert.equal(typing?.path, `/v1/phones/${PHONE}/agentEvents`);
    assert.match(typing?.query.get('eventId') ?? '', UUID);
    assert.equal(typing?.query.get('agentId'), AGENT);
    assert.deepEqual(typing?.body, { eventType: 'IS_TYPING' });
    assert.deepEqual(read?.body, { eventType: 'READ', messageId: 'user-msg-1' });
  });

  test('inviteTester posts to the Business Communications testers endpoint', async () => {
    await newClient().inviteTester(PHONE);
    const req = mock.requests[0]!;
    assert.equal(req.path, '/v1/testers');
    assert.deepEqual(req.body, { phone_number: PHONE, agentId: AGENT });
    assert.equal(mock.tokenRequests[0]?.claims.scope, 'https://www.googleapis.com/auth/businesscommunications');
  });

  test('rejects bad input before calling the API', async () => {
    const client = newClient();
    await assert.rejects(client.sendText('5551234567', 'hi'), /E\.164/);
    await assert.rejects(client.sendText(PHONE, 'x'.repeat(3073)), /3072/);
    await assert.rejects(client.sendText(PHONE, 'hi', [{ label: 'y'.repeat(26), postback: 'p' }]), /25 characters/);
    await assert.rejects(
      client.sendText(PHONE, 'hi', Array.from({ length: 12 }, (_, i) => ({ label: `${i}`, postback: `${i}` }))),
      /11/,
    );
    await assert.rejects(client.sendEvent('nope', 'IS_TYPING'), /E\.164/);
    assert.equal(mock.requests.length, 0);
  });

  test('maps API errors to RbmError without leaking the full phone number', async () => {
    mock.failNext((r) => r.path.endsWith('/agentMessages'), 403, '{"error":{"status":"PERMISSION_DENIED"}}');
    await assert.rejects(newClient().sendText(PHONE, 'hi'), (err: unknown) => {
      assert.ok(err instanceof RbmError);
      assert.equal(err.status, 403);
      assert.match(err.body, /PERMISSION_DENIED/);
      assert.match(err.message, /HTTP 403/);
      assert.ok(!err.message.includes('5551234567'), err.message);
      return true;
    });
  });
});

describe('ServiceAccountAuth', () => {
  let mock: MockRbm;
  before(async () => {
    mock = await startMockRbm();
  });
  after(() => mock.close());
  beforeEach(() => {
    mock.tokenRequests.length = 0;
  });

  test('signs an RS256 JWT that the token endpoint accepts', async () => {
    const token = await new ServiceAccountAuth(mock.serviceAccountKey).token('scope-a');
    assert.match(token, /^tok-\d+$/);
    const request = mock.tokenRequests[0]!;
    assert.equal(request.signatureValid, true);
    assert.equal(request.claims.iss, mock.serviceAccountKey.client_email);
    assert.equal(request.claims.scope, 'scope-a');
    assert.equal(request.claims.aud, mock.serviceAccountKey.token_uri);
    assert.equal(Number(request.claims.exp) - Number(request.claims.iat), 3600);
  });

  test('caches tokens per scope and refreshes inside the one-minute margin', async () => {
    let now = 1_700_000_000_000;
    const auth = new ServiceAccountAuth(mock.serviceAccountKey, { now: () => now });
    const first = await auth.token('s');
    assert.equal(await auth.token('s'), first);
    assert.equal(mock.tokenRequests.length, 1);

    await auth.token('other');
    assert.equal(mock.tokenRequests.length, 2);

    now += 3_600_000 - 30_000;
    assert.notEqual(await auth.token('s'), first);
    assert.equal(mock.tokenRequests.length, 3);
  });

  test('coalesces concurrent token requests', async () => {
    const auth = new ServiceAccountAuth(mock.serviceAccountKey);
    const tokens = await Promise.all([auth.token('s'), auth.token('s'), auth.token('s')]);
    assert.equal(new Set(tokens).size, 1);
    assert.equal(mock.tokenRequests.length, 1);
  });

  test('surfaces token endpoint failures', async () => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const auth = new ServiceAccountAuth({ ...mock.serviceAccountKey, private_key: other.privateKey });
    await assert.rejects(auth.token('s'), (err: unknown) => err instanceof RbmError && err.status === 400);
  });

  test('loads a key file and rejects files that are not service account keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'key-'));
    try {
      const good = join(dir, 'good.json');
      writeFileSync(good, JSON.stringify(mock.serviceAccountKey));
      assert.ok(ServiceAccountAuth.fromFile(good) instanceof ServiceAccountAuth);

      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{"hello":"world"}');
      assert.throws(() => ServiceAccountAuth.fromFile(bad), /not a service account key/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
