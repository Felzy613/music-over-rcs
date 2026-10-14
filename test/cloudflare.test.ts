import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { handleRequest, renderConfigured, runScheduled, sendAlert, type Env } from '../cloudflare/index.ts';
import { acquire, release, renew, r2LeaseStore, type LeaseBucket } from '../cloudflare/lease.ts';
import { FAILURES_BEFORE_REPORT, NOT_RUNNING_REPORT_MS, REPORT_AGAIN_MS, runWatchdog, type WatchdogState } from '../cloudflare/watchdog.ts';

/** An R2 bucket with the compare-and-swap rules of the real one: a put whose condition fails returns null and changes nothing. */
class FakeBucket implements LeaseBucket {
  objects = new Map<string, { value: string; etag: string }>();
  #version = 0;
  async get(key: string) {
    const object = this.objects.get(key);
    return object ? { etag: object.etag, text: async () => object.value } : null;
  }
  async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    const current = this.objects.get(key);
    const condition = options?.onlyIf;
    if (condition?.etagMatches !== undefined && current?.etag !== condition.etagMatches) return null;
    if (condition?.etagDoesNotMatch !== undefined && (condition.etagDoesNotMatch === '*' ? current !== undefined : current?.etag === condition.etagDoesNotMatch)) return null;
    this.objects.set(key, { value, etag: `etag-${++this.#version}` });
    return { key };
  }
}

describe('the lease', () => {
  const T0 = 1_800_000_000_000;

  test('the first instance gets it; a second has to wait, and is told how long', async () => {
    const store = r2LeaseStore(new FakeBucket());
    const first = await acquire(store, 'old', 90, T0);
    assert.deepEqual(first, { ok: true, expiresAt: T0 + 90_000 });
    const second = await acquire(store, 'new', 90, T0 + 10_000);
    assert.deepEqual(second, { ok: false, heldBy: 'old', retryInSeconds: 80 });
  });

  test('the holder can ask again and renew; renewing pushes the end back', async () => {
    const store = r2LeaseStore(new FakeBucket());
    await acquire(store, 'a', 60, T0);
    assert.equal((await acquire(store, 'a', 60, T0 + 5_000)).ok, true);
    assert.deepEqual(await renew(store, 'a', 60, T0 + 30_000), { ok: true, expiresAt: T0 + 90_000 });
    assert.equal((await acquire(store, 'b', 60, T0 + 80_000)).ok, false, 'still held after the original end because it was renewed');
  });

  test('a lease that lapses (a crashed instance) is taken by the next one, and the old holder then cannot renew', async () => {
    const store = r2LeaseStore(new FakeBucket());
    await acquire(store, 'crashed', 30, T0);
    const taken = await acquire(store, 'next', 30, T0 + 31_000);
    assert.equal(taken.ok, true);
    const late = await renew(store, 'crashed', 30, T0 + 32_000);
    assert.deepEqual(late, { ok: false, heldBy: 'next', retryInSeconds: 0 });
  });

  test('releasing hands it over at once; releasing someone else’s lease does nothing', async () => {
    const store = r2LeaseStore(new FakeBucket());
    await acquire(store, 'old', 90, T0);
    assert.deepEqual(await release(store, 'intruder'), { ok: true });
    assert.equal((await acquire(store, 'new', 90, T0 + 1000)).ok, false, 'an intruder’s release changed nothing');
    assert.deepEqual(await release(store, 'old'), { ok: true });
    assert.equal((await acquire(store, 'new', 90, T0 + 2000)).ok, true);
  });

  test('two instances racing for a free lease: exactly one wins', async () => {
    const store = r2LeaseStore(new FakeBucket());
    const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => acquire(store, `instance-${i}`, 60, T0)));
    assert.equal(answers.filter((answer) => answer.ok).length, 1);
  });

  test('a race on a held-then-lapsed lease also has exactly one winner', async () => {
    const bucket = new FakeBucket();
    const store = r2LeaseStore(bucket);
    await acquire(store, 'gone', 15, T0);
    const answers = await Promise.all(['x', 'y', 'z'].map((holder) => acquire(store, holder, 60, T0 + 20_000)));
    assert.equal(answers.filter((answer) => answer.ok).length, 1);
  });

  test('the time asked for is kept between 15 seconds and 5 minutes', async () => {
    const store = r2LeaseStore(new FakeBucket());
    assert.deepEqual(await acquire(store, 'a', 1, T0), { ok: true, expiresAt: T0 + 15_000 });
    assert.deepEqual(await renew(store, 'a', 100_000, T0), { ok: true, expiresAt: T0 + 300_000 });
  });

  test('a damaged record counts as a lapsed lease, not a stuck one', async () => {
    const bucket = new FakeBucket();
    await bucket.put('lease.json', 'not json');
    assert.equal((await acquire(r2LeaseStore(bucket), 'a', 60, T0)).ok, true);
  });
});

