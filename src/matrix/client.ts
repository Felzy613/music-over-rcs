import { randomUUID } from 'node:crypto';
import type { DownloadedAudio } from '../audio-fetch.ts';
import type { DownloadedImage } from '../image-fetch.ts';
import type { ChatMessage, IncomingPicture } from '../runner.ts';

export const DEFAULT_HOMESERVER = 'http://127.0.0.1:8008';
const REQUEST_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 180_000;
const SENT_LIMIT = 500;
const MAX_RATE_LIMIT_WAIT_MS = 10_000;
/** The largest file from the phone that is downloaded (a picture for an add-on, say). */
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
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

/** One level of a protobuf message: each field's number and its value (a number, or bytes). Undefined if it isn't one. */
function protoFields(buf: Uint8Array): Array<{ field: number; value: bigint | Uint8Array }> | undefined {
  const out: Array<{ field: number; value: bigint | Uint8Array }> = [];
  let i = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const byte = buf[i++];
      if (byte === undefined || shift > 63n) throw new RangeError('truncated');
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
    }
  };
  try {
    while (i < buf.length) {
      const key = Number(varint());
      const field = key >> 3;
      const type = key & 7;
      if (field === 0) return undefined;
      if (type === 0) out.push({ field, value: varint() });
      else if (type === 2) {
        const length = Number(varint());
        if (i + length > buf.length) return undefined;
        out.push({ field, value: buf.subarray(i, i + length) });
        i += length;
      } else if (type === 1 || type === 5) i += type === 1 ? 8 : 4;
      else return undefined;
    }
  } catch {
    return undefined;
  }
  return out;
}

const protoMessage = (fields: ReturnType<typeof protoFields>, field: number) => {
  const value = fields?.find((entry) => entry.field === field)?.value;
  return value instanceof Uint8Array ? protoFields(value) : undefined;
};

/**
 * What the Google Messages bridge's copy of the original message (its raw_debug_data) says about a picture: whether
 * this is the full picture (its media has an id at Google) or only the preview posted while the phone was still
 * sending, and when it was sent (microseconds, in the message itself). Empty when the data isn't there or changes shape.
 */
export function gmessagesPictureFacts(raw: unknown): { complete?: boolean; sentAt?: number } {
  if (typeof raw !== 'string' || !raw) return {};
  const message = protoMessage(protoMessage(protoFields(Buffer.from(raw, 'base64')), 3), 2);
  if (!message) return {};
  const facts: { complete?: boolean; sentAt?: number } = {};
  const sent = message.find((entry) => entry.field === 5)?.value;
  if (typeof sent === 'bigint') {
    const ms = Number(sent / 1000n);
    if (ms > Date.UTC(2020, 0, 1) && ms < Date.now() + 86_400_000) facts.sentAt = ms;
  }
  for (const part of message.filter((entry) => entry.field === 10 && entry.value instanceof Uint8Array)) {
    const media = protoMessage(protoFields(part.value as Uint8Array), 3);
    if (!media?.some((entry) => entry.field === 14 || entry.field === 4)) continue;
    const id = media.find((entry) => entry.field === 2)?.value;
    facts.complete = id instanceof Uint8Array && id.length > 0;
  }
  return facts;
}

/**
 * A picture someone else posted (sent from the phone, through the bridge). The bridge posts a placeholder first and
 * then the picture as edits of it, a small preview and then the full one, so an edit carries the picture too; `of` is
 * the message they all belong to. Google Messages sends a picture's text with it: the caption is the body when the
 * file has its own name.
 */
function pictureIn(event: MatrixEvent, self: string | undefined): IncomingPicture | undefined {
  if (event.sender === self) return undefined;
  const relation = asRecord(event.content['m.relates_to']);
  const edit = relation?.rel_type === 'm.replace';
  const content = edit ? asRecord(event.content['m.new_content']) : event.content;
  const url = asString(content?.url);
  if (!content || content.msgtype !== 'm.image' || !url?.startsWith('mxc://')) return undefined;
  const body = asString(content.body) ?? '';
  const filename = asString(content.filename);
  const caption = filename && body && body !== filename ? body : undefined;
  const bytes = Number(dig(content, 'info', 'size')) || undefined;
  const facts = gmessagesPictureFacts(content['fi.mau.gmessages.raw_debug_data'] ?? event.content['fi.mau.gmessages.raw_debug_data']);
  return {
    url,
    mimeType: asString(dig(content, 'info', 'mimetype')) ?? 'image/jpeg',
    name: filename ?? (body || 'picture.jpg'),
    of: edit ? (asString(relation.event_id) ?? event.eventId) : event.eventId,
    sentAt: facts.sentAt ?? event.timestamp,
    ...(caption ? { caption } : {}),
    ...(bytes ? { bytes } : {}),
    ...(facts.complete === false ? { complete: false } : {}),
  };
}

