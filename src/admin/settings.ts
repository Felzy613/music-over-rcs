import { parseCloudBudget, parseQuietHours, parseSongGap } from '../config.ts';
import { parseDailyTime, type DailyTime } from '../library/jobs.ts';

// Every setting the code reads (the environment variables of docs/configuration.md and docs/cloud.md), for the admin console to
// list with its value, where the value comes from, and whether it can change while the bot runs.
//
// Almost all of them are read once, when the bot starts, and are changed in Render's dashboard (which restarts the bot). A small
// allowlist is read again whenever it is used, so the owner can change it from the console without a restart: the daily
// message's time, the quiet hours, the gap between songs, how many album songs and songs ahead download at once, and the
// monthly OneDrive allowance. Those overrides are kept in the catalog's state table and sit over the environment: clearing one
// goes back to what Render says. Nothing here ever shows a secret's value, only whether it is set.

export type Parsed = { ok: true; value: string } | { ok: false; error: string };

export interface SettingSpec {
  key: string;
  group: string;
  label: string;
  note: string;
  /** What the code does without it. */
  default?: string;
  /** Never shown: only "set" or "not set". */
  secret?: boolean;
  /** Present only when the bot reads the setting again as it runs. */
  live?: { hint: string; example: string; parse(raw: string): Parsed };
}

const ok = (value: string): Parsed => ({ ok: true, value });
const fail = (error: string): Parsed => ({ ok: false, error });
const whole = (name: string, min: number, max: number) => (raw: string): Parsed => {
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? ok(String(n)) : fail(`${name} must be a whole number from ${min} to ${max}`);
};
const two = (n: number): string => String(n).padStart(2, '0');
const clock = (time: DailyTime): string => `${two(time.hour)}:${two(time.minute)}`;

/** The most the OneDrive allowance can be set to from the console: Render's free plan sends about 5,000 MB a month and the alert is at 4,000. */
export const MAX_LIVE_ONEDRIVE_MB = 4000;

const LIVE = {
  DIGEST_TIME: {
    hint: 'When the daily new-music message goes out, 24-hour, in the host\'s time zone. "off" for none.',
    example: '09:00',
    parse(raw: string): Parsed {
      const time = parseDailyTime(raw.trim() || undefined);
      return time instanceof Error ? fail('use a time like 09:30 (24-hour), or "off"') : ok(time ? clock(time) : 'off');
    },
  },
  QUIET_HOURS: {
    hint: 'No new-song alerts in these hours (24-hour, may cross midnight). "off" sends them any time.',
    example: '22:00-07:00',
    parse(raw: string): Parsed {
      const hours = parseQuietHours(raw.trim() || undefined);
      return hours instanceof Error ? fail('use hours like 22:00-07:00, or "off"') : ok(hours ? `${clock(hours.from)}-${clock(hours.to)}` : 'off');
    },
  },
  SONG_GAP_SECONDS: {
    hint: 'The least time between two audio files, in seconds (0 to 300), so the phone has sent one before the next arrives. 0 sends them as fast as they are ready.',
    example: '5',
    parse(raw: string): Parsed {
      const ms = parseSongGap(raw.trim() || undefined);
      return ms instanceof Error ? fail('use a number of seconds from 0 to 300') : ok(String(ms / 1000));
    },
  },
  ALBUM_DOWNLOADS: {
    hint: "An album's songs downloading at once (1 to 5). 1 is the gentlest on the host's memory.",
    example: '3',
    parse: whole('ALBUM_DOWNLOADS', 1, 5),
  },
  DOWNLOADS_AHEAD: {
    hint: 'Songs downloading ahead of their turn when several are asked for (1 to 10).',
    example: '1',
    parse: whole('DOWNLOADS_AHEAD', 1, 10),
  },
  ONEDRIVE_MAX_MB_PER_MONTH: {
    hint: `The most saved to OneDrive in a calendar month, in MB (0 to ${MAX_LIVE_ONEDRIVE_MB}). It shares Render's 5 GB of outbound traffic with the songs sent. 0 stops the saving; sending is never stopped.`,
    example: '1500',
    parse(raw: string): Parsed {
      const budget = parseCloudBudget(raw.trim() || undefined);
      if (budget instanceof Error || budget === undefined) return fail(`use a number of MB from 0 to ${MAX_LIVE_ONEDRIVE_MB} ("unlimited" can only be set in Render)`);
      const mb = Math.round(budget / 1048576);
      return mb <= MAX_LIVE_ONEDRIVE_MB ? ok(String(mb)) : fail(`at most ${MAX_LIVE_ONEDRIVE_MB} MB from the console (Render's free plan sends about 5,000 MB a month for everything)`);
    },
  },
} satisfies Record<string, NonNullable<SettingSpec['live']>>;

