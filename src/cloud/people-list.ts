import { parsePeople, type Person } from '../people.ts';
import type { S3 } from './s3.ts';

// The people added from the management console's People tab. The names are kept in one small object in the R2 bucket, because the host
// needs them at the very start (before the databases are restored): the bridge's permission lines and the Matrix accounts are made from
// them. It is read once per start (src/cloud/boot.ts) and written only when the owner changes the list (the bot, below). Names set in the
// PEOPLE variable in Render still work and are merged with these; the console cannot change those.
//
// Nothing read from the bucket is trusted: every name goes through `parsePeople` each time it is read, because the bridge's config is YAML
// and an account is made by a command line.

/** Where the list is kept, beside `lease.json` and `keys/synapse-signing.key`. */
export const PEOPLE_OBJECT = 'config/people.json';

/** The most people besides the owner (the ones in Render and the ones added here together): a safety bound, not a plan. */
export const MAX_PEOPLE = 10;

/** A bigger object than this is not ours (ten names are about a kilobyte). */
const MAX_OBJECT_CHARS = 16 * 1024;

export interface SavedPerson {
  readonly id: string;
  /** When the owner added them, as the console wrote it; null for a name put there by hand. */
  readonly addedAt: string | null;
}

/** Why a change to the list was refused, with the HTTP status the console answers with. */
export class PeopleListError extends Error {
  readonly status: 400 | 404 | 409 | 503;
  constructor(status: 400 | 404 | 409 | 503, message: string) {
    super(message);
    this.name = 'PeopleListError';
    this.status = status;
  }
}

/** A name as the owner typed it: trimmed and in lower case (the names are lower case, and a capital is the commonest slip). */
export const typedName = (raw: unknown): string => (typeof raw === 'string' ? raw.trim().toLowerCase() : '');

const shown = (text: string): string => JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);

/** The words for a name that `parsePeople` left out, without the log line's wrapping. */
const plainProblem = (line: string): string => line.replace(/^PEOPLE: /, '').replace(/; left out$/, '');

/**
 * One name, checked for adding: exactly one name that `parsePeople` accepts as it stands. Throws a 400 saying what is wrong.
 * (Two names in one box, or a separator in the name, would otherwise be split by `parsePeople` into names nobody typed.)
 */
export function checkNewName(raw: unknown, options: { reserved?: readonly string[] } = {}): string {
  const id = typedName(raw);
  if (!id) throw new PeopleListError(400, 'Type a name first (2 to 16 lower-case letters or digits, starting with a letter).');
  if (/[\s,]/.test(id)) throw new PeopleListError(400, 'One name at a time: no spaces or commas.');
  const parsed = parsePeople(id, { reserved: options.reserved });
  const one = parsed.people[0];
  if (!one || parsed.people.length !== 1 || one.id !== id) throw new PeopleListError(400, `${plainProblem(parsed.problems[0] ?? `${shown(id)} is not a usable name`)}.`);
  return one.id;
}

export interface SavedParse {
  /** The valid names, in the order stored. Never more than `MAX_PEOPLE`. */
  people: SavedPerson[];
  /** What was wrong, one line each, for a log. */
  problems: string[];
  /** True when the object as a whole could not be read (not JSON, not the expected shape, too large): nothing in it was used. */
  damaged: boolean;
}

/**
 * Reads the stored object. It never throws: nothing stored (`undefined`, or only spaces) is an empty list; an object that cannot be
 * read at all is `damaged` (an empty list and one problem); a name that cannot be used, or is listed again, is left out with its own
 * problem and the rest are kept.
 */
