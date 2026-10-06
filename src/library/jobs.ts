import type { DownloadedAudio } from '../audio-fetch.ts';
import { describe } from '../bot.ts';
import type { Catalog } from '../catalog.ts';
import type { MusicTable } from '../sources/music-table.ts';
import type { Reply } from '../types.ts';
import { prefetch, songsToKeep, type AudioCache } from './audio-cache.ts';
import { buildDigest, type DigestItem } from './digest.ts';
import { syncSite, type SyncResult } from './sync.ts';

export interface DailyTime {
  hour: number;
  minute: number;
}

export interface LibraryJobsOptions {
  musicTable: MusicTable;
  catalog: Catalog;
  /** Sends the daily message into the chat (the runner's `announce`). */
  announce(replies: Reply[]): Promise<void>;
  /** When to send the daily new-music message, in this Mac's time. Without it, none is sent. */
  digestAt?: DailyTime | undefined;
  /** Where songs are kept ready. Without it, nothing is downloaded ahead of time. */
  cache?: AudioCache | undefined;
  /** How many songs to keep ready. */
  keepSongs?: number;
  /** The real downloader (signed links), used to get songs ready. */
  fetchAudio(url: string, title?: string): Promise<DownloadedAudio>;
  syncEveryMs?: number;
  log?: (line: string) => void;
  now?: () => Date;
  /** Pause between two songs being got ready. */
  prefetchPauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const HOUR_MS = 60 * 60_000;
export const STATE = {
  lastSync: 'library.last_sync',
  scanOffset: 'library.scan_offset',
  scanDone: 'library.scan_done',
  digestDate: 'digest.last_date',
  digestSentAt: 'digest.last_sent_at',
  digestRetryAfter: 'digest.retry_after',
} as const;

/** The calendar day in this Mac's time zone, as YYYY-MM-DD. */
export const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Reads "9:00", "09:30" or "21:15". "off" means no daily message. Anything else is a mistake worth reporting. */
export function parseDailyTime(raw: string | undefined, fallback = '09:00'): DailyTime | undefined | Error {
  const text = (raw?.trim() || fallback).toLowerCase();
  if (/^(off|false|no|0|none)$/.test(text)) return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  const hour = Number(match?.[1]);
  const minute = Number(match?.[2]);
  if (!match || hour > 23 || minute > 59) return new Error(`DIGEST_TIME must look like 09:00 (24-hour) or be "off" (got "${raw}")`);
  return { hour, minute };
}

/**
 * The bot's background work: keeping the catalog in step with the site, keeping popular songs downloaded, and the
 * daily new-music message. Everything runs one thing at a time, checked once a minute, so a Mac that slept through
 * the scheduled time catches up when it wakes (once, not repeatedly).
 */
export class LibraryJobs {
  #o: LibraryJobsOptions;
  #log: (line: string) => void;
  #now: () => Date;
  #timers: NodeJS.Timeout[] = [];
  #running: Promise<void> | undefined;
  #stopped = false;
  /** Whether this run of the bot has filled the kept-ready folder yet (it does on its first round, sync due or not). */
  #keptReady = false;

  constructor(options: LibraryJobsOptions) {
    this.#o = options;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? (() => new Date());
  }

  start(): void {
    this.#stopped = false;
    const first = setTimeout(() => void this.check(), 15_000);
    const every = setInterval(() => void this.check(), 60_000);
    first.unref();
    every.unref();
    this.#timers.push(first, every);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
    await this.#running;
  }

  /** One round: the sync and the songs kept ready when they're due, then the daily message when it's due. */
  check(): Promise<void> {
    if (this.#running) return this.#running;
    // The marker is cleared from a callback, never inside the round: a round with nothing due finishes at once, and
    // clearing it there would happen before it was set, leaving it set for good.
    const round = this.#round().finally(() => {
      if (this.#running === round) this.#running = undefined;
    });
    this.#running = round;
    return round;
  }

