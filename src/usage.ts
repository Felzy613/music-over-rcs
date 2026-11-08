/**
 * How much has been sent out this month, kept in the catalog's small-facts table. A cloud host's plan includes only so much
 * outbound traffic a month (Render's free plan: 5 GB), and going over suspends the service, so the total is worth watching.
 * Only what the bot uploads to the homeserver is counted (songs and pictures, which the bridge then sends to Google);
 * it is a measure of the largest part, not an invoice.
 *
 * Each person has a count of their own (`usage.<month>.<id>.sent_bytes`, from their own Matrix client's `onUpload`: see
 * `sentCounter`), and the owner keeps the key every release before there were people used (`usage.<month>.sent_bytes`). The host's
 * total, which is what Render's allowance is spent by, is everybody's together; a person's share is held to a monthly cap
 * (`monthlyAllowance`), the owner's is not.
 */
import { liveValue, type Live } from './live.ts';
import { OWNER_ID, PERSON_ID_PATTERN, personIdProblem, type Person } from './people.ts';

interface StateStore {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

/** Whose bytes: a person or their id. Nothing said is the owner. */
export type Sender = string | Pick<Person, 'id'>;

const MB = 1048576;
const megabytes = (bytes: number): number => Math.round(bytes / MB);
const monthOf = (now: Date): string => now.toISOString().slice(0, 7);

/** A person's id, or the owner's. Throws on a name that cannot be a person's (it would make a key that is not theirs). */
function idOf(who: Sender): string {
  const id = typeof who === 'string' ? who : who.id;
  if (id === OWNER_ID) return id;
  const problem = personIdProblem(id);
  if (problem) throw new Error(`usage: ${problem}`);
  return id;
}

/** The owner's key is the one it has always been; anyone else's has their id in it (an id has no dots or underscores, so no key is another's). */
const sentKey = (now: Date, id: string): string => (id === OWNER_ID ? `usage.${monthOf(now)}.sent_bytes` : `usage.${monthOf(now)}.${id}.sent_bytes`);

/** Who besides the owner has sent anything this month, comma-separated: so the total finds a person who has since left the list. */
const sendersKey = (now: Date): string => `usage.${monthOf(now)}.people`;

/** The people besides the owner who have sent something in `now`'s month, in alphabetical order. */
export function sendersThisMonth(state: StateStore, now: Date = new Date()): string[] {
  const ids = (state.getState(sendersKey(now)) ?? '').split(',').filter((id) => PERSON_ID_PATTERN.test(id));
  return [...new Set(ids)].sort();
}

/** Counts what was sent to one person's chat (the owner's unless said). Written once per file, never on a timer. */
export function addSent(state: StateStore, bytes: number, now: Date = new Date(), who: Sender = OWNER_ID): void {
  const id = idOf(who);
  if (!(bytes > 0)) return;
  if (id !== OWNER_ID) {
    // Written the first time a person sends in a month, not every time.
    const known = sendersThisMonth(state, now);
    if (!known.includes(id)) state.setState(sendersKey(now), [...known, id].sort().join(','));
  }
  const key = sentKey(now, id);
  state.setState(key, String((Number(state.getState(key)) || 0) + Math.round(bytes)));
}

/** What was sent to one person's chat this month (the owner's unless said). */
export function sentThisMonth(state: StateStore, now: Date = new Date(), who: Sender = OWNER_ID): number {
  return Number(state.getState(sentKey(now, idOf(who)))) || 0;
}

/** Each sender's share of this month's songs and pictures sent: the owner first, then the people who sent any, by name. */
export function sentShares(state: StateStore, now: Date = new Date()): Array<{ id: string; bytes: number }> {
  const people = sendersThisMonth(state, now)
    .map((id) => ({ id, bytes: sentThisMonth(state, now, id) }))
    .filter((share) => share.bytes > 0);
  return [{ id: OWNER_ID, bytes: sentThisMonth(state, now) }, ...people];
}

/** What the host sent in songs and pictures this month: everybody's together. */
export function sentByEveryone(state: StateStore, now: Date = new Date()): number {
  return sentShares(state, now).reduce((total, share) => total + share.bytes, 0);
}

/**
 * What the onUpload hook of a person's Matrix client calls with the size of each file it uploads: the bytes count toward that
 * person (the owner when nothing is said). A person with a name that cannot be theirs is refused here, once, not at each upload.
 */
export function sentCounter(state: StateStore, who: Sender = OWNER_ID, clock: () => Date = () => new Date()): (bytes: number) => void {
  const id = idOf(who);
  return (bytes) => addSent(state, bytes, clock(), id);
}

const archivedKey = (now: Date): string => `usage.${monthOf(now)}.archived_bytes`;

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
 * ONEDRIVE_MAX_MB_PER_MONTH should stop the OneDrive copies well before this, and PERSON_MAX_MB_PER_MONTH what each person is sent.
 */
export const TRAFFIC_ALERT_BYTES = 4000 * 1048576;

/** What the bot sent out this month: songs and pictures sent to everybody, and copies saved to OneDrive. */
export function trafficThisMonth(state: StateStore, now: Date = new Date()): number {
  return sentByEveryone(state, now) + archivedThisMonth(state, now);
}

/**
 * What to say about this month's traffic: a problem past TRAFFIC_ALERT_BYTES, nothing otherwise. It counts everybody's songs, and
 * once anyone but the owner has been sent some it says how much went to each (the mail goes to the owner, so theirs is "you").
 */
export function trafficProblem(state: StateStore, now: Date = new Date()): string | undefined {
  const used = trafficThisMonth(state, now);
  if (used < TRAFFIC_ALERT_BYTES) return undefined;
  const mb = (bytes: number): string => `${megabytes(bytes).toLocaleString('en-US')} MB`;
  const shares = sentShares(state, now);
  const others = shares.slice(1);
  const songs = others.length === 0 ? `${mb(shares[0]!.bytes)} of songs` : [`${mb(shares[0]!.bytes)} of songs for you`, ...others.map((share) => `${mb(share.bytes)} for ${share.id}`)].join(', ');
  const fix = others.length === 0 ? 'Lower ONEDRIVE_MAX_MB_PER_MONTH in Render' : 'Lower PERSON_MAX_MB_PER_MONTH or ONEDRIVE_MAX_MB_PER_MONTH in Render';
  return `The host has sent ${mb(used)} this month (${songs}, ${mb(archivedThisMonth(state, now))} of OneDrive copies); Render's free plan includes about 5,000 MB and charges past it. ${fix}, or ask for fewer albums until the month is over.`;
}

export interface MonthlyAllowanceOptions {
  state: StateStore;
  /** Whose share this is. The owner has no cap: their allowance never refuses. */
  person: Sender;
  /** The most that may be sent to this person in a calendar month, in bytes (PERSON_MAX_MB_PER_MONTH). Undefined for no limit. */
  maxBytes: Live<number | undefined>;
  now?: () => Date;
}

/**
 * The runner's `allowance` for one person: what to answer, in place of a song or an album, once this month's cap is reached, and
 * nothing while there is room. It is asked as an answer is decided, so what is already on its way still arrives, and the count is
 * what the person's own Matrix client has uploaded (a soft limit: a file already queued is not held to it).
 */
export function monthlyAllowance(options: MonthlyAllowanceOptions): () => string | undefined {
  const id = idOf(options.person);
  if (id === OWNER_ID) return () => undefined;
  const clock = options.now ?? (() => new Date());
  return () => {
    const cap = liveValue(options.maxBytes);
    if (cap === undefined) return undefined;
    const used = sentThisMonth(options.state, clock(), id);
    if (used < cap) return undefined;
    const mb = (bytes: number): string => `${megabytes(bytes).toLocaleString('en-US')}`;
    return `🎵 You've used this month's share of songs (${mb(used)} of ${mb(cap)} MB), so no more songs or albums until next month. Searching and browsing still work.`;
  };
}

/** The people besides the owner as /status lists them: what has been sent to each this month and the cap they are held to (null: none). */
export function peopleTraffic(
  state: StateStore,
  people: readonly Sender[],
  maxBytes: Live<number | undefined>,
  now: Date = new Date(),
): Array<{ id: string; sentThisMonthMb: number; monthlyLimitMb: number | null }> {
  const cap = liveValue(maxBytes);
  return people.map((who) => {
    const id = idOf(who);
    return { id, sentThisMonthMb: megabytes(sentThisMonth(state, now, id)), monthlyLimitMb: cap === undefined ? null : megabytes(cap) };
  });
}
