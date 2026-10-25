import './load-env.ts';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Catalog } from './catalog.ts';
import { ensureTokenPatiently, waitForHomeserver } from './cloud/bootstrap.ts';
import { Pairing, chatNumber, ownChatRooms, selfChatRooms } from './cloud/pairing.ts';
import { createCloudWeb } from './cloud/web.ts';
import { Health, bridgeStatus, macNotify } from './health.ts';
import { DEFAULT_HOMESERVER, MatrixClient } from './matrix/client.ts';
import { alertFromEnv, allNotify, outboxNotify } from './alert.ts';
import { RoomWatch } from './cloud/room.ts';
import { s3FromEnv } from './cloud/s3.ts';
import { archivedThisMonth, sentThisMonth } from './usage.ts';
import { oneDriveFromEnv } from './archive/onedrive.ts';
import { parseCloudBudget } from './config.ts';
import { MemoryWatch } from './cloud/memory.ts';
import { recentTimelines } from './timeline.ts';

// The bot on a cloud host (Render): where matrix-main.ts assumes a Mac with the homeserver and bridge already set up and
// signed in, this starts with nothing but the services running beside it. It opens the web door first (the host wants a
// port at once), waits for the homeserver, signs the bot's account in, lets you pair the bridge with Google Messages on the
// /pair page, finds your "message yourself" chat (or takes the one chosen there), and then starts the same bot as matrix-main.ts.
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const env = process.env;
const startedAt = Date.now();
const homeserver = (env.MATRIX_HOMESERVER?.trim() || DEFAULT_HOMESERVER).replace(/\/+$/, '');
const bridgeUrl = (env.BRIDGE_URL?.trim() || 'http://127.0.0.1:29336').replace(/\/+$/, '');
const bridgeDb = env.BRIDGE_DB?.trim() || '/data/gmessages/mautrix-gmessages.db';
const botEnabled = !/^(off|false|no|0)$/i.test(env.BOT_ENABLED?.trim() ?? '');

/**
 * starting: waiting for the homeserver; setup: waiting for a chat to be chosen; bot-starting: the bot is coming up; running: it
 * is answering. /status also says room-missing for a setup that is waiting because the chat it was given can't be joined.
 */
type Phase = 'starting' | 'setup' | 'bot-starting' | 'running';
let phase: Phase = 'starting';
let session: { token: string; userId: string; pairing: Pairing } | undefined;
let stopping = false;

const catalog = new Catalog(env.CATALOG_DB?.trim() || '/data/catalog.db');
/** The rooms to try, best first: MATRIX_ROOM_ID, then the one chosen on the setup page (the second only matters when the first is gone). */
const roomsChosen = (): string[] => [...new Set([env.MATRIX_ROOM_ID?.trim(), catalog.getState('matrix.room')].filter((room): room is string => Boolean(room)))];
const roomChosen = (): string | undefined => roomsChosen()[0];
let onRoomChosen: (() => void) | undefined;

// Problems found before the bot starts (its chat room is gone) are mailed through the alert outbox like the bot's own; the bot makes its
// own Health when it starts, which also clears this list.
const health = new Health({ notify: allNotify(macNotify, alertFromEnv(env, log)), log, save: (problems) => catalog.setState('health.problems', JSON.stringify(problems)) });
let roomWatch: RoomWatch | undefined;

// Says in the log who holds the memory whenever the container is past 85% of its limit, and keeps the highest it has been for
// /status: a host that runs out of memory is stopped with nothing left to read (the first time, it took a 27 MB song).
const memoryWatch = new MemoryWatch({ log });

const oneDrive = oneDriveFromEnv(env, { state: catalog, log });
const cloudBudget = parseCloudBudget(env.ONEDRIVE_MAX_MB_PER_MONTH);
const oneDriveReport = (): Record<string, unknown> => ({
  ...oneDrive!.status(),
  savedThisMonthMb: Math.round(archivedThisMonth(catalog) / 1048576),
  monthlyLimitMb: cloudBudget instanceof Error || cloudBudget === undefined ? null : Math.round(cloudBudget / 1048576),
});

