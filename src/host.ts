import { adminConsole, type AdminConsole } from './admin/console.ts';
import { alertFromEnv, allNotify } from './alert.ts';
import { checkAudio, type AudioCheck } from './audio-check.ts';
import { fetchAudio } from './audio-fetch.ts';
import { archivedThisMonth, monthlyAllowance, sentCounter, trafficProblem } from './usage.ts';
import { oneDriveFromEnv, type OneDrive } from './archive/onedrive.ts';
import { bridgeRestarter } from './bridge-restart.ts';
import { createBot, type Bot } from './bot.ts';
import { Catalog, choicesIn, linksIn, resumeIn, viewsIn } from './catalog.ts';
import { watchJoinedRoom } from './cloud/room.ts';
import { memoryCheck } from './cloud/memory.ts';
import { youTubeRelayFromEnv } from './cloud/youtube-relay.ts';
import { loadMatrixHostConfig, parseCloudBudget, personBudgetOrDefault, type MatrixHostConfig } from './config.ts';
import { createDeliveryGate, type DeliveryGate } from './delivery-gate.ts';
import { loadExtensions, startExtensions, stopExtensions, type Extension, type ExtensionChat } from './extensions.ts';
import { BridgeWatch, Health, bridgeStatus, macNotify, online, type Notify } from './health.ts';
import { setUpLibrary, type Library } from './library/setup.ts';
import { MatrixClient } from './matrix/client.ts';
import { OWNER_ID, scoped, tagLine, type Person } from './people.ts';
import { createRunner, type IncomingPicture, type Runner } from './runner.ts';
import { sendStartupMessage, startupKey, startupModeFrom, startupText, type StartupMode } from './startup-message.ts';
import { musicTableFromEnv, resolvingAudio, type MusicTable } from './sources/music-table.ts';
import { songSourceOrder, songSources } from './sources/songs.ts';
import { gatedAudioCheck, resolvingYouTubeAudio, youTubeGate, youTubeMusicFromEnv, type YouTubeMusic } from './sources/youtube-music.ts';
import { zemerSearchFromEnv, type ZemerSearch } from './sources/zemer.ts';
import { newReleasesFromEnv, type NewReleases } from './sources/zemer-releases.ts';
import { zemerWhitelistFromEnv, type ZemerWhitelist } from './sources/zemer-whitelist.ts';
import { recentTimelines } from './timeline.ts';
import type { Reply } from './types.ts';
import { createWaitingNotice } from './waiting-notice.ts';

// The bot on the Matrix route, in two layers. The HOST is what every chat shares and is built once (`startHost`): the catalog, Zemer's
// artist list and the check made before every song is sent, the song sources, YouTube Music, the new releases, the background jobs, the
// problem list, the add-ons, the management console's view of all that, the one-file-at-a-time delivery gate and the memory guard. A CHAT is
// one person's own "message yourself" conversation (`addChat`): their Matrix account, their room, their bot (menus, picks, resume point,
// plays and follows kept apart from everyone else's), their runner and their place among the people the daily message goes to.
//
// The owner is a chat like any other, added by the same function with the legacy state keys; the waiting-artist notice, the artist-list
// commands, the add-ons, OneDrive and the console stay theirs alone. Everyone's bot is built from the SAME `sources` and `checkAudio`
// objects, so Zemer's list (no women, the owner's blocks and per-song allows) holds for every result and every send, whoever asked.

/** The memory an album's next download needs free on the host: 132 MB, that is under 380 of a 512 MB container. */
const ALBUM_MEMORY_SPARE = 132 * 1048576;

/** How a chat's bridge login is watched and reached; the owner's is the Google Messages bridge's own watch (`ownerBridge`), anyone else's is `personBridge` unless given. */
export interface ChatBridge {
  /** Looks at the login now (the host does it every minute), raising or clearing the problems it finds. Never needs to throw. */
  check(): Promise<void>;
  /** The chat reported that a message could not be delivered to Google Messages. */
  sendFailed(): void | Promise<void>;
  /**
   * Why something sent to this chat now would be lost, or undefined when it would arrive: the chat takes a message even when the bridge
   * can't pass it on (unlinked, disconnected, the host offline). The daily message waits while this says something.
   */
  blocked(): string | undefined;
}

