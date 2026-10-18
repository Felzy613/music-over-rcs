import { runWatchdog, type WatchdogState } from './watchdog.ts';
import { handleRelayRequest, sweepRelay } from './youtube.ts';

// The Worker beside the bot (see cloudflare/README.md). It has no way in from outside on purpose: Cloudflare puts a bot
// challenge in front of every automated client on workers.dev, so the cloud host could not call it. Instead both of them
// meet in the R2 bucket. Every five minutes this Worker (1) mails any alerts the bot has left in the bucket's alerts/
// folder, and (2) checks that the host answers, which also keeps Render's free service from going to sleep. And (3) when
// the host leaves a song request in yt/req/ (YouTube turns the host's address away), R2 tells it through the mors-yt
// queue and it fetches the song from YouTube Music on Cloudflare's network (cloudflare/youtube.ts).
// Written against the few Workers APIs it uses, so it typechecks and is tested with the rest of the project.

/** The part of an R2 bucket binding this Worker uses. */
interface Bucket {
  get(key: string): Promise<{ etag: string; text(): Promise<string> } | null>;
  put(key: string, value: string | ReadableStream | ArrayBuffer): Promise<unknown>;
  list(options: { prefix: string; limit?: number }): Promise<{ objects: Array<{ key: string; uploaded?: Date }> }>;
  delete(key: string): Promise<void>;
}

interface SendEmail {
  send(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface Env {
  STATE: Bucket;
  /** The Email Service binding (wrangler.jsonc `send_email`). Optional: NTFY_TOPIC can stand in. */
  EMAIL?: SendEmail;
  /** The Render service's address (https://….onrender.com), once there is one, and its ADMIN_TOKEN. All of these are secrets. */
  RENDER_URL?: string;
  RENDER_ADMIN_TOKEN?: string;
  /** Where alerts are emailed from (an address on a domain onboarded to Email Service) and to (a verified destination). */
  ALERT_FROM?: string;
  ALERT_TO?: string;
  /** A fallback: an ntfy.sh topic that alerts are posted to when there is no email binding. */
  NTFY_TOPIC?: string;
}

/** Alerts older than this are dropped instead of sent: news from yesterday is not news. */
export const ALERT_MAX_AGE_MS = 24 * 60 * 60_000;
/** The most alerts mailed in one round, so a runaway bot can't flood an inbox. */
export const ALERTS_PER_ROUND = 10;

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

/** Whether RENDER_URL is a real address yet (the Worker is deployed before the Render service exists). */
export function renderConfigured(env: Env): boolean {
  try {
    const { protocol, hostname } = new URL(env.RENDER_URL ?? '');
    return (protocol === 'https:' || protocol === 'http:') && !/replace-me/i.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Mails the alerts the bot left in alerts/ and removes each once sent. One that can't be sent now stays for the next round
 * (until it is a day old); one that isn't readable is removed.
 */
export async function sendOutbox(env: Env, now: number = Date.now(), doFetch: typeof fetch = fetch): Promise<{ sent: number; waiting: number; dropped: number }> {
  const result = { sent: 0, waiting: 0, dropped: 0 };
  const { objects } = await env.STATE.list({ prefix: 'alerts/', limit: 100 });
  for (const { key } of objects.sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const object = await env.STATE.get(key);
    if (!object) continue;
    let alert: { title?: unknown; message?: unknown; at?: unknown } = {};
    try {
      alert = JSON.parse(await object.text());
    } catch {
      // unreadable: removed below
    }
    const message = typeof alert.message === 'string' ? alert.message : '';
    const at = typeof alert.at === 'number' ? alert.at : now;
    if (!message || now - at > ALERT_MAX_AGE_MS) {
      await env.STATE.delete(key);
      result.dropped += 1;
      continue;
    }
    if (result.sent >= ALERTS_PER_ROUND) {
      result.waiting += 1;
      continue;
    }
    try {
      await sendAlert(env, typeof alert.title === 'string' && alert.title ? alert.title : 'Music over RCS', message, doFetch);
      await env.STATE.delete(key);
      result.sent += 1;
    } catch (err) {
      console.error(`could not send an alert: ${err instanceof Error ? err.message : String(err)}`);
      result.waiting += 1;
    }
  }
  return result;
}

/** One round of the five-minute job: mail what is waiting, then check the host. */
export async function runScheduled(env: Env, now: number = Date.now(), doFetch: typeof fetch = fetch): Promise<WatchdogState> {
  try {
    await sendOutbox(env, now, doFetch);
  } catch (err) {
    console.error(`could not look at the alerts: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await sweepRelay(env.STATE, now);
  } catch (err) {
    console.error(`could not tidy the YouTube relay's leftovers: ${err instanceof Error ? err.message : String(err)}`);
  }
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

/** One delivery from the mors-yt queue: R2's notices of requests the host left in yt/req/, each answered in turn. */
export async function runQueue(
  batch: { messages: Array<{ body: unknown; ack(): void }> },
  env: Env,
  doFetch: typeof fetch = (input, init) => fetch(input, init),
): Promise<void> {
  for (const message of batch.messages) {
    const key = (message.body as { object?: { key?: unknown } } | null)?.object?.key;
    if (typeof key === 'string') await handleRelayRequest(key, { bucket: env.STATE, fetch: doFetch, log: (line) => console.log(line) });
    message.ack();
  }
}

export default {
  // Nothing is served: there is no way in, and none is needed.
  fetch: () => new Response('ok'),
  scheduled: (_controller: unknown, env: Env, ctx: { waitUntil(promise: Promise<unknown>): void }) => ctx.waitUntil(runScheduled(env)),
  queue: (batch: { messages: Array<{ body: unknown; ack(): void }> }, env: Env) => runQueue(batch, env),
};