describe('the Worker’s requests', () => {
  const env = (extra: Partial<Env> = {}): Env => ({ STATE: new FakeBucket(), EDGE_TOKEN: 'edge-secret', RENDER_URL: 'https://mors.example', ...extra });
  const call = (e: Env, path: string, body?: unknown, token: string | null = 'edge-secret', method = 'POST') =>
    handleRequest(new Request(`https://edge.example${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), e, 1_800_000_000_000);

  test('/healthz is open; everything else needs the shared token', async () => {
    const e = env();
    assert.equal((await call(e, '/healthz', undefined, null, 'GET')).status, 200);
    assert.equal((await call(e, '/lease/acquire', { holder: 'a' }, null)).status, 401);
    assert.equal((await call(e, '/lease/acquire', { holder: 'a' }, 'wrong')).status, 401);
    assert.equal((await call(e, '/alert', { message: 'x' }, 'edge-secret-longer')).status, 401);
    assert.equal((await call(e, '/status', undefined, 'wrong', 'GET')).status, 401);
  });

  test('lease requests go through acquire, renew and release', async () => {
    const e = env();
    assert.deepEqual(await (await call(e, '/lease/acquire', { holder: 'a', ttlSeconds: 60 })).json(), { ok: true, expiresAt: 1_800_000_060_000 });
    assert.deepEqual(await (await call(e, '/lease/acquire', { holder: 'b' })).json(), { ok: false, heldBy: 'a', retryInSeconds: 60 });
    assert.equal(((await (await call(e, '/lease/renew', { holder: 'a' })).json()) as { ok: boolean }).ok, true);
    assert.deepEqual(await (await call(e, '/lease/release', { holder: 'a' })).json(), { ok: true });
    assert.equal(((await (await call(e, '/lease/acquire', { holder: 'b' })).json()) as { ok: boolean }).ok, true);
    assert.equal((await call(e, '/lease/acquire', {})).status, 400);
    assert.equal((await call(e, '/lease/nonsense', { holder: 'a' })).status, 404);
  });

  test('/alert sends an email with the title in the subject', async () => {
    const sent: unknown[] = [];
    const e = env({ EMAIL: { send: async (message) => void sent.push(message) }, ALERT_FROM: 'alerts@d.example', ALERT_TO: 'me@d.example' });
    const res = await call(e, '/alert', { title: 'The bridge is unlinked', message: 'Link it again.' });
    assert.equal(res.status, 200);
    assert.deepEqual(sent, [{ from: 'alerts@d.example', to: 'me@d.example', subject: '[Music over RCS] The bridge is unlinked', text: 'Link it again.' }]);
    assert.equal((await call(e, '/alert', { title: 'x' })).status, 400, 'a message is required');
  });

  test('with no email binding, alerts go to ntfy; with neither, the caller is told', async () => {
    const posted: Array<{ url: string; title: string | null; body: string }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, title: new Headers(init?.headers).get('title'), body: String(init?.body) });
      return new Response('ok');
    }) as unknown as typeof fetch;
    await sendAlert(env({ NTFY_TOPIC: 'my topic' }), 'Down', 'It is down', fakeFetch);
    assert.deepEqual(posted, [{ url: 'https://ntfy.sh/my%20topic', title: 'Down', body: 'It is down' }]);
    await assert.rejects(() => sendAlert(env(), 'x', 'y', fakeFetch), /no way to send alerts/);
    assert.equal((await call(env(), '/alert', { message: 'y' })).status, 502);
  });
});

describe('the watchdog', () => {
  const T0 = 1_800_000_000_000;
  const MIN = 60_000;

  function setUp(options: { phase?: string } = {}) {
    const state = { host: 'up' as 'up' | 'down' | 'sick', phase: options.phase ?? 'running', now: T0, saved: undefined as WatchdogState | undefined };
    const alerts: Array<[string, string]> = [];
    const requests: string[] = [];
    const fakeFetch = (async (url: string) => {
      requests.push(url);
      if (state.host === 'down') throw new Error('connect ECONNREFUSED');
      if (state.host === 'sick') return new Response('bad gateway', { status: 502 });
      if (url.endsWith('/status')) return Response.json({ phase: state.phase });
      return new Response('ok');
    }) as unknown as typeof fetch;
    const check = async () => {
      state.saved = await runWatchdog({
        renderUrl: 'https://mors.example',
        adminToken: 'admin',
        fetch: fakeFetch,
        now: state.now,
        load: async () => state.saved,
        save: async (s) => void (state.saved = structuredClone(s)),
        alert: async (title, message) => void alerts.push([title, message]),
      });
    };
    const at = async (minutes: number) => {
      state.now = T0 + minutes * MIN;
      await check();
    };
    return { state, alerts, requests, at };
  }

  test('a healthy host is asked twice (awake, then status) and nothing is said', async () => {
    const w = setUp();
    await w.at(0);
    assert.deepEqual(w.requests, ['https://mors.example/healthz', 'https://mors.example/status']);
    assert.equal(w.alerts.length, 0);
    assert.equal(w.state.saved?.lastCheck?.phase, 'running');
  });

  test('a short outage is not reported; a lasting one is, once, and its end is too', async () => {
    const w = setUp();
    await w.at(0);
    w.state.host = 'down';
    for (let i = 1; i < FAILURES_BEFORE_REPORT; i++) await w.at(i * 5);
    assert.equal(w.alerts.length, 0);
    await w.at(FAILURES_BEFORE_REPORT * 5);
    assert.equal(w.alerts.length, 1);
    assert.equal(w.alerts[0]![0], 'Music over RCS is down');
    await w.at(FAILURES_BEFORE_REPORT * 5 + 5);
    assert.equal(w.alerts.length, 1, 'not repeated at once');
    w.state.host = 'up';
    await w.at(60);
    assert.deepEqual(w.alerts.map(([title]) => title), ['Music over RCS is down', 'Music over RCS is back']);
    await w.at(65);
    assert.equal(w.alerts.length, 2, 'nothing more once it is back');
  });

  test('a host that answers with an error status counts as down', async () => {
    const w = setUp();
    w.state.host = 'sick';
    for (let i = 0; i <= FAILURES_BEFORE_REPORT; i++) await w.at(i * 5);
    assert.match(w.alerts[0]![1], /HTTP 502/);
  });

  test('a lasting outage is mentioned again after six hours', async () => {
    const w = setUp();
    w.state.host = 'down';
    for (let i = 0; i <= 3; i++) await w.at(i * 5);
    assert.equal(w.alerts.length, 1);
    await w.at(REPORT_AGAIN_MS / MIN + 20);
    assert.equal(w.alerts.length, 2);
  });

  test('a host that is up but whose bot is not running is reported after half an hour, not at once', async () => {
    const w = setUp({ phase: 'setup' });
    await w.at(0);
    await w.at(NOT_RUNNING_REPORT_MS / MIN - 5);
    assert.equal(w.alerts.length, 0);
    await w.at(NOT_RUNNING_REPORT_MS / MIN);
    assert.equal(w.alerts.length, 1);
    assert.equal(w.alerts[0]![0], 'Music over RCS is not answering texts');
    w.state.phase = 'running';
    await w.at(45);
    await w.at(50);
    assert.equal(w.alerts.length, 1);
    assert.equal(w.state.saved?.notRunningSince, undefined);
  });

  test('runScheduled does nothing, and sends nothing, until RENDER_URL is a real address', async () => {
    const bucket = new FakeBucket();
    let asked = 0;
    const counting = (async () => {
      asked += 1;
      throw new Error('should not be asked');
    }) as unknown as typeof fetch;
    for (const url of ['https://REPLACE-ME.onrender.com', '', 'not a url']) {
      const state = await runScheduled({ STATE: bucket, EDGE_TOKEN: 't', RENDER_URL: url }, T0, counting);
      assert.deepEqual(state, { failures: 0 });
    }
    assert.equal(asked, 0);
    assert.equal(bucket.objects.size, 0, 'nothing is recorded either');
    assert.equal(renderConfigured({ STATE: bucket, EDGE_TOKEN: 't', RENDER_URL: 'https://music-over-rcs.onrender.com' }), true);
  });

  test('runScheduled keeps its state in the bucket and survives having no way to send alerts', async () => {
    const bucket = new FakeBucket();
    const e: Env = { STATE: bucket, EDGE_TOKEN: 't', RENDER_URL: 'https://mors.example/' };
    const down = (async () => {
      throw new Error('refused');
    }) as unknown as typeof fetch;
    for (let i = 0; i < FAILURES_BEFORE_REPORT; i++) await runScheduled(e, T0 + i * 5 * MIN, down);
    const saved = JSON.parse((await (await bucket.get('watchdog.json'))!.text()) as string) as WatchdogState;
    assert.equal(saved.failures, FAILURES_BEFORE_REPORT);
    assert.ok(saved.reportedAt, 'the outage was recorded as reported even though the alert could not be sent');
  });
});