const HOST = 'Cloud host';
const CHAT = 'Chat and bridge';
const MUSIC = 'Music sources';
const SENDING = 'Sending';
const SCHEDULE = 'Library and schedule';
const PEOPLE_GROUP = 'People';
const ONEDRIVE = 'OneDrive';
const OTHER = 'Other routes (not used on Render)';

/** Every setting, in the order the console lists them. A test keeps this in step with what the code reads. */
export const SETTINGS: readonly SettingSpec[] = [
  // Sending
  { key: 'SONG_GAP_SECONDS', group: SENDING, label: 'Gap between songs', note: 'Seconds between audio files, so the phone has sent one before the next arrives.', default: '5', live: LIVE.SONG_GAP_SECONDS },
  { key: 'ALBUM_DOWNLOADS', group: SENDING, label: 'Album downloads at once', note: "An album's songs downloading together; fewer start while the host is short of memory.", default: '3', live: LIVE.ALBUM_DOWNLOADS },
  { key: 'DOWNLOADS_AHEAD', group: SENDING, label: 'Songs downloading ahead', note: 'Songs fetched ahead of their turn when several are asked for (1 on the cloud host).', default: '3', live: LIVE.DOWNLOADS_AHEAD },
  { key: 'MAX_DOWNLOAD_MB', group: SENDING, label: 'Largest song', note: 'Largest song to download and send, in MB (30 on the cloud host: a song is held in memory while it is fetched and tagged).', default: '100' },
  { key: 'MAX_ZIP_MB', group: SENDING, label: 'Largest album zip', note: "Largest an album's zip may be, 1 to 100 MB (what the bridge and the homeserver take); a bigger album comes as several zips.", default: '100' },
  { key: 'STARTUP_MESSAGE', group: SENDING, label: 'Hello message', note: 'A word in the chat when the bot is up: off, once or always.', default: 'off (once on the cloud host)' },
  // Library and schedule
  { key: 'DIGEST_TIME', group: SCHEDULE, label: 'Daily message time', note: 'When the daily new-music message goes out, in the host\'s time zone.', default: '09:00', live: LIVE.DIGEST_TIME },
  { key: 'QUIET_HOURS', group: SCHEDULE, label: 'Quiet hours', note: 'No new-song alerts in these hours; they wait for the morning.', default: '22:00-07:00', live: LIVE.QUIET_HOURS },
  { key: 'PREFETCH_MB', group: SCHEDULE, label: 'Songs kept ready', note: "Disk space for songs kept ready, in MB (0 on the cloud host: its disk is wiped at every restart).", default: 'unlimited' },
  { key: 'SONGS_ARCHIVE_DIR', group: SCHEDULE, label: 'Archive folder', note: 'A folder on an external drive that kept songs move into (a computer with a disk only).' },
  { key: 'CATALOG_DB', group: SCHEDULE, label: 'Catalog file', note: 'The catalog database (/data/catalog.db on the cloud host).', default: 'data/catalog.db' },
  // Music sources
  { key: 'YOUTUBE_MUSIC', group: MUSIC, label: 'YouTube Music', note: 'off stops all use of Zemer and YouTube Music.', default: 'on' },
  { key: 'ZEMER_SEARCH', group: MUSIC, label: "Zemer's catalog search", note: 'off asks YouTube Music\'s own search instead of search.zemer.io.', default: 'on' },
  { key: 'ZEMER_SEARCH_URL', group: MUSIC, label: "Zemer's search address", note: 'Only the tests change it.', default: 'https://search.zemer.io' },
  { key: 'ZEMER_CONTENT_URL', group: MUSIC, label: "Zemer's artist list address", note: "Empty: Zemer's server is never asked and the saved list is the list (it answers only Zemer's own app). Set https://content.zemer.io to ask it again; the tests point it at a mock.", default: 'empty (never asked)' },
  { key: 'ZEMER_RELEASES', group: MUSIC, label: "Zemer's new releases", note: 'off leaves "new", the daily message and the alerts to music-table.com.', default: 'on' },
  { key: 'ZEMER_RELEASES_URL', group: MUSIC, label: 'New-releases feed address', note: 'Where the releases feed is read from.', default: 'https://flipphoneguy.duckdns.org/?page=zemer_releases' },
  { key: 'YOUTUBE_MUSIC_URL', group: MUSIC, label: 'YouTube Music address', note: 'Only the tests change it.', default: 'https://music.youtube.com' },
  { key: 'YOUTUBE_RELAY', group: MUSIC, label: 'YouTube relay', note: "r2 fetches each song through the Cloudflare Worker, because YouTube turns the host's address away.", default: 'none (r2 on the cloud host)' },
  { key: 'SONG_SOURCES', group: MUSIC, label: 'Search order', note: 'Which source a search asks first: youtube-music,music-table or music-table,youtube-music.', default: 'youtube-music,music-table' },
  { key: 'MUSIC_TABLE', group: MUSIC, label: 'music-table.com', note: 'off stops all use of the site: lookups, sync and the daily message.', default: 'on' },
  { key: 'MUSIC_TABLE_URL', group: MUSIC, label: 'music-table.com address', note: 'Only the tests change it.', default: 'https://www.music-table.com' },
  // OneDrive
  { key: 'ONEDRIVE_MAX_MB_PER_MONTH', group: ONEDRIVE, label: 'Monthly OneDrive allowance', note: "The most saved to OneDrive in a calendar month, in MB. It counts against Render's 5 GB of outbound traffic.", default: '1500', live: LIVE.ONEDRIVE_MAX_MB_PER_MONTH },
  { key: 'ONEDRIVE_CLIENT_ID', group: ONEDRIVE, label: 'OneDrive app id', note: 'The Azure app that signs in to OneDrive. Empty: nothing is saved to OneDrive.', secret: true },
  { key: 'ONEDRIVE_SCOPE', group: ONEDRIVE, label: 'OneDrive sign-in scope', note: "What the sign-in asks for; empty is the app's own folder only.", default: 'Files.ReadWrite.AppFolder offline_access' },
  { key: 'ONEDRIVE_LOGIN_URL', group: ONEDRIVE, label: 'OneDrive sign-in address', note: 'Only the tests change it.' },
  { key: 'ONEDRIVE_GRAPH_URL', group: ONEDRIVE, label: 'OneDrive upload address', note: 'Only the tests change it.' },
  // Chat and bridge
  { key: 'MATRIX_HOMESERVER', group: CHAT, label: 'Matrix homeserver', note: 'Synapse, inside the container on the cloud host.', default: 'http://127.0.0.1:8008' },
  { key: 'MATRIX_ACCESS_TOKEN', group: CHAT, label: 'Matrix token', note: 'The cloud host signs the bot in itself and keeps the token in the catalog.', secret: true },
  { key: 'MATRIX_ROOM_ID', group: CHAT, label: 'Chat room', note: 'Best left empty on the cloud host: the bot finds your chat by itself.' },
  { key: 'MATRIX_USER', group: CHAT, label: 'Bot account', note: 'The bot\'s Matrix account name.', default: 'me' },
  { key: 'MATRIX_PASSWORD', group: CHAT, label: 'Bot account password', note: 'Created with the account on the first start.', secret: true },
  { key: 'MATRIX_POLL_MS', group: CHAT, label: 'Chat poll interval', note: 'How often the chat is checked when long polling is off, 500 to 30000 ms.', default: '1500' },
  { key: 'MATRIX_SYNC_WAIT_MS', group: CHAT, label: 'Long-poll wait', note: 'How long a read of the chat waits for something new, 0 to 60000 ms.', default: '25000' },
  { key: 'BRIDGE_URL', group: CHAT, label: 'Bridge address', note: 'Where the Google Messages bridge listens.', default: 'http://127.0.0.1:29336' },
  { key: 'BRIDGE_AUTO_RESTART', group: CHAT, label: 'Bridge auto-restart', note: 'off stops the automatic restart of a bridge that stays disconnected.', default: 'on' },
  { key: 'BRIDGE_STATUS_EVENTS', group: CHAT, label: 'Bridge status events', note: 'Set by the host itself so timelines can say when Google had a message.', default: 'off' },
  { key: 'BRIDGE_DB', group: CHAT, label: 'Bridge database', note: "Where the bridge's database is, read-only, to find your chat.", default: '/data/gmessages/mautrix-gmessages.db' },
  { key: 'BRIDGE_PIDFILE', group: CHAT, label: 'Bridge pid file', note: 'Where the bot finds the bridge to restart it.' },
  { key: 'BRIDGE_SERVICE', group: CHAT, label: 'Bridge service name', note: 'The service restarted on a Mac.' },
  { key: 'BRIDGE_PORT', group: CHAT, label: 'Bridge port', note: 'Port the bridge listens on.', default: '29336' },
  { key: 'GMESSAGES_ALL_CHATS', group: CHAT, label: 'Bridge every chat', note: '1 bridges every chat on the phone instead of only the self-chat (it multiplied Render traffic).', default: 'off' },
  { key: 'SYNAPSE_PORT', group: CHAT, label: 'Homeserver port', note: 'Port Synapse listens on.', default: '8008' },
  { key: 'SERVER_NAME', group: CHAT, label: 'Homeserver name', note: "The homeserver's own name.", default: 'localhost' },
  // People
  { key: 'PEOPLE', group: PEOPLE_GROUP, label: 'People', note: 'Other people who use the bot from their own Google Messages chat, besides you: names separated by commas or spaces (2 to 16 lower-case letters or digits, starting with a letter). Empty: only you.', default: 'empty (only you)' },
  { key: 'PEOPLE_PASSWORDS', group: PEOPLE_GROUP, label: "People's account passwords", note: "The Matrix passwords the host made for the people in PEOPLE, as name:password pairs separated by commas, handed to the bot by the host itself at each start (a value set by hand is replaced). Never set by hand.", secret: true },
  { key: 'PERSON_MAX_MB_PER_MONTH', group: PEOPLE_GROUP, label: 'Monthly limit per person', note: 'The most the bot sends one person besides you in a calendar month, in MB, or "unlimited". Past it, that person is told so and gets no more songs until next month (searching still works). It counts against Render\'s 5 GB of outbound traffic with everything else.', default: '1000' },
  // Cloud host
  { key: 'ADMIN_TOKEN', group: HOST, label: 'Admin token', note: "The recovery and machine password: any user name with it signs in, and it is what the Worker and cloud:check send. Your own user name and password are made on the Account page and kept in the database, not here.", secret: true },
  { key: 'SECRET_KEY', group: HOST, label: 'Master secret', note: "The homeserver's and bridge's secrets are derived from it. Keep it.", secret: true },
  { key: 'R2_ENDPOINT', group: HOST, label: 'R2 endpoint', note: 'The bucket for backups, the lease and alerts.', secret: true },
  { key: 'R2_BUCKET', group: HOST, label: 'R2 bucket', note: 'The bucket name.' },
  { key: 'R2_ACCESS_KEY_ID', group: HOST, label: 'R2 access key id', note: 'Key for the bucket.', secret: true },
  { key: 'R2_SECRET_ACCESS_KEY', group: HOST, label: 'R2 secret key', note: 'Key for the bucket.', secret: true },
  { key: 'R2_REGION', group: HOST, label: 'R2 region', note: 'auto for R2.', default: 'auto' },
  { key: 'PORT', group: HOST, label: 'Public port', note: 'The front door; Render sets it.', default: '8080' },
  { key: 'BOT_WEB_PORT', group: HOST, label: "Bot's own door port", note: "Where this console is served from, on this machine only.", default: '8081' },
  { key: 'HOST', group: HOST, label: 'Door address', note: 'The address the bot\'s own door listens on (127.0.0.1 behind the front door).', default: '0.0.0.0' },
  { key: 'BOT_ENABLED', group: HOST, label: 'Bot answers', note: 'off keeps the bot from answering (setup only).', default: 'on' },
  { key: 'ALLOW_IMPORT', group: HOST, label: 'Catalog import', note: '1 allows the one-time catalog upload.', default: 'off' },
  { key: 'BOT_HEAP_MB', group: HOST, label: "Bot's heap cap", note: "The bot's JavaScript heap limit.", default: '120' },
  { key: 'BOT_MEMORY_MB', group: HOST, label: "Bot's memory share", note: "Its share of memory where the container's own limit can't be read.", default: '220' },
  { key: 'GOMEMLIMIT', group: HOST, label: "Bridge's memory cap", note: "The bridge's Go memory limit.", default: '64MiB' },
  { key: 'DATA_DIR', group: HOST, label: 'Data folder', note: 'Where the databases live; litestream.yml names the same folder.', default: '/data' },
  { key: 'APP_DIR', group: HOST, label: 'App folder', note: 'Where the image keeps the bot.', default: '/app' },
  { key: 'RUN_DIR', group: HOST, label: 'Run folder', note: 'Where the supervisor keeps its files.', default: '/run/mors' },
  { key: 'SYNAPSE_PYTHON', group: HOST, label: 'Synapse python', note: "The image's Python for the homeserver." },
  { key: 'REGISTER_BIN', group: HOST, label: 'Account registration program', note: "The image's program that creates the bot's account." },
  { key: 'LITESTREAM_BIN', group: HOST, label: 'Litestream program', note: "The image's Litestream." },
  { key: 'LITESTREAM_CONFIG', group: HOST, label: 'Litestream config', note: 'Which databases are backed up, and how often.' },
  { key: 'NODE_BIN', group: HOST, label: 'Node program', note: "The image's Node." },
  { key: 'BRIDGE_BIN', group: HOST, label: 'Bridge program', note: "The image's Google Messages bridge." },
  { key: 'INSTANCE_ID', group: HOST, label: 'Instance id', note: 'The name this copy takes the lease under.' },
  { key: 'RENDER_INSTANCE_ID', group: HOST, label: 'Render instance id', note: 'Render sets it.' },
  { key: 'RENDER_URL', group: HOST, label: 'Render address', note: "The service's public address." },
  { key: 'RENDER_GIT_COMMIT', group: HOST, label: 'Deployed commit', note: 'Render sets it: the commit this copy was built from.' },
  { key: 'TZ', group: HOST, label: 'Time zone', note: 'The host\'s time zone: the daily message and quiet hours follow it (Render uses America/New_York).' },
  // Other routes
  { key: 'BEEPER_ACCESS_TOKEN', group: OTHER, label: 'Beeper token', note: 'The Beeper route.', secret: true },
  { key: 'BEEPER_CHAT_ID', group: OTHER, label: 'Beeper chat', note: 'The Beeper route.' },
  { key: 'BEEPER_API_URL', group: OTHER, label: 'Beeper address', note: 'The Beeper route.', default: 'http://localhost:23373' },
  { key: 'BEEPER_POLL_MS', group: OTHER, label: 'Beeper poll interval', note: 'The Beeper route.', default: '1500' },
  { key: 'RBM_AGENT_ID', group: OTHER, label: 'RCS agent id', note: 'The RCS for Business route.' },
  { key: 'RBM_REGION', group: OTHER, label: 'RCS region', note: 'The RCS for Business route.', default: 'us' },
  { key: 'RBM_CLIENT_TOKEN', group: OTHER, label: 'RCS webhook token', note: 'The RCS for Business route.', secret: true },
  { key: 'RBM_MESSAGE_TRAFFIC_TYPE', group: OTHER, label: 'RCS traffic type', note: 'The RCS for Business route.' },
  { key: 'GOOGLE_APPLICATION_CREDENTIALS', group: OTHER, label: 'RCS key file', note: 'Path to the service account key; the file itself is never read here.' },
  { key: 'ALLOWED_SENDERS', group: OTHER, label: 'RCS allowed senders', note: 'Phone numbers the RCS route answers.', secret: true },
];

