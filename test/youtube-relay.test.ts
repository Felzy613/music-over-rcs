import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runQueue, type Env } from '../cloudflare/index.ts';
import { handleRelayRequest, RELAY_MAX_AGE_MS, relaySong, sweepRelay } from '../cloudflare/youtube.ts';
import { createYouTubeRelay, relayTiming, youTubeRelayFromEnv } from '../src/cloud/youtube-relay.ts';
import { FakeBucket } from './helpers/fake-bucket.ts';

const SONG = Uint8Array.from({ length: 64 }, (_, i) => i);

type Behaviour = 'ok' | 'bot' | 'refuse-link' | 'unplayable' | 'http403' | 'http400';

/** A pretend YouTube Music: a session id, the player (each client version can be told how to behave), and the media host. */
function fakeYouTube(options: { byVersion?: Record<string, Behaviour>; sizeOf?: number; refuseFirstRound?: boolean; visitorStatus?: number } = {}) {
  const calls: string[] = [];
  let visitors = 0;
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/visitor_id')) {
      visitors += 1;
      calls.push('visitor');
      if (options.visitorStatus) return new Response('no', { status: options.visitorStatus });
      return Response.json({ responseContext: { visitorData: `CgtWaXNpdG9y${visitors}%3D%3D` } });
    }
    if (url.pathname.endsWith('/player')) {
      const body = JSON.parse(String(init?.body)) as { videoId: string; context: { client: { clientVersion: string; visitorData?: string } } };
      const version = body.context.client.clientVersion;
      calls.push(`player ${version}`);
      assert.equal(new Headers(init?.headers).get('X-Goog-Visitor-Id'), body.context.client.visitorData, 'the session goes in the header and the context alike');
      const behaviour = options.byVersion?.[version] ?? 'ok';
      if (behaviour === 'http403') return new Response('no', { status: 403 });
      if (behaviour === 'http400') return new Response('retired', { status: 400 });
      if (behaviour === 'bot') return Response.json({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } });
      if (behaviour === 'unplayable') return Response.json({ playabilityStatus: { status: 'UNPLAYABLE', reason: 'This video is unavailable' } });
      const refuse = behaviour === 'refuse-link' || (options.refuseFirstRound && visitors === 1);
      return Response.json({
        playabilityStatus: { status: 'OK' },
        streamingData: {
          adaptiveFormats: [
            { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 160_000, url: 'https://rr1.googlevideo.test/webm' },
            { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130_000, contentLength: String(options.sizeOf ?? SONG.length), url: `https://rr1.googlevideo.test/videoplayback?v=${body.videoId}&c=${version}&refuse=${refuse ? 1 : 0}` },
          ],
        },
      });
    }
    if (url.hostname === 'rr1.googlevideo.test') {
      calls.push(`media ${url.searchParams.get('c')}`);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('Range'), 'bytes=0-');
      assert.match(headers.get('User-Agent') ?? '', /Safari/);
      if (url.searchParams.get('refuse') === '1') return new Response('no', { status: 403 });
      return new Response(SONG, { status: 206, headers: { 'content-type': 'audio/mp4', 'content-length': String(SONG.length) } });
    }
    return new Response('?', { status: 404 });
  }) as typeof fetch;
  return { fetch: doFetch, calls };
}

