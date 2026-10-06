import { randomUUID } from 'node:crypto';
import type { DownloadedAudio } from '../audio-fetch.ts';
import type { DownloadedImage } from '../image-fetch.ts';
import type { ChatMessage } from '../runner.ts';

export const DEFAULT_HOMESERVER = 'http://127.0.0.1:8008';
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 180_000;
const SENT_LIMIT = 500;
const MAX_RATE_LIMIT_WAIT_MS = 10_000;
const MEDIA_TYPES = new Set(['m.image', 'm.video', 'm.audio', 'm.file', 'm.sticker']);

export class MatrixError extends Error {
  status: number;
  errcode: string;
  body: string;

  constructor(message: string, status: number, errcode: string, body: string) {
    super(message);
    this.name = 'MatrixError';
    this.status = status;
    this.errcode = errcode;
    this.body = body;
  }
}

export interface RoomSummary {
  id: string;
  name: string;
  members: number;
  /** Up to a few other members' IDs (for an invite: who invited you). */
  heroes: string[];
  invited: boolean;
}

/** A room message as the setup console shows it. */
export interface RoomEvent {
  id: string;
  sender: string;
  msgtype: string;
  body: string;
}

export interface MatrixClientOptions {
  token: string;
  homeserver?: string;
  fetch?: typeof fetch;
}

type Json = Record<string, unknown>;

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const asRecord = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Follows a path of keys through nested objects; undefined as soon as a step is missing. */
function dig(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const key of keys) {
    current = asRecord(current)?.[key];
    if (current === undefined) return undefined;
  }
  return current;
}

interface MatrixEvent {
  type: string;
  eventId: string;
  sender: string;
  timestamp: number;
  content: Json;
}

function toEvent(raw: unknown): MatrixEvent | undefined {
  const e = asRecord(raw);
  const type = asString(e?.type);
  if (!e || !type) return undefined;
  return {
    type,
    eventId: asString(e.event_id) ?? '',
    sender: asString(e.sender) ?? '',
    timestamp: Number(e.origin_server_ts) || 0,
    content: asRecord(e.content) ?? {},
  };
}

function eventsAt(value: unknown, ...keys: string[]): MatrixEvent[] {
  return asArray(dig(value, ...keys))
    .map(toEvent)
    .filter((event): event is MatrixEvent => event !== undefined);
}

/** A room message event as a ChatMessage; edits are not new messages, so they are skipped. */
function toChatMessage(event: MatrixEvent): ChatMessage | undefined {
  if (event.type === 'm.reaction' && event.eventId) {
    // A reaction tapped in Google Messages arrives from the bridge as an annotation on the message it's on.
    const relation = asRecord(event.content['m.relates_to']);
    const to = asString(relation?.event_id);
    const key = asString(relation?.key);
    if (relation?.rel_type !== 'm.annotation' || !to || !key) return undefined;
    return {
      id: event.eventId,
      timestamp: new Date(event.timestamp).toISOString(),
      type: 'REACTION',
      reaction: { to, key },
      hasAttachments: false,
      isDeleted: false,
    };
  }
  if (event.type !== 'm.room.message' || !event.eventId) return undefined;
  if (asRecord(event.content['m.relates_to'])?.rel_type === 'm.replace') return undefined;
  const msgtype = asString(event.content.msgtype) ?? '';
  const media = MEDIA_TYPES.has(msgtype) || event.content.url !== undefined || event.content.file !== undefined;
  return {
    id: event.eventId,
    timestamp: new Date(event.timestamp).toISOString(),
    text: asString(event.content.body),
    type: msgtype === 'm.text' ? 'TEXT' : msgtype.toUpperCase() || undefined,
    hasAttachments: media,
    isDeleted: false,
  };
}

function roomName(state: MatrixEvent[]): string {
  const named = state.find((event) => event.type === 'm.room.name');
  const alias = state.find((event) => event.type === 'm.room.canonical_alias');
  return asString(named?.content.name) ?? asString(alias?.content.alias) ?? '';
}

const timelineFilter = (roomID: string): string =>
  JSON.stringify({
    presence: { types: [] },
    account_data: { types: [] },
    room: {
      rooms: [roomID],
      timeline: { limit: 50, types: ['m.room.message', 'm.reaction'] },
      state: { types: [] },
      ephemeral: { types: [] },
      account_data: { types: [] },
    },
  });

const roomListFilter = JSON.stringify({
  presence: { types: [] },
  account_data: { types: [] },
  room: {
    timeline: { limit: 0 },
    ephemeral: { types: [] },
    account_data: { types: [] },
    state: { lazy_load_members: true, types: ['m.room.name', 'm.room.canonical_alias'] },
  },
});

