import { createVerify, generateKeyPairSync } from 'node:crypto';
import { listen, readText, type Listening } from './servers.ts';

export interface Captured {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface TokenRequest {
  claims: Record<string, unknown>;
  signatureValid: boolean;
}

export interface MockRbm extends Listening {
  requests: Captured[];
  tokenRequests: TokenRequest[];
  serviceAccountKey: { client_email: string; private_key: string; token_uri: string };
  /** Makes the next request matching `when` fail with `status`. */
  failNext(when: (request: Captured) => boolean, status: number, body?: string): void;
}

/** A stand-in for Google's OAuth token endpoint and the RBM / Business Communications REST APIs. */
export async function startMockRbm(): Promise<MockRbm> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const requests: Captured[] = [];
  const tokenRequests: TokenRequest[] = [];
  const failures: { when: (request: Captured) => boolean; status: number; body: string }[] = [];
  let issued = 0;

  const server = await listen(async (req, res) => {
    const raw = await readText(req);
    const url = new URL(req.url ?? '/', 'http://mock');

    if (url.pathname === '/token') {
      const [header, payload, signature] = (new URLSearchParams(raw).get('assertion') ?? '').split('.');
      const signatureValid = createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, Buffer.from(signature ?? '', 'base64url'));
      tokenRequests.push({
        claims: JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<string, unknown>,
        signatureValid,
      });
      if (!signatureValid) {
        res.writeHead(400).end('bad assertion');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: `tok-${++issued}`, expires_in: 3600, token_type: 'Bearer' }));
      return;
    }

    const captured: Captured = {
      method: req.method ?? '',
      path: url.pathname,
      query: url.searchParams,
      authorization: req.headers.authorization,
      body: raw ? JSON.parse(raw) : undefined,
    };
    requests.push(captured);
    if (!captured.authorization?.startsWith('Bearer tok-')) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const failure = failures.findIndex((candidate) => candidate.when(captured));
    if (failure >= 0) {
      const [rejected] = failures.splice(failure, 1);
      res.writeHead(rejected!.status, { 'content-type': 'application/json' }).end(rejected!.body);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });

  return {
    ...server,
    requests,
    tokenRequests,
    serviceAccountKey: {
      client_email: 'music-bot@example-project.iam.gserviceaccount.test',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      token_uri: `${server.url}/token`,
    },
    failNext(when, status, body = '{"error":"mock failure"}') {
      failures.push({ when, status, body });
    },
  };
}
