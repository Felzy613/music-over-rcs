import assert from 'node:assert/strict';
import { get as httpGet, request as httpRequest } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import type { Picture, PreparedPicture } from '../src/library/images.ts';
import { createSimulator, type Simulator } from '../src/simulator/server.ts';
import { Trace } from '../src/simulator/trace.ts';
import { MusicTable } from '../src/sources/music-table.ts';
import { startMockMusicTable, type MockMusicTable, type MockPost } from './helpers/mock-music-table.ts';

const POSTS: MockPost[] = [
  { slug: 'yoely-weiss-shabbos', title: 'Yoely Weiss - Shabbos', files: [{ name: 'Yoely Weiss - Shabbos.mp3' }] },
  { slug: 'yoely-weiss-purim-26', title: "Yoely Weiss - Purim '26", files: [{ name: "Yoely Weiss Purim '26.mp3" }] },
  { slug: 'benny-friedman-live', title: 'Benny Friedman - Live', files: [{ name: 'Benny Friedman - Live.mp3' }] },
];

/** Stands in for drawing pictures: a song's card keeps its cover's address; a collage lists its covers. */
const stubPictures = async (picture: Picture): Promise<PreparedPicture> => ({
  image: {
    data: new Blob([]),
    fileName: 'cover.jpg',
    mimeType: 'image/jpeg',
    bytes: 0,
    sourceUrl: picture.kind === 'collage' ? `collage:${picture.images.map((tile) => tile.number).join(',')}` : picture.url,
  },
  captioned: true,
});