/** The settings the console can change while the bot runs. */
export const LIVE_KEYS = SETTINGS.filter((spec) => spec.live).map((spec) => spec.key);

const STORE_KEY = 'admin.settings';

interface StateStore {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

/** A setting as the console shows it. A secret never carries its value. */
export interface SettingView {
  key: string;
  group: string;
  label: string;
  note: string;
  default: string | null;
  secret: boolean;
  /** The effective value; null for a secret, and for a setting nothing sets. */
  value: string | null;
  /** For a secret: whether anything sets it. */
  isSet: boolean;
  source: 'override' | 'environment' | 'default';
  /** What Render's environment says, for a live setting that the console has overridden (so the two can be compared). */
  environment: string | null;
  live: boolean;
  hint: string | null;
  example: string | null;
}

/** Settings read again as the bot runs: the environment with the console's overrides over it. */
export class LiveSettings {
  #env: NodeJS.ProcessEnv;
  #state: StateStore | undefined;
  #overrides = new Map<string, string>();

  constructor(options: { env?: NodeJS.ProcessEnv; state?: StateStore | undefined } = {}) {
    this.#env = options.env ?? process.env;
    this.#state = options.state;
    try {
      const saved: unknown = JSON.parse(this.#state?.getState(STORE_KEY) ?? '{}');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [key, value] of Object.entries(saved)) {
          const spec = SETTINGS.find((candidate) => candidate.key === key);
          // Only a live setting whose saved value still passes is taken; anything else is as if it had never been set.
          if (spec?.live && typeof value === 'string' && spec.live.parse(value).ok) this.#overrides.set(key, value);
        }
      }
    } catch {
      // damaged: the environment applies
    }
  }

