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

/** A phone number's digits as they can be compared: a leading 0 (a trunk or an international prefix) says nothing about the number. */
const digitsOf = (number: string): string => number.replace(/\D/g, '').replace(/^0+/, '');

/**
 * Whether two ways of writing a phone number are the same number: "+1 (555) 123-4567" and "5551234567", "+972 54-123-4567" and
 * "054-123-4567". The shorter must end the longer and have at least eight digits, so a partial number matches nothing.
 */
export function sameNumber(a: string, b: string): boolean {
  const [short, long] = [digitsOf(a), digitsOf(b)].sort((x, y) => x.length - y.length) as [string, string];
  return short.length >= 8 && long.endsWith(short);
}

interface DirectChat {
  login: string;
  phone: string;
  room: string;
}

/** The bridge's one-to-one chats that have a room, the chat with the newest message first. */
function directChats(db: DatabaseSync): DirectChat[] {
  return db
    .prepare(
      `SELECT d.login_id AS login, d.phone_number AS phone, p.mxid AS room
       FROM gmessages_direct_conversation d JOIN portal p ON p.id = d.portal_id AND p.receiver IN (d.login_id, '')
       WHERE p.mxid IS NOT NULL ORDER BY d.last_message_ts DESC`,
    )
    .all()
    .map((row) => ({ login: String(row.login), phone: String(row.phone), room: String(row.room) }));
}

function readBridge<T>(bridgeDb: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(bridgeDb, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/**
 * The rooms the bridge made for the chat with a phone number (your own number, for the "message yourself" chat), read from the
 * bridge's own database without changing it. Empty until the bridge has seen that chat.
 */
export function selfChatRooms(bridgeDb: string, phone: string): string[] {
  if (digitsOf(phone).length < 7) return [];
  return readBridge(bridgeDb, (db) => [...new Set(directChats(db).filter((chat) => sameNumber(chat.phone, phone)).map((chat) => chat.room))]);
}

/**
 * The phone's own numbers for each of the bridge's logins: what Google Messages told the bridge about each SIM, kept in the
 * login's settings. A SIM whose carrier doesn't give its number has none.
 */
function ownNumbers(db: DatabaseSync, userId: string | undefined): Map<string, string[]> {
  const numbers = new Map<string, string[]>();
  for (const row of db.prepare('SELECT id, user_mxid, metadata FROM user_login').all()) {
    if (userId && row.user_mxid !== userId) continue;
    let sims: Record<string, { SIMData?: { formattedPhoneNumber?: string } }> = {};
    try {
      sims = (JSON.parse(String(row.metadata)) as { sim_metadata?: typeof sims }).sim_metadata ?? {};
    } catch {
      // a login whose settings can't be read has no numbers to offer
    }
    const own = Object.values(sims).flatMap((sim) => (sim?.SIMData?.formattedPhoneNumber ? [sim.SIMData.formattedPhoneNumber] : []));
    numbers.set(String(row.id), own);
  }
  return numbers;
}

/**
 * The rooms of your "message yourself" chat, found with nobody's help: the one-to-one chat whose other end is one of the phone's
 * own numbers (what Google Messages told the bridge about its SIMs), or one of `known` (the number of the chat the bot used
 * before, for a SIM that doesn't say its number). Only a chat with yourself has your own number at the other end. Newest first;
 * empty until the bridge has made the chat's room, which it does when you text yourself.
 */
export function ownChatRooms(bridgeDb: string, options: { userId?: string; known?: string[] } = {}): string[] {
  return readBridge(bridgeDb, (db) => {
    const numbers = ownNumbers(db, options.userId);
    const mine = (chat: DirectChat): boolean => {
      const own = numbers.get(chat.login);
      return own !== undefined && [...own, ...(options.known ?? [])].some((number) => sameNumber(chat.phone, number));
    };
    return [...new Set(directChats(db).filter(mine).map((chat) => chat.room))];
  });
}

/** The phone number at the other end of the chat with this room (yours, for your own chat), or nothing for a room that isn't a one-to-one chat. */
export function chatNumber(bridgeDb: string, room: string): string | undefined {
  return readBridge(bridgeDb, (db) => directChats(db).find((chat) => chat.room === room)?.phone);
}
