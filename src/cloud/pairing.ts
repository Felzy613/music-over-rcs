import { DatabaseSync } from 'node:sqlite';
import type { MatrixClient } from '../matrix/client.ts';
import { groupPastedLines } from '../matrix/paste.ts';
import type { PairLine } from './web.ts';

const KEEP_LINES = 100;
/** A pasted request carries Google session cookies, so it is taken back out of the chat shortly after the bridge has read it. */
const REDACT_AFTER_MS = 60_000;
const LONG_PASTE = 300;

/**
 * A chat window to the bridge's bot for the web page: what is sent goes to it as typed (a pasted multi-line request as one
 * message, as the terminal console does), and what it answers is kept to show. A long paste (the Google request, which holds
 * session cookies) is deleted from the chat a minute later, so the cookies don't stay in the homeserver's database or its backups.
 */
export class Pairing {
  #matrix: MatrixClient;
  #botId: string;
  #userId: string;
  #room: string | undefined;
  #lines: PairLine[] = [];
  #polling: Promise<void> = Promise.resolve();
  #redactAfterMs: number;
  #log: (line: string) => void;

  constructor(options: { matrix: MatrixClient; botId: string; userId: string; redactAfterMs?: number; log?: (line: string) => void }) {
    this.#matrix = options.matrix;
    this.#botId = options.botId;
    this.#userId = options.userId;
    this.#redactAfterMs = options.redactAfterMs ?? REDACT_AFTER_MS;
    this.#log = options.log ?? (() => {});
  }

  async #open(): Promise<string> {
    if (this.#room) return this.#room;
    const rooms = await this.#matrix.listRooms();
    this.#room = rooms.find((room) => !room.invited && room.members <= 2 && room.heroes.includes(this.#botId))?.id ?? (await this.#matrix.createDirectRoom(this.#botId));
    // Reading from here on: what was said before is not shown.
    await this.#matrix.pollEvents(this.#room);
    return this.#room;
  }

  async send(text: string): Promise<void> {
    const room = await this.#open();
    async function* lines() {
      yield* text.split('\n');
    }
    for await (const message of groupPastedLines(lines())) {
      const id = await this.#matrix.sendText(room, message.text);
      if (id && (message.lines > 1 || message.text.length > LONG_PASTE)) {
        const timer = setTimeout(() => this.#matrix.redact(room, id).catch((err: unknown) => this.#log(`could not delete the pasted request from the chat: ${err instanceof Error ? err.message : String(err)}`)), this.#redactAfterMs);
        timer.unref();
      }
    }
  }

  /** What the bridge's bot has said since the last call, added to what it said before (the newest 100). */
  async log(): Promise<PairLine[]> {
    const room = await this.#open();
    // One read at a time: each moves the position the next starts from.
    this.#polling = this.#polling.then(async () => {
      for (const event of await this.#matrix.pollEvents(room)) {
        if (event.sender === this.#userId) continue;
        this.#lines.push({ at: new Date().toISOString(), text: event.body });
      }
      this.#lines = this.#lines.slice(-KEEP_LINES);
    });
    await this.#polling;
    return [...this.#lines];
  }
}

/**
 * The rooms the bridge made for the chat with a phone number (your own number, for the "message yourself" chat), read from the
 * bridge's own database without changing it. Empty until the bridge has seen that chat.
 */
export function selfChatRooms(bridgeDb: string, phoneDigits: string): string[] {
  const digits = phoneDigits.replace(/\D/g, '').slice(-10);
  if (digits.length < 7) return [];
  const db = new DatabaseSync(bridgeDb, { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT p.mxid AS room, d.phone_number AS phone FROM gmessages_direct_conversation d JOIN portal p ON p.id = d.portal_id WHERE p.mxid IS NOT NULL')
      .all();
    return [...new Set(rows.filter((row) => String(row.phone).replace(/\D/g, '').endsWith(digits)).map((row) => String(row.room)))];
  } finally {
    db.close();
  }
}
