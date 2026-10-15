// A small OneDrive client for saving songs into the app's own folder (Apps/<app name>) in the owner's personal OneDrive.
// It signs in with Microsoft's device code flow (the owner types a code at microsoft.com, so no password or cookie ever
// reaches the bot), keeps the refresh token in the catalog's small-facts table, and uploads with Graph upload sessions.
// Written against Microsoft's documentation; see docs/cloud.md for what has and hasn't been tried against the real service.

interface StateStore {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

const GRAPH_URL = 'https://graph.microsoft.com/v1.0';
const LOGIN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
/** A multiple of 320 KiB (Graph requires it), and the size Microsoft recommends. */
const CHUNK_BYTES = 32 * 327_680;
/** Up to this size a single request does it. */
const SIMPLE_BYTES = 4 * 1024 * 1024;
const MAX_RETRIES = 4;
export const DEFAULT_SCOPE = 'Files.ReadWrite.AppFolder offline_access';
const REFRESH_KEY = 'onedrive.refresh';
const ERROR_KEY = 'onedrive.error';

export class OneDriveError extends Error {
  status: number | undefined;
  /** True when only signing in again will help. */
  needsLogin: boolean;
  constructor(message: string, options: { status?: number; needsLogin?: boolean } = {}) {
    super(message);
    this.name = 'OneDriveError';
    this.status = options.status;
    this.needsLogin = options.needsLogin ?? false;
  }
}

export type LoginState =
  | { state: 'idle' }
  | { state: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { state: 'connected' }
  | { state: 'failed'; error: string };

export interface OneDriveStatus {
  connected: boolean;
  login: LoginState;
  /** The last thing that went wrong with an upload or a refresh, until something works. */
  error?: string;
}

export interface OneDriveOptions {
  clientId: string;
  state: StateStore;
  scope?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  /** Where Microsoft's sign-in and Graph are (for tests; the defaults are the real ones). */
  loginUrl?: string;
  graphUrl?: string;
}

/** A path as Graph wants it in a URL: each part encoded, and no part a name OneDrive refuses. */
export function graphPath(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      // OneDrive refuses " * : < > ? / \ | in names, and a name that ends in a dot or a space.
      const clean = part.replace(/["*:<>?\\|]/g, '_').replace(/[. ]+$/, '').slice(0, 200) || '_';
      return encodeURIComponent(clean);
    })
    .join('/');
}

export class OneDrive {
  #clientId: string;
  #state: StateStore;
  #scope: string;
  #fetch: typeof fetch;
  #sleep: (ms: number) => Promise<void>;
  #now: () => number;
  #log: (line: string) => void;
  #loginUrl: string;
  #graphUrl: string;
  #login: LoginState = { state: 'idle' };
  #polling: Promise<void> = Promise.resolve();
  #access: { token: string; expiresAt: number } | undefined;
  #refreshing: Promise<string> | undefined;

  constructor(options: OneDriveOptions) {
    this.#clientId = options.clientId;
    this.#state = options.state;
    this.#scope = options.scope ?? DEFAULT_SCOPE;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? (() => {});
    this.#loginUrl = options.loginUrl ?? LOGIN_URL;
    this.#graphUrl = options.graphUrl ?? GRAPH_URL;
  }

  /** Whether the owner has signed in (a refresh token is kept). */
  connected(): boolean {
    return Boolean(this.#state.getState(REFRESH_KEY));
  }

  status(): OneDriveStatus {
    const error = this.#state.getState(ERROR_KEY);
    return { connected: this.connected(), login: this.#login, ...(error ? { error } : {}) };
  }

  /** Resolves when a sign-in that is waiting for the owner has finished (for tests). */
  loginDone(): Promise<void> {
    return this.#polling;
  }

  // --- signing in -----------------------------------------------------------------------------------------------

  /** Starts a sign-in: the owner opens the address it gives, enters the code, and approves. The bot waits for that in the background. */
  async startLogin(): Promise<LoginState> {
    const res = await this.#fetch(`${this.#loginUrl}/devicecode`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.#clientId, scope: this.#scope }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
      const why = typeof body.error_description === 'string' ? body.error_description.split('\r\n')[0] : `HTTP ${res.status}`;
      this.#login = { state: 'failed', error: `Microsoft would not start a sign-in: ${why}` };
      return this.#login;
    }
    const expiresAt = this.#now() + (Number(body.expires_in) || 900) * 1000;
    this.#login = { state: 'pending', userCode: body.user_code, verificationUri: typeof body.verification_uri === 'string' ? body.verification_uri : 'https://microsoft.com/devicelogin', expiresAt };
    this.#polling = this.#poll(body.device_code, Number(body.interval) || 5, expiresAt);
    return this.#login;
  }

  async #poll(deviceCode: string, intervalSeconds: number, expiresAt: number): Promise<void> {
    let interval = intervalSeconds;
    while (this.#now() < expiresAt) {
      await this.#sleep(interval * 1000);
      let body: Record<string, unknown>;
      try {
        const res = await this.#fetch(`${this.#loginUrl}/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: this.#clientId, device_code: deviceCode }),
          signal: AbortSignal.timeout(20_000),
        });
        body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      } catch {
        continue; // a network blip; the code is good for fifteen minutes
      }
      if (typeof body.refresh_token === 'string') {
        this.#state.setState(REFRESH_KEY, body.refresh_token);
        this.#state.setState(ERROR_KEY, '');
        if (typeof body.access_token === 'string') this.#access = { token: body.access_token, expiresAt: this.#now() + (Number(body.expires_in) || 3600) * 1000 };
        this.#login = { state: 'connected' };
        this.#log('OneDrive is connected');
        return;
      }
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') {
        interval += 5;
        continue;
      }
      const why = body.error === 'authorization_declined' ? 'it was declined' : body.error === 'expired_token' ? 'the code ran out' : String(body.error ?? 'unknown error');
      this.#login = { state: 'failed', error: `Sign-in did not finish: ${why}.` };
      return;
    }
    this.#login = { state: 'failed', error: 'Sign-in did not finish: the code ran out.' };
  }

  // --- tokens ---------------------------------------------------------------------------------------------------

  /** A working access token, refreshed when it is about to lapse. Microsoft gives a new refresh token each time; the latest is kept. */
  accessToken(): Promise<string> {
    if (this.#access && this.#access.expiresAt - 60_000 > this.#now()) return Promise.resolve(this.#access.token);
    this.#refreshing ??= this.#refresh().finally(() => (this.#refreshing = undefined));
    return this.#refreshing;
  }

  async #refresh(): Promise<string> {
    const refresh = this.#state.getState(REFRESH_KEY);
    if (!refresh) throw new OneDriveError('OneDrive is not connected: sign in on the setup page.', { needsLogin: true });
    const res = await this.#fetch(`${this.#loginUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.#clientId, refresh_token: refresh, scope: this.#scope }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== 'string') {
      const code = String(body.error ?? res.status);
      // invalid_grant: the token was revoked or lapsed (not used for 90 days, or the password changed). Only a new sign-in helps.
      const needsLogin = code === 'invalid_grant' || code === 'interaction_required' || code === 'invalid_client' || code === 'unauthorized_client';
      throw new OneDriveError(`Microsoft would not renew the OneDrive sign-in (${code}).${needsLogin ? ' Sign in again on the setup page.' : ''}`, { status: res.status, needsLogin });
    }
    if (typeof body.refresh_token === 'string') this.#state.setState(REFRESH_KEY, body.refresh_token);
    this.#access = { token: body.access_token, expiresAt: this.#now() + (Number(body.expires_in) || 3600) * 1000 };
    return this.#access.token;
  }

  // --- talking to OneDrive --------------------------------------------------------------------------------------

  /** One Graph request, with the token, one retry on a stale token, and a wait-and-retry when Microsoft says to slow down. */
  async #graph(url: string, init: RequestInit = {}): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await this.#fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.#access = undefined;
        await res.body?.cancel().catch(() => {});
        continue;
      }
      if ((res.status === 429 || res.status === 503 || res.status === 502 || res.status === 504) && attempt < MAX_RETRIES) {
        const wait = Math.min(Number(res.headers.get('retry-after')) || 2 ** attempt, 30);
        await res.body?.cancel().catch(() => {});
        await this.#sleep(wait * 1000);
        continue;
      }
      return res;
    }
  }

  async #fail(res: Response, doing: string): Promise<never> {
    const text = await res.text().catch(() => '');
    let detail = '';
    try {
      detail = ((JSON.parse(text) as { error?: { message?: string; code?: string } }).error?.message ?? '').slice(0, 200);
    } catch {
      detail = text.slice(0, 120);
    }
    throw new OneDriveError(`OneDrive refused ${doing} (HTTP ${res.status}${detail ? `: ${detail}` : ''})`, { status: res.status, needsLogin: res.status === 401 || res.status === 403 });
  }

  /** Whether a file is already there. */
  async exists(path: string): Promise<boolean> {
    const res = await this.#graph(`${this.#graphUrl}/me/drive/special/approot:/${graphPath(path)}`);
    if (res.status === 404) return false;
    if (!res.ok) return this.#fail(res, 'a check for a file');
    await res.body?.cancel().catch(() => {});
    return true;
  }

  /** Saves a file at a path in the app folder, making the folders on the way. Replaces a file of the same name. */
  async upload(path: string, data: Uint8Array): Promise<void> {
    try {
      await this.#uploadOnce(path, data);
    } catch (err) {
      if (!(err instanceof OneDriveError) || err.status !== 404) throw err;
      // The folders on the way may not exist yet (or the upload session expired): make them, and begin again once.
      await this.#ensureFolders(path);
      await this.#uploadOnce(path, data);
    }
  }

  async #uploadOnce(path: string, data: Uint8Array): Promise<void> {
    const target = `${this.#graphUrl}/me/drive/special/approot:/${graphPath(path)}:`;
    if (data.byteLength <= SIMPLE_BYTES) {
      const res = await this.#graph(`${target}/content?@microsoft.graph.conflictBehavior=replace`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: data as never });
      if (!res.ok) return this.#fail(res, 'a file');
      await res.body?.cancel().catch(() => {});
      return;
    }
    const created = await this.#graph(`${target}/createUploadSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    });
    if (!created.ok) return this.#fail(created, 'an upload');
    const uploadUrl = ((await created.json()) as { uploadUrl?: string }).uploadUrl;
    if (!uploadUrl) throw new OneDriveError('OneDrive gave no address to upload to');
    for (let offset = 0; offset < data.byteLength; ) {
      const end = Math.min(offset + CHUNK_BYTES, data.byteLength);
      offset = await this.#putChunk(uploadUrl, data, offset, end);
    }
  }

  /** Sends one range of a file, retrying a failed or dropped request; returns where the next range starts. */
  async #putChunk(uploadUrl: string, data: Uint8Array, start: number, end: number): Promise<number> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      try {
        // No Authorization header here: the upload address already carries its authorization, and a token on it is refused.
        res = await this.#fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'content-range': `bytes ${start}-${end - 1}/${data.byteLength}` },
          body: data.subarray(start, end) as never,
          signal: AbortSignal.timeout(180_000),
        });
      } catch (err) {
        if (attempt >= MAX_RETRIES) throw new OneDriveError(`the upload to OneDrive broke off: ${err instanceof Error ? err.message : String(err)}`);
        await this.#sleep(2 ** attempt * 1000);
        continue;
      }
      if (res.status === 200 || res.status === 201) {
        await res.body?.cancel().catch(() => {});
        return data.byteLength;
      }
      if (res.status === 202) {
        await res.body?.cancel().catch(() => {});
        return end;
      }
      if (res.status === 416) {
        // OneDrive has this range already (the reply to an earlier try was lost): ask where it is up to.
        await res.body?.cancel().catch(() => {});
        const status = await this.#fetch(uploadUrl, { signal: AbortSignal.timeout(30_000) });
        const next = ((await status.json().catch(() => ({}))) as { nextExpectedRanges?: string[] }).nextExpectedRanges?.[0];
        const resumeAt = Number(/^(\d+)-/.exec(next ?? '')?.[1]);
        if (Number.isFinite(resumeAt) && resumeAt > start) return Math.min(resumeAt, data.byteLength);
        throw new OneDriveError('OneDrive and the bot disagree about how much of the file has arrived', { status: 416 });
      }
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        await res.body?.cancel().catch(() => {});
        await this.#sleep(2 ** attempt * 1000);
        continue;
      }
      return this.#fail(res, 'a part of a file');
    }
  }

  async #ensureFolders(path: string): Promise<void> {
    const parts = graphPath(path).split('/').slice(0, -1);
    for (let i = 0; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/');
      const url = parent ? `${this.#graphUrl}/me/drive/special/approot:/${parent}:/children` : `${this.#graphUrl}/me/drive/special/approot/children`;
      const res = await this.#graph(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: decodeURIComponent(parts[i]!), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      });
      // 409: it is there already, which is what was wanted.
      if (!res.ok && res.status !== 409) return this.#fail(res, 'a folder');
      await res.body?.cancel().catch(() => {});
    }
  }
}

