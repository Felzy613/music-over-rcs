import type { Notify } from './health.ts';
import { s3FromEnv, type S3 } from './cloud/s3.ts';

/**
 * Leaves each problem in the R2 bucket's alerts/ folder, where the Cloudflare Worker mails it within five minutes
 * (cloudflare/index.ts). It is the cloud stand-in for the Mac's notifications: a bot on a server has no screen, and the chat
 * can't carry news of its own breakdown. It goes through the bucket rather than calling the Worker because Cloudflare
 * challenges every automated client on workers.dev. It never throws: a lost alert is not a reason to stop the bot.
 */
export function outboxNotify(options: { s3: Pick<S3, 'put'>; log?: (line: string) => void; now?: () => number; random?: () => string }): Notify {
  const now = options.now ?? Date.now;
  const random = options.random ?? (() => Math.random().toString(16).slice(2, 8));
  return async (title, message) => {
    const at = now();
    try {
      await options.s3.put(`alerts/${String(at).padStart(14, '0')}-${random()}.json`, JSON.stringify({ title, message, at }));
    } catch (err) {
      options.log?.(`could not leave an alert for the Worker: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

/** The alert outbox in the R2 bucket named by the R2_* settings, or nothing when they aren't set (on the Mac, say). */
export function alertFromEnv(env: NodeJS.ProcessEnv = process.env, log?: (line: string) => void): Notify | undefined {
  const s3 = s3FromEnv(env);
  return s3 ? outboxNotify({ s3, ...(log ? { log } : {}) }) : undefined;
}

/** Tells every sink; one that fails doesn't stop the others. */
export function allNotify(...sinks: Array<Notify | undefined>): Notify {
  const live = sinks.filter((sink): sink is Notify => sink !== undefined);
  return async (title, message) => {
    await Promise.all(live.map((sink) => sink(title, message).catch(() => {})));
  };
}