describe('the Worker side of the YouTube relay', () => {
  test('gets the song as the first client, puts its audio in the bucket, and says what it is', async () => {
    const bucket = new FakeBucket();
    const yt = fakeYouTube();
    const result = await relaySong({ videoId: 'dX7fqa8Z2Gs' }, { fetch: yt.fetch, bucket: bucket.binding, audioKey: 'yt/audio/x' });
    assert.deepEqual(result, { ok: true, type: 'audio/mp4', bytes: SONG.length });
    assert.deepEqual(bucket.objects.get('yt/audio/x')?.bytes, SONG);
    assert.deepEqual(yt.calls, ['visitor', 'player 1.02', 'media 1.02']);
  });

  test('a link that refuses the whole song is dropped for the next client’s', async () => {
    const yt = fakeYouTube({ byVersion: { '1.02': 'refuse-link' } });
    const result = await relaySong({ videoId: 'dX7fqa8Z2Gs' }, { fetch: yt.fetch, bucket: new FakeBucket().binding, audioKey: 'a' });
    assert.equal(result.ok, true);
    assert.deepEqual(yt.calls, ['visitor', 'player 1.02', 'media 1.02', 'player 1.03', 'media 1.03']);
  });

  test('after a whole round of refused links it tries once more with a new session', async () => {
    const yt = fakeYouTube({ refuseFirstRound: true });
    const result = await relaySong({ videoId: 'dX7fqa8Z2Gs' }, { fetch: yt.fetch, bucket: new FakeBucket().binding, audioKey: 'a' });
    assert.equal(result.ok, true);
    assert.equal(yt.calls.filter((call) => call === 'visitor').length, 2);
  });

  test('a bot check everywhere is said as such, and nothing is downloaded', async () => {
    const bucket = new FakeBucket();
    const yt = fakeYouTube({ byVersion: { '1.02': 'bot', '1.03': 'bot', '1.01': 'bot' } });
    const result = await relaySong({ videoId: 'dX7fqa8Z2Gs' }, { fetch: yt.fetch, bucket: bucket.binding, audioKey: 'a' });
    assert.deepEqual(result, { ok: false, error: 'Sign in to confirm you’re not a bot', turnedAway: true });
    assert.equal(bucket.objects.size, 0);
    assert.equal(yt.calls.filter((call) => call === 'visitor').length, 1, 'a new session does not get past a bot check');
  });

  test('HTTP 403 from YouTube Music, at the player or for a session, is being turned away too', async () => {
    const everywhere = fakeYouTube({ byVersion: { '1.02': 'http403', '1.03': 'http403', '1.01': 'http403' } });
    assert.deepEqual(await relaySong({ videoId: 'dX7fqa8Z2Gs' }, { fetch: everywhere.fetch, bucket: new FakeBucket().binding, audioKey: 'a' }), {
      ok: false,
      error: 'YouTube Music answered HTTP 403',
      turnedAway: true,
    });
    assert.deepEqual(everywhere.calls, ['visitor', 'player 1.02'], 'it is the address that is refused, so no other version is asked');
    const session = fakeYouTube({ visitorStatus: 403 });
    assert.deepEqual(await relaySong({ videoId: 'dX7fqa8Z2Gs' }, { fetch: session.fetch, bucket: new FakeBucket().binding, audioKey: 'a' }), {
      ok: false,
      error: 'YouTube Music answered HTTP 403',
      turnedAway: true,
    });
  });

  test('a retired client version (HTTP 400) is passed over for the next, and is not being turned away', async () => {
    const yt = fakeYouTube({ byVersion: { '1.02': 'http400' } });
    assert.equal((await relaySong({ videoId: 'dX7fqa8Z2Gs' }, { fetch: yt.fetch, bucket: new FakeBucket().binding, audioKey: 'a' })).ok, true);
    assert.deepEqual(yt.calls, ['visitor', 'player 1.02', 'player 1.03', 'media 1.03']);
    const all = fakeYouTube({ byVersion: { '1.02': 'http400', '1.03': 'http400', '1.01': 'http400' } });
    assert.deepEqual(await relaySong({ videoId: 'dX7fqa8Z2Gs' }, { fetch: all.fetch, bucket: new FakeBucket().binding, audioKey: 'a' }), { ok: false, error: 'YouTube Music answered HTTP 400' });
  });

  test('every request leaves one line in the log, saying whether YouTube turned Cloudflare away', async () => {
    const lines: string[] = [];
    const bucket = new FakeBucket();
    await bucket.binding.put('yt/req/dX7fqa8Z2Gs-ab12.json', JSON.stringify({ videoId: 'dX7fqa8Z2Gs' }));
    await handleRelayRequest('yt/req/dX7fqa8Z2Gs-ab12.json', { bucket: bucket.binding, fetch: fakeYouTube().fetch, log: (line) => lines.push(line) });
    await bucket.binding.put('yt/req/dX7fqa8Z2Gs-cd34.json', JSON.stringify({ videoId: 'dX7fqa8Z2Gs' }));
    const bot = fakeYouTube({ byVersion: { '1.02': 'bot', '1.03': 'bot', '1.01': 'bot' } });
    await handleRelayRequest('yt/req/dX7fqa8Z2Gs-cd34.json', { bucket: bucket.binding, fetch: bot.fetch, log: (line) => lines.push(line) });
    assert.equal(lines.length, 2, lines.join('\n'));
    assert.match(lines[0]!, /^YouTube relay: dX7fqa8Z2Gs-ab12: 0\.0 MB in \d+\.\d s \(queued \d+ ms, session \d+, player \d+, link \d+, store \d+\)$/);
    assert.match(lines[1]!, /^YouTube relay: dX7fqa8Z2Gs-cd34: turned away: Sign in to confirm you’re not a bot \(\d+\.\d s; queued \d+ ms, session \d+, player \d+, link \d+, store \d+\)$/);
  });

  test('a song over the limit is refused before anything is downloaded; a bad id is refused at once', async () => {
    const yt = fakeYouTube({ sizeOf: 40 * 1_048_576 });
    const result = await relaySong({ videoId: 'dX7fqa8Z2Gs', maxBytes: 30 * 1_048_576 }, { fetch: yt.fetch, bucket: new FakeBucket().binding, audioKey: 'a' });
    assert.deepEqual(result, { ok: false, error: 'it is too big to send (40.0 MB, the limit is 30 MB)' });
    assert.ok(!yt.calls.some((call) => call.startsWith('media')));
    assert.deepEqual(await relaySong({ videoId: '../etc' }, { fetch: yt.fetch, bucket: new FakeBucket().binding, audioKey: 'a' }), { ok: false, error: "that isn't a YouTube song" });
  });

  test('a request is answered once, its outcome left beside it; a repeated notice or a stray key does nothing', async () => {
    const bucket = new FakeBucket();
    const yt = fakeYouTube({ byVersion: { '1.02': 'unplayable', '1.03': 'unplayable', '1.01': 'unplayable' } });
    await bucket.binding.put('yt/req/dX7fqa8Z2Gs-ab12.json', JSON.stringify({ videoId: 'dX7fqa8Z2Gs' }));
    const result = await handleRelayRequest('yt/req/dX7fqa8Z2Gs-ab12.json', { bucket: bucket.binding, fetch: yt.fetch });
    const { timing, ...outcome } = result!;
    assert.deepEqual(outcome, { ok: false, error: 'This video is unavailable' });
    assert.ok(timing && timing.totalMs >= 0 && timing.doneAt > 0 && timing.queuedMs !== undefined, 'the outcome says where the Worker’s time went');
    assert.equal(bucket.objects.has('yt/req/dX7fqa8Z2Gs-ab12.json'), false);
    assert.deepEqual(JSON.parse(bucket.objects.get('yt/res/dX7fqa8Z2Gs-ab12.json')!.body), result);
    assert.equal(await handleRelayRequest('yt/req/dX7fqa8Z2Gs-ab12.json', { bucket: bucket.binding, fetch: yt.fetch }), undefined);
    assert.equal(await handleRelayRequest('alerts/x.json', { bucket: bucket.binding, fetch: yt.fetch }), undefined);
  });

  test('the queue hands each notice on and acknowledges it', async () => {
    const bucket = new FakeBucket();
    await bucket.binding.put('yt/req/dX7fqa8Z2Gs-cd34.json', JSON.stringify({ videoId: 'dX7fqa8Z2Gs' }));
    const acked: number[] = [];
    const env: Env = { STATE: bucket.binding };
    await runQueue(
      { messages: [{ body: { action: 'PutObject', object: { key: 'yt/req/dX7fqa8Z2Gs-cd34.json' } }, ack: () => void acked.push(1) }, { body: 'nonsense', ack: () => void acked.push(2) }] },
      env,
      fakeYouTube().fetch,
    );
    assert.deepEqual(acked, [1, 2]);
    assert.ok(bucket.objects.has('yt/audio/dX7fqa8Z2Gs-cd34'));
  });

  test('leftovers older than an hour are swept, newer ones kept', async () => {
    const bucket = new FakeBucket();
    const t0 = Date.parse('2026-10-16T12:00:00Z');
    bucket.now = () => new Date(t0);
    await bucket.binding.put('yt/audio/old', 'x');
    await bucket.binding.put('yt/res/old.json', '{}');
    bucket.now = () => new Date(t0 + RELAY_MAX_AGE_MS);
    await bucket.binding.put('yt/req/new.json', '{}');
    await bucket.binding.put('alerts/keep.json', '{}');
    assert.equal(await sweepRelay(bucket.binding, t0 + RELAY_MAX_AGE_MS + 1000), 2);
    assert.deepEqual([...bucket.objects.keys()].sort(), ['alerts/keep.json', 'yt/req/new.json']);
  });
});

