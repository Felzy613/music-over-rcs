import assert from 'node:assert/strict';
import type { RequestListener } from 'node:http';
import { after, before, describe, test } from 'node:test';
import { AudioFetchError, fetchAudio, sanitizeFileName } from '../src/audio-fetch.ts';
import { listen, type Listening } from './helpers/servers.ts';

const MiB = 1024 * 1024;
const PAYLOAD = Buffer.from('fake-audio-bytes'.repeat(100));

const host: RequestListener = (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  switch (path) {
    case '/song.mp3':
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
      break;
    case '/Artist%20-%20Title.flac':
      res.writeHead(200, { 'content-type': 'audio/flac' });
      res.end(PAYLOAD);
      break;
    case '/octet.ogg':
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(PAYLOAD);
      break;
    case '/page.html':
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
      break;
    case '/big.mp3':
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(5 * MiB) });
      res.end();
      break;
    case '/stream.mp3':
      // No content-length: the size is only discovered while reading.
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      for (let i = 0; i < 3; i++) res.write(Buffer.alloc(400 * 1024));
      res.end();
      break;
    case '/empty.mp3':
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '0' });
      res.end();
      break;
    case '/hang.mp3':
      break; // never answers
    default:
      res.writeHead(404);
      res.end();
  }
};

describe('fetchAudio', () => {
  let server: Listening;
  before(async () => {
    server = await listen(host);
  });
  after(() => server.close());

  const get = (path: string, title?: string, options = {}) => fetchAudio(`${server.url}${path}`, title, options);

  const rejectsWith = (promise: Promise<unknown>, pattern: RegExp) =>
    assert.rejects(promise, (err: unknown) => {
      assert.ok(err instanceof AudioFetchError, String(err));
      assert.match(err.message, pattern);
      return true;
    });

  test('downloads the file and names it after the title', async () => {
    const audio = await get('/song.mp3', 'Mira Vale — Paper Planes at Dawn');
    assert.equal(audio.fileName, 'Mira Vale — Paper Planes at Dawn.mp3');
    assert.equal(audio.mimeType, 'audio/mpeg');
    assert.equal(audio.bytes, PAYLOAD.length);
    assert.deepEqual(Buffer.from(await audio.data.arrayBuffer()), PAYLOAD);
  });

  test('falls back to the URL file name, and accepts formats RCS for Business would not', async () => {
    const audio = await get('/Artist%20-%20Title.flac');
    assert.equal(audio.fileName, 'Artist - Title.flac');
    assert.equal(audio.mimeType, 'audio/flac');
  });

  test('infers the type from the extension when the server says octet-stream', async () => {
    assert.equal((await get('/octet.ogg')).mimeType, 'audio/ogg');
  });

  test('refuses web pages', async () => {
    await rejectsWith(get('/page.html'), /isn't an audio file/);
  });

  test('refuses files whose declared size is over the limit, without downloading them', async () => {
    await rejectsWith(get('/big.mp3', undefined, { maxBytes: MiB }), /5\.0 MB.*limit is 1\.0 MB/);
  });

  test('stops reading once a stream outgrows the limit', async () => {
    await rejectsWith(get('/stream.mp3', undefined, { maxBytes: MiB }), /bigger than the 1\.0 MB limit/);
  });

  test('refuses empty files, HTTP errors and invalid links', async () => {
    await rejectsWith(get('/empty.mp3'), /empty/);
    await rejectsWith(get('/gone.mp3'), /HTTP 404/);
    await rejectsWith(fetchAudio('not a url'), /valid URL/);
    await rejectsWith(fetchAudio('ftp://example.com/a.mp3'), /http/);
  });

  test('gives up on a server that never answers', async () => {
    await rejectsWith(get('/hang.mp3', undefined, { timeoutMs: 100 }), /didn't answer/);
  });
});

describe('sanitizeFileName', () => {
  test('replaces characters that are unsafe in file names', () => {
    assert.equal(sanitizeFileName('AC/DC: Back "In" Black?'), 'AC_DC_ Back _In_ Black_');
  });

  test('collapses whitespace and trims dots', () => {
    assert.equal(sanitizeFileName('  ..a   b..  '), 'a b');
  });

  test('keeps names to 120 characters without splitting an emoji', () => {
    const name = sanitizeFileName('🎵'.repeat(200));
    assert.equal(Array.from(name).length, 120);
  });
});
