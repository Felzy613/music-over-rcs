import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { BROWSE_HELP_TEXT, createBot, HELP_TEXT } from '../src/bot.ts';
import { loadExtensions, startExtensions, stopExtensions, type Extension, type ExtensionChat, type ExtensionContext } from '../src/extensions.ts';
import { gmessagesPictureFacts, MatrixClient } from '../src/matrix/client.ts';
import { createRunner, markBotText, type ChatClient, type ChatMessage, type IncomingPicture } from '../src/runner.ts';
import type { Reply } from '../src/types.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';

// What add-ons (src/extensions.ts) build on: loading them, an assistant's first word, pictures from the phone, and
// reactions. The add-ons themselves are tested in their own folders.

describe('loading add-ons', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'extensions-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('each folder with an index.ts is set up; one that is off or broken is left out, and a broken one is said', async () => {
    const problems: string[] = [];
    const context: ExtensionContext = {
      state: { getState: () => undefined, setState: () => {} },
      health: { problem: (_key, message) => void problems.push(message), ok: () => {} },
      env: { GREETING: 'hello' },
      log: () => {},
      download: async () => new Uint8Array(),
    };
    const add = async (name: string, source: string) => {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, 'index.ts'), source);
    };
    await add('a-works', "export default (context) => ({ name: 'works', summary: context.env.GREETING });\n");
    await add('b-off', 'export default () => undefined;\n');
    await add('c-broken', "export default () => { throw new Error('no settings'); };\n");
    await add('d-no-default', 'export const nothing = 1;\n');
    await mkdir(join(dir, 'e-empty'));
    const loaded = await loadExtensions(context, dir);
    assert.deepEqual(
      loaded.map((extension) => [extension.name, extension.summary]),
      [['works', 'hello']],
    );
    assert.deepEqual(problems, ['The add-on "c-broken" didn\'t start: no settings', 'The add-on "d-no-default" didn\'t start: its index.ts has no default export']);
    assert.deepEqual(await loadExtensions(context, join(dir, 'missing')), []);
  });

  test('one that throws when started or stopped is said or logged, and the others still start and stop', async () => {
    const problems: string[] = [];
    const logged: string[] = [];
    const ran: string[] = [];
    const extensions: Extension[] = [
      { name: 'broken', start: () => { throw new Error('no chat yet'); }, stop: async () => { throw new Error('stuck'); } },
      { name: 'fine', start: () => void ran.push('start'), stop: async () => void ran.push('stop') },
    ];
    const chat: ExtensionChat = { announce: async () => {}, post: async () => undefined, react: async () => undefined, unreact: async () => {} };
    startExtensions(extensions, chat, { problem: (_key, message) => void problems.push(message), ok: () => {} });
    await stopExtensions(extensions, (line) => void logged.push(line));
    assert.deepEqual(ran, ['start', 'stop']);
    assert.deepEqual(problems, ['The add-on "broken" didn\'t start: no chat yet']);
    assert.deepEqual(logged, ['the add-on "broken" didn\'t stop cleanly: stuck']);
  });
});

describe('an assistant\'s word ("jarvis …")', () => {
  const catalog = { search: () => [], get: () => undefined };
  const checkAudio = async () => ({ ok: true as const, type: 'audio/mpeg' });

  function bot(forward: (text: string) => Promise<string | undefined>) {
    const forwarded: string[] = [];
    const instance = createBot({
      catalog,
      checkAudio,
      assistant: {
        word: 'jarvis',
        name: 'Jarvis',
        forward: async (text) => {
          forwarded.push(text);
          return forward(text);
        },
      },
    });
    return { instance, forwarded };
  }

  test('the rest of the message goes on whole, however long, and nothing is said when it went', async () => {
    const { instance, forwarded } = bot(async () => undefined);
    const long = `Can you plan my week? ${'Details. '.repeat(60)}`.trim();
    assert.deepEqual(await instance.handle({ from: 'me', messageId: '1', text: `Jarvis, ${long}` }), []);
    assert.deepEqual(await instance.handle({ from: 'me', messageId: '2', text: 'jarvis: search for flights' }), []);
    assert.deepEqual(forwarded, [long, 'search for flights']);
  });

  test('just "jarvis" says how; a failure says why; a note is passed on', async () => {
    const { instance, forwarded } = bot(async (text) => {
      if (text === 'fail') throw new Error("it isn't signed in");
      return text === 'note' ? 'Sent to Jarvis, but…' : undefined;
    });
    const say = async (text: string) => (await instance.handle({ from: 'me', messageId: text, text })).map((reply) => (reply.kind === 'text' ? reply.text : reply.kind));
    assert.deepEqual(await say('Jarvis'), ['Text "jarvis" and your message, like "jarvis what\'s on my calendar tomorrow?"']);
    assert.deepEqual(await say('jarvis fail'), ["I couldn't send that to Jarvis: it isn't signed in."]);
    assert.deepEqual(await say('jarvis note'), ['Sent to Jarvis, but…']);
    assert.deepEqual(forwarded, ['fail', 'note']);
  });

  test('"jarviss" and "search jarvis" are not for it; the help mentions it only when it is on', async () => {
    const { instance, forwarded } = bot(async () => undefined);
    await instance.handle({ from: 'me', messageId: '1', text: 'jarviss song' });
    await instance.handle({ from: 'me', messageId: '2', text: 'search jarvis' });
    assert.deepEqual(forwarded, []);
    const [help] = await instance.handle({ from: 'me', messageId: '3', text: 'help' });
    assert.equal((help as Extract<Reply, { kind: 'text' }>).text, `${HELP_TEXT}\n"jarvis" and a message to ask Jarvis; the answer comes back here.`);
    const without = createBot({ catalog, checkAudio });
    const [plain] = await without.handle({ from: 'me', messageId: '4', text: 'help' });
    assert.equal((plain as Extract<Reply, { kind: 'text' }>).text, HELP_TEXT);
    assert.notEqual(HELP_TEXT, BROWSE_HELP_TEXT);
  });
});

