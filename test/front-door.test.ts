import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, test } from 'node:test';
import { openFrontDoor, type FrontDoor } from '../src/cloud/front-door.ts';
import { createCloudWeb, type CloudDeps } from '../src/cloud/web.ts';

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};
const stop = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
/** A port nothing listens on: bound, noted and released again. */
async function freePort(): Promise<number> {
  const probe = createServer();
  const port = await listen(probe);
  await stop(probe);
  return port;
}

const toClose: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of toClose.splice(0)) await close();
});
async function door(upstreamPort: number, options: { phase?: string; idleMs?: number } = {}): Promise<{ door: FrontDoor; url: string }> {
  const opened = await openFrontDoor({ port: 0, host: '127.0.0.1', upstream: { port: upstreamPort }, ...options });
  toClose.push(() => opened.close());
  return { door: opened, url: `http://127.0.0.1:${opened.port}` };
}
async function upstream(handler: Parameters<typeof createServer>[1]): Promise<{ port: number; server: Server }> {
  const server = createServer(handler);
  const port = await listen(server);
  toClose.push(() => stop(server));
  return { port, server };
}

describe('the front door, with the bot not there', () => {
  test('/healthz answers ok whatever the bot is doing, and everything else is a polite 503 (never a refused connection)', async () => {
    const { url } = await door(await freePort());
    const healthz = await fetch(`${url}/healthz`);
    assert.equal(healthz.status, 200);
    assert.equal(await healthz.text(), 'ok');
    assert.equal((await fetch(`${url}/healthz`, { method: 'HEAD' })).status, 200);
    for (const path of ['/', '/ping', '/status', '/pair', '/admin/import-catalog']) {
      const res = await fetch(url + path);
      assert.equal(res.status, 503, path);
      assert.equal(res.headers.get('retry-after'), '5', path);
      assert.equal(res.headers.get('cache-control'), 'no-store', path);
    }
  });

  test('a browser gets a page that tries again by itself; anything else gets JSON; both say what is going on', async () => {
    const { door: d, url } = await door(await freePort(), { phase: 'starting' });
    const page = await fetch(`${url}/pair`, { headers: { accept: 'text/html,application/xhtml+xml' } });
    assert.equal(page.status, 503);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    const html = await page.text();
    assert.match(html, /<meta http-equiv="refresh" content="5">/);
    assert.match(html, /starting \(starting\)/);

    d.setPhase('restoring the databases');
    const json = await fetch(`${url}/status`);
    assert.match(json.headers.get('content-type')!, /application\/json/);
    assert.deepEqual(await json.json(), { error: 'starting', phase: 'restoring the databases' });

    d.setPhase('<script>alert(1)</script>');
    const escaped = await (await fetch(`${url}/pair`, { headers: { accept: 'text/html' } })).text();
    assert.ok(!escaped.includes('<script>'), 'the phase is escaped');
    assert.match(escaped, /&lt;script&gt;/);

    const head = await fetch(`${url}/pair`, { method: 'HEAD', headers: { accept: 'text/html' } });
    assert.equal(head.status, 503);
    assert.equal(await head.text(), '');
  });

  test('the bot can come up later without the front door being reopened', async () => {
    const port = await freePort();
    const { url } = await door(port);
    assert.equal((await fetch(`${url}/status`)).status, 503);
    const server = createServer((_req, res) => res.end('the bot'));
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    toClose.push(() => stop(server));
    assert.equal(await (await fetch(`${url}/status`)).text(), 'the bot');
    await stop(server);
    assert.equal((await fetch(`${url}/status`)).status, 503, 'and a bot that goes away again is a 503, not a dropped connection');
  });
});