// The bucket the lease, the alerts and the Worker's notes live in (the same one the databases are backed up to).
const bucket = s3FromEnv(env);
async function edgeReport(): Promise<Record<string, unknown> | undefined> {
  if (!bucket) return undefined;
  try {
    const [lease, watch, waiting] = await Promise.all([bucket.get('lease.json'), bucket.get('watchdog.json'), bucket.list('alerts/')]);
    return {
      lease: lease ? JSON.parse(lease.text) : null,
      watchdog: watch ? ((JSON.parse(watch.text) as { lastCheck?: unknown }).lastCheck ?? null) : null,
      alertsWaiting: waiting.length,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const page = readFileSync(new URL('./cloud/pair.html', import.meta.url), 'utf8');
const web = createCloudWeb({
  adminToken: env.ADMIN_TOKEN?.trim() || undefined,
  pageHtml: page,
  testAlert: bucket ? () => outboxNotify({ s3: bucket, log })('Test alert', 'This is a test from npm run cloud:check. If you can read it, alerts work.') : undefined,
  oneDrive: oneDrive ? { status: oneDriveReport, start: async () => ({ ...(await oneDrive.startLogin()) }) } : undefined,
  async status() {
    const bridge = session
      ? await bridgeStatus({ url: bridgeUrl, token: session.token, userId: session.userId }).catch((err: unknown) => ({ state: undefined, error: err instanceof Error ? err.message : String(err) }))
      : { state: undefined, error: 'the homeserver is not ready yet' };
    let problems: unknown = [];
    try {
      problems = JSON.parse(catalog.getState('health.problems') || '[]');
    } catch {
      // a half-written value is not worth failing the report for
    }
    const room = roomWatch?.report();
    return {
      phase: phase === 'setup' && room?.state === 'gone' ? 'room-missing' : phase,
      botEnabled,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage.rss() / 1048576),
      // The whole container: what it uses against its limit, who holds it, and the highest it has reached since the start.
      memory: memoryWatch.report() ?? null,
      node: process.version,
      // The room the bot joined (given, or found by itself), or the one it was given while it waits.
      room: room?.room ?? roomChosen() ?? null,
      // The rooms that could not be joined (the chat was deleted and the bridge made another), and since when.
      roomGone: room?.state === 'gone' ? { rooms: room.gone, since: room.since } : null,
      bridge,
      problems,
      tracks: catalog.count(),
      sentThisMonthMb: Math.round(sentThisMonth(catalog) / 1048576),
      // The last few requests' timelines (and songs' and albums'), so a check doesn't need a log search.
      timings: recentTimelines.list(),
      ...(oneDrive ? { oneDrive: oneDriveReport() } : {}),
      ...(bucket ? { edge: await edgeReport() } : {}),
    };
  },
  pair: {
    async send(text) {
      if (!session) throw new Error('The homeserver is not ready yet; try again in a minute.');
      await session.pairing.send(text);
    },
    async log() {
      return session ? session.pairing.log() : [];
    },
  },
  rooms: (phone) => selfChatRooms(bridgeDb, phone),
  setRoom(room) {
    catalog.setState('matrix.room', room);
    log(`chat chosen: ${room}`);
    onRoomChosen?.();
  },
  canImport: () => env.ALLOW_IMPORT === '1' && (phase === 'starting' || phase === 'setup') && catalog.isEmpty(),
  importCatalog(path) {
    const counts = catalog.importFrom(path);
    log(`imported a catalog: ${JSON.stringify(counts)}`);
    return counts;
  },
});

const port = Number(env.PORT?.trim() || 8080);
await new Promise<void>((resolve, reject) => {
  web.once('error', reject);
  web.listen(port, env.HOST?.trim() || '0.0.0.0', resolve);
});
log(`web door open on port ${(web.address() as AddressInfo).port}${env.ADMIN_TOKEN ? '' : ' (ADMIN_TOKEN is not set: only /healthz works)'}`);

// Starts looking now that the door is open: see the MemoryWatch declared above.
memoryWatch.start();

const stop = () => {
  // Once the bot has started it has its own shutdown (matrix-main.ts), which also ends the process.
  if (phase === 'running' || stopping) return;
  stopping = true;
  log('shutting down');
  web.close();
  web.closeAllConnections();
  catalog.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
  await waitForHomeserver(homeserver, { log, stopped: () => stopping });
  const { token, userId } = await ensureTokenPatiently({ env, state: catalog, homeserver, log }, { stopped: () => stopping });
  const matrix = new MatrixClient({ token, homeserver });
  session = { token, userId, pairing: new Pairing({ matrix, botId: `@gmessagesbot:${userId.slice(userId.indexOf(':') + 1)}`, userId, log }) };
  phase = 'setup';

  if (!botEnabled) log('BOT_ENABLED is off: the setup page works, but the bot will not answer');
  // Wait for the chat to be joined, and for the bot to be switched on. The chat is the one given (MATRIX_ROOM_ID, or chosen on the
  // setup page) or, when there is none that can be joined, the one found: the bridge's chat with the phone's own number. A chat
  // deleted on the phone (the bridge deletes its room) is waited on here with the web door up, and its new room is taken as soon
  // as the bridge makes it (when the owner texts themself again), instead of the bot starting and failing at every restart.
  roomWatch = new RoomWatch({
    rooms: roomsChosen,
    find: () => ownChatRooms(bridgeDb, { userId, known: [catalog.getState('matrix.phone')].filter((number): number is string => Boolean(number)) }),
    found(room) {
      catalog.setState('matrix.room', room);
    },
    enabled: () => botEnabled,
    join: (room) => matrix.joinRoom(room),
    wait: () =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 60_000);
        timer.unref();
        onRoomChosen = () => {
          clearTimeout(timer);
          resolve();
        };
      }),
    stopped: () => stopping,
    health,
    log,
  });
  const room = await roomWatch.ready();
  if (!stopping && room) {
    // The chat's number (the owner's own) is kept, so its next room is found even if the phone never says its number.
    try {
      const number = chatNumber(bridgeDb, room);
      if (number) catalog.setState('matrix.phone', number);
    } catch (err) {
      log(`could not read the chat's number from the bridge's database: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.env.MATRIX_ACCESS_TOKEN = token;
    process.env.MATRIX_ROOM_ID = room;
    // The bridge was set up to say when Google Messages has each message (matrix.message_status_events, provision.ts).
    process.env.BRIDGE_STATUS_EVENTS = '1';
    phase = 'bot-starting';
    // The bot proper: this returns once it is up (it signs in, joins the chat and starts answering), and it runs until the process ends.
    await import('./matrix-main.ts');
    phase = 'running';
  }
} catch (err) {
  console.error(`cannot start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
