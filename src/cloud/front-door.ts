import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FrontDoor {
  port: number;
  /** What the "starting up" page says is going on ("restoring the databases"). */
  setPhase(text: string): void;
  /** Closes the door and its connections. */
  close(): Promise<void>;
}

export interface FrontDoorOptions {
  port: number;
  host?: string;
  /** The bot's own web door (src/cloud-main.ts), on this machine only. */
  upstream: { port: number; host?: string };
  phase?: string;
  /** How long an upstream may stay silent, in either direction, before it is given up on (default 2 minutes). */
  idleMs?: number;
}

// What the proxy must not copy from one side to the other (RFC 9110 §7.6.1). (Requests also lose `expect`, which this door has
// already answered, and `host`, which is the bot's own.)
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade'];
const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } as const;

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Headers to pass on, without the ones named in `drop` (those that belong to a single connection). */
function passable(headers: IncomingHttpHeaders, drop: string[]): IncomingHttpHeaders {
  const copy: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (!drop.includes(name.toLowerCase())) copy[name] = value;
  return copy;
}

/**
 * The host's web door, open on the port Render watches from the first moment the container runs until it stops. Render sends
 * traffic to a new instance as soon as its port accepts a connection, and stops the old instance then; the new one then spends
 * a minute or so restoring its databases and starting its processes. With the door closed in that time every visitor got
 * Render's "Bad Gateway", and Render, finding the port refusing connections, restarted the instance it had just started. So the
 * port stays open here, for the whole life of the host:
 *
 * - `/healthz` is answered here (the host is alive), whatever the bot is doing;
 * - everything else is passed to the bot's own door on a port of its own, and while that door isn't open (the bot hasn't started,
 *   is restarting, or crashed) the answer is 503 with a "starting up" page that reloads itself, never a refused connection.
 *
 * The bot's door does its own password check; this passes the request and the answer through untouched, bodies streamed.
 */
export async function openFrontDoor(options: FrontDoorOptions): Promise<FrontDoor> {
  let phase = options.phase ?? 'starting';
  const upstreamHost = options.upstream.host ?? '127.0.0.1';
  const idleMs = options.idleMs ?? 120_000;

  const starting = (req: IncomingMessage, res: ServerResponse): void => {
    const head = { 'cache-control': 'no-store', 'retry-after': '5', 'x-content-type-options': 'nosniff' };
    const html = (req.headers.accept ?? '').includes('text/html');
    if (html) {
      res.writeHead(503, { ...head, 'content-type': 'text/html; charset=utf-8' });
      res.end(
        req.method === 'HEAD'
          ? undefined
          : `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Starting up</title>` +
              `<body style="font:16px system-ui,sans-serif;margin:16vh auto;max-width:28rem;padding:0 16px"><h1 style="font-size:1.3rem">Starting up</h1>` +
              `<p>The bot is starting (${escapeHtml(phase)}). This page tries again every few seconds, and a restart takes about a minute.</p>`,
      );
      return;
    }
    res.writeHead(503, { ...head, 'content-type': 'application/json; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error: 'starting', phase }));
  };

  const pass = (req: IncomingMessage, res: ServerResponse): void => {
    const upstream = request(
      {
        host: upstreamHost,
        port: options.upstream.port,
        method: req.method,
        path: req.url,
        headers: { ...passable(req.headers, [...HOP_BY_HOP, 'expect', 'host']), host: `${upstreamHost}:${options.upstream.port}` },
        timeout: idleMs,
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, passable(answer.headers, HOP_BY_HOP));
        answer.on('error', () => res.destroy());
        answer.pipe(res);
      },
    );
    // The bot isn't there (yet): the door says so politely. Once its answer has begun this is not the place to judge it: an answer
    // that really breaks off is caught on the answer itself, while one that is whole must not be cut short because the bot also
    // closed the connection on an upload it had already refused.
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      if (res.headersSent) return;
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH' || err.code === 'EPIPE') return starting(req, res);
      res.writeHead(504, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      res.end(JSON.stringify({ error: 'the bot is not answering' }));
    });
    upstream.on('timeout', () => upstream.destroy(new Error('timed out')));
    // A visitor who leaves takes the bot's half of the request with them.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  };

  const server = createServer((req, res) => {
    try {
      const path = new URL(req.url ?? '/', 'http://front').pathname;
      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
        return void res.end(req.method === 'HEAD' ? undefined : 'ok');
      }
      pass(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  // What Node does by default for a request it cannot read: a 400 and a closed connection.
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    setPhase: (text) => void (phase = text),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
