import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeS3Server {
  /** The address to give as R2_ENDPOINT (the bucket name follows it in the path). */
  url: string;
  objects: Map<string, { body: string; etag: string }>;
  /** Keys that answer HTTP 500 to every request. */
  unreadable: Set<string>;
  /** Every request made, as `METHOD key`. */
  requests: string[];
  close(): Promise<void>;
}

/**
 * A bucket over HTTP on this machine, for running the real host's programs against: objects with ETags, If-Match and If-None-Match as R2
 * does them, and an empty listing. Signatures are not checked. Nothing here reaches the network.
 */
export async function startFakeS3(): Promise<FakeS3Server> {
  const objects = new Map<string, { body: string; etag: string }>();
  const unreadable = new Set<string>();
  const requests: string[] = [];
  let n = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const key = decodeURIComponent((req.url ?? '').split('?')[0]!.split('/').slice(2).join('/'));
      requests.push(`${req.method} ${key}`);
      const current = objects.get(key);
      if (unreadable.has(key)) {
        res.writeHead(500);
        return void res.end('<Error><Code>InternalError</Code></Error>');
      }
      if (req.method === 'PUT') {
        if (req.headers['if-none-match'] === '*' && current) return void res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>');
        if (typeof req.headers['if-match'] === 'string' && current?.etag !== req.headers['if-match']) return void res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>');
        const etag = `"e${++n}"`;
        objects.set(key, { body: Buffer.concat(chunks).toString('utf8'), etag });
        return void res.writeHead(200, { etag }).end();
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return void res.writeHead(204).end();
      }
      if (req.method === 'GET' && key === '') return void res.writeHead(200, { 'content-type': 'application/xml' }).end('<ListBucketResult></ListBucketResult>');
      if (req.method === 'GET' && current) return void res.writeHead(200, { etag: current.etag }).end(current.body);
      res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    objects,
    unreadable,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