interface Frame {
  event: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

interface EventStream {
  frames: Frame[];
  waitFor(predicate: (frame: Frame) => boolean, ms?: number): Promise<Frame>;
  close(): void;
}

/** Listens to the page's live feed the way the browser does. */
function openStream(base: string): Promise<EventStream> {
  return new Promise((resolve, reject) => {
    const frames: Frame[] = [];
    const listeners = new Set<() => void>();
    let buffer = '';
    const req = httpGet(`${base}/api/stream`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(raw)?.[1];
          const data = /^data: (.*)$/m.exec(raw)?.[1];
          if (event && data) frames.push({ event, data: JSON.parse(data) });
        }
        for (const listener of [...listeners]) listener();
      });
      resolve({
        frames,
        waitFor(predicate, ms = 5000) {
          return new Promise<Frame>((done, fail) => {
            const check = () => {
              const found = frames.find(predicate);
              if (!found) return;
              clearTimeout(timer);
              listeners.delete(check);
              done(found);
            };
            const timer = setTimeout(() => {
              listeners.delete(check);
              fail(new Error(`no matching event within ${ms} ms; saw ${frames.map((f) => f.event).join(', ')}`));
            }, ms);
            listeners.add(check);
            check();
          });
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

describe('message simulator', () => {
  let site: MockMusicTable;
  let simulator: Simulator;
  let base: string;
  let port: number;
  let trace: Trace;
  let catalog: Catalog;
  const streams: EventStream[] = [];

  before(async () => {
    site = await startMockMusicTable(POSTS);
  });

  after(async () => {
    await site.close();
  });

  beforeEach(async () => {
    site.reset();
    catalog = new Catalog(':memory:');
    trace = new Trace();
    const musicTable = new MusicTable({
      baseUrl: site.url,
      minIntervalMs: 0,
      trustedFileUrl: () => true,
      onEvent: (event) => trace.site(event),
    });
    simulator = createSimulator({ catalog, musicTable, trace, pollMs: 5, prepareImage: stubPictures });
    ({ url: base, port } = await simulator.listen(0));
  });

  async function finish() {
    for (const stream of streams.splice(0)) stream.close();
    await simulator.close();
    catalog.close();
  }

  const post = (path: string, body: unknown, headers: Record<string, string> = { 'x-simulator': '1' }) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const say = (text: string) => post('/api/send', { text });
  const stream = async () => {
    const opened = await openStream(base);
    streams.push(opened);
    return opened;
  };
  const labels = (frames: Frame[], runId?: number) =>
    frames
      .filter((f) => f.event === 'trace-item' && (runId === undefined || f.data.runId === runId))
      .map((f) => `${f.data.item.label}: ${f.data.item.detail}`);

  test('serves the page and starts empty', async () => {
    try {
      const page = await fetch(base);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/);
      const html = await page.text();
      assert.match(html, /Behind the scenes/);
      assert.match(html, /RCS message/);

      const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>;
      assert.deepEqual(state, {
        catalogTracks: 0,
        musicTable: true,
        full: false,
        maxMb: 100,
        typing: false,
        messages: [],
        runs: [],
      });
    } finally {
      await finish();
    }
  });

  test('refuses other hosts and requests that did not come from the page', async () => {
    try {
      const strangerHost = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `evil.example:${port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(strangerHost, 403, 'a page on another site must not reach the simulator through DNS rebinding');

      assert.equal((await post('/api/send', { text: 'hi' }, {})).status, 403, 'no header, no message');
      assert.equal((await post('/api/reset', {}, {})).status, 403);
      assert.equal((await post('/api/send', { text: 'x'.repeat(5000) })).status, 413);
      assert.equal((await say('')).status, 400);
      assert.equal((await say('y'.repeat(401))).status, 400);
      const garbage = await fetch(`${base}/api/send`, { method: 'POST', headers: { 'x-simulator': '1' }, body: '{nope' });
      assert.equal(garbage.status, 400);
      assert.equal((await fetch(`${base}/api/nowhere`)).status, 404);
      assert.equal(site.postReads.length, 0, 'nothing reached the site');
    } finally {
      await finish();
    }
  });

  test('a song name runs through the real bot and site and comes back as audio, with every step on record', async () => {
    try {
      const live = await stream();
      await live.waitFor((f) => f.event === 'snapshot');

      assert.equal((await say('yoely weiss shabbos')).status, 202);
      const ended = await live.waitFor((f) => f.event === 'trace-end');

      const events = live.frames.map((f) => f.event);
      assert.ok(events.indexOf('typing') < events.indexOf('trace-end'), 'typing starts before the answer');
      const typing = live.frames.filter((f) => f.event === 'typing').map((f) => f.data);
      assert.deepEqual(typing, [true, false]);

      const messages = live.frames.filter((f) => f.event === 'message').map((f) => f.data);
      assert.equal(messages[0].from, 'me');
      assert.equal(messages[0].text, 'yoely weiss shabbos');
      assert.equal(messages[1].from, 'bot');
      assert.match(messages[1].text, /Yoely Weiss .* Shabbos/);
      assert.equal(messages[2].from, 'bot');
      assert.match(messages[2].audio.name, /Shabbos\.mp3$/);
      assert.equal(messages[2].audio.mime, 'audio/mpeg');
      assert.equal(messages[2].audio.bytes, site.bytes('yoely-weiss-shabbos').length);
      assert.match(messages[2].audio.linkId, /^[0-9a-f]{8}$/);

      const steps = labels(live.frames, ended.data.id);
      assert.ok(steps.some((s) => s.startsWith('your catalog: ') && s.includes('no match')), steps.join('\n'));
      assert.ok(steps.some((s) => s.startsWith('site search: ')), steps.join('\n'));
      assert.ok(steps.some((s) => s.startsWith('read post: ')), steps.join('\n'));
      assert.ok(steps.some((s) => s.startsWith('check file: audio/mpeg')), steps.join('\n'));
      assert.ok(steps.some((s) => s.startsWith('file ready: ') && s.includes('not downloaded')), steps.join('\n'));
      assert.ok(steps.some((s) => s.startsWith('reply sent: ')), steps.join('\n'));

      assert.equal(ended.data.text, 'yoely weiss shabbos');
      assert.equal(ended.data.choice, false);
      assert.equal(typeof ended.data.firstReplyMs, 'number');
      assert.ok(ended.data.firstReplyMs <= ended.data.totalMs);
      assert.equal(catalog.count(), 1, 'what the site had is now saved, so the next ask is local');
    } finally {
      await finish();
    }
  });

  test('the site file is only checked, not downloaded, unless asked', async () => {
    try {
      const live = await stream();
      await say('benny friedman');
      await live.waitFor((f) => f.event === 'trace-end');
      assert.deepEqual(site.fileRequests, [], 'the file itself was never requested, only described');
      assert.equal(site.signed, 1, 'a link is signed to check the file, then reused');
    } finally {
      await finish();
    }
  });

  test('Play asks for a fresh signed link and the file behind it is the real one', async () => {
    try {
      const live = await stream();
      await say('yoely weiss shabbos');
      await live.waitFor((f) => f.event === 'trace-end');
      const audio = live.frames.map((f) => f.data).find((d) => d?.audio)?.audio;
      assert.ok(audio);

      const res = await fetch(`${base}/api/play/${audio.linkId}`);
      assert.equal(res.status, 200);
      const { url } = (await res.json()) as { url: string };
      assert.match(url, /\/files\/.*token=/);
      assert.equal(site.signed, 1, 'the link made while checking the file is still fresh, so it is reused');
      assert.deepEqual(site.fileRequests, [], 'nothing is downloaded until Play is pressed');
      const file = Buffer.from(await (await fetch(url)).arrayBuffer());
      assert.deepEqual(file, site.bytes('yoely-weiss-shabbos'));
      assert.equal(site.fileRequests.length, 1);

      assert.equal((await fetch(`${base}/api/play/not-a-real-id`)).status, 404);
    } finally {
      await finish();
    }
  });

  test('a misspelled name still finds the song, and the trace says how', async () => {
    try {
      const live = await stream();
      await say('yoely wiess shabbos');
      const ended = await live.waitFor((f) => f.event === 'trace-end');
      const steps = labels(live.frames, ended.data.id).join('\n');
      assert.match(steps, /lookup: .*left out/);
      const reply = live.frames.map((f) => f.data).find((d) => d?.from === 'bot' && d.audio);
      assert.match(reply.audio.name, /Shabbos\.mp3$/);
    } finally {
      await finish();
    }
  });

  test('a broad request lists numbered choices, and the number plays that one', async () => {
    try {
      const live = await stream();
      await say('weiss');
      const first = await live.waitFor((f) => f.event === 'trace-end');
      const said = live.frames.filter((f) => f.event === 'message' && f.data.from === 'bot').map((f) => f.data.text ?? '');
      assert.ok(said.includes('🎵 Which one?'), 'the bot lists its options');
      assert.ok(said.some((text) => text.startsWith('🎵 1. ')) && said.some((text) => text.startsWith('🎵 2. ')), 'one message per option');

      await say('2');
      const second = await live.waitFor((f) => f.event === 'trace-end' && f.data.id !== first.data.id);
      assert.equal(second.data.choice, true);
      assert.equal(second.data.text, '2');
      const audio = live.frames.map((f) => f.data).filter((d) => d?.audio);
      assert.equal(audio.length, 1, 'picking an option sends that one song');

      await say('1'); // the list is still on screen, so the other option can be picked too
      await live.waitFor((f) => f.event === 'trace-end' && f.data.id !== first.data.id && f.data.id !== second.data.id);
      assert.equal(live.frames.map((f) => f.data).filter((d) => d?.audio).length, 2);
    } finally {
      await finish();
    }
  });

  test('asking the same thing again right away is ignored and says why', async () => {
    try {
      const live = await stream();
      await say('benny friedman');
      await live.waitFor((f) => f.event === 'trace-end');
      await say('benny friedman');
      const ignored = await live.waitFor((f) => f.event === 'trace-item' && f.data.item.label === 'ignored');
      assert.match(ignored.data.item.detail, /20 seconds/);
      const answers = live.frames.map((f) => f.data).filter((d) => d?.audio);
      assert.equal(answers.length, 1, 'only one copy of the song');
    } finally {
      await finish();
    }
  });

  test('a song nobody has gets a plain no-match answer', async () => {
    try {
      const live = await stream();
      await say('zzzz qqqq');
      await live.waitFor((f) => f.event === 'trace-end');
      const reply = live.frames.map((f) => f.data).find((d) => d?.from === 'bot');
      assert.match(reply.text, /^🎵 No match for "zzzz qqqq" \(I looked on music-table\.com too\)/);
    } finally {
      await finish();
    }
  });

  test('a page that connects late gets the whole conversation and the trace so far', async () => {
    try {
      const early = await stream();
      await say('benny friedman');
      await early.waitFor((f) => f.event === 'trace-end');

      const late = await stream();
      const snapshot = await late.waitFor((f) => f.event === 'snapshot');
      assert.equal(snapshot.data.messages.length, 3, 'my message, the title, the audio');
      assert.equal(snapshot.data.runs.length, 1);
      assert.ok(snapshot.data.runs[0].items.length >= 5);
      assert.equal(snapshot.data.typing, false);
      assert.equal(snapshot.data.catalogTracks, 1);
    } finally {
      await finish();
    }
  });

  test('Clear starts a fresh chat and the bot keeps working', async () => {
    try {
      const live = await stream();
      await say('benny friedman');
      await live.waitFor((f) => f.event === 'trace-end');

      assert.equal((await post('/api/reset', {})).status, 200);
      const reset = await live.waitFor((f) => f.event === 'reset');
      assert.deepEqual(reset.data.messages, []);
      assert.deepEqual(reset.data.runs, []);

      await say('yoely weiss shabbos');
      await live.waitFor((f) => f.event === 'trace-end' && f.data.text === 'yoely weiss shabbos');
      const state = (await (await fetch(`${base}/api/state`)).json()) as { messages: unknown[]; runs: unknown[] };
      assert.equal(state.messages.length, 3);
      assert.equal(state.runs.length, 1);
    } finally {
      await finish();
    }
  });

  test('Daily message shows the new-music message with album art, and a number from it plays that song', async () => {
    await finish();
    const recent = new Date(Date.now() - 60 * 60_000).toISOString();
    const art = await startMockMusicTable([
      { slug: 'oizer-ana-elech', title: 'Oizer Oberlander - Ana Elech', files: [{ name: 'Ana Elech.mp3' }], publishedAt: recent, category: 'Singles', coverId: 'img1~mv2.png' },
      { slug: 'band-clip', title: 'Band - Clip', video: true, publishedAt: recent, category: 'Videos' },
    ]);
    try {
      catalog = new Catalog(':memory:');
      trace = new Trace();
      const musicTable = new MusicTable({ baseUrl: art.url, minIntervalMs: 0, trustedFileUrl: () => true, onEvent: (event) => trace.site(event) });
      simulator = createSimulator({ catalog, musicTable, trace, pollMs: 5, prepareImage: stubPictures });
      ({ url: base, port } = await simulator.listen(0));
      const live = await stream();
      assert.equal((await post('/api/digest', {}, {})).status, 403, 'only from the page');
      assert.equal((await post('/api/digest', {})).status, 202);
      const ended = await live.waitFor((f) => f.event === 'trace-end' && f.data.text === 'daily new-music message');
      const shown = live.frames.filter((f) => f.event === 'message').map((f) => f.data);
      assert.match(shown[0].text, /^🎵 New music · /);
      assert.equal(shown[1].image.url, 'collage:1', 'one picture of the covers, numbered');
      assert.equal(shown[2].text, '🎵 1. Oizer Oberlander — Ana Elech · single');
      assert.match(shown[3].text, /Also new, video only:\n• Band - Clip/);
      const steps = labels(live.frames, ended.data.id).join('\n');
      assert.match(steps, /site feed/);
      assert.match(steps, /newest posts/);
      assert.equal(art.postReads.length, 0, 'the list carried everything; no post was read on its own');

      await say('1');
      const picked = await live.waitFor((f) => f.event === 'trace-end' && f.data.choice === true);
      const reply = live.frames.filter((f) => f.event === 'message' && f.data.from === 'bot').map((f) => f.data).slice(-2);
      assert.equal(reply[0].image.url, 'https://static.wixstatic.com/media/img1~mv2.png/v1/fill/w_640,h_360,al_c,q_80/cover.jpg', "the song's card first");
      assert.match(reply[1].audio.name, /Ana Elech\.mp3$/, 'then the song: two messages');
      assert.equal(picked.data.text, '1');
    } finally {
      await finish();
      await art.close();
    }
  });

  test('with no site, the bot answers from the catalog only and says so', async () => {
    await finish();
    catalog = new Catalog(':memory:');
    trace = new Trace();
    simulator = createSimulator({ catalog, musicTable: undefined, trace, pollMs: 5, prepareImage: stubPictures });
    ({ url: base, port } = await simulator.listen(0));
    try {
      const live = await stream();
      await say('anything at all');
      await live.waitFor((f) => f.event === 'trace-end');
      const reply = live.frames.map((f) => f.data).find((d) => d?.from === 'bot');
      assert.match(reply.text, /^🎵 No match for "anything at all"\./);
      assert.doesNotMatch(reply.text, /music-table/);
      assert.equal(((await (await fetch(`${base}/api/state`)).json()) as { musicTable: boolean }).musicTable, false);
    } finally {
      await finish();
    }
  });
});
