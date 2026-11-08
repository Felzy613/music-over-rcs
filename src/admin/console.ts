import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Catalog } from '../catalog.ts';
import type { Follows } from '../library/follows.ts';
import type { LibraryJobs } from '../library/jobs.ts';
import { parseQuery } from '../query.ts';
import type { YouTubeMusic } from '../sources/youtube-music.ts';
import type { NewReleases } from '../sources/zemer-releases.ts';
import type { Verdict, ZemerWhitelist } from '../sources/zemer-whitelist.ts';
import type { Reply } from '../types.ts';
import { TRAFFIC_ALERT_BYTES, archivedThisMonth, sentThisMonth } from '../usage.ts';
import { ActionGuard, AdminError, type ActionOutcome } from './actions.ts';
import { AdminAccount, MAX_PASSWORD_CHARS, MAX_USER_CHARS, MIN_PASSWORD_CHARS, MIN_USER_CHARS } from './account.ts';
import { AuditLog } from './audit.ts';
import { isSameSite } from './same-site.ts';
import type { SignIn } from './sign-in.ts';
import { LiveSettings } from './settings.ts';

export { isSameSite };
import { logRing, type LogRing } from './log-ring.ts';

// The owner's management console: a few plain pages and a small JSON API, served by the cloud host's web door behind the same
// ADMIN_TOKEN as /status and /pair (src/cloud/web.ts checks the password; nothing here is reachable without it). It shows what
// the backend knows and does, changes the settings that can change while the bot runs, starts refreshes, and decides which
// artists and songs may be sent. Docs: docs/admin.md.
//
// The door exists before the bot is loaded, so the bot registers what it has with `provide()` afterwards (src/cloud-main.ts
// gives the host's part, src/matrix-main.ts the bot's). Until then the parts that need the bot say it is still starting.
//
// Every request that changes anything is a POST with a JSON body and the header `X-Admin-Console: 1`, and is refused when the
// browser says it came from another site (Origin, Sec-Fetch-Site), so a page on another site cannot use the browser's saved
// password to act: a cross-site request cannot carry that header without a preflight, which this door never allows. Bodies are
// limited to 64 KB and changes to 60 a minute. Everything shown that came from outside (artist and song names) is escaped by
// the page, which builds it with textContent only, under a content security policy that allows no inline script.

const MAX_BODY_BYTES = 64 * 1024;
const POSTS_PER_MINUTE = 60;
const TRACK_ROWS = 25;

/** What the console can use. The host provides its part first, the bot the rest once it is up. */
export interface AdminDeps {
  catalog: Catalog;
  env: NodeJS.ProcessEnv;
  /** The same report as /status. */
  status(): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** Unix ms the process started. */
  startedAt: number;
  log(line: string): void;
  settings: LiveSettings;
  ring: LogRing;
  whitelist: ZemerWhitelist;
  youTube: YouTubeMusic;
  releases: NewReleases;
  jobs(): LibraryJobs | undefined;
  follows: Follows;
  /** Signing in: the owner's account and the sessions (src/admin/sign-in.ts). */
  signIn: SignIn;
  /** The Connect page's part of the host: linking Google Messages, the chat, OneDrive's sign-in. */
  connect: ConnectDeps;
  /** The OneDrive archive's report, when it is set up. */
  oneDrive(): Record<string, unknown>;
  now(): number;
}

/**
 * What the Connect page needs from the host: linking Google Messages to the bridge, finding the "message yourself" chat, OneDrive's
 * sign-in, and a test alert. The host (src/cloud-main.ts) provides it, since the homeserver and the bridge are its.
 */
export interface ConnectDeps {
  /** A light report (no bucket or OneDrive calls: the page asks every few seconds): phase, whether the bot answers, the chat, the bridge's login, problems. */
  state(): Promise<Record<string, unknown>>;
  /** A window to the bridge's bot: what is sent goes to it as typed, and what it answers is kept to show. */
  pair: { send(text: string): Promise<void>; log(): Promise<Array<{ at: string; text: string }>> };
  /** The rooms the bridge made for the chat with this phone number; with no number, for the phone's own numbers (which the bridge learned from Google Messages). */
  rooms(phone: string | undefined): Promise<string[]> | string[];
  /** Chooses the room the bot answers in. */
  setRoom(room: string): Promise<void> | void;
  /** The phone number the chat was found under before, if it was. */
  knownPhone(): string | undefined;
  /** Saving songs to OneDrive, when it is set up. */
  oneDrive?: { status(): Record<string, unknown>; start(): Promise<Record<string, unknown>> } | undefined;
  /** Leaves a test alert for the Worker to mail, when alerts are set up. */
  testAlert?: (() => Promise<void>) | undefined;
}

export const ACTIONS = ['refresh-list', 'refresh-list-force', 'refresh-releases', 'sync-site', 'prefetch', 'digest-preview', 'digest-send', 'alerts-check'] as const;
export type ActionName = (typeof ACTIONS)[number];

/** How long before an action may be started again. */
const COOLDOWN_MS: Record<ActionName, number> = {
  'refresh-list': 10_000,
  'refresh-list-force': 5 * 60_000,
  'refresh-releases': 30_000,
  'sync-site': 60_000,
  prefetch: 60_000,
  'digest-preview': 30_000,
  'digest-send': 60_000,
  'alerts-check': 30_000,
};

