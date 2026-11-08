// Who uses the bot. The owner is the person the bot was made for: the legacy state keys, the empty `chat` column and the
// plain behaviour of every release before there were people. Anyone else is listed in `PEOPLE` (the Render environment),
// has a Matrix account, a bridge login, a room and a chat of their own, and keeps their own menus, picks, resume point,
// follows and plays beside the owner's under a name that is theirs (`scoped`). With `PEOPLE` unset or empty nothing here
// changes anything: there is only the owner.

export interface Person {
  /** `owner` for the owner; for anyone else the name listed in `PEOPLE` (also their Matrix account's name). */
  readonly id: string;
  readonly owner: boolean;
  /**
   * The value of the catalog's `chat` columns for this person: empty for the owner (what every row had before there were
   * people), the id for anyone else.
   */
  readonly chat: string;
}

export const OWNER_ID = 'owner';

/** The owner: the legacy keys, and the empty `chat`. */
export const OWNER: Person = Object.freeze({ id: OWNER_ID, owner: true, chat: '' });

/** A name that can be listed: a lower-case letter, then lower-case letters or digits, 2 to 16 characters in all. */
export const PERSON_ID_PATTERN = /^[a-z][a-z0-9]{1,15}$/;

/** Names no one else may take: the owner's Matrix account by default, and the owner themself. */
const RESERVED_IDS: readonly string[] = ['me', OWNER_ID];

/** The bridge's own accounts are @gmessagesbot and @gmessages_… (the appservice's namespaces, src/cloud/provision.ts). */
const BRIDGE_PREFIX = 'gmessages';

/** What is said about an id in a message: quoted, and short, so odd input cannot fill or garble a log line. */
const shown = (id: string): string => JSON.stringify(id.length > 40 ? `${id.slice(0, 40)}…` : id);

/**
 * Why a name cannot be a person's id, or undefined when it can. `reserved` is more names the owner already has (the
 * owner's Matrix account when `MATRIX_USER` changes it from `me`).
 */
export function personIdProblem(id: string, reserved: readonly string[] = []): string | undefined {
  if (!PERSON_ID_PATTERN.test(id)) {
    return `${shown(id)} is not a usable name: use 2 to 16 characters, a lower-case letter first and then lower-case letters or digits`;
  }
  if (RESERVED_IDS.includes(id)) return `${shown(id)} is reserved for the owner`;
  if (id.startsWith(BRIDGE_PREFIX)) return `${shown(id)} is reserved: names starting with "${BRIDGE_PREFIX}" belong to the Google Messages bridge`;
  if (reserved.includes(id)) return `${shown(id)} is the owner's Matrix account`;
  return undefined;
}

/** A person who is not the owner. Throws on a name that cannot be one (see `personIdProblem`). */
export function personOf(id: string, reserved: readonly string[] = []): Person {
  const problem = personIdProblem(id, reserved);
  if (problem) throw new Error(`PEOPLE: ${problem}`);
  return Object.freeze({ id, owner: false, chat: id });
}

export interface PeopleParse {
  /** The people who may use the bot besides the owner, in the order listed. */
  people: Person[];
  /**
   * What was wrong with the names left out, one sentence each, ready for a log. A bad name never stops the host (a typo in
   * Render must not take the owner's bot down with it): it is left out, and these say so.
   */
  problems: string[];
}

/**
 * Reads the `PEOPLE` setting: names separated by commas or spaces. A name that cannot be used (see `personIdProblem`) or
 * that is listed again is left out and described in `problems`. Nothing set, or empty, is no one but the owner.
 */
export function parsePeople(raw: string | undefined, options: { reserved?: readonly string[] | undefined } = {}): PeopleParse {
  const reserved = (options.reserved ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean);
  const people: Person[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const id of (raw ?? '').split(/[\s,]+/).filter(Boolean)) {
    const problem = personIdProblem(id, reserved) ?? (seen.has(id) ? `${shown(id)} is listed twice` : undefined);
    if (problem) {
      problems.push(`PEOPLE: ${problem}; left out`);
      continue;
    }
    seen.add(id);
    people.push(Object.freeze({ id, owner: false, chat: id }));
  }
  return { people, problems };
}

/** `PEOPLE` from the environment, with the owner's Matrix account (`MATRIX_USER`) kept for the owner. */
export function peopleFromEnv(env: NodeJS.ProcessEnv = process.env): PeopleParse {
  return parsePeople(env.PEOPLE, { reserved: env.MATRIX_USER ? [env.MATRIX_USER] : [] });
}

/**
 * A per-chat state key for a person: the owner keeps `base` as it always was, anyone else gets `base:<id>`
 * (`chat.view` and `chat.view:alice`). A person's id never contains a colon, so one person's key can't be another's.
 */
export function scoped(base: string, person: Person = OWNER): string {
  return person.owner ? base : `${base}:${person.id}`;
}

/**
 * The people's Matrix passwords as the host hands them to the bot in `PEOPLE_PASSWORDS`: `id:password` pairs separated by commas
 * (`alice:3f9c…,bob:a01d…`). The host makes the accounts with passwords derived from its master secret (src/cloud/provision.ts,
 * `personPassword`) and the bot, which cannot derive them, reads them back here. A password has no comma or space, so nothing needs
 * escaping; a name or password that could not be read back is a mistake in the caller and throws (the message never has the password).
 */
export function formatPeoplePasswords(entries: ReadonlyArray<{ id: string; password: string }>): string {
  return entries
    .map(({ id, password }) => {
      const problem = personIdProblem(id);
      if (problem) throw new Error(`PEOPLE_PASSWORDS: ${problem}`);
      if (!/^[^\s,]+$/.test(password)) throw new Error(`PEOPLE_PASSWORDS: the password for ${shown(id)} is empty or has a comma or a space in it`);
      return `${id}:${password}`;
    })
    .join(',');
}

/**
 * Reads `PEOPLE_PASSWORDS` (see `formatPeoplePasswords`): each person's id and password. It never throws: a pair that is not
 * `id:password` with a usable id, and a name listed again (the first is kept), is left out, so a damaged value costs the people
 * concerned their sign-in and no one else.
 */
export function parsePeoplePasswords(raw: string | undefined): Map<string, string> {
  const passwords = new Map<string, string>();
  for (const pair of (raw ?? '').split(',')) {
    const colon = pair.indexOf(':');
    if (colon < 0) continue;
    const id = pair.slice(0, colon).trim();
    const password = pair.slice(colon + 1).trim();
    if (!PERSON_ID_PATTERN.test(id) || !password || /\s/.test(password) || passwords.has(id)) continue;
    passwords.set(id, password);
  }
  return passwords;
}

/** The lines the host writes for each request, song and album: Render's log is searched by their first word. */
const KIND_LINE = /^(timeline|song|album): /;

/**
 * A log line for one person's chat. The owner's lines are as they always were. Anyone else's say whose they are, after the first word
 * of a `timeline:`, `song:` or `album:` line (so a search for that word still finds them) and in front of any other line:
 * `[alice] -> announcement (1 message)`, `timeline: [alice] "search blue" …`.
 */
export function tagLine(person: Person, line: string): string {
  if (person.owner) return line;
  const kind = KIND_LINE.exec(line);
  return kind ? `${kind[0]}[${person.id}] ${line.slice(kind[0].length)}` : `[${person.id}] ${line}`;
}
