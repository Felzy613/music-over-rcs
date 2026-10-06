import { createSign, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Chip, Reply } from '../types.ts';

export const SCOPE_RBM = 'https://www.googleapis.com/auth/rcsbusinessmessaging';
export const SCOPE_BUSINESS_COMMUNICATIONS = 'https://www.googleapis.com/auth/businesscommunications';

const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const DEFAULT_TESTERS_URL = 'https://businesscommunications.googleapis.com/v1/testers';
const PHONE = /^\+[1-9]\d{6,14}$/;
const MAX_TEXT = 3072;
const MAX_CHIPS = 11;
const MAX_CHIP_LABEL = 25;
const REQUEST_TIMEOUT_MS = 15_000;

export class RbmError extends Error {
  status: number;
  body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'RbmError';
    this.status = status;
    this.body = body;
  }
}

export interface TokenProvider {
  token(scope: string): Promise<string>;
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface AuthOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

function signJwt(claims: Record<string, unknown>, privateKey: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
  return `${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
}

async function bodyOf(res: Response): Promise<string> {
  return (await res.text().catch(() => '')).slice(0, 500);
}

function assertPhone(phone: string): void {
  if (!PHONE.test(phone)) throw new TypeError('phone number must be in E.164 format, e.g. +15551234567');
}

/** Exchanges a Google service account key for short-lived OAuth access tokens (JWT bearer flow). */
export class ServiceAccountAuth implements TokenProvider {
  #key: ServiceAccountKey;
  #fetch: typeof fetch;
  #now: () => number;
  #cache = new Map<string, { token: string; expiresAt: number }>();
  #inflight = new Map<string, Promise<string>>();

  constructor(key: ServiceAccountKey, options: AuthOptions = {}) {
    this.#key = key;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  static fromFile(path: string, options?: AuthOptions): ServiceAccountAuth {
    const key = JSON.parse(readFileSync(path, 'utf8')) as Partial<ServiceAccountKey>;
    if (!key.client_email || !key.private_key) {
      throw new Error(`${path} is not a service account key (it has no client_email / private_key)`);
    }
    const { client_email, private_key, token_uri } = key;
    return new ServiceAccountAuth(token_uri ? { client_email, private_key, token_uri } : { client_email, private_key }, options);
  }

  token(scope: string): Promise<string> {
    const cached = this.#cache.get(scope);
    if (cached && cached.expiresAt - 60_000 > this.#now()) return Promise.resolve(cached.token);
    let pending = this.#inflight.get(scope);
    if (!pending) {
      pending = this.#refresh(scope).finally(() => this.#inflight.delete(scope));
      this.#inflight.set(scope, pending);
    }
    return pending;
  }

  async #refresh(scope: string): Promise<string> {
    const tokenUri = this.#key.token_uri ?? DEFAULT_TOKEN_URI;
    const issuedAt = Math.floor(this.#now() / 1000);
    const assertion = signJwt(
      { iss: this.#key.client_email, scope, aud: tokenUri, iat: issuedAt, exp: issuedAt + 3600 },
      this.#key.private_key,
    );
    const res = await this.#fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new RbmError(`Google OAuth token request failed (HTTP ${res.status})`, res.status, await bodyOf(res));
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new RbmError('Google OAuth response had no access_token', res.status, '');
    this.#cache.set(scope, { token: json.access_token, expiresAt: this.#now() + (json.expires_in ?? 3600) * 1000 });
    return json.access_token;
  }
}

export interface RbmClientOptions {
  agentId: string;
  auth: TokenProvider;
  region?: 'us' | 'europe' | 'asia';
  /** Replaces the regional API base URL (used by tests). */
  apiBase?: string;
  /** Replaces the tester-invite endpoint (used by tests). */
  testersUrl?: string;
  /** Sent as messageTrafficType, which Google requires for multi-use agents. */
  trafficType?: string | undefined;
  fetch?: typeof fetch;
}

/** The slice of the RCS for Business REST API this agent needs: messages, events and tester invites. */
export class RbmClient {
  #agentId: string;
  #auth: TokenProvider;
  #base: string;
  #testersUrl: string;
  #trafficType: string | undefined;
  #fetch: typeof fetch;

  constructor(options: RbmClientOptions) {
    this.#agentId = options.agentId;
    this.#auth = options.auth;
    const region = options.region ?? 'us';
    this.#base = (options.apiBase ?? `https://${region}-rcsbusinessmessaging.googleapis.com/v1`).replace(/\/+$/, '');
    this.#testersUrl = options.testersUrl ?? DEFAULT_TESTERS_URL;
    this.#trafficType = options.trafficType;
    this.#fetch = options.fetch ?? fetch;
  }