export interface HostDeps {
  /** The environment the host reads, `process.env` unless given (tests give their own). */
  env?: NodeJS.ProcessEnv;
  /** What every chat shares (see `loadMatrixHostConfig`). Read from `env` when not given. */
  config?: MatrixHostConfig;
  log?: (line: string) => void;
  /** The catalog. When not given the host opens one at `config.dbPath` and closes it when it stops; a given one is left open. */
  catalog?: Catalog;
  /** Where the management console is told about the host (the shared `adminConsole`). */
  admin?: Pick<AdminConsole, 'provide' | 'liveSettings'>;
  /** Where problems are said (a Mac notification and, with ALERT_URL, the alert outbox). */
  notify?: Notify;
  /** The add-ons (extensions/); loaded from that folder when not given. */
  extensions?: Extension[];
  /** The host's one turn at a time for sending a file; a new one when not given. */
  gate?: DeliveryGate;
  /** Whether the host has internet, for the owner's bridge watch. */
  online?: () => Promise<boolean>;
  /** How often each chat's login is looked at and the month's traffic is checked (a minute; tests use less). */
  minuteMs?: number;
}

export interface Host {
  readonly env: NodeJS.ProcessEnv;
  readonly config: MatrixHostConfig;
  readonly catalog: Catalog;
  readonly log: (line: string) => void;
  readonly health: Health;
  /** The host's one turn at a time for sending a file (src/delivery-gate.ts): every chat's runner shares it. */
  readonly gate: DeliveryGate;
  readonly library: Library;
  readonly musicTable: MusicTable | undefined;
  readonly youTube: YouTubeMusic | undefined;
  readonly zemer: ZemerSearch | undefined;
  /** Zemer's artist list with the owner's decisions; undefined only when YouTube Music is off (no Zemer songs at all). */
  readonly whitelist: ZemerWhitelist | undefined;
  readonly releases: NewReleases | undefined;
  readonly oneDrive: OneDrive | undefined;
  readonly extensions: readonly Extension[];
  /** The song sources every chat's bot is built from: the same object for all, so none can leave the artist list out. */
  readonly sources: ReturnType<typeof songSources>;
  /** The check made before every song is sent, with the artist list's verdict first: the same function for all. */
  readonly checkAudio: (url: string) => Promise<AudioCheck>;
  /** The most any person besides the owner may be sent in a month, in bytes (PERSON_MAX_MB_PER_MONTH); undefined for no limit. */
  readonly personBudget: number | undefined;
  /** Everyone whose chat is up, by person id. */
  readonly chats: ReadonlyMap<string, HostChat>;
  /** Whether a song, picture or album is on its way to any chat: a OneDrive copy waits until it isn't. */
  sending(): boolean;
  /** Starts the background jobs (the site sync, Zemer's feed, the songs kept ready, the daily message). The first chat added does this; it is safe to call again. */
  startJobs(): void;
  /** Stops everything: every chat, the jobs, the add-ons and the watches, in the order the bot always shut down in. */
  stop(): Promise<void>;
}

export interface AddChatOptions {
  /** This person's own Matrix access token. Never taken from the environment. */
  token: string;
  /** This person's own "message yourself" room. */
  roomID: string;
  /** Their Matrix user id when it is known already (`whoami` is asked when not). */
  userId?: string;
  /** Where their account lives: the host's homeserver unless said (tests run one mock homeserver per person). */
  homeserver?: string;
  /** Called, once, when the homeserver no longer knows their room; the chat is checked every five minutes only when this is given. */
  onRoomGone?: (room: string) => void;
  /** How often the room is checked (default five minutes). */
  roomCheckEveryMs?: number;
  /** How their bridge login is watched. The owner's is the bridge's own watch (it restarts a stuck bridge); anyone else's is `personBridge`, which never restarts it, unless this is given. */
  bridge?: ChatBridge;
  /** Minutes after the host's daily time that this person (not the owner) is sent the daily message; see `RecipientOptions`. */
  digestOffsetMinutes?: number;
}

export interface HostChat {
  readonly person: Person;
  readonly userId: string;
  readonly roomID: string;
  readonly matrix: MatrixClient;
  readonly bot: Bot;
  readonly runner: Runner;
  readonly bridge: ChatBridge;
  /**
   * What the daily message and the alerts are sent with: into this chat, and only while `bridge.blocked()` says nothing (otherwise it
   * rejects, and they are tried again later).
   */
  announce(replies: Reply[]): Promise<void>;
  /** Takes this person out of the host: their runner stops (the answers that had not started are dropped; a restart answers them), nothing more is sent to them. */
  stop(options?: { abandon?: boolean }): Promise<void>;
}

