import { listen, readBuffer, type Listening } from './servers.ts';

export interface MockRoom {
  id: string;
  name: string;
  members: number;
  heroes: string[];
}

export interface MockInvite {
  id: string;
  name: string;
  inviter: string;
}

export interface MockEvent {
  type: string;
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
}

export interface MockMatrix extends Listening {
  userId: string;
  /** Test-only credentials for the mock. */
  password: string;
  token: string;
  /** The room standing in for the "message yourself" chat. */
  roomId: string;
  /** A user the bridge makes up for you: where messages typed on your phone come from. */
  ghost: string;
  /** The direct chat with the bridge bot. */
  botRoomId: string;
  botUser: string;
  /** Everything in the watched room, oldest first. */
  events: MockEvent[];
  botEvents: MockEvent[];
  /** What the client posted through the send API (either room). */
  sent: { eventId: string; content: Record<string, any> }[];
  uploads: { mxc: string; fileName: string | null; contentType: string; bytes: Buffer }[];
  requests: { method: string; path: string }[];
  /** Every "typing…" call, with how many messages had been sent when it arrived. */
  typing: { roomId: string; userId: string; typing: boolean; timeout: number | undefined; afterSends: number }[];
  rooms: MockRoom[];
  invites: MockInvite[];
  joinedViaApi: string[];
  created: Record<string, any>[];
  /** Act like a bridge: re-post each text the client sends, from the ghost user, under a new event id. */
  echoAsGhost: boolean;
  /** The bridge bot answers every message sent to its room with a notice: "You said: ...". */
  botReplies: boolean;
  failSync: boolean;
  /** Typing calls are answered with a server error. */
  failTyping: boolean;
  /** The next `count` sends are answered with 429. */
  rateLimit(count: number): void;
  addMessage(sender: string, content: Record<string, unknown>, room?: string): string;
  /** A reaction (as the bridge passes on a 👍 tapped in Google Messages) to an event in the watched room. */
  addReaction(sender: string, eventId: string, key: string): string;
  /** A file the homeserver holds (a picture sent from the phone), for the media download API; returns its mxc:// address. */
  addMedia(bytes: Buffer, contentType: string): string;
  /** Reactions the client put on messages (send/m.reaction), and events it redacted. */
  reactionsSent: { eventId: string; to: string; key: string }[];
  redactions: string[];
  reset(): void;
}

