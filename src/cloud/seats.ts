import { bridgeStatus, type BridgeStatus, type Health } from '../health.ts';
import { addChat, removeChat, type Host, type HostChat } from '../host.ts';
import { DIGEST_STAGGER_MINUTES } from '../library/jobs.ts';
import { MatrixClient, MatrixError } from '../matrix/client.ts';
import { OWNER, scoped, tagLine, type Person } from '../people.ts';
import { Onboarding, loginKind, type OnboardingReport } from './onboarding.ts';
import { Pairing, chatNumber, ownChatRooms, selfChatRooms, simNumbers } from './pairing.ts';
import { RoomWatch } from './room.ts';

// One seat for each person who uses the bot, the owner first: everything the cloud host knows about that person's Matrix account, their
// link to Google Messages (a Pairing with the bridge's bot) and their own "message yourself" room, and the loop that brings their chat up on
// the host once the room is there. Seats are independent: one person's account that can't be signed in, room that was deleted on the
// phone, or chat that fails to start never makes another person wait or stops another's chat, and the owner's does not stop theirs. The
// host (`startHost`, src/host.ts) is built once and needs no room; each seat adds its chat to it (`addChat`) when its own room resolves.
//
// Only the legacy owner-only start (no PEOPLE) keeps using the seat as a plain holder: src/cloud-main.ts then drives the owner's room watch
// itself and imports matrix-main.ts, exactly as before there were people.

type StateStore = { getState(key: string): string | undefined; setState(key: string, value: string): void };

/** starting: signing in to the homeserver; setup: waiting for a chat; bot-starting: the chat is coming up; running: it is answering. */
export type SeatPhase = 'starting' | 'setup' | 'bot-starting' | 'running';

/** A person who cannot be signed in however long it is tried (the host handed over no password for them): the seat stops trying. */
export class SeatImpossible extends Error {}

export interface SeatSession {
  token: string;
  userId: string;
  matrix: MatrixClient;
  /** The chat window to the bridge's bot, with this person's own Matrix account. */
  pairing: Pairing;
}

/** What a seat says of itself, for /status and the Connect page. */
export interface SeatReport {
  id: string;
  /** `room-missing` while the chat's room can't be joined (it was deleted on the phone) and the seat waits for a new one. */
  phase: SeatPhase | 'room-missing';
  /** The room the chat is in, or the one it was given while it waits. */
  room: string | null;
  /** The rooms that could not be joined, and since when. */
  roomGone: { rooms: string[]; since: string | null } | null;
  /** Why the account can't be used, while that is so. */
  error: string | null;
}

export interface SeatDeps {
  env: NodeJS.ProcessEnv;
  state: StateStore;
  /** The bridge's database, read-only, to find a person's chat. */
  bridgeDb: string;
  log(line: string): void;
}

export class Seat {
  readonly person: Person;
  phase: SeatPhase = 'starting';
  session: SeatSession | undefined;
  /** The watch for this seat's room; a new one each time the room has to be waited for again. */
  watch: RoomWatch | undefined;
  /** This person's chat on the host while it is up. */
  chat: HostChat | undefined;
  /** Why the account can't be used, while that is so. */
  problem: string | undefined;
  #deps: SeatDeps;
  #wakers = new Set<() => void>();
  #interrupt: (() => void) | undefined;
  #onboarding: Onboarding | undefined;

  constructor(person: Person, deps: SeatDeps) {
    this.person = person;
    this.#deps = deps;
  }

  get id(): string {
    return this.person.id;
  }

  /** What this seat says in a log: the owner's lines are as they always were, anyone else's carry their name. */
  log = (line: string): void => this.#deps.log(tagLine(this.person, line));

