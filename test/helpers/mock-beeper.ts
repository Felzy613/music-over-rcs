import { listen, readBuffer, type Listening } from './servers.ts';

export interface StoredMessage {
  id: string;
  senderID: string;
  isSender: boolean;
  text?: string;
  timestamp: string;
  sortKey: string;
  type: string;
  attachments?: unknown[];
}

export interface Upload {
  uploadID: string;
  fileName: string;
  mimeType: string;
  bytes: Buffer;
}

export interface SentMessage {
  text?: string;
  attachment?: { uploadID: string; fileName: string; mimeType: string; type: string };
}

export interface MockBeeper extends Listening {
  token: string;
  chatID: string;
  messages: StoredMessage[];
  uploads: Upload[];
  sent: SentMessage[];
  requests: { method: string; path: string }[];
  /** Junk appended to every message listing, to prove malformed entries are skipped. */
  extraItems: unknown[];
  failListing: boolean;
  /** The user typing into the chat on their phone. */
  addUserMessage(text: string): StoredMessage;
  /** Any other message, such as an attachment. */
  addRaw(message: { type: string; text?: string; attachments?: unknown[] }): StoredMessage;
  reset(): void;
}

interface Part {
  name: string;
  fileName?: string | undefined;
  mimeType?: string | undefined;
  data: Buffer;
}

function parseMultipart(body: Buffer, contentType: string): Part[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType);
  const token = boundary?.[1] ?? boundary?.[2];
  if (!token) return [];
  const delimiter = Buffer.from(`--${token}`);
  const parts: Part[] = [];
  let start = body.indexOf(delimiter);
  while (start !== -1) {
    const next = body.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    const part = body.subarray(start + delimiter.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const head = part.subarray(0, headerEnd).toString('utf8');
      parts.push({
        name: /name="([^"]*)"/.exec(head)?.[1] ?? '',
        fileName: /filename="([^"]*)"/.exec(head)?.[1],
        mimeType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim(),
        data: part.subarray(headerEnd + 4, part.length - 2),
      });
    }
    start = next;
  }
  return parts;
}

/**
 * A stand-in for the Beeper Desktop API (the local HTTP API). It behaves like a chat with yourself: whatever the
 * bot sends comes back in the message list as one more message from you, which is what the loop guard must survive.
 */
export async function startMockBeeper(chatID = '!self-chat:beeper.local'): Promise<MockBeeper> {
  const token = 'beeper-test-token';
  const messages: StoredMessage[] = [];
  const uploads: Upload[] = [];
  const sent: SentMessage[] = [];
  const requests: { method: string; path: string }[] = [];
  const extraItems: unknown[] = [];
  const state = { failListing: false };
  let counter = 0;

  const addMessage = (fields: { type: string; text?: string; attachments?: unknown[] }): StoredMessage => {
    counter++;
    const message: StoredMessage = {
      id: `m${counter}`,
      senderID: 'me',
      isSender: true,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString(),
      sortKey: String(counter).padStart(8, '0'),
      ...fields,
    };
    messages.push(message);
    return message;
  };

  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const body = await readBuffer(req);
    requests.push({ method: req.method ?? '', path: url.pathname });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };

    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorized' });

    if (req.method === 'GET' && url.pathname === '/v1/info') return json(200, { app: { name: 'Beeper Desktop' } });

    if (req.method === 'GET' && url.pathname === '/v1/chats') {
      return json(200, {
        hasMore: false,
        items: [
          {
            id: chatID,
            accountID: 'gmessages',
            title: 'Me',
            type: 'single',
            network: 'Google Messages',
            participants: { items: [{ id: 'me', isSelf: true }] },
          },
          {
            id: '!friend:beeper.local',
            accountID: 'gmessages',
            title: 'Alex',
            type: 'single',
            network: 'Google Messages',
            participants: { items: [{ id: 'me', isSelf: true }, { id: 'alex' }] },
          },
          {
            id: '!group:beeper.local',
            accountID: 'telegram',
            title: 'Group',
            type: 'group',
            network: 'Telegram',
            participants: { items: [{ isSelf: true }, {}, {}] },
          },
        ],
      });
    }

    const inChat = /^\/v1\/chats\/([^/]+)\/messages$/.exec(url.pathname);
    if (inChat && decodeURIComponent(inChat[1]!) === chatID) {
      if (req.method === 'GET') {
        if (state.failListing) return json(500, { error: 'listing is broken' });
        return json(200, { hasMore: false, items: [...messages].reverse().concat(extraItems as StoredMessage[]) });
      }
      if (req.method === 'POST') {
        const payload = JSON.parse(body.toString('utf8')) as SentMessage;
        sent.push(payload);
        if (payload.attachment) {
          addMessage({ type: 'AUDIO', attachments: [{ id: payload.attachment.uploadID, ...payload.attachment }] });
        } else {
          addMessage({ type: 'TEXT', text: payload.text ?? '' });
        }
        return json(200, { chatID, pendingMessageID: `pending-${counter}` });
      }
    }

    if (req.method === 'POST' && url.pathname === '/v1/assets/upload') {
      const file = parseMultipart(body, req.headers['content-type'] ?? '').find((part) => part.name === 'file');
      if (!file) return json(400, { error: 'no file part' });
      const upload: Upload = {
        uploadID: `up-${uploads.length + 1}`,
        fileName: file.fileName ?? '',
        mimeType: file.mimeType ?? '',
        bytes: Buffer.from(file.data),
      };
      uploads.push(upload);
      return json(200, {
        uploadID: upload.uploadID,
        fileName: upload.fileName,
        mimeType: upload.mimeType,
        fileSize: upload.bytes.length,
      });
    }

    json(404, { error: `no route for ${req.method} ${url.pathname}` });
  });

  return {
    ...server,
    token,
    chatID,
    messages,
    uploads,
    sent,
    requests,
    extraItems,
    get failListing() {
      return state.failListing;
    },
    set failListing(value: boolean) {
      state.failListing = value;
    },
    addUserMessage: (text) => addMessage({ type: 'TEXT', text }),
    addRaw: (message) => addMessage(message),
    reset() {
      messages.length = 0;
      uploads.length = 0;
      sent.length = 0;
      requests.length = 0;
      extraItems.length = 0;
      state.failListing = false;
    },
  };
}
