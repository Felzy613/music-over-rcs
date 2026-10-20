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

/** unchosen: no chat to join yet; gone: every room we were told about is unusable; joined: the bot has a room. */
export type RoomState = 'unchosen' | 'gone' | 'joined';

export interface RoomWatchDeps {
  /** The rooms to try, best first (MATRIX_ROOM_ID, then the one chosen on the setup page). */
  rooms(): string[];
  /** False while the bot is switched off (BOT_ENABLED). */
  enabled(): boolean;
  /** Joins a room (accepting the bridge's invite); a join that works again for a room already joined is fine. */
  join(room: string): Promise<void>;
  /** Waits until a chat is chosen, or a while, so a room that comes back by itself is noticed too. */
  wait(): Promise<void>;
  stopped(): boolean;
  health: Pick<Health, 'problem' | 'ok'>;
  log(line: string): void;
}

/**
 * Finds the room the bot answers in, and waits (with the web door still up) when there isn't a usable one, instead of
 * letting the start fail: a bot that exits at every start can't be told on the setup page that its chat is gone, and
 * can't be given the new one. On 2026-10-19 the chat was deleted on the phone, the bridge deleted its room, and the bot
 * restarted every few seconds for hours with nobody told. Other failures (the homeserver down) are still thrown.
 */
export class RoomWatch {
  #deps: RoomWatchDeps;
  #state: RoomState = 'unchosen';
  #gone: string[] = [];
  #since: string | undefined;
  #told = '';

  constructor(deps: RoomWatchDeps) {
    this.#deps = deps;
  }

  /** The room joined, or nothing when the host is stopping. */
  async ready(): Promise<string | undefined> {
    const d = this.#deps;
    while (!d.stopped()) {
      const rooms = d.enabled() ? d.rooms() : [];
      if (rooms.length === 0) {
        this.#state = 'unchosen';
        this.#gone = [];
        if (d.enabled()) d.log('no chat chosen yet: open the setup page, connect Google Messages and choose your chat');
        await d.wait();
        continue;
      }
      const gone: string[] = [];
      for (const room of rooms) {
        try {
          await d.join(room);
        } catch (err) {
          if (!roomUnusable(err)) throw err;
          gone.push(room);
          continue;
        }
        if (gone.length > 0) d.log(`using ${room}: ${gone.join(', ')} cannot be joined`);
        this.#state = 'joined';
        this.#gone = [];
        this.#since = undefined;
        this.#told = '';
        d.health.ok('room', 'Fixed: the bot has its chat room again and is answering.');
        return room;
      }
      this.#state = 'gone';
      this.#gone = gone;
      this.#since ??= new Date().toISOString();
      if (this.#told !== gone.join(' ')) {
        this.#told = gone.join(' ');
        d.log(`the chat room cannot be joined (${gone.join(', ')}): waiting for a chat to be chosen on the setup page, not restarting`);
      }
      d.health.problem(
        'room',
        `The bot's chat room is gone (${gone.join(', ')}): the homeserver no longer knows it or won't let the bot in, which usually means the chat was deleted on the phone and the bridge made a new room. The bot is waiting, not crashing: open the service's /pair page and choose your "message yourself" chat again.`,
      );
      await d.wait();
    }
    return undefined;
  }

  /** What /status shows. */
  report(): { state: RoomState; gone: string[]; since: string | null } {
    return { state: this.#state, gone: [...this.#gone], since: this.#since ?? null };
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
