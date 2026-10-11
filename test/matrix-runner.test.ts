import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { checkAudio } from '../src/audio-check.ts';
import { AudioFetchError, fetchAudio } from '../src/audio-fetch.ts';
import { createBot, HELP_TEXT } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import type { Picture, PreparedPicture } from '../src/library/images.ts';
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
    typedOnPhone('search paper planes');
    const { runner } = makeRunner();
    await runner.prime();
    await runner.tick();
    assert.deepEqual(mock.sent, []);
  });

  test('answers a request typed on the phone with a caption and an audio message', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('search paper planes');
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
    typedOnPhone('search paper planes');
    await runner.tick();
    const sentAfterFirst = mock.sent.length;
    assert.equal(sentAfterFirst, 2);
    for (let i = 0; i < 4; i++) await runner.tick();
    assert.equal(mock.sent.length, sentAfterFirst);
  });

  test('shows "typing…" while it works on a request and clears it once the answer is out', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('search paper planes');
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
    typedOnPhone('search paper planes');
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
    typedOnPhone('search paper planes');
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

    typedOnPhone('search paper planes');
    typedOnPhone('search paper planes');
    await runner.tick();
    assert.equal(mock.typing.filter((call) => call.typing).length, 1, 'one request, one "typing…"');
  });

  test('does not answer again when a copy of the request bounces back a moment later', async () => {
    const { runner, logs } = makeRunner();
    await runner.prime();
    typedOnPhone('search paper planes');
    typedOnPhone('search Paper  planes '); // the echo: same words, different case and spacing
    await runner.tick();
    assert.equal(mock.sent.length, 2, 'one caption and one audio file, not two of each');
    assert.ok(logs.some((line) => line.includes('ignoring a repeat')));
  });

  test('answers the same request again once the repeat window has passed', async () => {
    let clock = 1_000_000;
    const { runner } = makeRunner({ now: () => clock });
    await runner.prime();
    typedOnPhone('search paper planes');
    await runner.tick();
    assert.equal(mock.sent.length, 2);
    clock += 21_000;
    typedOnPhone('search paper planes');
    await runner.tick();
    assert.equal(mock.sent.length, 4);
  });

  test('a different request right after the first is answered as usual', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('search paper planes');
    typedOnPhone('search night owls');
    await runner.tick();
    assert.equal(mock.sent.length, 6, 'the name and audio for the first, then the list for the second (heading, two options, how to pick)');
  });

  test('offers a choice, one message per option and no numbers, and a 👍 on one is the answer', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('search night owls');
    await runner.tick();
    assert.deepEqual(mock.sent.map((s) => s.content.body), [
      '🎵 Which one?',
      '🎵 The Night Owls — Blue Horizon',
      '🎵 The Night Owls — Blue Horizon (Live)',
      '🎵 Tap 👍 on one to choose.',
    ]);

    mock.addReaction(mock.ghost, mock.sent[2]!.eventId!, '👍');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon (Live).mp3');
  });

  test('"all" sends every song on the list, files only, and the list stays open', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('search night owls');
    await runner.tick();
    const before = mock.sent.length;
    typedOnPhone('All');
    await runner.tick();
    assert.deepEqual(
      mock.sent.slice(before).map((s) => s.content.body),
      ['🎵 Here come all 2 songs:', 'The Night Owls — Blue Horizon.mp3', 'The Night Owls — Blue Horizon (Live).mp3'],
    );
    mock.addReaction(mock.ghost, mock.sent[1]!.eventId!, '👍');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon.mp3', 'a 👍 still picks from it');
  });

  test('"all" with no list open says how to use it', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('all');
    await runner.tick();
    assert.match(mock.sent.at(-1)?.content.body, /^🎵 Text "search" and a song first; then "all" sends every song on the list\.$/);
  });

  test('songs download a few at a time, and one that fails does not stop the rest', async () => {
    const urls = catalog.all().map((track) => track.url);
    let inFlight = 0;
    let most = 0;
    const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
    const runner = createRunner({
      chat: matrix,
      bot: { handle: async () => [...urls, ...urls].map((url, i) => ({ kind: 'audio' as const, url: i === 1 ? `${url}?broken` : url, title: `Song ${i + 1}` })) },
      chatID: mock.roomId,
      fetchAudio: async (url, title) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        if (url.endsWith('?broken')) throw new AudioFetchError('the file server answered HTTP 500');
        return fetchAudio(url, title);
      },
      pollMs: 20,
    });
    await runner.prime();
    typedOnPhone('everything please');
    await runner.tick();
    assert.ok(most <= 3, `${most} downloads at once`);
    assert.equal(mock.sent.filter((s) => s.content.msgtype === 'm.audio').length, 5, 'the five that worked');
    assert.ok(mock.sent.some((s) => s.content.body === '🎵 I couldn\'t send "Song 2": the file server answered HTTP 500.'));
  });

  test('a 👍 on another option picks again, since the list is still on screen', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('search night owls');
    await runner.tick();
    const [, first, second] = mock.sent.map((s) => s.eventId!);
    mock.addReaction(mock.ghost, second!, '👍');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon (Live).mp3');
    mock.addReaction(mock.ghost, first!, '👍');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon.mp3');
  });

  test('a new search ends the list, so a later number is no longer an answer', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('search night owls');
    await runner.tick();
    typedOnPhone('search paper planes');
    await runner.tick();
    const before = mock.sent.length;
    typedOnPhone('1');
    await runner.tick();
    assert.equal(mock.sent.length, before + 1);
    assert.equal(mock.sent.at(-1)?.content.body, `🎵 ${HELP_TEXT}`);
  });

  test('a number picks nothing where a 👍 does: it says how to pick, and the list stays open', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    typedOnPhone('search night owls');
    await runner.tick();
    typedOnPhone('2');
    await runner.tick();
    assert.equal(mock.sent.at(-1)?.content.body, '🎵 To get a song from the list, tap 👍 on it.');
    assert.equal(mock.sent.filter((s) => s.content.msgtype === 'm.audio').length, 0);
    typedOnPhone('all');
    await runner.tick();
    assert.equal(mock.sent.filter((s) => s.content.msgtype === 'm.audio').length, 2, '"all" still has the list');
  });

  test('a list stops answering "all" after half an hour', async () => {
    let clock = 1_000_000;
    const { runner } = makeRunner({ now: () => clock });
    await runner.prime();
    typedOnPhone('search night owls');
    await runner.tick();
    clock += 31 * 60_000;
    typedOnPhone('all');
    await runner.tick();
    assert.match(mock.sent.at(-1)?.content.body, /^🎵 Text "search" and a song first; then "all"/);
  });

  describe('pictures and messages the bot starts itself', () => {
    const picture = (url: string) => ({
      data: new Blob([Buffer.from('jpeg')], { type: 'image/jpeg' }),
      fileName: 'cover.jpg',
      mimeType: 'image/jpeg',
      bytes: 4,
      sourceUrl: url,
    });

    function runnerWith(bot: { handle: () => Promise<Reply[]> }, prepareImage: (picture: Picture) => Promise<PreparedPicture>, now?: () => number) {
      const logs: string[] = [];
      const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
      const runner = createRunner({
        chat: matrix,
        bot,
        chatID: mock.roomId,
        fetchAudio: (url, title) => fetchAudio(url, title),
        prepareImage,
        pollMs: 20,
        log: (line) => logs.push(line),
        ...(now ? { now } : {}),
      });
      return { runner, logs };
    }

    const card: Reply = { kind: 'image', url: 'https://img.test/a.jpg', caption: { title: 'Ana Elech', artist: 'Oizer Oberlander' } };

    test("a song's card goes out as one picture, with its name drawn on it", async () => {
      const { runner } = runnerWith({ handle: async () => [card, { kind: 'text', text: 'after it' }] }, async (p) => ({ image: picture(p.kind === 'image' ? p.url : ''), captioned: true }));
      await runner.prime();
      typedOnPhone('search ana elech');
      await runner.tick();
      assert.deepEqual(mock.sent.map((s) => s.content.msgtype), ['m.image', 'm.text']);
      assert.equal(mock.uploads[0]?.contentType, 'image/jpeg');
    });

    test("where the name couldn't be drawn on, it follows the picture as text; with no picture at all, the name still goes", async () => {
      const plain = runnerWith({ handle: async () => [card] }, async (p) => ({ image: picture(p.kind === 'image' ? p.url : ''), captioned: false }));
      await plain.runner.prime();
      typedOnPhone('search ana elech');
      await plain.runner.tick();
      assert.deepEqual(mock.sent.map((s) => [s.content.msgtype, s.content.body]), [
        ['m.image', 'cover.jpg'],
        ['m.text', '🎵 Oizer Oberlander — Ana Elech'],
      ]);

      mock.reset();
      const broken = runnerWith({ handle: async () => [card] }, async () => {
        throw new Error('the picture server answered HTTP 404');
      });
      await broken.runner.prime();
      typedOnPhone('search ana elech again');
      await broken.runner.tick();
      assert.deepEqual(mock.sent.map((s) => s.content.body), ['🎵 Oizer Oberlander — Ana Elech']);
      assert.ok(broken.logs.some((line) => /could not send a picture: the picture server answered HTTP 404/.test(line)));
    });

    test('a song starts downloading while its picture is still being made', async () => {
      const live = catalog.search('blue horizon live')[0]!;
      const order: string[] = [];
      const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
      const runner = createRunner({
        chat: matrix,
        bot: { handle: async () => [card, { kind: 'audio', url: live.url, title: 'The Night Owls — Blue Horizon (Live)' }] },
        chatID: mock.roomId,
        fetchAudio: async (url, title) => {
          order.push('download started');
          return fetchAudio(url, title);
        },
        prepareImage: async (p) => {
          order.push('picture started');
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push('picture done');
          return { image: picture(p.kind === 'image' ? p.url : ''), captioned: true };
        },
        pollMs: 20,
      });
      await runner.prime();
      typedOnPhone('search blue horizon live');
      await runner.tick();
      assert.deepEqual(order.slice(0, 2), ['download started', 'picture started'], 'the download did not wait for the picture');
      assert.deepEqual(mock.sent.map((s) => s.content.msgtype), ['m.image', 'm.audio']);
    });

    test('announce sends a message nobody asked for, and its list works for as long as it says', async () => {
      let clock = 1_000_000;
      const live = catalog.search('blue horizon live')[0]!;
      const { runner } = runnerWith(
        {
          handle: async () => [
            { kind: 'text', text: '🎵 Blue Horizon (Live)' },
            { kind: 'audio', url: live.url, title: 'The Night Owls — Blue Horizon (Live)' },
          ],
        },
        async () => ({ image: picture('https://img.test/x.jpg'), captioned: true }),
        () => clock,
      );
      await runner.prime();
      await runner.announce([
        { kind: 'text', text: 'New music today' },
        { kind: 'text', text: 'The Night Owls — Blue Horizon (Live)', postback: `play:${live.id}` },
        { kind: 'text', text: 'Tap 👍 on it to get it.', chips: [{ label: '1', postback: `play:${live.id}` }], chipsValidMs: 24 * 60 * 60_000 },
      ]);
      assert.deepEqual(mock.sent.map((s) => s.content.body), [
        '🎵 New music today',
        '🎵 The Night Owls — Blue Horizon (Live)',
        '🎵 Tap 👍 on it to get it.',
      ], 'no word about numbers');
      clock += 5 * 60 * 60_000; // five hours later
      typedOnPhone('all');
      await runner.tick();
      assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon (Live).mp3');
    });

    test('a list sent by another process (or before a restart) still answers "all", through the shared store', async () => {
      const live = catalog.search('blue horizon live')[0]!;
      let kept: PendingChoices | undefined;
      const store = { load: () => kept, save: (choices: PendingChoices | undefined) => void (kept = choices) };
      const matrix = new MatrixClient({ token: mock.token, homeserver: mock.url });
      const sender = createRunner({ chat: matrix, bot: { handle: async () => [] }, chatID: mock.roomId, fetchAudio: (url, title) => fetchAudio(url, title), choices: store });
      await sender.announce([{ kind: 'text', text: 'Tap 👍 on it to get it.', chips: [{ label: '1', postback: `play:${live.id}` }], chipsValidMs: 60 * 60_000 }]);
      assert.equal(kept?.chips[0]?.postback, `play:${live.id}`);

      const bot = createBot({ catalog, checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }) });
      const answerer = createRunner({ chat: new MatrixClient({ token: mock.token, homeserver: mock.url }), bot, chatID: mock.roomId, fetchAudio: (url, title) => fetchAudio(url, title), choices: store });
      await answerer.prime();
      typedOnPhone('all');
      await answerer.tick();
      assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon (Live).mp3');
      typedOnPhone('search paper planes');
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
        { kind: 'text', text: 'The Night Owls — Blue Horizon (Live)', postback: `play:${live.id}` },
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

    test("a 👍 on the phone's own copy of a song's message (another id, after a slow send) still sends that song", async () => {
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
        { kind: 'text', text: 'The Night Owls — Blue Horizon (Live)', postback: `play:${live.id}` },
      ]);
      const [heading, item] = mock.sent;
      // The bridge called the send undelivered, so the phone's copy of each message shows up as new events.
      const headingCopy = mock.addMessage(mock.ghost, { msgtype: 'm.text', body: heading!.content.body });
      const itemCopy = mock.addMessage(mock.ghost, { msgtype: 'm.text', body: item!.content.body });
      await runner.tick();
      mock.addReaction(mock.ghost, headingCopy, '👍');
      await runner.tick();
      assert.equal(mock.sent.length, 2, 'a copy of the heading is still not a song');
      assert.ok(logs.includes('ignoring a 👍 on a message that does not stand for a song'));
      mock.addReaction(mock.ghost, itemCopy, '👍');
      await runner.tick();
      assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon (Live).mp3');
      assert.ok(logs.includes(`<- 👍 play:${live.id}`));
      mock.addReaction(mock.ghost, '$gone:localhost', '👍');
      await runner.tick();
      assert.ok(logs.some((line) => line.startsWith('could not read the message a 👍 is on')), 'an unreadable message is logged, not fatal');
    });

    test('songs picked one after another (three 👍 in a row) go out songGapMs apart, each with its name', async () => {
      const songs = ['blue horizon', 'blue horizon live', 'paper planes'].map((words) => catalog.search(words)[0]!);
      const bot = createBot({ catalog, checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }) });
      let clock = 1_000_000;
      const waits: Array<{ ms: number; afterSends: number }> = [];
      const runner = createRunner({
        chat: new MatrixClient({ token: mock.token, homeserver: mock.url }),
        bot,
        chatID: mock.roomId,
        fetchAudio: (url, title) => fetchAudio(url, title),
        songGapMs: 15_000,
        now: () => clock,
        sleep: async (ms) => {
          waits.push({ ms, afterSends: mock.sent.length });
          clock += ms;
        },
      });
      await runner.prime();
      await runner.announce(songs.map((track, i): Reply => ({ kind: 'text', text: `${i + 1}. ${track.title}`, postback: `play:${track.id}` })));
      const items = mock.sent.map((s) => s.eventId!);
      for (const item of items) mock.addReaction(mock.ghost, item, '👍');
      await runner.tick();
      assert.deepEqual(
        mock.sent.slice(items.length).map((s) => (s.content.msgtype === 'm.audio' ? s.content.filename : s.content.body)),
        [
          '🎵 The Night Owls — Blue Horizon',
          'The Night Owls — Blue Horizon.mp3',
          '🎵 The Night Owls — Blue Horizon (Live)',
          'The Night Owls — Blue Horizon (Live).mp3',
          '🎵 Mira Vale — Paper Planes at Dawn',
          'Mira Vale — Paper Planes at Dawn.mp3',
        ],
      );
      // The first song goes at once; the others wait their turn, each with its name held back until then.
      assert.deepEqual(waits, [
        { ms: 15_000, afterSends: items.length + 2 },
        { ms: 15_000, afterSends: items.length + 4 },
      ]);
      // A song asked for once the last one had its time goes at once.
      clock += 15_000;
      mock.addReaction(mock.ghost, items[0]!, '👍');
      await runner.tick();
      assert.equal(waits.length, 2);
      assert.equal(mock.sent.at(-1)?.content.filename, 'The Night Owls — Blue Horizon.mp3');
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
        async () => ({ image: picture('https://img.test/x.jpg'), captioned: true }),
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
    typedOnPhone('search paper planes');
    await runner.tick();
    assert.ok(logs.some((line) => line.includes('poll failed')));
    assert.deepEqual(mock.sent, []);

    mock.failSync = false;
    await runner.tick();
    assert.equal(mock.sent.length, 2);
  });
});