/** What the host keeps for itself about its chats and jobs. */
interface Inside {
  chats: Map<string, HostChat>;
  /** People whose chat is being added right now (it takes a few requests), so one person is never added twice at once. */
  adding: Set<string>;
  /** What each chat does every minute (look at its login, tell the owner about waiting artists). */
  minute: Map<string, () => void>;
  /** Stops a chat's watching and its room checks, and then lets its runner finish (see `HostChat.stop`). */
  parts: WeakMap<HostChat, { quiet(): void; drain(): Promise<void> }>;
  stopping: boolean;
  jobsStarted: boolean;
  /** The owner's chat has started the add-ons (they start once, with the first owner chat). */
  ownerExtensions: boolean;
  startupMode: StartupMode;
  /** The settings the console can change, as the runner and the waiting notice read them. */
  live: { quiet: () => MatrixHostConfig['quiet']; songGapMs: () => number; albumDownloads: () => number | undefined; downloadsAhead: () => number | undefined };
  /** What the owner's start-up line says of the host. */
  summary: string;
  memoryRoom: (() => boolean) | undefined;
  online: () => Promise<boolean>;
}

const inside = new WeakMap<Host, Inside>();
const insideOf = (host: Host): Inside => {
  const found = inside.get(host);
  if (!found) throw new Error('addChat and removeChat need a host made by startHost');
  return found;
};

const defaultLog = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

/**
 * Builds everything the chats share, once. Nothing here needs a chat: the jobs start when the first chat is added (or `startJobs`),
 * and the host can be up with no one in it. Throws what is wrong with the configuration before anything is opened.
 */
