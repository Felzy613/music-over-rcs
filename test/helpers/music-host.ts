import { listen, type Listening } from './servers.ts';

export interface MusicHost extends Listening {
  /** The bytes served at a path, so tests can check a file arrived intact. */
  bytes(path: string): Buffer;
}

/** A pretend file host: three MP3s, one web page, and one file whose HEAD works but whose GET fails. */
export async function startMusicHost(): Promise<MusicHost> {
  const files = new Map<string, { type: string; data: Buffer }>([
    ['/planes.mp3', { type: 'audio/mpeg', data: Buffer.from('planes-audio-bytes'.repeat(40)) }],
    ['/blue.mp3', { type: 'audio/mpeg', data: Buffer.from('blue-audio-bytes'.repeat(40)) }],
    ['/blue-live.mp3', { type: 'audio/mpeg', data: Buffer.from('blue-live-audio-bytes'.repeat(40)) }],
  ]);

  const server = await listen((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const head = req.method === 'HEAD';

    if (path === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(head ? undefined : '<html></html>');
    } else if (path === '/flaky.mp3') {
      if (head) {
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '100' });
        res.end();
      } else {
        res.writeHead(500);
        res.end('boom');
      }
    } else {
      const file = files.get(path);
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': file.type, 'content-length': String(file.data.length) });
      res.end(head ? undefined : file.data);
    }
  });

  return { ...server, bytes: (path) => files.get(path)!.data };
}