export function readSavedPeople(text: string | undefined, options: { reserved?: readonly string[] } = {}): SavedParse {
  if (text === undefined || text.trim() === '') return { people: [], problems: [], damaged: false };
  const damaged = (why: string): SavedParse => ({ people: [], problems: [`the saved list of people (${PEOPLE_OBJECT}) ${why}`], damaged: true });
  if (text.length > MAX_OBJECT_CHARS) return damaged('is far bigger than a list of names can be, so none of it is used');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return damaged('is not valid JSON, so none of it is used');
  }
  const list = value && typeof value === 'object' && !Array.isArray(value) ? (value as { people?: unknown }).people : undefined;
  if (!Array.isArray(list)) return damaged('has no "people" list, so none of it is used');
  const people: SavedPerson[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const raw: unknown = typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? (entry as { id?: unknown }).id : undefined;
    if (typeof raw !== 'string') {
      problems.push(`the saved list of people has an entry that is not a name; left out`);
      continue;
    }
    const parsed = parsePeople(raw, { reserved: options.reserved });
    const one = parsed.people[0];
    if (!one || parsed.people.length !== 1 || one.id !== raw) {
      problems.push(`the saved list of people: ${plainProblem(parsed.problems[0] ?? `${shown(raw)} is not a usable name`)}; left out`);
      continue;
    }
    if (seen.has(raw)) {
      problems.push(`the saved list of people: ${shown(raw)} is listed twice; left out`);
      continue;
    }
    if (people.length >= MAX_PEOPLE) {
      problems.push(`the saved list of people has more than ${MAX_PEOPLE} names; ${shown(raw)} and the rest are left out`);
      break;
    }
    seen.add(raw);
    const at = typeof entry === 'object' && entry !== null ? (entry as { addedAt?: unknown }).addedAt : undefined;
    people.push({ id: raw, addedAt: typeof at === 'string' && at.length <= 40 && Number.isFinite(Date.parse(at)) ? at : null });
  }
  return { people, problems, damaged: false };
}

/** The object as it is stored. */
export function serializePeople(list: readonly SavedPerson[]): string {
  return `${JSON.stringify({ version: 1, people: list.map((one) => ({ id: one.id, ...(one.addedAt ? { addedAt: one.addedAt } : {}) })) }, null, 2)}\n`;
}

export interface Merged {
  /** Everyone besides the owner: the environment's names first, then the added ones, each once, all checked by `parsePeople` again. */
  people: Person[];
  /** Of those, the ones that came from the saved list only. */
  added: string[];
  problems: string[];
}

/**
 * The names from the environment and the saved list together. The environment's come first and are always all kept (they were the
 * owner's before there was a console); the saved list adds the ones not there already, up to `MAX_PEOPLE` in all. The result goes
 * through `parsePeople` once more, so nothing that reaches the bridge config or a command line has skipped it.
 */
export function mergePeople(fromEnv: readonly Person[], saved: readonly SavedPerson[], options: { reserved?: readonly string[] } = {}): Merged {
  const ids = fromEnv.map((person) => person.id);
  const problems: string[] = [];
  const addedIds: string[] = [];
  for (const one of saved) {
    if (ids.includes(one.id)) continue;
    if (ids.length >= Math.max(MAX_PEOPLE, fromEnv.length)) {
      problems.push(`the saved list of people: ${shown(one.id)} is left out because there are already ${MAX_PEOPLE} people`);
      continue;
    }
    ids.push(one.id);
    addedIds.push(one.id);
  }
  const parsed = parsePeople(ids.join(' '), { reserved: options.reserved });
  const kept = new Set(parsed.people.map((person) => person.id));
  return { people: parsed.people, added: addedIds.filter((id) => kept.has(id)), problems: [...problems, ...parsed.problems] };
}

type Store = Pick<S3, 'get' | 'put'>;

export interface PeopleListOptions {
  store: Store;
  /** Names the owner has (their Matrix account), which no person may take. */
  reserved?: readonly string[];
  now?: () => Date;
  /** How long a read is reused (the People tab asks often); a change always reads afresh. Default 30 s. */
  cacheMs?: number;
  key?: string;
}

const unavailable = (what: string, err: unknown): PeopleListError => new PeopleListError(503, `${what}: ${err instanceof Error ? err.message : String(err)}`);

/**
 * The list in the bucket, for the bot's console to read and change. Changes are made one at a time (a lock in this process, and R2's
 * conditional write against anything else), so two adds can never overwrite each other. A damaged object is never overwritten.
 */
