import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { checkAudio } from '../src/audio-check.ts';
import { fetchAudio } from '../src/audio-fetch.ts';
import { createBot, HELP_TEXT } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { createRunner, type PendingChoices } from '../src/runner.ts';
import type { Reply } from '../src/types.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';
import { startMusicHost, type MusicHost } from './helpers/music-host.ts';

describe('runner over Matrix (the bridge case)', () => {
  let mock: MockMatrix;
  let music: MusicHost;
  let catalog: Catalog;

  before(async () => {
    mock = await startMockMatrix();
    music = await startMusicHost();
    catalog = new Catalog(':memory:');
    catalog.add({ title: 'Blue Horizon', artist: 'The Night Owls', url: `${music.url}/blue.mp3` });
    catalog.add({ title: 'Blue Horizon (Live)', artist: 'The Night Owls', url: `${music.url}/blue-live.mp3` });
    catalog.add({ title: 'Paper Planes at Dawn', artist: 'Mira Vale', url: `${music.url}/planes.mp3` });
  });

  after(async () => {
    await mock.close();
    await music.close();
  });

  beforeEach(() => mock.reset());

  function makeRunner(options: { now?: () => number; typingRefreshMs?: number; fetchDelayMs?: number } = {}) {
    const logs: string[] = [];
    const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
    const bot = createBot({
      catalog,
      checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }),
    });
    const runner = createRunner({
      chat: matrix,
      bot,
      chatID: mock.roomId,
      fetchAudio: async (url, title) => {
        if (options.fetchDelayMs) await new Promise((resolve) => setTimeout(resolve, options.fetchDelayMs));
        return fetchAudio(url, title);
      },
      pollMs: 20,
      log: (line) => logs.push(line),
      ...(options.now ? { now: options.now } : {}),
      ...(options.typingRefreshMs ? { typingRefreshMs: options.typingRefreshMs } : {}),
    });
    return { runner, logs };
  }

  const typedOnPhone = (body: string) => mock.addMessage(mock.ghost, { msgtype: 'm.text', body });

  test('never replays history that was in the room before it started', async () => {
    typedOnPhone('paper planes');
    const { runner } = makeRunner();
    await runner.prime();
    await runner.tick();
    assert.deepEqual(mock.sent, []);
  });

  test('answers a request typed on the phone with a caption and an audio message', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('paper planes');
    await runner.tick();

    assert.equal(mock.sent.length, 2);
    assert.deepEqual(mock.sent[0]?.content, { msgtype: 'm.text', body: '🎵 Mira Vale — Paper Planes at Dawn' });
    const audio = mock.sent[1]?.content;
    assert.equal(audio?.msgtype, 'm.audio');
    assert.equal(audio?.filename, 'Mira Vale — Paper Planes at Dawn.mp3');
    assert.equal(audio?.info.mimetype, 'audio/mpeg');
    assert.equal(audio?.url, mock.uploads[0]?.mxc);
    assert.deepEqual(mock.uploads[0]?.bytes, music.bytes('/planes.mp3'));
  });

  test('does not answer itself, even when a bridge echoes its texts back from another user', async () => {
    mock.echoAsGhost = true;
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('paper planes');
    await runner.tick();
    const sentAfterFirst = mock.sent.length;
    assert.equal(sentAfterFirst, 2);
    for (let i = 0; i < 4; i++) await runner.tick();
    assert.equal(mock.sent.length, sentAfterFirst);
  });

  test('shows "typing…" while it works on a request and clears it once the answer is out', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('paper planes');
    await runner.tick();
    assert.equal(mock.typing.length, 2);
    const [on, off] = mock.typing;
    assert.ok(on?.typing && on.afterSends < 2, 'turned on before the answer is out');
    assert.ok(off && !off.typing && off.afterSends === 2, 'turned off after the caption and the audio');
    assert.ok(mock.typing.every((call) => call.roomId === mock.roomId && call.userId === mock.userId));
  });

  test('renews "typing…" while a slow request is still being worked on', async () => {
    const { runner } = makeRunner({ typingRefreshMs: 15, fetchDelayMs: 140 });
    await runner.prime();
    typedOnPhone('paper planes');
    await runner.tick();
    assert.ok(mock.typing.filter((call) => call.typing).length >= 3, 'renewed more than once during the wait');
    assert.equal(mock.typing.at(-1)?.typing, false, 'and the last word is "stopped"');
    const calls = mock.typing.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(mock.typing.length, calls, 'nothing is renewed after the request is done');
  });

  test('a broken typing indicator never stops the answer, and is reported once', async () => {
    mock.failTyping = true;
    const { runner, logs } = makeRunner({ typingRefreshMs: 10, fetchDelayMs: 60 });
    await runner.prime();
    typedOnPhone('paper planes');
    await runner.tick();
    assert.equal(mock.sent.length, 2);
    assert.equal(logs.filter((line) => line.includes('typing indicator failed')).length, 1);
  });

  test('ignored messages and repeats do not show "typing…"', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('🎵 something the bot said');
    mock.addMessage(mock.ghost, { msgtype: 'm.image', body: 'x.png', url: 'mxc://localhost/img' });
    await runner.tick();
    assert.equal(mock.typing.length, 0);

    typedOnPhone('paper planes');
    typedOnPhone('paper planes');
    await runner.tick();
    assert.equal(mock.typing.filter((call) => call.typing).length, 1, 'one request, one "typing…"');
  });

  test('does not answer again when a copy of the request bounces back a moment later', async () => {
    const { runner, logs } = makeRunner();
    await runner.prime();
    typedOnPhone('paper planes');
    typedOnPhone('Paper  planes '); // the echo: same words, different case and spacing
    await runner.tick();
    assert.equal(mock.sent.length, 2, 'one caption and one audio file, not two of each');
    assert.ok(logs.some((line) => line.includes('ignoring a repeat')));
  });

  test('answers the same request again once the repeat window has passed', async () => {
    let clock = 1_000_000;
    const { runner } = makeRunner({ now: () => clock });
    await runner.prime();
    typedOnPhone('paper planes');
    await runner.tick();
    assert.equal(mock.sent.length, 2);
    clock += 21_000;
    typedOnPhone('paper planes');
    await runner.tick();
    assert.equal(mock.sent.length, 4);
  });

  test('a different request right after the first is answered as usual', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('paper planes');
    typedOnPhone('night owls');
    await runner.tick();
    assert.equal(mock.sent.length, 3, 'the audio for the first, then the list for the second');
  });

  test('offers a numbered choice and takes the number as the answer', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('night owls');
    await runner.tick();
    assert.equal(
      mock.sent[0]?.content.body,
      '🎵 Which one?\n1. The Night Owls — Blue Horizon\n2. The Night Owls — Blue Horizon (Live)\n\nReply with a number to choose.',
    );

    typedOnPhone('2');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon (Live).mp3');
  });

  test('another number from the same list picks again, since the list is still on screen', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('night owls');
    await runner.tick();
    typedOnPhone('2');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon (Live).mp3');
    typedOnPhone('1');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon.mp3');
  });

  test('a new search ends the list, so a later number is no longer an answer', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('night owls');
    await runner.tick();
    typedOnPhone('paper planes');
    await runner.tick();
    const before = mock.sent.length;
    typedOnPhone('1');
    await runner.tick();
    assert.equal(mock.sent.length, before + 1);
    assert.equal(mock.sent.at(-1)?.content.body, `🎵 ${HELP_TEXT}`);
  });

  test('a number beyond the list is explained, and the list still works afterwards', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('night owls');
    await runner.tick();
    typedOnPhone('7');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.body, '🎵 Pick a number from 1 to 2, or text me another song name.');
    typedOnPhone('1');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon.mp3');
  });

  test('a list stops answering numbers after half an hour', async () => {
    let clock = 1_000_000;
    const { runner } = makeRunner({ now: () => clock });
    await runner.prime();
    typedOnPhone('night owls');
    await runner.tick();
    clock += 31 * 60_000;
    typedOnPhone('2');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.body, `🎵 ${HELP_TEXT}`);
  });

  describe('pictures and messages the bot starts itself', () => {
    const picture = (url: string) => ({
      data: new Blob([Buffer.from('jpeg')], { type: 'image/jpeg' }),
      fileName: 'cover.jpg',
      mimeType: 'image/jpeg',
      bytes: 4,
      sourceUrl: url,
    });

    function runnerWith(bot: { handle: () => Promise<Reply[]> }, fetchImage: (url: string) => Promise<ReturnType<typeof picture>>, now?: () => number) {
      const logs: string[] = [];
      const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
      const runner = createRunner({
        chat: matrix,
        bot,
        chatID: mock.roomId,
        fetchAudio: (url, title) => fetchAudio(url, title),
        fetchImage,
        pollMs: 20,
        log: (line) => logs.push(line),
        ...(now ? { now } : {}),
      });
      return { runner, logs };
    }

    test('a picture goes out as an image, before the words that follow it', async () => {
      const { runner } = runnerWith({ handle: async () => [{ kind: 'image', url: 'https://img.test/a.jpg' }, { kind: 'text', text: 'Ana Elech' }] }, async (url) => picture(url));
      await runner.prime();
      typedOnPhone('ana elech');
      await runner.tick();
      assert.deepEqual(mock.sent.map((s) => s.content.msgtype), ['m.image', 'm.text']);
      assert.equal(mock.uploads[0]?.contentType, 'image/jpeg');
    });

    test('a picture that cannot be fetched is left out and the answer goes on', async () => {
      const { runner, logs } = runnerWith(
        { handle: async () => [{ kind: 'image', url: 'https://img.test/gone.jpg' }, { kind: 'text', text: 'still here' }] },
        async () => {
          throw new Error('the picture server answered HTTP 404');
        },
      );
      await runner.prime();
      typedOnPhone('anything');
      await runner.tick();
      assert.deepEqual(mock.sent.map((s) => s.content.body), ['🎵 still here']);
      assert.ok(logs.some((line) => /could not send a picture: the picture server answered HTTP 404/.test(line)));
    });

    test('announce sends a message nobody asked for, and its numbers work for as long as it says', async () => {
      let clock = 1_000_000;
      const live = catalog.search('blue horizon live')[0]!;
      const { runner } = runnerWith(
        {
          handle: async () => [
            { kind: 'text', text: '🎵 Blue Horizon (Live)' },
            { kind: 'audio', url: live.url, title: 'The Night Owls — Blue Horizon (Live)' },
          ],
        },
        async (url) => picture(url),
        () => clock,
      );
      await runner.prime();
      await runner.announce([
        { kind: 'text', text: 'New music today' },
        { kind: 'text', text: '1. The Night Owls — Blue Horizon (Live)\n\nReply with a number to get the song.', chips: [{ label: '1', postback: `play:${live.id}` }], chipsValidMs: 24 * 60 * 60_000 },
      ]);
      assert.deepEqual(mock.sent.map((s) => s.content.body), [
        '🎵 New music today',
        '🎵 1. The Night Owls — Blue Horizon (Live)\n\nReply with a number to get the song.',
      ], 'its own hint, not a second one');
      clock += 5 * 60 * 60_000; // five hours later
      typedOnPhone('1');
      await runner.tick();
      assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon (Live).mp3');
    });

    test('a list sent by another process (or before a restart) still answers a number, through the shared store', async () => {
      const live = catalog.search('blue horizon live')[0]!;
      let kept: PendingChoices | undefined;
      const store = { load: () => kept, save: (choices: PendingChoices | undefined) => void (kept = choices) };
      const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
      const sender = createRunner({ chat: matrix, bot: { handle: async () => [] }, chatID: mock.roomId, fetchAudio: (url, title) => fetchAudio(url, title), choices: store });
      await sender.announce([{ kind: 'text', text: '1. Blue Horizon (Live)', chips: [{ label: '1', postback: `play:${live.id}` }], chipsValidMs: 60 * 60_000 }]);
      assert.equal(kept?.chips[0]?.postback, `play:${live.id}`);

      const bot = createBot({ catalog, checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }) });
      const answerer = createRunner({ chat: new MatrixClient({ token: mock.token, homeserver: mock.url }), bot, chatID: mock.roomId, fetchAudio: (url, title) => fetchAudio(url, title), choices: store });
      await answerer.prime();
      typedOnPhone('1');
      await answerer.tick();
      assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon (Live).mp3');
      typedOnPhone('paper planes');
      await answerer.tick();
      assert.equal(kept, undefined, 'a new search ends the list for everyone');
    });

    test('a 👍 on a message that stands for a song sends that song; other reactions and other messages do nothing', async () => {
      const live = catalog.search('blue horizon live')[0]!;
      const bot = createBot({ catalog, checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }) });
      const logs: string[] = [];
      const runner = createRunner({
        chat: new MatrixClient({ token: mock.token, homeserver: mock.url }),
        bot,
        chatID: mock.roomId,
        fetchAudio: (url, title) => fetchAudio(url, title),
        pollMs: 20,
        log: (line) => logs.push(line),
      });
      await runner.prime();
      await runner.announce([
        { kind: 'text', text: 'New music today' },
        { kind: 'text', text: '1. The Night Owls — Blue Horizon (Live)', postback: `play:${live.id}` },
      ]);
      const [heading, item] = mock.sent.map((s) => s.eventId);
      mock.addReaction(mock.ghost, heading!, '👍');
      mock.addReaction(mock.ghost, item!, '❤️');
      await runner.tick();
      assert.equal(mock.sent.length, 2, 'a 👍 on the heading, or a ❤️ on the song, sends nothing');
      mock.addReaction(mock.ghost, item!, '👍🏽');
      await runner.tick();
      assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon (Live).mp3');
      assert.ok(logs.some((line) => line === `<- 👍 play:${live.id}`));
    });

    test('announce waits for a request that is being answered', async () => {
      let release: () => void = () => {};
      const slow = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { runner } = runnerWith(
        {
          handle: async () => {
            await slow;
            return [{ kind: 'text', text: 'the answer' }];
          },
        },
        async (url) => picture(url),
      );
      await runner.prime();
      typedOnPhone('something');
      const answering = runner.tick();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const announcing = runner.announce([{ kind: 'text', text: 'daily message' }]);
      release();
      await Promise.all([answering, announcing]);
      assert.deepEqual(mock.sent.map((s) => s.content.body), ['🎵 the answer', '🎵 daily message']);
    });
  });

  test('ignores bridge notices, edits and media', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    mock.addMessage('@gmessagesbot:localhost', { msgtype: 'm.notice', body: 'paper planes' });
    mock.addMessage(mock.ghost, { msgtype: 'm.image', body: 'paper planes.png', url: 'mxc://localhost/img' });
    mock.addMessage(mock.ghost, {
      msgtype: 'm.text',
      body: '* paper planes',
      'm.relates_to': { rel_type: 'm.replace', event_id: '$older' },
    });
    await runner.tick();
    assert.deepEqual(mock.sent, []);
  });

  test('survives a failed sync and answers what arrived meanwhile', async () => {
    const { runner, logs } = makeRunner();
    await runner.prime();
    mock.failSync = true;
    typedOnPhone('paper planes');
    await runner.tick();
    assert.ok(logs.some((line) => line.includes('poll failed')));
    assert.deepEqual(mock.sent, []);

    mock.failSync = false;
    await runner.tick();
    assert.equal(mock.sent.length, 2);
  });
});
