import { createHash, createHmac } from 'node:crypto';

// A small S3 client for the one bucket this project keeps in Cloudflare R2: read, write (optionally only if the object is
// unchanged), list and delete small objects. It exists because the cloud host cannot call a Worker over HTTP (Cloudflare
// challenges every automated client on workers.dev) but can always reach R2's S3 address with the keys it already has for the
// database backups. Requests are signed with AWS Signature Version 4. No dependencies.

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding, as AWS wants it (encodeURIComponent leaves ! ' ( ) * alone). */
const encode = (text: string): string => encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  /** The full URL, with its query. */
  url: string;
  /** Headers to send; the ones named in `sign` are signed. `host` and `x-amz-date` are added. */
  headers?: Record<string, string>;
  /** The names (lower case) of the headers to sign besides host and x-amz-date. */
  sign?: string[];
  /** The hex SHA-256 of the body ('' hashes the empty body). */
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  date: Date;
}

/** The headers to send for a signed request: the ones given, plus host, x-amz-date and Authorization. */
export function signRequest(input: SignInput): Record<string, string> {
  const url = new URL(input.url);
  const amzDate = input.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])), host: url.host, 'x-amz-date': amzDate };
  const signed = [...new Set(['host', 'x-amz-date', ...(input.sign ?? [])])].sort();
  const canonicalHeaders = signed.map((name) => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const query = [...url.searchParams.entries()].map(([k, v]) => [encode(k), encode(v)] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const path = url.pathname.split('/').map((part) => encode(decodeURIComponent(part))).join('/');
  const canonicalRequest = [input.method.toUpperCase(), path || '/', query, canonicalHeaders, signed.join(';'), input.payloadHash].join('\n');
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${signature}`;
  return headers;
}

export class S3Error extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
  }
}

export interface S3Options {
  /** https://<account id>.r2.cloudflarestorage.com */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Told, in a line, about a conditional write R2 refused (rare, and worth knowing the reason for). */
  log?: (line: string) => void;
}

/** Only write if the object is as it was: a specific ETag, or `'*'`-style "does not exist yet". */
export interface WriteCondition {
  ifMatch?: string;
  ifNoneMatch?: '*';
}

/** An ETag for If-Match: a weak one (W/"x", which a proxy that compresses a response turns a strong one into) never matches there. */
const strongETag = (etag: string): string => etag.replace(/^W\//, '');

export class S3 {
  #options: S3Options;
  #fetch: typeof fetch;

  constructor(options: S3Options) {
    this.#options = { ...options, endpoint: options.endpoint.replace(/\/+$/, '') };
    this.#fetch = options.fetch ?? fetch;
  }

  async #send(method: string, key: string, init: { query?: Record<string, string>; body?: string | Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    const { endpoint, bucket } = this.#options;
    const query = init.query ? `?${new URLSearchParams(init.query)}` : '';
    const url = `${endpoint}/${bucket}${key ? `/${key.split('/').map(encode).join('/')}` : ''}${query}`;
    const body = init.body ?? '';
    const payloadHash = sha256(body);
    const headers = signRequest({
      method,
      url,
      // identity: ask for the object as stored, so its ETag comes back strong and usable in If-Match.
      headers: { 'x-amz-content-sha256': payloadHash, 'accept-encoding': 'identity', ...init.headers },
      sign: ['x-amz-content-sha256'],
      payloadHash,
      accessKeyId: this.#options.accessKeyId,
      secretAccessKey: this.#options.secretAccessKey,
      region: this.#options.region ?? 'auto',
      service: 's3',
      date: this.#options.now?.() ?? new Date(),
    });
    return this.#fetch(url, { method, headers, ...(init.body === undefined ? {} : { body: init.body as string | Uint8Array }), signal: AbortSignal.timeout(30_000) });
  }

  async #fail(res: Response, doing: string): Promise<never> {
    const text = await res.text().catch(() => '');
    const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? '';
    throw new S3Error(`R2 refused ${doing} (HTTP ${res.status}${code ? ` ${code}` : ''})`, res.status);
  }

  /** An object's text and ETag, or nothing when it doesn't exist. */
  async get(key: string): Promise<{ text: string; etag: string } | undefined> {
    const res = await this.#send('GET', key);
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return undefined;
    }
    if (!res.ok) return this.#fail(res, `reading ${key}`);
    return { text: await res.text(), etag: strongETag(res.headers.get('etag') ?? '') };
  }

  /** Writes an object. With a condition, returns false (and writes nothing) when it isn't met; otherwise true with the new ETag. */
  async put(key: string, body: string | Uint8Array, condition: WriteCondition = {}): Promise<{ ok: true; etag: string } | { ok: false }> {
    const headers: Record<string, string> = {};
    if (condition.ifMatch !== undefined) headers['if-match'] = strongETag(condition.ifMatch);
    if (condition.ifNoneMatch) headers['if-none-match'] = condition.ifNoneMatch;
    const res = await this.#send('PUT', key, { body, headers });
    // 412: the condition failed. 409: another write to the same object was in flight (R2's "conditional request conflict").
    if (res.status === 412 || res.status === 409) {
      const code = /<Code>([^<]*)<\/Code>/.exec(await res.text().catch(() => ''))?.[1] ?? '';
      this.#options.log?.(`[s3] ${key}: the write was refused (HTTP ${res.status}${code ? ` ${code}` : ''}; sent ${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join(', ') || 'no condition'})`);
      return { ok: false };
    }
    if (!res.ok) return this.#fail(res, `writing ${key}`);
    await res.body?.cancel().catch(() => {});
    return { ok: true, etag: res.headers.get('etag') ?? '' };
  }

  async delete(key: string): Promise<void> {
    const res = await this.#send('DELETE', key);
    if (!res.ok && res.status !== 404) return this.#fail(res, `deleting ${key}`);
    await res.body?.cancel().catch(() => {});
  }

  /** The keys that start with a prefix (the first thousand). */
  async list(prefix: string): Promise<string[]> {
    const res = await this.#send('GET', '', { query: { 'list-type': '2', prefix } });
    if (!res.ok) return this.#fail(res, `listing ${prefix}`);
    const xml = await res.text();
    return [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => m[1]!.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
  }
}

/** The bucket named by R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (and R2_REGION, default auto), or nothing when they aren't all set. */
export function s3FromEnv(env: NodeJS.ProcessEnv, options: { fetch?: typeof fetch; log?: (line: string) => void } = {}): S3 | undefined {
  const [endpoint, bucket, accessKeyId, secretAccessKey] = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].map((name) => env[name]?.trim());
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return undefined;
  // R2 uses the region "auto"; another S3 server (a stand-in for trying things out) may want a named one.
  return new S3({ endpoint, bucket, accessKeyId, secretAccessKey, region: env.R2_REGION?.trim() || 'auto', ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.log ? { log: options.log } : {}) });
}
