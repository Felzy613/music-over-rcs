import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { DownloadedAudio } from '../src/audio-fetch.ts';
import { describeMatrixError, MatrixClient, MatrixError } from '../src/matrix/client.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';

describe('MatrixClient', () => {
  let mock: MockMatrix;
  before(async () => {
    mock = await startMockMatrix();
  });
  after(() => mock.close());
  beforeEach(() => mock.reset());

  const client = () => new MatrixClient({ token: mock.token, homeserver: mock.url });
  const text = (body: string) => ({ msgtype: 'm.text', body });

  test('login returns a token, and a wrong password is refused without echoing it', async () => {
    assert.deepEqual(await MatrixClient.login(mock.url, 'me', mock.password), {
      accessToken: mock.token,
      userId: mock.userId,
    });
    await assert.rejects(MatrixClient.login(mock.url, 'me', 'not-the-password'), (err: unknown) => {
      assert.ok(err instanceof MatrixError);
      assert.equal(err.status, 403);
      assert.equal(err.errcode, 'M_FORBIDDEN');
      assert.ok(!err.message.includes('not-the-password') && !err.body.includes('not-the-password'));
      return true;
    });
  });

  test('whoami works with the token and fails with M_UNKNOWN_TOKEN otherwise', async () => {
    assert.deepEqual(await client().whoami(), { userId: mock.userId });
    await assert.rejects(new MatrixClient({ token: 'wrong', homeserver: mock.url }).whoami(), (err: unknown) => {
      assert.ok(err instanceof MatrixError);
      assert.equal(err.status, 401);
      assert.equal(err.errcode, 'M_UNKNOWN_TOKEN');
      return true;
    });
  });

  test('listMessages returns recent history once, then only what is new', async () => {
    mock.addMessage(mock.ghost, text('old one'));
    const matrix = client();
    assert.deepEqual(
      (await matrix.listMessages(mock.roomId)).map((m) => m.text),
      ['old one'],
    );
    assert.deepEqual(await matrix.listMessages(mock.roomId), []);

    mock.addMessage(mock.ghost, text('paper planes'));
    const fresh = await matrix.listMessages(mock.roomId);
    assert.deepEqual(
      fresh.map((m) => [m.text, m.type, m.hasAttachments, m.isDeleted]),
      [['paper planes', 'TEXT', false, false]],
    );
    assert.match(fresh[0]!.id, /^\$ev\d+:localhost$/);
    assert.match(fresh[0]!.timestamp, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await matrix.listMessages(mock.roomId), []);
  });

  test('maps message kinds: notices and media are not plain text, edits are skipped', async () => {
    const matrix = client();
    await matrix.listMessages(mock.roomId);
    mock.addMessage(mock.ghost, { msgtype: 'm.notice', body: 'bridge says hi' });
    mock.addMessage(mock.ghost, { msgtype: 'm.audio', body: 'song.mp3', url: 'mxc://localhost/x' });
    mock.addMessage(mock.ghost, { msgtype: 'm.image', body: 'cat.png', file: { url: 'mxc://localhost/y' } });
    mock.addMessage(mock.ghost, {
      msgtype: 'm.text',
      body: '* paper planes',
      'm.relates_to': { rel_type: 'm.replace', event_id: '$older' },
    });
    mock.addMessage(mock.ghost, {});

    const messages = await matrix.listMessages(mock.roomId);
    assert.deepEqual(
      messages.map((m) => [m.text, m.type, m.hasAttachments]),
      [
        ['bridge says hi', 'M.NOTICE', false],
        ['song.mp3', 'M.AUDIO', true],
        ['cat.png', 'M.IMAGE', true],
        [undefined, undefined, false],
      ],
    );
  });

  test('a failed sync loses nothing: the next call returns what was waiting', async () => {
    const matrix = client();
    await matrix.listMessages(mock.roomId);
    mock.addMessage(mock.ghost, text('while it was down'));

    mock.failSync = true;
    await assert.rejects(matrix.listMessages(mock.roomId), (err: unknown) => err instanceof MatrixError && err.status === 500);

    mock.failSync = false;
    assert.deepEqual(
      (await matrix.listMessages(mock.roomId)).map((m) => m.text),
      ['while it was down'],
    );
    assert.deepEqual(await matrix.listMessages(mock.roomId), []);
  });

  test('messages it sent itself never come back', async () => {
    const matrix = client();
    await matrix.listMessages(mock.roomId);
    await matrix.sendText(mock.roomId, 'hello');
    assert.deepEqual(await matrix.listMessages(mock.roomId), []);
  });

  test('sendText posts an m.text event to the percent-encoded room path', async () => {
    await client().sendText(mock.roomId, 'hello');
    assert.deepEqual(mock.sent.map((s) => s.content), [{ msgtype: 'm.text', body: 'hello' }]);
    assert.match(
      mock.requests.at(-1)?.path ?? '',
      /^\/_matrix\/client\/v3\/rooms\/!portal%3Alocalhost\/send\/m\.room\.message\/[0-9a-f-]{36}$/,
    );
  });

  test('setTyping shows and clears "typing…" for the signed-in user, looking the user up only once', async () => {
    const c = client();
    await c.setTyping(mock.roomId, true);
    await c.setTyping(mock.roomId, false);
    assert.deepEqual(
      mock.typing.map(({ roomId, userId, typing, timeout }) => ({ roomId, userId, typing, timeout })),
      [
        { roomId: mock.roomId, userId: mock.userId, typing: true, timeout: 30_000 },
        { roomId: mock.roomId, userId: mock.userId, typing: false, timeout: undefined },
      ],
    );
    assert.equal(mock.requests.filter((request) => request.path.endsWith('/account/whoami')).length, 1);
  });

  test('setTyping reports a homeserver error', async () => {
    mock.failTyping = true;
    await assert.rejects(client().setTyping(mock.roomId, true), (err: unknown) => err instanceof MatrixError && err.status === 500);
  });

  test('sendAudio uploads the bytes, then posts an m.audio event that points at them', async () => {
    const bytes = Buffer.from('audio-bytes'.repeat(60));
    const audio: DownloadedAudio = {
      data: new Blob([bytes], { type: 'audio/mpeg' }),
      fileName: 'Mira Vale — Paper Planes.mp3',
      mimeType: 'audio/mpeg',
      bytes: bytes.length,
    };
    await client().sendAudio(mock.roomId, audio);

    const [upload] = mock.uploads;
    assert.equal(upload?.fileName, 'Mira Vale — Paper Planes.mp3');
    assert.equal(upload?.contentType, 'audio/mpeg');
    assert.deepEqual(upload?.bytes, bytes);
    assert.deepEqual(mock.sent.map((s) => s.content), [
      {
        msgtype: 'm.audio',
        body: 'Mira Vale — Paper Planes.mp3',
        filename: 'Mira Vale — Paper Planes.mp3',
        url: upload?.mxc,
        info: { mimetype: 'audio/mpeg', size: bytes.length },
      },
    ]);
  });

  test('sendImage uploads the picture, then posts an m.image event (the bridge sends it as a photo)', async () => {
    const bytes = Buffer.from('jpeg-bytes'.repeat(40));
    await client().sendImage(mock.roomId, {
      data: new Blob([bytes], { type: 'image/jpeg' }),
      fileName: 'cover.jpg',
      mimeType: 'image/jpeg',
      bytes: bytes.length,
      sourceUrl: 'https://img.example.test/cover.jpg',
    });
    const [upload] = mock.uploads;
    assert.equal(upload?.contentType, 'image/jpeg');
    assert.deepEqual(upload?.bytes, bytes);
    assert.deepEqual(mock.sent.map((s) => s.content), [
      { msgtype: 'm.image', body: 'cover.jpg', filename: 'cover.jpg', url: upload?.mxc, info: { mimetype: 'image/jpeg', size: bytes.length } },
    ]);
  });

  test('reactions come through as reactions to a message, and every send says which message it made', async () => {
    const matrix = client();
    const sentId = await matrix.sendText(mock.roomId, 'a song');
    assert.equal(sentId, mock.sent[0]?.eventId);
    await matrix.listMessages(mock.roomId);
    mock.addReaction(mock.ghost, sentId!, '👍');
    const [reaction] = await matrix.listMessages(mock.roomId);
    assert.deepEqual(reaction && { type: reaction.type, reaction: reaction.reaction, hasAttachments: reaction.hasAttachments }, {
      type: 'REACTION',
      reaction: { to: sentId, key: '👍' },
      hasAttachments: false,
    });
  });

  test('reads back what a message says, and fails for one the homeserver does not have', async () => {
    const matrix = client();
    const id = await matrix.sendText(mock.roomId, '🎵 Aleph Beis · Apr 4, 2025');
    assert.equal(await matrix.messageText(mock.roomId, id!), '🎵 Aleph Beis · Apr 4, 2025');
    await assert.rejects(matrix.messageText(mock.roomId, '$nothing:localhost'));
  });

  test('retries once when the homeserver says slow down', async () => {
    mock.rateLimit(1);
    await client().sendText(mock.roomId, 'patient');
    assert.equal(mock.sent.length, 1);
    assert.equal(mock.requests.filter((r) => r.method === 'PUT').length, 2);
  });

  test('listRooms returns joined rooms and pending invites with their names', async () => {
    const rooms = await client().listRooms();
    assert.deepEqual(
      rooms.map((r) => [r.id, r.name, r.members, r.heroes, r.invited]),
      [
        ['!portal:localhost', 'Me', 2, ['@gmessages_me:localhost'], false],
        ['!dm-bot:localhost', '', 2, ['@gmessagesbot:localhost'], false],
        ['!invited:localhost', 'Alex', 0, ['@gmessages_alex:localhost'], true],
      ],
    );
  });

  test('joinRoom accepts an invite, and a room you were never invited to is refused', async () => {
    await client().joinRoom('!invited:localhost');
    assert.deepEqual(mock.joinedViaApi, ['!invited:localhost']);

    const refused = await client().joinRoom('!stranger:localhost').catch((err: unknown) => err);
    assert.ok(refused instanceof MatrixError);
    assert.equal(refused.errcode, 'M_FORBIDDEN');
    assert.match(describeMatrixError(refused), /matrix-rooms/);
  });

  test('createDirectRoom invites the other user to a direct chat', async () => {
    assert.equal(await client().createDirectRoom('@gmessagesbot:localhost'), '!dm-new:localhost');
    assert.deepEqual(mock.created, [{ is_direct: true, invite: ['@gmessagesbot:localhost'], preset: 'trusted_private_chat' }]);
  });

  test('pollEvents reports who said what, notices included', async () => {
    const matrix = client();
    mock.addMessage('@gmessagesbot:localhost', { msgtype: 'm.notice', body: 'Please log in' });
    const events = await matrix.pollEvents(mock.roomId);
    assert.deepEqual(
      events.map((e) => [e.sender, e.msgtype, e.body]),
      [['@gmessagesbot:localhost', 'm.notice', 'Please log in']],
    );
  });

  test('the bridge bot room works as a conversation: send a command, read its reply', async () => {
    mock.botReplies = true;
    const matrix = client();
    await matrix.pollEvents(mock.botRoomId);
    await matrix.sendText(mock.botRoomId, 'login google');
    const events = await matrix.pollEvents(mock.botRoomId);
    assert.deepEqual(
      events.map((e) => [e.sender, e.msgtype, e.body]),
      [[mock.botUser, 'm.notice', 'You said: login google']],
    );
  });

  test('describeMatrixError turns failures into advice', async () => {
    const wrongToken = await new MatrixClient({ token: 'wrong', homeserver: mock.url }).whoami().catch((err: unknown) => err);
    assert.match(describeMatrixError(wrongToken), /npm run matrix-login/);

    const closed = 'http://127.0.0.1:9';
    const unreachable = await new MatrixClient({ token: 'x', homeserver: closed }).whoami().catch((err: unknown) => err);
    assert.match(describeMatrixError(unreachable, closed), /Can't reach the Matrix homeserver at http:\/\/127\.0\.0\.1:9/);

    assert.equal(describeMatrixError(new Error('plain')), 'plain');
  });
});
