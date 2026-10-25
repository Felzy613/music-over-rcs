import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import worker, { ALERT_MAX_AGE_MS, ALERTS_PER_ROUND, renderConfigured, runScheduled, sendAlert, sendOutbox, type Env } from '../cloudflare/index.ts';
import { FAILURES_BEFORE_REPORT, NOT_RUNNING_REPORT_MS, REPORT_AGAIN_MS, runWatchdog, type WatchdogState } from '../cloudflare/watchdog.ts';
import { FakeBucket } from './helpers/fake-bucket.ts';

const T0 = 1_800_000_000_000;
const MIN = 60_000;

describe('sending an alert', () => {
  test('by email, with the title in the subject', async () => {
    const sent: unknown[] = [];
    const env: Env = { STATE: new FakeBucket().binding, EMAIL: { send: async (m) => void sent.push(m) }, ALERT_FROM: 'alerts@d.example', ALERT_TO: 'me@d.example' };
    await sendAlert(env, 'The bridge is unlinked', 'Link it again.');
    assert.deepEqual(sent, [{ from: 'alerts@d.example', to: 'me@d.example', subject: '[Music over RCS] The bridge is unlinked', text: 'Link it again.' }]);
  });

  test('with no email binding, to ntfy; with neither, it says so', async () => {
    const posted: Array<{ url: string; title: string | null; body: string }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      posted.push({ url, title: new Headers(init?.headers).get('title'), body: String(init?.body) });
      return new Response('ok');
    }) as unknown as typeof fetch;
    const base: Env = { STATE: new FakeBucket().binding };
    await sendAlert({ ...base, NTFY_TOPIC: 'my topic' }, 'Down', 'It is down', fakeFetch);
    assert.deepEqual(posted, [{ url: 'https://ntfy.sh/my%20topic', title: 'Down', body: 'It is down' }]);
    await assert.rejects(() => sendAlert(base, 'x', 'y', fakeFetch), /no way to send alerts/);
  });
});

describe('mailing what the bot left in the bucket', () => {
  const emailEnv = (bucket: FakeBucket, sent: Array<{ subject: string; text: string }>): Env => ({
    STATE: bucket.binding,
    EMAIL: { send: async (m) => void sent.push({ subject: m.subject, text: m.text }) },
    ALERT_FROM: 'alerts@d.example',
    ALERT_TO: 'me@d.example',
  });
  const leave = (bucket: FakeBucket, name: string, alert: unknown) => void bucket.objects.set(`alerts/${name}.json`, { body: typeof alert === 'string' ? alert : JSON.stringify(alert), etag: `"${name}"` });

  test('each alert is sent in order and removed once sent', async () => {
    const bucket = new FakeBucket();
    const sent: Array<{ subject: string; text: string }> = [];
    leave(bucket, '2', { title: 'Second', message: 'two', at: T0 });
    leave(bucket, '1', { title: 'First', message: 'one', at: T0 });
    const result = await sendOutbox(emailEnv(bucket, sent), T0 + MIN);
    assert.deepEqual(result, { sent: 2, waiting: 0, dropped: 0 });
    assert.deepEqual(sent.map((m) => m.subject), ['[Music over RCS] First', '[Music over RCS] Second']);
    assert.equal(bucket.objects.size, 0);
  });

  test('one that cannot be sent stays for the next round, and is dropped when a day old', async () => {
    const bucket = new FakeBucket();
    leave(bucket, '1', { title: 'T', message: 'm', at: T0 });
    const noWay: Env = { STATE: bucket.binding };
    assert.deepEqual(await sendOutbox(noWay, T0 + MIN), { sent: 0, waiting: 1, dropped: 0 });
    assert.equal(bucket.objects.size, 1);
    assert.deepEqual(await sendOutbox(noWay, T0 + ALERT_MAX_AGE_MS + MIN), { sent: 0, waiting: 0, dropped: 1 });
    assert.equal(bucket.objects.size, 0);
  });

  test('an unreadable or empty one is removed, not retried for ever', async () => {
    const bucket = new FakeBucket();
    leave(bucket, '1', 'not json');
    leave(bucket, '2', { title: 'no message', at: T0 });
    const result = await sendOutbox(emailEnv(bucket, []), T0);
    assert.deepEqual(result, { sent: 0, waiting: 0, dropped: 2 });
    assert.equal(bucket.objects.size, 0);
  });

  test('a flood is mailed a few at a time', async () => {
    const bucket = new FakeBucket();
    const sent: Array<{ subject: string; text: string }> = [];
    for (let i = 0; i < ALERTS_PER_ROUND + 4; i++) leave(bucket, String(i).padStart(3, '0'), { title: 'T', message: `m${i}`, at: T0 });
    assert.deepEqual(await sendOutbox(emailEnv(bucket, sent), T0), { sent: ALERTS_PER_ROUND, waiting: 4, dropped: 0 });
    assert.deepEqual(await sendOutbox(emailEnv(bucket, sent), T0 + 5 * MIN), { sent: 4, waiting: 0, dropped: 0 });
  });

  test('other things in the bucket are left alone', async () => {
    const bucket = new FakeBucket();
    await bucket.binding.put('lease.json', '{}');
    await bucket.binding.put('watchdog.json', '{}');
    await sendOutbox(emailEnv(bucket, []), T0);
    assert.deepEqual([...bucket.objects.keys()].sort(), ['lease.json', 'watchdog.json']);
  });
});