describe('the runner and relayed replies', () => {
  test("a 🤖 text isn't marked again, and the bot never answers one (the phone's echo of a relayed reply)", async () => {
    assert.equal(markBotText('🤖 9:30 tomorrow.'), '🤖 9:30 tomorrow.');
    assert.equal(markBotText('Sent to Jarvis'), '🎵 Sent to Jarvis');
    const incoming: ChatMessage[] = [];
    const sentTexts: string[] = [];
    const chat: ChatClient = {
      listMessages: async () => incoming.splice(0),
      sendText: async (_chat, text) => void sentTexts.push(text),
      sendAudio: async () => undefined,
    };
    const handled: string[] = [];
    const runner = createRunner({
      chat,
      bot: { handle: async (msg) => (handled.push(msg.text ?? ''), []) },
      chatID: 'room',
      fetchAudio: async () => {
        throw new Error('no songs here');
      },
    });
    await runner.announce([{ kind: 'text', text: '🤖 9:30 tomorrow.' }]);
    assert.deepEqual(sentTexts, ['🤖 9:30 tomorrow.']);
    incoming.push({ id: 'echo', timestamp: '', text: '🤖 9:30 tomorrow.', hasAttachments: false, isDeleted: false });
    incoming.push({ id: 'mine', timestamp: '', text: 'jarvis thanks', hasAttachments: false, isDeleted: false });
    await runner.tick();
    assert.deepEqual(handled, ['jarvis thanks']);
  });
});

