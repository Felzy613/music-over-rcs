import './load-env.ts';
import './admin/capture.ts';
import type { AddressInfo } from 'node:net';
import { AdminAccount, Sessions, sessionBinding } from './admin/account.ts';
import { adminConsole, type ConnectDeps } from './admin/console.ts';
import { SignIn } from './admin/sign-in.ts';
import { Catalog } from './catalog.ts';
import { ensureTokenPatiently, peopleAccounts, waitForHomeserver, type MatrixAccount } from './cloud/bootstrap.ts';
import { createCloudWeb } from './cloud/web.ts';
import { Health, bridgeStatus, macNotify } from './health.ts';
import { startHost, type Host } from './host.ts';
import { DEFAULT_HOMESERVER } from './matrix/client.ts';
import { alertFromEnv, allNotify, outboxNotify } from './alert.ts';
import { SeatImpossible, Seats } from './cloud/seats.ts';
import { s3FromEnv } from './cloud/s3.ts';
import { archivedThisMonth, peopleTraffic, sentByEveryone, sentThisMonth } from './usage.ts';
import { oneDriveFromEnv } from './archive/onedrive.ts';
import { parseCloudBudget, personBudgetOrDefault } from './config.ts';
import { peopleFromEnv, tagLine, type Person } from './people.ts';
import { MemoryWatch } from './cloud/memory.ts';
import { recentTimelines } from './timeline.ts';

// The bot on a cloud host (Render): where matrix-main.ts assumes a Mac with the homeserver and bridge already set up and
// signed in, this starts with nothing but the services running beside it. It opens the web door first (the host wants a
// port at once), waits for the homeserver, signs the bot's account in, lets you pair the bridge with Google Messages on the
// Connect page of the console (the old /pair address goes there), finds your "message yourself" chat (or takes the one chosen there), and then starts the same bot as matrix-main.ts.
//
// With people besides the owner (PEOPLE) the start differs in one way: the host (everything the chats share, src/host.ts) is built as soon as
// the homeserver is up and the owner is signed in, with no room needed, and each person's chat, the owner's too, is added to it by that
// person's own seat (src/cloud/seats.ts) when their own room is joined. A person whose account can't be signed in, or whose chat was deleted
// on the phone, never stops the owner's chat or anyone else's. With nobody in PEOPLE the owner's start goes exactly as it always did.
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const env = process.env;
const startedAt = Date.now();
const homeserver = (env.MATRIX_HOMESERVER?.trim() || DEFAULT_HOMESERVER).replace(/\/+$/, '');
const bridgeUrl = (env.BRIDGE_URL?.trim() || 'http://127.0.0.1:29336').replace(/\/+$/, '');
const bridgeDb = env.BRIDGE_DB?.trim() || '/data/gmessages/mautrix-gmessages.db';
const botEnabled = !/^(off|false|no|0)$/i.test(env.BOT_ENABLED?.trim() ?? '');

let stopping = false;
/** The host the chats are added to when there are people (PEOPLE). With only the owner, matrix-main.ts builds it once the owner's room is joined. */
let host: Host | undefined;

const catalog = new Catalog(env.CATALOG_DB?.trim() || '/data/catalog.db');

// Problems found before the bot starts (its chat room is gone) are mailed through the alert outbox like the bot's own; the bot makes its
// own Health when it starts, which also clears this list.
const health = new Health({ notify: allNotify(macNotify, alertFromEnv(env, log)), log, save: (problems) => catalog.setState('health.problems', JSON.stringify(problems)) });

// Says in the log who holds the memory whenever the container is past 85% of its limit, and keeps the highest it has been for
// /status: a host that runs out of memory is stopped with nothing left to read (the first time, it took a 27 MB song).
const memoryWatch = new MemoryWatch({ log });

const oneDrive = oneDriveFromEnv(env, { state: catalog, log });
const cloudBudget = parseCloudBudget(env.ONEDRIVE_MAX_MB_PER_MONTH);
// The people besides the owner (PEOPLE) and the most each may be sent in a month, for /status. A name that can't be used is left out and said.
const { people: configuredPeople, problems: peopleProblems } = peopleFromEnv(env);
for (const problem of peopleProblems) log(problem);
const personBudget = personBudgetOrDefault(env.PERSON_MAX_MB_PER_MONTH, log);
// The accounts the host made for the people: filled in once the owner is signed in (an account's id has the homeserver's name in it).
const accounts = new Map<string, MatrixAccount>();

