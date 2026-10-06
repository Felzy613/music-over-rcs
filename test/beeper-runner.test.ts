import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { checkAudio } from '../src/audio-check.ts';
import { fetchAudio } from '../src/audio-fetch.ts';
import { BeeperClient } from '../src/beeper/client.ts';
import { createBot, HELP_TEXT } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { createRunner, type RunnerOptions } from '../src/runner.ts';
import { startMockBeeper, type MockBeeper } from './helpers/mock-beeper.ts';
import { startMusicHost, type MusicHost } from './helpers/music-host.ts';

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('runner over Beeper', () => {
  let beeper: MockBeeper;
  let music: MusicHost;
  let catalog: Catalog;
  let client: BeeperClient;

  before(async () => {
    beeper = await startMockBeeper();
    music = await startMusicHost();
    client = new BeeperClient({ token: beeper.token, baseUrl: beeper.url });
    catalog = new Catalog(':memory:');
    catalog.add({ title: 'Blue Horizon', artist: 'The Night Owls', url: `${music.url}/blue.mp3` });
    catalog.add({ title: 'Blue Horizon (Live)', artist: 'The Night Owls', url: `${music.url}/blue-live.mp3` });
    catalog.add({ title: 'Paper Planes at Dawn', artist: 'Mira Vale', url: `${music.url}/planes.mp3` });
    catalog.add({ title: 'Broken Link', artist: 'Nobody', url: `${music.url}/page.html` });
    catalog.add({ title: 'Flaky File', artist: 'Nobody', url: `${music.url}/flaky.mp3` });
  });

  after(async () => {
    await beeper.close();
    await music.close();
  });

  beforeEach(() => beeper.reset());

  function makeRunner(extra: Partial<RunnerOptions> = {}) {
    const logs: string[] = [];
    const bot = createBot({
      catalog,
      checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }),
    });
    const runner = createRunner({
      chat: client,
      bot,
      chatID: beeper.chatID,
      fetchAudio: (url, title) => fetchAudio(url, title),
      pollMs: 20,
      log: (line) => logs.push(line),
      ...extra,
    });
    return { runner, logs };
  }

  test('never replays history that was in the chat before it started', async () => {
    beeper.addUserMessage('paper planes');
    const { runner } = makeRunner();
    await runner.prime();
    await runner.tick();
    assert.deepEqual(beeper.sent, []);
  });

  test('answers a request with a caption and the audio file as an attachment', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    beeper.addUserMessage('paper planes');
    await runner.tick();

    assert.equal(beeper.sent.length, 2);
    assert.equal(beeper.sent[0]?.text, '🎵 Mira Vale — Paper Planes at Dawn');
    const attachment = beeper.sent[1]?.attachment;
    assert.equal(attachment?.type, 'audio');
    assert.equal(attachment?.fileName, 'Mira Vale — Paper Planes at Dawn.mp3');
    assert.equal(attachment?.mimeType, 'audio/mpeg');
    assert.equal(beeper.uploads.length, 1);
    assert.equal(beeper.uploads[0]?.uploadID, attachment?.uploadID);
    assert.deepEqual(beeper.uploads[0]?.bytes, music.bytes('/planes.mp3'));
  });

  test('does not answer its own messages, however many times it polls', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    beeper.addUserMessage('paper planes');
    await runner.tick();
    const sentAfterFirst = beeper.sent.length;
    for (let i = 0; i < 4; i++) await runner.tick();
    assert.equal(beeper.sent.length, sentAfterFirst);
  });

  test('offers a numbered choice and takes the number as the answer', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    beeper.addUserMessage('night owls');
    await runner.tick();

    assert.equal(beeper.sent.length, 1);
    assert.equal(
      beeper.sent[0]?.text,
      '🎵 Which one?\n1. The Night Owls — Blue Horizon\n2. The Night Owls — Blue Horizon (Live)\n\nReply with a number to choose.',
    );

    beeper.addUserMessage('2');
    await runner.tick();
    assert.equal(beeper.sent.at(-1)?.attachment?.fileName, 'The Night Owls — Blue Horizon (Live).mp3');
  });

  test('a number with no choice pending is not a song, so it gets the help text', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    beeper.addUserMessage('2');
    await runner.tick();
    assert.deepEqual(beeper.sent, [{ text: `🎵 ${HELP_TEXT}` }]);
  });

  test('ignores attachments, its own marker and blank messages', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    beeper.addRaw({ type: 'AUDIO', attachments: [{ id: 'x' }] });
    beeper.addRaw({ type: 'TEXT', text: '🎵 something the bot said earlier' });
    beeper.addUserMessage('   ');
    await runner.tick();
    assert.deepEqual(beeper.sent, []);
  });

  test('explains a catalog link that is a web page, and sends nothing else', async () => {
    const { runner } = makeRunner();
    await runner.prime();
    beeper.addUserMessage('broken link');
    await runner.tick();
    assert.deepEqual(beeper.sent, [
      { text: `🎵 I can't send "Nobody — Broken Link": it isn't an audio file (the server says "text/html").` },
    ]);
    assert.equal(beeper.uploads.length, 0);
  });

  test('tells the user when the download fails after the link looked fine', async () => {
    const { runner, logs } = makeRunner();
    await runner.prime();
    beeper.addUserMessage('flaky file');
    await runner.tick();
    assert.deepEqual(beeper.sent, [
      { text: '🎵 Nobody — Flaky File' },
      { text: "🎵 I couldn't send that file: the file server answered HTTP 500." },
    ]);
    assert.equal(beeper.uploads.length, 0);
    assert.ok(logs.some((line) => line.includes('could not send audio')));
  });

  test('stops sending when the per-minute limit is hit, and resumes later', async () => {
    let clock = 1_000_000;
    const { runner, logs } = makeRunner({ maxSendsPerMinute: 2, now: () => clock });
    await runner.prime();

    beeper.addUserMessage('paper planes');
    await runner.tick();
    assert.equal(beeper.sent.length, 2);

    // A different request: an identical one this soon would be taken for an echo of the first and ignored.
    beeper.addUserMessage('paper planes at dawn');
    await runner.tick();
    assert.equal(beeper.sent.length, 2, 'the second answer is dropped');
    assert.ok(logs.some((line) => line.includes('send limit')));

    clock += 61_000;
    beeper.addUserMessage('blue horizon live');
    await runner.tick();
    assert.equal(beeper.sent.length, 4);
  });

  test('survives a failed poll and answers what arrived meanwhile', async () => {
    const { runner, logs } = makeRunner();
    await runner.prime();
    beeper.failListing = true;
    beeper.addUserMessage('paper planes');
    await runner.tick();
    assert.ok(logs.some((line) => line.includes('poll failed')));
    assert.deepEqual(beeper.sent, []);

    beeper.failListing = false;
    await runner.tick();
    assert.equal(beeper.sent.length, 2);
  });

  test('polls on its own after start() and stops cleanly', async () => {
    const { runner } = makeRunner();
    await runner.start();
    beeper.addUserMessage('paper planes');
    await waitFor(() => beeper.sent.length >= 2);

    await runner.stop();
    const requestsAtStop = beeper.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(beeper.requests.length, requestsAtStop);
  });

  test('start() fails loudly when Beeper Desktop is not running', async () => {
    const unreachable = new BeeperClient({ token: 'x', baseUrl: 'http://127.0.0.1:9' });
    const { runner } = makeRunner({ chat: unreachable });
    await assert.rejects(runner.start());
  });
});