  /** The console's override for a live setting, if there is one. */
  override(key: string): string | undefined {
    return this.#overrides.get(key);
  }

  /** What the console set a live setting to, validated and normalised. Persisted at once. */
  set(key: string, raw: string): { ok: true; value: string; from: string | null } | { ok: false; error: string } {
    const spec = SETTINGS.find((candidate) => candidate.key === key);
    if (!spec) return { ok: false, error: `there is no setting called ${key}` };
    if (!spec.live) return { ok: false, error: `${key} can't be changed while the bot runs: change it in Render (that restarts the bot)` };
    const parsed = spec.live.parse(raw);
    if (!parsed.ok) return parsed;
    const from = this.#overrides.get(key) ?? this.#env[key]?.trim() ?? null;
    this.#overrides.set(key, parsed.value);
    this.#persist();
    return { ok: true, value: parsed.value, from };
  }

  /** Goes back to what Render's environment says. */
  clear(key: string): { ok: true; from: string | null } | { ok: false; error: string } {
    const spec = SETTINGS.find((candidate) => candidate.key === key);
    if (!spec?.live) return { ok: false, error: `${key} is not a setting the console changes` };
    const from = this.#overrides.get(key) ?? null;
    if (this.#overrides.delete(key)) this.#persist();
    return { ok: true, from };
  }

  #persist(): void {
    try {
      this.#state?.setState(STORE_KEY, JSON.stringify(Object.fromEntries(this.#overrides)));
    } catch {
      // the setting works until the next restart
    }
  }