// Everyone who uses the bot, each in a seat of their own (src/cloud/seats.ts): the owner's account, token, chat window to the bridge and room, and
// each person's. The owner's seat is what this file's own start-up fills in; the people's run by themselves once the host is up.
const seats = new Seats({
  people: configuredPeople,
  env,
  state: catalog,
  bridgeDb,
  log,
  homeserver: () => homeserver,
  enabled: () => botEnabled,
  stopped: () => stopping,
  host: () => host,
  // Before the host exists (the owner-only start) problems found are said by the pre-start Health above; the host's own takes over after.
  health: () => host?.health ?? health,
  signIn(person: Person) {
    if (person.owner) return ensureTokenPatiently({ env, state: catalog, homeserver, log }, { stopped: () => stopping });
    const account = accounts.get(person.id);
    if (!account) return Promise.reject(new SeatImpossible(`The host handed over no Matrix password for ${person.id}, so the bot cannot sign ${person.id} in`));
    return ensureTokenPatiently({ env, state: catalog, homeserver, account, log: (line) => log(tagLine(person, line)) }, { stopped: () => stopping });
  },
});
const ownerSeat = seats.owner;
/** The seat for a person id (the owner's for none). The routes check the id against the people first, so this finding nobody is a mistake. */
const seatOf = (person?: string) => {
  const seat = seats.get(person);
  if (!seat) throw new Error(`There is nobody called "${person}" on this host.`);
  return seat;
};

// The settings the owner's console can change while the bot runs sit over the environment (src/admin/settings.ts): the allowance shown
// here is the one in force.
const liveSettings = adminConsole.liveSettings(catalog, env);
const oneDriveReport = (): Record<string, unknown> => {
  const budget = liveSettings.cloudBudget(cloudBudget instanceof Error ? undefined : cloudBudget);
  return {
    ...oneDrive!.status(),
    savedThisMonthMb: Math.round(archivedThisMonth(catalog) / 1048576),
    monthlyLimitMb: budget === undefined ? null : Math.round(budget / 1048576),
  };
};

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

/** Whether a problem is a person's: their problems are kept under keys ending `:<id>` (`room:alice`). */
const isPersonsProblem = (problem: unknown, id: string): boolean => {
  const key = (problem as { key?: unknown } | null)?.key;
  return typeof key === 'string' && key.endsWith(`:${id}`);
};

/**
 * The problems the host has right now. The owner's report keeps the host's own and the owner's (all of them when there is nobody else); a
 * person's has only theirs, so the owner's /status keeps meaning "the owner is being answered".
 */
function problemsFor(person?: string): unknown {
  let problems: unknown = [];
  try {
    problems = JSON.parse(catalog.getState('health.problems') || '[]');
  } catch {
    // a half-written value is not worth failing the report for
  }
  if (configuredPeople.length === 0 || !Array.isArray(problems)) return problems;
  return person === undefined ? problems.filter((problem) => !configuredPeople.some((one) => isPersonsProblem(problem, one.id))) : problems.filter((problem) => isPersonsProblem(problem, person));
}

/**
 * The light part of the report: where the start is, whether the bot answers, its chat, the bridge's login and the problems. The console's
 * Connect page asks for it every few seconds, so it makes no call to the bucket (as /status does) or to OneDrive. With a `person` it is that
 * person's own; the owner's also names the people and where each stands, when there are any, so the page can draw its selector.
 */
async function connectState(person?: string): Promise<Record<string, unknown>> {
  const seat = seatOf(person);
  const session = seat.session;
  const bridge =
    person !== undefined
      ? await seat.bridge(bridgeUrl)
      : session
        ? await bridgeStatus({ url: bridgeUrl, token: session.token, userId: session.userId }).catch((err: unknown) => ({ state: undefined, error: err instanceof Error ? err.message : String(err) }))
        : { state: undefined, error: 'the homeserver is not ready yet' };
  const room = seat.watch?.report();
  return {
    phase: seat.phase === 'setup' && room?.state === 'gone' ? 'room-missing' : seat.phase,
    botEnabled,
    // The room the bot joined (given, or found by itself), or the one it was given while it waits.
    room: room?.room ?? seat.roomsChosen()[0] ?? null,
    // The rooms that could not be joined (the chat was deleted and the bridge made another), and since when.
    roomGone: room?.state === 'gone' ? { rooms: room.gone, since: room.since } : null,
    bridge,
    problems: problemsFor(person),
    // A person's also says whether their phone gave the bridge its number and whether their own chat has arrived (the onboarding gate, src/cloud/onboarding.ts).
    ...(person !== undefined ? { person, error: seat.problem ?? null, simNumber: seat.hasSimNumber(), onboarding: seat.onboarding(bridge) } : configuredPeople.length > 0 ? { people: seats.people.map((one) => ({ id: one.id, phase: one.report().phase })) } : {}),
  };
}

