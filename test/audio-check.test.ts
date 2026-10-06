import assert from 'node:assert/strict';
import type { RequestListener } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { checkAudio } from '../src/audio-check.ts';
import { listen, type Listening } from './helpers/servers.ts';

const MiB = 1024 * 1024;

const audioHost: RequestListener = (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const head = req.method === 'HEAD';
  const send = (status: number, headers: Record<string, string>, body?: Buffer | string) => {
    res.writeHead(status, headers);
    if (head || body === undefined) res.end();
    else res.end(body);
  };

  switch (path) {
    case '/ok.mp3':
      return send(200, { 'content-type': 'audio/mpeg', 'content-length': '1234' }, Buffer.alloc(1234));
    case '/charset.mp3':
      return send(200, { 'content-type': 'Audio/MPEG; charset=binary', 'content-length': '10' }, Buffer.alloc(10));
    case '/page.html':
      return send(200, { 'content-type': 'text/html; charset=utf-8' }, '<html></html>');
    case '/huge.mp3':
      return send(200, { 'content-type': 'audio/mpeg', 'content-length': String(200 * MiB) });
    case '/nohead.mp3':
      if (head) return send(405, {});
      return send(206, { 'content-type': 'audio/mpeg', 'content-range': 'bytes 0-0/5000', 'content-length': '1' }, Buffer.alloc(1));
    case '/octet.mp3':
    case '/octet.bin':
      return send(200, { 'content-type': 'application/octet-stream', 'content-length': '10' }, Buffer.alloc(10));
    case '/song.wav':
      return send(200, { 'content-type': 'audio/wav', 'content-length': '10' }, Buffer.alloc(10));
    case '/forbidden.mp3':
      return send(403, {});
    default:
      return send(404, {});
  }
};

describe('checkAudio', () => {
  let host: Listening;
  before(async () => {
    host = await listen(audioHost);
  });
  after(() => host.close());

  const check = (path: string) => checkAudio(`${host.url}${path}`, { allowPrivateHosts: true });

  test('accepts a reachable MP3 and reports its size', async () => {
    assert.deepEqual(await check('/ok.mp3'), { ok: true, type: 'audio/mpeg', bytes: 1234 });
  });

  test('normalises the content type', async () => {
    assert.deepEqual(await check('/charset.mp3'), { ok: true, type: 'audio/mpeg', bytes: 10 });
  });

  test('rejects web pages such as a streaming-site watch URL', async () => {
    const result = await check('/page.html');
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : '', /isn't an audio file.*text\/html/);
  });

  test('rejects files over 100 MiB', async () => {
    const result = await check('/huge.mp3');
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : '', /200\.0 MB.*100 MiB/);
  });

  test('falls back to a one-byte ranged GET when HEAD is refused', async () => {
    assert.deepEqual(await check('/nohead.mp3'), { ok: true, type: 'audio/mpeg', bytes: 5000 });
  });

  test('retries with GET when HEAD is forbidden, then reports the HTTP error', async () => {
    const result = await check('/forbidden.mp3');
    assert.deepEqual(result, { ok: false, reason: 'the file server answered HTTP 403' });
  });

  test('reports missing files', async () => {
    assert.deepEqual(await check('/gone.mp3'), { ok: false, reason: 'the file server answered HTTP 404' });
  });

  test('accepts octet-stream only when the URL ends in an audio extension', async () => {
    assert.equal((await check('/octet.mp3')).ok, true);
    assert.equal((await check('/octet.bin')).ok, false);
  });

  test('explains that RCS does not take WAV', async () => {
    const result = await check('/song.wav');
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : '', /WAV, FLAC or WebM.*MP3 or AAC/);
  });

  test('accepts WAV when any audio format will do', async () => {
    const result = await checkAudio(`${host.url}/song.wav`, { allowPrivateHosts: true, allowAnyAudio: true });
    assert.deepEqual(result, { ok: true, type: 'audio/wav', bytes: 10 });
  });

  test('honours a custom size limit', async () => {
    const result = await checkAudio(`${host.url}/huge.mp3`, { allowPrivateHosts: true, maxBytes: MiB });
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : '', /200\.0 MB.*limit is 1\.0 MB/);
  });

  test('reports an unreachable host', async () => {
    const result = await checkAudio('http://127.0.0.1:9/x.mp3', { allowPrivateHosts: true, timeoutMs: 1000 });
    assert.deepEqual(result, { ok: false, reason: "the file server didn't answer (network error or timeout)" });
  });
});

describe('checkAudio URL rules', () => {
  test('refuses hosts Google could not reach', async () => {
    for (const url of [
      'http://localhost/x.mp3',
      'http://127.0.0.1:8080/x.mp3',
      'http://10.0.0.5/x.mp3',
      'http://172.16.4.2/x.mp3',
      'http://192.168.1.20/x.mp3',
      'http://169.254.169.254/latest/meta-data',
      'http://nas.local/x.mp3',
      'http://[::1]/x.mp3',
      'http://[fd00::1]/x.mp3',
    ]) {
      const result = await checkAudio(url);
      assert.equal(result.ok, false, url);
      assert.match(!result.ok ? result.reason : '', /publicly reachable/, url);
    }
  });

  test('refuses things that are not http(s) URLs', async () => {
    assert.deepEqual(await checkAudio('not a url'), { ok: false, reason: "the link isn't a valid URL" });
    assert.deepEqual(await checkAudio('ftp://example.com/x.mp3'), {
      ok: false,
      reason: 'the link must start with http:// or https://',
    });
  });
});
