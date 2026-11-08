import { scoped, type Person } from '../people.ts';

// The gate a second person goes through before they count as set up. The bridge keeps only the "message yourself" chat by dropping every
// conversation that is not one-to-one with one of the phone's own numbers (deploy/cloud/patches/gmessages-only-self-chat.patch), and that patch fails
// OPEN: a login that tells the bridge no number keeps every chat. Copying all of someone's chats onto this host is what used up Render's
// traffic and got the service suspended on 2026-10-29, so a person is not onboarded just because their login is connected. They are onboarded
// once their own chat has actually ARRIVED (the bridge made its room, found by the SIM number the phone gave), within a few minutes of linking.
// A phone that gives a number which does not match its chat never gets there, and the page says to unlink it: the only other way to get its chat,
// GMESSAGES_ALL_CHATS=1, is for the whole host and would bring every chat of everyone back.
//
// The owner is not run through this (their setup is the Connect page's checklist, as it always was).

type StateStore = { getState(key: string): string | undefined; setState(key: string, value: string): void };

/** How long after a person is linked their own chat has to arrive ("a few minutes": they text themself right after linking). */
export const ONBOARDING_GRACE_MS = 10 * 60_000;
/** How long Google Messages has to tell the bridge the phone's number before the page stops saying "give it a minute". */
export const NUMBER_GRACE_MS = 2 * 60_000;

/** The state keys (a person's id is added to each): when the login was first seen connected, and when their own chat was first seen. */
export const LINKED_KEY = 'onboarding.linked';
export const PROVED_KEY = 'onboarding.proved';

/**
 * What the bridge says of a person's login: `none` (it answered, and there is no login at all), `unknown` (it did not answer, or the person's
 * account is not signed in yet), `linked` (connected), `other` (a login in some other state: connecting, disconnected, signed out).
 */
export type LoginKind = 'none' | 'unknown' | 'linked' | 'other';

export function loginKind(status: { state?: string | undefined; error?: string | undefined }): LoginKind {
  if (status.state === undefined) return status.error === undefined ? 'none' : 'unknown';
  return status.state === 'CONNECTED' || status.state === 'BACKFILLING' ? 'linked' : 'other';
}

export type OnboardingStep = 'not-linked' | 'no-number' | 'waiting-for-chat' | 'chat-missing' | 'onboarded';

export interface OnboardingReport {
  step: OnboardingStep;
  /** True once the person's own chat has arrived: the only state that counts as set up. */
  onboarded: boolean;
  /** The owner has something to do about it now (unlink the person). */
  warn: boolean;
  /** When the login was first seen connected (ISO), while it is linked. */
  linkedSince: string | null;
  /** When the person's own chat was first seen (ISO). */
  provedAt: string | null;
  /** When the chat has to arrive by, while it is waited for (ISO). */
  chatDueBy: string | null;
  /** What to tell the owner, in plain words. */
  message: string;
}

export interface Seen {
  login: LoginKind;
  /** Whether the person's login reports a SIM number (`Seat.hasSimNumber`): null when that cannot be read. */
  simNumber: boolean | null;
  /** Whether the bridge has made the person's own chat (or the bot is already in it). */
  chatFound: boolean;
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export class Onboarding {
  readonly person: Person;
  #state: StateStore;
  #now: () => number;
  #graceMs: number;

  constructor(options: { state: StateStore; person: Person; now?: () => number; graceMs?: number }) {
    if (options.person.owner) throw new Error('the owner is not run through the onboarding gate: it is for the people besides the owner');
    this.person = options.person;
    this.#state = options.state;
    this.#now = options.now ?? Date.now;
    this.#graceMs = options.graceMs ?? ONBOARDING_GRACE_MS;
  }

  #key(base: string): string {
    return scoped(base, this.person);
  }