describe('the front door, with the bot there', () => {
  test('passes the method, path, query and headers, and gives back the status, headers and body untouched', async () => {
    const seen: Record<string, unknown>[] = [];
    const bot = await upstream((req, res) => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, custom: req.headers['x-custom'], host: req.headers.host, expect: req.headers.expect });
      res.writeHead(418, { 'content-type': 'application/json', 'x-bot': 'yes', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'], 'www-authenticate': 'Basic realm="x"' });
      res.end('{"tea":true}');
    });
    const { url } = await door(bot.port);
    const res = await fetch(`${url}/setup/rooms?phone=5551234`, { headers: { authorization: 'Basic YWRtaW46c2VjcmV0', 'x-custom': 'kept' } });
    assert.equal(res.status, 418);
    assert.equal(res.headers.get('x-bot'), 'yes');
    assert.equal(res.headers.get('www-authenticate'), 'Basic realm="x"');
    assert.deepEqual(res.headers.getSetCookie(), ['a=1; Path=/', 'b=2; Path=/']);
    assert.equal(await res.text(), '{"tea":true}');
    assert.deepEqual(seen, [{ method: 'GET', url: '/setup/rooms?phone=5551234', authorization: 'Basic YWRtaW46c2VjcmV0', custom: 'kept', host: `127.0.0.1:${bot.port}`, expect: undefined }]);
  });

  test('streams a big upload to the bot without changing a byte, and the bot’s answer back', async () => {
    const bot = await upstream((req, res) => {
      const hash = createHash('sha256');
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        hash.update(chunk);
      });
      req.on('end', () => res.end(JSON.stringify({ size, sha: hash.digest('hex') })));
    });
    const { url } = await door(bot.port);
    const body = randomBytes(5 * 1024 * 1024);
    const res = await fetch(`${url}/admin/import-catalog`, { method: 'POST', body });
    assert.deepEqual(await res.json(), { size: body.length, sha: createHash('sha256').update(body).digest('hex') });
  });

  test('sends back a response that arrives in pieces, as it arrives', async () => {
    const bot = await upstream(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('one ');
      await new Promise((resolve) => setTimeout(resolve, 30));
      res.end('two');
    });
    const { url } = await door(bot.port);
    assert.equal(await (await fetch(`${url}/`)).text(), 'one two');
  });

  test('a visitor who gives up takes the bot’s half of the request with them', async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => (upstreamClosed = resolve));
    const bot = await upstream((req, res) => {
      res.writeHead(200);
      res.write('started');
      res.on('close', upstreamClosed);
      req.resume();
    });
    const { url } = await door(bot.port);
    const controller = new AbortController();
    const res = await fetch(`${url}/slow`, { signal: controller.signal });
    await res.body!.getReader().read();
    controller.abort();
    await Promise.race([closed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the bot was left holding the request')), 2000))]);
  });

  test('a bot that dies in the middle of an answer ends the visitor’s answer, and the door carries on', async () => {
    const bot = await upstream((req, res) => {
      if (req.url === '/dies') {
        res.writeHead(200, { 'content-length': '1000' });
        res.write('part');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.end('fine');
    });
    const { url } = await door(bot.port);
    const dying = await fetch(`${url}/dies`);
    await assert.rejects(dying.text());
    assert.equal(await (await fetch(`${url}/ok`)).text(), 'fine');
  });

  test('a bot that accepts the request and says nothing is called silent after the idle time (504), not waited on for ever', async () => {
    const bot = await upstream(() => {});
    const { url } = await door(bot.port, { idleMs: 80 });
    const res = await fetch(`${url}/stuck`);
    assert.equal(res.status, 504);
    assert.deepEqual(await res.json(), { error: 'the bot is not answering' });
  });

  test('a bot that refuses an upload before reading it (a 403, as the web door does without ALLOW_IMPORT) still gets its 403 to the visitor', async () => {
    const bot = await upstream((_req, res) => {
      const body = '{"error":"importing is off (set ALLOW_IMPORT=1, and do it before the bot starts)"}';
      res.writeHead(403, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
    });
    const { url } = await door(bot.port);
    const res = await fetch(`${url}/admin/import-catalog`, { method: 'POST', body: randomBytes(4 * 1024 * 1024) });
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { error: string }).error, /importing is off/);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
  });

  test('a request Node cannot read is a 400, and the door carries on', async () => {
    const bot = await upstream((_req, res) => res.end('ok'));
    const { url } = await door(bot.port);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(url).port), '127.0.0.1', () => socket.write(Buffer.from('GET /caf\u00e9 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n', 'latin1')));
      let text = '';
      socket.on('data', (chunk) => (text += chunk.toString('latin1')));
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 400 /);
    assert.equal(await (await fetch(`${url}/after`)).text(), 'ok');
  });
});

describe('the front door in front of the real web door', () => {
  const cleanUp: string[] = [];
  afterEach(() => {
    for (const dir of cleanUp.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const deps = (calls: string[]): CloudDeps => ({
    adminToken: 'open-sesame',
    pageHtml: '<!doctype html><title>setup</title>',
    status: () => ({ phase: 'setup' }),
    pair: { send: async () => {}, log: async () => [] },
    rooms: () => [],
    setRoom: () => {},
    canImport: () => true,
    importCatalog: (path) => {
      calls.push(`import:${path.endsWith('catalog.db')}`);
      return { tracks: 3 };
    },
  });
  const basic = (password: string) => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;

  test('the password check, the pages, /ping’s deliberate 500 and a catalog upload all work through it', async () => {
    const calls: string[] = [];
    const web = createCloudWeb(deps(calls));
    const port = await listen(web);
    toClose.push(() => stop(web));
    const { url } = await door(port);

    const noPassword = await fetch(`${url}/status`);
    assert.equal(noPassword.status, 401);
    assert.match(noPassword.headers.get('www-authenticate')!, /^Basic realm=/);
    assert.equal((await fetch(`${url}/status`, { headers: { authorization: basic('wrong') } })).status, 401);
    assert.deepEqual(await (await fetch(`${url}/status`, { headers: { authorization: basic('open-sesame') } })).json(), { phase: 'setup' });
    const page = await fetch(`${url}/pair`, { headers: { authorization: basic('open-sesame') } });
    assert.match(page.headers.get('content-type')!, /text\/html/);
    assert.match(await page.text(), /<title>setup<\/title>/);
    assert.equal((await fetch(`${url}/ping`)).status, 500, 'the monitor that expects 500 gets it from the bot, through the door');
    assert.equal((await fetch(`${url}/healthz`)).status, 200);

    const dir = mkdtempSync(join(tmpdir(), 'front-door-'));
    cleanUp.push(dir);
    const file = join(dir, 'source.db');
    const source = new DatabaseSync(file);
    source.exec('create table t (n integer); insert into t values (1)');
    source.close();
    const upload = await fetch(`${url}/admin/import-catalog`, { method: 'POST', headers: { authorization: basic('open-sesame') }, body: readFileSync(file) });
    assert.deepEqual(await upload.json(), { ok: true, imported: { tracks: 3 } });
    assert.deepEqual(calls, ['import:true']);
  });
});

describe('closing the front door', () => {
  test('frees the port at once, even with a connection still open, and refuses to open on a port that is taken', async () => {
    const opened = await openFrontDoor({ port: 0, host: '127.0.0.1', upstream: { port: await freePort() } });
    const res = await fetch(`http://127.0.0.1:${opened.port}/healthz`, { headers: { connection: 'keep-alive' } });
    await res.text();
    await assert.rejects(openFrontDoor({ port: opened.port, host: '127.0.0.1', upstream: { port: 1 } }), /EADDRINUSE/);
    await opened.close();
    await assert.rejects(fetch(`http://127.0.0.1:${opened.port}/healthz`));
  });
});
