import { createServer, type IncomingMessage, type RequestListener, type ServerResponse } from 'node:http';
import { checkAudio, type AudioCheck } from './audio-check.ts';
import { createBot } from './bot.ts';
import { Catalog } from './catalog.ts';
import { loadConfig } from './config.ts';
import { createEventHandler } from './handler.ts';
import { RbmClient, ServiceAccountAuth } from './rbm/client.ts';
import { createWebhook, type Webhook } from './rbm/webhook.ts';

export const WEBHOOK_PATH = '/rbm/webhook';
const MAX_BODY_BYTES = 1_000_000;

export interface AppDeps {
  catalog: Pick<Catalog, 'search' | 'get'>;
  rbm: Pick<RbmClient, 'send' | 'sendEvent'>;
  clientToken: string;
  agentId?: string;
  allowedSenders?: ReadonlySet<string> | undefined;
  checkAudio?: (url: string) => Promise<AudioCheck>;
  log?: (line: string) => void;
}

export interface App {
  listener: RequestListener;
  webhook: Webhook;
}

function reply(res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...extra });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new RangeError('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createApp(deps: AppDeps): App {
  const log = deps.log ?? (() => {});
  const bot = createBot({ catalog: deps.catalog, checkAudio: deps.checkAudio ?? ((url) => checkAudio(url)) });
  const webhook = createWebhook({
    clientToken: deps.clientToken,
    onEvent: createEventHandler({
      bot,
      rbm: deps.rbm,
      ...(deps.agentId ? { agentId: deps.agentId } : {}),
      ...(deps.allowedSenders ? { allowedSenders: deps.allowedSenders } : {}),
      log,
    }),
    log,
  });

  const listener: RequestListener = async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/healthz') return reply(res, 200, 'ok');
      if (req.method === 'POST' && path === WEBHOOK_PATH) {
        const body = await readBody(req, MAX_BODY_BYTES);
        const out = await webhook.handle({ headers: req.headers, body });
        return reply(res, out.status, out.body);
      }
      reply(res, 404, 'not found');
    } catch (err) {
      if (err instanceof RangeError) return reply(res, 413, 'request body too large', { connection: 'close' });
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      reply(res, 500, 'internal error');
    }
  };

  return { listener, webhook };
}

/** Starts the agent from the environment (see .env.example). Exits with a readable message if it is misconfigured. */
export function main(): void {
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  try {
    const config = loadConfig();
    const catalog = new Catalog(config.dbPath);
    const rbm = new RbmClient({
      agentId: config.agentId,
      region: config.region,
      trafficType: config.trafficType,
      auth: ServiceAccountAuth.fromFile(config.keyPath),
    });
    const { listener, webhook } = createApp({
      catalog,
      rbm,
      clientToken: config.clientToken,
      agentId: config.agentId,
      allowedSenders: config.allowedSenders,
      log,
    });
    const server = createServer(listener);
    server.listen(config.port, () => {
      log(`listening on port ${config.port}, webhook at ${WEBHOOK_PATH}, ${catalog.count()} tracks in ${config.dbPath}`);
    });

    const shutdown = () => {
      log('shutting down');
      server.close();
      void webhook.idle().then(() => {
        catalog.close();
        process.exit(0);
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