  async #round(): Promise<void> {
    try {
      if (this.#syncDue()) await this.refresh();
      else if (!this.#keptReady && this.#o.cache) await this.keepReady();
      if (this.#digestDue()) await this.sendDigest();
      if (!this.#o.catalog.getState(STATE.scanDone)) await this.scanStep();
    } catch (err) {
      this.#log(`background work failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Syncs the catalog with the site, then gets the songs worth keeping onto disk. */
  async refresh(): Promise<void> {
    const result = await this.sync();
    if (result && this.#o.cache) await this.keepReady();
  }

  async sync(): Promise<SyncResult | undefined> {
    const { catalog, musicTable } = this.#o;
    try {
      const result = await syncSite({ musicTable, catalog, now: this.#now });
      catalog.setState(STATE.lastSync, this.#now().toISOString());
      this.#log(`synced with music-table.com: ${result.seen} recent posts, ${result.fresh.length} new, ${result.songs} songs in the catalog from them`);
      return result;
    } catch (err) {
      // Try again in an hour rather than at the next check.
      catalog.setState(STATE.lastSync, new Date(this.#now().getTime() - (this.#o.syncEveryMs ?? 3 * HOUR_MS) + HOUR_MS).toISOString());
      this.#log(`could not sync with music-table.com: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Reads more of the site's archive into the catalog: a few pages a round, so a request or the daily message never
   * waits long, picking up where it left off after a restart. Once the whole site is in, the regular sync keeps it
   * current and this does nothing.
   */
  async scanStep(pages = 4): Promise<void> {
    const { catalog, musicTable } = this.#o;
    const offset = Number(catalog.getState(STATE.scanOffset) ?? 0) || 0;
    try {
      const result = await syncSite({ musicTable, catalog, pages, offset, feed: false, now: this.#now });
      catalog.setState(STATE.scanOffset, String(offset + result.seen));
      if (!result.more) {
        catalog.setState(STATE.scanDone, this.#now().toISOString());
        this.#log(`the whole site is in the catalog: ${offset + result.seen} posts read`);
      }
    } catch (err) {
      this.#log(`could not read more of the site (will carry on next round): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The whole site at once (the command line's scan): pages of 50, with a pause between them. Returns posts read. */
  async scanAll(options: { pauseMs?: number; progress?: (posts: number) => void } = {}): Promise<number> {
    const { catalog, musicTable } = this.#o;
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let offset = 0;
    for (;;) {
      const result = await syncSite({ musicTable, catalog, pages: 1, offset, feed: offset === 0, now: this.#now });
      offset += result.seen;
      catalog.setState(STATE.scanOffset, String(offset));
      options.progress?.(offset);
      if (!result.more) break;
      await sleep(options.pauseMs ?? 1000);
    }
    catalog.setState(STATE.scanDone, this.#now().toISOString());
    return offset;
  }

  async keepReady(): Promise<void> {
    const cache = this.#o.cache;
    if (!cache) return;
    this.#keptReady = true;
    const songs = songsToKeep(
      { catalog: this.#o.catalog, songUrl: (post) => this.#o.musicTable.trackUrl(post, 0), now: this.#now },
      this.#o.keepSongs ?? 25,
    );
    const result = await prefetch({
      cache,
      songs,
      fetchAudio: this.#o.fetchAudio,
      describe,
      ...(this.#o.prefetchPauseMs !== undefined ? { pauseMs: this.#o.prefetchPauseMs } : {}),
      ...(this.#o.sleep ? { sleep: this.#o.sleep } : {}),
      log: this.#log,
      stopped: () => this.#stopped,
    });
    const { files, bytes } = cache.stats();
    if (result.downloaded > 0 || result.failed > 0) {
      this.#log(`songs kept ready: ${result.downloaded} downloaded, ${result.failed} failed; ${files} on disk (${(bytes / 1048576).toFixed(0)} MB)`);
    }
  }

  /**
   * What the daily message would say right now (after a sync), without sending it or marking anything. `since`
   * widens it, to see what a message with more in it looks like.
   */
  async previewDigest(since?: Date): Promise<{ replies: Reply[]; slugs: string[] }> {
    await this.sync();
    return this.#digest(since);
  }

  /** Builds and sends the daily message, and remembers which posts it covered. Returns how many posts were in it. */
  async sendDigest(since?: Date): Promise<number> {
    const { catalog } = this.#o;
    const now = this.#now();
    await this.sync();
    const { replies, slugs } = this.#digest(since);
    if (replies.length === 0) {
      catalog.setState(STATE.digestDate, localDay(now));
      this.#log('daily message: nothing new today, so none was sent');
      return 0;
    }
    try {
      await this.#o.announce(replies);
    } catch (err) {
      catalog.setState(STATE.digestRetryAfter, new Date(now.getTime() + 30 * 60_000).toISOString());
      this.#log(`daily message could not be sent (trying again in 30 minutes): ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
    catalog.markAnnounced(slugs, now);
    catalog.setState(STATE.digestDate, localDay(now));
    catalog.setState(STATE.digestSentAt, now.toISOString());
    this.#log(`daily message sent: ${slugs.length} new post${slugs.length === 1 ? '' : 's'}`);
    return slugs.length;
  }

  #digest(sinceOverride?: Date): { replies: Reply[]; slugs: string[] } {
    const { catalog, musicTable } = this.#o;
    const now = this.#now();
    const sentAt = catalog.getState(STATE.digestSentAt);
    // Since the last message (with a margin for posts the site dated a little earlier), or the last day for the first.
    const since = sinceOverride ?? (sentAt ? new Date(Date.parse(sentAt) - 6 * HOUR_MS) : new Date(now.getTime() - 24 * HOUR_MS));
    const items: DigestItem[] = [];
    for (const post of catalog.postsToAnnounce(since)) {
      if (post.audioFiles === 0) {
        items.push({ post });
        continue;
      }
      const song = catalog.byUrl(musicTable.trackUrl(post, 0));
      if (song) items.push({ post, song });
    }
    return { replies: buildDigest(items, { date: now }), slugs: items.map((item) => item.post.slug) };
  }

  #syncDue(): boolean {
    const last = Date.parse(this.#o.catalog.getState(STATE.lastSync) ?? '');
    return Number.isNaN(last) || this.#now().getTime() - last >= (this.#o.syncEveryMs ?? 3 * HOUR_MS);
  }

  #digestDue(): boolean {
    const at = this.#o.digestAt;
    if (!at) return false;
    const { catalog } = this.#o;
    const now = this.#now();
    const today = localDay(now);
    const reached = now.getHours() * 60 + now.getMinutes() >= at.hour * 60 + at.minute;
    const last = catalog.getState(STATE.digestDate);
    if (last === undefined) {
      // The first time the bot runs with this on: no surprise message in the middle of the day. Today's comes at the
      // scheduled time if that's still ahead, otherwise the first one is tomorrow's.
      catalog.setState(STATE.digestDate, reached ? today : localDay(new Date(now.getTime() - 24 * HOUR_MS)));
      return false;
    }
    if (last === today || !reached) return false;
    const retryAfter = Date.parse(catalog.getState(STATE.digestRetryAfter) ?? '');
    return Number.isNaN(retryAfter) || now.getTime() >= retryAfter;
  }
}
