import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sameSecret } from '../cloud/web.ts';
import { AdminAccount, Sessions } from './account.ts';
import { isSameSite } from './same-site.ts';

// The web pages' sign-in: a real page at /login (a user name and a password), a session cookie, and a way out. What signs in:
//   - the owner's own user name and password, set on the console's Account page and kept in the database (account.ts);
//   - any user name with the host's ADMIN_TOKEN as the password: the recovery way in (and the first one, before an account exists).
// A script or the Cloudflare Worker has no cookie: it sends the ADMIN_TOKEN as a Bearer token (or a Basic password), as before.
//
// The cookie is HttpOnly and SameSite=Lax (and Secure over https), so another site cannot make the browser send it with anything
// but a plain link; every change is also a POST with its own header and a same-site check, as in the console. Wrong guesses are
// slowed (300 ms) and limited (a few a minute, for the whole host), because the check is a deliberately slow hash.

const COOKIE = 'mors_session';
const FAILS_PER_MINUTE = 8;
const MAX_BODY_BYTES = 4 * 1024;
const DEFAULT_PAGE = '/admin/';
const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } as const;
const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PAGES: Record<string, { file: string; type: string }> = {
  '/login': { file: 'login.html', type: 'text/html; charset=utf-8' },
  '/login.js': { file: 'login.js', type: 'text/javascript; charset=utf-8' },
  '/login.css': { file: 'login.css', type: 'text/css; charset=utf-8' },
};

/** Where to go after signing in: a path on this site, never another address, and never the sign-in page itself. */
export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\/(?!\/)[\w\-./?=&%#:,~+@]*$/.test(raw) || raw.length > 300 || raw === '/login' || raw.startsWith('/login?') || raw.startsWith('/login/')) return DEFAULT_PAGE;
  return raw;
}

const cookieOf = (req: IncomingMessage): string | undefined => {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim();
  }
  return undefined;
};

export type Confirmed = 'ok' | 'wrong' | 'limited';

export interface SignInOptions {
  /** The host's ADMIN_TOKEN, when it has one. */
  token?: string | undefined;
  account: AdminAccount;
  sessions: Sessions;
  log?: (line: string) => void;
  now?: () => number;
}

export class SignIn {
  readonly account: AdminAccount;
  readonly sessions: Sessions;
  #token: string | undefined;
  #log: (line: string) => void;
  #now: () => number;
  #fails: number[] = [];
  #files = new Map<string, { body: Buffer; etag: string }>();

  constructor(options: SignInOptions) {
    this.#token = options.token?.trim() || undefined;
    this.account = options.account;
    this.sessions = options.sessions;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? Date.now;
  }

  /** Whether anything can sign in at all (a token in Render, or an account in the database). */
  get configured(): boolean {
    return this.#token !== undefined || this.account.isSet;
  }

  /** Whether the host has an ADMIN_TOKEN. */
  get hasToken(): boolean {
    return this.#token !== undefined;
  }

  /** The session token in the request's cookie, if any (so the console can say which session is this browser's). */
  cookieToken(req: IncomingMessage): string | undefined {
    return cookieOf(req);
  }

