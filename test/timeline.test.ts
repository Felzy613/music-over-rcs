import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RecentLines, seconds, timed, Timeline } from '../src/timeline.ts';

describe('a request’s timeline', () => {
  test('seconds: two places under a second, one above', () => {
    assert.equal(seconds(210), '0.21s');
    assert.equal(seconds(7600), '7.6s');
    assert.equal(seconds(-5), '0.00s', 'a clock a little behind is not a negative time');
  });

  test('one line: phone to bot, the bot’s own steps, each message sent, and when Google had the last one', () => {
    let clock = 10_000;
    const timeline = new Timeline('search achas', { phoneAt: 2_400, now: () => clock });
    timeline.span('zemer', 210);
    clock += 1000;
    timeline.mark('bot');
    for (let i = 0; i < 12; i += 1) {
      clock += 300;
      timeline.sent(300, `$e${i}`);
    }
    assert.equal(timeline.waiting, 12);
    for (let i = 0; i < 12; i += 1) timeline.reached(`$e${i}`, 10_000 + 1_100 + i * 360);
    timeline.reached('$not-ours', 99_999);
    assert.equal(timeline.waiting, 0);
    assert.equal(
      timeline.line(true),
      'timeline: "search achas" phone→seen 7.6s · bot 1.0s (zemer 0.21s) · 12 msgs first +1.3s last +4.6s (0.30s each) · at Google +5.1s',
    );
    assert.equal(timeline.line(), 'timeline: "search achas" phone→seen 7.6s · bot 1.0s (zemer 0.21s) · 12 msgs first +1.3s last +4.6s (0.30s each)', 'without Google’s word asked for');
  });

  test('a step taken twice adds up; other moments are listed; a message Google never confirmed is counted', () => {
    let clock = 0;
    const timeline = new Timeline('👍 album:x', { now: () => clock });
    timeline.span('album', 300);
    timeline.span('album', 200);
    clock = 2700;
    timeline.mark('bot');
    clock = 70_000;
    timeline.mark('zip');
    timeline.sent(22_000, '$zip');
    timeline.sent(10, '$text');
    timeline.reached('$text', 70_100);
    assert.equal(timeline.line(true), 'timeline: "👍 album:x" · bot 2.7s (album 0.50s ×2) · zip +70.0s · 2 msgs first +70.0s last +70.0s (11.0s each) · at Google +70.1s (1 of 2)');
  });

  test('remembers only the newest lines', () => {
    const lines = new RecentLines(2);
    lines.add('a');
    lines.add('b');
    lines.add('c');
    assert.deepEqual(
      lines.list().map((line) => line.split(' ').slice(1).join(' ')),
      ['b', 'c'],
    );
  });

  test('timed reports how long the work took, and passes on what it gave or threw', async () => {
    const heard: Array<[string, number]> = [];
    assert.equal(await timed((step, ms) => heard.push([step, ms]), 'zemer', Promise.resolve(42)), 42);
    await assert.rejects(timed((step, ms) => heard.push([step, ms]), 'album', Promise.reject(new Error('down'))), /down/);
    assert.deepEqual(
      heard.map(([step]) => step),
      ['zemer', 'album'],
    );
    assert.equal(await timed(undefined, 'x', Promise.resolve('no trace')), 'no trace');
  });
});