describe('pictures and reactions on the Matrix side', () => {
  let mock: MockMatrix;
  beforeEach(async () => {
    mock = await startMockMatrix();
  });
  afterEach(async () => {
    await mock.close();
  });

  test("a picture from the phone comes with its text, edits included; the bot's own pictures and other edits don't", async () => {
    const client = new MatrixClient({ token: mock.token, homeserver: mock.url });
    await client.listMessages(mock.roomId);
    const original = mock.addMessage(mock.ghost, {});
    mock.addMessage(mock.ghost, { msgtype: 'm.notice', body: '* Waiting for attachment', 'm.new_content': { msgtype: 'm.notice', body: 'Waiting' }, 'm.relates_to': { rel_type: 'm.replace', event_id: original } });
    const full = mock.addMedia(Buffer.from('jpeg bytes'), 'image/jpeg');
    const image = { msgtype: 'm.image', body: 'Jarvis what is this', filename: '2052.jpg', url: full, info: { mimetype: 'image/jpeg', size: 10 } };
    mock.addMessage(mock.ghost, { ...image, 'm.new_content': image, 'm.relates_to': { rel_type: 'm.replace', event_id: original } });
    mock.addMessage(mock.ghost, { msgtype: 'm.image', body: 'IMG_1.jpg', url: 'mxc://localhost/plain', info: { mimetype: 'image/png' } });
    mock.addMessage(mock.userId, { msgtype: 'm.image', body: 'cover.jpg', filename: 'cover.jpg', url: 'mxc://localhost/card' });
    const pictures = (await client.listMessages(mock.roomId)).flatMap((message) => (message.picture ? [message.picture] : []));
    // Without the bridge's own data, a picture counts as sent when it arrived.
    assert.ok(pictures.every((picture) => typeof picture.sentAt === 'number'));
    assert.deepEqual(
      pictures.map(({ sentAt: _sentAt, ...picture }) => picture),
      [
        { url: full, mimeType: 'image/jpeg', name: '2052.jpg', of: original, caption: 'Jarvis what is this', bytes: 10 },
        { url: 'mxc://localhost/plain', mimeType: 'image/png', name: 'IMG_1.jpg', of: pictures[1]!.of },
      ],
    );
    assert.deepEqual([...(await client.downloadMedia(full))], [...Buffer.from('jpeg bytes')]);
    await assert.rejects(client.downloadMedia('https://example.com/x.jpg'), /Not a Matrix media address/);
  });

  test("reactions go on a message, aren't read back as new, and can be taken back", async () => {
    const client = new MatrixClient({ token: mock.token, homeserver: mock.url });
    await client.listMessages(mock.roomId);
    const target = mock.addMessage(mock.ghost, { msgtype: 'm.text', body: 'jarvis nice' });
    await client.listMessages(mock.roomId);
    const id = await client.sendReaction(mock.roomId, target, '👍');
    assert.deepEqual(mock.reactionsSent, [{ eventId: id, to: target, key: '👍' }]);
    assert.deepEqual(await client.listMessages(mock.roomId), []);
    await client.redact(mock.roomId, id!);
    assert.deepEqual(mock.redactions, [id]);
  });

  test('the runner hands pictures to onPicture and never answers them', async () => {
    const pictures: IncomingPicture[] = [];
    const handled: string[] = [];
    const incoming: ChatMessage[] = [
      { id: '1', timestamp: '', text: 'Jarvis look', hasAttachments: true, isDeleted: false, picture: { url: 'mxc://a/b', mimeType: 'image/jpeg', name: 'b.jpg', caption: 'Jarvis look', of: '1' } },
    ];
    const runner = createRunner({
      chat: { listMessages: async () => incoming.splice(0), sendText: async () => undefined, sendAudio: async () => undefined },
      bot: { handle: async (msg) => (handled.push(msg.text ?? ''), []) },
      chatID: 'room',
      fetchAudio: async () => {
        throw new Error('no songs here');
      },
      onPicture: (picture) => void pictures.push(picture),
    });
    await runner.tick();
    assert.equal(pictures.length, 1);
    assert.deepEqual(handled, []);
  });
});

/** Protobuf, just enough to build what the Google Messages bridge keeps as raw_debug_data. */
const proto = {
  varint(n: bigint): Buffer {
    const out: number[] = [];
    do {
      let byte = Number(n & 0x7fn);
      n >>= 7n;
      if (n > 0n) byte |= 0x80;
      out.push(byte);
    } while (n > 0n);
    return Buffer.from(out);
  },
  number(field: number, n: bigint): Buffer {
    return Buffer.concat([proto.varint(BigInt(field << 3)), proto.varint(n)]);
  },
  bytes(field: number, value: Buffer | string): Buffer {
    const data = Buffer.from(value);
    return Buffer.concat([proto.varint(BigInt((field << 3) | 2)), proto.varint(BigInt(data.length)), data]);
  },
};

/** The bridge's copy of a picture message: sent at `sentAt`, with Google's media id once the full picture is in. */
function rawPictureMessage(sentAt: number, mediaId: string | undefined): string {
  const media = Buffer.concat([
    proto.number(1, 1n),
    ...(mediaId ? [proto.bytes(2, mediaId)] : []),
    proto.bytes(4, 'b0a72a2c.jpg'),
    proto.number(5, 1117216n),
    proto.bytes(9, 'cfb6ccf5/thumbnail'),
    proto.bytes(14, 'image/jpeg'),
  ]);
  const message = Buffer.concat([
    proto.bytes(1, '21155'),
    proto.number(5, BigInt(sentAt) * 1000n),
    proto.bytes(10, Buffer.concat([proto.bytes(1, '21309'), proto.bytes(3, media)])),
    proto.bytes(10, Buffer.concat([proto.bytes(1, '21155caption'), proto.bytes(2, proto.bytes(1, 'Jarvis what is this?'))])),
  ]);
  return proto.bytes(3, proto.bytes(2, message)).toString('base64');
}

describe("the bridge's picture data", () => {
  test('a preview has no media id yet; the full picture does; both say when it was sent', () => {
    const sent = Date.UTC(2026, 9, 7, 17, 54, 0, 970);
    assert.deepEqual(gmessagesPictureFacts(rawPictureMessage(sent, undefined)), { sentAt: sent, complete: false });
    assert.deepEqual(gmessagesPictureFacts(rawPictureMessage(sent, '8a2056c3/7b5AAZdQ9xkkrjXlmlBGjfrUQ')), { sentAt: sent, complete: true });
    assert.deepEqual(gmessagesPictureFacts(undefined), {});
    assert.deepEqual(gmessagesPictureFacts('not protobuf at all'), {});
  });
});

