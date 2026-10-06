import { createHmac } from 'node:crypto';

/** Builds a webhook call the way Cloud Pub/Sub push delivers it: a signed base64 payload in a JSON envelope. */
export function signedRaw(clientToken: string, payload: string, type = 'message_callback') {
  const data = Buffer.from(payload).toString('base64');
  const signature = createHmac('sha512', clientToken).update(Buffer.from(data, 'base64')).digest('base64');
  return {
    headers: { 'content-type': 'application/json', 'x-goog-webhook-type': type, 'x-goog-signature': signature },
    body: JSON.stringify({
      message: { data, messageId: '1', publishTime: '2026-01-01T00:00:00Z' },
      subscription: 'projects/example/subscriptions/test',
    }),
  };
}

export function signedCall(clientToken: string, event: unknown, type?: string) {
  return signedRaw(clientToken, JSON.stringify(event), type);
}