/** Each person's own standing for /status: where their chat is, their login at the bridge, whether their SIM gives its number, their problems. */
async function peopleStanding(): Promise<Map<string, Record<string, unknown>>> {
  const standing = await Promise.all(
    seats.people.map(async (seat) => {
      const report = seat.report();
      const bridge = await seat.bridge(bridgeUrl);
      // `onboarding` is the gate for a new person (src/cloud/onboarding.ts): linked, the phone gave its number, and their own chat has arrived.
      return [
        seat.id,
        { phase: report.phase, roomMissing: report.phase === 'room-missing', room: report.room, roomGone: report.roomGone, error: report.error, bridge, simNumber: seat.hasSimNumber(), onboarding: seat.onboarding(bridge), problems: problemsFor(seat.id) },
      ] as const;
    }),
  );
  return new Map(standing);
}

/** What a person's phase says if they have no seat (they always have one: this is for a name that is not in PEOPLE). */
const PERSON_PHASE_UNKNOWN = 'not-started';

/** What /status reports, and the management console's overview (src/admin/console.ts) shows. */
async function statusReport(): Promise<Record<string, unknown>> {
  const [owner, standing] = await Promise.all([connectState(), peopleStanding()]);
  return {
    ...owner,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    memoryMb: Math.round(process.memoryUsage.rss() / 1048576),
    // The whole container: what it uses against its limit, who holds it, and the highest it has reached since the start.
    memory: memoryWatch.report() ?? null,
    node: process.version,
    tracks: catalog.count(),
    // The owner's own; everybody's together (what Render's allowance is spent by) is the next, and each other person's the list after it.
    sentThisMonthMb: Math.round(sentThisMonth(catalog) / 1048576),
    sentTotalThisMonthMb: Math.round(sentByEveryone(catalog) / 1048576),
    // Each person besides the owner: their chat's state, their login at the bridge and what they were sent this month. The fields above are the owner's alone.
    people: peopleTraffic(catalog, configuredPeople, personBudget).map(({ id, ...traffic }) => ({ id, ...(standing.get(id) ?? { phase: PERSON_PHASE_UNKNOWN }), ...traffic })),
    // The last few requests' timelines (and songs' and albums'), so a check doesn't need a log search.
    timings: recentTimelines.list(),
    ...(oneDrive ? { oneDrive: oneDriveReport() } : {}),
    ...(bucket ? { edge: await edgeReport() } : {}),
  };
}
// Signing in to the pages: the owner's own user name and password, kept in the database (src/admin/account.ts), or the ADMIN_TOKEN from Render.
const signIn = new SignIn({ token: env.ADMIN_TOKEN, account: new AdminAccount({ state: catalog }), sessions: new Sessions({ state: catalog, binding: sessionBinding(env.ADMIN_TOKEN?.trim() || undefined) }), log });

// Linking Google Messages, the chat the bot answers in, OneDrive's sign-in: the console's Connect page (src/admin/console.ts) and the older
// routes below (which scripts may still use) share these, and both take an optional person (the owner when none is named).
const pairWindow: ConnectDeps['pair'] = {
  async send(text, person) {
    const session = seatOf(person).session;
    if (!session) throw new Error(person === undefined ? 'The homeserver is not ready yet; try again in a minute.' : `${person}'s Matrix account is not ready yet; try again in a minute.`);
    await session.pairing.send(text);
  },
  async log(person) {
    const session = seatOf(person).session;
    return session ? session.pairing.log() : [];
  },
};
function chooseRoom(room: string, person?: string): void {
  seats.choose(seatOf(person), room);
}
const sendTestAlert = bucket ? () => outboxNotify({ s3: bucket, log })('Test alert', 'This is a test from the management console. If you can read it, alerts work.') : undefined;
const oneDriveSignIn = oneDrive ? { status: oneDriveReport, start: async () => ({ ...(await oneDrive.startLogin()) }) } : undefined;
const people = (): Array<{ id: string }> => configuredPeople.map(({ id }) => ({ id }));
const connect: ConnectDeps = {
  state: connectState,
  pair: pairWindow,
  // With no number given, the phone's own: what Google Messages told the bridge about each SIM, or the number the chat was found under before.
  rooms: (phone, person) => seatOf(person).rooms(phone),
  setRoom: chooseRoom,
  knownPhone: (person) => seatOf(person).knownPhone(),
  people,
  oneDrive: oneDriveSignIn,
  testAlert: sendTestAlert,
};
adminConsole.provide({ catalog, env, status: statusReport, startedAt, log, settings: liveSettings, signIn, connect, ...(oneDrive ? { oneDrive: oneDriveReport } : {}) });

