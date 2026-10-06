import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkAudio, megabytes } from '../audio-check.ts';
import { AudioFetchError, fetchAudio, sanitizeFileName, type DownloadedAudio } from '../audio-fetch.ts';
import { createBot, describe } from '../bot.ts';
import type { Catalog } from '../catalog.ts';
import { createPictures, type Picture, type PreparedPicture } from '../library/images.ts';
import { catalogBrowse } from '../library/browse.ts';
import { Categories } from '../library/categories.ts';
import { catalogFollows } from '../library/follows.ts';
import { LibraryJobs } from '../library/jobs.ts';
import { createRunner, type Runner } from '../runner.ts';
import { createMusicTableSource, resolvingAudio, type MusicTable } from '../sources/music-table.ts';
import { SimulatedChat } from './chat.ts';
import type { Trace, TraceItem, TraceRun } from './trace.ts';

export interface SimulatorOptions {
  catalog: Catalog;
  musicTable: MusicTable | undefined;
  trace: Trace;
  /** Really download each file the bot sends, as it does for a phone. By default only its type and size are checked. */
  full?: boolean;
  /** Largest file the bot will send, in bytes. */
  maxBytes?: number;
  pollMs?: number;
  now?: () => number;
  /** How pictures are made. By default the real way (cards and collages drawn on this Mac), so the page shows what the phone gets. */
  prepareImage?: (picture: Picture) => Promise<PreparedPicture>;
}

export interface Simulator {
  /** Starts listening on 127.0.0.1. Port 0 picks a free one. */
  listen(port?: number): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
  readonly server: Server;
}

const PAGE_URL = new URL('./page.html', import.meta.url);
const MAX_BODY_BYTES = 4096;
const MAX_TEXT_CHARS = 400;
const KEEPALIVE_MS = 15_000;
const KEEP_LINKS = 200;

const EXTENSION_BY_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
};

const mb = (bytes: number): string => (bytes > 0 ? `${megabytes(bytes)} MB` : 'size unknown');
const clip = (text: string, n = 90): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const runSummary = (run: TraceRun) => ({
  id: run.id,
  text: run.text,
  choice: run.choice,
  startedAt: run.startedAt,
  firstReplyMs: run.firstReplyMs,
  totalMs: run.totalMs,
});

/**
 * A web page that looks like a Google Messages chat and talks to the real bot: the same runner, bot, catalog and
 * music-table.com lookup the phone setup uses, with a "behind the scenes" panel that shows each step and its time.
 */
