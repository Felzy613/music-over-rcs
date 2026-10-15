import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { alertFromEnv, allNotify, outboxNotify } from '../src/alert.ts';
import { Health } from '../src/health.ts';
import { FakeBucket } from './helpers/fake-bucket.ts';

describe('alerts left for the Worker', () => {
  test('each problem becomes a file in alerts/, oldest first by name, holding the title, message and time', async () => {
    const bucket = new FakeBucket();
    let at = 1_800_000_000_000;
    let n = 0;
    const notify = outboxNotify({ s3: bucket.s3, now: () => at++, random: () => `r${n++}` });
    await notify('Music over RCS', 'The bridge is unlinked.');
    await notify('Music over RCS', 'Fixed: it is linked again.');
    const keys = await bucket.s3.list('alerts/');
    assert.deepEqual(keys, ['alerts/01800000000000-r0.json', 'alerts/01800000000001-r1.json']);
    assert.deepEqual(JSON.parse(bucket.objects.get(keys[0]!)!.body), { title: 'Music over RCS', message: 'The bridge is unlinked.', at: 1_800_000_000_000 });
  });

  test('never throws: a bucket that refuses is only logged', async () => {
    const logs: string[] = [];
    const notify = outboxNotify({
      s3: {
        put: async () => {
          throw new Error('R2 refused writing alerts/x (HTTP 403)');
        },
      },
      log: (line) => logs.push(line),
    });
    await notify('a', 'b');
    assert.match(logs[0]!, /could not leave an alert for the Worker: R2 refused writing/);
  });

  test('is on when the four R2 settings are there, and off when they are not (the Mac)', () => {
    const all = { R2_ENDPOINT: 'https://a.r2.cloudflarestorage.com', R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'i', R2_SECRET_ACCESS_KEY: 's' };
    assert.equal(typeof alertFromEnv(all), 'function');
    assert.equal(alertFromEnv({}), undefined);
    assert.equal(alertFromEnv({ ...all, R2_BUCKET: '' }), undefined);
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

  test('a Health problem and its recovery both reach the bucket', async () => {
    const bucket = new FakeBucket();
    let at = 1_800_000_000_000;
    const health = new Health({ notify: outboxNotify({ s3: bucket.s3, now: () => at++ }) });
    health.problem('bridge', 'Google Messages unlinked the bridge.');
    health.ok('bridge', 'Fixed: the bridge is connected again.');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const messages = [...bucket.objects.values()].map((o) => (JSON.parse(o.body) as { message: string }).message);
    assert.deepEqual(messages, ['Google Messages unlinked the bridge.', 'Fixed: the bridge is connected again.']);
  });
});
