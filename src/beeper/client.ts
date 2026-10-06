import type { DownloadedAudio } from '../audio-fetch.ts';
import type { DownloadedImage } from '../image-fetch.ts';

export const DEFAULT_BASE_URL = 'http://localhost:23373';
const REQUEST_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 180_000;

export class BeeperError extends Error {
  status: number;
  body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'BeeperError';
    this.status = status;
    this.body = body;
  }
}

/** The same shape the runner works with, whatever the chat platform. */
export type BeeperMessage = import('../runner.ts').ChatMessage;

export interface BeeperChat {
  id: string;
  title: string;
  network: string;
  accountID: string;
  type: string;
  participants: number;
  /** A one-person chat with yourself, which is where "message yourself" lives. */
  selfOnly: boolean;
}

export interface BeeperClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

function itemsOf(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const items = asRecord(data)?.items;
  return Array.isArray(items) ? items : [];
}

function toMessage(raw: unknown): BeeperMessage | undefined {
  const m = asRecord(raw);
  const id = asString(m?.id);
  if (!m || !id) return undefined;
  return {
    id,
    timestamp: asString(m.timestamp) ?? '',
    text: asString(m.text),
    type: asString(m.type),
    hasAttachments: Array.isArray(m.attachments) && m.attachments.length > 0,
    isDeleted: m.isDeleted === true,
  };
}

function toChat(raw: unknown): BeeperChat | undefined {
  const c = asRecord(raw);
  const id = asString(c?.id);
  if (!c || !id) return undefined;
  const people = itemsOf(c.participants);
  return {
    id,
    title: asString(c.title) ?? '',
    network: asString(c.network) ?? '',
    accountID: asString(c.accountID) ?? '',
    type: asString(c.type) ?? '',
    participants: people.length,
    selfOnly: c.type === 'single' && people.length > 0 && people.every((person) => asRecord(person)?.isSelf === true),
  };
}

/** The slice of the Beeper Desktop API (a local HTTP API) this project needs. */
export class BeeperClient {
  #token: string;
  #base: string;
  #fetch: typeof fetch;

  constructor(options: BeeperClientOptions) {
    this.#token = options.token;
    this.#base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  /** Throws if Beeper Desktop isn't reachable or the token is wrong. */
  async info(): Promise<void> {
    await this.#request('GET', '/v1/info');
  }

  async listChats(limit = 200): Promise<BeeperChat[]> {
    const data = await this.#request('GET', `/v1/chats?limit=${limit}`);
    return itemsOf(data)
      .map(toChat)
      .filter((chat): chat is BeeperChat => chat !== undefined);
  }

  /** The newest page of messages in a chat, oldest first. */
  async listMessages(chatID: string): Promise<BeeperMessage[]> {
    const data = await this.#request('GET', `/v1/chats/${encodeURIComponent(chatID)}/messages`);
    return itemsOf(data)
      .map(toMessage)
      .filter((message): message is BeeperMessage => message !== undefined)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async sendText(chatID: string, text: string): Promise<void> {
    await this.#send(chatID, { text });
  }

  /** Uploads the file, then sends it to the chat as an audio attachment. */
  async sendAudio(chatID: string, audio: DownloadedAudio): Promise<void> {
    await this.#sendAttachment(chatID, audio, 'audio');
  }

  /** Uploads the picture, then sends it to the chat as an image attachment. */
  async sendImage(chatID: string, image: DownloadedImage): Promise<void> {
    await this.#sendAttachment(chatID, image, 'image');
  }

  async #sendAttachment(chatID: string, file: { data: Blob; fileName: string; mimeType: string }, type: 'audio' | 'image'): Promise<void> {
    const form = new FormData();
    form.append('file', file.data, file.fileName);
    const upload = asRecord(await this.#request('POST', '/v1/assets/upload', form, {}, UPLOAD_TIMEOUT_MS));
    const uploadID = asString(upload?.uploadID);
    if (!uploadID) {
      const why = asString(upload?.error);
      throw new BeeperError(`Beeper did not accept the upload${why ? `: ${why}` : ''}`, 0, '');
    }
    await this.#send(chatID, {
      attachment: { uploadID, fileName: file.fileName, mimeType: file.mimeType, type },
    });
  }

  async #send(chatID: string, body: Record<string, unknown>): Promise<void> {
    await this.#request('POST', `/v1/chats/${encodeURIComponent(chatID)}/messages`, JSON.stringify(body), {
      'content-type': 'application/json',
    });
  }

  async #request(
    method: 'GET' | 'POST',
    path: string,
    body?: string | FormData,
    headers: Record<string, string> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#token}`, ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new BeeperError(
        `Beeper Desktop API answered HTTP ${res.status} for ${method} ${path.split('?')[0]}`,
        res.status,
        text.slice(0, 500),
      );
    }
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Turns an error from this client (or the network under it) into advice a person can act on. */
export function describeBeeperError(err: unknown, baseUrl = DEFAULT_BASE_URL): string {
  if (err instanceof BeeperError) {
    if (err.status === 401 || err.status === 403) {
      return `Beeper rejected the access token (HTTP ${err.status}). Create one in Beeper Desktop: Settings > Developers > Approved connections (+).`;
    }
    return err.body ? `${err.message}\n${err.body}` : err.message;
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return `Beeper Desktop at ${baseUrl} took too long to answer.`;
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return `Can't reach Beeper Desktop at ${baseUrl}. Is the app running, with the Desktop API enabled (Settings > Developers)?`;
  }
  return err instanceof Error ? err.message : String(err);
}
