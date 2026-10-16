import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, test } from 'node:test';
import { openWaitingDoor, withWaitingDoor, type Leasing } from '../src/cloud/waiting-door.ts';

describe('the waiting door', () => {
  test('answers /healthz ok and everything else 503 (never a 500 or a 200 that could pass for the bot)', async () => {
    const door = await openWaitingDoor({ port: 0, host: '127.0.0.1' });
    try {
      const base = `http://127.0.0.1:${door.port}`;
      const healthz = await fetch(`${base}/healthz`);
      assert.equal(healthz.status, 200);
      assert.equal(await healthz.text(), 'ok');
      assert.equal((await fetch(`${base}/healthz`, { method: 'HEAD' })).status, 200);
      for (const path of ['/', '/ping', '/status', '/pair']) {
        const res = await fetch(base + path);
        assert.equal(res.status, 503, path);
        assert.equal(res.headers.get('retry-after'), '10');
      }
    } finally {
      await door.close();
    }
  });

  test('closing frees the port at once (the real door opens on it), even with a connection still open', async () => {
    const door = await openWaitingDoor({ port: 0, host: '127.0.0.1' });
    // a keep-alive connection that has not finished, which would hold a plain server.close() open
    const res = await fetch(`http://127.0.0.1:${door.port}/healthz`, { headers: { connection: 'keep-alive' } });
    await res.text();
    await door.close();
    const real = createServer((_req, response) => response.end('the bot'));
    await new Promise<void>((resolve, reject) => {
      real.once('error', reject);
      real.listen(door.port, '127.0.0.1', resolve);
    });
    try {
      assert.equal(await (await fetch(`http://127.0.0.1:${door.port}/`)).text(), 'the bot');
    } finally {
      real.closeAllConnections();
      await new Promise<void>((resolve) => real.close(() => resolve()));
    }
  });

  test('fails to open when something already has the port, instead of pretending', async () => {
    const door = await openWaitingDoor({ port: 0, host: '127.0.0.1' });
    try {
      await assert.rejects(openWaitingDoor({ port: door.port, host: '127.0.0.1' }), /EADDRINUSE/);
    } finally {
      await door.close();
    }
  });
});

describe('holding the web port while waiting for the lease', () => {
  const noop = { renew: async () => 'ok' as const, release: async () => {} };

  test('the door is open for exactly as long as the wait, and closed when the lease is taken', async () => {
    const logs: string[] = [];
    let port = 0;
    const answers: number[] = [];
    const slow: Leasing = {
      holder: 'new',
      ...noop,
      async acquire(options) {
        options?.onWaiting?.();
        options?.onWaiting?.();
        // a second refusal must not open a second door
        await new Promise((resolve) => setTimeout(resolve, 50));
        answers.push((await fetch(`http://127.0.0.1:${port}/healthz`)).status);
      },
    };
    const wrapped = withWaitingDoor(slow, {
      port: 0,
      host: '127.0.0.1',
      log: (line) => logs.push(line),
      open: async (o) => {
        const door = await openWaitingDoor(o);
        port = door.port;
        return door;
      },
    });
    assert.equal(wrapped.holder, 'new');
    await wrapped.acquire();
    assert.deepEqual(answers, [200], 'Render sees an open port while the old instance still holds the lease');
    assert.match(logs.join('\n'), /answering on port \d+ meanwhile/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), 'closed once the lease is taken');
  });

  test('with the lease free no door is opened at all', async () => {
    let opened = 0;
    const free: Leasing = { holder: 'new', ...noop, acquire: async () => {} };
    await withWaitingDoor(free, { port: 0, log: () => {}, open: async () => (opened++, { port: 0, close: async () => {} }) }).acquire();
    assert.equal(opened, 0);
  });

  test('the door is closed even when acquiring ends in an error, and a door that cannot open does not stop the wait', async () => {
    let closed = 0;
    const failing: Leasing = {
      holder: 'new',
      ...noop,
      async acquire(options) {
        options?.onWaiting?.();
        throw new Error('R2 is gone');
      },
    };
    await assert.rejects(
      withWaitingDoor(failing, { port: 0, log: () => {}, open: async () => ({ port: 1, close: async () => void closed++ }) }).acquire(),
      /R2 is gone/,
    );
    assert.equal(closed, 1);

    const logs: string[] = [];
    const waits: Leasing = {
      holder: 'new',
      ...noop,
      async acquire(options) {
        options?.onWaiting?.();
      },
    };
    await withWaitingDoor(waits, { port: 0, log: (line) => logs.push(line), open: async () => Promise.reject(new Error('EADDRINUSE')) }).acquire();
    assert.match(logs.join('\n'), /could not open the waiting door: EADDRINUSE/);
  });

  test('renew and release go straight to the lease', async () => {
    const seen: string[] = [];
    const inner: Leasing = { holder: 'h', acquire: async () => {}, renew: async () => (seen.push('renew'), 'ok' as const), release: async () => void seen.push('release') };
    const wrapped = withWaitingDoor(inner, { port: 0, log: () => {} });
    assert.equal(await wrapped.renew(), 'ok');
    await wrapped.release();
    assert.deepEqual(seen, ['renew', 'release']);
  });
});
