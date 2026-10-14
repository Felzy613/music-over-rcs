/**
 * How much has been sent out this month, kept in the catalog's small-facts table. A cloud host's plan includes only so much
 * outbound traffic a month (Render's free plan: 5 GB), and going over suspends the service, so the total is worth watching.
 * Only what the bot uploads to the homeserver is counted (songs and pictures, which the bridge then sends to Google);
 * it is a measure of the largest part, not an invoice.
 */
interface StateStore {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

const keyFor = (now: Date): string => `usage.${now.toISOString().slice(0, 7)}.sent_bytes`;

export function addSent(state: StateStore, bytes: number, now: Date = new Date()): void {
  if (!(bytes > 0)) return;
  const key = keyFor(now);
  state.setState(key, String((Number(state.getState(key)) || 0) + Math.round(bytes)));
}

export function sentThisMonth(state: StateStore, now: Date = new Date()): number {
  return Number(state.getState(keyFor(now))) || 0;
}

const archivedKey = (now: Date): string => `usage.${now.toISOString().slice(0, 7)}.archived_bytes`;

/** Counts a song uploaded to the cloud archive this month (it uses the same outbound traffic as a song sent). */
export function addArchived(state: StateStore, bytes: number, now: Date = new Date()): void {
  if (!(bytes > 0)) return;
  const key = archivedKey(now);
  state.setState(key, String((Number(state.getState(key)) || 0) + Math.round(bytes)));
}

export function archivedThisMonth(state: StateStore, now: Date = new Date()): number {
  return Number(state.getState(archivedKey(now))) || 0;
}