/** What the web door needs from the console. */
export interface AdminRouter {
  /** Answers the request when it is for the console and returns true; false when the path is not the console's. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } as const;
/** Pictures come only from Google's picture hosts (YouTube Music's artists and covers); nothing else is loaded, nothing inline runs. */
const CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.googleusercontent.com https://*.ggpht.com https://*.ytimg.com https://*.gstatic.com; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const WHY: Record<Extract<Verdict, { ok: false }>['why'], string> = {
  blocked: "Zemer's list blocks this song",
  female: 'a credited artist is flagged as a woman on Zemer\'s list',
  'not on the list': 'none of the credited artists is on the list',
  owner: 'you blocked a credited artist',
};
const verdictText = (verdict: Verdict): string => (verdict.ok ? 'may be sent' : WHY[verdict.why]);
/** Whether allowing the song by itself could change the verdict: not while a credited artist is a woman or one the owner blocked. */
const canAllow = (verdict: Verdict): boolean => !verdict.ok && verdict.why !== 'female' && verdict.why !== 'owner';

const STANDING_TEXT = {
  blocked: 'blocked by you',
  female: "on Zemer's list, flagged as a woman",
  listed: "on Zemer's list",
  allowed: 'allowed by you',
  waiting: 'waiting for your word',
  unknown: 'not on the list',
} as const;

const text = (value: unknown, max = 200): string => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max) : '');

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new AdminError(413, 'That is too much data.');
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // falls through
  }
  throw new AdminError(400, 'Expected a JSON object.');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
}

