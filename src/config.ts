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
  /** How much disk the songs kept ready may use, in MB. 0 turns keeping songs ready off. */
  prefetchMb: number;
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
  const prefetchMb = Number(env.PREFETCH_MB?.trim() || 400);
  if (!(Number.isFinite(prefetchMb) && prefetchMb >= 0 && prefetchMb <= 20_000)) {
    problems.push(`PREFETCH_MB must be a number from 0 (off) to 20000 (got "${env.PREFETCH_MB}")`);
  }
  return {
    pollMs,
    maxDownloadMb,
    dbPath: env.CATALOG_DB?.trim() || 'data/catalog.db',
    digestAt: digestAt instanceof Error ? undefined : digestAt,
    prefetchMb,
  };
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

  throwIfAny(problems);
  return { homeserver, token, roomID, ...settings };
}
