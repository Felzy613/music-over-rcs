import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/** One thing the bridge's bot said while pairing. */
export interface PairLine {
  at: string;
  text: string;
}

/** What the cloud web server needs from the rest of the bot. Everything else it asks for here, it gets from these. */
export interface CloudDeps {
  /** The password for everything but /healthz and /ping. Without one those routes answer 503 instead of being open. */
  adminToken: string | undefined;
  /** What /status reports. */
  status(): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Sends a command to the bridge's bot (`login google`, then the pasted request), and reads what it answered. */
  pair: { send(text: string): Promise<void>; log(): Promise<PairLine[]> };
  /** Rooms the bridge made for the chat with this phone number. */
  rooms(phone: string): Promise<string[]> | string[];
  /** Chooses the room the bot answers in. */
  setRoom(room: string): Promise<void> | void;
  /** Whether a catalog may be uploaded now (ALLOW_IMPORT=1 and the bot not started). */
  canImport(): boolean;
  /** Reads an uploaded catalog file into this one; the file is deleted afterwards. */
  importCatalog(path: string): Promise<Record<string, number>> | Record<string, number>;
  /** Saving songs to OneDrive, when it is set up (ONEDRIVE_CLIENT_ID): what to show, and starting a sign-in. */
  oneDrive?: { status(): Record<string, unknown>; start(): Promise<Record<string, unknown>> } | undefined;
  /** Leaves a test alert for the Worker to mail (only when the R2 settings are there). */
  testAlert?: (() => Promise<void>) | undefined;
  /** The /pair page. */
  pageHtml: string;
}

const MAX_JSON_BYTES = 64 * 1024;
const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
const REALM = 'Music over RCS';
const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } as const;

/** Compares without leaking, through timing, how much of the password matched. */
export function sameSecret(given: string, wanted: string): boolean {
  return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(wanted).digest());
}

/** The password in an `Authorization: Basic …` (any user name) or `Bearer …` header. */
export function passwordIn(header: string | undefined): string | undefined {
  const [scheme, value] = (header ?? '').split(/\s+/, 2);
  if (!value) return undefined;
  if (scheme?.toLowerCase() === 'bearer') return value;
  if (scheme?.toLowerCase() === 'basic') {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon >= 0 ? decoded.slice(colon + 1) : undefined;
  }
  return undefined;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, 'too much data');
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // falls through
  }
  throw new HttpError(400, 'expected a JSON object');
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const text = type === 'application/json' ? JSON.stringify(body) : String(body);
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, ...SECURITY_HEADERS });
  res.end(text);
}

/**
 * The cloud host's only door: /healthz for Render and the Worker that keeps it awake (it says nothing about the bot), and
 * behind the admin password a status report, the page to pair the bridge with Google Messages, the choice of the chat the
 * bot answers in, and a one-time upload of the old catalog. It is for a person with the password, not an API for others.
 */
export function createCloudWeb(deps: CloudDeps): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://cloud');
    const path = url.pathname;
    try {
      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
        return void res.end(req.method === 'HEAD' ? undefined : 'ok');
      }
      // For a monitor that wants to see the app itself answer: 500 on purpose, which neither Render's "starting up" page nor its
      // gateway errors (502/503) ever say, so only a running web door gets through.
      if (path === '/ping' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
        return void res.end(req.method === 'HEAD' ? undefined : 'pong (this answers 500 on purpose, for a monitor that expects it)');
      }
      if (!deps.adminToken) return send(res, 503, { error: 'ADMIN_TOKEN is not set, so nothing but /healthz and /ping is available' });
      const given = passwordIn(req.headers.authorization);
      if (given === undefined || !sameSecret(given, deps.adminToken)) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        res.writeHead(401, { 'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"`, 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        return void res.end(JSON.stringify({ error: 'unauthorized' }));
      }

      if (req.method === 'GET' && path === '/status') return send(res, 200, await deps.status());
      if (req.method === 'GET' && (path === '/pair' || path === '/')) return send(res, 200, deps.pageHtml, 'text/html');
      if (req.method === 'GET' && path === '/pair/log') return send(res, 200, { lines: await deps.pair.log() });
      if (req.method === 'POST' && path === '/pair/send') {
        const text = (await readJson(req)).text;
        if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
        if (text.length > 20_000) throw new HttpError(413, 'that is too long to be a command');
        await deps.pair.send(text);
        return send(res, 200, { ok: true });
      }
      if (path === '/onedrive/status' || path === '/onedrive/start') {
        if (!deps.oneDrive) throw new HttpError(404, 'OneDrive is not set up (set ONEDRIVE_CLIENT_ID)');
        if (req.method === 'GET' && path === '/onedrive/status') return send(res, 200, deps.oneDrive.status());
        if (req.method === 'POST' && path === '/onedrive/start') return send(res, 200, await deps.oneDrive.start());
      }
      if (req.method === 'POST' && path === '/admin/test-alert') {
        if (!deps.testAlert) throw new HttpError(404, 'alerts need the R2 settings (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
        await deps.testAlert();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/setup/rooms') {
        const phone = (url.searchParams.get('phone') ?? '').replace(/\D/g, '');
        if (phone.length < 7) throw new HttpError(400, 'phone is required (your number, digits only)');
        return send(res, 200, { rooms: await deps.rooms(phone) });
      }
      if (req.method === 'POST' && path === '/setup/room') {
        const room = (await readJson(req)).room;
        if (typeof room !== 'string' || !/^![^\s:]+:[^\s]+$/.test(room)) throw new HttpError(400, 'room must look like !abc:server');
        await deps.setRoom(room);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && path === '/admin/import-catalog') {
        if (!deps.canImport()) throw new HttpError(403, 'importing is off (set ALLOW_IMPORT=1, and do it before the bot starts)');
        const dir = await mkdtemp(join(tmpdir(), 'mors-import-'));
        const file = join(dir, 'catalog.db');
        try {
          let size = 0;
          let head = Buffer.alloc(0);
          const guarded = async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              if (head.length < SQLITE_MAGIC.length) head = Buffer.concat([head, chunk]).subarray(0, SQLITE_MAGIC.length);
              size += chunk.length;
              if (size > MAX_IMPORT_BYTES) throw new HttpError(413, 'that file is too big to be the catalog');
              yield chunk;
            }
          };
          await pipeline(req, guarded, createWriteStream(file, { mode: 0o600 }));
          if (!head.equals(SQLITE_MAGIC)) throw new HttpError(400, 'that is not a SQLite database');
          return send(res, 200, { ok: true, imported: await deps.importCatalog(file) });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      send(res, 404, { error: 'not found' });
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      send(res, 500, { error: err instanceof Error ? err.message : 'server error' });
    }
  });
}