/** How long the homeserver keeps showing "typing…" before it lapses on its own. */
const TYPING_TIMEOUT_MS = 30_000;

interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: Blob;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * A small Matrix client-server API client: just enough to read one room, write to it, and look around.
 * It never reads messages twice: listMessages() uses incremental sync, so it returns only what is new.
 */
export class MatrixClient {
  #base: string;
  #token: string;
  #fetch: typeof fetch;
  #since: string | undefined;
  #userId: string | undefined;
  #sent = new Set<string>();

  constructor(options: MatrixClientOptions) {
    this.#base = (options.homeserver ?? DEFAULT_HOMESERVER).replace(/\/+$/, '');
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  /** Signs in with a password and returns an access token. The password is sent once and never stored. */
  static async login(
    homeserver: string,
    user: string,
    password: string,
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ accessToken: string; userId: string }> {
    const res = await fetchImpl(`${homeserver.replace(/\/+$/, '')}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user },
        password,
        initial_device_display_name: 'Music over RCS',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok) throw errorFrom(res.status, json, text);
    const accessToken = asString(json.access_token);
    const userId = asString(json.user_id);
    if (!accessToken || !userId) throw new MatrixError('The homeserver did not return an access token', res.status, '', '');
    return { accessToken, userId };
  }

  async whoami(): Promise<{ userId: string }> {
    const json = await this.#request('GET', '/_matrix/client/v3/account/whoami');
    return { userId: asString(json.user_id) ?? '' };
  }

  /** Joins a room; this also accepts a pending invite (the bridge invites you to each chat it creates). */
  async joinRoom(roomID: string): Promise<void> {
    await this.#request('POST', `/_matrix/client/v3/join/${encodeURIComponent(roomID)}`, { body: {} });
  }

  async createDirectRoom(userID: string): Promise<string> {
    const json = await this.#request('POST', '/_matrix/client/v3/createRoom', {
      body: { is_direct: true, invite: [userID], preset: 'trusted_private_chat' },
    });
    return asString(json.room_id) ?? '';
  }

  /** Rooms you are in, and rooms you have been invited to, with their names. */
  async listRooms(): Promise<RoomSummary[]> {
    const data = await this.#request('GET', '/_matrix/client/v3/sync', {
      query: { filter: roomListFilter, timeout: '0' },
    });
    const rooms: RoomSummary[] = [];
    for (const [id, room] of Object.entries(asRecord(dig(data, 'rooms', 'join')) ?? {})) {
      const summary = asRecord(dig(room, 'summary'));
      rooms.push({
        id,
        name: roomName(eventsAt(room, 'state', 'events')),
        members: Number(summary?.['m.joined_member_count']) || 0,
        heroes: asArray(summary?.['m.heroes']).filter((hero): hero is string => typeof hero === 'string'),
        invited: false,
      });
    }
    for (const [id, room] of Object.entries(asRecord(dig(data, 'rooms', 'invite')) ?? {})) {
      const state = eventsAt(room, 'invite_state', 'events');
      const inviter = state.find((event) => event.type === 'm.room.member' && event.content.membership === 'invite');
      rooms.push({ id, name: roomName(state), members: 0, heroes: inviter ? [inviter.sender] : [], invited: true });
    }
    return rooms;
  }

  /** New messages in a room since the last call (the first call returns recent history), oldest first. */
  async listMessages(roomID: string): Promise<ChatMessage[]> {
    return (await this.#newEvents(roomID)).flatMap((event) => {
      const message = toChatMessage(event);
      return message ? [message] : [];
    });
  }

  /** Like listMessages, but as the setup console wants them: who said what, notices included. */
  async pollEvents(roomID: string): Promise<RoomEvent[]> {
    return (await this.#newEvents(roomID))
      .filter((event) => event.type === 'm.room.message' && event.eventId)
      .map((event) => ({
        id: event.eventId,
        sender: event.sender,
        msgtype: asString(event.content.msgtype) ?? '',
        body: asString(event.content.body) ?? '',
      }));
  }

  /** Posts a text; returns the new event's id. */
  async sendText(roomID: string, text: string): Promise<string | undefined> {
    return this.#sendMessage(roomID, { msgtype: 'm.text', body: text });
  }

  /**
   * Shows or clears "typing…" in a room as the signed-in user. The homeserver lets it lapse after `timeoutMs`,
   * so a long job has to repeat the call. The bridge passes it on to Google Messages.
   */
  async setTyping(roomID: string, typing: boolean, timeoutMs = TYPING_TIMEOUT_MS): Promise<void> {
    if (!this.#userId) this.#userId = (await this.whoami()).userId;
    if (!this.#userId) throw new MatrixError('The homeserver did not say who this access token belongs to', 0, '', '');
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomID)}/typing/${encodeURIComponent(this.#userId)}`;
    await this.#request('PUT', path, { body: typing ? { typing: true, timeout: timeoutMs } : { typing: false } });
  }

  /** Uploads the file to the homeserver, then posts it to the room as an audio message. */
  async sendAudio(roomID: string, audio: DownloadedAudio): Promise<string | undefined> {
    return this.#sendFile(roomID, 'm.audio', audio);
  }

  /** Uploads the picture to the homeserver, then posts it to the room as an image (the bridge sends it as a photo). */
  async sendImage(roomID: string, image: DownloadedImage): Promise<string | undefined> {
    return this.#sendFile(roomID, 'm.image', image);
  }

  async #sendFile(
    roomID: string,
    msgtype: 'm.audio' | 'm.image',
    file: { data: Blob; fileName: string; mimeType: string; bytes: number },
  ): Promise<string | undefined> {
    const upload = await this.#request('POST', '/_matrix/media/v3/upload', {
      query: { filename: file.fileName },
      rawBody: file.data,
      headers: { 'content-type': file.mimeType },
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    const url = asString(upload.content_uri);
    if (!url) throw new MatrixError('The homeserver did not return a content_uri for the upload', 0, '', '');
    return this.#sendMessage(roomID, {
      msgtype,
      body: file.fileName,
      filename: file.fileName,
      url,
      info: { mimetype: file.mimeType, size: file.bytes },
    });
  }

  async #newEvents(roomID: string): Promise<MatrixEvent[]> {
    const query: Record<string, string> = { filter: timelineFilter(roomID), timeout: '0' };
    if (this.#since) query.since = this.#since;
    const data = await this.#request('GET', '/_matrix/client/v3/sync', { query });
    // Only move the cursor once the response is in hand, so a failed call loses nothing.
    if (typeof data.next_batch === 'string') this.#since = data.next_batch;
    return eventsAt(data, 'rooms', 'join', roomID, 'timeline', 'events').filter((event) => !this.#sent.has(event.eventId));
  }

  async #sendMessage(roomID: string, content: Json): Promise<string | undefined> {
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomID)}/send/m.room.message/${randomUUID()}`;
    const json = await this.#request('PUT', path, { body: content });
    const eventId = asString(json.event_id);
    if (eventId) {
      this.#sent.add(eventId);
      if (this.#sent.size > SENT_LIMIT) this.#sent.delete(this.#sent.values().next().value!);
    }
    return eventId;
  }

  async #request(method: string, path: string, options: RequestOptions = {}): Promise<Json> {
    const query = options.query ? `?${new URLSearchParams(options.query)}` : '';
    for (let attempt = 0; ; attempt++) {
      const res = await this.#fetch(`${this.#base}${path}${query}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...options.headers,
        },
        body: options.rawBody ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      const json = parseJson(text);
      if (res.status === 429 && attempt < 2) {
        const wait = Math.min(Number(json.retry_after_ms) || 1000, MAX_RATE_LIMIT_WAIT_MS);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      if (!res.ok) throw errorFrom(res.status, json, text);
      return json;
    }
  }
}