export async function startHost(deps: HostDeps = {}): Promise<Host> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? defaultLog;
  const config = deps.config ?? loadMatrixHostConfig(env);
  // What can be wrong with the settings is said before anything is opened or started.
  const cloudBudget = parseCloudBudget(env.ONEDRIVE_MAX_MB_PER_MONTH);
  if (cloudBudget instanceof Error) throw cloudBudget;
  const startupMode: StartupMode = startupModeFrom(env);
  const personBudget = personBudgetOrDefault(env.PERSON_MAX_MB_PER_MONTH, log);
  const maxBytes = config.maxDownloadMb * 1024 * 1024;

  const ownsCatalog = deps.catalog === undefined;
  const catalog = deps.catalog ?? new Catalog(config.dbPath);
  const admin = deps.admin ?? adminConsole;
  // The owner's management console (src/admin/console.ts) reads and changes what this assembles; a few settings it can change
  // while the bot runs (the daily message's time, the quiet hours, the gap between songs, …) are read through `settings`.
  const settings = admin.liveSettings(catalog, env);
  admin.provide({ catalog, env, log, settings });

  // This machine downloads the file, so private addresses (a NAS, say) are fine and any audio format will do.
  // A search asks Zemer's catalog first, then music-table.com (YOUTUBE_MUSIC=off and MUSIC_TABLE=off turn them off;
  // SONG_SOURCES sets which is asked first). Zemer's songs are YouTube Music's, so their audio comes from there.
  const musicTable = musicTableFromEnv(env);
  // YouTube turns the cloud host away at its player, so there songs come through the Cloudflare Worker (YOUTUBE_RELAY=r2).
  const youTube = youTubeMusicFromEnv(env, { log, relay: youTubeRelayFromEnv(env, { log }) });
  // Whether songs can be had (from this host, or through the relay), learned and logged at start.
  void youTube?.checkStreams();
  const zemer = youTube && zemerSearchFromEnv(env, { log });
  // Whether Zemer's search answers this host, logged at start (without it, searches use YouTube Music's own search).
  void zemer?.check();
  const whitelist = youTube && zemerWhitelistFromEnv(env, { state: catalog });
  const audio = resolvingYouTubeAudio(
    youTube,
    resolvingAudio(
      musicTable,
      {
        checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true, maxBytes }),
        fetchAudio: (url, title) => fetchAudio(url, title, { maxBytes }),
      },
      { maxBytes },
    ),
    { maxBytes },
  );
  // What's wrong, shown on the Mac: the chat can't carry news of its own breakdown.
  // On a server (ALERT_URL set) problems are also sent to the alert Worker, which emails them.
  const health = new Health({ notify: deps.notify ?? allNotify(macNotify, alertFromEnv(env, log)), log, save: (problems) => catalog.setState('health.problems', JSON.stringify(problems)) });
  catalog.setState('health.problems', '[]');
  // Zemer's artist list is what YouTube Music songs are filtered by. Zemer's server no longer answers the bot, so by default
  // (ZEMER_CONTENT_URL unset) the saved copy is the list and nothing is asked or watched; with the URL set it changes through
  // the day and is kept current while the bot runs, with a note if it goes a day without updating (the last good list is used meanwhile).
  const stopWatching = whitelist?.watch((error) => {
    if (error === undefined) health.ok('whitelist', "Fixed: Zemer's artist list is updating again.");
    else if (whitelist.frozen) health.problem('whitelist', `Zemer's artist list now answers only its own app, so the bot keeps the last copy it saved. Artists Zemer adds wait for your word (text "pending"); text "block" and a name to hide anyone.`);
    else if (whitelist.ageMs > 24 * 60 * 60_000) health.problem('whitelist', `Zemer's artist list hasn't updated for a day (${error}). YouTube Music songs are being checked against the old list.`);
  });
  void whitelist?.warm().then(() => whitelist.loaded && log(`Zemer's artist list: ${whitelist.size.artists} artists, ${whitelist.size.blocked} blocked songs${whitelist.offline ? " (the saved copy: Zemer's server is not asked)" : whitelist.frozen ? ' (frozen: the server turns the bot away)' : ''}; you allowed ${whitelist.owner.allowed}, blocked ${whitelist.owner.blocked}, ${whitelist.owner.waiting} waiting`));
  // Zemer's new releases (the feed behind the Zemer app's Latest Releases shelf): in "new", the daily message and the alerts,
  // held to the same list. ZEMER_RELEASES=off turns them off.
  const releases = newReleasesFromEnv({ catalog, whitelist, log }, env);

  // With ONEDRIVE_CLIENT_ID set, every song sent is also saved to the owner's OneDrive (signed in on the setup page).
  const oneDrive = oneDriveFromEnv(env, { state: catalog, log });
  // Where the host's memory stands (a cloud host's container), for the OneDrive copies and an album's downloads.
  const memory = memoryCheck(env);
  const memoryRoom = memory
    ? (): boolean => {
        const use = memory();
        return !use || use.limit - use.used >= ALBUM_MEMORY_SPARE;
      }
    : undefined;
  const gate = deps.gate ?? createDeliveryGate();
  const chats = new Map<string, HostChat>();
  // Whether a song or an album is on its way to any chat: a OneDrive copy waits until it isn't.
  const sending = (): boolean => gate.busy() || [...chats.values()].some((chat) => chat.runner.busy());
  /** The settings the console can change: what the bot started with applies until the owner changes it there. */
  const live = {
    digestAt: () => settings.digestAt(config.digestAt),
    quiet: () => settings.quiet(config.quiet),
    songGapMs: () => settings.songGapMs(config.songGapMs),
    albumDownloads: () => settings.albumDownloads(config.albumDownloads),
    downloadsAhead: () => settings.downloadsAhead(config.downloadsAhead),
    cloudBudget: () => settings.cloudBudget(cloudBudget),
  };
  // Songs kept on disk (the most played, the newest, the most viewed), album art, and the daily new-music message.
  const library = setUpLibrary({
    catalog,
    musicTable,
    audio,
    dbPath: config.dbPath,
    ...(oneDrive
      ? {
          cloudFolder: oneDrive,
          cloudMonthlyBytes: live.cloudBudget,
          // On a small cloud host the OneDrive copy of a big song waits for memory, or is skipped, rather than crowd out sending.
          cloudMemory: memory,
          cloudBusy: sending,
          onCloudFolder: (problem: string | undefined, needsLogin: boolean) =>
            problem
              ? health.problem('onedrive', `Songs are not being saved to OneDrive: ${problem}${needsLogin ? ' Open the setup page and sign in to OneDrive again.' : ''}`)
              : health.ok('onedrive', 'Fixed: songs are being saved to OneDrive again.'),
        }
      : {}),
    digestAt: live.digestAt,
    prefetchMb: config.prefetchMb,
    archiveDir: config.archiveDir,
    onArchive: (problem) => (problem ? health.problem('archive', problem) : health.ok('archive', 'Fixed: the songs folder on the drive can be used again.')),
    quiet: live.quiet,
    // With no internet at all, that's the one thing said; the site isn't blamed for it.
    onSite: (ok, problem) =>
      ok ? health.ok('site', 'Fixed: music-table.com is answering again.') : health.has('internet') ? undefined : health.problem('site', problem ?? "music-table.com isn't answering."),
    releases,
    onReleases: (ok, problem) =>
      ok ? health.ok('releases', "Fixed: Zemer's new releases are being read again.") : health.has('internet') ? undefined : health.problem('releases', problem ?? "Zemer's new releases aren't being read."),
    log,
  });
  // What the console shows and changes: Zemer's artist list, YouTube Music for finding artists, the releases, and the background jobs
  // (which are made when the library starts, so asked for each time).
  admin.provide({ whitelist, youTube, releases, jobs: () => library.jobs, follows: library.follows, ...(oneDrive
      ? {
          // The same report as /status's: signed in or not, what was saved this month, and the allowance in force (the console may have changed it).
          oneDrive: (): Record<string, unknown> => {
            const budget = live.cloudBudget();
            return { ...oneDrive.status(), savedThisMonthMb: Math.round(archivedThisMonth(catalog) / 1048576), monthlyLimitMb: budget === undefined ? null : Math.round(budget / 1048576) };
          },
        }
      : {}),
  });
  // Add-ons kept outside this repository, in extensions/ (see src/extensions.ts). One that fails is left out. They belong to the owner's
  // chat: what they download comes from it, and their assistant, pictures and posts are the owner's alone.
  const extensions =
    deps.extensions ??
    (await loadExtensions({
      state: catalog,
      health,
      env,
      log,
      download: (url) => {
        const owner = chats.get(OWNER_ID);
        return owner ? owner.matrix.downloadMedia(url) : Promise.reject(new Error("the owner's chat is not up"));
      },
    }));
  const sources = songSources({ catalog, musicTable, youTube, whitelist, zemer, order: songSourceOrder(env) });
  // A YouTube Music song is checked against the list as it stands when it is sent, not only when it was found.
  const songGate = youTube && whitelist ? youTubeGate({ youTube, whitelist, catalog }) : undefined;
  const gatedCheck = gatedAudioCheck(songGate, library.checkAudio);

  // A month's outbound traffic near what Render's free plan includes is said, before it costs anything.
  const checkTraffic = (): void => {
    const problem = trafficProblem(catalog);
    if (problem) health.problem('traffic', problem);
    else health.ok('traffic', "Fixed: this month's outbound traffic is back under the limit (a new month).");
  };
  const minute = new Map<string, () => void>();
  const watching = setInterval(() => {
    for (const task of [...minute.values()]) task();
    checkTraffic();
  }, deps.minuteMs ?? 60_000);
  watching.unref();

  const summary = `Zemer ${zemer ? 'on' : youTube ? 'off (YouTube Music search instead)' : 'off'}, music-table.com ${musicTable ? 'on' : 'off'}, ${library.summary}${extensions.map((extension) => `, ${extension.summary ?? extension.name}`).join('')}`;

  const state: Inside = {
    chats,
    adding: new Set(),
    minute,
    parts: new WeakMap(),
    stopping: false,
    jobsStarted: false,
    ownerExtensions: false,
    startupMode,
    live: { quiet: live.quiet, songGapMs: live.songGapMs, albumDownloads: live.albumDownloads, downloadsAhead: live.downloadsAhead },
    summary,
    memoryRoom,
    online: deps.online ?? online,
  };
  const host: Host = {
    env,
    config,
    catalog,
    log,
    health,
    gate,
    library,
    musicTable,
    youTube,
    zemer,
    whitelist,
    releases,
    oneDrive,
    extensions,
    sources,
    checkAudio: gatedCheck,
    personBudget,
    chats,
    sending,
    startJobs() {
      if (state.jobsStarted || state.stopping) return;
      state.jobsStarted = true;
      library.start();
    },
    async stop() {
      state.stopping = true;
      clearInterval(watching);
      const up = [...chats.values()];
      for (const chat of up) state.parts.get(chat)?.quiet();
      stopWatching?.();
      await stopExtensions([...extensions], log);
      await library.stop();
      for (const chat of up) await state.parts.get(chat)?.drain();
      if (ownsCatalog) catalog.close();
    },
  };
  inside.set(host, state);
  return host;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The owner's bridge login: the Google Messages bridge's own watch, which restarts a bridge that is stuck (src/health.ts). */
