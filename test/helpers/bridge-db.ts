import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

// A stand-in for the Google Messages bridge's database, with the tables and columns src/cloud/pairing.ts reads, for several people at once:
// each person has a Matrix account (`user`), a Google login of their own (`login`) with the phone number their SIM reports, and the chats
// the bridge has made for them (a room each, or none once the chat was deleted on the phone).

export interface FixtureChat {
  /** The number at the other end: the person's own for their "message yourself" chat. */
  phone: string;
  /** The Matrix room the bridge made for it; none for a chat whose room was deleted. */
  room: string | null;
  /** When its newest message was (newer first). */
  at: number;
}

export interface FixtureLogin {
  /** The bridge's id for this Google login. */
  login: string;
  /** The Matrix account it belongs to. */
  user: string;
  /** The numbers Google Messages reported for the phone's SIMs (none: a SIM that doesn't say its number). */
  sims?: string[];
  chats?: FixtureChat[];
}

let counter = 0;

/** Writes a bridge database into `dir` and returns its path. */
export function writeBridgeDb(dir: string, logins: FixtureLogin[]): string {
  const path = join(dir, `bridge-${++counter}.db`);
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE user_login (bridge_id TEXT, user_mxid TEXT, id TEXT, remote_name TEXT, metadata TEXT);
    CREATE TABLE portal (bridge_id TEXT, id TEXT, receiver TEXT, mxid TEXT);
    CREATE TABLE gmessages_direct_conversation (bridge_id TEXT, login_id TEXT, phone_number TEXT, portal_id TEXT, last_message_ts INTEGER)`);
  db.close();
  for (const login of logins) addLogin(path, login);
  return path;
}

/** A login appears (the person linked Google Messages), with the chats it already has. */
export function addLogin(path: string, login: FixtureLogin): void {
  const db = new DatabaseSync(path);
  try {
    const sims = Object.fromEntries((login.sims ?? []).map((number, index) => [String(index + 1), { SIMData: { carrierName: 'Carrier', formattedPhoneNumber: number }, SIMParticipant: { ID: String(index + 1) } }]));
    db.prepare("INSERT INTO user_login VALUES ('gmessages', ?, ?, '', ?)").run(login.user, login.login, JSON.stringify({ session: { secret: 'x' }, sim_metadata: sims }));
  } finally {
    db.close();
  }
  for (const chat of login.chats ?? []) addChat(path, login.login, chat);
}

/** The bridge makes a chat (a room) for a login: what happens when the person texts themself. */
export function addChat(path: string, login: string, chat: FixtureChat): void {
  const db = new DatabaseSync(path);
  try {
    counter++;
    const portal = `portal-${counter}`;
    db.prepare("INSERT INTO portal VALUES ('gmessages', ?, ?, ?)").run(portal, login, chat.room);
    db.prepare("INSERT INTO gmessages_direct_conversation VALUES ('gmessages', ?, ?, ?, ?)").run(login, chat.phone, portal, chat.at);
  } finally {
    db.close();
  }
}

/** The bridge deletes a room (the chat was deleted on the phone): the portal stays, with no room. */
export function deleteRoom(path: string, room: string): void {
  const db = new DatabaseSync(path);
  try {
    db.prepare('UPDATE portal SET mxid = NULL WHERE mxid = ?').run(room);
  } finally {
    db.close();
  }
}
