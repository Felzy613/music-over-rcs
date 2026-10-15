import type { LeaseRecord, LeaseStore } from '../../src/cloud/lease.ts';

/** A store with compare-and-swap, held in memory. */
export function memoryLeaseStore(): LeaseStore & { record?: LeaseRecord } {
  let current: { record: LeaseRecord; version: number } | undefined;
  return {
    async read() {
      return current ? { record: { ...current.record }, version: String(current.version) } : undefined;
    },
    async write(record, version) {
      if ((version === undefined) !== (current === undefined) || (version !== undefined && String(current?.version) !== version)) return false;
      current = { record: { ...record }, version: (current?.version ?? 0) + 1 };
      return true;
    },
  };
}