function ownerBridge(host: Host, deps: { token: string; userId: string; online: () => Promise<boolean> }): ChatBridge {
  const { health } = host;
  const watch = new BridgeWatch({
    health,
    status: () => bridgeStatus({ url: host.config.bridgeUrl, token: deps.token, userId: deps.userId }),
    online: deps.online,
    restart: bridgeRestarter(host.env),
    log: host.log,
  });
  return {
    check: () => watch.check(),
    sendFailed: () => watch.sendFailed(),
    // The daily message and the alerts count as sent once the chat takes them, which it does even when the bridge can't pass them on
    // to Google Messages (unlinked, disconnected) and they would be lost. So they wait until it can.
    blocked() {
      const blocked = ['bridge', 'internet'].find((key) => health.has(key));
      return blocked === undefined ? undefined : blocked === 'internet' ? 'the host has no internet' : 'the bridge is not connected to Google Messages';
    },
  };
}

/**
 * A person's bridge login (anyone but the owner): asked about with their own Matrix token and id, so the bridge answers for THEIR login,
 * and raised under keys of their own (`bridge:alice`, `bridge-restart:alice`, `rcs:alice`) in words that name them. Nothing here ever
 * restarts the bridge, whatever their login does (signed out by Google, a phone that is off for hours, an undelivered message): the
 * bridge is ONE process for everybody, and a restart can't mend any of that, so a person's dead login would otherwise cut the owner's
 * connection off every few minutes. Only the owner's watch (`ownerBridge`) restarts it. Nothing is raised for a login that has not
 * been seen connected yet (a person who has not linked is not "logged out"; `bridge.seen:<id>` in the catalog remembers the first time),
 * and what is sent to them waits until it has. `deps.now` is for tests.
 */
