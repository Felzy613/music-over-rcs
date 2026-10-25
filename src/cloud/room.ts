import type { Health } from '../health.ts';
import { MatrixError } from '../matrix/client.ts';

/**
 * Whether a failed join means this room can't be used (the homeserver doesn't know it, or won't let the bot in), as against
 * the homeserver having a moment. Synapse answers 404 for a room it has no record of, which is what is left when the bridge
 * deletes a chat's room (a chat deleted on the phone, a chat re-created under another id), and 403 when the bot may not enter.
 */
export function roomUnusable(err: unknown): boolean {
  return err instanceof MatrixError && (err.status === 404 || err.status === 403);
}

/** Whether a failed join is the homeserver asking the bot to slow down: a reason to wait, not to stop. */
const slowDown = (err: unknown): boolean => err instanceof MatrixError && err.status === 429;

/** unchosen: no chat to join yet; gone: every room we were told about or found is unusable; joined: the bot has a room. */
export type RoomState = 'unchosen' | 'gone' | 'joined';

export interface RoomWatchDeps {
  /** The rooms to try, best first (MATRIX_ROOM_ID, then the one chosen on the setup page). */
  rooms(): string[];
  /**
   * The rooms of the owner's own chat the host finds with nobody's help (the bridge's chat with the phone's own number), best
   * first: tried after `rooms`, so a chat deleted on the phone and texted again is found without anyone choosing it.
   */
  find?(): string[] | Promise<string[]>;
  /** A room that was found, not given, has been joined: the host keeps it as the chat chosen. */
  found?(room: string): void;
  /** False while the bot is switched off (BOT_ENABLED). */
  enabled(): boolean;
  /** Joins a room (accepting the bridge's invite); a join that works again for a room already joined is fine. */
  join(room: string): Promise<void>;
  /** Waits until a chat is chosen, or a while, so a room that comes back by itself (or a new one the bridge makes) is noticed too. */
  wait(): Promise<void>;
  stopped(): boolean;
  health: Pick<Health, 'problem' | 'ok'>;
  log(line: string): void;
}

/**
 * Finds the room the bot answers in, and waits (with the web door still up) when there isn't a usable one, instead of
 * letting the start fail: a bot that exits at every start can't be told on the setup page that its chat is gone, and
 * can't be given the new one. On 2026-10-19 the chat was deleted on the phone, the bridge deleted its room, and the bot
 * restarted every few seconds for hours with nobody told. It happened again on 2026-10-22, and nobody chose the chat again:
 * so the room of the owner's own chat is also looked for (`find`), and a new one is taken as soon as the bridge makes it.
 * The homeserver asking the bot to slow down (HTTP 429) is waited out too: on 2026-10-25 it made every start fail. Other
 * failures (the homeserver down) are still thrown.
 */
export class RoomWatch {
  #deps: RoomWatchDeps;
  #state: RoomState = 'unchosen';
  #gone: string[] = [];
  #since: string | undefined;
  #told = '';
  #findFailed = '';
  #slowed = false;
  #room: string | undefined;

  constructor(deps: RoomWatchDeps) {
    this.#deps = deps;
  }