  /** Whether the request is signed in: the ADMIN_TOKEN in its Authorization header (a Bearer token, or any user name's Basic password), or a live session. */
  authorized(req: IncomingMessage): boolean {
    const header = String(req.headers.authorization ?? '');
    const [scheme, value] = header.split(/\s+/, 2);
    if (this.#token && value) {
      if (scheme?.toLowerCase() === 'bearer' && sameSecret(value, this.#token)) return true;
      if (scheme?.toLowerCase() === 'basic') {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        const colon = decoded.indexOf(':');
        if (colon >= 0 && sameSecret(decoded.slice(colon + 1), this.#token)) return true;
      }
    }
    return this.sessions.valid(cookieOf(req));
  }

  /** A browser asking for a page without being signed in is sent to the sign-in page, which brings it back. */
  redirectToLogin(req: IncomingMessage, res: ServerResponse): boolean {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !String(req.headers.accept ?? '').includes('text/html')) return false;
    res.writeHead(302, { location: `/login?next=${encodeURIComponent(safeNext(req.url))}`, ...SECURITY_HEADERS });
    res.end();
    return true;
  }

  #limited(): boolean {
    const now = this.#now();
    this.#fails = this.#fails.filter((at) => now - at < 60_000);
    return this.#fails.length >= FAILS_PER_MINUTE;
  }

  /** Whether `password` is one the owner may confirm a change with: their own password, or ADMIN_TOKEN. Wrong attempts count against the limit. */
  async confirm(password: string): Promise<Confirmed> {
    if (this.#limited()) return 'limited';
    if (this.#token && sameSecret(password, this.#token)) return 'ok';
    if (this.account.isSet && (await this.account.verifyPassword(password))) return 'ok';
    this.#fails.push(this.#now());
    return 'wrong';
  }

  /** Opens a session and says how to give it to the browser. */
  startSession(req: IncomingMessage): string {
    const { token, maxAgeSeconds } = this.sessions.create();
    const secure = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  }

  #cleared(req: IncomingMessage): string {
    const secure = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  #json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(body));
  }

  /** The sign-in page and its files, signing in, and signing out. True when the request was one of those. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://login');
    const path = url.pathname;
    const page = PAGES[path];
    if (page && (req.method === 'GET' || req.method === 'HEAD')) {
      // Already signed in: straight on.
      if (path === '/login' && this.authorized(req)) {
        res.writeHead(302, { location: safeNext(url.searchParams.get('next')), ...SECURITY_HEADERS });
        res.end();
        return true;
      }
      this.#serve(req, res, page);
      return true;
    }
    if (req.method === 'POST' && (path === '/login' || path === '/logout')) {
      try {
        if (req.headers['x-admin-console'] !== '1' || !isSameSite(req.headers)) return this.#json(res, 403, { error: 'Refused: this has to come from the sign-in page itself.' }), true;
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return this.#json(res, 415, { error: 'Send JSON.' }), true;
        const body = await this.#body(req);
        if (path === '/logout') {
          this.sessions.revoke(cookieOf(req));
          return this.#json(res, 200, { ok: true }, { 'set-cookie': this.#cleared(req) }), true;
        }
        await this.#login(req, res, body);
      } catch (err) {
        const status = err instanceof BodyError ? err.status : 500;
        if (!res.headersSent) this.#json(res, status, { error: err instanceof BodyError ? err.message : 'Something went wrong.' });
      }
      return true;
    }
    return false;
  }

  async #login(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
    if (!this.configured) return this.#json(res, 503, { error: 'Nothing is set up to sign in with: the host has no ADMIN_TOKEN and no account has been made.' });
    const user = typeof body.user === 'string' ? body.user : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (this.#limited()) {
      this.#log('sign-in: too many wrong attempts this minute; waiting');
      return this.#json(res, 429, { error: 'Too many wrong attempts. Wait a minute and try again.' });
    }
    let ok = this.#token !== undefined && sameSecret(password, this.#token);
    if (!ok && this.account.isSet) ok = await this.account.verify(user, password);
    if (!ok) {
      this.#fails.push(this.#now());
      this.#log(`sign-in: wrong user name or password (${this.#fails.length} in the last minute)`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return this.#json(res, 401, { error: 'That user name and password do not match.' });
    }
    this.#log('sign-in: signed in');
    this.#json(res, 200, { ok: true, next: safeNext(body.next) }, { 'set-cookie': this.startSession(req) });
  }

  async #body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new BodyError(413, 'That is too much data.');
      chunks.push(chunk as Buffer);
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // falls through
    }
    throw new BodyError(400, 'Expected a JSON object.');
  }

  #serve(req: IncomingMessage, res: ServerResponse, page: { file: string; type: string }): void {
    let kept = this.#files.get(page.file);
    if (!kept) {
      const body = readFileSync(new URL(`./site/${page.file}`, import.meta.url));
      kept = { body, etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
      this.#files.set(page.file, kept);
    }
    const headers = {
      'content-type': page.type,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-cache',
      etag: kept.etag,
      ...(page.file === 'login.html' ? { 'content-security-policy': CONTENT_SECURITY_POLICY, 'x-frame-options': 'DENY' } : {}),
    };
    if (req.headers['if-none-match'] === kept.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : kept.body);
  }
}

class BodyError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