export function personBridge(host: Host, person: Person, deps: { token: string; userId: string; online: () => Promise<boolean>; now?: () => Date }): ChatBridge {
  if (person.owner) throw new Error('personBridge is for the people besides the owner; the owner has ownerBridge');
  const { catalog, health } = host;
  const seenKey = scoped('bridge.seen', person);
  const watch = new BridgeWatch({
    health,
    person,
    status: () => bridgeStatus({ url: host.config.bridgeUrl, token: deps.token, userId: deps.userId }),
    online: deps.online,
    log: (line) => host.log(tagLine(person, line)),
    everConnected: {
      has: () => Boolean(catalog.getState(seenKey)),
      mark: () => catalog.setState(seenKey, (deps.now?.() ?? new Date()).toISOString()),
    },
    ...(deps.now ? { now: deps.now } : {}),
  });
  const { bridge } = watch.keys();
  return {
    check: () => watch.check(),
    sendFailed: () => watch.sendFailed(),
    // Like the owner's: what is sent to them is lost while their login can't pass it on, so the daily message and the alerts wait.
    blocked() {
      if (!watch.linked()) return `${person.id}'s Google Messages is not linked to the bridge yet`;
      if (health.has(bridge)) return `${person.id}'s Google Messages is not connected to the bridge`;
      return health.has('internet') ? 'the host has no internet' : undefined;
    },
  };
}

/**
 * Puts one person's chat on the host: signs their account in (`token`), joins their room, builds their bot and runner, makes them one
 * of the people the daily message and the alerts go to, and starts answering. The first chat added also starts the host's jobs.
 * Nothing of the person is left behind when this throws (their account can't be used, the room can't be joined, the chat can't be
 * read), and no other chat is touched. The owner is `OWNER`; their state keys are the plain ones, and only theirs get the waiting-artist
 * notice, the artist-list commands, the add-ons, OneDrive and the console.
 */
