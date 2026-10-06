import '../src/load-env.ts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadMatrixConfig } from '../src/config.ts';
import { describeMatrixError, MatrixClient } from '../src/matrix/client.ts';

// Lists the rooms your account is in or invited to, so you can find the one the bridge made for your
// "message yourself" chat. An optional word filters the list.
//   npm run matrix-rooms -- --phone 5551234567   the room of your chat with that number (your own, for the bot)
const args = process.argv.slice(2);
const phoneAt = args.indexOf('--phone');

if (phoneAt >= 0) {
  // The bridge keeps which room is which phone number's chat in its own database; read it, change nothing.
  const digits = (args[phoneAt + 1] ?? '').replace(/\D/g, '').slice(-10);
  if (digits.length < 7) {
    console.error('usage: npm run matrix-rooms -- --phone <your number, digits only or as you like>');
    process.exit(2);
  }
  const home = process.env.MORS_HOME?.trim() || join(homedir(), 'Library', 'Application Support', 'music-over-rcs');
  let rooms: string[];
  try {
    const db = new DatabaseSync(join(home, 'gmessages', 'mautrix-gmessages.db'), { readOnly: true });
    rooms = db
      .prepare('SELECT p.mxid AS room, d.phone_number AS phone FROM gmessages_direct_conversation d JOIN portal p ON p.id = d.portal_id WHERE p.mxid IS NOT NULL')
      .all()
      .filter((row) => String(row.phone).replace(/\D/g, '').endsWith(digits))
      .map((row) => String(row.room));
    db.close();
  } catch (err) {
    console.error(`Could not read the bridge's database in ${home}/gmessages: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Is the bridge installed (npm run mac:setup) and logged in? MORS_HOME points elsewhere if you moved it.');
    process.exit(1);
  }
  if (rooms.length === 0) {
    console.log("The bridge has no room for a chat with that number yet. Text that number once on your phone, wait a few seconds, and try again.");
  } else {
    for (const room of [...new Set(rooms)]) console.log(room);
    console.log('\nPut it in .env as MATRIX_ROOM_ID. You are only invited until the bot joins it for you, when it starts.');
  }
  process.exit(0);
}

const filter = args.join(' ').trim().toLowerCase();
let homeserver: string | undefined;

try {
  const config = loadMatrixConfig(process.env, { room: false });
  homeserver = config.homeserver;
  const matrix = new MatrixClient({ token: config.token, homeserver });
  const rooms = (await matrix.listRooms()).filter(
    (room) => !filter || `${room.name} ${room.id} ${room.heroes.join(' ')}`.toLowerCase().includes(filter),
  );

  if (rooms.length === 0) console.log(filter ? `no rooms match "${filter}"` : 'no rooms yet; is the bridge logged in?');
  for (const room of rooms) {
    const details = [
      room.invited ? 'INVITED' : 'joined',
      room.name || '(no name)',
      room.members ? `${room.members} members` : '',
      room.heroes.join(', '),
    ].filter(Boolean);
    console.log(`${room.id}\n    ${details.join(' | ')}`);
  }
  console.log('\nPut the room ID in .env as MATRIX_ROOM_ID. If you are only invited, the bot joins for you when it starts.');
} catch (err) {
  console.error(describeMatrixError(err, homeserver));
  process.exit(1);
}
