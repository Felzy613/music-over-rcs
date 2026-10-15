import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containerMemory, memoryCheck } from '../src/cloud/memory.ts';

const files = (max: string, stat: string) => (path: string): string => {
  if (path.endsWith('memory.max')) return max;
  if (path.endsWith('memory.stat')) return stat;
  throw new Error('ENOENT');
};
const STAT = 'anon 100000000\nfile 300000000\nkernel 5000000\nshmem 2000000\n';

test('reads the container’s limit and what really uses it (anonymous and shared memory, not the file cache)', () => {
  assert.deepEqual(containerMemory(files('536870912\n', STAT)), { limit: 536870912, used: 102000000 });
});

test('there is no answer where there is no limit or no container', () => {
  assert.equal(containerMemory(files('max\n', STAT)), undefined);
  assert.equal(containerMemory(files('536870912', 'nothing useful')), undefined);
  assert.equal(containerMemory(() => {
    throw new Error('ENOENT');
  }), undefined);
});

test('the bot’s check uses the container when there is one, else its own share when told one, else none', () => {
  const container = () => ({ limit: 512, used: 100 });
  assert.deepEqual(memoryCheck({}, { container })!(), { limit: 512, used: 100 });
  assert.deepEqual(memoryCheck({ BOT_MEMORY_MB: '220' }, { container: () => undefined, rss: () => 123 })!(), { limit: 220 * 1048576, used: 123 });
  assert.equal(memoryCheck({}, { container: () => undefined }), undefined);
  assert.equal(memoryCheck({ BOT_MEMORY_MB: 'lots' }, { container: () => undefined }), undefined);
});