describe('the host side of the YouTube relay', () => {
  /** A relay whose waits run the Worker, the way R2's notice would, once the request is in the bucket. */
  const wired = (bucket: FakeBucket, yt = fakeYouTube(), options: { worker?: boolean } = {}) => {
    let clock = 0;
    return createYouTubeRelay(bucket.s3, {
      now: () => clock,
      timeoutMs: 5000,
      pollMs: 1000,
      sleep: async (ms) => {
        clock += ms;
        if (options.worker === false) return;
        for (const key of [...bucket.objects.keys()].filter((k) => k.startsWith('yt/req/'))) {
          await handleRelayRequest(key, { bucket: bucket.binding, fetch: yt.fetch });
        }
      },
    });
  };

  test('leaves the request, waits for the Worker, takes the audio, and leaves nothing behind', async () => {
    const bucket = new FakeBucket();
    const audio = await wired(bucket)('dX7fqa8Z2Gs', { maxBytes: 1_000_000 });
    const { timing, ...song } = audio;
    assert.deepEqual(song, { data: SONG, type: 'audio/mp4', bytes: SONG.length });
    assert.match(timing ?? '', /^put [\d.]+s, queue [\d.]+s, worker [\d.]+s \[session [\d.]+s, player [\d.]+s, link [\d.]+s, store [\d.]+s\], seen \+[\d.]+s, get [\d.]+s$/);
    assert.equal(bucket.objects.size, 0);
  });

  test('says where a song’s time went: the host’s part, and the Worker’s from its answer (or the whole wait, from an older Worker)', () => {
    const host = { putMs: 120, waitMs: 4100, getMs: 400, foundAt: 10_600 };
    assert.equal(
      relayTiming(host, { queuedMs: 1400, sessionMs: 300, playerMs: 600, linkMs: 200, storeMs: 1900, totalMs: 3100, doneAt: 10_000 }),
      'put 0.12s, queue 1.4s, worker 3.1s [session 0.30s, player 0.60s, link 0.20s, store 1.9s], seen +0.60s, get 0.40s',
    );
    assert.equal(relayTiming(host, undefined), 'put 0.12s, wait 4.1s, get 0.40s');
    assert.equal(relayTiming(host, { totalMs: 'x', sessionMs: -1 }), 'put 0.12s, wait 4.1s, get 0.40s', 'what is not a time is left out');
  });

  test('passes the size limit on, and says why the Worker could not get the song', async () => {
    const bucket = new FakeBucket();
    await assert.rejects(wired(bucket, fakeYouTube({ sizeOf: 50 }))('dX7fqa8Z2Gs', { maxBytes: 10 }), /too big to send/);
    await assert.rejects(wired(bucket, fakeYouTube({ byVersion: { '1.02': 'bot', '1.03': 'bot', '1.01': 'bot' } }))('dX7fqa8Z2Gs'), /not a bot/);
    assert.equal(bucket.objects.size, 0);
  });

  test('when YouTube turns Cloudflare away it asks again 5 seconds later, then 15 more, and then says why', async () => {
    const bucket = new FakeBucket();
    let turned = 2;
    const sometimes = fakeYouTube();
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/player') && turned > 0) {
        turned -= JSON.parse(String(init?.body)).context.client.clientVersion === '1.01' ? 1 : 0;
        return Response.json({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } });
      }
      return sometimes.fetch(input, init);
    }) as typeof fetch;
    const lines: string[] = [];
    const waits: number[] = [];
    let clock = 0;
    const relay = (yt: { fetch: typeof fetch }) =>
      createYouTubeRelay(bucket.s3, {
        now: () => clock,
        pollMs: 1000,
        log: (line) => lines.push(line),
        sleep: async (ms) => {
          clock += ms;
          // The relay's own waits between asks are the long ones; the looks for an answer are a second.
          if (ms > 1000) waits.push(ms);
          for (const key of [...bucket.objects.keys()].filter((k) => k.startsWith('yt/req/'))) await handleRelayRequest(key, { bucket: bucket.binding, fetch: yt.fetch });
        },
      });
    assert.deepEqual((await relay({ fetch: flaky })('dX7fqa8Z2Gs')).bytes, SONG.length, 'the third ask comes through');
    assert.deepEqual(waits, [5000, 15_000]);
    assert.ok(lines.includes('YouTube Music turned Cloudflare away for dX7fqa8Z2Gs (Sign in to confirm you’re not a bot); asking again in 5 s'), lines.join('\n'));

    waits.length = 0;
    await assert.rejects(
      relay(fakeYouTube({ byVersion: { '1.02': 'bot', '1.03': 'bot', '1.01': 'bot' } }))('dX7fqa8Z2Gs'),
      (err: unknown) => err instanceof Error && /not a bot/.test(err.message) && (err as { turnedAway?: boolean }).turnedAway === true,
    );
    assert.deepEqual(waits, [5000, 15_000], 'three asks in all');
    assert.ok(lines.includes('YouTube Music turned Cloudflare away for dX7fqa8Z2Gs 3 times in a row (Sign in to confirm you’re not a bot)'), lines.join('\n'));
    assert.equal(bucket.objects.size, 0);
  });

  test('a failure that is not YouTube turning Cloudflare away is not asked again', async () => {
    const bucket = new FakeBucket();
    const yt = fakeYouTube({ byVersion: { '1.02': 'unplayable', '1.03': 'unplayable', '1.01': 'unplayable' } });
    await assert.rejects(wired(bucket, yt)('dX7fqa8Z2Gs'), /This video is unavailable/);
    assert.equal(yt.calls.filter((call) => call === 'visitor').length, 1);
  });

  test('looks for the answer less and less often while it waits, up to every 3 seconds', async () => {
    const waits: number[] = [];
    let clock = 0;
    const relay = createYouTubeRelay(new FakeBucket().s3, { now: () => clock, timeoutMs: 20_000, pollMs: 750, sleep: async (ms) => void (waits.push(ms), (clock += ms)) });
    await assert.rejects(relay('dX7fqa8Z2Gs'), /no answer within 20 seconds/);
    assert.deepEqual(waits.slice(0, 6), [750, 1125, 1688, 2532, 3000, 3000]);
  });

  test('gives up when no answer comes in time, and cleans up its request', async () => {
    const bucket = new FakeBucket();
    await assert.rejects(wired(bucket, fakeYouTube(), { worker: false })('dX7fqa8Z2Gs'), /the relay gave no answer within 5 seconds/);
    assert.equal(bucket.objects.size, 0);
    await assert.rejects(wired(bucket)('not-an-id'), /isn't a YouTube song/);
  });

  test('is on only with YOUTUBE_RELAY=r2 and the bucket set up', () => {
    const r2 = { R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', R2_BUCKET: 'mors-state', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret' };
    assert.equal(youTubeRelayFromEnv({}), undefined);
    assert.equal(youTubeRelayFromEnv({ ...r2 }), undefined);
    assert.equal(youTubeRelayFromEnv({ YOUTUBE_RELAY: 'r2' }), undefined, 'no bucket, no relay');
    assert.equal(typeof youTubeRelayFromEnv({ ...r2, YOUTUBE_RELAY: 'R2' }), 'function');
  });
});
