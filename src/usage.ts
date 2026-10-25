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

/**
 * Past this much sent and saved in a month the host says so (a problem, mailed): Render's free plan includes about 5,000 MB of
 * outbound traffic and charges past it, or suspends a service with no card on file, and the owner spends no more (2026-10-20).
 * ONEDRIVE_MAX_MB_PER_MONTH should stop the OneDrive copies well before this.
 */
export const TRAFFIC_ALERT_BYTES = 4000 * 1048576;

/** What the bot sent out this month: songs and pictures sent, and copies saved to OneDrive. */
export function trafficThisMonth(state: StateStore, now: Date = new Date()): number {
  return sentThisMonth(state, now) + archivedThisMonth(state, now);
}

/** What to say about this month's traffic: a problem past TRAFFIC_ALERT_BYTES, nothing otherwise. */
export function trafficProblem(state: StateStore, now: Date = new Date()): string | undefined {
  const used = trafficThisMonth(state, now);
  if (used < TRAFFIC_ALERT_BYTES) return undefined;
  const mb = (bytes: number): string => `${Math.round(bytes / 1048576).toLocaleString('en-US')} MB`;
  return `The host has sent ${mb(used)} this month (${mb(sentThisMonth(state, now))} of songs, ${mb(archivedThisMonth(state, now))} of OneDrive copies); Render's free plan includes about 5,000 MB and charges past it. Lower ONEDRIVE_MAX_MB_PER_MONTH in Render, or ask for fewer albums until the month is over.`;
}
