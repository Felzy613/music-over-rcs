import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createImageFetcher } from '../src/image-fetch.ts';
import { listen, type Listening } from './helpers/servers.ts';

describe('image fetch (album art)', () => {
  let server: Listening;
  const hits: string[] = [];
  before(async () => {
    server = await listen((req, res) => {
      hits.push(req.url ?? '');
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path === '/cover.jpg') {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(Buffer.from('jpeg-bytes'));
      } else if (path === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html></html>');
      } else if (path === '/huge.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.alloc(5000));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  after(() => server.close());
  beforeEach(() => {
    hits.length = 0;
  });

  test('downloads a picture, with its type and a file name to attach it under', async () => {
    const image = await createImageFetcher()(`${server.url}/cover.jpg`);
    assert.equal(image.mimeType, 'image/jpeg');
    assert.equal(image.fileName, 'cover.jpg');
    assert.equal(image.bytes, 10);
    assert.equal(image.sourceUrl, `${server.url}/cover.jpg`);
  });

  test('refuses what is not a picture, is missing, or is too big', async () => {
    const fetchImage = createImageFetcher({ maxBytes: 1000 });
    await assert.rejects(fetchImage(`${server.url}/page`), /isn't a picture \(text\/html\)/);
    await assert.rejects(fetchImage(`${server.url}/missing.jpg`), /HTTP 404/);
    await assert.rejects(fetchImage(`${server.url}/huge.png`), /too big/);
    await assert.rejects(fetchImage('not a url'), /valid URL/);
  });

  test('the same picture is downloaded once; a failure is not remembered', async () => {
    const fetchImage = createImageFetcher();
    await Promise.all([fetchImage(`${server.url}/cover.jpg`), fetchImage(`${server.url}/cover.jpg`)]);
    await fetchImage(`${server.url}/cover.jpg`);
    assert.deepEqual(hits, ['/cover.jpg']);
    await assert.rejects(fetchImage(`${server.url}/missing.jpg`));
    await assert.rejects(fetchImage(`${server.url}/missing.jpg`));
    assert.equal(hits.filter((hit) => hit === '/missing.jpg').length, 2);
  });

  test('keeps only the most recent pictures', async () => {
    const fetchImage = createImageFetcher({ remember: 1 });
    await fetchImage(`${server.url}/cover.jpg`);
    await fetchImage(`${server.url}/cover.jpg?b`);
    await fetchImage(`${server.url}/cover.jpg`);
    assert.equal(hits.length, 3, 'the first was forgotten when the second came');
  });
});