/**
 * OneDrive from the environment (ONEDRIVE_CLIENT_ID, ONEDRIVE_SCOPE), or nothing when no client id is set.
 * ONEDRIVE_LOGIN_URL and ONEDRIVE_GRAPH_URL point it at another server; they exist so the whole bot can be tried against a stand-in.
 */
export function oneDriveFromEnv(env: NodeJS.ProcessEnv, deps: { state: StateStore; fetch?: typeof fetch; log?: (line: string) => void }): OneDrive | undefined {
  const clientId = env.ONEDRIVE_CLIENT_ID?.trim();
  // Empty, or a word that means "not yet" (a host's settings page wants something typed in the box), is off.
  if (!clientId || /^(none|off|no|false|0|-|n\/a)$/i.test(clientId)) return undefined;
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error(`ONEDRIVE_CLIENT_ID should be the app's "Application (client) ID", a long id like 0a1b2c3d-… (got "${clientId}")`);
  return new OneDrive({ clientId, state: deps.state, ...(env.ONEDRIVE_SCOPE?.trim() ? { scope: env.ONEDRIVE_SCOPE.trim() } : {}), ...(env.ONEDRIVE_LOGIN_URL?.trim() ? { loginUrl: env.ONEDRIVE_LOGIN_URL.trim().replace(/\/+$/, '') } : {}), ...(env.ONEDRIVE_GRAPH_URL?.trim() ? { graphUrl: env.ONEDRIVE_GRAPH_URL.trim().replace(/\/+$/, '') } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.log ? { log: deps.log } : {}) });
}