  // What the bot reads as it runs. Each takes what the bot started with (parsed from the environment, and validated then), which
  // applies until the console overrides it.

  /** When the daily message goes out; undefined for none. */
  digestAt(started: DailyTime | undefined): DailyTime | undefined {
    const raw = this.#overrides.get('DIGEST_TIME');
    if (raw === undefined) return started;
    const time = parseDailyTime(raw);
    return time instanceof Error ? started : time;
  }

  quiet(started: { from: DailyTime; to: DailyTime } | undefined): { from: DailyTime; to: DailyTime } | undefined {
    const raw = this.#overrides.get('QUIET_HOURS');
    if (raw === undefined) return started;
    const hours = parseQuietHours(raw);
    return hours instanceof Error ? started : hours;
  }

  songGapMs(started: number): number {
    const raw = this.#overrides.get('SONG_GAP_SECONDS');
    if (raw === undefined) return started;
    const ms = parseSongGap(raw);
    return ms instanceof Error ? started : ms;
  }

  albumDownloads(started: number | undefined): number | undefined {
    const raw = this.#overrides.get('ALBUM_DOWNLOADS');
    return raw === undefined ? started : Number(raw);
  }

  downloadsAhead(started: number | undefined): number | undefined {
    const raw = this.#overrides.get('DOWNLOADS_AHEAD');
    return raw === undefined ? started : Number(raw);
  }

  /** The most that may be saved to OneDrive this month, in bytes; undefined for no limit. */
  cloudBudget(started: number | undefined): number | undefined {
    const raw = this.#overrides.get('ONEDRIVE_MAX_MB_PER_MONTH');
    if (raw === undefined) return started;
    const budget = parseCloudBudget(raw);
    return budget instanceof Error ? started : budget;
  }

  /** Every setting as the console shows it. */
  report(): SettingView[] {
    return SETTINGS.map((spec): SettingView => {
      const fromEnv = this.#env[spec.key]?.trim() || null;
      const override = this.#overrides.get(spec.key);
      const source: SettingView['source'] = override !== undefined ? 'override' : fromEnv !== null ? 'environment' : 'default';
      const effective = override ?? fromEnv;
      return {
        key: spec.key,
        group: spec.group,
        label: spec.label,
        note: spec.note,
        default: spec.default ?? null,
        secret: spec.secret === true,
        value: spec.secret ? null : effective,
        isSet: effective !== null,
        source,
        environment: spec.secret ? null : fromEnv,
        live: spec.live !== undefined,
        hint: spec.live?.hint ?? null,
        example: spec.live?.example ?? null,
      };
    });
  }
}
