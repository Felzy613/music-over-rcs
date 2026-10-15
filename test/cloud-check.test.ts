import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import { checkCloud, type CheckResult } from '../src/cloud/check.ts';
import { createCloudWeb } from '../src/cloud/web.ts';

const NOW = 1_800_000_000_000;
const byName = (results: CheckResult[], name: string): CheckResult => {
  const found = results.find((r) => r.name === name);
  assert.ok(found, `no result named "${name}" in:\n${results.map((r) => r.name).join('\n')}`);
  return found;
};

describe('the host checks', () => {
  const servers: Server[] = [];
  const alerts: string[] = [];
  after(() => {
    for (const s of servers) {
      s.close();
      s.closeAllConnections();
    }
  });
  async function host(status: Record<string, unknown>, options: { withAlerts?: boolean } = {}) {
    const server = createCloudWeb({
      adminToken: 'admin-secret',
      pageHtml: '',
      status: () => status,
      pair: { send: async () => {}, log: async () => [] },
      rooms: () => [],
      setRoom: () => {},
      canImport: () => false,
      importCatalog: () => ({}),
      ...(options.withAlerts ? { testAlert: async () => void alerts.push('test') } : {}),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const EDGE = { lease: { holder: 'srv-abc', expiresAt: NOW + 60_000 }, watchdog: { at: NOW - 2 * 60_000, ok: true, detail: 'up' }, alertsWaiting: 0 };
  const RUNNING = { phase: 'running', botEnabled: true, uptimeSeconds: 600, memoryMb: 300, room: '!r:localhost', bridge: { state: 'CONNECTED' }, problems: [], sentThisMonthMb: 120, oneDrive: { connected: true, savedThisMonthMb: 90, monthlyLimitMb: 1500 }, edge: EDGE };
  const check = async (status: Record<string, unknown>, extra: Parameters<typeof checkCloud>[0] = {}) => checkCloud({ render: await host(status), adminToken: 'admin-secret', now: () => NOW, ...extra });

  test('a host that is up, linked, answering, backed up and watched passes every check', async () => {
    const results = await check(RUNNING);
    assert.deepEqual(results.filter((r) => !r.ok), []);
    assert.match(byName(results, 'This host holds the lease').detail, /held by srv-abc/);
    assert.match(byName(results, 'The Worker is watching the host').detail, /2 min ago, found it up/);
    assert.match(byName(results, 'Songs are saved to OneDrive').detail, /90 MB saved this month of 1500 MB allowed/);
  });

  test('each stage of setup says what is next', async () => {
    const waiting = await check({ ...RUNNING, phase: 'setup', room: null, bridge: { state: undefined, error: 'no login' } });
    assert.match(byName(waiting, 'Google Messages is linked').fix!, /\/pair/);
    assert.match(byName(waiting, 'The bot is answering texts').fix!, /choose your "message yourself" chat/);
    assert.match(byName(await check({ ...RUNNING, phase: 'setup', botEnabled: false }), 'The bot is answering texts').fix!, /BOT_ENABLED/);
    assert.match(byName(await check({ ...RUNNING, phase: 'starting' }), 'The bot is answering texts').fix!, /still starting/);
    assert.match(byName(await check({ ...RUNNING, oneDrive: { connected: false } }), 'Songs are saved to OneDrive').fix!, /Sign in to OneDrive/);
  });

  test('R2 trouble, a lapsed lease, a Worker that has not checked and alerts stuck in the bucket each say what to do', async () => {
    assert.match(byName(await check({ ...RUNNING, edge: undefined }), 'Backups, the lease and alerts (R2)').fix!, /R2_ENDPOINT/);
    const refused = byName(await check({ ...RUNNING, edge: { error: 'R2 refused listing alerts/ (HTTP 403 AccessDenied)' } }), 'Backups, the lease and alerts (R2)');
    assert.equal(refused.ok, false);
    assert.match(refused.fix!, /Object Read & Write/);

    const lapsed = byName(await check({ ...RUNNING, edge: { ...EDGE, lease: { holder: 'srv-abc', expiresAt: NOW - 1000 } } }), 'This host holds the lease');
    assert.equal(lapsed.ok, false);
    assert.match(lapsed.detail, /lapsed/);

    const never = byName(await check({ ...RUNNING, edge: { ...EDGE, watchdog: null } }), 'The Worker is watching the host');
    assert.match(never.fix!, /wrangler secret put RENDER_URL/);
    const stale = byName(await check({ ...RUNNING, edge: { ...EDGE, watchdog: { at: NOW - 40 * 60_000, ok: true, detail: 'up' } } }), 'The Worker is watching the host');
    assert.equal(stale.ok, false, 'a check from forty minutes ago means the Worker has stopped');

    const stuck = byName(await check({ ...RUNNING, edge: { ...EDGE, alertsWaiting: 3 } }), 'No alerts stuck waiting');
    assert.equal(stuck.ok, false);
    assert.match(stuck.fix!, /ALERT_FROM and ALERT_TO/);
  });

  test('problems the bot reports, a nearly full memory and a nearly used-up month are all shown', async () => {
    const results = await check({ ...RUNNING, memoryMb: 500, sentThisMonthMb: 4000, problems: [{ key: 'bridge', message: 'Google Messages unlinked the bridge.' }] });
    assert.equal(byName(results, 'Memory is within the free plan').ok, false);
    assert.equal(byName(results, 'Outbound traffic this month').ok, false);
    assert.match(byName(results, 'No problems reported').detail, /unlinked the bridge/);
  });

  test('a test alert is left for the Worker when asked, and a host with nowhere to leave it says so', async () => {
    const withAlerts = await checkCloud({ render: await host(RUNNING, { withAlerts: true }), adminToken: 'admin-secret', now: () => NOW, sendTestAlert: true });
    assert.equal(byName(withAlerts, 'A test alert is left for the Worker').ok, true);
    assert.deepEqual(alerts, ['test']);
    const without = await checkCloud({ render: await host(RUNNING), adminToken: 'admin-secret', now: () => NOW, sendTestAlert: true });
    assert.equal(byName(without, 'A test alert is left for the Worker').ok, false);
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
