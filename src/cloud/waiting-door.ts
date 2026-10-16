import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LeaseState } from './supervise.ts';

export interface WaitingDoor {
  port: number;
  /** Closes the door and its connections; resolves once the port is free for the real door. */
  close(): Promise<void>;
}

/**
 * The door the host keeps open on the web port while it waits for the lease. On a deploy Render starts the new instance beside
 * the old one and stops the old one only once the new one has opened its port, and the old one's stopping is what lets go of the
 * lease: without this the newcomer would wait for a lease its predecessor cannot give up until the newcomer is "up". Everything
 * answers 503 except /healthz (the host is alive, and waiting), so nothing mistakes it for the bot, and /ping says 503 too.
 * It closes before the real door opens on the same port.
 */
export async function openWaitingDoor(options: { port: number; host?: string }): Promise<WaitingDoor> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://waiting').pathname;
    const healthz = path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD');
    res.writeHead(healthz ? 200 : 503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...(healthz ? {} : { 'retry-after': '10' }) });
    res.end(req.method === 'HEAD' ? undefined : healthz ? 'ok' : 'starting: waiting for the previous instance to let go');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface Leasing {
  holder: string;
  acquire(options?: { sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; onWaiting?: () => void }): Promise<void>;
  renew(): Promise<LeaseState>;
  release(): Promise<void>;
}

/**
 * The same lease, but with the waiting door open on the web port for as long as `acquire` has to wait, and closed again (before
 * it returns) once the lease is taken. With the lease free there is no wait and no door, so a first start behaves as it always did.
 * A door that cannot open (the port is taken) is logged and the wait goes on without it.
 */
export function withWaitingDoor(lease: Leasing, options: { port: number; host?: string; log: (line: string) => void; open?: typeof openWaitingDoor }): Leasing {
  const open = options.open ?? openWaitingDoor;
  return {
    holder: lease.holder,
    async acquire(acquireOptions = {}) {
      let door: Promise<WaitingDoor | undefined> | undefined;
      try {
        await lease.acquire({
          ...acquireOptions,
          onWaiting: () => {
            acquireOptions.onWaiting?.();
            door ??= open({ port: options.port, ...(options.host ? { host: options.host } : {}) }).then(
              (opened) => {
                options.log(`waiting for the lease, and answering on port ${opened.port} meanwhile`);
                return opened;
              },
              (err: unknown) => {
                options.log(`could not open the waiting door: ${err instanceof Error ? err.message : String(err)}`);
                return undefined;
              },
            );
          },
        });
      } finally {
        await (await door)?.close();
      }
    },
    renew: () => lease.renew(),
    release: () => lease.release(),
  };
}
