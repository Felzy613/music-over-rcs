import { parsePeople } from '../people.ts';
import type { HostRestarter } from './host-restart.ts';
import { MAX_PEOPLE, PEOPLE_OBJECT, PeopleListError, checkNewName, typedName, type PeopleList, type SavedPerson } from './people-list.ts';

// What the management console's People tab does with the list of people: show who is set in Render, who was added here and who is running,
// add and remove names (kept in the bucket, src/cloud/people-list.ts) and ask the host to restart so the change takes effect (the new
// person's account, bridge permission and chat are made at the start). It is the console's whole view of this; nothing here touches Render.

export interface DeskEntry {
  id: string;
  /** Named in the PEOPLE variable in Render (the page cannot change that), or added in the console. */
  source: 'render' | 'console';
  /** `running`: the bot is running for them and the list still has them. `adding`: in the list, waiting for the restart. `removing`: running, but out of the list, leaving at the restart. */
  state: 'running' | 'adding' | 'removing';
  addedAt: string | null;
}

export interface DeskOverview {
  /** The bot's start time: it changes when the host has restarted, which is how the page knows the restart is over. */
  bootId: number;
  max: number;
  /** Whether names can be added and removed here, and if not, why. */
  canChange: boolean;
  whyNot: string | null;
  entries: DeskEntry[];
  /** True when the list and the people the bot is running for differ: a restart would change something. */
  pendingRestart: boolean;
  restart: { available: boolean; whyNot: string | null; pending: boolean };
}

export interface DeskChange {
  id: string;
  /** Whether a restart is needed now for the list to take effect. */
  pendingRestart: boolean;
  /** Whether this host can restart itself when asked. */
  restartAvailable: boolean;
}

/** What the console needs of the desk (the console imports only this). */
export interface PeopleAdmin {
  overview(): Promise<DeskOverview>;
  add(name: unknown): Promise<DeskChange>;
  remove(name: unknown): Promise<DeskChange & { wasRunning: boolean }>;
  restart(): Promise<{ inSeconds: number }>;
}

export const NO_BUCKET = 'People can only be added here when the R2 settings are all set in Render (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY), because the list is kept in the bucket. PEOPLE in Render still works.';

export interface PeopleDeskOptions {
  /** The names PEOPLE in Render gave this start (the host passes them as PEOPLE_IN_RENDER). */
  fromRender: readonly string[];
  /** The people the bot is running for now, besides the owner. */
  running: readonly string[];
  /** The owner's own Matrix account name, which no one may take. */
  reserved: readonly string[];
  /** The saved list in the bucket; absent when there is no bucket. */
  list: PeopleList | undefined;
  restarter: HostRestarter;
  bootId: number;
  log(line: string): void;
}

export class PeopleDesk implements PeopleAdmin {
  #render: string[];
  #running: string[];
  #reserved: readonly string[];
  #list: PeopleList | undefined;
  #restarter: HostRestarter;
  #bootId: number;
  #log: (line: string) => void;

  constructor(options: PeopleDeskOptions) {
    // The names are checked again here: whatever the environment holds reaches the page's table and decides what may be removed.
    const checked = (names: readonly string[]): string[] => parsePeople(names.join(' '), { reserved: options.reserved }).people.map((person) => person.id);
    this.#render = checked(options.fromRender);
    this.#running = checked(options.running);
    this.#reserved = options.reserved;
    this.#list = options.list;
    this.#restarter = options.restarter;
    this.#bootId = options.bootId;
    this.#log = options.log;
  }

