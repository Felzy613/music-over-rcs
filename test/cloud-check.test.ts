import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import { handleRequest, runScheduled, type Env } from '../cloudflare/index.ts';
import { checkCloud, type CheckResult } from '../src/cloud/check.ts';
import { createCloudWeb } from '../src/cloud/web.ts';

/** An R2 bucket with compare-and-swap, enough for the lease and the watchdog's record. */
class Bucket {
  objects = new Map<string, { value: string; etag: string }>();
  n = 0;
  async get(key: string) {
    const o = this.objects.get(key);
    return o ? { etag: o.etag, text: async () => o.value } : null;
  }
  async put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    const cur = this.objects.get(key);
    const c = options?.onlyIf;
    if (c?.etagMatches !== undefined && cur?.etag !== c.etagMatches) return null;
    if (c?.etagDoesNotMatch !== undefined && (c.etagDoesNotMatch === '*' ? cur !== undefined : cur?.etag === c.etagDoesNotMatch)) return null;
    this.objects.set(key, { value, etag: `e${++this.n}` });
    return {};
  }
}

const byName = (results: CheckResult[], name: string): CheckResult => {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result named "${name}" in:\n${results.map((r) => r.name).join('\n')}`);
  return found;
};

describe('the Worker checks', () => {
  function worker(env: Partial<Env> = {}) {
    const full: Env = { STATE: new Bucket(), EDGE_TOKEN: 'edge-secret', RENDER_URL: 'https://REPLACE-ME.onrender.com', ...env };
    const sent: unknown[] = [];
    if (!('EMAIL' in env) && env.NTFY_TOPIC === undefined) {
      full.EMAIL = { send: async (m) => void sent.push(m) };
      full.ALERT_FROM = 'alerts@d.example';
      full.ALERT_TO = 'me@d.example';
    }
    const fakeFetch = (async (url: string, init?: RequestInit) => handleRequest(new Request(url, init), full)) as unknown as typeof fetch;
    return { env: full, fakeFetch, sent };
  }

  test('a working Worker passes everything, and the test email is sent when asked', async () => {
    const w = worker();
    const results = await checkCloud({ worker: 'https://edge.test/', edgeToken: 'edge-secret', sendTestAlert: true, fetch: w.fakeFetch });
    for (const name of ['The Worker answers', 'The Worker accepts the shared token', 'The Worker refuses a wrong token', 'The lease works', 'A test alert is sent']) assert.equal(byName(results, name).ok, true, name);
    assert.equal(w.sent.length, 1);
    assert.match(byName(results, 'The lease works').detail, /taken and given back/);
    // The lease was given back, not left held.
    const again = await checkCloud({ worker: 'https://edge.test', edgeToken: 'edge-secret', fetch: w.fakeFetch });
    assert.match(byName(again, 'The lease works').detail, /taken and given back/);
  });

  test('not yet watching the host says what to set; once a check has run it passes', async () => {
    const w = worker({ RENDER_URL: 'https://mors.example', RENDER_ADMIN_TOKEN: 'admin' });
    const before = byName(await checkCloud({ worker: 'https://edge.test', edgeToken: 'edge-secret', fetch: w.fakeFetch }), 'The Worker is watching the host');
    assert.equal(before.ok, false);
    assert.match(before.fix!, /RENDER_URL/);
    await runScheduled(w.env, Date.now(), (async (url: string) => (String(url).endsWith('/healthz') ? new Response('ok') : Response.json({ phase: 'running' }))) as unknown as typeof fetch);
    const after = byName(await checkCloud({ worker: 'https://edge.test', edgeToken: 'edge-secret', fetch: w.fakeFetch }), 'The Worker is watching the host');
    assert.equal(after.ok, true);
    assert.match(after.detail, /bot phase "running"/);
  });

  test('a wrong shared token is named as the problem, with the command that fixes it', async () => {
    const w = worker();
    const results = await checkCloud({ worker: 'https://edge.test', edgeToken: 'a-different-token', fetch: w.fakeFetch });
    const token = byName(results, 'The Worker accepts the shared token');
    assert.equal(token.ok, false);
    assert.match(token.fix!, /wrangler secret put EDGE_TOKEN/);
    assert.ok(!results.some((r) => r.name === 'The lease works'), 'nothing else is tried with a token that is refused');
  });

  test('a missing token, an unreachable Worker and a Worker with no way to send email each say what to do', async () => {
    const w = worker();
    assert.match(byName(await checkCloud({ worker: 'https://edge.test', fetch: w.fakeFetch }), 'The Worker accepts the shared token').fix!, /EDGE_TOKEN=/);
    const down = (async () => {
      throw new Error('getaddrinfo ENOTFOUND edge.test');
    }) as unknown as typeof fetch;
    const unreachable = byName(await checkCloud({ worker: 'https://edge.test', edgeToken: 'x', fetch: down }), 'The Worker answers');
    assert.equal(unreachable.ok, false);
    assert.match(unreachable.fix!, /wrangler deploy/);
    const noMail = worker({ EMAIL: undefined as never });
    noMail.env.EMAIL = undefined;
    const alert = byName(await checkCloud({ worker: 'https://edge.test', edgeToken: 'edge-secret', sendTestAlert: true, fetch: noMail.fakeFetch }), 'A test alert is sent');
    assert.equal(alert.ok, false);
    assert.match(alert.fix!, /ALERT_FROM and ALERT_TO|NTFY_TOPIC/);
  });
});

describe('the Render host checks', () => {
  const servers: Server[] = [];
  after(() => {
    for (const s of servers) {
      s.close();
      s.closeAllConnections();
    }
  });
  async function host(status: Record<string, unknown>) {
    const server = createCloudWeb({
      adminToken: 'admin-secret',
      pageHtml: '',
      status: () => status,
      pair: { send: async () => {}, log: async () => [] },
      rooms: () => [],
      setRoom: () => {},
      canImport: () => false,
      importCatalog: () => ({}),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const RUNNING = { phase: 'running', botEnabled: true, uptimeSeconds: 600, memoryMb: 300, room: '!r:localhost', bridge: { state: 'CONNECTED' }, problems: [], sentThisMonthMb: 120, oneDrive: { connected: true, savedThisMonthMb: 90, monthlyLimitMb: 1500 } };

  test('a host that is up, linked and answering passes every check', async () => {
    const results = await checkCloud({ render: await host(RUNNING), adminToken: 'admin-secret' });
    assert.deepEqual(results.filter((r) => !r.ok), []);
    assert.match(byName(results, 'Songs are saved to OneDrive').detail, /90 MB saved this month of 1500 MB allowed/);
  });

  test('each stage of setup says what is next', async () => {
    const waiting = await checkCloud({ render: await host({ ...RUNNING, phase: 'setup', room: null, bridge: { state: undefined, error: 'no login' } }), adminToken: 'admin-secret' });
    assert.match(byName(waiting, 'Google Messages is linked').fix!, /\/pair/);
    assert.match(byName(waiting, 'The bot is answering texts').fix!, /choose your "message yourself" chat/);

    const off = await checkCloud({ render: await host({ ...RUNNING, phase: 'setup', botEnabled: false }), adminToken: 'admin-secret' });
    assert.match(byName(off, 'The bot is answering texts').fix!, /BOT_ENABLED/);

    const starting = await checkCloud({ render: await host({ ...RUNNING, phase: 'starting' }), adminToken: 'admin-secret' });
    assert.match(byName(starting, 'The bot is answering texts').fix!, /still starting/);

    const unsigned = await checkCloud({ render: await host({ ...RUNNING, oneDrive: { connected: false } }), adminToken: 'admin-secret' });
    assert.match(byName(unsigned, 'Songs are saved to OneDrive').fix!, /Sign in to OneDrive/);
  });

  test('problems the bot reports, a nearly full memory and a nearly used-up month are all shown', async () => {
    const results = await checkCloud({ render: await host({ ...RUNNING, memoryMb: 500, sentThisMonthMb: 4000, problems: [{ key: 'bridge', message: 'Google Messages unlinked the bridge.' }] }), adminToken: 'admin-secret' });
    assert.equal(byName(results, 'Memory is within the free plan').ok, false);
    assert.equal(byName(results, 'Outbound traffic this month').ok, false);
    assert.match(byName(results, 'No problems reported').detail, /unlinked the bridge/);
  });

  test('a wrong or missing admin password is told apart from a host that is down', async () => {
    const url = await host(RUNNING);
    const wrong = byName(await checkCloud({ render: url, adminToken: 'nope' }), 'The host accepts the admin password');
    assert.equal(wrong.ok, false);
    assert.match(wrong.fix!, /ADMIN_TOKEN/);
    assert.match(byName(await checkCloud({ render: url }), 'The host accepts the admin password').detail, /not set in this shell/);
    const down = byName(await checkCloud({ render: 'http://127.0.0.1:1', adminToken: 'x', fetch: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch }), 'The Render host answers');
    assert.equal(down.ok, false);
    assert.match(down.fix!, /Logs/);
  });

  test('with nothing to check it says so', async () => {
    assert.equal((await checkCloud({}))[0]!.ok, false);
  });
});
