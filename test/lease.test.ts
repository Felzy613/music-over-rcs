import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { acquire, release, renew, s3LeaseStore } from '../src/cloud/lease.ts';
import { FakeBucket } from './helpers/fake-bucket.ts';
import { memoryLeaseStore } from './helpers/memory-lease.ts';

const T0 = 1_800_000_000_000;

describe('the lease', () => {
  for (const [name, makeStore] of [
    ['in memory', () => memoryLeaseStore()],
    ['over the bucket', () => s3LeaseStore(new FakeBucket().s3)],
  ] as const) {
    describe(name, () => {
      test('the first instance gets it; a second has to wait, and is told how long', async () => {
        const store = makeStore();
        assert.deepEqual(await acquire(store, 'old', 90, T0), { ok: true, expiresAt: T0 + 90_000 });
        assert.deepEqual(await acquire(store, 'new', 90, T0 + 10_000), { ok: false, heldBy: 'old', retryInSeconds: 80 });
      });

      test('the holder can ask again and renew; renewing pushes the end back', async () => {
        const store = makeStore();
        await acquire(store, 'a', 60, T0);
        assert.equal((await acquire(store, 'a', 60, T0 + 5_000)).ok, true);
        assert.deepEqual(await renew(store, 'a', 60, T0 + 30_000), { ok: true, expiresAt: T0 + 90_000 });
        assert.equal((await acquire(store, 'b', 60, T0 + 80_000)).ok, false, 'still held after the original end because it was renewed');
      });

      test('a lease that lapses (a crashed instance) is taken by the next one, and the old holder then cannot renew', async () => {
        const store = makeStore();
        await acquire(store, 'crashed', 30, T0);
        assert.equal((await acquire(store, 'next', 30, T0 + 31_000)).ok, true);
        assert.deepEqual(await renew(store, 'crashed', 30, T0 + 32_000), { ok: false, heldBy: 'next', retryInSeconds: 0 });
      });

      test('releasing hands it over at once; releasing someone else’s lease does nothing', async () => {
        const store = makeStore();
        await acquire(store, 'old', 90, T0);
        assert.deepEqual(await release(store, 'intruder'), { ok: true });
        assert.equal((await acquire(store, 'new', 90, T0 + 1000)).ok, false, 'an intruder’s release changed nothing');
        assert.deepEqual(await release(store, 'old'), { ok: true });
        assert.equal((await acquire(store, 'new', 90, T0 + 2000)).ok, true);
      });

      test('two instances racing for a free lease: exactly one wins', async () => {
        const store = makeStore();
        const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => acquire(store, `instance-${i}`, 60, T0)));
        assert.equal(answers.filter((answer) => answer.ok).length, 1);
      });

      test('a race on a lapsed lease also has exactly one winner', async () => {
        const store = makeStore();
        await acquire(store, 'gone', 15, T0);
        const answers = await Promise.all(['x', 'y', 'z'].map((holder) => acquire(store, holder, 60, T0 + 20_000)));
        assert.equal(answers.filter((answer) => answer.ok).length, 1);
      });

      test('the time asked for is kept between 15 seconds and 5 minutes', async () => {
        const store = makeStore();
        assert.deepEqual(await acquire(store, 'a', 1, T0), { ok: true, expiresAt: T0 + 15_000 });
        assert.deepEqual(await renew(store, 'a', 100_000, T0), { ok: true, expiresAt: T0 + 300_000 });
      });
    });
  }

  test('a damaged record in the bucket counts as a lapsed lease, not a stuck one', async () => {
    const bucket = new FakeBucket();
    await bucket.s3.put('lease.json', 'not json');
    assert.equal((await acquire(s3LeaseStore(bucket.s3), 'a', 60, T0)).ok, true);
  });
});
