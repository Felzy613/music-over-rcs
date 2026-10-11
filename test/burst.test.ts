import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { DownloadedAudio } from '../src/audio-fetch.ts';
import type { PreparedPicture } from '../src/library/images.ts';
import { createRunner, type ChatClient, type ChatMessage, type MessageLinks } from '../src/runner.ts';
import type { Reply } from '../src/types.ts';

/** Several 👍 read together are answered together: their downloads and covers run ahead, in one line. */
describe('a burst of 👍', () => {
  const song = (n: number): DownloadedAudio => ({ data: new Blob(['x']), fileName: `song ${n}.mp3`, mimeType: 'audio/mpeg', bytes: 1 });
  const like = (to: string, id = `reaction-${to}`): ChatMessage => ({
    id,
    timestamp: '',
    hasAttachments: false,
    isDeleted: false,
    reaction: { to, key: '👍' },
  });

  /** A chat with songs 1 to `count` on offer (message "m<n>" stands for song n), a bot that answers each with a card and a song. */
  function setup(count: number, options: { failing?: number[]; downloadMs?: number } = {}) {
    const events: string[] = [];
    const incoming: ChatMessage[] = [];
    const typing: boolean[] = [];
    const texts: string[] = [];
    let downloading = 0;
    let mostAtOnce = 0;
    const known = new Map<string, string>(Array.from({ length: count }, (_, i) => [`m${i + 1}`, `play:${i + 1}`]));
    const links: MessageLinks = { link: (id, postback) => void known.set(id, postback), lookup: (id) => known.get(id) };
    let clock = 0;
    const chat: ChatClient = {
      reactions: true,
      listMessages: async () => incoming.splice(0),
      sendText: async (_room, text) => void (texts.push(text), events.push(`text:${text}`)),
      sendAudio: async (_room, audio) => void events.push(`audio:${audio.fileName}`),
      sendImage: async (_room, image) => void events.push(`image:${image.fileName}`),
      setTyping: async (_room, on) => void typing.push(on),
    };
    const runner = createRunner({
      chat,
      bot: {
        handle: async (msg) => {
          if (msg.postback === undefined) return [{ kind: 'text', text: `answer to ${msg.text}` }];
          const n = Number(/^play:(\d+)$/.exec(msg.postback ?? '')?.[1]);
          if (options.failing?.includes(n)) throw new Error(`song ${n} broke`);
          return [
            { kind: 'image', url: `https://img.test/${n}.jpg`, caption: { title: `Song ${n}`, artist: 'Artist' }, postback: `play:${n}` },
            { kind: 'audio', url: `https://music.test/${n}.mp3`, title: `Song ${n}` },
          ];
        },
      },
      chatID: 'room',
      links,
      songGapMs: 5_000,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      typingRefreshMs: 1_000_000,
      fetchAudio: async (url) => {
        const n = Number(/(\d+)\.mp3$/.exec(url)?.[1]);
        events.push(`download:${n}`);
        downloading += 1;
        mostAtOnce = Math.max(mostAtOnce, downloading);
        await new Promise((resolve) => setTimeout(resolve, options.downloadMs ?? 5));
        downloading -= 1;
        return song(n);
      },
      prepareImage: async (picture): Promise<PreparedPicture> => {
        const n = Number(/(\d+)\.jpg$/.exec(picture.kind === 'image' ? picture.url : '')?.[1]);
        events.push(`draw:${n}`);
        return { image: { data: new Blob(['x']), fileName: `card ${n}.jpg`, mimeType: 'image/jpeg', bytes: 1, sourceUrl: '' }, captioned: true };
      },
      log: () => {},
    });
    return { runner, events, incoming, typing, texts, mostAtOnce: () => mostAtOnce };
  }

  test('five songs picked together are downloaded three at a time, ahead of their turns', async () => {
    const { runner, events, incoming, mostAtOnce } = setup(5);
    await runner.prime();
    incoming.push(...[1, 2, 3, 4, 5].map((n) => like(`m${n}`)));
    await runner.tick();
    assert.equal(mostAtOnce(), 3, 'three downloads run at once, as many as are allowed ahead');
    // All three started before the first song went out.
    assert.deepEqual(events.slice(0, 3).sort(), ['download:1', 'download:2', 'download:3']);
    assert.ok(events.indexOf('download:3') < events.indexOf('audio:song 1.mp3'));
    // The songs still go in the order they were picked, each after its own cover.
    const sent = events.filter((e) => e.startsWith('audio:') || e.startsWith('image:'));
    assert.deepEqual(
      sent,
      [1, 2, 3, 4, 5].flatMap((n) => [`image:card ${n}.jpg`, `audio:song ${n}.mp3`]),
    );
  });

  test('the next covers are drawn while the song before waits its turn, two ahead', async () => {
    const { runner, events, incoming } = setup(4);
    await runner.prime();
    incoming.push(...[1, 2, 3, 4].map((n) => like(`m${n}`)));
    await runner.tick();
    const at = (event: string) => events.indexOf(event);
    assert.ok(at('draw:2') < at('image:card 1.jpg'), 'the second cover is drawn before the first is even sent');
    assert.ok(at('draw:3') > at('image:card 1.jpg'), 'but not further than two ahead');
    assert.ok(at('draw:3') < at('audio:song 2.mp3'));
  });

  test('one typing indicator covers the whole burst', async () => {
    const { runner, incoming, typing } = setup(5);
    await runner.prime();
    incoming.push(...[1, 2, 3, 4, 5].map((n) => like(`m${n}`)));
    await runner.tick();
    assert.deepEqual(typing, [true, false]);
  });

  test('a 👍 on something that is not a song is skipped, the rest are answered, and a request in between comes after them', async () => {
    const { runner, events, incoming } = setup(3);
    await runner.prime();
    incoming.push(like('m1'), like('a heading'), like('m2'), { id: 'typed', timestamp: '', text: 'help', hasAttachments: false, isDeleted: false });
    await runner.tick();
    assert.deepEqual(
      events.filter((e) => e.startsWith('audio:') || e.startsWith('text:')),
      ['audio:song 1.mp3', 'audio:song 2.mp3', 'text:🎵 answer to help'],
    );
  });

  test('several songs that fail get one apology, and the others still go', async () => {
    const { runner, events, incoming, texts } = setup(4, { failing: [2, 3] });
    await runner.prime();
    incoming.push(...[1, 2, 3, 4].map((n) => like(`m${n}`)));
    await runner.tick();
    assert.deepEqual(
      events.filter((e) => e.startsWith('audio:')),
      ['audio:song 1.mp3', 'audio:song 4.mp3'],
    );
    assert.equal(texts.filter((text) => /went wrong/.test(text)).length, 1);
  });

  test('a single 👍 still goes at once, with no wait', async () => {
    const { runner, events, incoming } = setup(2);
    await runner.prime();
    incoming.push(like('m2'));
    await runner.tick();
    assert.deepEqual(
      events.filter((e) => e.startsWith('audio:') || e.startsWith('image:')),
      ['image:card 2.jpg', 'audio:song 2.mp3'],
    );
  });

  test('replies handed to announce are covers-ahead too, and its picture failing still sends the name', async () => {
    const { runner, events } = setup(1);
    const replies: Reply[] = [{ kind: 'image', url: 'https://img.test/9.jpg', caption: { title: 'Nine', artist: '' }, postback: 'play:9' }];
    await runner.announce(replies);
    assert.deepEqual(events, ['draw:9', 'image:card 9.jpg']);
  });
});