const SITE: Record<string, { file: string; type: string }> = {
  '/admin/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/admin/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/admin/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

export class AdminConsole implements AdminRouter {
  #deps: Partial<AdminDeps> = {};
  #guard: ActionGuard;
  #audit: AuditLog | undefined;
  #auditCatalog: Catalog | undefined;
  #assets = new Map<string, { body: Buffer; etag: string }>();
  #posts: number[] = [];

  constructor(options: { now?: () => number } = {}) {
    this.#guard = new ActionGuard(options.now ? { now: options.now } : {});
    if (options.now) this.#deps.now = options.now;
  }

  /** Adds what the caller has to what the console can use (the host first, the bot once it is up). */
  provide(deps: Partial<AdminDeps>): void {
    Object.assign(this.#deps, deps);
  }

  /** The settings the bot reads as it runs: made once, on the first catalog, and shared by whoever asks (the bot reads them through this). */
  liveSettings(catalog: Pick<Catalog, 'getState' | 'setState'>, env: NodeJS.ProcessEnv = process.env): LiveSettings {
    this.#deps.settings ??= new LiveSettings({ env, state: catalog });
    return this.#deps.settings;
  }

  get #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  get audit(): AuditLog {
    const catalog = this.#deps.catalog;
    if (!this.#audit || this.#auditCatalog !== catalog) {
      this.#audit = new AuditLog({ state: catalog, now: () => this.#now });
      this.#auditCatalog = catalog;
    }
    return this.#audit;
  }

  #need<K extends keyof AdminDeps>(key: K, what: string): NonNullable<AdminDeps[K]> {
    const value = this.#deps[key];
    if (value === undefined || value === null) throw new AdminError(503, `${what} is not available yet: the bot is still starting, or it is switched off.`);
    return value as NonNullable<AdminDeps[K]>;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://admin');
    const path = url.pathname;
    if (path === '/admin' && req.method === 'GET') {
      res.writeHead(302, { location: '/admin/', ...SECURITY_HEADERS });
      res.end();
      return true;
    }
    const asset = SITE[path];
    if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
      this.#serve(req, res, path, asset);
      return true;
    }
    if (!path.startsWith('/admin/api/')) return false;
    const route = path.slice('/admin/api/'.length);
    try {
      if (req.method === 'GET') return sendJson(res, 200, await this.#read(route, url, req)), true;
      if (req.method === 'POST') {
        this.#guardPost(req);
        const body = await readBody(req);
        return sendJson(res, 200, await this.#change(route, body)), true;
      }
      throw new AdminError(405, 'Use GET to read and POST to change.');
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return true;
      }
      if (err instanceof AdminError) sendJson(res, err.status, { error: err.message });
      else sendJson(res, 500, { error: err instanceof Error ? err.message : 'Something went wrong.' });
      return true;
    }
  }

  #serve(req: IncomingMessage, res: ServerResponse, path: string, asset: { file: string; type: string }): void {
    let kept = this.#assets.get(path);
    if (!kept) {
      const body = readFileSync(new URL(`./site/${asset.file}`, import.meta.url));
      kept = { body, etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
      this.#assets.set(path, kept);
    }
    const headers = {
      'content-type': asset.type,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // Revalidated each time: a few kilobytes, and a new deploy shows at once.
      'cache-control': 'no-cache',
      etag: kept.etag,
      ...(asset.file === 'index.html' ? { 'content-security-policy': CONTENT_SECURITY_POLICY, 'x-frame-options': 'DENY' } : {}),
    };
    if (req.headers['if-none-match'] === kept.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : kept.body);
  }

  /** The checks every change goes through, on top of the password. */
  #guardPost(req: IncomingMessage): void {
    if (req.headers['x-admin-console'] !== '1') throw new AdminError(403, 'This is only for the console page (the X-Admin-Console header is missing).');
    if (!isSameSite(req.headers)) throw new AdminError(403, 'Refused: the request came from another site.');
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) throw new AdminError(415, 'Send JSON.');
    const now = this.#now;
    this.#posts = this.#posts.filter((at) => now - at < 60_000);
    if (this.#posts.length >= POSTS_PER_MINUTE) throw new AdminError(429, 'Too many changes in a minute; wait a little.');
    this.#posts.push(now);
  }

  // --- reading ---

  async #read(route: string, url: URL, req: IncomingMessage): Promise<unknown> {
    switch (route) {
      case 'account':
        return this.#account(req);
      case 'connect':
        return this.#connect();
      case 'connect/log':
        return this.#connectLog();
      case 'overview':
        return this.#overview();
      case 'artists':
        return this.#artists(url);
      case 'songs':
        return this.#songs();
      case 'library':
        return this.#library(url);
      case 'settings':
        return { settings: this.#need('settings', 'The settings').report(), restart: 'Everything that is not marked "live" is read when the bot starts: change it in Render (that restarts the bot, about a minute).' };
      case 'follows':
        return { following: this.#need('catalog', 'The catalog').followed().map((artist) => ({ name: artist.name, songs: artist.songs, auto: artist.auto })) };
      case 'log': {
        const ring = this.#deps.ring ?? logRing;
        const level = url.searchParams.get('level') === 'problems' ? 'problems' : 'all';
        const search = text(url.searchParams.get('search'), 100);
        const limit = Number(url.searchParams.get('limit')) || 200;
        return { lines: ring.lines({ limit, level, ...(search ? { search } : {}) }), kept: ring.size, total: ring.total };
      }
      case 'audit':
        return { entries: this.audit.list() };
      default:
        throw new AdminError(404, 'There is nothing at that address.');
    }
  }

  async #overview(): Promise<unknown> {
    const { catalog, env } = this.#deps;
    const status = this.#deps.status ? await this.#deps.status() : null;
    const sent = catalog ? sentThisMonth(catalog) : 0;
    const saved = catalog ? archivedThisMonth(catalog) : 0;
    const mb = (bytes: number): number => Math.round(bytes / 1048576);
    const commit = env?.RENDER_GIT_COMMIT?.trim();
    return {
      now: this.#now,
      startedAt: this.#deps.startedAt ?? null,
      commit: commit ? { sha: commit.slice(0, 10), source: 'Render' } : null,
      node: process.version,
      botReady: this.#deps.whitelist !== undefined || this.#deps.jobs !== undefined,
      status,
      traffic: { sentMb: mb(sent), savedMb: mb(saved), totalMb: mb(sent + saved), alertMb: mb(TRAFFIC_ALERT_BYTES), planMb: 5000 },
      list: this.#deps.whitelist?.report() ?? null,
      releases: this.#deps.releases?.status() ?? null,
      jobs: this.#deps.jobs?.()?.report() ?? null,
      actions: this.#guard.snapshot(ACTIONS),
    };
  }

  #artists(url: URL): unknown {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const limit = Number(url.searchParams.get('limit')) || 50;
    const offset = Number(url.searchParams.get('offset')) || 0;
    const query = text(url.searchParams.get('q'), 100);
    return { report: whitelist.report(), owner: whitelist.ownerArtists(), list: { ...whitelist.listedArtists({ query, limit, offset }), query, offset, limit } };
  }

  #songs(): unknown {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const catalog = this.#deps.catalog;
    const youTube = this.#deps.youTube;
    const songs = whitelist.songs();
    const unblocked = new Set(songs.unblocked.map((song) => song.id));
    const titleOf = (id: string): string | null => {
      const track = youTube && catalog ? catalog.byUrl(youTube.trackUrl(id)) : undefined;
      return track ? `${track.title}${track.artist ? ` — ${track.artist}` : ''}` : null;
    };
    return {
      allowed: songs.allowed.map((song) => ({ ...song, holding: (() => { const verdict = whitelist.verdict(song.id, song.artistIds); return verdict.ok ? null : verdictText(verdict); })() })),
      unblocked: songs.unblocked,
      blocked: songs.blocked.slice(0, 500).map((id) => ({ id, title: titleOf(id), unblocked: unblocked.has(id) })),
      blockedTotal: songs.blocked.length,
    };
  }

  #library(url: URL): unknown {
    const catalog = this.#need('catalog', 'The catalog');
    const whitelist = this.#deps.whitelist;
    const youTube = this.#deps.youTube;
    const query = text(url.searchParams.get('q'), 100);
    const row = (track: ReturnType<Catalog['search']>[number]) => {
      const videoId = youTube?.parseTrackUrl(track.url);
      const ids = catalog.artistIdsOf(track.url);
      return {
        id: track.id,
        title: track.title,
        artist: track.artist,
        videoId: videoId ?? null,
        artistIds: ids ?? null,
        verdict: videoId && whitelist ? verdictText(whitelist.verdict(videoId, ids ?? [])) : null,
        allowed: videoId && whitelist ? whitelist.verdict(videoId, ids ?? []).ok : null,
        canAllow: videoId && whitelist ? canAllow(whitelist.verdict(videoId, ids ?? [])) : null,
      };
    };
    const releases = this.#deps.releases;
    const inNew = new Set((releases?.list() ?? []).map((release) => release.id));
    return {
      counts: catalog.tableCounts(),
      search: query ? { query, tracks: catalog.search(query, TRACK_ROWS).map(row) } : null,
      recent: catalog.recentTracks(15).map((track) => ({ ...row(track), addedAt: track.addedAt })),
      views: catalog.recentViews(15),
      jobs: this.#deps.jobs?.()?.report() ?? null,
      oneDrive: this.#deps.oneDrive ? this.#deps.oneDrive() : null,
      releases: {
        status: releases?.status() ?? null,
        stored: catalog
          .releases()
          .slice(0, 100)
          .map((release) => ({ id: release.id, title: release.title, artist: release.artist, artistId: release.artistId, songs: release.songs, releasedAt: release.releasedAt, firstSeenAt: release.firstSeenAt, announcedAt: release.announcedAt ?? null, alertedAt: release.alertedAt ?? null, inNew: inNew.has(release.id) })),
      },
    };
  }

  // --- changing ---

  async #change(route: string, body: Record<string, unknown>): Promise<unknown> {
    if (route.startsWith('actions/')) return this.#action(route.slice('actions/'.length), body);
    switch (route) {
      case 'artists/allow':
        return this.#allowArtist(body);
      case 'artists/block':
        return this.#blockArtist(body);
      case 'artists/unblock':
        return this.#unblockArtist(body);
      case 'artists/unallow':
        return this.#unallowArtist(body);
      case 'songs/allow':
        return this.#allowSong(body);
      case 'songs/unallow':
        return this.#unallowSong(body);
      case 'songs/unblock':
        return this.#unblockSong(body);
      case 'songs/reblock':
        return this.#reblockSong(body);
      case 'settings/set':
        return this.#setSetting(body);
      case 'settings/clear':
        return this.#clearSetting(body);
      case 'follows/add':
        return this.#follow(body, true);
      case 'follows/remove':
        return this.#follow(body, false);
      case 'youtube/search':
        return this.#searchYouTube(body);
      case 'connect/start':
        return this.#connectStart();
      case 'connect/send':
        return this.#connectSend(body);
      case 'connect/rooms':
        return this.#connectRooms(body);
      case 'connect/room':
        return this.#connectRoom(body);
      case 'connect/onedrive/start':
        return this.#connectOneDrive();
      case 'connect/test-alert':
        return this.#connectTestAlert();
      case 'account/set':
        return this.#setAccount(body);
      case 'account/clear':
        return this.#clearAccount(body);
      case 'account/signout-all':
        return this.#signOutEverywhere();
      default:
        throw new AdminError(404, 'There is nothing at that address.');
    }
  }

  /** The owner's word that no woman is credited, which every allow needs and which is never assumed. */
  #confirmedNoWomen(body: Record<string, unknown>, what: string): void {
    if (body.noWomenConfirmed !== true) throw new AdminError(400, `Confirm that no women are credited on ${what} first. Nothing was changed.`);
  }

  #channel(body: Record<string, unknown>): string {
    const id = text(body.id, 80);
    if (!id) throw new AdminError(400, 'Which artist? (a channel id is needed)');
    return id;
  }

  #allowArtist(body: Record<string, unknown>): unknown {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const id = this.#channel(body);
    this.#confirmedNoWomen(body, 'this artist');
    const before = whitelist.standing(id);
    const done = whitelist.admit(id, text(body.name, 100));
    if (!done.ok) throw new AdminError(409, done.why);
    this.audit.add({ what: 'allow artist', detail: `${done.artist.name} (${id})`, from: STANDING_TEXT[before.state], to: done.already ? 'no change' : 'allowed by you, no women credited' });
    return { ok: true, artist: done.artist, standing: whitelist.standing(id), message: done.already ? `${done.artist.name} was allowed already.` : `${done.artist.name} is allowed: their songs can be sent now.` };
  }

  #blockArtist(body: Record<string, unknown>): unknown {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const id = this.#channel(body);
    const before = whitelist.standing(id);
    const done = whitelist.refuse(id, text(body.name, 100));
    if (!done.ok) throw new AdminError(409, done.why);
    this.audit.add({ what: 'block artist', detail: `${done.artist.name} (${id})`, from: STANDING_TEXT[before.state], to: 'blocked by you' });
    return { ok: true, artist: done.artist, standing: whitelist.standing(id), message: `${done.artist.name} is blocked: none of their songs will be sent.` };
  }

  #unblockArtist(body: Record<string, unknown>): unknown {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const id = this.#channel(body);
    const done = whitelist.unblock(id);
    if (!done) throw new AdminError(404, 'You have not blocked that artist.');
    const after = whitelist.standing(id);
    this.audit.add({ what: 'unblock artist', detail: `${done.name} (${id})`, from: 'blocked by you', to: STANDING_TEXT[after.state] });
    return { ok: true, artist: done, standing: after, message: `${done.name} is not blocked any more (${STANDING_TEXT[after.state]}).` };
  }

  #unallowArtist(body: Record<string, unknown>): unknown {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const id = this.#channel(body);
    const done = whitelist.unallow(id);
    if (!done) throw new AdminError(404, 'You have not allowed that artist.');
    const after = whitelist.standing(id);
    this.audit.add({ what: 'remove allowed artist', detail: `${done.name} (${id})`, from: 'allowed by you', to: STANDING_TEXT[after.state] });
    return { ok: true, artist: done, standing: after, message: `${done.name} is not allowed by you any more (${STANDING_TEXT[after.state]}).` };
  }

  #videoId(body: Record<string, unknown>): string {
    const id = text(body.videoId, 20);
    if (!/^[\w-]{11}$/.test(id)) throw new AdminError(400, 'That is not a YouTube video id (11 letters, digits, - and _).');
    return id;
  }

  #allowSong(body: Record<string, unknown>): unknown {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const id = this.#videoId(body);
    this.#confirmedNoWomen(body, 'this song');
    const artistIds = Array.isArray(body.artistIds) ? body.artistIds.filter((one): one is string => typeof one === 'string').map((one) => text(one, 80)) : [];
    const before = whitelist.verdict(id, artistIds);
    // A credited artist you blocked, or one Zemer's list flags as a woman, stops a song whatever is said here: say so instead of saving it.
    if (!before.ok && (before.why === 'owner' || before.why === 'female')) throw new AdminError(409, `This song can't be allowed: ${verdictText(before)}.`);
    const done = whitelist.allowSong({ id, title: text(body.title, 120), artist: text(body.artist, 120), artistIds });
    if (!done.ok) throw new AdminError(409, done.why);
    this.audit.add({ what: 'allow song', detail: `${done.song.title}${done.song.artist ? ` — ${done.song.artist}` : ''} (${id})`, from: verdictText(before), to: done.verdict.ok ? 'allowed by you, no women credited' : `saved, but ${verdictText(done.verdict)}` });
    return {
      ok: true,
      song: done.song,
      verdict: verdictText(done.verdict),
      message: done.verdict.ok ? `"${done.song.title}" can be sent now.` : `"${done.song.title}" is saved, but it is still held back: ${verdictText(done.verdict)}.`,
    };
  }

  #unallowSong(body: Record<string, unknown>): unknown {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const id = this.#videoId(body);
    const done = whitelist.unallowSong(id);
    if (!done) throw new AdminError(404, 'You have not allowed that song.');
    this.audit.add({ what: 'remove allowed song', detail: `${done.title} (${id})`, from: 'allowed by you', to: 'not allowed by itself' });
    return { ok: true, message: `"${done.title}" is no longer allowed by itself.` };
  }

  #unblockSong(body: Record<string, unknown>): unknown {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const id = this.#videoId(body);
    this.#confirmedNoWomen(body, 'this song');
    const done = whitelist.unblockSong(id, text(body.title, 120));
    if (!done.ok) throw new AdminError(409, done.why);
    this.audit.add({ what: 'unblock song', detail: `${done.song.title} (${id})`, from: "blocked by Zemer's list", to: 'unblocked by you' });
    return { ok: true, message: `Zemer's block on "${done.song.title}" is lifted. Its artists must still be allowed.` };
  }

  #reblockSong(body: Record<string, unknown>): unknown {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const id = this.#videoId(body);
    const done = whitelist.reblockSong(id);
    if (!done) throw new AdminError(404, 'You have not unblocked that song.');
    this.audit.add({ what: 'block song again', detail: `${done.title} (${id})`, from: 'unblocked by you', to: "blocked by Zemer's list" });
    return { ok: true, message: `"${done.title}" is blocked again.` };
  }

  #setSetting(body: Record<string, unknown>): unknown {
    const settings = this.#need('settings', 'The settings');
    const key = text(body.key, 80);
    const done = settings.set(key, typeof body.value === 'string' ? body.value : '');
    if (!done.ok) throw new AdminError(400, done.error);
    this.audit.add({ what: `setting ${key}`, from: done.from ?? 'not set', to: done.value });
    this.#deps.log?.(`admin console: ${key} set to ${done.value}`);
    return { ok: true, value: done.value, message: `${key} is ${done.value} from now on.` };
  }

  #clearSetting(body: Record<string, unknown>): unknown {
    const settings = this.#need('settings', 'The settings');
    const key = text(body.key, 80);
    const done = settings.clear(key);
    if (!done.ok) throw new AdminError(400, done.error);
    if (done.from === null) return { ok: true, message: `${key} had no override.` };
    this.audit.add({ what: `setting ${key}`, from: done.from, to: 'back to the environment' });
    this.#deps.log?.(`admin console: ${key} back to the environment's value`);
    return { ok: true, message: `${key} follows Render's environment again.` };
  }

  #follow(body: Record<string, unknown>, adding: boolean): unknown {
    const follows = this.#need('follows', 'Following');
    const name = text(body.name, 100);
    const tokens = parseQuery(name);
    if (tokens.length === 0) throw new AdminError(400, 'Which artist? (a name is needed)');
    if (adding) {
      const artist = follows.follow(tokens);
      if (!artist) throw new AdminError(404, `No artist called "${name}" is in the catalog. Try the name as the site or the menus write it.`);
      this.audit.add({ what: 'follow artist', detail: artist.name, from: 'not followed', to: 'followed' });
      return { ok: true, message: `Following ${artist.name}.` };
    }
    const result = follows.unfollow(tokens);
    if (!result) throw new AdminError(404, `No artist called "${name}" is in the catalog.`);
    if (result.was) this.audit.add({ what: 'unfollow artist', detail: result.artist.name, from: 'followed', to: 'not followed' });
    return { ok: true, message: result.was ? `Stopped following ${result.artist.name}.` : `${result.artist.name} was not being followed.` };
  }

  // --- the Connect page: Google Messages, the chat, OneDrive ---

  async #connect(): Promise<unknown> {
    const connect = this.#need('connect', 'Setup');
    const oneDrive = connect.oneDrive;
    return {
      state: await connect.state(),
      phone: connect.knownPhone() ?? null,
      oneDrive: oneDrive ? oneDrive.status() : null,
      alerts: connect.testAlert !== undefined,
    };
  }

  /** What the bridge's bot has said, for the page's "what the bridge says" panel. It may not be ready yet (the homeserver is still starting). */
  async #connectLog(): Promise<unknown> {
    const connect = this.#need('connect', 'Setup');
    try {
      return { lines: (await connect.pair.log()).slice(-60) };
    } catch (err) {
      return { lines: [], error: err instanceof Error ? err.message : 'The bridge did not answer.' };
    }
  }

  async #connectStart(): Promise<unknown> {
    const connect = this.#need('connect', 'Setup');
    try {
      await connect.pair.send('login google');
    } catch (err) {
      throw new AdminError(503, err instanceof Error ? err.message : 'The bridge did not answer.');
    }
    this.audit.add({ what: 'started the Google Messages login' });
    return { ok: true, message: 'Asked the bridge to start the login. Its reply shows below.' };
  }

  /** The request the owner copied from Google Messages for web (it holds their Google session cookies): sent on, never kept, logged or echoed. */
  async #connectSend(body: Record<string, unknown>): Promise<unknown> {
    const connect = this.#need('connect', 'Setup');
    const text = typeof body.text === 'string' ? body.text : '';
    if (!text.trim()) throw new AdminError(400, 'Paste the copied request first.');
    if (text.length > 20_000) throw new AdminError(413, 'That is too long to be the request: copy only the one request the bridge names.');
    try {
      await connect.pair.send(text);
    } catch (err) {
      throw new AdminError(503, err instanceof Error ? err.message : 'The bridge did not answer.');
    }
    // How much was sent, nothing of what it said.
    this.audit.add({ what: 'sent a pasted request to the bridge', detail: `${text.length} characters` });
    return { ok: true, message: 'Sent. The bridge answers below; the request is deleted from the chat in a minute.' };
  }

  async #connectRooms(body: Record<string, unknown>): Promise<unknown> {
    const connect = this.#need('connect', 'Setup');
    const given = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : '';
    if (given !== '' && given.length < 7) throw new AdminError(400, 'That is too short to be a phone number (digits only, with the area code).');
    return { rooms: await connect.rooms(given === '' ? undefined : given) };
  }

  async #connectRoom(body: Record<string, unknown>): Promise<unknown> {
    const connect = this.#need('connect', 'Setup');
    const room = typeof body.room === 'string' ? body.room.trim() : '';
    if (!/^![^\s:]+:[^\s]+$/.test(room)) throw new AdminError(400, 'That is not a chat id (it looks like !abc:server).');
    await connect.setRoom(room);
    this.audit.add({ what: 'chose the chat the bot answers in', detail: room });
    return { ok: true, message: 'Chosen. The bot starts answering in that chat within a minute.' };
  }

  async #connectOneDrive(): Promise<unknown> {
    const oneDrive = this.#need('connect', 'Setup').oneDrive;
    if (!oneDrive) throw new AdminError(404, 'OneDrive is not set up on this host (ONEDRIVE_CLIENT_ID is not set in Render).');
    const login = await oneDrive.start();
    this.audit.add({ what: 'started the OneDrive sign-in' });
    return { ok: true, login };
  }

  async #connectTestAlert(): Promise<unknown> {
    const testAlert = this.#need('connect', 'Setup').testAlert;
    if (!testAlert) throw new AdminError(404, 'Alerts need the R2 settings in Render (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).');
    await testAlert();
    this.audit.add({ what: 'left a test alert' });
    return { ok: true, message: 'Left a test alert. The Worker mails it within five minutes.' };
  }

  // --- the owner's own user name and password ---

  #account(req: IncomingMessage): unknown {
    const { account, sessions, hasToken, cookieToken } = this.#signInParts();
    return {
      user: account.user ?? null,
      set: account.isSet,
      changedAt: account.changedAt ?? null,
      tokenSet: hasToken,
      sessions: sessions.list(cookieToken(req)),
      policy: { minPasswordChars: MIN_PASSWORD_CHARS, maxPasswordChars: MAX_PASSWORD_CHARS, minUserChars: MIN_USER_CHARS, maxUserChars: MAX_USER_CHARS },
    };
  }

  #signInParts() {
    const signIn = this.#need('signIn', 'Signing in');
    return { signIn, account: signIn.account, sessions: signIn.sessions, hasToken: signIn.hasToken, cookieToken: (req: IncomingMessage) => signIn.cookieToken(req) };
  }

  /** Asks for the password the owner signs in with now (or ADMIN_TOKEN): no change to the account is made on a session alone. */
  async #confirmCurrent(body: Record<string, unknown>): Promise<void> {
    const answer = await this.#signInParts().signIn.confirm(typeof body.current === 'string' ? body.current : '');
    if (answer === 'limited') throw new AdminError(429, 'Too many wrong passwords this minute. Wait a minute and try again.');
    if (answer !== 'ok') throw new AdminError(403, 'The current password is not right. Nothing was changed.');
  }

  async #setAccount(body: Record<string, unknown>): Promise<unknown> {
    const { account, sessions } = this.#signInParts();
    const user = typeof body.user === 'string' ? body.user.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const problem = AdminAccount.problem(user, password, this.#deps.env?.ADMIN_TOKEN?.trim());
    if (problem) throw new AdminError(400, problem);
    await this.#confirmCurrent(body);
    const before = account.user;
    await account.set(user, password);
    // Every browser signs in again with the new password (the page does it for this one).
    sessions.revokeAll();
    this.audit.add({ what: 'change sign-in', detail: 'user name and password', from: before ?? 'ADMIN_TOKEN only', to: user });
    this.#deps.log?.('admin console: the sign-in user name and password were changed');
    return { ok: true, user, message: `Done. You sign in as ${user} from now on.` };
  }

  async #clearAccount(body: Record<string, unknown>): Promise<unknown> {
    const { account, sessions, hasToken } = this.#signInParts();
    if (!account.isSet) throw new AdminError(404, 'You have not set your own user name and password.');
    // With no ADMIN_TOKEN in Render either, nothing could sign in any more.
    if (!hasToken) throw new AdminError(409, "The host has no ADMIN_TOKEN, so removing your sign-in would leave no way in. Set ADMIN_TOKEN in Render first.");
    await this.#confirmCurrent(body);
    const before = account.user;
    account.clear();
    sessions.revokeAll();
    this.audit.add({ what: 'remove own sign-in', from: before ?? '', to: 'ADMIN_TOKEN only' });
    this.#deps.log?.('admin console: the sign-in account was removed; ADMIN_TOKEN signs in');
    return { ok: true, message: 'Your user name and password are removed: ADMIN_TOKEN signs in again.' };
  }

  #signOutEverywhere(): unknown {
    const { sessions } = this.#signInParts();
    const count = sessions.revokeAll();
    this.audit.add({ what: 'signed out everywhere', to: `${count} browser${count === 1 ? '' : 's'}` });
    return { ok: true, message: 'Every browser is signed out.' };
  }

  // --- finding artists and songs on YouTube Music ---

  async #searchYouTube(body: Record<string, unknown>): Promise<unknown> {
    const whitelist = this.#need('whitelist', "Zemer's artist list");
    const youTube = this.#need('youTube', 'YouTube Music');
    const query = text(body.query, 100);
    if (query.length < 2) throw new AdminError(400, 'Type at least two letters to search for.');
    let found: { artists: unknown[]; songs: unknown[] } | undefined;
    const result = await this.#guard.run('youtube-search', 2_000, async () => {
      const [artists, songs] = await Promise.allSettled([youTube.searchArtists(query), youTube.searchRows(query)]);
      if (artists.status === 'rejected' && songs.status === 'rejected') {
        return { ok: false, summary: songs.reason instanceof Error ? songs.reason.message : 'YouTube Music did not answer.' };
      }
      const rows = songs.status === 'fulfilled' ? songs.value.slice(0, 20) : [];
      const named = new Map<string, { id: string; name: string; picture?: string; detail?: string }>();
      if (artists.status === 'fulfilled') for (const hit of artists.value.slice(0, 8)) named.set(hit.id, hit);
      // An artist the artists search missed but a song credits is offered too, without a picture.
      for (const { hit, names } of rows) for (const id of hit.artistIds) if (!named.has(id) && named.size < 12) named.set(id, { id, name: names[id] ?? id });
      const songView = rows.map(({ hit, names }) => {
        const verdict = whitelist.verdict(hit.videoId, hit.artistIds);
        return {
          videoId: hit.videoId,
          title: hit.title,
          artist: hit.artist,
          album: hit.album ?? null,
          cover: hit.cover ?? null,
          artistIds: hit.artistIds,
          artists: hit.artistIds.map((id) => ({ id, name: names[id] ?? id, standing: whitelist.standing(id).state })),
          verdict: verdictText(verdict),
          allowed: verdict.ok,
          canAllow: canAllow(verdict),
          allowedByYou: whitelist.songAllowed(hit.videoId),
        };
      });
      const artistView = [...named.values()].map((artist) => {
        const standing = whitelist.standing(artist.id);
        return {
          id: artist.id,
          name: artist.name,
          picture: artist.picture ?? null,
          detail: artist.detail ?? null,
          standing: standing.state,
          standingText: STANDING_TEXT[standing.state],
          samples: songView.filter((song) => song.artistIds.includes(artist.id)).slice(0, 3).map((song) => ({ videoId: song.videoId, title: song.title })),
        };
      });
      found = { artists: artistView, songs: songView };
      const problems = [artists, songs].flatMap((one) => (one.status === 'rejected' ? [one.reason instanceof Error ? one.reason.message : String(one.reason)] : []));
      return { ok: true, summary: `${artistView.length} artist${artistView.length === 1 ? '' : 's'} and ${songView.length} song${songView.length === 1 ? '' : 's'} for "${query}"${problems.length > 0 ? ` (${problems.join('; ')})` : ''}.` };
    });
    if (!result.ok || !found) throw new AdminError(502, result.summary);
    return { ok: true, query, summary: result.summary, ...found, turnedAway: youTube.turnsThisHostAway };
  }

  // --- actions ---

  async #action(name: string, body: Record<string, unknown>): Promise<unknown> {
    if (!(ACTIONS as readonly string[]).includes(name)) throw new AdminError(404, 'There is no such action.');
    const action = name as ActionName;
    if (action === 'digest-send' && body.confirm !== true) throw new AdminError(400, 'Sending the daily message now texts it to your chat: confirm it first. Nothing was sent.');
    const result = await this.#guard.run(action, COOLDOWN_MS[action], () => this.#work(action));
    // Sending something to the chat and asking Zemer's locked server are worth a line in the record; a read-only refresh is not.
    if (action === 'digest-send' || action === 'refresh-list-force') this.audit.add({ what: action === 'digest-send' ? 'sent the daily message now' : "forced a try at Zemer's artist list", to: result.ok ? result.summary : `failed: ${result.summary}` });
    this.#deps.log?.(`admin console: ${action}: ${result.summary}`);
    return { ok: true, action, result, state: this.#guard.snapshot(ACTIONS)[action] };
  }

  async #work(action: ActionName): Promise<ActionOutcome> {
    switch (action) {
      case 'refresh-list': {
        const done = await this.#need('whitelist', "Zemer's artist list").refreshNow({ force: false });
        return { ok: done.ok, summary: done.message };
      }
      case 'refresh-list-force': {
        const done = await this.#need('whitelist', "Zemer's artist list").refreshNow({ force: true });
        return { ok: done.ok, summary: done.message };
      }
      case 'refresh-releases': {
        const releases = this.#deps.releases;
        if (!releases) return { ok: false, summary: "Zemer's new releases are off (ZEMER_RELEASES=off) or the artist list is." };
        const jobs = this.#deps.jobs?.();
        if (jobs) await jobs.exclusive(() => jobs.syncReleases(0));
        else await releases.sync(0);
        const status = releases.status();
        return status.lastOk === false
          ? { ok: false, summary: status.problem ?? "Zemer's feed could not be read." }
          : { ok: true, summary: `${status.inFeed} in the feed, ${status.passed} pass the list, ${status.fresh} new, ${status.held.length} held back.` };
      }
      case 'sync-site': {
        const jobs = this.#need('jobs', 'The library jobs')();
        if (!jobs) return { ok: false, summary: 'music-table.com is off, so there is nothing to sync.' };
        const result = await jobs.exclusive(() => jobs.sync());
        return result ? { ok: true, summary: `${result.seen} recent posts read, ${result.fresh.length} new, ${result.songs} songs added.` } : { ok: false, summary: 'music-table.com did not answer; the log has the reason.' };
      }
      case 'prefetch': {
        const jobs = this.#need('jobs', 'The library jobs')();
        if (!jobs) return { ok: false, summary: 'music-table.com is off, so no songs are kept ready.' };
        if (!jobs.report().cache) return { ok: true, summary: 'Nothing to do: this host keeps no songs ready (PREFETCH_MB is 0, because its disk is wiped at every restart).' };
        await jobs.exclusive(() => jobs.keepReady());
        const cache = jobs.report().cache;
        return { ok: true, summary: `Songs kept ready: ${cache?.files ?? 0} on disk (${Math.round((cache?.bytes ?? 0) / 1048576)} MB).` };
      }
      case 'digest-preview': {
        const jobs = this.#need('jobs', 'The library jobs')();
        if (!jobs) return { ok: false, summary: 'music-table.com is off, so there is no daily message.' };
        const digest = await jobs.exclusive(() => jobs.previewDigest());
        const lines = digest.replies.map(replyText).filter((line) => line !== '');
        return { ok: true, summary: lines.length === 0 ? 'Nothing new: the daily message would not be sent.' : `The daily message would say this (${digest.slugs.length + digest.releaseIds.length} new). Nothing was sent.`, lines };
      }
      case 'digest-send': {
        const jobs = this.#need('jobs', 'The library jobs')();
        if (!jobs) return { ok: false, summary: 'music-table.com is off, so there is no daily message.' };
        const count = await jobs.exclusive(() => jobs.sendDigest());
        return { ok: true, summary: count > 0 ? `Sent the daily message with ${count} new release${count === 1 ? '' : 's'}.` : 'Nothing new, or the chat could not take it right now (the log says which). Today\'s scheduled message counts as done if nothing was new.' };
      }
      case 'alerts-check': {
        const jobs = this.#need('jobs', 'The library jobs')();
        if (!jobs) return { ok: false, summary: 'music-table.com is off, so there are no alerts.' };
        if (jobs.report().inQuietHours) return { ok: true, summary: 'It is in the quiet hours, so no alerts go out until they end.' };
        const count = await jobs.exclusive(() => jobs.alertFollowed());
        return { ok: true, summary: count > 0 ? `Sent ${count} alert${count === 1 ? '' : 's'}.` : 'No new releases by the artists you follow.' };
      }
    }
  }
}

/** A reply of the daily message as a line of plain text. */
function replyText(reply: Reply): string {
  switch (reply.kind) {
    case 'text':
      return reply.text;
    case 'image':
      return `[picture] ${reply.caption ? `${reply.caption.title}${reply.caption.artist ? ` — ${reply.caption.artist}` : ''}` : ''}`.trim();
    case 'collage':
      return `[collage of ${reply.images.length} covers]`;
    case 'album':
      return `[album] ${reply.title} — ${reply.artist}`;
    case 'audio':
      return `[audio] ${reply.title ?? ''}`.trim();
  }
}

/** The console the running bot registers with. */
export const adminConsole = new AdminConsole();
