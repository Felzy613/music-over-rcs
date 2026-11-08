import { waitingArtistsReplies, type ArtistList } from './bot.ts';
import { inQuietHours, type DailyTime } from './library/jobs.ts';
import { liveValue, type Live } from './live.ts';
import type { Reply } from './types.ts';

// Tells the owner, once, about each artist that is waiting for their word (see zemer-whitelist.ts). The chat is how they
// answer, so the news goes there rather than to a log nobody reads. Nothing is said in the quiet hours or while the bridge
// can't pass it on, and an artist is told about once even across restarts.

const TOLD_KEY = 'whitelist.told';

export interface WaitingNoticeDeps {
  list: Pick<ArtistList, 'pending'>;
  state: { getState(key: string): string | undefined; setState(key: string, value: string): void };
  /** Sends the replies to the chat; rejects when they could not be sent (then it is tried again at the next check). */
  announce(replies: Reply[]): Promise<void>;
  /** Whether the chat can take a message now (the bridge is connected). */
  ready?: () => boolean;
  quiet?: Live<{ from: DailyTime; to: DailyTime } | undefined>;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Returns the check to run every minute or so. It never throws, and never runs two sends at once. */
export function createWaitingNotice(deps: WaitingNoticeDeps): () => Promise<void> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  let sending = false;

  const told = (): Set<string> => {
    try {
      const saved: unknown = JSON.parse(deps.state.getState(TOLD_KEY) ?? '[]');
      return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  };

  return async () => {
    if (sending) return;
    const waiting = deps.list.pending();
    if (waiting.length === 0) return;
    const already = told();
    if (waiting.every((artist) => already.has(artist.id))) return;
    if (inQuietHours(liveValue(deps.quiet), now()) || deps.ready?.() === false) return;
    sending = true;
    try {
      await deps.announce(waitingArtistsReplies(waiting));
      deps.state.setState(TOLD_KEY, JSON.stringify([...new Set([...already, ...waiting.map((artist) => artist.id)])]));
      log(`told the owner about ${waiting.length} artist${waiting.length === 1 ? '' : 's'} waiting for a word`);
    } catch (err) {
      log(`could not tell the owner about the artists waiting for a word (${err instanceof Error ? err.message : String(err)}); trying again`);
    } finally {
      sending = false;
    }
  };
}
