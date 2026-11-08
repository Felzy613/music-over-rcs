import { SourceError } from '../bot.ts';

// The artist whitelist the Zemer app filters YouTube Music with (github.com/ZemerTeam/zemer-app, docs/whitelist): a
// curated list of artist channels, each flagged female or not, plus a list of single songs to hide even when their
// artist is on it. Zemer reads both from its public content mirror, content.zemer.io, without signing in, and so does
// this: `/whitelist/version` says whether the list changed, `/whitelist` is the list, `/blockedContentIds` the songs.
//
// This bot always filters the way Zemer does with female singers turned off (Zemer's default): a song is let through
// only when one of its artists is on the list and none of its artists is flagged female, and never when its id is on
// the blocked list. With no list to filter by there is no answer rather than an unfiltered one, as in Zemer.
//
// Since early November 2026 content.zemer.io answers only the signed official app (Cloudflare turns everything else
// away with HTTP 403), and that is Zemer's to decide: nothing here imitates the app. When the server refuses, the list
// is frozen at its last good copy and the owner keeps it up to date from the chat:
//   - an artist that Zemer's public releases feed shows but the copy doesn't know is *waiting*: Zemer has put them on its
//     list, but the feed doesn't say whether they are a woman, so their songs stay hidden until the owner says ("allow");
//   - "block" hides an artist the copy lets through (someone Zemer has since taken off, or a song that leaks);
//   - a block always wins, and an allow never overrides Zemer's own female flag.
// These decisions are kept apart from Zemer's list and are never replaced by it. If the server ever answers again, its
// list becomes the base once more and the decisions stay on top.
//
// The admin console (src/admin/) adds two more decisions of the owner's, kept in the same place:
//   - a song allowed by its YouTube video id, for one song by an artist who is not on the list: it is still refused when
//     one of the artists credited on it (as they were when it was allowed, and as they are now) is blocked by the owner or
//     flagged female by Zemer, and a song on Zemer's blocked list stays blocked until the owner unblocks that very song;
//   - an artist allowed or blocked by channel id alone (found on YouTube Music, before Zemer's feed ever shows them).
// Allowing needs the owner's word that no woman is credited, which the console asks for and these methods take as given.

export const ZEMER_CONTENT_URL = 'https://content.zemer.io';

const STATE_KEY = 'zemer.whitelist';
const OWNER_KEY = 'zemer.whitelist.owner';
const WHITELIST_TIMEOUT_MS = 20_000;
const SMALL_TIMEOUT_MS = 8_000;
/** The list changes through the day as music comes out, so it is never trusted for longer than this without asking. */
const CHECK_EVERY_MS = 5 * 60_000;
/** A search waits at most this long for that question to be answered, then goes on with the list it has. */
const PATIENCE_MS = 2_000;
/** After a failed check, the next is not tried for this long. */
const RETRY_AFTER_MS = 60_000;
/** After the server has turned the bot away (HTTP 401 or 403), it is left alone this long: asking again changes nothing. */
const REFUSED_RETRY_MS = 3 * 60 * 60_000;
const WATCH_EVERY_MS = 10 * 60_000;
/** A channel id as YouTube writes it. The releases feed is not ours, so nothing else becomes a waiting artist. */
const CHANNEL_ID = /^UC[\w-]{10,60}$/;
const MAX_WAITING = 200;
const MAX_NAME_CHARS = 80;
/** The most artists the owner can have allowed, and blocked, and the most songs allowed or unblocked: the decisions are kept in one small value. */
const MAX_DECIDED = 2000;
const MAX_SONGS = 1000;
/** A YouTube video id. */
const VIDEO_ID = /^[\w-]{11}$/;
/** What an artist's id looks like in a song's credits (YouTube's are "UC" and 22 characters; kept loose for the ones a song carries). */
const CREDIT_ID = /^[\w-]{3,64}$/;

/** A problem whose message is fit to show to the user. */
export class ZemerWhitelistError extends SourceError {
  /** The server answered but turned the bot away (HTTP 401 or 403): it now answers only Zemer's own app. */
  readonly refused: boolean;
  constructor(message: string, refused = false) {
    super(message);
    this.name = 'ZemerWhitelistError';
    this.refused = refused;
  }
}

export interface WhitelistedArtist {
  name: string;
  /** How the name is written in the other alphabet, when the list says ("Netanel Zalevski" for "נתנאל זלבסקי"). */
  altName?: string;
  female: boolean;
}

/** Why a song was let through or held back, in plain words. `owner` is an artist the owner blocked. */
export type Verdict = { ok: true } | { ok: false; why: 'blocked' | 'female' | 'not on the list' | 'owner' };

/** What is kept between runs: the list, and the version it was fetched at. */
interface Saved {
  gate: number;
  checkedAt: number;
  /** [channel id, name, 1 if flagged female, the name in the other alphabet] */
  artists: Array<[string, string, 0 | 1] | [string, string, 0 | 1, string]>;
  blocked: string[];
}