  /** Everyone the page lists, with where they stand. `saved` is undefined when the list could not be read. */
  #entries(saved: readonly SavedPerson[] | undefined): DeskEntry[] {
    const inList = (id: string): boolean => this.#render.includes(id) || (saved?.some((one) => one.id === id) ?? false);
    const ids = [...new Set([...this.#render, ...(saved ?? []).map((one) => one.id), ...this.#running])];
    return ids.map((id) => {
      const running = this.#running.includes(id);
      // With the list unreadable nothing can be said to be arriving or leaving: everybody running is just running.
      const state = saved === undefined ? 'running' : running ? (inList(id) ? 'running' : 'removing') : 'adding';
      return { id, source: this.#render.includes(id) ? 'render' : 'console', state, addedAt: saved?.find((one) => one.id === id)?.addedAt ?? null };
    });
  }

  async overview(options: { fresh?: boolean } = {}): Promise<DeskOverview> {
    let saved: SavedPerson[] | undefined;
    let whyNot: string | null = null;
    if (!this.#list) whyNot = NO_BUCKET;
    else {
      try {
        const read = await this.#list.read(options);
        if (read.damaged) whyNot = `${read.problems[0] ?? 'The saved list is damaged'}. Fix or delete ${PEOPLE_OBJECT} in the bucket before changing it here.`;
        else saved = read.people;
      } catch (err) {
        whyNot = `${err instanceof Error ? err.message : String(err)}. Nothing can be changed here until the bucket can be read.`;
      }
    }
    const entries = this.#entries(saved);
    const can = this.#restarter.available();
    return {
      bootId: this.#bootId,
      max: MAX_PEOPLE,
      canChange: whyNot === null,
      whyNot,
      entries,
      pendingRestart: entries.some((entry) => entry.state !== 'running'),
      restart: { available: can.ok, whyNot: can.ok ? null : can.why, pending: this.#restarter.pending() },
    };
  }

  #need(): PeopleList {
    if (!this.#list) throw new PeopleListError(409, NO_BUCKET);
    return this.#list;
  }

  #refuseDuringRestart(): void {
    if (this.#restarter.pending()) throw new PeopleListError(409, 'A restart is on its way; wait for it to finish before changing the list.');
  }

  async add(name: unknown): Promise<DeskChange> {
    const id = checkNewName(name, { reserved: this.#reserved });
    if (this.#render.includes(id)) throw new PeopleListError(409, `${id} is already set in the PEOPLE variable in Render.`);
    const list = this.#need();
    this.#refuseDuringRestart();
    await list.add(id, { limit: Math.max(0, MAX_PEOPLE - this.#render.length) });
    this.#log(`people: ${id} added from the console; they are set up at the next restart`);
    const after = await this.overview();
    return { id, pendingRestart: after.pendingRestart, restartAvailable: after.restart.available };
  }

  async remove(name: unknown): Promise<DeskChange & { wasRunning: boolean }> {
    const id = typedName(name);
    if (!id || /[\s,]/.test(id)) throw new PeopleListError(400, 'Which person? (one name)');
    if (this.#render.includes(id)) throw new PeopleListError(409, `${id} is set in the PEOPLE variable in Render, and this page cannot change Render: take the name out of PEOPLE there.`);
    const list = this.#need();
    this.#refuseDuringRestart();
    await list.remove(id);
    this.#log(`people: ${id} removed from the console's list; they leave at the next restart`);
    const after = await this.overview();
    return { id, wasRunning: this.#running.includes(id), pendingRestart: after.pendingRestart, restartAvailable: after.restart.available };
  }

  /** Asks the host to restart, but only when the list and the running people differ and nothing is on its way already. */
  async restart(): Promise<{ inSeconds: number }> {
    const can = this.#restarter.available();
    if (!can.ok) throw new PeopleListError(409, can.why);
    if (this.#restarter.pending()) throw new PeopleListError(409, 'A restart is already on its way.');
    const now = await this.overview({ fresh: true });
    if (!now.canChange) throw new PeopleListError(409, `${now.whyNot ?? 'The list cannot be read.'} A restart is not asked for while the list cannot be read.`);
    if (!now.pendingRestart) throw new PeopleListError(409, 'Nothing is waiting: the people the bot is running for are the people in the list.');
    return this.#restarter.request();
  }
}