  #read(base: string): string | null {
    return this.#state.getState(this.#key(base)) || null;
  }

  /** Written once: the second look at the same fact changes nothing, so asking every few seconds costs the database nothing. */
  #once(base: string): string {
    const kept = this.#read(base);
    if (kept && Number.isFinite(Date.parse(kept))) return kept;
    const at = new Date(this.#now()).toISOString();
    this.#state.setState(this.#key(base), at);
    return at;
  }

  /**
   * Where the person stands, given what is seen now. A login the bridge says is gone altogether (a deliberate unlink) forgets how far they got, so a
   * person put back later on another phone starts again; a login that is only disconnected (Google unpaired it, the phone is off) does not.
   */
  evaluate(seen: Seen): OnboardingReport {
    const id = this.person.id;
    if (seen.login === 'none') {
      for (const base of [LINKED_KEY, PROVED_KEY]) if (this.#read(base)) this.#state.setState(this.#key(base), '');
    }
    const proved = this.#read(PROVED_KEY);
    const report = (step: OnboardingStep, message: string, extra: Partial<OnboardingReport> = {}): OnboardingReport => ({
      step,
      onboarded: step === 'onboarded',
      warn: false,
      linkedSince: this.#read(LINKED_KEY),
      provedAt: this.#read(PROVED_KEY),
      chatDueBy: null,
      message,
      ...extra,
    });

    if (seen.login !== 'linked') {
      // Not connected right now: what was proved stays proved (the bridge's own watch reports a login that dropped), and nothing is learned or written.
      if (proved) return report('onboarded', `${id} was set up: their own chat arrived. Google Messages is not connected right now.`);
      return report(
        'not-linked',
        seen.login === 'unknown' ? `The bridge did not answer, so nothing is known of ${id}'s link yet.` : seen.login === 'other' ? `${id}'s Google Messages is not connected to the bridge (yet).` : `${id}'s Google Messages is not linked yet.`,
      );
    }

    const linkedSince = this.#once(LINKED_KEY);
    const age = Math.max(0, this.#now() - Date.parse(linkedSince));
    // A login with no number is the dangerous one, whatever else is true: it keeps every chat the person has.
    if (seen.simNumber === false) {
      return report(
        'no-number',
        age < NUMBER_GRACE_MS
          ? `Google Messages has not told the bridge ${id}'s phone number yet. Give it a minute or two; if it is still missing, unlink ${id} (below).`
          : `The bridge has no phone number for ${id}'s phone. Without it the bridge cannot tell their own chat from the others and copies ALL of their chats onto this host, the traffic that got the service suspended on 2026-10-29. Unlink ${id} now (below) and do not set up this phone.`,
        { warn: true, linkedSince },
      );
    }
    if (proved || seen.chatFound) {
      const provedAt = proved ?? this.#once(PROVED_KEY);
      return report('onboarded', `${id} is linked and their own chat has arrived.`, { linkedSince, provedAt });
    }
    const dueBy = new Date(Date.parse(linkedSince) + this.#graceMs);
    if (age <= this.#graceMs) {
      return report('waiting-for-chat', `${id} is linked. Waiting for ${id} to text themself once from their phone: the bridge makes their chat only when they do, and it has to arrive within ${minutes(this.#graceMs)} minutes of linking (by ${dueBy.toISOString().slice(11, 16)} UTC).`, {
        linkedSince,
        chatDueBy: dueBy.toISOString(),
      });
    }
    return report(
      'chat-missing',
      `${id}'s own chat has not arrived ${minutes(age)} minutes after linking. Ask them to text themself once more. If it still does not arrive, the number their phone gives the bridge does not match their chat, and this host cannot set them up: unlink ${id} (below) and take them out of PEOPLE. The only other way, GMESSAGES_ALL_CHATS=1, is for the whole host and would bring every chat of everyone back (the traffic that got the service suspended on 2026-10-29).`,
      { warn: true, linkedSince, chatDueBy: dueBy.toISOString() },
    );
  }
}
