import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { parseDailyTime, type DailyTime } from './library/jobs.ts';
import { DEFAULT_BASE_URL } from './beeper/client.ts';
import { DEFAULT_HOMESERVER } from './matrix/client.ts';

const REGIONS = ['us', 'europe', 'asia'] as const;
const TRAFFIC_TYPES = ['AUTHENTICATION', 'TRANSACTION', 'PROMOTION', 'SERVICEREQUEST', 'ACKNOWLEDGEMENT'];
const PHONE = /^\+[1-9]\d{6,14}$/;

function requiredReader(env: NodeJS.ProcessEnv, problems: string[]) {
  return (name: string): string => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is not set`);
    return value ?? '';
  };
}

function throwIfAny(problems: string[]): void {
  if (problems.length > 0) {
    throw new Error(`Configuration problems:\n  - ${problems.join('\n  - ')}\nSee .env.example.`);
  }
}

function checkUrl(name: string, value: string, problems: string[]): void {
  try {
    const { protocol } = new URL(value);
    if (protocol !== 'http:' && protocol !== 'https:') problems.push(`${name} must be http(s) (got "${value}")`);
  } catch {
    problems.push(`${name} is not a valid URL (got "${value}")`);
  }
}

export interface Config {
  port: number;
  dbPath: string;
  agentId: string;
  region: (typeof REGIONS)[number];
  /** Empty when loaded with `webhook: false` (scripts that only call the API). */
  clientToken: string;
  keyPath: string;
  trafficType?: string | undefined;
  allowedSenders?: Set<string> | undefined;
}

/** Reads and validates the RCS for Business settings, reporting every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: { webhook?: boolean } = {}): Config {
  const needWebhook = options.webhook ?? true;
  const problems: string[] = [];
  const required = requiredReader(env, problems);

  const agentId = required('RBM_AGENT_ID');
  const keyPath = required('GOOGLE_APPLICATION_CREDENTIALS');
  const clientToken = needWebhook ? required('RBM_CLIENT_TOKEN') : (env.RBM_CLIENT_TOKEN?.trim() ?? '');

  const region = (env.RBM_REGION?.trim() || 'us').toLowerCase();
  if (!(REGIONS as readonly string[]).includes(region)) {
    problems.push(`RBM_REGION must be one of ${REGIONS.join(', ')} (got "${region}")`);
  }

  const trafficType = env.RBM_MESSAGE_TRAFFIC_TYPE?.trim().toUpperCase() || undefined;
  if (trafficType && !TRAFFIC_TYPES.includes(trafficType)) {
    problems.push(`RBM_MESSAGE_TRAFFIC_TYPE must be one of ${TRAFFIC_TYPES.join(', ')} (got "${trafficType}")`);
  }

  const senders = (env.ALLOWED_SENDERS ?? '')
    .split(',')
    .map((sender) => sender.trim())
    .filter(Boolean);
  for (const sender of senders) {
    if (!PHONE.test(sender)) problems.push(`ALLOWED_SENDERS entry "${sender}" is not in E.164 format (+15551234567)`);
  }

  const port = Number(env.PORT?.trim() || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT must be 1-65535 (got "${env.PORT}")`);

  throwIfAny(problems);

  return {
    port,
    dbPath: env.CATALOG_DB?.trim() || 'data/catalog.db',
    agentId,
    region: region as Config['region'],
    clientToken,
    keyPath,
    trafficType,
    allowedSenders: senders.length > 0 ? new Set(senders) : undefined,
  };
}

/** Settings shared by the two "watch my own chat" routes (Beeper and Matrix). */
interface ChatSettings {
  pollMs: number;
  dbPath: string;
  maxDownloadMb: number;
  /** When the daily new-music message goes out (this Mac's time). Undefined when DIGEST_TIME=off. */
  digestAt: DailyTime | undefined;
  /** How much disk the songs kept ready may use, in MB: Infinity (the default) for no limit, 0 for none kept. */
  prefetchMb: number;
  /** A folder (on an external drive, say) the kept songs move into whenever it's there. */
  archiveDir: string | undefined;
  /** No alerts for new songs by artists you follow in these hours. Undefined when QUIET_HOURS=off. */
  quiet: { from: DailyTime; to: DailyTime } | undefined;
  /** The least time between two songs sent, in ms, so the phone has sent one before the next arrives. */
  songGapMs: number;
}

function readChatSettings(env: NodeJS.ProcessEnv, pollName: string, problems: string[]): ChatSettings {
  const pollMs = Number(env[pollName]?.trim() || 1500);
  if (!Number.isInteger(pollMs) || pollMs < 500 || pollMs > 30_000) {
    problems.push(`${pollName} must be a whole number from 500 to 30000 (got "${env[pollName]}")`);
  }
  const maxDownloadMb = Number(env.MAX_DOWNLOAD_MB?.trim() || 100);
  if (!(maxDownloadMb > 0 && maxDownloadMb <= 500)) {
    problems.push(`MAX_DOWNLOAD_MB must be more than 0 and at most 500 (got "${env.MAX_DOWNLOAD_MB}")`);
  }
  const digestAt = parseDailyTime(env.DIGEST_TIME);
  if (digestAt instanceof Error) problems.push(digestAt.message);
  const prefetchMb = parsePrefetchMb(env.PREFETCH_MB);
  if (prefetchMb instanceof Error) problems.push(prefetchMb.message);
  const quiet = parseQuietHours(env.QUIET_HOURS);
  if (quiet instanceof Error) problems.push(quiet.message);
  const archiveDir = parseArchiveDir(env.SONGS_ARCHIVE_DIR);
  if (archiveDir instanceof Error) problems.push(archiveDir.message);
  const songGapMs = parseSongGap(env.SONG_GAP_SECONDS);
  if (songGapMs instanceof Error) problems.push(songGapMs.message);
  return {
    pollMs,
    maxDownloadMb,
    dbPath: env.CATALOG_DB?.trim() || 'data/catalog.db',
    digestAt: digestAt instanceof Error ? undefined : digestAt,
    prefetchMb: prefetchMb instanceof Error ? 0 : prefetchMb,
    archiveDir: archiveDir instanceof Error ? undefined : archiveDir,
    quiet: quiet instanceof Error ? undefined : quiet,
    songGapMs: songGapMs instanceof Error ? 0 : songGapMs,
  };
}

