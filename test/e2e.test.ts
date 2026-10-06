import assert from 'node:assert/strict';
import type { RequestListener } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { checkAudio } from '../src/audio-check.ts';
import { HELP_TEXT } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { RbmClient, ServiceAccountAuth } from '../src/rbm/client.ts';
import type { Webhook } from '../src/rbm/webhook.ts';
import { createApp, WEBHOOK_PATH } from '../src/server.ts';
import { startMockRbm, type MockRbm } from './helpers/mock-rbm.ts';
import { listen, type Listening } from './helpers/servers.ts';
import { signedCall } from './helpers/signing.ts';

const TOKEN = 'e2e-token';
const AGENT = 'music_bot@rbm.goog';
const ME = '+15551234567';

/** Serves any .mp3 as audio and one HTML page, like a catalog with one bad link. */
const musicHost: RequestListener = (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const head = req.method === 'HEAD';
  if (path.endsWith('.mp3')) {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '2048' });
    if (head) res.end();
    else res.end(Buffer.alloc(2048));
  } else if (path === '/page.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (head) res.end();
    else res.end('<html></html>');
  } else {
    res.writeHead(404).end();
  }
};

const userText = (text: string, messageId: string, from = ME, agentId = AGENT) => ({
  agentId,
  senderPhoneNumber: from,
  messageId,
  sendTime: '2026-01-01T00:00:00Z',
  text,
});

describe('Google webhook to bot to RBM API', () => {
  let rbm: MockRbm;
  let music: Listening;
  let app: Listening;
  let webhook: Webhook;

  before(async () => {
    rbm = await startMockRbm();
    music = await listen(musicHost);

    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Blue Horizon', artist: 'The Night Owls', url: `${music.url}/blue.mp3` });
    catalog.add({ title: 'Blue Horizon (Live)', artist: 'The Night Owls', url: `${music.url}/blue-live.mp3` });
    catalog.add({ title: 'Paper Planes at Dawn', artist: 'Mira Vale', url: `${music.url}/planes.mp3` });
    catalog.add({ title: 'Broken Link', artist: 'Nobody', url: `${music.url}/page.html` });

    const client = new RbmClient({
      agentId: AGENT,
      apiBase: `${rbm.url}/v1`,
      testersUrl: `${rbm.url}/v1/testers`,
      auth: new ServiceAccountAuth(rbm.serviceAccountKey),
    });
    const built = createApp({
      catalog,
      rbm: client,
      clientToken: TOKEN,
      agentId: AGENT,
      allowedSenders: new Set([ME]),
      checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true }),
    });
    webhook = built.webhook;
    app = await listen(built.listener);
  });

  after(async () => {
    await app.close();
    await music.close();
    await rbm.close();
  });

  beforeEach(() => {
    rbm.requests.length = 0;
  });

  async function deliver(event: unknown, options: { token?: string; type?: string } = {}) {
    const call = signedCall(options.token ?? TOKEN, event, options.type);
    const res = await fetch(`${app.url}${WEBHOOK_PATH}`, { method: 'POST', headers: call.headers, body: call.body });
    await webhook.idle();
    return res;
  }

  const sentMessages = () =>
    rbm.requests.filter((r) => r.path.endsWith('/agentMessages')).map((r) => r.body.contentMessage);
  const sentEvents = () => rbm.requests.filter((r) => r.path.endsWith('/agentEvents')).map((r) => r.body);

  test('answers the verification handshake and the health check', async () => {
    const handshake = await fetch(`${app.url}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'x-goog-webhook-type': 'verification', 'content-type': 'application/json' },
      body: JSON.stringify({ clientToken: TOKEN, secret: 'handshake-secret' }),
    });
    assert.equal(handshake.status, 200);
    assert.equal(await handshake.text(), 'handshake-secret');

    assert.equal(await (await fetch(`${app.url}/healthz`)).text(), 'ok');
    assert.equal((await fetch(`${app.url}/nope`)).status, 404);
  });

  test('a text request becomes read receipt, typing, caption and audio file', async () => {
    const res = await deliver(userText('search paper planes', 'm1'));
    assert.equal(res.status, 200);

    assert.deepEqual(sentEvents(), [{ eventType: 'READ', messageId: 'm1' }, { eventType: 'IS_TYPING' }]);
    assert.deepEqual(sentMessages(), [
      { text: '🎵 Mira Vale — Paper Planes at Dawn' },
      { contentInfo: { fileUrl: `${music.url}/planes.mp3`, forceRefresh: false } },
    ]);
    assert.ok(rbm.requests.every((r) => r.path.startsWith(`/v1/phones/${ME}/`)));
  });

  test('an ambiguous request offers chips, and tapping one sends the track', async () => {
    await deliver(userText('search night owls', 'm2'));
    const [question] = sentMessages();
    assert.match(question.text, /^Which one\?/);
    assert.equal(question.suggestions.length, 2);

    rbm.requests.length = 0;
    const tapped = question.suggestions[0].reply;
    await deliver({
      agentId: AGENT,
      senderPhoneNumber: ME,
      messageId: 'm3',
      sendTime: '2026-01-01T00:00:01Z',
      suggestionResponse: { postbackData: tapped.postbackData, text: tapped.text },
    });
    const messages = sentMessages();
    assert.equal(messages.length, 2);
    assert.match(messages[1].contentInfo.fileUrl, /\/blue\.mp3$/);
  });

  test('a link that is not audio is explained, not sent', async () => {
    await deliver(userText('search broken link', 'm4'));
    const messages = sentMessages();
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /I can't send "Nobody — Broken Link": it isn't an audio file/);
  });

  test('greetings get the help text', async () => {
    await deliver(userText('hi', 'm5'));
    assert.deepEqual(sentMessages(), [{ text: HELP_TEXT }]);
  });

  test('when Google rejects the file, the user is told', async () => {
    rbm.failNext((r) => r.path.endsWith('/agentMessages') && r.body?.contentMessage?.contentInfo !== undefined, 400);
    await deliver(userText('search paper planes', 'm6'));
    const messages = sentMessages();
    assert.equal(messages.length, 3, 'caption, the rejected audio attempt, then the notice');
    assert.match(messages[2].text, /couldn't send it/);
  });

  test('senders outside the allow-list are ignored', async () => {
    await deliver(userText('search paper planes', 'm7', '+15559999999'));
    assert.equal(rbm.requests.length, 0);
  });

  test('events for other agents are ignored', async () => {
    await deliver(userText('search paper planes', 'm8', ME, 'someone_else@rbm.goog'));
    assert.equal(rbm.requests.length, 0);
  });

  test('a call signed with the wrong token is rejected', async () => {
    const res = await deliver(userText('search paper planes', 'm9'), { token: 'wrong' });
    assert.equal(res.status, 401);
    assert.equal(rbm.requests.length, 0);
  });

  test('duplicate deliveries are processed once', async () => {
    const event = userText('search paper planes', 'm10');
    await deliver(event);
    await deliver(event);
    assert.equal(sentMessages().length, 2, 'one caption and one audio, not four');
  });

  test('receipts and other events are ignored', async () => {
    const res = await deliver({
      agentId: AGENT,
      senderPhoneNumber: ME,
      eventType: 'DELIVERED',
      messageId: 'agent-msg-1',
      sendTime: '2026-01-01T00:00:02Z',
    });
    assert.equal(res.status, 200);
    assert.equal(rbm.requests.length, 0);
  });
});