export function createSimulator(options: SimulatorOptions): Simulator {
  const { catalog, musicTable, trace } = options;
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  const clients = new Set<ServerResponse>();
  const links = new Map<string, string>();
  let port = 0;
  let chat = new SimulatedChat(now);
  let runner: Runner | undefined;
  let keepalive: NodeJS.Timeout | undefined;

  const send = (event: string, data: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(frame);
  };

  const real = {
    checkAudio: (url: string) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true, maxBytes }),
    fetchAudio: (url: string, title?: string) => fetchAudio(url, title, { maxBytes }),
  };
  const audio = resolvingAudio(musicTable, real, { maxBytes });
  const pictures = options.prepareImage ?? createPictures();

  /** Type and size of a file without downloading it. */
  async function describeFile(url: string): Promise<{ type: string; bytes: number }> {
    const site = await musicTable?.inspect(url);
    if (site) return { type: site.type, bytes: site.bytes };
    const check = await real.checkAudio(url);
    if (!check.ok) throw new AudioFetchError(check.reason);
    return { type: check.type, bytes: check.bytes ?? 0 };
  }

  const tracedCatalog = {
    search(query: string, limit?: number) {
      const started = now();
      const found = catalog.search(query, limit);
      trace.add({
        label: 'your catalog',
        detail: `“${query}” · ${found.length === 0 ? 'no match' : `${found.length} match${found.length === 1 ? '' : 'es'}`}`,
        ms: now() - started,
        tone: 'catalog',
      });
      return found;
    },
    get: (id: number) => catalog.get(id),
    postTracks: (slug: string) => catalog.postTracks(slug),
  };

  const bot = createBot({
    catalog: tracedCatalog,
    checkAudio: async (url) => {
      const started = now();
      const result = await audio.checkAudio(url);
      trace.add({
        label: 'check file',
        detail: result.ok ? `${result.type}, ${mb(result.bytes ?? 0)}` : `refused: ${result.reason}`,
        ms: now() - started,
        tone: result.ok ? 'site' : 'warn',
      });
      return result;
    },
    onPlay: (track) => catalog.recordPlay(track.id),
    browse: catalogBrowse(catalog, undefined, musicTable ? new Categories({ musicTable, catalog }) : undefined),
    follows: catalogFollows(catalog),
    ...(musicTable
      ? { source: createMusicTableSource({ musicTable, catalog, onNote: (note) => trace.add({ label: 'lookup', detail: note, tone: 'note' }) }) }
      : {}),
  });

  /**
   * The daily new-music message, as it would go out now, into this chat. Unlike the real one it covers the last three
   * days (so there is always something to see) and marks nothing as sent, so it can be shown again.
   */
  async function showDigest(): Promise<void> {
    trace.begin('daily new-music message');
    try {
      if (!musicTable || !runner) throw new Error('music-table.com is off');
      const activeRunner = runner;
      const jobs = new LibraryJobs({
        musicTable,
        catalog,
        announce: (replies) => activeRunner.announce(replies),
        fetchAudio: audio.fetchAudio,
        log: (line) => trace.add({ label: 'library', detail: clip(line, 160), tone: 'note' }),
      });
      const { replies } = await jobs.previewDigest(new Date(now() - 3 * 24 * 60 * 60_000));
      if (replies.length === 0) trace.add({ label: 'nothing new', detail: 'no posts in the last three days', tone: 'note' });
      else await activeRunner.announce(replies);
    } catch (err) {
      trace.add({ label: 'failed', detail: err instanceof Error ? err.message : String(err), tone: 'warn' });
    } finally {
      trace.end();
    }
  }

  /** What the runner calls to get a file ready to send. */
  async function prepare(url: string, title?: string): Promise<DownloadedAudio> {
    const started = now();
    const linkId = randomUUID().slice(0, 8);
    links.set(linkId, url);
    if (links.size > KEEP_LINKS) links.delete(links.keys().next().value!);
    chat.nextAudioLink = linkId;
    if (options.full) {
      const file = await audio.fetchAudio(url, title);
      trace.add({ label: 'download file', detail: `${mb(file.bytes)} downloaded, ready to send`, ms: now() - started, tone: 'site' });
      return file;
    }
    const info = await describeFile(url);
    const name = `${sanitizeFileName(title ?? 'track') || 'track'}.${EXTENSION_BY_TYPE[info.type] ?? 'audio'}`;
    trace.add({
      label: 'file ready',
      detail: `${name} · ${mb(info.bytes)} · not downloaded: Play streams it from the site`,
      ms: now() - started,
      tone: 'site',
    });
    return { data: new Blob([]), fileName: name, mimeType: info.type, bytes: info.bytes };
  }

  /** What a 👍 picked, in words: the song, or the album. */
  function picked(postback: string): string {
    const id = /^play:(\d+)$/.exec(postback)?.[1];
    const track = id === undefined ? undefined : catalog.get(Number(id));
    if (track) return describe(track);
    const slug = /^post:(.+)$/.exec(postback)?.[1];
    return (slug === undefined ? undefined : catalog.sitePost(slug)?.title) ?? postback;
  }

  /** The runner reports what it does in plain lines; they open and annotate each request in the trace. */
  function onRunnerLog(line: string): void {
    const request = /^<- (?:choice (\d+)|👍 (\S+)|("(?:[^"\\]|\\.)*"))$/u.exec(line);
    if (request) {
      if (request[1]) trace.begin(request[1], true);
      else if (request[2]) trace.begin(`👍 ${picked(request[2])}`, true);
      else trace.begin(JSON.parse(request[3]!) as string);
      return;
    }
    if (line.startsWith('ignoring a repeat')) {
      const quoted = /: ("(?:[^"\\]|\\.)*")$/.exec(line)?.[1];
      trace.begin(quoted ? (JSON.parse(quoted) as string) : 'a repeat');
      trace.add({ label: 'ignored', detail: 'the same request again within 20 seconds, taken as an echo of the first', tone: 'note' });
      trace.end();
      return;
    }
    if (line.startsWith('-> audio') || line.startsWith('-> announcement')) return; // the replies themselves are shown
    trace.add({ label: 'bot', detail: clip(line, 160), tone: /fail|could not|error|limit/i.test(line) ? 'warn' : 'note' });
  }

  function startSession(): void {
    chat = new SimulatedChat(now);
    chat.events.on('message', (message) => {
      send('message', message);
      if (message.from === 'bot') {
        trace.add({
          label: 'reply sent',
          detail: message.audio ? `${message.audio.name} · ${mb(message.audio.bytes)}` : message.image ? 'album art' : clip(message.text ?? '', 120),
          tone: 'reply',
        });
      }
    });
    chat.events.on('reaction', (reaction: { id: number; key: string }) => send('reaction', reaction));
    chat.events.on('typing', (typing: boolean) => {
      send('typing', typing);
      if (!typing) trace.end();
    });
    runner = createRunner({
      chat,
      bot,
      chatID: 'simulated-chat',
      fetchAudio: prepare,
      prepareImage: pictures,
      pollMs: options.pollMs ?? 40,
      log: onRunnerLog,
    });
    void runner.start();
  }

  trace.events.on('begin', (run: TraceRun) => send('trace-begin', runSummary(run)));
  trace.events.on('item', ({ run, item }: { run: TraceRun; item: TraceItem }) => send('trace-item', { runId: run.id, item }));
  trace.events.on('end', (run: TraceRun) => send('trace-end', { ...runSummary(run), catalogTracks: catalog.count() }));

  const state = () => ({
    catalogTracks: catalog.count(),
    musicTable: musicTable !== undefined,
    full: options.full === true,
    maxMb: Math.round(maxBytes / (1024 * 1024)),
    typing: chat.typing,
    messages: chat.messages,
    runs: trace.runs,
  });

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  /** Only pages loaded from this machine's own address may talk to the simulator (this blocks DNS rebinding). */
  const hostAllowed = (req: IncomingMessage): boolean => {
    const match = /^(127\.0\.0\.1|localhost|\[::1\]):(\d+)$/.exec(req.headers.host ?? '');
    return match !== null && Number(match[2]) === port;
  };

  async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
    if (req.headers['x-simulator'] !== '1') return { ok: false, status: 403 };
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_BODY_BYTES) return { ok: false, status: 413 };
      chunks.push(chunk as Buffer);
    }
    try {
      return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
    } catch {
      return { ok: false, status: 400 };
    }
  }

  const server = createServer(async (req, res) => {
    try {
      if (!hostAllowed(req)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;

      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(readFileSync(PAGE_URL, 'utf8'));
      } else if (req.method === 'GET' && path === '/api/state') {
        json(res, 200, state());
      } else if (req.method === 'GET' && path === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
        res.write(`retry: 2000\n\nevent: snapshot\ndata: ${JSON.stringify(state())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
      } else if (req.method === 'POST' && path === '/api/send') {
        const body = await readJson(req);
        if (!body.ok) return json(res, body.status, { error: body.status === 403 ? 'forbidden' : 'bad request' });
        const text = typeof (body.value as { text?: unknown }).text === 'string' ? (body.value as { text: string }).text.trim() : '';
        if (!text || text.length > MAX_TEXT_CHARS) return json(res, 400, { error: `type 1 to ${MAX_TEXT_CHARS} characters` });
        json(res, 202, { ok: true, id: chat.say(text).id });
      } else if (req.method === 'POST' && path === '/api/react') {
        const body = await readJson(req);
        if (!body.ok) return json(res, body.status, { error: body.status === 403 ? 'forbidden' : 'bad request' });
        const id = (body.value as { id?: unknown }).id;
        if (typeof id !== 'number' || !chat.react(id)) return json(res, 404, { error: 'no such message' });
        json(res, 202, { ok: true });
      } else if (req.method === 'POST' && path === '/api/digest') {
        const body = await readJson(req);
        if (!body.ok) return json(res, body.status, { error: 'forbidden' });
        if (!musicTable) return json(res, 409, { error: 'music-table.com is off' });
        json(res, 202, { ok: true });
        void showDigest();
      } else if (req.method === 'POST' && path === '/api/reset') {
        const body = await readJson(req);
        if (!body.ok) return json(res, body.status, { error: 'forbidden' });
        await runner?.stop();
        trace.clear();
        startSession();
        send('reset', state());
        json(res, 200, { ok: true });
      } else if (req.method === 'GET' && path.startsWith('/api/play/')) {
        const original = links.get(decodeURIComponent(path.slice('/api/play/'.length)));
        if (!original) return json(res, 404, { error: 'unknown file' });
        try {
          json(res, 200, { url: musicTable ? await musicTable.resolveUrl(original) : original });
        } catch (err) {
          json(res, 502, { error: err instanceof Error ? err.message : 'could not get the file' });
        }
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : 'server error' });
      else res.end();
    }
  });

  startSession();

  return {
    server,
    async listen(wanted = 0) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(wanted, '127.0.0.1', resolve);
      });
      port = (server.address() as AddressInfo).port;
      keepalive = setInterval(() => {
        for (const client of clients) client.write(': keepalive\n\n');
      }, KEEPALIVE_MS);
      keepalive.unref();
      return { url: `http://127.0.0.1:${port}`, port };
    },
    async close() {
      clearInterval(keepalive);
      await runner?.stop();
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