/**
 * What the owner decided, kept apart from Zemer's list. Each artist is [channel id, name, when it was decided]; a waiting one is
 * [channel id, name, when it was first seen]. The songs are the owner's per-song decisions (see the top of this file).
 */
interface OwnerSaved {
  allowed: Array<[string, string] | [string, string, number]>;
  blocked: Array<[string, string] | [string, string, number]>;
  waiting: Array<[string, string, number]>;
  allowedSongs?: AllowedSong[];
  unblockedSongs?: UnblockedSong[];
}

/** A song the owner allowed by itself. `artistIds` are the channels credited on it when it was allowed, checked again at every send. */
export interface AllowedSong {
  id: string;
  title: string;
  artist: string;
  artistIds: string[];
  at: number;
}

/** A song on Zemer's blocked list that the owner chose to let through (it must still pass the artist rules). */
export interface UnblockedSong {
  id: string;
  title: string;
  at: number;
}

/** How many decisions the owner has made, of each kind (the songs are the ones decided one by one). */
export interface OwnerCounts {
  allowed: number;
  blocked: number;
  waiting: number;
  allowedSongs: number;
  unblockedSongs: number;
}

/** An artist the owner decided on, and when. */
export interface DecidedArtist extends NamedArtist {
  at: number | null;
}

/** An artist as the chat names them. */
export interface NamedArtist {
  id: string;
  name: string;
}

export interface ZemerWhitelistOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Where the list is kept between runs (the catalog's state table). Without one it is kept in memory only. */
  state?: { getState(key: string): string | undefined; setState(key: string, value: string): void } | undefined;
  /** How old the list may be before a search asks whether it changed. */
  checkEveryMs?: number;
  /** How long a search waits for that answer. */
  patienceMs?: number;
  retryAfterMs?: number;
  /** How long a server that turned the bot away is left alone. */
  refusedRetryMs?: number;
  now?: () => number;
}

/** A name for comparing: any case, one space between words. */
const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');
/** The ways an artist may be called: the whole name, and each half of a dual "English - עברית" name. */
const callings = (...names: Array<string | undefined>): Set<string> => {
  const keys = new Set<string>();
  for (const name of names) {
    if (!name?.trim()) continue;
    keys.add(nameKey(name));
    for (const part of name.split(/\s+[-–—]\s+/)) if (part.trim()) keys.add(nameKey(part));
  }
  return keys;
};
/**
 * A name from outside, fit to show in the chat: no control characters, nothing that changes the direction text is drawn in
 * (the bot sets its own marks), not endless. Hebrew letters themselves are kept.
 */
const cleanName = (name: string): string =>
  name
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁠-⁩﻿]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS);