function parseJson(text: string): Json {
  try {
    return asRecord(text ? JSON.parse(text) : {}) ?? {};
  } catch {
    return {};
  }
}

function errorFrom(status: number, json: Json, text: string): MatrixError {
  const errcode = asString(json.errcode) ?? '';
  const reason = asString(json.error) ?? '';
  return new MatrixError(`Homeserver answered HTTP ${status}${errcode ? ` ${errcode}` : ''}${reason ? `: ${reason}` : ''}`, status, errcode, text.slice(0, 500));
}

/** Turns an error from this client (or the network under it) into advice a person can act on. */
export function describeMatrixError(err: unknown, homeserver = DEFAULT_HOMESERVER): string {
  if (err instanceof MatrixError) {
    if (err.status === 401 || err.errcode === 'M_UNKNOWN_TOKEN') {
      return 'The homeserver rejected the access token. Run `npm run matrix-login` to get a new one.';
    }
    if (err.errcode === 'M_FORBIDDEN' && /invite|join/i.test(err.message)) {
      return `${err.message}\nThe bridge invites your account to each chat it creates; check the room ID with \`npm run matrix-rooms\`.`;
    }
    return err.message;
  }
  if (err instanceof Error && err.name === 'TimeoutError') return `The homeserver at ${homeserver} took too long to answer.`;
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return `Can't reach the Matrix homeserver at ${homeserver}. Is it running? (npm run homeserver)`;
  }
  return err instanceof Error ? err.message : String(err);
}