const web = createCloudWeb({
  adminToken: env.ADMIN_TOKEN?.trim() || undefined,
  admin: adminConsole,
  signIn,
  testAlert: sendTestAlert,
  oneDrive: oneDriveSignIn,
  status: statusReport,
  pair: pairWindow,
  rooms: (phone, person) => seatOf(person).rooms(phone),
  setRoom: chooseRoom,
  people,
  canImport: () => env.ALLOW_IMPORT === '1' && (ownerSeat.phase === 'starting' || ownerSeat.phase === 'setup') && catalog.isEmpty(),
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
log(`web door open on port ${(web.address() as AddressInfo).port}${signIn.configured ? '' : ' (ADMIN_TOKEN is not set and there is no account: only /healthz works)'}`);

// Starts looking now that the door is open: see the MemoryWatch declared above.
memoryWatch.start();

const stop = () => {
  // With only the owner, once the bot has started it has its own shutdown (matrix-main.ts), which also ends the process.
  if ((!host && ownerSeat.phase === 'running') || stopping) return;
  stopping = true;
  log('shutting down');
  const finish = () => {
    web.close();
    web.closeAllConnections();
    catalog.close();
    process.exit(0);
  };
  if (!host) return finish();
  // The chats are the host's to stop, in the order the bot always shut down in.
  const running = host;
  void seats
    .stop()
    .then(() => running.stop())
    .catch((err: unknown) => log(`could not stop cleanly: ${err instanceof Error ? err.message : String(err)}`))
    .finally(finish);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
  await waitForHomeserver(homeserver, { log, stopped: () => stopping });
  const { token, userId } = await ensureTokenPatiently({ env, state: catalog, homeserver, log }, { stopped: () => stopping });
  ownerSeat.open(token, userId, homeserver);
  ownerSeat.phase = 'setup';

  if (!botEnabled) log('BOT_ENABLED is off: the setup page works, but the bot will not answer');
  if (configuredPeople.length > 0) {
    // Everyone's chat is added to one host, each by its own seat when its own room is joined: the host needs no room, so it is built now,
    // and the owner's chat being gone (or anyone's) never keeps another from starting.
    const found = peopleAccounts(env, userId.slice(userId.indexOf(':') + 1));
    for (const { person, account } of found.accounts) accounts.set(person.id, account);
    // The names that can't be used were said above; what is left to say is a person the host handed no password for.
    for (const problem of found.problems) if (!peopleProblems.includes(problem)) log(problem);
    if (botEnabled) {
      // The bridge was set up to say when Google Messages has each message (matrix.message_status_events, provision.ts).
      process.env.BRIDGE_STATUS_EVENTS = '1';
      host = await startHost({ env, catalog, log });
    }
    seats.runAll();
  } else {
    // Wait for the chat to be joined, and for the bot to be switched on. The chat is the one given (MATRIX_ROOM_ID, or chosen on the
    // setup page) or, when there is none that can be joined, the one found: the bridge's chat with the phone's own number. A chat
    // deleted on the phone (the bridge deletes its room) is waited on here with the web door up, and its new room is taken as soon
    // as the bridge makes it (when the owner texts themself again), instead of the bot starting and failing at every restart.
    ownerSeat.watch = seats.watchFor(ownerSeat);
    const room = await ownerSeat.watch.ready();
    if (!stopping && room) {
      // The chat's number (the owner's own) is kept, so its next room is found even if the phone never says its number.
      ownerSeat.rememberPhone(room);
      process.env.MATRIX_ACCESS_TOKEN = token;
      process.env.MATRIX_ROOM_ID = room;
      // The bridge was set up to say when Google Messages has each message (matrix.message_status_events, provision.ts).
      process.env.BRIDGE_STATUS_EVENTS = '1';
      ownerSeat.phase = 'bot-starting';
      // The bot proper: this returns once it is up (it signs in, joins the chat and starts answering), and it runs until the process ends.
      await import('./matrix-main.ts');
      ownerSeat.phase = 'running';
    }
  }
} catch (err) {
  console.error(`cannot start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