/** A room message event as a ChatMessage; edits are not new messages, so they are skipped (unless they bring a picture). */
function toChatMessage(event: MatrixEvent, self?: string): ChatMessage | undefined {
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
  const picture = pictureIn(event, self);
  if (asRecord(event.content['m.relates_to'])?.rel_type === 'm.replace' && !picture) return undefined;
  const msgtype = asString(event.content.msgtype) ?? '';
  const media = MEDIA_TYPES.has(msgtype) || event.content.url !== undefined || event.content.file !== undefined;
  const body = asString(event.content.body);
  // "Phone has not confirmed message delivery" only means the phone is slow: the message usually arrives (its copy
  // shows up a moment later), so that notice is no reason to restart the bridge. Other reasons are.
  const notice = event.sender.startsWith('@gmessagesbot:') ? (body ?? '') : '';
  const bridgeSendFailure = /your message may not have been bridged:/i.test(notice) && !/phone has not confirmed message delivery/i.test(notice);
  return {
    id: event.eventId,
    timestamp: new Date(event.timestamp).toISOString(),
    text: body,
    type: msgtype === 'm.text' ? 'TEXT' : msgtype.toUpperCase() || undefined,
    hasAttachments: media || picture !== undefined,
    isDeleted: false,
    ...(bridgeSendFailure ? { bridgeSendFailure: true } : {}),
    ...(picture ? { picture } : {}),
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
  /** The bridge passes reactions on, so a 👍 on a song in a list can get it. */
  readonly reactions = true;

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
    const userId = asString(json.user_id) ?? '';
    if (userId) this.#userId = userId;
    return { userId };
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
    // Knowing who this is tells the phone's pictures from the bot's own.
    if (!this.#userId) await this.whoami();
    return (await this.#newEvents(roomID)).flatMap((event) => {
      const message = toChatMessage(event, this.#userId);
      return message ? [message] : [];
    });
  }

  /** Downloads a file posted in a room (an mxc:// address), up to 25 MB. */
  async downloadMedia(mxc: string): Promise<Uint8Array> {
    const match = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc);
    if (!match) throw new MatrixError(`Not a Matrix media address: ${mxc}`, 0, '', '');
    const res = await this.#fetch(`${this.#base}/_matrix/client/v1/media/download/${encodeURIComponent(match[1]!)}/${encodeURIComponent(match[2]!)}`, {
      headers: { authorization: `Bearer ${this.#token}` },
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      throw errorFrom(res.status, parseJson(text), text);
    }
    const size = Number(res.headers.get('content-length')) || 0;
    if (size > MAX_MEDIA_BYTES) throw new MatrixError(`The file is too big (${Math.round(size / 1048576)} MB)`, 0, '', '');
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_MEDIA_BYTES) throw new MatrixError(`The file is too big (${Math.round(bytes.byteLength / 1048576)} MB)`, 0, '', '');
    return bytes;
  }

  /** Puts a reaction (👍, ❤️ …) on a message; returns the reaction's id, which removes it again (redact). */
  async sendReaction(roomID: string, eventId: string, key: string): Promise<string | undefined> {
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomID)}/send/m.reaction/${randomUUID()}`;
    const json = await this.#request('PUT', path, { body: { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key } } });
    const id = asString(json.event_id);
    if (id) this.#remember(id);
    return id;
  }

  /** Takes back one of this account's events (a reaction, say). */
  async redact(roomID: string, eventId: string): Promise<void> {
    await this.#request('PUT', `/_matrix/client/v3/rooms/${encodeURIComponent(roomID)}/redact/${encodeURIComponent(eventId)}/${randomUUID()}`, { body: {} });
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

  /** What a message in a room says (its body), or undefined when it has none. Throws when the homeserver doesn't have it. */
  async messageText(roomID: string, eventId: string): Promise<string | undefined> {
    const json = await this.#request('GET', `/_matrix/client/v3/rooms/${encodeURIComponent(roomID)}/event/${encodeURIComponent(eventId)}`);
    return asString(dig(json, 'content', 'body'));
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
    if (eventId) this.#remember(eventId);
    return eventId;
  }

  /** An event this client sent, so it isn't read back as a new message. */
  #remember(eventId: string): void {
    this.#sent.add(eventId);
    if (this.#sent.size > SENT_LIMIT) this.#sent.delete(this.#sent.values().next().value!);
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
