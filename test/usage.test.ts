import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { addSent, sentThisMonth } from '../src/usage.ts';
import { startMockMatrix } from './helpers/mock-matrix.ts';

test('counts what is sent, month by month', () => {
  const catalog = new Catalog(':memory:');
  assert.equal(sentThisMonth(catalog, new Date('2026-10-13T12:00:00Z')), 0);
  addSent(catalog, 1000, new Date('2026-10-13T12:00:00Z'));
  addSent(catalog, 500.4, new Date('2026-10-31T23:00:00Z'));
  addSent(catalog, 0, new Date('2026-10-14T00:00:00Z'));
  addSent(catalog, -5, new Date('2026-10-14T00:00:00Z'));
  addSent(catalog, 700, new Date('2026-11-01T00:00:00Z'));
  assert.equal(sentThisMonth(catalog, new Date('2026-10-20T00:00:00Z')), 1500);
  assert.equal(sentThisMonth(catalog, new Date('2026-11-02T00:00:00Z')), 700);
});

test('the Matrix client reports each file it uploads, and a broken counter does not stop the send', async () => {
  const mock = await startMockMatrix();
  try {
    const counted: number[] = [];
    const client = new MatrixClient({ token: mock.token, homeserver: mock.url, onUpload: (bytes) => void counted.push(bytes) });
    const data = new Blob([new Uint8Array(1234)]);
    await client.sendAudio(mock.roomId, { data, fileName: 'a.mp3', mimeType: 'audio/mpeg', bytes: 1234 } as never);
    assert.deepEqual(counted, [1234]);

    const broken = new MatrixClient({
      token: mock.token,
      homeserver: mock.url,
      onUpload: () => {
        throw new Error('disk full');
      },
    });
    assert.ok(await broken.sendAudio(mock.roomId, { data, fileName: 'b.mp3', mimeType: 'audio/mpeg', bytes: 1234 } as never));
  } finally {
    await mock.close();
  }
});