  async sendText(to: string, text: string, chips: Chip[] = []): Promise<void> {
    if (text.length > MAX_TEXT) throw new RangeError(`message text is ${text.length} characters; RCS allows ${MAX_TEXT}`);
    if (chips.length > MAX_CHIPS) throw new RangeError(`${chips.length} suggestion chips; RCS allows ${MAX_CHIPS}`);
    for (const chip of chips) {
      if (Array.from(chip.label).length > MAX_CHIP_LABEL) {
        throw new RangeError(`chip label "${chip.label}" is longer than ${MAX_CHIP_LABEL} characters`);
      }
    }
    const contentMessage: Record<string, unknown> = { text };
    if (chips.length > 0) {
      contentMessage.suggestions = chips.map((chip) => ({ reply: { text: chip.label, postbackData: chip.postback } }));
    }
    await this.#sendMessage(to, contentMessage);
  }

  /** Sends an audio file by public URL; Google fetches, caches and delivers it. Audio can't go in a rich card. */
  async sendAudio(to: string, fileUrl: string): Promise<void> {
    await this.#sendMessage(to, { contentInfo: { fileUrl, forceRefresh: false } });
  }

  /** Sends a picture by public URL (album art); Google fetches it like an audio file. */
  async sendImage(to: string, fileUrl: string): Promise<void> {
    await this.#sendMessage(to, { contentInfo: { fileUrl, forceRefresh: false } });
  }

  async send(to: string, reply: Reply): Promise<void> {
    if (reply.kind === 'audio') return this.sendAudio(to, reply.url);
    if (reply.kind === 'collage') return; // its songs are listed in the messages around it
    if (reply.kind === 'image') {
      // Google shows the cover; the song's name goes under it as text.
      await this.sendImage(to, reply.url);
      if (reply.caption) await this.sendText(to, `${reply.caption.artist ? `${reply.caption.artist} — ` : ''}${reply.caption.title}`);
      return;
    }
    return this.sendText(to, reply.text, reply.chips);
  }

  async sendEvent(to: string, eventType: 'IS_TYPING' | 'READ', messageId?: string): Promise<void> {
    assertPhone(to);
    const body = eventType === 'READ' && messageId ? { eventType, messageId } : { eventType };
    const query = new URLSearchParams({ eventId: randomUUID(), agentId: this.#agentId });
    await this.#post(`${this.#base}/phones/${to}/agentEvents?${query}`, SCOPE_RBM, body);
  }

  /** Invites a phone to be a tester of this (unlaunched) agent. Google allows 20 invites a day, 200 in total. */
  async inviteTester(phone: string): Promise<void> {
    assertPhone(phone);
    await this.#post(this.#testersUrl, SCOPE_BUSINESS_COMMUNICATIONS, { phone_number: phone, agentId: this.#agentId });
  }

  async #sendMessage(to: string, contentMessage: Record<string, unknown>): Promise<void> {
    assertPhone(to);
    const body: Record<string, unknown> = { contentMessage };
    if (this.#trafficType) body.messageTrafficType = this.#trafficType;
    const query = new URLSearchParams({ messageId: randomUUID(), agentId: this.#agentId });
    await this.#post(`${this.#base}/phones/${to}/agentMessages?${query}`, SCOPE_RBM, body);
  }

  async #post(url: string, scope: string, body: unknown): Promise<void> {
    const token = await this.#auth.token(scope);
    const res = await this.#fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const where = url.split('?')[0]!.replace(/\/phones\/\+\d+/, '/phones/+***');
      throw new RbmError(`RBM API answered HTTP ${res.status} for ${where}`, res.status, await bodyOf(res));
    }
    await res.body?.cancel().catch(() => {});
  }
}