describe('the five-minute job', () => {
  test('does nothing, and records nothing, to the host until RENDER_URL is a real address', async () => {
    const bucket = new FakeBucket();
    let asked = 0;
    const counting = (async () => {
      asked += 1;
      throw new Error('should not be asked');
    }) as unknown as typeof fetch;
    for (const url of [undefined, 'https://REPLACE-ME.onrender.com', '', 'not a url']) {
      const state = await runScheduled({ STATE: bucket.binding, ...(url === undefined ? {} : { RENDER_URL: url }) }, T0, counting);
      assert.deepEqual(state, { failures: 0 });
    }
    assert.equal(asked, 0);
    assert.equal(bucket.objects.size, 0);
    assert.equal(renderConfigured({ STATE: bucket.binding, RENDER_URL: 'https://music-over-rcs.onrender.com' }), true);
  });

  test('mails the waiting alerts even before there is a host to watch', async () => {
    const bucket = new FakeBucket();
    const sent: unknown[] = [];
    bucket.objects.set('alerts/1.json', { body: JSON.stringify({ title: 'T', message: 'hello', at: T0 }), etag: '"1"' });
    await runScheduled({ STATE: bucket.binding, EMAIL: { send: async (m) => void sent.push(m) }, ALERT_FROM: 'a@d.example', ALERT_TO: 'me@d.example' }, T0);
    assert.equal(sent.length, 1);
  });

  test('checks the host, keeps what it saw in the bucket, and survives having no way to send alerts', async () => {
    const bucket = new FakeBucket();
    const env: Env = { STATE: bucket.binding, RENDER_URL: 'https://mors.example/' };
    const down = (async () => {
      throw new Error('refused');
    }) as unknown as typeof fetch;
    for (let i = 0; i < FAILURES_BEFORE_REPORT; i++) await runScheduled(env, T0 + i * 5 * MIN, down);
    const saved = JSON.parse(bucket.objects.get('watchdog.json')!.body) as WatchdogState;
    assert.equal(saved.failures, FAILURES_BEFORE_REPORT);
    assert.ok(saved.reportedAt, 'the outage was recorded as reported even though the alert could not be sent');
  });

  test('reaches the host with the Workers runtime’s fetch, which refuses to be called on another object (2026-10-25)', async () => {
    // As workerd does: a fetch called as `something.fetch(…)` throws instead of fetching.
    const asked: string[] = [];
    const workersFetch = function (this: unknown, input: string | URL | Request): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
      asked.push(String(input));
      return Promise.resolve(new Response('ok'));
    } as typeof fetch;
    const real = globalThis.fetch;
    globalThis.fetch = workersFetch;
    try {
      const bucket = new FakeBucket();
      const state = await runScheduled({ STATE: bucket.binding, RENDER_URL: 'https://mors.example' }, T0);
      assert.equal(state.lastCheck?.detail, 'up');
      assert.equal(state.lastCheck?.ok, true);
      assert.equal(state.failures, 0);
      assert.deepEqual(asked, ['https://mors.example/healthz'], 'the request that keeps the free service awake went out');
    } finally {
      globalThis.fetch = real;
    }
  });

  test('serves nothing: there is no way in', async () => {
    assert.equal(await (await worker.fetch()).text(), 'ok');
  });
});

describe('the watchdog', () => {
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
});