  /**
   * Signed in: the account's token, and the chat window to the bridge's bot. `homeserver` is where this account lives, `log` where the
   * bridge window reports (the pasted request is never logged). A paste waiting to be deleted from the chat is remembered in the host's state,
   * so a restart inside that minute deletes it when this account is signed in again.
   */
  open(token: string, userId: string, homeserver: string): SeatSession {
    const matrix = new MatrixClient({ token, homeserver });
    const botId = `@gmessagesbot:${userId.slice(userId.indexOf(':') + 1)}`;
    this.session = { token, userId, matrix, pairing: new Pairing({ matrix, botId, userId, state: this.#deps.state, log: this.log }) };
    return this.session;
  }

  /**
   * The rooms to try, best first. The owner's are MATRIX_ROOM_ID and the chat chosen on the Connect page; anyone else's is only the one chosen for
   * them (`matrix.room:<id>`): MATRIX_ROOM_ID is the owner's.
   */
  roomsChosen(): string[] {
    const { env, state } = this.#deps;
    const chosen = state.getState(scoped('matrix.room', this.person));
    const given = this.person.owner ? [env.MATRIX_ROOM_ID?.trim(), chosen] : [chosen];
    return [...new Set(given.filter((room): room is string => Boolean(room)))];
  }

  /** The number of the chat this person was found under before, for a SIM that doesn't say its own (`matrix.phone`, `matrix.phone:<id>`). */
  knownPhone(): string | undefined {
    return this.#deps.state.getState(scoped('matrix.phone', this.person)) || undefined;
  }

  /**
   * The rooms of this person's own "message yourself" chat that the bridge has made, found with nobody's help. Only this person's own
   * logins are looked at (their Matrix account), so a deleted chat is never replaced by someone else's.
   */
  findRooms(): string[] {
    if (!this.session) return [];
    const known = this.knownPhone();
    return ownChatRooms(this.#deps.bridgeDb, { userId: this.session.userId, known: known ? [known] : [] });
  }

  /**
   * The rooms the bridge made for a chat with this phone number (or with none given, for this person's own numbers). A number typed for the
   * owner is looked up as it always was, among all the bridge's chats; for anyone else only among their own logins.
   */
  rooms(phone?: string): string[] {
    if (!phone) return this.findRooms();
    if (this.person.owner) return selfChatRooms(this.#deps.bridgeDb, phone);
    return this.session ? selfChatRooms(this.#deps.bridgeDb, phone, { userId: this.session.userId }) : [];
  }

  /** A room that was found, not given, has been joined: kept as the chat chosen. */
  keep(room: string): void {
    this.#deps.state.setState(scoped('matrix.room', this.person), room);
  }

  /** Chooses the room this person's chat is in, and wakes the wait for it. */
  choose(room: string): void {
    this.keep(room);
    this.log(`chat chosen: ${room}`);
    this.wake();
  }

  /** The chat's number is kept, so its next room is found even if the phone never says its number. */
  rememberPhone(room: string): void {
    try {
      const number = chatNumber(this.#deps.bridgeDb, room);
      if (number) this.#deps.state.setState(scoped('matrix.phone', this.person), number);
    } catch (err) {
      this.log(`could not read the chat's number from the bridge's database: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Waits up to `ms`, or until a chat is chosen for this person, or the seat is woken. */
  nap(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      this.#wakers.add(done);
    });
  }

  wake(): void {
    for (const wake of [...this.#wakers]) wake();
  }

  /** Ends whatever the seat is waiting for (the host is stopping). */
  interrupt(): void {
    this.wake();
    this.#interrupt?.();
  }

  /** Called by the run loop: what ends the wait for the chat to go away. */
  onInterrupt(end: (() => void) | undefined): void {
    this.#interrupt = end;
  }

  report(): SeatReport {
    const room = this.watch?.report();
    return {
      id: this.id,
      phase: this.phase === 'setup' && room?.state === 'gone' ? 'room-missing' : this.phase,
      room: room?.room ?? this.roomsChosen()[0] ?? null,
      roomGone: room?.state === 'gone' ? { rooms: room.gone, since: room.since } : null,
      error: this.problem ?? null,
    };
  }

  /**
   * The bridge's word on this person's Google Messages login, from the bridge's provisioning API with their own token: nothing is
   * assumed of a person whose account isn't signed in yet.
   */
  async bridge(bridgeUrl: string): Promise<BridgeStatus | { state: undefined; error: string }> {
    if (!this.session) return { state: undefined, error: 'this account is not signed in yet' };
    return bridgeStatus({ url: bridgeUrl, token: this.session.token, userId: this.session.userId }).catch((err: unknown) => ({ state: undefined, error: err instanceof Error ? err.message : String(err) }));
  }

  /**
   * Where this person stands in the onboarding gate (src/cloud/onboarding.ts): linked, the phone's number reported, and their own chat arrived
   * within a few minutes. `bridge` is what the bridge said of their login (`Seat.bridge`). Undefined for the owner. Reading it keeps, once, the time
   * the login was first seen connected and the time the chat was first seen.
   */
  onboarding(bridge: { state?: string | undefined; error?: string | undefined }): OnboardingReport | undefined {
    if (this.person.owner) return undefined;
    this.#onboarding ??= new Onboarding({ state: this.#deps.state, person: this.person });
    let chatFound = this.chat !== undefined;
    if (!chatFound) {
      try {
        chatFound = this.findRooms().length > 0;
      } catch {
        // a bridge database that cannot be read proves nothing
      }
    }
    return this.#onboarding.evaluate({ login: loginKind(bridge), simNumber: this.hasSimNumber(), chatFound });
  }

  /**
   * Whether the bridge's login for this person reports a SIM number (the self-chat is kept only when it does, or when the number of the chat
   * is known); null when that can't be read (no account yet, the bridge's database isn't there).
   */
  hasSimNumber(): boolean | null {
    if (!this.session) return null;
    try {
      return simNumbers(this.#deps.bridgeDb, this.session.userId).length > 0;
    } catch {
      return null;
    }
  }
}

export interface SeatsDeps extends SeatDeps {
  /** The people besides the owner, in the order PEOPLE lists them. */
  people: readonly Person[];
  /** Where a person's account lives (one homeserver on the cloud host). */
  homeserver(person: Person): string;
  /** False while the bot is switched off (BOT_ENABLED): the accounts are signed in, but no chat is started. */
  enabled(): boolean;
  /** True once the host is stopping. */
  stopped?(): boolean;
  /** The host that chats are added to; undefined until it exists. */
  host(): Host | undefined;
  /** Where room problems are said: the host's. */
  health(): Pick<Health, 'problem' | 'ok'>;
  /**
   * Signs a person's account in (src/cloud/bootstrap.ts `ensureTokenPatiently`) and gives the token and the id it belongs to. Rejects when it
   * can't; `SeatImpossible` when trying again would not help.
   */
  signIn(person: Person): Promise<{ token: string; userId: string }>;
  /** How long to wait before trying a failed step again (default a minute). */
  retryMs?: number;
  /** How long to wait for a chat before looking again (default a minute). */
  waitMs?: number;
  /** How often a running chat's room is checked (default five minutes). */
  roomCheckEveryMs?: number;
}

const MINUTE = 60_000;
/** How long stopping waits for the seats' loops to end. */
const STOP_WAIT_MS = 1_000;

/** Everyone who uses the bot, each in a seat of their own. */
export class Seats {
  readonly owner: Seat;
  readonly people: readonly Seat[];
  #deps: SeatsDeps;
  #stopping = false;
  #runs = new Map<string, Promise<void>>();

  constructor(deps: SeatsDeps) {
    this.#deps = deps;
    this.owner = new Seat(OWNER, deps);
    this.people = deps.people.map((person) => new Seat(person, deps));
  }

  get stopped(): boolean {
    return this.#stopping || (this.#deps.stopped?.() ?? false);
  }

  all(): Seat[] {
    return [this.owner, ...this.people];
  }

  /** The seat for a person id; the owner for no id (and for `owner`). Undefined for a name nobody has. */
  get(id?: string): Seat | undefined {
    if (id === undefined || id === '' || id === OWNER.id) return this.owner;
    return this.people.find((seat) => seat.id === id);
  }

  /**
   * Chooses the room a person's chat is in. Refused when it is a room another person's chat already has: each person's account is in their own
   * room only, so it could not be joined anyway, and the choice would leave their seat waiting for a room that never works.
   */
  choose(seat: Seat, room: string): void {
    for (const other of this.all()) {
      if (other === seat) continue;
      if (other.chat?.roomID === room || other.watch?.report().room === room) {
        throw new Error(`That chat is ${other.person.owner ? "the owner's" : `${other.id}'s`}, not ${seat.person.owner ? "the owner's" : `${seat.id}'s`}: each person's bot answers only in their own chat.`);
      }
    }
    seat.choose(room);
  }

  /** The watch for a seat's room: its problem is kept under `room` for the owner and `room:<id>` for anyone else, and names the person. */
  watchFor(seat: Seat): RoomWatch {
    const d = this.#deps;
    return new RoomWatch({
      rooms: () => seat.roomsChosen(),
      find: () => seat.findRooms(),
      found: (room) => seat.keep(room),
      enabled: d.enabled,
      join: (room) => {
        const session = seat.session;
        if (!session) return Promise.reject(new Error(`${seat.person.owner ? 'the owner' : seat.id} is not signed in`));
        return session.matrix.joinRoom(room);
      },
      wait: () => seat.nap(d.waitMs ?? MINUTE),
      stopped: () => this.stopped,
      health: d.health(),
      log: seat.log,
      key: seat.person.owner ? 'room' : `room:${seat.id}`,
      ...(seat.person.owner ? {} : { name: seat.id }),
    });
  }

  /**
   * Starts every seat: each signs its account in, waits for its chat's room, adds the chat to the host, and watches it. They run side by side and none
   * waits for another; a seat that cannot go on says why in its report and the others carry on. Returns at once.
   */
  runAll(): void {
    for (const seat of this.all()) {
      if (this.#runs.has(seat.id)) continue;
      this.#runs.set(seat.id, this.#run(seat).catch((err: unknown) => seat.log(`stopped: ${err instanceof Error ? err.message : String(err)}`)));
    }
  }

  /**
   * Ends every seat's loop; the chats themselves are the host's to stop. A sign-in in progress can't be cut short, and a loop that finishes late
   * does nothing (the host takes no chat once it is stopping), so this waits a moment for them and not for as long as they take.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    for (const seat of this.all()) seat.interrupt();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_WAIT_MS)));
    await Promise.race([Promise.allSettled([...this.#runs.values()]), late]);
    clearTimeout(timer);
  }

  async #run(seat: Seat): Promise<void> {
    const d = this.#deps;
    const retryMs = d.retryMs ?? MINUTE;
    const who = seat.person.owner ? 'the owner' : seat.id;
    const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));
    while (!this.stopped) {
      // Their Matrix account.
      let session = seat.session;
      if (!session) {
        try {
          const { token, userId } = await d.signIn(seat.person);
          if (this.stopped) return;
          session = seat.open(token, userId, d.homeserver(seat.person));
          seat.problem = undefined;
          seat.phase = 'setup';
        } catch (err) {
          if (this.stopped) return;
          seat.problem = reason(err);
          if (err instanceof SeatImpossible) {
            seat.log(`${seat.problem}; ${who} stays out until the host is restarted`);
            return;
          }
          seat.log(`could not sign ${who} in: ${seat.problem}; trying again in a minute`);
          await seat.nap(retryMs);
          continue;
        }
      }

      // Their chat's room.
      const watch = this.watchFor(seat);
      seat.watch = watch;
      let room: string | undefined;
      try {
        room = await watch.ready();
      } catch (err) {
        if (this.stopped) return;
        if (err instanceof MatrixError && err.status === 401) {
          // The homeserver no longer knows this account's token: signing in again makes a new one.
          seat.log('the homeserver no longer accepts the token; signing in again');
          seat.session = undefined;
          seat.phase = 'starting';
          continue;
        }
        seat.log(`could not look for the chat: ${reason(err)}; trying again in a minute`);
        await seat.nap(retryMs);
        continue;
      }
      const host = d.host();
      if (!room || this.stopped || !host) return;
      seat.rememberPhone(room);

      // Their chat on the host. It is taken off again when its room goes, and the seat starts waiting for a new one.
      seat.phase = 'bot-starting';
      let gone!: (room: string | undefined) => void;
      const goneP = new Promise<string | undefined>((resolve) => (gone = resolve));
      seat.onInterrupt(() => gone(undefined));
      try {
        const index = d.people.findIndex((person) => person.id === seat.id);
        seat.chat = await addChat(host, seat.person, {
          token: session.token,
          roomID: room,
          userId: session.userId,
          homeserver: d.homeserver(seat.person),
          onRoomGone: (lost) => gone(lost),
          ...(d.roomCheckEveryMs ? { roomCheckEveryMs: d.roomCheckEveryMs } : {}),
          ...(index >= 0 ? { digestOffsetMinutes: DIGEST_STAGGER_MINUTES * (index + 1) } : {}),
        });
      } catch (err) {
        seat.onInterrupt(undefined);
        seat.chat = undefined;
        seat.phase = 'setup';
        if (this.stopped) return;
        seat.log(`could not start the chat in ${room}: ${reason(err)}; trying again in a minute`);
        await seat.nap(retryMs);
        continue;
      }
      seat.phase = 'running';
      const lost = await goneP;
      seat.onInterrupt(undefined);
      if (lost === undefined || this.stopped) return;
      seat.log(`the chat room ${lost} is gone (the homeserver no longer knows it or won't let ${seat.person.owner ? 'the bot' : `${seat.id}'s account`} in): ${who}'s chat leaves the host until a new chat is chosen. Nobody else's chat is affected`);
      seat.chat = undefined;
      seat.phase = 'setup';
      await removeChat(host, seat.person).catch((err: unknown) => seat.log(`could not take the chat off the host: ${reason(err)}`));
    }
  }
}