/** A stand-in for a Matrix homeserver: login, whoami, sync, send, upload, join and createRoom. */
export async function startMockMatrix(): Promise<MockMatrix> {
  const userId = '@me:localhost';
  const password = 'mock-password-for-tests';
  const token = 'syt_mock_token';
  const roomId = '!portal:localhost';
  const ghost = '@gmessages_me:localhost';
  const botRoomId = '!dm-bot:localhost';
  const botUser = '@gmessagesbot:localhost';

  const events: MockEvent[] = [];
  const botEvents: MockEvent[] = [];
  const timelines = new Map<string, MockEvent[]>([
    [roomId, events],
    [botRoomId, botEvents],
  ]);
  const sent: MockMatrix['sent'] = [];
  const uploads: MockMatrix['uploads'] = [];
  const requests: MockMatrix['requests'] = [];
  const typing: MockMatrix['typing'] = [];
  const joinedViaApi: string[] = [];
  const created: Record<string, any>[] = [];
  const reactionsSent: MockMatrix['reactionsSent'] = [];
  const redactions: string[] = [];
  const media = new Map<string, { bytes: Buffer; contentType: string }>();
  const rooms: MockRoom[] = [
    { id: roomId, name: 'Me', members: 2, heroes: [ghost] },
    { id: botRoomId, name: '', members: 2, heroes: [botUser] },
  ];
  const invites: MockInvite[] = [{ id: '!invited:localhost', name: 'Alex', inviter: '@gmessages_alex:localhost' }];
  const state = { echoAsGhost: false, botReplies: false, failSync: false, failTyping: false, rateLimited: 0 };
  let counter = 0;

  const push = (sender: string, content: Record<string, unknown>, timeline: MockEvent[] = events, type = 'm.room.message'): MockEvent => {
    counter++;
    const event: MockEvent = {
      type,
      event_id: `$ev${counter}:localhost`,
      sender,
      origin_server_ts: 1_800_000_000_000 + counter * 1000,
      content,
    };
    timeline.push(event);
    return event;
  };

  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const body = await readBuffer(req);
    requests.push({ method: req.method ?? '', path: url.pathname });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };

    if (req.method === 'POST' && url.pathname === '/_matrix/client/v3/login') {
      const payload = JSON.parse(body.toString('utf8')) as { identifier?: { user?: string }; password?: string };
      if (payload.identifier?.user === 'me' && payload.password === password) {
        return json(200, { user_id: userId, access_token: token, device_id: 'MOCKDEVICE' });
      }
      return json(403, { errcode: 'M_FORBIDDEN', error: 'Invalid username or password' });
    }

    if (req.headers.authorization !== `Bearer ${token}`) {
      return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unrecognised access token' });
    }

    if (req.method === 'GET' && url.pathname === '/_matrix/client/v3/account/whoami') {
      return json(200, { user_id: userId, device_id: 'MOCKDEVICE' });
    }

    if (req.method === 'GET' && url.pathname === '/_matrix/client/v3/sync') {
      if (state.failSync) return json(500, { errcode: 'M_UNKNOWN', error: 'sync is broken' });
      const filter = JSON.parse(url.searchParams.get('filter') ?? '{}') as {
        room?: { rooms?: string[]; timeline?: { limit?: number } };
      };
      const watched = filter.room?.rooms;
      if (watched) {
        // The sync token is "<primary room length>.<bot room length>", so each room has its own cursor.
        const since = url.searchParams.get('since');
        const [sincePrimary = 0, sinceBot = 0] = since === null ? [] : since.split('.').map(Number);
        const limit = filter.room?.timeline?.limit ?? 50;
        const join: Record<string, unknown> = {};
        for (const id of watched) {
          const timeline = timelines.get(id);
          if (!timeline) continue;
          const offset = id === roomId ? sincePrimary : sinceBot;
          join[id] = { timeline: { events: since === null ? timeline.slice(-limit) : timeline.slice(offset), limited: false } };
        }
        return json(200, { next_batch: `${events.length}.${botEvents.length}`, rooms: { join } });
      }
      const join = Object.fromEntries(
        rooms.map((room) => [
          room.id,
          {
            state: {
              events: room.name
                ? [{ type: 'm.room.name', state_key: '', sender: '@someone:localhost', content: { name: room.name } }]
                : [],
            },
            summary: { 'm.heroes': room.heroes, 'm.joined_member_count': room.members },
            timeline: { events: [] },
          },
        ]),
      );
      const invite = Object.fromEntries(
        invites.map((entry) => [
          entry.id,
          {
            invite_state: {
              events: [
                { type: 'm.room.name', state_key: '', sender: entry.inviter, content: { name: entry.name } },
                { type: 'm.room.member', state_key: userId, sender: entry.inviter, content: { membership: 'invite' } },
              ],
            },
          },
        ]),
      );
      return json(200, { next_batch: 'listing', rooms: { join, invite } });
    }

    const send = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\/[^/]+$/.exec(url.pathname);
    if (req.method === 'PUT' && send) {
      const target = timelines.get(decodeURIComponent(send[1]!));
      if (!target) return json(403, { errcode: 'M_FORBIDDEN', error: 'You are not in that room' });
      if (state.rateLimited > 0) {
        state.rateLimited--;
        return json(429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: 10 });
      }
      const content = JSON.parse(body.toString('utf8')) as Record<string, any>;
      const event = push(userId, content, target);
      sent.push({ eventId: event.event_id, content });
      if (state.echoAsGhost && target === events && content.msgtype === 'm.text') push(ghost, content);
      if (state.botReplies && target === botEvents) {
        push(botUser, { msgtype: 'm.notice', body: `You said: ${String(content.body)}` }, botEvents);
      }
      return json(200, { event_id: event.event_id });
    }

    const lookup = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/event\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && lookup) {
      const event = timelines.get(decodeURIComponent(lookup[1]!))?.find((e) => e.event_id === decodeURIComponent(lookup[2]!));
      return event ? json(200, event) : json(404, { errcode: 'M_NOT_FOUND', error: 'Event not found.' });
    }

    const reaction = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.reaction\/[^/]+$/.exec(url.pathname);
    if (req.method === 'PUT' && reaction) {
      const target = timelines.get(decodeURIComponent(reaction[1]!));
      if (!target) return json(403, { errcode: 'M_FORBIDDEN', error: 'You are not in that room' });
      const content = JSON.parse(body.toString('utf8')) as Record<string, any>;
      const event = push(userId, content, target, 'm.reaction');
      reactionsSent.push({ eventId: event.event_id, to: content['m.relates_to']?.event_id, key: content['m.relates_to']?.key });
      return json(200, { event_id: event.event_id });
    }

    const redact = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/redact\/([^/]+)\/[^/]+$/.exec(url.pathname);
    if (req.method === 'PUT' && redact) {
      redactions.push(decodeURIComponent(redact[2]!));
      return json(200, { event_id: `$redaction${redactions.length}:localhost` });
    }

    const download = /^\/_matrix\/client\/v1\/media\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && download) {
      const file = media.get(`mxc://${decodeURIComponent(download[1]!)}/${decodeURIComponent(download[2]!)}`);
      if (!file) return json(404, { errcode: 'M_NOT_FOUND', error: 'Not found' });
      res.writeHead(200, { 'content-type': file.contentType, 'content-length': String(file.bytes.length) });
      return res.end(file.bytes);
    }

    const typingCall = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/typing\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'PUT' && typingCall) {
      if (state.failTyping) return json(500, { errcode: 'M_UNKNOWN', error: 'typing is broken' });
      const payload = JSON.parse(body.toString('utf8')) as { typing?: boolean; timeout?: number };
      typing.push({
        roomId: decodeURIComponent(typingCall[1]!),
        userId: decodeURIComponent(typingCall[2]!),
        typing: payload.typing === true,
        timeout: payload.timeout,
        afterSends: sent.length,
      });
      return json(200, {});
    }

    if (req.method === 'POST' && url.pathname === '/_matrix/media/v3/upload') {
      const mxc = `mxc://localhost/media${uploads.length + 1}`;
      uploads.push({
        mxc,
        fileName: url.searchParams.get('filename'),
        contentType: String(req.headers['content-type'] ?? ''),
        bytes: Buffer.from(body),
      });
      return json(200, { content_uri: mxc });
    }

    const join = /^\/_matrix\/client\/v3\/join\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && join) {
      const id = decodeURIComponent(join[1]!);
      const known = rooms.some((room) => room.id === id) || invites.some((entry) => entry.id === id);
      if (!known) return json(403, { errcode: 'M_FORBIDDEN', error: 'You are not invited to this room.' });
      joinedViaApi.push(id);
      return json(200, { room_id: id });
    }

    if (req.method === 'POST' && url.pathname === '/_matrix/client/v3/createRoom') {
      created.push(JSON.parse(body.toString('utf8')) as Record<string, any>);
      return json(200, { room_id: '!dm-new:localhost' });
    }

    json(404, { errcode: 'M_UNRECOGNIZED', error: `no route for ${req.method} ${url.pathname}` });
  });

  return {
    ...server,
    userId,
    password,
    token,
    roomId,
    ghost,
    botRoomId,
    botUser,
    events,
    botEvents,
    sent,
    uploads,
    requests,
    typing,
    rooms,
    invites,
    joinedViaApi,
    created,
    get echoAsGhost() {
      return state.echoAsGhost;
    },
    set echoAsGhost(value: boolean) {
      state.echoAsGhost = value;
    },
    get botReplies() {
      return state.botReplies;
    },
    set botReplies(value: boolean) {
      state.botReplies = value;
    },
    get failSync() {
      return state.failSync;
    },
    set failSync(value: boolean) {
      state.failSync = value;
    },
    get failTyping() {
      return state.failTyping;
    },
    set failTyping(value: boolean) {
      state.failTyping = value;
    },
    rateLimit(count) {
      state.rateLimited = count;
    },
    addMessage: (sender, content, room = roomId) => push(sender, content, timelines.get(room) ?? events).event_id,
    addReaction: (sender, eventId, key) => push(sender, { 'm.relates_to': { rel_type: 'm.annotation', event_id: eventId, key } }, events, 'm.reaction').event_id,
    addMedia(bytes, contentType) {
      const mxc = `mxc://localhost/phone${media.size + 1}`;
      media.set(mxc, { bytes, contentType });
      return mxc;
    },
    reactionsSent,
    redactions,
    reset() {
      reactionsSent.length = 0;
      redactions.length = 0;
      media.clear();
      events.length = 0;
      botEvents.length = 0;
      sent.length = 0;
      uploads.length = 0;
      requests.length = 0;
      typing.length = 0;
      joinedViaApi.length = 0;
      created.length = 0;
      state.echoAsGhost = false;
      state.botReplies = false;
      state.failSync = false;
      state.failTyping = false;
      state.rateLimited = 0;
    },
  };
}