export async function addChat(host: Host, person: Person, options: AddChatOptions): Promise<HostChat> {
  const state = insideOf(host);
  const { catalog, config, health, library } = host;
  const id = person.id;
  if (state.stopping) throw new Error('the host is stopping');
  if (state.chats.has(id) || state.adding.has(id)) throw new Error(`${person.owner ? 'the owner' : id} already has a chat on this host`);
  state.adding.add(id);
  try {
    const log = (line: string): void => host.log(tagLine(person, line));
    // What is sent is counted for this person alone (a cloud host's plan allows only so much a month; /status shows it).
    const matrix = new MatrixClient({ token: options.token, homeserver: options.homeserver ?? config.homeserver, onUpload: sentCounter(catalog, person) });
    const userId = options.userId ?? (await matrix.whoami()).userId;
    // The bridge invites you to each chat it creates; joining accepts the invite and does nothing if you're in already.
    await matrix.joinRoom(options.roomID);
    if (state.stopping) throw new Error('the host is stopping');

    const bridge = options.bridge ?? (person.owner ? ownerBridge(host, { token: options.token, userId, online: state.online }) : personBridge(host, person, { token: options.token, userId, online: state.online }));
    // Their own plays and follows, and songs that are not copied to the owner's OneDrive; the owner's are the library's own.
    const mine = person.owner ? library : library.forPerson(person);
    // The add-ons are the owner's: their assistant, their pictures and the pictures sent from their phone.
    const assistant = person.owner ? host.extensions.find((extension) => extension.assistant)?.assistant : undefined;
    const pictureTakers = person.owner ? host.extensions.filter((extension) => extension.onPicture) : [];
    const prepareImage = person.owner ? host.extensions.reduce((prepare, extension) => extension.pictures?.(prepare) ?? prepare, library.prepareImage) : library.prepareImage;
    // The same `sources` and `checkAudio` for everyone, so Zemer's list holds for every result and every send. Only the owner has the
    // list itself (allow, block, pending) and the assistant: for anyone else those words are not commands.
    const bot = createBot({
      catalog,
      checkAudio: host.checkAudio,
      onPlay: mine.onPlay,
      browse: library.browse,
      follows: mine.follows,
      ...(person.owner && host.whitelist ? { artistList: host.whitelist } : {}),
      ...(assistant ? { assistant } : {}),
      // The chat's menus and where it is in them ("songs more", a 👍 on an older menu), kept across restarts.
      views: viewsIn(catalog, scoped('chat.view', person), person.chat),
      ...host.sources,
    });
    const runner = createRunner({
      chat: matrix,
      bot,
      chatID: options.roomID,
      fetchAudio: mine.fetchAudio,
      prepareImage,
      choices: choicesIn(catalog, scoped('chat.choices', person)),
      links: linksIn(catalog, person.chat),
      // A restart (routine on a cloud host) answers what was sent while the bot was down instead of dropping it.
      resume: resumeIn(catalog, scoped('chat.resume', person)),
      pollMs: config.pollMs,
      // A long poll: a text is read the moment the homeserver has it (MATRIX_SYNC_WAIT_MS=0 reads every MATRIX_POLL_MS instead).
      waitMs: config.syncWaitMs,
      songGapMs: state.live.songGapMs,
      downloadsAhead: state.live.downloadsAhead,
      // An album's songs come three at a time (ALBUM_DOWNLOADS), each to disk as it arrives; another starts only while the host has
      // room: under 380 of its 512 MB, the most it reached with one at a time being 391 (2026-10-20).
      albumDownloads: state.live.albumDownloads,
      ...(state.memoryRoom ? { memoryRoom: state.memoryRoom } : {}),
      // One file at a time on the whole host, taken in turns between the chats (src/delivery-gate.ts).
      gate: host.gate,
      gateOwner: id,
      // Anyone but the owner has a share of the host's traffic each month (PERSON_MAX_MB_PER_MONTH).
      ...(person.owner ? {} : { allowance: monthlyAllowance({ state: catalog, person, maxBytes: host.personBudget }) }),
      // An album's zip is written to disk and streamed from there, so it can be bigger than a song held in memory.
      maxFileBytes: config.maxZipMb * 1024 * 1024,
      onBridgeSendFailure: () => bridge.sendFailed(),
      // Where each request's time goes, one line each in the log; the last few are in the cloud host's /status too.
      sendStatus: config.sendStatus,
      onTimeline: (line) => recentTimelines.add(tagLine(person, line)),
      ...(pictureTakers.length > 0 ? { onPicture: (picture: IncomingPicture) => pictureTakers.forEach((extension) => extension.onPicture!(picture)) } : {}),
      log,
      // Half a minute without the homeserver is worth a word; it comes back on its own when it's restarted.
      onPoll: (ok, failures, error) => {
        if (ok) health.ok('homeserver', 'Fixed: the bot can reach the Matrix homeserver again.');
        else if (failures >= 20) health.problem('homeserver', `The bot can't reach the Matrix homeserver (${error ?? 'no answer'}). It restarts on its own; if this lasts, restart the service in Render.`);
      },
    });
    await runner.start();
    // The host was stopped while this chat was coming up: it is not in the host's list, so nothing else would stop it.
    if (state.stopping) {
      await runner.stop({ abandon: true });
      throw new Error('the host is stopping');
    }

    let quieted = false;
    let stopRoomWatch: (() => void) | undefined;
    let drained: Promise<void> | undefined;
    const quiet = (): void => {
      quieted = true;
      stopRoomWatch?.();
      state.minute.delete(id);
    };
    const drain = (abandon = false): Promise<void> => (drained ??= runner.stop(abandon ? { abandon: true } : undefined));
    const chat: HostChat = {
      person,
      userId,
      roomID: options.roomID,
      matrix,
      bot,
      runner,
      bridge,
      async announce(replies) {
        const why = bridge.blocked();
        if (why) throw new Error(why);
        await runner.announce(replies);
      },
      async stop(stopOptions) {
        quiet();
        if (state.chats.get(id) === chat) {
          state.chats.delete(id);
          library.removeRecipient(id);
          log('left the host');
        }
        await drain(stopOptions?.abandon === true);
      },
    };
    state.parts.set(chat, { quiet, drain: () => drain() });
    state.chats.set(id, chat);

    try {
      // The daily message and the new-song alerts go to this chat too (the jobs start with the first chat).
      library.addRecipient(person, { announce: (replies) => chat.announce(replies), ...(!person.owner && options.digestOffsetMinutes !== undefined ? { digestOffsetMinutes: options.digestOffsetMinutes } : {}) });
      host.startJobs();
      if (person.owner && !state.ownerExtensions) {
        state.ownerExtensions = true;
        const extensionChat: ExtensionChat = {
          announce: (replies) => runner.announce(replies),
          post: (text) => matrix.sendText(options.roomID, text),
          react: (messageId, key) => matrix.sendReaction(options.roomID, messageId, key),
          unreact: (reactionId) => matrix.redact(options.roomID, reactionId),
        };
        startExtensions([...host.extensions], extensionChat, health);
      }
      // Artists Zemer has added that its frozen list doesn't know wait for the owner's word; they are told about once, to the owner.
      const tellWaiting = person.owner && host.whitelist
        ? createWaitingNotice({
            list: host.whitelist,
            state: catalog,
            announce: (replies) => runner.announce(replies),
            ready: () => bridge.blocked() === undefined,
            quiet: state.live.quiet,
            log,
          })
        : undefined;
      // If the internet is back but Google Messages stays disconnected, restart its stale bridge session automatically (the owner's login only:
      // a person's login is only reported, since the bridge is one process for everybody).
      const watchBridge = (): void => void bridge.check().catch((err: unknown) => log(`could not check the bridge: ${errorText(err)}`));
      state.minute.set(id, () => {
        watchBridge();
        void tellWaiting?.();
      });
      watchBridge();
      // A word in the chat once the bot is up and the bridge can pass it on (the cloud host asks for it once, on its first start).
      void sendStartupMessage({
        mode: state.startupMode,
        state: catalog,
        key: startupKey(person),
        text: startupText(person),
        ready: async () => {
          await bridge.check();
          return bridge.blocked() === undefined;
        },
        send: (replies) => runner.announce(replies),
        stopped: () => state.stopping || quieted,
        log,
      });
      log(
        person.owner
          ? `signed in as ${userId}, watching room ${options.roomID}, ${catalog.count()} tracks in ${config.dbPath}, ${state.summary}. Text "search" and a song name in that chat.`
          : `signed in as ${userId}, watching room ${options.roomID}. Text "search" and a song name in that chat.`,
      );
      // A chat deleted on the phone takes its room with it, and the bot would go on running without hearing from it.
      if (options.onRoomGone) {
        const gone = options.onRoomGone;
        stopRoomWatch = watchJoinedRoom({
          join: () => matrix.joinRoom(options.roomID),
          onGone: () => gone(options.roomID),
          ...(options.roomCheckEveryMs ? { everyMs: options.roomCheckEveryMs } : {}),
          log,
        });
      }
    } catch (err) {
      quiet();
      state.chats.delete(id);
      library.removeRecipient(id);
      await drain(true).catch(() => {});
      throw err;
    }
    return chat;
  } finally {
    state.adding.delete(id);
  }
}

/** Takes someone's chat off the host (see `HostChat.stop`): what has not started is dropped, and a restart answers it. False when they had no chat. */
export async function removeChat(host: Host, person: Person | string, options: { abandon?: boolean } = {}): Promise<boolean> {
  const chat = insideOf(host).chats.get(typeof person === 'string' ? person : person.id);
  if (!chat) return false;
  await chat.stop({ abandon: options.abandon ?? true });
  return true;
}
