import type { Notify } from './health.ts';

const TIMEOUT_MS = 10_000;

/**
 * Sends each problem to a Worker that emails it (cloudflare/, POST /alert with a bearer token). It is the cloud
 * stand-in for the Mac's notifications: a bot running on a server has no screen, and the chat can't carry news of its own
 * breakdown. It never throws: a failed alert is lost, not a reason to stop the bot.
 */
export function remoteNotify(options: { url: string; token: string; fetch?: typeof fetch; log?: (line: string) => void }): Notify {
  const doFetch = options.fetch ?? fetch;
  return async (title, message) => {
    try {
      const res = await doFetch(options.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ title, message }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      if (!res.ok) options.log?.(`the alert service answered HTTP ${res.status}`);
    } catch (err) {
      options.log?.(`could not send an alert: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/** The alert sink named by ALERT_URL and ALERT_TOKEN, or undefined when ALERT_URL is not set. Throws on a bad setting. */
export function alertFromEnv(env: NodeJS.ProcessEnv = process.env, log?: (line: string) => void): Notify | undefined {
  const url = env.ALERT_URL?.trim();
  if (!url) return undefined;
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error(`ALERT_URL is not a valid URL (got "${url}")`);
  }
  if (protocol !== 'https:' && protocol !== 'http:') throw new Error(`ALERT_URL must be http(s) (got "${url}")`);
  const token = env.ALERT_TOKEN?.trim();
  if (!token) throw new Error('ALERT_URL is set but ALERT_TOKEN is not');
  return remoteNotify({ url, token, ...(log ? { log } : {}) });
}

/** Tells every sink; one that fails doesn't stop the others. */
export function allNotify(...sinks: Array<Notify | undefined>): Notify {
  const live = sinks.filter((sink): sink is Notify => sink !== undefined);
  return async (title, message) => {
    await Promise.all(live.map((sink) => sink(title, message).catch(() => {})));
  };
}