export class PeopleList {
  #store: Store;
  #reserved: readonly string[];
  #now: () => Date;
  #cacheMs: number;
  #key: string;
  #chain: Promise<unknown> = Promise.resolve();
  #cache: { at: number; value: SavedParse } | undefined;

  constructor(options: PeopleListOptions) {
    this.#store = options.store;
    this.#reserved = options.reserved ?? [];
    this.#now = options.now ?? (() => new Date());
    this.#cacheMs = options.cacheMs ?? 30_000;
    this.#key = options.key ?? PEOPLE_OBJECT;
  }

  /** Runs `work` once every earlier call has finished, whether they worked or not. */
  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(work);
    this.#chain = run.catch(() => {});
    return run;
  }

  /** The saved list. Throws a 503 when the bucket can't be read. */
  read(options: { fresh?: boolean } = {}): Promise<SavedParse> {
    return this.#exclusive(async () => {
      const kept = this.#cache;
      if (!options.fresh && kept && this.#now().getTime() - kept.at < this.#cacheMs) return kept.value;
      let object: { text: string; etag: string } | undefined;
      try {
        object = await this.#store.get(this.#key);
      } catch (err) {
        throw unavailable('the saved list could not be read from R2', err);
      }
      const value = readSavedPeople(object?.text, { reserved: this.#reserved });
      this.#cache = { at: this.#now().getTime(), value };
      return value;
    });
  }

  /**
   * Reads the object, applies `edit` to the names in it and writes the result back only if nobody changed it meanwhile (tried again a few
   * times if somebody did). `edit` returns the new list, or throws a `PeopleListError` to refuse.
   */
  #change(edit: (current: SavedPerson[]) => SavedPerson[]): Promise<SavedPerson[]> {
    return this.#exclusive(async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        let object: { text: string; etag: string } | undefined;
        try {
          object = await this.#store.get(this.#key);
        } catch (err) {
          throw unavailable('the saved list could not be read from R2, so nothing was changed', err);
        }
        const current = readSavedPeople(object?.text, { reserved: this.#reserved });
        if (current.damaged) {
          throw new PeopleListError(409, `${current.problems[0]}. Nothing was changed: fix or delete ${this.#key} in the bucket first.`);
        }
        const next = edit(current.people);
        let written: Awaited<ReturnType<Store['put']>>;
        try {
          // With an ETag the write happens only if the object is still the one read; with none (the first list ever) only if it still does not exist.
          const condition = object === undefined ? { ifNoneMatch: '*' as const } : object.etag ? { ifMatch: object.etag } : {};
          written = await this.#store.put(this.#key, serializePeople(next), condition);
        } catch (err) {
          throw unavailable('the list could not be saved to R2, so nothing was changed', err);
        }
        if (written.ok) {
          this.#cache = { at: this.#now().getTime(), value: { people: next, problems: [], damaged: false } };
          return next;
        }
      }
      throw new PeopleListError(409, 'The list was changed somewhere else while it was being saved, three times in a row. Nothing was lost; try again.');
    });
  }

  /** Adds a name (already checked with `checkNewName`). `limit` is the most names the saved list may hold (the rest of `MAX_PEOPLE` is the Render ones). */
  async add(id: string, options: { limit?: number } = {}): Promise<{ person: SavedPerson; people: SavedPerson[] }> {
    const person: SavedPerson = { id, addedAt: this.#now().toISOString() };
    const people = await this.#change((current) => {
      if (current.some((one) => one.id === id)) throw new PeopleListError(409, `${id} is already added.`);
      if (current.length >= (options.limit ?? MAX_PEOPLE)) throw new PeopleListError(409, `That is the most people this host takes (${MAX_PEOPLE}, counting the ones set in Render). Remove someone first.`);
      return [...current, person];
    });
    return { person, people };
  }

  /** Takes a name out of the saved list. */
  async remove(id: string): Promise<{ people: SavedPerson[] }> {
    const people = await this.#change((current) => {
      if (!current.some((one) => one.id === id)) throw new PeopleListError(404, `${id} is not in the list added here.`);
      return current.filter((one) => one.id !== id);
    });
    return { people };
  }
}
