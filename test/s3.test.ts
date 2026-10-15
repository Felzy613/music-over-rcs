import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { S3, S3Error, s3FromEnv, signRequest } from '../src/cloud/s3.ts';

const EMPTY = createHash('sha256').update('').digest('hex');

describe('request signing', () => {
  test('reproduces the AWS Signature Version 4 test-suite example "get-vanilla"', () => {
    // From AWS's published test suite: GET / on example.amazonaws.com, 2015-08-30T12:36:00Z, region us-east-1, service "service".
    const headers = signRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/',
      payloadHash: EMPTY,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'service',
      date: new Date('2015-08-30T12:36:00Z'),
    });
    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    assert.equal(headers['x-amz-date'], '20150830T123600Z');
  });

  test('reproduces the AWS example "get-vanilla-query-order-key-case" (query parameters sorted)', () => {
    const headers = signRequest({
      method: 'GET',
      url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1',
      payloadHash: EMPTY,
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 'service',
      date: new Date('2015-08-30T12:36:00Z'),
    });
    assert.match(headers.authorization!, /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/);
  });
});

/** An object store that checks nothing about signatures but does what S3 does with ETags and conditions. */
function fakeStore() {
  const objects = new Map<string, { body: string; etag: string }>();
  const seen: Array<{ method: string; url: string; headers: Headers }> = [];
  let n = 0;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const headers = new Headers(init?.headers);
    seen.push({ method: init?.method ?? 'GET', url, headers });
    const key = decodeURIComponent(u.pathname.split('/').slice(2).join('/'));
    if (init?.method === 'PUT') {
      const current = objects.get(key);
      if (headers.get('if-none-match') === '*' && current) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      if (headers.has('if-match') && current?.etag !== headers.get('if-match')) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      const etag = `"e${++n}"`;
      objects.set(key, { body: String(init.body), etag });
      return new Response('', { status: 200, headers: { etag } });
    }
    if (init?.method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') ?? '';
      return new Response(`<ListBucketResult>${[...objects.keys()].filter((k) => k.startsWith(prefix)).map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}</ListBucketResult>`);
    }
    const found = objects.get(key);
    return found ? new Response(found.body, { headers: { etag: found.etag } }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
  }) as unknown as typeof fetch;
  return { objects, seen, s3: new S3({ endpoint: 'https://acct.r2.cloudflarestorage.com/', bucket: 'mors-state', accessKeyId: 'id', secretAccessKey: 'secret', fetch: fakeFetch, now: () => new Date('2026-10-14T00:00:00Z') }) };
}

describe('the bucket client', () => {
  test('writes, reads back with the ETag, lists by prefix and deletes', async () => {
    const { s3 } = fakeStore();
    assert.equal(await s3.get('a.json'), undefined);
    const written = await s3.put('alerts/1.json', '{"x":1}');
    assert.equal(written.ok, true);
    assert.deepEqual(await s3.get('alerts/1.json'), { text: '{"x":1}', etag: (written as { etag: string }).etag });
    await s3.put('alerts/2 & more.json', 'b');
    await s3.put('lease.json', 'c');
    assert.deepEqual(await s3.list('alerts/'), ['alerts/1.json', 'alerts/2 & more.json']);
    await s3.delete('alerts/1.json');
    await s3.delete('alerts/never-existed.json');
    assert.deepEqual(await s3.list('alerts/'), ['alerts/2 & more.json']);
  });

  test('conditional writes: only if absent, only if unchanged; a lost race is false, not an error', async () => {
    const { s3 } = fakeStore();
    const first = await s3.put('lease.json', 'one', { ifNoneMatch: '*' });
    assert.equal(first.ok, true);
    assert.deepEqual(await s3.put('lease.json', 'two', { ifNoneMatch: '*' }), { ok: false });
    const etag = (first as { etag: string }).etag;
    const second = await s3.put('lease.json', 'two', { ifMatch: etag });
    assert.equal(second.ok, true);
    assert.deepEqual(await s3.put('lease.json', 'three', { ifMatch: etag }), { ok: false }, 'the ETag moved on');
    assert.equal((await s3.get('lease.json'))?.text, 'two');
  });

  test('sends path-style addresses, signed, with the body hash and the condition headers', async () => {
    const { s3, seen } = fakeStore();
    await s3.put('a b/c.json', 'x', { ifNoneMatch: '*' });
    const request = seen[0]!;
    assert.equal(request.url, 'https://acct.r2.cloudflarestorage.com/mors-state/a%20b/c.json');
    assert.equal(request.headers.get('if-none-match'), '*');
    assert.equal(request.headers.get('x-amz-content-sha256'), createHash('sha256').update('x').digest('hex'));
    assert.match(request.headers.get('authorization')!, /^AWS4-HMAC-SHA256 Credential=id\/20261014\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });

  test('other failures name the status and S3’s code', async () => {
    const s3 = new S3({ endpoint: 'https://x.test', bucket: 'b', accessKeyId: 'i', secretAccessKey: 's', fetch: (async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })) as unknown as typeof fetch });
    await assert.rejects(() => s3.get('k'), (err: unknown) => err instanceof S3Error && err.status === 403 && /AccessDenied/.test(err.message));
    await assert.rejects(() => s3.put('k', 'v'), /HTTP 403/);
  });

  test('is made from the four R2 settings, or not at all', () => {
    const all = { R2_ENDPOINT: 'https://a.r2.cloudflarestorage.com', R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'i', R2_SECRET_ACCESS_KEY: 's' };
    assert.ok(s3FromEnv(all) instanceof S3);
    assert.ok(s3FromEnv({ ...all, R2_REGION: 'us-east-1' }) instanceof S3);
    assert.equal(s3FromEnv({ ...all, R2_BUCKET: '' }), undefined);
    assert.equal(s3FromEnv({}), undefined);
  });
});