const record =(value: unknown): Record<string, unknown> | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export class ZemerWhitelist {
  readonly baseUrl: string;
  #fetch: typeof fetch;
  #state: ZemerWhitelistOptions['state'];
  #checkEvery: number;
  #patience: number;
  #retryAfter: number;
  #refusedRetry: number;
  #now: () => number;
  #artists = new Map<string, WhitelistedArtist>();
  /** The artists by name, made when first asked for and again after the list or the owner's decisions change. */
  #byName: Map<string, string[]> | undefined;
  #blocked = new Set<string>();
  #gate: number | undefined;
  #checkedAt = 0;
  #retryAt = 0;
  /** When the server first turned the bot away, until it next answers properly. */
  #refusedAt: number | undefined;
  #lastError: ZemerWhitelistError | undefined;
  #flight: Promise<void> | undefined;
  #watching: NodeJS.Timeout | undefined;
  /** The owner's decisions (see the top of this file). */
  #allowed = new Map<string, string>();
  #refused = new Map<string, string>();
  #waiting = new Map<string, { name: string; since: number }>();
  /** When the owner allowed or blocked each artist in the two maps above (an artist is in at most one of them). */
  #decidedAt = new Map<string, number>();
  #songsAllowed = new Map<string, AllowedSong>();
  #songsUnblocked = new Map<string, UnblockedSong>();

  constructor(options: ZemerWhitelistOptions = {}) {
    this.baseUrl = (options.baseUrl ?? ZEMER_CONTENT_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
    this.#state = options.state;
    this.#checkEvery = options.checkEveryMs ?? CHECK_EVERY_MS;
    this.#patience = options.patienceMs ?? PATIENCE_MS;
    this.#retryAfter = options.retryAfterMs ?? RETRY_AFTER_MS;
    this.#refusedRetry = options.refusedRetryMs ?? REFUSED_RETRY_MS;
    this.#now = options.now ?? Date.now;
    this.#restore();
    this.#restoreOwner();
  }

  /**
   * Whether Zemer's server has turned the bot away and not answered since. The list is then the last good copy plus the
   * owner's decisions: it can't learn what Zemer changes, so a new artist waits for the owner's word.
   */
  get frozen(): boolean {
    return this.#refusedAt !== undefined;
  }

  /** How many artists the owner has allowed and blocked, and how many are waiting for a word. */
  get owner(): { allowed: number; blocked: number; waiting: number } {
    return { allowed: this.#allowed.size, blocked: this.#refused.size, waiting: this.pending().length };
  }

  /** How many artists are on the list, and how many songs are blocked. */
  get size(): { artists: number; blocked: number } {
    return { artists: this.#artists.size, blocked: this.#blocked.size };
  }

  /** Whether there is a list to filter by (kept from an earlier run, or fetched). */
  get loaded(): boolean {
    return this.#artists.size > 0;
  }

  /** How long ago the list was last confirmed to be the server's current one; Infinity when there is no list. */
  get ageMs(): number {
    return this.loaded ? this.#now() - this.#checkedAt : Infinity;
  }

  /**
   * Makes sure the list is current before it is used. With none, it is fetched now (rejecting if that can't be done).
   * With one that was last confirmed more than `checkEveryMs` ago, the server is asked whether it changed (a request of
   * about a hundred bytes) and a new list is fetched if so; a search waits a couple of seconds for that and otherwise
   * goes on with the list it has, which is the last good one: a failed check never empties or replaces it.
   */
  async ready(): Promise<void> {
    if (!this.loaded) {
      // Turned away and nothing to filter by: say so again without asking again, a search at a time.
      if (this.#refusedAt !== undefined && this.#lastError && this.#now() < this.#retryAt) throw this.#lastError;
      return this.#refresh();
    }
    if (this.ageMs < this.#checkEvery || this.#now() < this.#retryAt) return;
    const check = this.#refresh().catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([check, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.#patience)))]);
    clearTimeout(timer);
  }

  /**
   * Keeps the list current while the bot runs, whether or not anyone searches: checks every ten minutes and reports
   * each check's outcome (an error message when it failed), so a list that has stopped updating can be flagged.
   * Returns a function that stops it.
   */
  watch(onCheck?: (error: string | undefined) => void, everyMs = WATCH_EVERY_MS): () => void {
    this.#watching ??= setInterval(() => {
      // A server that has turned the bot away is not asked again until its wait is over; the last answer is reported.
      if (this.#refusedAt !== undefined && this.#lastError && this.#now() < this.#retryAt) {
        onCheck?.(this.#lastError.message);
        return;
      }
      this.#refresh().then(
        () => onCheck?.(undefined),
        (err: unknown) => onCheck?.(err instanceof Error ? err.message : String(err)),
      );
    }, everyMs);
    this.#watching.unref();
    return () => {
      clearInterval(this.#watching);
      this.#watching = undefined;
    };
  }

  /** Starts getting the list so the first search doesn't wait for it. A failure is left for `ready` to report. */
  warm(): Promise<void> {
    return this.ready().catch(() => {});
  }

  /**
   * Whether a song is let through: `ids` are the channel ids of the artists credited on it. A song the owner allowed by itself
   * passes without its artist being on the list, but the artists credited on it when it was allowed count as credited now too,
   * so a song whose credits are not known any more (a stored song with no ids) is still held to the blocks and the female flag.
   */
  verdict(videoId: string, ids: readonly string[]): Verdict {
    const song = this.#songsAllowed.get(videoId);
    // Zemer's blocked songs stay blocked unless the owner unblocked that very song.
    if (this.#blocked.has(videoId) && !this.#songsUnblocked.has(videoId)) return { ok: false, why: 'blocked' };
    let listed = false;
    for (const id of song ? new Set([...ids, ...song.artistIds]) : ids) {
      // The owner's block wins over everything, so it is looked at before the list.
      if (this.#refused.has(id)) return { ok: false, why: 'owner' };
      const artist = this.#artists.get(id);
      if (!artist) {
        if (this.#allowed.has(id)) listed = true;
        continue;
      }
      // One woman among the credits is enough: the song is a female singer's, whoever else is on it.
      if (artist.female) return { ok: false, why: 'female' };
      listed = true;
    }
    return listed || song ? { ok: true } : { ok: false, why: 'not on the list' };
  }

  /** Whether the owner allowed this song by itself (so a gate may let it through when its credits aren't stored). */
  songAllowed(videoId: string): boolean {
    return this.#songsAllowed.has(videoId);
  }

  allows(videoId: string, ids: readonly string[]): boolean {
    return this.verdict(videoId, ids).ok;
  }

  /** An artist on the list (Zemer's, or one the owner allowed), by channel id. */
  artist(id: string): WhitelistedArtist | undefined {
    const listed = this.#artists.get(id);
    if (listed) return listed;
    const name = this.#allowed.get(id);
    return name ? { name, female: false } : undefined;
  }

  /**
   * The channel ids of the artists on the list called this (by their name or the name in the other alphabet, any case),
   * for a credit that comes as a name only. Empty when nobody on the list is.
   */
  idsNamed(name: string): string[] {
    const wanted = nameKey(name);
    if (!wanted) return [];
    if (!this.#byName) {
      this.#byName = new Map();
      const add = (id: string, ...written: Array<string | undefined>) => {
        for (const one of written) {
          const key = one ? nameKey(one) : '';
          if (key) this.#byName!.set(key, [...(this.#byName!.get(key) ?? []), id]);
        }
      };
      for (const [id, artist] of this.#artists) add(id, artist.name, artist.altName);
      for (const [id, allowedName] of this.#allowed) if (!this.#artists.has(id)) add(id, allowedName);
    }
    return this.#byName.get(wanted) ?? [];
  }

  /**
   * An artist that Zemer's releases feed shows but this list doesn't know. Only noted while the list is frozen (when the
   * server answers, its list is the authority and an artist it lacks is not Zemer's to vouch for), and only for something
   * that is a channel id, since the feed is not ours. They stay hidden until `allow`. Returns whether this one is new.
   */
  consider(id: string, name: string): boolean {
    const clean = cleanName(name);
    if (!this.frozen || !CHANNEL_ID.test(id) || !clean) return false;
    if (this.#artists.has(id) || this.#allowed.has(id) || this.#refused.has(id) || this.#waiting.has(id)) return false;
    if (this.#waiting.size >= MAX_WAITING) return false;
    this.#waiting.set(id, { name: clean, since: this.#now() });
    this.#saveOwner();
    return true;
  }

  /** The artists waiting for the owner's word, oldest first. */
  pending(): NamedArtist[] {
    return [...this.#waiting]
      .filter(([id]) => !this.#artists.has(id))
      .sort((a, b) => a[1].since - b[1].since)
      .map(([id, { name }]) => ({ id, name }));
  }

  /**
   * Lets an artist's songs through: a waiting one, or one the owner had blocked. `ref` is a channel id or a name (the whole
   * name, or either half of a dual "English - עברית" one). Never lifts Zemer's own female flag. Returns who was allowed.
   */
  allow(ref: string): NamedArtist[] {
    const done: NamedArtist[] = [];
    for (const [id, name] of [...this.#waiting.entries()].map(([id, one]) => [id, one.name] as const).concat([...this.#refused])) {
      if (!this.#is(ref, id, name)) continue;
      const listed = this.#artists.get(id);
      this.#waiting.delete(id);
      this.#refused.delete(id);
      // Someone on Zemer's list needs no allowing; lifting a block puts them back as they were.
      if (!listed) {
        this.#allowed.set(id, name);
        this.#decidedAt.set(id, this.#now());
      } else this.#decidedAt.delete(id);
      done.push({ id, name: listed?.name ?? name });
    }
    if (done.length > 0) this.#changed();
    return done;
  }

  /** Hides an artist's songs: anyone the list lets through, one the owner allowed, or one waiting. Returns who was blocked. */
  block(ref: string): NamedArtist[] {
    const known = new Map<string, string>();
    for (const [id, artist] of this.#artists) if (this.#is(ref, id, artist.name, artist.altName)) known.set(id, artist.name);
    for (const [id, name] of this.#allowed) if (this.#is(ref, id, name)) known.set(id, name);
    for (const [id, one] of this.#waiting) if (this.#is(ref, id, one.name)) known.set(id, one.name);
    for (const [id, name] of known) {
      this.#refused.set(id, name);
      this.#decidedAt.set(id, this.#now());
      this.#allowed.delete(id);
      this.#waiting.delete(id);
    }
    if (known.size > 0) this.#changed();
    return [...known].map(([id, name]) => ({ id, name }));
  }

  /**
   * Lets an artist's songs through by channel id, for the admin console: one found on YouTube Music, one waiting, or one the
   * owner had blocked. The caller has the owner's word that no woman is credited as them. Zemer's own female flag is never lifted:
   * an artist its list flags is refused, whatever is said here. Someone already on Zemer's list needs no allowing (a block on
   * them is lifted, which puts them back as they were).
   */
  admit(id: string, name: string): { ok: true; artist: NamedArtist; already: boolean } | { ok: false; why: string } {
    if (!CHANNEL_ID.test(id)) return { ok: false, why: "that isn't a YouTube channel id (they start with UC)" };
    const listed = this.#artists.get(id);
    if (listed?.female) return { ok: false, why: "Zemer's list flags this artist as a woman, and an allow never lifts that" };
    const known = listed?.name ?? this.#allowed.get(id) ?? this.#refused.get(id) ?? this.#waiting.get(id)?.name;
    const clean = cleanName(name) || known || '';
    if (!clean) return { ok: false, why: 'a name is needed, so the list can be read by a person' };
    const already = this.#allowed.has(id) || (listed !== undefined && !this.#refused.has(id));
    if (!listed && !this.#allowed.has(id) && this.#allowed.size >= MAX_DECIDED) return { ok: false, why: `${MAX_DECIDED} artists are allowed already; remove some first` };
    this.#waiting.delete(id);
    this.#refused.delete(id);
    if (!listed) {
      this.#allowed.set(id, this.#allowed.get(id) ?? clean);
      if (!already) this.#decidedAt.set(id, this.#now());
    } else this.#decidedAt.delete(id);
    this.#changed();
    return { ok: true, artist: { id, name: listed?.name ?? this.#allowed.get(id) ?? clean }, already };
  }

  /** Hides an artist by channel id, whether or not they are known: a block always wins. */
  refuse(id: string, name: string): { ok: true; artist: NamedArtist } | { ok: false; why: string } {
    if (!CHANNEL_ID.test(id)) return { ok: false, why: "that isn't a YouTube channel id (they start with UC)" };
    const clean = cleanName(name) || this.#artists.get(id)?.name || this.#allowed.get(id) || this.#refused.get(id) || this.#waiting.get(id)?.name || '';
    if (!clean) return { ok: false, why: 'a name is needed, so the list can be read by a person' };
    if (!this.#refused.has(id) && this.#refused.size >= MAX_DECIDED) return { ok: false, why: `${MAX_DECIDED} artists are blocked already; remove some first` };
    this.#refused.set(id, this.#refused.get(id) ?? clean);
    this.#decidedAt.set(id, this.#decidedAt.get(id) ?? this.#now());
    this.#allowed.delete(id);
    this.#waiting.delete(id);
    this.#changed();
    return { ok: true, artist: { id, name: this.#refused.get(id)! } };
  }

  /**
   * Lifts the owner's block on an artist without allowing them: one on Zemer's list is as the list has them (a woman it flags is
   * still refused), anyone else goes back to being unknown, which is hidden until they are allowed.
   */
  unblock(id: string): NamedArtist | undefined {
    const name = this.#refused.get(id);
    if (name === undefined) return undefined;
    this.#refused.delete(id);
    this.#decidedAt.delete(id);
    this.#changed();
    return { id, name };
  }

  /** Takes an artist off the owner's allowed list (they go back to being unknown, so hidden unless Zemer's list has them). */
  unallow(id: string): NamedArtist | undefined {
    const name = this.#allowed.get(id);
    if (name === undefined) return undefined;
    this.#allowed.delete(id);
    this.#decidedAt.delete(id);
    this.#changed();
    return { id, name };
  }

  /**
   * Allows one song by its YouTube video id, for the admin console, with the artists credited on it as far as they are known
   * (they are checked at every send, so an artist blocked later still stops it). The caller has the owner's word that no woman
   * is credited. Returns the verdict as it stands, since a song may still be held back (Zemer blocks it, an artist is blocked).
   */
  allowSong(song: { id: string; title?: string; artist?: string; artistIds?: readonly string[] }): { ok: true; song: AllowedSong; verdict: Verdict } | { ok: false; why: string } {
    if (!VIDEO_ID.test(song.id)) return { ok: false, why: "that isn't a YouTube video id (11 letters, digits, - and _)" };
    if (!this.#songsAllowed.has(song.id) && this.#songsAllowed.size >= MAX_SONGS) return { ok: false, why: `${MAX_SONGS} songs are allowed already; remove some first` };
    const kept = this.#songsAllowed.get(song.id);
    const artistIds = [...new Set((song.artistIds ?? []).filter((id) => CREDIT_ID.test(id)))].slice(0, 12);
    const entry: AllowedSong = {
      id: song.id,
      title: cleanName(song.title ?? '') || kept?.title || song.id,
      artist: cleanName(song.artist ?? '') || kept?.artist || '',
      artistIds: artistIds.length > 0 ? artistIds : (kept?.artistIds ?? []),
      at: kept?.at ?? this.#now(),
    };
    this.#songsAllowed.set(song.id, entry);
    this.#changed();
    return { ok: true, song: entry, verdict: this.verdict(song.id, entry.artistIds) };
  }

  /** Takes a song off the owner's allowed songs. */
  unallowSong(id: string): AllowedSong | undefined {
    const song = this.#songsAllowed.get(id);
    if (!song) return undefined;
    this.#songsAllowed.delete(id);
    this.#changed();
    return song;
  }

  /**
   * Lets a song through that Zemer's blocked list holds back. Only that song, and only its block: its artists must still pass.
   * Refused for an id Zemer doesn't block (there is nothing to lift).
   */
  unblockSong(id: string, title?: string): { ok: true; song: UnblockedSong } | { ok: false; why: string } {
    if (!VIDEO_ID.test(id)) return { ok: false, why: "that isn't a YouTube video id" };
    if (!this.#blocked.has(id)) return { ok: false, why: "Zemer's list doesn't block that song" };
    if (!this.#songsUnblocked.has(id) && this.#songsUnblocked.size >= MAX_SONGS) return { ok: false, why: `${MAX_SONGS} songs are unblocked already; remove some first` };
    const song: UnblockedSong = { id, title: cleanName(title ?? '') || this.#songsUnblocked.get(id)?.title || id, at: this.#songsUnblocked.get(id)?.at ?? this.#now() };
    this.#songsUnblocked.set(id, song);
    this.#changed();
    return { ok: true, song };
  }

  /** Puts Zemer's block back on a song the owner had unblocked. */
  reblockSong(id: string): UnblockedSong | undefined {
    const song = this.#songsUnblocked.get(id);
    if (!song) return undefined;
    this.#songsUnblocked.delete(id);
    this.#changed();
    return song;
  }

  /** The songs the owner decided on one by one, and Zemer's blocked ones (ids only: the list has no titles). */
  songs(): { allowed: AllowedSong[]; unblocked: UnblockedSong[]; blocked: string[] } {
    return {
      allowed: [...this.#songsAllowed.values()].sort((a, b) => b.at - a.at),
      unblocked: [...this.#songsUnblocked.values()].sort((a, b) => b.at - a.at),
      blocked: [...this.#blocked].sort(),
    };
  }

  /** Where an artist stands, by channel id, in plain terms: for the console to say what an allow or a block would change. */
  standing(id: string): { state: 'blocked' | 'female' | 'listed' | 'allowed' | 'waiting' | 'unknown'; name?: string } {
    const refusedName = this.#refused.get(id);
    if (refusedName !== undefined) return { state: 'blocked', name: refusedName };
    const listed = this.#artists.get(id);
    if (listed) return { state: listed.female ? 'female' : 'listed', name: listed.name };
    const allowedName = this.#allowed.get(id);
    if (allowedName !== undefined) return { state: 'allowed', name: allowedName };
    const waiting = this.#waiting.get(id);
    return waiting ? { state: 'waiting', name: waiting.name } : { state: 'unknown' };
  }

  /** The owner's decisions about artists: who is allowed, blocked and waiting, with when. */
  ownerArtists(): { allowed: DecidedArtist[]; blocked: Array<DecidedArtist & { listed: boolean; female: boolean }>; waiting: Array<NamedArtist & { since: number }> } {
    const decided = ([id, name]: [string, string]): DecidedArtist => ({ id, name, at: this.#decidedAt.get(id) ?? null });
    return {
      allowed: [...this.#allowed].map(decided).sort((a, b) => a.name.localeCompare(b.name)),
      blocked: [...this.#refused].map((entry) => ({ ...decided(entry), listed: this.#artists.has(entry[0]), female: this.#artists.get(entry[0])?.female ?? false })).sort((a, b) => a.name.localeCompare(b.name)),
      waiting: [...this.#waiting]
        .filter(([id]) => !this.#artists.has(id))
        .map(([id, one]) => ({ id, name: one.name, since: one.since }))
        .sort((a, b) => a.since - b.since),
    };
  }

  /** Zemer's saved list, a page of it, for a person to read: anything the query is part of (the name, the other-alphabet name or the channel id). */
  listedArtists(options: { query?: string; limit?: number; offset?: number } = {}): { total: number; matches: Array<{ id: string; name: string; altName: string | null; female: boolean; owner: 'allowed' | 'blocked' | null }> } {
    const wanted = nameKey(options.query ?? '');
    const limit = Math.max(1, Math.min(100, options.limit ?? 50));
    const offset = Math.max(0, options.offset ?? 0);
    const all = [...this.#artists]
      .filter(([id, artist]) => !wanted || id.toLowerCase().includes(wanted) || nameKey(artist.name).includes(wanted) || (artist.altName !== undefined && nameKey(artist.altName).includes(wanted)))
      .sort((a, b) => a[1].name.localeCompare(b[1].name));
    return {
      total: all.length,
      matches: all.slice(offset, offset + limit).map(([id, artist]) => ({ id, name: artist.name, altName: artist.altName ?? null, female: artist.female, owner: this.#refused.has(id) ? 'blocked' : null })),
    };
  }

  /**
   * What the admin console shows about the list: whether it is live or frozen, how old it is, what the server last said, how
   * many artists and blocked songs, and when it may be asked again.
   */
  report(): {
    loaded: boolean;
    frozen: boolean;
    refusedSince: number | null;
    lastError: string | null;
    checkedAt: number | null;
    ageMs: number | null;
    gate: number | null;
    nextAttemptAt: number | null;
    size: { artists: number; blocked: number };
    owner: OwnerCounts;
  } {
    const now = this.#now();
    return {
      loaded: this.loaded,
      frozen: this.frozen,
      refusedSince: this.#refusedAt ?? null,
      lastError: this.#lastError?.message ?? null,
      checkedAt: this.loaded && this.#checkedAt > 0 ? this.#checkedAt : null,
      ageMs: this.loaded ? now - this.#checkedAt : null,
      gate: this.#gate ?? null,
      nextAttemptAt: this.#retryAt > now ? this.#retryAt : null,
      size: this.size,
      owner: { ...this.owner, allowedSongs: this.#songsAllowed.size, unblockedSongs: this.#songsUnblocked.size },
    };
  }

  /**
   * Asks Zemer's server whether its list changed, for the admin console. Without `force` the back-off is respected (nothing is
   * asked while the last answer was a refusal less than three hours ago, or a failure less than a minute ago); with it, one
   * try is made now, and a refusal starts the three hours again. Never rejects.
   */
  async refreshNow(options: { force?: boolean } = {}): Promise<{ ok: boolean; skipped: boolean; message: string }> {
    const now = this.#now();
    if (!options.force && now < this.#retryAt) {
      const minutes = Math.ceil((this.#retryAt - now) / 60_000);
      return { ok: false, skipped: true, message: `${this.#lastError?.message ?? 'The last check failed'}; not asked again for about ${minutes >= 90 ? `${Math.round(minutes / 60)} hours` : `${minutes} minute${minutes === 1 ? '' : 's'}`}. Use the forced try to ask now.` };
    }
    try {
      await this.#refresh();
      return { ok: true, skipped: false, message: `Zemer's list answered: version ${this.#gate}, ${this.#artists.size} artists, ${this.#blocked.size} blocked songs.` };
    } catch (err) {
      return { ok: false, skipped: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Whether `ref` (an id or a name) means the artist with this id and these names. */
  #is(ref: string, id: string, ...names: Array<string | undefined>): boolean {
    const wanted = ref.trim();
    if (!wanted) return false;
    return wanted === id || callings(...names).has(nameKey(wanted));
  }

  #changed(): void {
    this.#byName = undefined;
    this.#saveOwner();
  }

  #refresh(): Promise<void> {
    this.#flight ??= this.#fetchList()
      .catch((err: unknown) => {
        const refused = err instanceof ZemerWhitelistError && err.refused;
        if (refused) {
          this.#refusedAt ??= this.#now();
          this.#lastError = err;
        }
        this.#retryAt = this.#now() + (refused ? this.#refusedRetry : this.#retryAfter);
        throw err;
      })
      .finally(() => {
        this.#flight = undefined;
      });
    return this.#flight;
  }

  async #fetchList(): Promise<void> {
    const first = !this.loaded;
    const version = record(await this.#get('/whitelist/version', SMALL_TIMEOUT_MS));
    const gate = Number(version?.gate);
    if (!Number.isFinite(gate)) throw new ZemerWhitelistError("Zemer's list didn't say which version it is");

    let artists = this.#artists;
    if (first || gate !== this.#gate) {
      const docs = await this.#get('/whitelist', WHITELIST_TIMEOUT_MS);
      artists = new Map();
      for (const doc of Array.isArray(docs) ? docs : []) {
        const entry = record(doc);
        const id = text(entry?.artistId) ?? text(entry?.id);
        const name = text(entry?.displayName) ?? text(entry?.name) ?? text(entry?.artistName);
        const altName = text(entry?.altName);
        if (id && name) artists.set(id, { name, ...(altName && altName !== name ? { altName } : {}), female: entry?.isFemale === true });
      }
      // An empty or broken answer must never replace a good list.
      if (artists.size === 0) throw new ZemerWhitelistError("Zemer's list came back empty");
    }

    // The blocked songs are read on every check, even when the list itself hasn't changed, as Zemer does. Failing to
    // is only fatal when there is nothing to fall back on.
    let blocked = this.#blocked;
    try {
      const answer = record(await this.#get('/blockedContentIds', SMALL_TIMEOUT_MS));
      blocked = new Set([...(Array.isArray(answer?.global) ? answer.global : []), ...(Array.isArray(answer?.female) ? answer.female : [])].filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()));
    } catch (err) {
      if (first) throw err;
    }

    this.#artists = artists;
    this.#byName = undefined;
    this.#blocked = blocked;
    this.#gate = gate;
    this.#checkedAt = this.#now();
    // It answered properly: no longer frozen, and any artist the list now knows needs no waiting.
    this.#refusedAt = undefined;
    this.#lastError = undefined;
    this.#save();
    if (this.pending().length !== this.#waiting.size) this.#forgetKnownWaiting();
  }

  #forgetKnownWaiting(): void {
    for (const id of [...this.#waiting.keys()]) if (this.#artists.has(id)) this.#waiting.delete(id);
    this.#changed();
  }

  async #get(path: string, timeoutMs: number): Promise<unknown> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json', 'User-Agent': 'music-over-rcs/0.1 (personal, single-user project)' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new ZemerWhitelistError("I couldn't reach Zemer's artist list (network error or timeout)");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 401 || res.status === 403) {
        throw new ZemerWhitelistError(`Zemer's artist list turned the bot away (HTTP ${res.status}): it now answers only the official Zemer app`, true);
      }
      throw new ZemerWhitelistError(`Zemer's artist list answered HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new ZemerWhitelistError("Zemer's artist list wasn't readable");
    }
  }

  #save(): void {
    if (!this.#state || this.#gate === undefined) return;
    const saved: Saved = {
      gate: this.#gate,
      checkedAt: this.#checkedAt,
      artists: [...this.#artists].map(([id, artist]) => (artist.altName ? [id, artist.name, artist.female ? 1 : 0, artist.altName] : [id, artist.name, artist.female ? 1 : 0])),
      blocked: [...this.#blocked],
    };
    try {
      this.#state.setState(STATE_KEY, JSON.stringify(saved));
    } catch {
      // not being able to keep the list only means fetching it again next time
    }
  }

  #restore(): void {
    let saved: Partial<Saved> | undefined;
    try {
      const raw = this.#state?.getState(STATE_KEY);
      saved = raw ? (JSON.parse(raw) as Partial<Saved>) : undefined;
    } catch {
      return;
    }
    if (!saved || typeof saved.gate !== 'number' || !Array.isArray(saved.artists) || saved.artists.length === 0) return;
    for (const entry of saved.artists) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
        this.#artists.set(entry[0], { name: entry[1], ...(typeof entry[3] === 'string' ? { altName: entry[3] } : {}), female: entry[2] === 1 });
      }
    }
    this.#blocked = new Set((Array.isArray(saved.blocked) ? saved.blocked : []).filter((id): id is string => typeof id === 'string'));
    this.#gate = saved.gate;
    this.#checkedAt = typeof saved.checkedAt === 'number' ? saved.checkedAt : 0;
  }

  #saveOwner(): void {
    if (!this.#state) return;
    const decided = ([id, name]: [string, string]): [string, string] | [string, string, number] => {
      const at = this.#decidedAt.get(id);
      return at === undefined ? [id, name] : [id, name, at];
    };
    const saved: OwnerSaved = {
      allowed: [...this.#allowed].map(decided),
      blocked: [...this.#refused].map(decided),
      waiting: [...this.#waiting].map(([id, { name, since }]) => [id, name, since]),
      ...(this.#songsAllowed.size > 0 ? { allowedSongs: [...this.#songsAllowed.values()] } : {}),
      ...(this.#songsUnblocked.size > 0 ? { unblockedSongs: [...this.#songsUnblocked.values()] } : {}),
    };
    try {
      this.#state.setState(OWNER_KEY, JSON.stringify(saved));
    } catch {
      // the decisions are lost on a restart; the owner is asked again
    }
  }

  #restoreOwner(): void {
    let saved: Partial<OwnerSaved> | undefined;
    try {
      const raw = this.#state?.getState(OWNER_KEY);
      saved = raw ? (JSON.parse(raw) as Partial<OwnerSaved>) : undefined;
    } catch {
      return;
    }
    const pairs = (entries: unknown): Array<[string, string, number | undefined]> =>
      (Array.isArray(entries) ? entries : [])
        .filter((entry): entry is unknown[] => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string')
        .map((entry) => [entry[0] as string, entry[1] as string, typeof entry[2] === 'number' ? entry[2] : undefined]);
    for (const [id, name, at] of pairs(saved?.allowed)) {
      this.#allowed.set(id, name);
      if (at !== undefined) this.#decidedAt.set(id, at);
    }
    for (const [id, name, at] of pairs(saved?.blocked)) {
      this.#refused.set(id, name);
      if (at !== undefined) this.#decidedAt.set(id, at);
    }
    for (const song of Array.isArray(saved?.allowedSongs) ? saved.allowedSongs : []) {
      if (song && typeof song.id === 'string' && VIDEO_ID.test(song.id) && typeof song.title === 'string') {
        const ids = Array.isArray(song.artistIds) ? song.artistIds.filter((id): id is string => typeof id === 'string') : [];
        this.#songsAllowed.set(song.id, { id: song.id, title: song.title, artist: typeof song.artist === 'string' ? song.artist : '', artistIds: ids, at: typeof song.at === 'number' ? song.at : 0 });
      }
    }
    for (const song of Array.isArray(saved?.unblockedSongs) ? saved.unblockedSongs : []) {
      if (song && typeof song.id === 'string' && VIDEO_ID.test(song.id) && typeof song.title === 'string') this.#songsUnblocked.set(song.id, { id: song.id, title: song.title, at: typeof song.at === 'number' ? song.at : 0 });
    }
    for (const entry of Array.isArray(saved?.waiting) ? saved.waiting : []) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
        this.#waiting.set(entry[0], { name: entry[1], since: typeof entry[2] === 'number' ? entry[2] : 0 });
      }
    }
  }
}

/** ZEMER_CONTENT_URL points it somewhere else (tests). */
export function zemerWhitelistFromEnv(env: NodeJS.ProcessEnv = process.env, options: ZemerWhitelistOptions = {}): ZemerWhitelist {
  const baseUrl = env.ZEMER_CONTENT_URL?.trim();
  return new ZemerWhitelist(baseUrl ? { ...options, baseUrl } : options);
}