  /** The rooms `find` gives, or none when it fails (the bridge hasn't made its database yet): said once per different failure. */
  async #find(): Promise<string[]> {
    try {
      const rooms = (await this.#deps.find?.()) ?? [];
      this.#findFailed = '';
      return rooms;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (this.#findFailed !== reason) this.#deps.log(`could not look for your chat in the bridge's database: ${reason}`);
      this.#findFailed = reason;
      return [];
    }
  }

  /** The room joined, or nothing when the host is stopping. */
  async ready(): Promise<string | undefined> {
    const d = this.#deps;
    while (!d.stopped()) {
      if (!d.enabled()) {
        this.#state = 'unchosen';
        this.#gone = [];
        await d.wait();
        continue;
      }
      const chosen = d.rooms();
      const gone: string[] = [];
      let joined: string | undefined;
      let wasFound = false;
      let slowed = false;
      const tryJoin = async (room: string): Promise<boolean> => {
        try {
          await d.join(room);
          return true;
        } catch (err) {
          if (slowDown(err)) {
            slowed = true;
            return false;
          }
          if (!roomUnusable(err)) throw err;
          gone.push(room);
          return false;
        }
      };
      for (const room of chosen) {
        if (await tryJoin(room)) {
          joined = room;
          break;
        }
        if (slowed) break;
      }
      const found = joined || slowed ? [] : (await this.#find()).filter((room) => !chosen.includes(room));
      for (const room of found) {
        if (await tryJoin(room)) {
          joined = room;
          wasFound = true;
          break;
        }
        if (slowed) break;
      }
      if (joined) {
        if (wasFound) {
          d.found?.(joined);
          d.log(`found your chat by itself: ${joined}${gone.length > 0 ? ` (${gone.join(', ')} cannot be joined)` : ''}`);
        } else if (gone.length > 0) d.log(`using ${joined}: ${gone.join(', ')} cannot be joined`);
        this.#state = 'joined';
        this.#gone = [];
        this.#since = undefined;
        this.#told = '';
        this.#slowed = false;
        this.#room = joined;
        d.health.ok('room', 'Fixed: the bot has its chat room again and is answering.');
        return joined;
      }
      if (slowed) {
        // The homeserver counts joins: waiting a minute is what it asks for. Nothing about the room is known from this.
        if (!this.#slowed) d.log('the homeserver asked the bot to slow down (HTTP 429) while joining its chat: trying again in a minute, not restarting');
        this.#slowed = true;
        await d.wait();
        continue;
      }
      this.#slowed = false;
      if (gone.length === 0) {
        this.#state = 'unchosen';
        this.#gone = [];
        d.log('no chat chosen yet: text yourself once on your phone (the bot finds that chat by itself), or choose it on the setup page');
        await d.wait();
        continue;
      }
      this.#state = 'gone';
      this.#gone = gone;
      this.#since ??= new Date().toISOString();
      if (this.#told !== gone.join(' ')) {
        this.#told = gone.join(' ');
        d.log(`the chat room cannot be joined (${gone.join(', ')}): waiting for your chat to come back (text yourself on the phone) or to be chosen on the setup page, not restarting`);
      }
      d.health.problem(
        'room',
        `The bot's chat room is gone (${gone.join(', ')}): the homeserver no longer knows it or won't let the bot in, which usually means the chat was deleted on the phone. The bot is waiting, not crashing, and finds your chat by itself: text yourself once from your phone, and it starts answering in that chat within a minute or two. If it doesn't, open the service's /pair page and choose your "message yourself" chat there.`,
      );
      await d.wait();
    }
    return undefined;
  }

  /** What /status shows: the room joined, if one is. */
  report(): { state: RoomState; room: string | null; gone: string[]; since: string | null } {
    return { state: this.#state, room: this.#room ?? null, gone: [...this.#gone], since: this.#since ?? null };
  }
}

/**
 * Looks at the room now and then while the bot runs. A chat deleted on the phone takes its room with it, and the bot keeps
 * running without hearing from it: on 2026-10-19 it answered nothing for ten hours, until the first message the room refused
 * crashed it. Joining a room already joined does nothing, so this asks the homeserver whether the bot still has it; when the
 * homeserver has forgotten it, `onGone` is called once (the bot stops, and the host's next start waits for a new chat to be
 * chosen). Any other failure is only logged: the homeserver having a moment is not the room being gone. Returns the function
 * that ends the checks.
 */
export function watchJoinedRoom(options: { join(): Promise<void>; onGone(): void; everyMs?: number; log(line: string): void }): () => void {
  let looking = false;
  let finished = false;
  const timer = setInterval(() => {
    if (looking || finished) return;
    looking = true;
    options
      .join()
      .catch((err: unknown) => {
        if (finished) return;
        if (roomUnusable(err)) {
          finished = true;
          clearInterval(timer);
          options.onGone();
        } else {
          options.log(`could not check the chat room: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
      .finally(() => {
        looking = false;
      });
  }, options.everyMs ?? 5 * 60_000);
  timer.unref();
  return () => {
    finished = true;
    clearInterval(timer);
  };
}
