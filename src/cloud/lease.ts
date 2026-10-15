import type { S3 } from './s3.ts';

/**
 * A lease: at most one running copy of the bot's host may own the Google Messages session and write the replicated
 * databases at a time. Render starts a new instance before it stops the old one on a deploy, and two bridges on one
 * Google login, or two writers on one replica, would unpair the phone or corrupt the backup. The newcomer waits here until
 * the old one lets go (it does on SIGTERM) or its lease runs out (it crashed).
 *
 * The record lives in one R2 object and is changed only with a compare-and-swap (R2's conditional writes), so two callers
 * can't both win. The host reaches it through R2's S3 address, with the keys it has for the backups.
 */
export interface LeaseRecord {
  holder: string;
  /** When the lease lapses unless renewed (Unix ms). 0 once released. */
  expiresAt: number;
}

/** Storage with compare-and-swap: write only if nothing changed since `version` was read. */
export interface LeaseStore {
  read(): Promise<{ record: LeaseRecord; version: string } | undefined>;
  /** `version` undefined means "only if nothing is stored yet". False when someone else changed it first. */
  write(record: LeaseRecord, version: string | undefined): Promise<boolean>;
}

export type LeaseAnswer = { ok: true; expiresAt: number } | { ok: false; heldBy: string; retryInSeconds: number };

export const MIN_TTL_SECONDS = 15;
export const MAX_TTL_SECONDS = 300;

const clampTtl = (seconds: number | undefined): number => Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.round(seconds ?? 90)));

/** The lease record in the bucket (R2's S3 interface: write only if absent, or only if the ETag is still what was read). */
export function s3LeaseStore(s3: Pick<S3, 'get' | 'put'>, key = 'lease.json'): LeaseStore {
  return {
    async read() {
      const object = await s3.get(key);
      if (!object) return undefined;
      try {
        const value = JSON.parse(object.text) as Partial<LeaseRecord>;
        if (typeof value.holder === 'string' && typeof value.expiresAt === 'number') return { record: { holder: value.holder, expiresAt: value.expiresAt }, version: object.etag };
      } catch {
        // a damaged record is treated as a lapsed lease below
      }
      return { record: { holder: '', expiresAt: 0 }, version: object.etag };
    },
    async write(record, version) {
      const result = await s3.put(key, JSON.stringify(record), version === undefined ? { ifNoneMatch: '*' } : { ifMatch: version });
      return result.ok;
    },
  };
}

/** Takes the lease if it is free, lapsed, or already this holder's. */
export async function acquire(store: LeaseStore, holder: string, ttlSeconds: number | undefined, now: number): Promise<LeaseAnswer> {
  const current = await store.read();
  if (current && current.record.holder !== holder && current.record.expiresAt > now) {
    return { ok: false, heldBy: current.record.holder, retryInSeconds: Math.max(1, Math.ceil((current.record.expiresAt - now) / 1000)) };
  }
  const record = { holder, expiresAt: now + clampTtl(ttlSeconds) * 1000 };
  if (await store.write(record, current?.version)) return { ok: true, expiresAt: record.expiresAt };
  // Someone else wrote between the read and the write: they have it.
  const winner = await store.read();
  return { ok: false, heldBy: winner?.record.holder ?? 'another instance', retryInSeconds: 5 };
}

/** Extends the lease for its holder. Fails if it was lost (lapsed and taken by another). */
export async function renew(store: LeaseStore, holder: string, ttlSeconds: number | undefined, now: number): Promise<LeaseAnswer> {
  const current = await store.read();
  if (!current || current.record.holder !== holder) return { ok: false, heldBy: current?.record.holder ?? '', retryInSeconds: 0 };
  const record = { holder, expiresAt: now + clampTtl(ttlSeconds) * 1000 };
  if (await store.write(record, current.version)) return { ok: true, expiresAt: record.expiresAt };
  return { ok: false, heldBy: (await store.read())?.record.holder ?? '', retryInSeconds: 0 };
}

/** Lets go, so the next instance doesn't have to wait for the lease to lapse. Harmless if it isn't the holder. */
export async function release(store: LeaseStore, holder: string): Promise<{ ok: boolean }> {
  const current = await store.read();
  if (!current || current.record.holder !== holder) return { ok: true };
  return { ok: await store.write({ holder, expiresAt: 0 }, current.version) };
}
