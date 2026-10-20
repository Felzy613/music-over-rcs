import assert from 'node:assert/strict';
import { describe, test, type TestContext } from 'node:test';
import { AudioFetchError, type DownloadedAudio } from '../src/audio-fetch.ts';
import { createRunner, type ChatClient, type ChatMessage, type ResumePoint } from '../src/runner.ts';

/** A request made while a song or album is on its way is answered then, not after it. */
describe('requests that overlap a song being sent', () => {
  const song = (n: number): DownloadedAudio => ({ data: new Blob(['x']), fileName: `song ${n}.mp3`, mimeType: 'audio/mpeg', bytes: 1 });
  const typed = (id: string, text: string): ChatMessage => ({ id, timestamp: '', text, hasAttachments: false, isDeleted: false });

  /** Resolves once `ready` holds (polling), or fails the test after two seconds. */
  async function until(ready: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!ready()) {
      if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }

  /**
   * A chat where "song N" is answered with song N, whose download waits until `release(N)`, and any other text with
   * a line of text. A song N in `unreachable` can't be downloaded.
   */
  function setup(t: TestContext, options: { unreachable?: number[]; failApologies?: boolean } = {}) {
    const events: string[] = [];
    const incoming: ChatMessage[] = [];
    const typing: boolean[] = [];
    const polls: { ok: boolean; failures: number }[] = [];
    const saved: ResumePoint[] = [];
    const gates = new Map<number, () => void>();
    const waiting = new Map<number, Promise<void>>();
    const gate = (n: number): Promise<void> => {
      let open!: () => void;
      const closed = new Promise<void>((resolve) => (open = resolve));
      gates.set(n, open);
      waiting.set(n, closed);
      return closed;
    };
    const chat: ChatClient = {
      reactions: true,
      listMessages: async () => incoming.splice(0),
      sendText: async (_room, text) => {
        if (options.failApologies && /couldn't send/.test(text)) throw new Error('the chat is not taking texts');
        events.push(`text:${text}`);
      },
      sendAudio: async (_room, audio) => void events.push(`audio:${audio.fileName}`),
      setTyping: async (_room, on) => void typing.push(on),
    };
    let resume: ResumePoint | undefined;
    const runner = createRunner({
      chat,
      bot: {
        handle: async (msg) => {
          const n = Number(/^song (\d+)$/.exec(msg.text ?? '')?.[1]);
          return n ? [{ kind: 'audio', url: `https://music.test/${n}.mp3`, title: `Song ${n}` }] : [{ kind: 'text', text: `answer to ${msg.text}` }];
        },
      },
      chatID: 'room',
      pollMs: 3,
      typingRefreshMs: 1_000_000,
      resume: { load: () => resume, save: (point) => void (saved.push(point), (resume = point)) },
      onPoll: (ok, failures) => void polls.push({ ok, failures }),
      fetchAudio: async (url) => {
        const n = Number(/(\d+)\.mp3$/.exec(url)?.[1]);
        events.push(`download:${n}`);
        await gate(n);
        if (options.unreachable?.includes(n)) throw new AudioFetchError('not reachable');
        return song(n);
      },
      log: () => {},
    });
    const release = (n: number): void => gates.get(n)?.();
    // Whatever a test leaves waiting is let go and the runner stopped, so a failing test ends instead of hanging.
    t.after(async () => {
      for (const open of gates.values()) open();
      await runner.stop();
    });
    return { runner, events, incoming, typing, polls, saved, release };
  }

  test('a text asked for while a song downloads is answered at once, before the song', async (t) => {
    const { runner, events, incoming, release } = setup(t);
    await runner.start();
    incoming.push(typed('a', 'song 1'));
    await until(() => events.includes('download:1'), 'the song to start downloading');
    incoming.push(typed('b', 'help'));
    await until(() => events.includes('text:🎵 answer to help'), 'the second request to be answered');
    assert.ok(!events.includes('audio:song 1.mp3'), 'the song is still on its way');
    release(1);
    await until(() => events.includes('audio:song 1.mp3'), 'the song to arrive');
    await runner.stop();
  });

  test('songs asked for one after the other go one at a time, in the order asked', async (t) => {
    const { runner, events, incoming, release } = setup(t);
    await runner.start();
    incoming.push(typed('a', 'song 1'));
    await until(() => events.includes('download:1'), 'the first download');
    incoming.push(typed('b', 'song 2'));
    await new Promise((resolve) => setTimeout(resolve, 40)); // plenty of polls to have read the second request
    assert.ok(!events.includes('download:2'), 'the second song waits for the first');
    release(1);
    await until(() => events.includes('download:2'), 'the second download to start');
    assert.ok(events.indexOf('audio:song 1.mp3') < events.indexOf('download:2'), 'and starts once the first has gone');
    release(2);
    await runner.stop();
    assert.deepEqual(
      events.filter((event) => event.startsWith('audio:')),
      ['audio:song 1.mp3', 'audio:song 2.mp3'],
    );
  });

  test('"typing…" stays up until the song is out, even after the other request is answered', async (t) => {
    const { runner, events, incoming, typing, release } = setup(t);
    await runner.start();
    incoming.push(typed('a', 'song 1'));
    await until(() => events.includes('download:1'), 'the song to start downloading');
    incoming.push(typed('b', 'help'));
    await until(() => events.includes('text:🎵 answer to help'), 'the second request to be answered');
    assert.deepEqual(typing, [true], 'one indicator, still up');
    release(1);
    await runner.stop();
    assert.deepEqual(typing, [true, false]);
  });

  test("where the bot got to is not saved while a song is still on its way, and is once it's out", async (t) => {
    const { runner, events, incoming, saved, release } = setup(t);
    await runner.start();
    const atStart = saved.length;
    incoming.push(typed('a', 'song 1'));
    await until(() => events.includes('download:1'), 'the song to start downloading');
    incoming.push(typed('b', 'help'));
    await until(() => events.includes('text:🎵 answer to help'), 'the second request to be answered');
    assert.equal(saved.length, atStart, 'a crash now would answer the song again');
    release(1);
    await runner.stop();
    assert.equal(saved.length, atStart + 1);
    assert.ok(saved.at(-1)!.ids.includes('a') && saved.at(-1)!.ids.includes('b'));
  });

  test('a song that cannot be sent does not stop the next one, and the failure is counted like a failed poll', async (t) => {
    const { runner, events, incoming, polls, release } = setup(t, { unreachable: [1], failApologies: true });
    await runner.start();
    incoming.push(typed('a', 'song 1'));
    await until(() => events.includes('download:1'), 'the first download');
    incoming.push(typed('b', 'song 2'));
    release(1);
    await until(() => polls.some((poll) => !poll.ok), 'the failure to be reported');
    await until(() => events.includes('download:2'), 'the next song to start');
    release(2);
    await until(() => events.includes('audio:song 2.mp3'), 'the next song to arrive');
    await runner.stop();
  });

  test('stopping waits for a song on its way', async (t) => {
    const { runner, events, incoming, release } = setup(t);
    await runner.start();
    incoming.push(typed('a', 'song 1'));
    await until(() => events.includes('download:1'), 'the song to start downloading');
    let stopped = false;
    const stopping = runner.stop().then(() => void (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false);
    release(1);
    await stopping;
    assert.ok(events.includes('audio:song 1.mp3'));
  });
});
