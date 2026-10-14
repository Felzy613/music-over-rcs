import { acquire, r2LeaseStore, release, renew, type LeaseAnswer, type LeaseBucket } from './lease.ts';
import { runWatchdog, type WatchdogState } from './watchdog.ts';

// The Worker beside the bot (see cloudflare/README.md). Written against the few parts of the Workers API it uses, so it
// typechecks and is tested with the rest of the project and needs nothing installed until it is deployed.

/** The part of an R2 bucket this Worker uses. */
interface Bucket extends LeaseBucket {
  get(key: string): Promise<{ etag: string; text(): Promise<string> } | null>;
  put(key: string, value: string, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }): Promise<unknown | null>;
}

interface SendEmail {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface Env {
  STATE: Bucket;
  /** The Email Service binding (wrangler.jsonc `send_email`). Optional: NTFY_TOPIC can stand in. */
  EMAIL?: SendEmail;
  /** The shared secret the bot sends as `Authorization: Bearer …` to /lease and /alert. */
  EDGE_TOKEN: string;
  /** The Render service's address (https://….onrender.com), once there is one, and its ADMIN_TOKEN. */
  RENDER_URL?: string;
  RENDER_ADMIN_TOKEN?: string;
  /** Where alerts are emailed from (an address on a domain onboarded to Email Service) and to (a verified destination). */
  ALERT_FROM?: string;
  ALERT_TO?: string;
  /** A fallback: an ntfy.sh topic that alerts are posted to when there is no email binding. */
  NTFY_TOPIC?: string;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function sameToken(given: string | null, wanted: string | undefined): boolean {
  if (!given || !wanted) return false;
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(wanted);
  // Compared over the whole length either way, so the time taken doesn't say how much matched.
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** Sends an alert by email, or to ntfy when there is no email binding. Throws if neither is set up. */
export async function sendAlert(env: Env, title: string, message: string, doFetch: typeof fetch = fetch): Promise<void> {
  if (env.EMAIL && env.ALERT_FROM && env.ALERT_TO) {
    await env.EMAIL.send({ from: env.ALERT_FROM, to: env.ALERT_TO, subject: `[Music over RCS] ${title}`.slice(0, 200), text: message });
    return;
  }
  if (env.NTFY_TOPIC) {
    const res = await doFetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, { method: 'POST', headers: { title: title.slice(0, 200) }, body: message });
    if (!res.ok) throw new Error(`ntfy answered HTTP ${res.status}`);
    return;
  }
  throw new Error('no way to send alerts is set up (EMAIL with ALERT_FROM and ALERT_TO, or NTFY_TOPIC)');
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function handleRequest(request: Request, env: Env, now: number = Date.now(), doFetch: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/healthz') return new Response('ok');
  if (!sameToken(request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null, env.EDGE_TOKEN)) return json(401, { error: 'unauthorized' });

  if (request.method === 'GET' && url.pathname === '/status') {
    const object = await env.STATE.get('watchdog.json');
    return json(200, object ? JSON.parse(await object.text()) : {});
  }
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });

  const body = await readJson(request);
  if (url.pathname === '/alert') {
    const title = typeof body.title === 'string' && body.title ? body.title : 'Music over RCS';
    const message = typeof body.message === 'string' ? body.message.slice(0, 4000) : '';
    if (!message) return json(400, { error: 'message is required' });
    try {
      await sendAlert(env, title, message, doFetch);
      return json(200, { ok: true });
    } catch (err) {
      return json(502, { error: err instanceof Error ? err.message : 'could not send the alert' });
    }
  }

  const holder = typeof body.holder === 'string' ? body.holder.slice(0, 100) : '';
  const ttl = typeof body.ttlSeconds === 'number' ? body.ttlSeconds : undefined;
  const store = r2LeaseStore(env.STATE);
  if (url.pathname.startsWith('/lease/') && !holder) return json(400, { error: 'holder is required' });
  let answer: LeaseAnswer | { ok: boolean } | undefined;
  if (url.pathname === '/lease/acquire') answer = await acquire(store, holder, ttl, now);
  else if (url.pathname === '/lease/renew') answer = await renew(store, holder, ttl, now);
  else if (url.pathname === '/lease/release') answer = await release(store, holder);
  if (!answer) return json(404, { error: 'not found' });
  // 200 with ok:false, not an error status: "someone else has it" is an answer, not a failure.
  return json(200, answer);
}

/** Whether RENDER_URL is a real address yet (the Worker is deployed before the Render service exists, to learn its own address). */
export function renderConfigured(env: Env): boolean {
  try {
    const { protocol, hostname } = new URL(env.RENDER_URL ?? '');
    return (protocol === 'https:' || protocol === 'http:') && !/replace-me/i.test(hostname);
  } catch {
    return false;
  }
}

export async function runScheduled(env: Env, now: number = Date.now(), doFetch: typeof fetch = fetch): Promise<WatchdogState> {
  // Nothing to watch yet: not an outage, and nothing to email about.
  if (!renderConfigured(env)) return { failures: 0 };
  return runWatchdog({
    renderUrl: (env.RENDER_URL ?? '').replace(/\/+$/, ''),
    adminToken: env.RENDER_ADMIN_TOKEN,
    fetch: doFetch,
    now,
    async load() {
      const object = await env.STATE.get('watchdog.json');
      return object ? (JSON.parse(await object.text()) as WatchdogState) : undefined;
    },
    async save(state) {
      await env.STATE.put('watchdog.json', JSON.stringify(state));
    },
    async alert(title, message) {
      try {
        await sendAlert(env, title, message, doFetch);
      } catch (err) {
        console.error(`could not send an alert: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}

export default {
  fetch: (request: Request, env: Env) => handleRequest(request, env),
  scheduled: (_controller: unknown, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) => ctx.waitUntil(runScheduled(env)),
};
