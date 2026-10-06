import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

/** The decoded payload Google delivers for user messages and events (only the fields this agent reads). */
export interface UserEvent {
  agentId?: string;
  senderPhoneNumber?: string;
  messageId?: string;
  sendTime?: string;
  text?: string;
  suggestionResponse?: { postbackData?: string; text?: string };
  eventType?: string;
}

export interface Webhook {
  handle(req: WebhookRequest): Promise<WebhookResponse>;
  /** Resolves once every event accepted so far has finished processing (for tests and shutdown). */
  idle(): Promise<void>;
}

export interface WebhookOptions {
  clientToken: string;
  onEvent: (event: UserEvent) => Promise<void> | void;
  log?: (line: string) => void;
}

const respond = (status: number, body = ''): WebhookResponse => ({ status, body });

function header(headers: WebhookRequest['headers'], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Receives RCS for Business webhook calls (Cloud Pub/Sub push):
 *  - answers the one-time verification handshake by echoing the secret,
 *  - checks X-Goog-Signature (HMAC-SHA512 of the base64-decoded message.data, keyed by the client token),
 *  - acknowledges with 200 straight away and processes the event in the background, as Google requires.
 */
export function createWebhook(options: WebhookOptions): Webhook {
  const log = options.log ?? (() => {});
  const inflight = new Set<Promise<void>>();

  return {
    async handle(req) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body);
      } catch {
        return respond(400, 'invalid JSON');
      }
      if (typeof parsed !== 'object' || parsed === null) return respond(400, 'invalid body');
      const payload = parsed as Record<string, unknown>;

      const { clientToken, secret } = payload;
      const isVerification =
        header(req.headers, 'x-goog-webhook-type') === 'verification' ||
        (!('message' in payload) && typeof clientToken === 'string' && typeof secret === 'string');
      if (isVerification) {
        if (typeof clientToken !== 'string' || typeof secret !== 'string' || !safeEqual(clientToken, options.clientToken)) {
          log('webhook verification rejected: client token does not match RBM_CLIENT_TOKEN');
          return respond(403, 'client token mismatch');
        }
        log('webhook verification handshake answered');
        return respond(200, secret);
      }

      const data = (payload.message as { data?: unknown } | undefined)?.data;
      if (typeof data !== 'string') return respond(400, 'missing message.data');
      const decoded = Buffer.from(data, 'base64');
      const expected = createHmac('sha512', options.clientToken).update(decoded).digest();
      const signature = header(req.headers, 'x-goog-signature');
      const given = signature ? Buffer.from(signature, 'base64') : Buffer.alloc(0);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        log('rejected a webhook call with a missing or invalid signature');
        return respond(401, 'bad signature');
      }

      let event: unknown;
      try {
        event = JSON.parse(decoded.toString('utf8'));
      } catch {
        log('ignored a signed webhook call whose payload is not JSON');
        return respond(200);
      }
      if (typeof event !== 'object' || event === null) return respond(200);

      const task: Promise<void> = Promise.resolve()
        .then(() => options.onEvent(event as UserEvent))
        .catch((err: unknown) => log(`event handler failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => inflight.delete(task));
      inflight.add(task);
      return respond(200);
    },

    async idle() {
      await Promise.allSettled([...inflight]);
    },
  };
}