/** Seconds between two songs (SONG_GAP_SECONDS), in ms: 5 unless set, 0 or "off" for none, at most 300. */
export function parseSongGap(raw: string | undefined): number | Error {
  const text = raw?.trim().toLowerCase() || '5';
  const seconds = text === 'off' ? 0 : Number(text);
  if (!(Number.isFinite(seconds) && seconds >= 0 && seconds <= 300)) {
    return new Error(`SONG_GAP_SECONDS must be a number of seconds from 0 to 300, or "off" (got "${raw}")`);
  }
  return seconds * 1000;
}

/**
 * Disk space for songs kept ready, in MB. No limit unless one is set (every song you get stays); "unlimited" says
 * the same. 0 or "off" keeps none.
 */
export function parsePrefetchMb(raw: string | undefined): number | Error {
  const text = raw?.trim().toLowerCase() || 'unlimited';
  if (text === 'unlimited') return Number.POSITIVE_INFINITY;
  if (text === 'off') return 0;
  const mb = Number(text);
  if (!(Number.isFinite(mb) && mb >= 0)) return new Error(`PREFETCH_MB must be "unlimited" (the default), a number of MB, or 0 for none (got "${raw}")`);
  return mb;
}

/** The folder kept songs move into (SONGS_ARCHIVE_DIR): a full path, or one starting with ~/. Nothing when unset. */
export function parseArchiveDir(raw: string | undefined, home = homedir()): string | undefined | Error {
  const text = raw?.trim();
  if (!text) return undefined;
  const path = text.startsWith('~/') ? join(home, text.slice(2)) : text;
  if (!isAbsolute(path)) return new Error(`SONGS_ARCHIVE_DIR must be a full path, like /Volumes/Drive/Music/Music over RCS (got "${raw}")`);
  return normalize(path).replace(/\/+$/, '');
}

/** Reads "22:00-07:00" (24-hour, may cross midnight); "off" for none. */
export function parseQuietHours(raw: string | undefined, fallback = '22:00-07:00'): { from: DailyTime; to: DailyTime } | undefined | Error {
  const text = (raw?.trim() || fallback).toLowerCase();
  if (/^(off|false|no|0|none)$/.test(text)) return undefined;
  const [from, to] = text.split(/\s*-\s*/);
  const start = parseDailyTime(from, 'x');
  const end = parseDailyTime(to, 'x');
  if (!from || !to || start instanceof Error || end instanceof Error || !start || !end) {
    return new Error(`QUIET_HOURS must look like 22:00-07:00 or be "off" (got "${raw}")`);
  }
  return { from: start, to: end };
}

export interface BeeperConfig extends ChatSettings {
  token: string;
  /** Empty when loaded with `chat: false` (the script that lists chats). */
  chatID: string;
  baseUrl: string;
}

/** Reads and validates the Beeper settings, reporting every problem at once. */
export function loadBeeperConfig(env: NodeJS.ProcessEnv = process.env, options: { chat?: boolean } = {}): BeeperConfig {
  const needChat = options.chat ?? true;
  const problems: string[] = [];
  const required = requiredReader(env, problems);

  const token = required('BEEPER_ACCESS_TOKEN');
  const chatID = needChat ? required('BEEPER_CHAT_ID') : (env.BEEPER_CHAT_ID?.trim() ?? '');
  const baseUrl = (env.BEEPER_API_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
  checkUrl('BEEPER_API_URL', baseUrl, problems);
  const settings = readChatSettings(env, 'BEEPER_POLL_MS', problems);

  throwIfAny(problems);
  return { token, chatID, baseUrl, ...settings };
}

export interface MatrixConfig extends ChatSettings {
  /** The bridge's own address, for checking that Google Messages is still logged in. */
  bridgeUrl: string;
  homeserver: string;
  token: string;
  /** Empty when loaded with `room: false` (scripts that don't watch one room). */
  roomID: string;
}

/** Reads and validates the Matrix settings, reporting every problem at once. */
export function loadMatrixConfig(env: NodeJS.ProcessEnv = process.env, options: { room?: boolean } = {}): MatrixConfig {
  const needRoom = options.room ?? true;
  const problems: string[] = [];

  const token = env.MATRIX_ACCESS_TOKEN?.trim() ?? '';
  if (!token) problems.push('MATRIX_ACCESS_TOKEN is not set (run `npm run matrix-login` to get one)');
  const roomID = env.MATRIX_ROOM_ID?.trim() ?? '';
  if (needRoom && !roomID) problems.push('MATRIX_ROOM_ID is not set (run `npm run matrix-rooms` to find it)');
  const homeserver = (env.MATRIX_HOMESERVER?.trim() || DEFAULT_HOMESERVER).replace(/\/+$/, '');
  checkUrl('MATRIX_HOMESERVER', homeserver, problems);
  const settings = readChatSettings(env, 'MATRIX_POLL_MS', problems);
  const bridgeUrl = (env.BRIDGE_URL?.trim() || 'http://127.0.0.1:29336').replace(/\/+$/, '');
  checkUrl('BRIDGE_URL', bridgeUrl, problems);

  throwIfAny(problems);
  return { homeserver, token, roomID, bridgeUrl, ...settings };
}
