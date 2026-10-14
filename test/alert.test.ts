import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { alertFromEnv, allNotify, remoteNotify } from '../src/alert.ts';
import { Health } from '../src/health.ts';
import { listen, readText, type Listening } from './helpers/servers.ts';

describe('alerts to the Worker', () => {
  const servers: Listening[] = [];
  after(async () => {
    await Promise.all(servers.map((server) => server.close()));
  });

  async function alertServer(status = 200) {
    const received: Array<{ method: string; path: string; authorization: string | undefined; body: unknown }> = [];
    const server = await listen(async (req, res) => {
      received.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization, body: JSON.parse(await readText(req)) });
      res.writeHead(status).end('{}');
    });
    servers.push(server);
    return { server, received };
  }

  test('posts the title and message with the bearer token', async () => {
    const { server, received } = await alertServer();
    await remoteNotify({ url: `${server.url}/alert`, token: 'secret' })('Music over RCS', 'The bridge is unlinked.');
    assert.deepEqual(received, [{ method: 'POST', path: '/alert', authorization: 'Bearer secret', body: { title: 'Music over RCS', message: 'The bridge is unlinked.' } }]);
  });

  test('never throws: an unreachable or unhappy Worker is only logged', async () => {
    const logs: string[] = [];
    await remoteNotify({ url: 'http://127.0.0.1:1/alert', token: 't', log: (line) => logs.push(line) })('a', 'b');
    const { server } = await alertServer(500);
    await remoteNotify({ url: `${server.url}/alert`, token: 't', log: (line) => logs.push(line) })('a', 'b');
    assert.equal(logs.length, 2);
    assert.match(logs[0]!, /could not send an alert/);
    assert.match(logs[1]!, /HTTP 500/);
  });

  test('reads ALERT_URL and ALERT_TOKEN; nothing when unset; a clear error when wrong', () => {
    assert.equal(alertFromEnv({}), undefined);
    assert.equal(typeof alertFromEnv({ ALERT_URL: 'https://edge.example/alert', ALERT_TOKEN: 'x' }), 'function');
    assert.throws(() => alertFromEnv({ ALERT_URL: 'not a url', ALERT_TOKEN: 'x' }), /ALERT_URL is not a valid URL/);
    assert.throws(() => alertFromEnv({ ALERT_URL: 'ftp://edge.example/alert', ALERT_TOKEN: 'x' }), /must be http\(s\)/);
    assert.throws(() => alertFromEnv({ ALERT_URL: 'https://edge.example/alert' }), /ALERT_TOKEN is not/);
  });

  test('allNotify tells every sink even when one fails', async () => {
    const told: string[] = [];
    const notify = allNotify(
      async () => {
        throw new Error('down');
      },
      undefined,
      async (_title, message) => void told.push(message),
    );
    await notify('t', 'hello');
    assert.deepEqual(told, ['hello']);
  });

  test('a Health problem and its recovery both reach the Worker', async () => {
    const { server, received } = await alertServer();
    const health = new Health({ notify: remoteNotify({ url: `${server.url}/alert`, token: 'k' }) });
    health.problem('bridge', 'Google Messages unlinked the bridge.');
    health.ok('bridge', 'Fixed: the bridge is connected again.');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      received.map((r) => (r.body as { message: string }).message),
      ['Google Messages unlinked the bridge.', 'Fixed: the bridge is connected again.'],
    );
  });
});
