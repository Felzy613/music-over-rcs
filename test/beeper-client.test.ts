import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { DownloadedAudio } from '../src/audio-fetch.ts';
import { BeeperClient, BeeperError, describeBeeperError } from '../src/beeper/client.ts';
import { startMockBeeper, type MockBeeper } from './helpers/mock-beeper.ts';

describe('BeeperClient', () => {
  let mock: MockBeeper;
  before(async () => {
    mock = await startMockBeeper();
  });
  after(() => mock.close());
  beforeEach(() => mock.reset());

  const client = () => new BeeperClient({ token: mock.token, baseUrl: mock.url });

  test('info succeeds with the right token and fails with 401 otherwise', async () => {
    await client().info();
    await assert.rejects(new BeeperClient({ token: 'wrong', baseUrl: mock.url }).info(), (err: unknown) => {
      assert.ok(err instanceof BeeperError);
      assert.equal(err.status, 401);
      return true;
    });
  });

  test('listChats maps the chats and flags the one-person chat with yourself', async () => {
    const chats = await client().listChats();
    assert.deepEqual(
      chats.map((chat) => [chat.title, chat.network, chat.type, chat.participants, chat.selfOnly]),
      [
        ['Me', 'Google Messages', 'single', 1, true],
        ['Alex', 'Google Messages', 'single', 2, false],
        ['Group', 'Telegram', 'group', 3, false],
      ],
    );
    assert.equal(chats[0]?.id, mock.chatID);
  });

  test('listMessages returns the newest page oldest first with plain fields', async () => {
    mock.addUserMessage('first');
    mock.addUserMessage('second');
    mock.addRaw({ type: 'AUDIO', attachments: [{ id: 'a' }] });
    const messages = await client().listMessages(mock.chatID);
    assert.deepEqual(
      messages.map((m) => [m.text, m.type, m.hasAttachments]),
      [
        ['first', 'TEXT', false],
        ['second', 'TEXT', false],
        [undefined, 'AUDIO', true],
      ],
    );
  });

  test('listMessages skips malformed entries', async () => {
    mock.addUserMessage('real');
    mock.extraItems.push(null, 42, 'text', { no: 'id' });
    const messages = await client().listMessages(mock.chatID);
    assert.deepEqual(
      messages.map((m) => m.text),
      ['real'],
    );
  });

  test('sendText posts the text to the percent-encoded chat path', async () => {
    await client().sendText(mock.chatID, 'hello');
    assert.deepEqual(mock.sent, [{ text: 'hello' }]);
    assert.equal(mock.requests.at(-1)?.path, '/v1/chats/!self-chat%3Abeeper.local/messages');
  });

  test('sendAudio uploads the file, then attaches it by uploadID', async () => {
    const bytes = Buffer.from('some-audio-bytes'.repeat(50));
    const audio: DownloadedAudio = {
      data: new Blob([bytes], { type: 'audio/mpeg' }),
      fileName: 'Mira Vale — Paper Planes.mp3',
      mimeType: 'audio/mpeg',
      bytes: bytes.length,
    };
    await client().sendAudio(mock.chatID, audio);

    const [upload] = mock.uploads;
    assert.equal(upload?.fileName, 'Mira Vale — Paper Planes.mp3');
    assert.equal(upload?.mimeType, 'audio/mpeg');
    assert.deepEqual(upload?.bytes, bytes);
    assert.deepEqual(mock.sent, [
      {
        attachment: {
          uploadID: upload?.uploadID,
          fileName: 'Mira Vale — Paper Planes.mp3',
          mimeType: 'audio/mpeg',
          type: 'audio',
        },
      },
    ]);
    assert.deepEqual(
      mock.requests.map((r) => `${r.method} ${r.path}`),
      ['POST /v1/assets/upload', 'POST /v1/chats/!self-chat%3Abeeper.local/messages'],
    );
  });

  test('API errors carry the status and body', async () => {
    mock.failListing = true;
    await assert.rejects(client().listMessages(mock.chatID), (err: unknown) => {
      assert.ok(err instanceof BeeperError);
      assert.equal(err.status, 500);
      assert.match(err.body, /listing is broken/);
      return true;
    });
  });

  test('describeBeeperError turns failures into advice', async () => {
    const wrongToken = await new BeeperClient({ token: 'wrong', baseUrl: mock.url }).info().catch((err: unknown) => err);
    assert.match(describeBeeperError(wrongToken), /access token.*Settings > Developers/);

    const closed = 'http://127.0.0.1:9';
    const unreachable = await new BeeperClient({ token: 'x', baseUrl: closed }).info().catch((err: unknown) => err);
    assert.match(describeBeeperError(unreachable, closed), /Can't reach Beeper Desktop at http:\/\/127\.0\.0\.1:9/);

    assert.equal(describeBeeperError(new Error('plain')), 'plain');
  });
});
