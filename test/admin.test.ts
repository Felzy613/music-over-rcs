import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { AdminConsole, isSameSite } from '../src/admin/console.ts';
import { LogRing, redact, secretValues, tapConsole } from '../src/admin/log-ring.ts';
import { LIVE_KEYS, LiveSettings, SETTINGS } from '../src/admin/settings.ts';
import { Catalog } from '../src/catalog.ts';
import { openFrontDoor, type FrontDoor } from '../src/cloud/front-door.ts';
import { createCloudWeb } from '../src/cloud/web.ts';
import { catalogFollows } from '../src/library/follows.ts';
import { LibraryJobs, STATE } from '../src/library/jobs.ts';
import { MusicTable } from '../src/sources/music-table.ts';
import { YouTubeMusic } from '../src/sources/youtube-music.ts';
import { createNewReleases, ZemerReleases } from '../src/sources/zemer-releases.ts';
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import type { Reply } from '../src/types.ts';
import { startMockMusicTable, type MockMusicTable } from './helpers/mock-music-table.ts';
import { artistId, startMockYouTubeMusic, type MockYouTubeMusic } from './helpers/mock-youtube-music.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { startMockZemerReleases, type MockFeedRelease, type MockZemerReleases } from './helpers/mock-zemer-releases.ts';

// The owner's management console (src/admin/): who may reach it, what it shows, what its buttons do, and that the artist rules
// it edits stay the strict ones.

const TOKEN = 'console-test-password-7d3f';
const SECRET_IN_ENV = 'R2-secret-value-abc123';
const LISTED: MockArtist[] = [
  { id: artistId('The Night Owls'), name: 'The Night Owls' },
  { id: artistId('Rina Cohen'), name: 'Rina Cohen', female: true },
  { id: artistId('Mira Vale'), name: 'Mira Vale' },
];
const night = artistId('The Night Owls');
const rina = artistId('Rina Cohen');
const newcomer = artistId('Newcomer Band');
const stranger = artistId('Stranger Band');

const basic = (password: string) => `Basic ${Buffer.from(`owner:${password}`).toString('base64')}`;

async function serve(server: Server): Promise<{ url: string; close(): Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const releasesFeed = (): MockFeedRelease[] => [
  { artistId: night, artistName: 'The Night Owls', title: 'Owl Song', browseId: 'MPREb_owls0001', uploadDate: '2026-11-05T10:00:00-05:00', trackCount: 1, sampleVideoId: 'owlsong0001' },
  { artistId: newcomer, artistName: 'Newcomer Band', title: 'New Sound', browseId: 'MPREb_newcm001', uploadDate: '2026-11-05T09:00:00-05:00', trackCount: 1, sampleVideoId: 'newsound001' },
  { artistId: rina, artistName: 'Rina Cohen', title: 'Her Single', browseId: 'MPREb_rina0001', uploadDate: '2026-11-04T09:00:00-05:00', trackCount: 1, sampleVideoId: 'hersingle01' },
];

describe('the management console', () => {
  let content: MockZemerContent;
  let youMock: MockYouTubeMusic;
  let feed: MockZemerReleases;
  let site: MockMusicTable;
  let catalog: Catalog;
  let whitelist: ZemerWhitelist;
  let admin: AdminConsole;
  let jobs: LibraryJobs;
  let door: { url: string; close(): Promise<void> };
  let ring: LogRing;
  let clock: number;
  let announced: Reply[][];
  let env: NodeJS.ProcessEnv;

  before(async () => {
    content = await startMockZemerContent(LISTED);
    youMock = await startMockYouTubeMusic([
      { videoId: 'owlsong0001', title: 'Owl Song', artists: ['The Night Owls'] },
      { videoId: 'newsound001', title: 'New Sound', artists: ['Newcomer Band'], album: 'Fresh' },
      { videoId: 'duet0000001', title: 'Newcomer Duet', artists: ['Newcomer Band', 'Rina Cohen'] },
      { videoId: 'strangerson', title: 'Stranger Song', artists: ['Stranger Band'] },
    ]);
    feed = await startMockZemerReleases(releasesFeed());
    site = await startMockMusicTable([]);
  });
  after(async () => {
    await Promise.all([content.close(), youMock.close(), feed.close(), site.close()]);
  });

  /** Everything the bot assembles in matrix-main.ts, in memory, with the real console in front of it. */
  beforeEach(async () => {
    content.reset(LISTED);
    content.blocked.global = ['blockedsong'];
    feed.reset(releasesFeed());
    youMock.reset();
    clock = Date.parse('2026-11-06T12:00:00Z');
    announced = [];
    env = { ADMIN_TOKEN: TOKEN, R2_SECRET_ACCESS_KEY: SECRET_IN_ENV, DIGEST_TIME: '09:00', QUIET_HOURS: '22:00-07:00' };
    catalog = new Catalog(':memory:');
    ring = new LogRing({ secrets: () => secretValues(env) });
    whitelist = new ZemerWhitelist({ baseUrl: content.url, state: catalog, checkEveryMs: 0, retryAfterMs: 0, now: () => clock });
    await whitelist.ready();
    const releases = createNewReleases({ feed: new ZemerReleases({ url: `${feed.url}/?page=zemer_releases` }), whitelist, catalog, now: () => new Date(clock) });
    admin = new AdminConsole({ now: () => clock });
    const settings = admin.liveSettings(catalog, env);
    jobs = new LibraryJobs({
      musicTable: new MusicTable({ baseUrl: site.url, minIntervalMs: 0 }),
      catalog,
      announce: async (replies) => void announced.push(replies),
      digestAt: () => settings.digestAt({ hour: 9, minute: 0 }),
      quiet: () => settings.quiet({ from: { hour: 22, minute: 0 }, to: { hour: 7, minute: 0 } }),
      fetchAudio: async () => {
        throw new Error('no downloads in these tests');
      },
      releases,
      now: () => new Date(clock),
    });
    admin.provide({
      catalog,
      env,
      status: () => ({ phase: 'running', botEnabled: true, uptimeSeconds: 42, problems: [{ key: 'site', message: 'music-table.com is slow', since: '2026-11-06T10:00:00Z' }], timings: ['timeline: "search x"'], bridge: { state: 'CONNECTED' } }),
      startedAt: clock - 42_000,
      log: (line) => ring.add(line),
      ring,
      whitelist,
      youTube: new YouTubeMusic({ baseUrl: youMock.url }),
      releases,
      jobs: () => jobs,
      follows: catalogFollows(catalog),
    });
    door = await serve(
      createCloudWeb({
        adminToken: TOKEN,
        admin,
        pageHtml: '<!doctype html><title>setup</title>',
        status: () => ({}),
        pair: { send: async () => {}, log: async () => [] },
        rooms: () => [],
        setRoom: () => {},
        canImport: () => false,
        importCatalog: () => ({}),
      }),
    );
  });
  afterEach(async () => {
    await door.close();
    catalog.close();
  });

  const tick = (ms: number) => void (clock += ms);
  const authed = { authorization: basic(TOKEN) };
  const get = (path: string, headers: Record<string, string> = authed) => fetch(door.url + path, { headers });
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
    fetch(door.url + path, { method: 'POST', headers: { ...authed, 'content-type': 'application/json', 'x-admin-console': '1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const json = async (res: Response) => (await res.json()) as any;

  describe('who may reach it', () => {
    test('nothing without the admin password: not the page, not the API, not a change', async () => {
      for (const path of ['/admin/', '/admin/app.js', '/admin/app.css', '/admin/api/overview']) {
        assert.equal((await fetch(door.url + path)).status, 401, path);
        assert.equal((await fetch(door.url + path, { headers: { authorization: basic('wrong') } })).status, 401, path);
      }
      const res = await fetch(door.url + '/admin/api/settings/set', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-console': '1' }, body: '{}' });
      assert.equal(res.status, 401);
      assert.match(res.headers.get('www-authenticate') ?? '', /^Basic/);
      assert.equal((await fetch(door.url + '/admin/api/overview', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200, 'a bearer password works too');
    });

    test('serves the page with a policy that allows no inline script, and its two files', async () => {
      const page = await get('/admin/');
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
      const policy = page.headers.get('content-security-policy') ?? '';
      assert.match(policy, /script-src 'self'/);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
      assert.match(policy, /frame-ancestors 'none'/);
      assert.doesNotMatch(await page.text(), /<script>|onclick=|<style/i, 'the page has no inline script or style');
      assert.equal(page.headers.get('x-frame-options'), 'DENY');
      const script = await get('/admin/app.js');
      assert.match(script.headers.get('content-type') ?? '', /javascript/);
      assert.equal((await get('/admin/app.css')).status, 200);
      const etag = script.headers.get('etag')!;
      assert.equal((await get('/admin/app.js', { ...authed, 'if-none-match': etag })).status, 304);
      assert.equal((await fetch(door.url + '/admin', { headers: authed, redirect: 'manual' })).headers.get('location'), '/admin/');
    });

    test('the page builds everything with textContent: no innerHTML, outerHTML, document.write or eval', () => {
      const code = readFileSync(new URL('../src/admin/site/app.js', import.meta.url), 'utf8');
      assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
    });

    test('a change is refused without the console header, from another site, or without JSON', async () => {
      const body = { key: 'DIGEST_TIME', value: '10:00' };
      const route = '/admin/api/settings/set';
      assert.equal((await fetch(door.url + route, { method: 'POST', headers: { ...authed, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status, 403, 'no X-Admin-Console header');
      assert.equal((await post(route, body, { 'x-admin-console': '0' })).status, 403);
      assert.equal((await post(route, body, { origin: 'https://evil.example' })).status, 403, 'another origin');
      assert.equal((await post(route, body, { origin: 'null' })).status, 403, 'an opaque origin');
      assert.equal((await post(route, body, { 'sec-fetch-site': 'cross-site' })).status, 403);
      assert.equal((await post(route, body, { 'sec-fetch-site': 'same-site' })).status, 403, 'a sibling site is another site');
      assert.equal((await post(route, body, { 'content-type': 'text/plain' })).status, 415);
      assert.equal((await post(route, 'not json')).status, 400);
      assert.equal((await post(route, '[1,2]')).status, 400, 'an array is not an object');
      assert.equal(admin.audit.list().length, 0, 'none of them changed anything');
      assert.equal(new LiveSettings({ env, state: catalog }).override('DIGEST_TIME'), undefined);

      const host = new URL(door.url).host;
      assert.equal((await post(route, body, { origin: door.url, 'sec-fetch-site': 'same-origin' })).status, 200, 'this site, as a browser says it');
      assert.equal((await post(route, body, { origin: `http://${host}` })).status, 200);
      assert.equal(admin.audit.list().length, 2);
    });

    test('a change from the browser needs a preflight another site cannot pass: the door never answers OPTIONS', async () => {
      const res = await fetch(door.url + '/admin/api/settings/set', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-admin-console,content-type' } });
      assert.ok(res.status === 401 || res.status === 404 || res.status === 405, `status ${res.status}`);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
    });

    test('bodies are limited to 64 KB and changes to 60 a minute', async () => {
      const big = await post('/admin/api/settings/set', { key: 'DIGEST_TIME', value: 'x'.repeat(70_000) });
      assert.equal(big.status, 413);
      for (let i = 0; i < 59; i += 1) assert.equal((await post('/admin/api/settings/clear', { key: 'DIGEST_TIME' })).status, 200);
      assert.equal((await post('/admin/api/settings/clear', { key: 'DIGEST_TIME' })).status, 429, 'the 61st in a minute');
      tick(61_000);
      assert.equal((await post('/admin/api/settings/clear', { key: 'DIGEST_TIME' })).status, 200);
    });

    test('isSameSite: what the browser sends decides, and a script that sends nothing is let through by the other checks', () => {
      assert.equal(isSameSite({}), true);
      assert.equal(isSameSite({ origin: 'https://a.example', host: 'a.example' }), true);
      assert.equal(isSameSite({ origin: 'https://a.example', host: '127.0.0.1:8081', 'x-forwarded-host': 'a.example' }), true, 'behind the front door');
      assert.equal(isSameSite({ origin: 'https://a.example', host: '127.0.0.1:8081' }), false);
      assert.equal(isSameSite({ origin: 'https://evil.example', host: 'a.example' }), false);
      assert.equal(isSameSite({ origin: 'not a url', host: 'a.example' }), false);
      assert.equal(isSameSite({ 'sec-fetch-site': 'same-origin' }), true);
      assert.equal(isSameSite({ 'sec-fetch-site': 'none' }), false);
    });

    test('behind the host’s front door the visitor’s own address decides, and a forged one does not', async () => {
      const back = new URL(door.url);
      const front: FrontDoor = await openFrontDoor({ port: 0, host: '127.0.0.1', upstream: { port: Number(back.port), host: '127.0.0.1' } });
      try {
        const base = `http://127.0.0.1:${front.port}`;
        const change = (headers: Record<string, string>) =>
          fetch(`${base}/admin/api/settings/clear`, { method: 'POST', headers: { ...authed, 'content-type': 'application/json', 'x-admin-console': '1', ...headers }, body: JSON.stringify({ key: 'DIGEST_TIME' }) });
        assert.equal((await change({ origin: base })).status, 200, 'the page on the front door’s own address');
        assert.equal((await change({ origin: 'https://evil.example' })).status, 403);
        assert.equal((await change({ origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' })).status, 403, 'the front door replaces what the visitor sent');
        assert.equal((await fetch(`${base}/admin/api/overview`, { headers: authed })).status, 200);
        assert.equal((await fetch(`${base}/admin/api/overview`)).status, 401);
      } finally {
        await front.close();
      }
    });
  });

  describe('what it shows', () => {
    test('the overview: the status, uptime, traffic against the alert, the list, the releases and the jobs', async () => {
      env.RENDER_GIT_COMMIT = 'abcdef0123456789';
      const now = new Date();
      catalog.setState(`usage.${now.toISOString().slice(0, 7)}.sent_bytes`, String(1500 * 1048576));
      await jobs.syncReleases(0);
      const d = await json(await get('/admin/api/overview'));
      assert.equal(d.status.phase, 'running');
      assert.equal(d.status.problems[0].since, '2026-11-06T10:00:00Z');
      assert.deepEqual(d.commit, { sha: 'abcdef0123', source: 'Render' });
      assert.equal(d.traffic.alertMb, 4000);
      assert.equal(d.traffic.sentMb, 1500);
      assert.equal(d.list.loaded, true);
      assert.equal(d.list.size.artists, 3);
      assert.equal(d.releases.lastOk, true);
      assert.equal(d.jobs.digest.at, '09:00');
      assert.equal(d.jobs.quiet, '22:00-07:00');
      assert.equal(d.botReady, true);
      assert.equal(typeof d.startedAt, 'number');
      assert.deepEqual(Object.keys(d.actions).sort(), ['alerts-check', 'digest-preview', 'digest-send', 'prefetch', 'refresh-list', 'refresh-list-force', 'refresh-releases', 'sync-site']);
    });

    test('the artist page: the list’s state, the saved copy searchable, the owner’s lists with times', async () => {
      whitelist.admit(newcomer, 'Newcomer Band');
      whitelist.refuse(stranger, 'Stranger Band');
      const d = await json(await get('/admin/api/artists?q=mira'));
      assert.equal(d.report.frozen, false);
      assert.equal(d.report.size.artists, 3);
      assert.equal(d.report.gate, content.gate);
      assert.deepEqual(d.list.matches.map((a: any) => a.name), ['Mira Vale']);
      assert.equal(d.list.total, 1);
      const all = await json(await get('/admin/api/artists'));
      assert.equal(all.list.total, 3);
      assert.deepEqual(all.list.matches.find((a: any) => a.id === rina), { id: rina, name: 'Rina Cohen', altName: null, female: true, owner: null });
      assert.equal(all.owner.allowed[0].id, newcomer);
      assert.equal(all.owner.allowed[0].at, clock);
      assert.equal(all.owner.blocked[0].id, stranger);
    });

    test('a frozen list says so, with the error and when it will be asked again', async () => {
      content.refusing = true;
      tick(10 * 60_000);
      await whitelist.refreshNow({ force: true });
      const d = await json(await get('/admin/api/artists'));
      assert.equal(d.report.frozen, true);
      assert.match(d.report.lastError, /HTTP 403/);
      assert.ok(d.report.nextAttemptAt > clock);
      assert.ok(d.report.refusedSince > 0);
    });

    test('the library: table counts, the songs with what the bot would do, the stored releases and the ones held back with why', async () => {
      catalog.add({ title: 'Owl Song', artist: 'The Night Owls', url: youMock.url + '/watch?v=owlsong0001', artistIds: [night] });
      catalog.add({ title: 'Stranger Song', artist: 'Stranger Band', url: youMock.url + '/watch?v=strangerson', artistIds: [stranger] });
      catalog.add({ title: 'Plain', artist: 'Someone', url: 'https://www.music-table.com/post/x#0' });
      await jobs.syncReleases(0);
      const d = await json(await get('/admin/api/library?q=song'));
      assert.equal(d.counts.tracks, 3);
      const owl = d.search.tracks.find((t: any) => t.title === 'Owl Song');
      assert.deepEqual([owl.videoId, owl.allowed, owl.verdict], ['owlsong0001', true, 'may be sent']);
      const stranger1 = d.search.tracks.find((t: any) => t.title === 'Stranger Song');
      assert.deepEqual([stranger1.allowed, stranger1.verdict], [false, 'none of the credited artists is on the list']);
      assert.equal(stranger1.canAllow, true);
      assert.equal(d.recent.length, 3);
      assert.equal(d.recent.find((t: any) => t.title === 'Plain').videoId, null, 'a music-table.com song has no artist list to check');
      assert.deepEqual(d.releases.stored.map((r: any) => [r.title, r.inNew]), [['Owl Song', true]]);
      const held = d.releases.status.held;
      assert.deepEqual(held.map((r: any) => [r.title, r.why]).sort(), [
        ['Her Single', "Zemer's list flags the artist as a woman"],
        ['New Sound', "the artist isn't on the saved list"],
      ]);
      assert.equal(d.jobs.following, 0);
    });

    test('a waiting artist’s release says it is waiting for your word, and is in “new” once you allow them', async () => {
      content.refusing = true;
      tick(10 * 60_000);
      await whitelist.refreshNow({ force: true });
      const res = await post('/admin/api/actions/refresh-releases');
      assert.equal(res.status, 200);
      const d = await json(await get('/admin/api/library'));
      const sound = d.releases.status.held.find((r: any) => r.title === 'New Sound');
      assert.equal(sound.waiting, true);
      assert.match(sound.why, /waiting for your word/);
      await post('/admin/api/artists/allow', { id: newcomer, name: 'Newcomer Band', noWomenConfirmed: true });
      tick(60_000);
      await post('/admin/api/actions/refresh-releases');
      const after = await json(await get('/admin/api/library'));
      assert.equal(after.releases.stored.find((r: any) => r.title === 'New Sound').inNew, true);
    });

    test('the log: the last lines, filtered, with no secret in them', async () => {
      ring.add('plain line');
      ring.add(`using the key ${SECRET_IN_ENV} now`);
      ring.add('Authorization: Bearer abcdefghijklmnop1234');
      ring.add('a failure', 'error');
      const all = await json(await get('/admin/api/log'));
      const text = JSON.stringify(all);
      assert.ok(!text.includes(SECRET_IN_ENV));
      assert.ok(!text.includes('abcdefghijklmnop1234'));
      assert.ok(all.lines.some((l: any) => l.text === 'plain line'));
      const problems = await json(await get('/admin/api/log?level=problems'));
      assert.deepEqual(problems.lines.map((l: any) => l.text), ['a failure']);
      const found = await json(await get('/admin/api/log?search=PLAIN'));
      assert.deepEqual(found.lines.map((l: any) => l.text), ['plain line']);
    });

    test('before the bot is up the parts that need it say so, and the host’s part still works', async () => {
      const bare = new AdminConsole();
      bare.provide({ catalog, env, status: () => ({ phase: 'setup' }), startedAt: clock, log: () => {}, ring });
      const side = await serve(createCloudWeb({ adminToken: TOKEN, admin: bare, pageHtml: '', status: () => ({}), pair: { send: async () => {}, log: async () => [] }, rooms: () => [], setRoom: () => {}, canImport: () => false, importCatalog: () => ({}) }));
      try {
        const overview = await fetch(side.url + '/admin/api/overview', { headers: authed });
        assert.equal(overview.status, 200);
        const d = await json(overview);
        assert.equal(d.status.phase, 'setup');
        assert.equal(d.botReady, false);
        assert.equal(d.list, null);
        const artists = await fetch(side.url + '/admin/api/artists', { headers: authed });
        assert.equal(artists.status, 503);
        assert.match((await json(artists)).error, /still starting/);
        const change = await fetch(side.url + '/admin/api/artists/block', { method: 'POST', headers: { ...authed, 'content-type': 'application/json', 'x-admin-console': '1' }, body: JSON.stringify({ id: newcomer, name: 'x' }) });
        assert.equal(change.status, 503);
      } finally {
        await side.close();
      }
    });
  });

  describe('the refreshes and the daily message', () => {
    test('refreshing Zemer’s artist list asks once; with the server refusing it waits out the three hours; the forced try is one more ask', async () => {
      const first = await json(await post('/admin/api/actions/refresh-list'));
      assert.equal(first.result.ok, true);
      assert.match(first.result.summary, /3 artists/);

      content.refusing = true;
      tick(60_000);
      content.requests = [];
      const refused = await json(await post('/admin/api/actions/refresh-list'));
      assert.equal(refused.result.ok, false);
      assert.match(refused.result.summary, /turned the bot away/);
      assert.equal(content.requests.length, 1);

      tick(60_000);
      const waiting = await json(await post('/admin/api/actions/refresh-list'));
      assert.match(waiting.result.summary, /not asked again for about 3 hours/);
      assert.equal(content.requests.length, 1, 'the back-off held');

      const forced = await json(await post('/admin/api/actions/refresh-list-force'));
      assert.equal(forced.result.ok, false);
      assert.equal(content.requests.length, 2);
      assert.equal(admin.audit.list()[0]?.what, "forced a try at Zemer's artist list", 'the forced try is on record');

      const again = await post('/admin/api/actions/refresh-list-force');
      assert.equal(again.status, 429, 'a forced try is allowed once in five minutes');
      assert.match((await json(again)).error, /ran a moment ago/);
    });

    test('an action cannot run twice at once, and not again until its cooldown has passed', async () => {
      content.delayMs = 200;
      tick(5 * 60_000);
      const [a, b] = await Promise.all([post('/admin/api/actions/refresh-list'), post('/admin/api/actions/refresh-list')]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409]);
      assert.match((await json(a.status === 409 ? a : b)).error, /running already/);
      const soon = await post('/admin/api/actions/refresh-list');
      assert.equal(soon.status, 429);
      const state = (await json(await get('/admin/api/overview'))).actions['refresh-list'];
      assert.equal(state.running, false);
      assert.equal(state.last.ok, true);
      assert.ok(state.readyAt > clock);
      tick(11_000);
      assert.equal((await post('/admin/api/actions/refresh-list')).status, 200);
    });

    test('refreshing the new releases reads the feed again and says what passed and what was held back', async () => {
      const d = await json(await post('/admin/api/actions/refresh-releases'));
      assert.equal(d.result.ok, true);
      assert.equal(d.result.summary, '3 in the feed, 1 pass the list, 1 new, 2 held back.');
      feed.failing = true;
      tick(60_000);
      const failed = await json(await post('/admin/api/actions/refresh-releases'));
      assert.equal(failed.result.ok, false);
      assert.match(failed.result.summary, /HTTP 500/);
    });

    test('syncing the site, getting songs ready and checking alerts say what they did', async () => {
      const sync = await json(await post('/admin/api/actions/sync-site'));
      assert.equal(sync.result.ok, true);
      assert.match(sync.result.summary, /posts read, 0 new/);
      assert.ok(catalog.getState(STATE.lastSync), 'the sync was recorded');
      const prefetch = await json(await post('/admin/api/actions/prefetch'));
      assert.equal(prefetch.result.ok, true);
      assert.match(prefetch.result.summary, /keeps no songs ready/);
      const alerts = await json(await post('/admin/api/actions/alerts-check'));
      assert.equal(alerts.result.ok, true);
      assert.match(alerts.result.summary, /quiet hours|No new releases/);
    });

    test('the daily message can be previewed without sending, and sent only after a confirmation', async () => {
      const preview = await json(await post('/admin/api/actions/digest-preview'));
      assert.equal(preview.result.ok, true);
      assert.match(preview.result.summary, /Nothing was sent|Nothing new/);
      assert.equal(announced.length, 0, 'a preview sends nothing');

      const unconfirmed = await post('/admin/api/actions/digest-send', {});
      assert.equal(unconfirmed.status, 400);
      assert.equal(announced.length, 0);

      const sent = await json(await post('/admin/api/actions/digest-send', { confirm: true }));
      assert.equal(sent.result.ok, true);
      assert.equal(announced.length, 1, 'the Owl Song release went out');
      assert.ok(announced[0]!.some((reply) => reply.kind === 'text' && /Owl Song/.test(reply.text)));
      assert.equal(admin.audit.list()[0]?.what, 'sent the daily message now');
    });

    test('a manual job waits for the round that is running instead of overlapping it', async () => {
      const order: string[] = [];
      let release!: () => void;
      const slow = new Promise<void>((resolve) => (release = resolve));
      const first = jobs.exclusive(async () => {
        order.push('first start');
        await slow;
        order.push('first end');
      });
      const second = jobs.exclusive(async () => void order.push('second'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(order, ['first start']);
      release();
      await Promise.all([first, second]);
      assert.deepEqual(order, ['first start', 'first end', 'second']);
      assert.equal(jobs.report().busy, false);
    });

    test('an action that does not exist, and one that is off, say so', async () => {
      assert.equal((await post('/admin/api/actions/format-everything')).status, 404);
      assert.equal((await post('/admin/api/nothing')).status, 404);
      assert.equal((await get('/admin/api/nothing')).status, 404);
    });
  });

  describe('deciding who may be sent', () => {
    test('allowing an artist needs the owner’s word that no women are credited, and never defaults to yes', async () => {
      for (const word of [undefined, false, 'true', 1, 'yes']) {
        const res = await post('/admin/api/artists/allow', { id: newcomer, name: 'Newcomer Band', ...(word === undefined ? {} : { noWomenConfirmed: word }) });
        assert.equal(res.status, 400, `noWomenConfirmed=${String(word)}`);
        assert.match((await json(res)).error, /Confirm that no women are credited/);
      }
      assert.equal(whitelist.standing(newcomer).state, 'unknown');
      assert.equal(admin.audit.list().length, 0);
      const res = await post('/admin/api/artists/allow', { id: newcomer, name: 'Newcomer Band', noWomenConfirmed: true });
      assert.equal(res.status, 200);
      assert.equal(whitelist.standing(newcomer).state, 'allowed');
      assert.equal(whitelist.allows('x', [newcomer]), true);
      const entry = admin.audit.list()[0]!;
      assert.deepEqual([entry.what, entry.detail, entry.from, entry.at], ['allow artist', `Newcomer Band (${newcomer})`, 'not on the list', clock]);
    });

    test('an allow cannot lift Zemer’s female flag, and a real channel id is needed', async () => {
      const woman = await post('/admin/api/artists/allow', { id: rina, name: 'Rina Cohen', noWomenConfirmed: true });
      assert.equal(woman.status, 409);
      assert.match((await json(woman)).error, /flags this artist as a woman/);
      assert.equal(whitelist.allows('x', [rina]), false);
      const bad = await post('/admin/api/artists/allow', { id: 'not-a-channel', name: 'X', noWomenConfirmed: true });
      assert.equal(bad.status, 409);
      assert.equal((await post('/admin/api/artists/allow', { name: 'X', noWomenConfirmed: true })).status, 400);
      assert.equal(admin.audit.list().length, 0);
    });

    test('blocking, unblocking and taking an allow away work for anyone, and a block always wins', async () => {
      await post('/admin/api/artists/allow', { id: newcomer, name: 'Newcomer Band', noWomenConfirmed: true });
      const blocked = await json(await post('/admin/api/artists/block', { id: newcomer, name: 'Newcomer Band' }));
      assert.equal(blocked.standing.state, 'blocked');
      assert.equal(whitelist.allows('x', [newcomer]), false, 'the block replaced the allow');
      const listed = await json(await post('/admin/api/artists/block', { id: night, name: 'The Night Owls' }));
      assert.equal(listed.standing.state, 'blocked');
      assert.deepEqual(whitelist.verdict('x', [night]), { ok: false, why: 'owner' });
      assert.equal((await post('/admin/api/artists/block', { id: stranger, name: 'Stranger Band' })).status, 200, 'someone nobody has mentioned');

      const un = await json(await post('/admin/api/artists/unblock', { id: night }));
      assert.equal(un.standing.state, 'listed');
      assert.equal(whitelist.allows('x', [night]), true);
      assert.equal((await post('/admin/api/artists/unblock', { id: night })).status, 404);
      assert.equal((await post('/admin/api/artists/unallow', { id: night })).status, 404);

      await post('/admin/api/artists/unblock', { id: newcomer });
      assert.equal(whitelist.allows('x', [newcomer]), false, 'unblocking is not allowing');
      assert.deepEqual(admin.audit.list().map((e) => e.what), ['unblock artist', 'unblock artist', 'block artist', 'block artist', 'block artist', 'allow artist'], 'every change is on record, newest first');
    });

    test('a waiting artist is allowed from the console like any other', async () => {
      content.refusing = true;
      tick(10 * 60_000);
      await whitelist.refreshNow({ force: true });
      whitelist.consider(newcomer, 'Newcomer Band');
      const before = await json(await get('/admin/api/artists'));
      assert.deepEqual(before.owner.waiting.map((a: any) => [a.id, a.since]), [[newcomer, clock]]);
      assert.equal((await post('/admin/api/artists/allow', { id: newcomer, name: 'Newcomer Band', noWomenConfirmed: true })).status, 200);
      assert.deepEqual(whitelist.pending(), []);
    });

    test('searching YouTube Music shows artists with their channel id and picture, sample songs, and where each stands', async () => {
      whitelist.refuse(stranger, 'Stranger Band');
      const d = await json(await post('/admin/api/youtube/search', { query: 'newcomer' }));
      assert.equal(d.ok, true);
      const band = d.artists.find((a: any) => a.id === newcomer);
      assert.equal(band.name, 'Newcomer Band');
      assert.match(band.picture, /^https:\/\/yt3\.googleusercontent\.com\//);
      assert.equal(band.detail, 'Artist • 1.2K subscribers');
      assert.equal(band.standing, 'unknown');
      assert.deepEqual(band.samples.map((s: any) => s.videoId).sort(), ['duet0000001', 'newsound001']);
      const sound = d.songs.find((s: any) => s.videoId === 'newsound001');
      assert.deepEqual([sound.allowed, sound.verdict], [false, 'none of the credited artists is on the list']);
      const duet = d.songs.find((s: any) => s.videoId === 'duet0000001');
      assert.equal(duet.verdict, "a credited artist is flagged as a woman on Zemer's list");
      assert.deepEqual([duet.canAllow, sound.canAllow], [false, true], 'a song with a woman credited cannot be allowed, so the page offers no button');
      assert.deepEqual(duet.artists.map((a: any) => [a.name, a.standing]), [['Newcomer Band', 'unknown'], ['Rina Cohen', 'female']]);
      assert.equal(youMock.searches.length, 2, 'one songs search and one artists search');

      tick(10_000);
      const strangerSearch = await json(await post('/admin/api/youtube/search', { query: 'stranger' }));
      assert.equal(strangerSearch.artists.find((a: any) => a.id === stranger).standing, 'blocked');
    });

    test('a search for too little, a failing YouTube, and searches too close together are refused politely', async () => {
      assert.equal((await post('/admin/api/youtube/search', { query: 'a' })).status, 400);
      youMock.failSearch = true;
      const failed = await post('/admin/api/youtube/search', { query: 'newcomer' });
      assert.equal(failed.status, 502);
      youMock.failSearch = false;
      const quick = await post('/admin/api/youtube/search', { query: 'newcomer' });
      assert.equal(quick.status, 429);
      tick(3000);
      assert.equal((await post('/admin/api/youtube/search', { query: 'newcomer' })).status, 200);
    });

    test('allowing one song: the word is needed, a woman or a blocked artist stops it, and Zemer’s blocks stay unless lifted', async () => {
      const song = { videoId: 'newsound001', title: 'New Sound', artist: 'Newcomer Band', artistIds: [newcomer] };
      assert.equal((await post('/admin/api/songs/allow', song)).status, 400, 'no word, no allow');
      const done = await json(await post('/admin/api/songs/allow', { ...song, noWomenConfirmed: true }));
      assert.match(done.message, /can be sent now/);
      assert.equal(whitelist.allows('newsound001', [newcomer]), true);
      assert.equal(whitelist.artist(newcomer), undefined, 'the artist is not allowed, only the song');

      const woman = await post('/admin/api/songs/allow', { videoId: 'duet0000001', title: 'Duet', artistIds: [newcomer, rina], noWomenConfirmed: true });
      assert.equal(woman.status, 409);
      assert.match((await json(woman)).error, /flagged as a woman/);
      whitelist.refuse(stranger, 'Stranger Band');
      const blocked = await post('/admin/api/songs/allow', { videoId: 'strangerson', title: 'S', artistIds: [stranger], noWomenConfirmed: true });
      assert.equal(blocked.status, 409);
      assert.match((await json(blocked)).error, /you blocked a credited artist/);

      const zemerBlocked = await json(await post('/admin/api/songs/allow', { videoId: 'blockedsong', title: 'Blocked One', artistIds: [night], noWomenConfirmed: true }));
      assert.match(zemerBlocked.message, /still held back: Zemer's list blocks this song/);
      assert.equal(whitelist.allows('blockedsong', [night]), false);
      assert.equal((await post('/admin/api/songs/unblock', { videoId: 'blockedsong', title: 'Blocked One' })).status, 400, 'lifting a block needs the word too');
      assert.equal((await post('/admin/api/songs/unblock', { videoId: 'blockedsong', title: 'Blocked One', noWomenConfirmed: true })).status, 200);
      assert.equal(whitelist.allows('blockedsong', [night]), true);
      assert.equal((await post('/admin/api/songs/unblock', { videoId: 'neverblock1', noWomenConfirmed: true })).status, 409, 'a song Zemer does not block');
      assert.equal((await post('/admin/api/songs/reblock', { videoId: 'blockedsong' })).status, 200);
      assert.equal(whitelist.allows('blockedsong', [night]), false);

      const list = await json(await get('/admin/api/songs'));
      assert.deepEqual(Object.fromEntries(list.allowed.map((s: any) => [s.id, s.holding])), { newsound001: null, blockedsong: "Zemer's list blocks this song" });
      assert.deepEqual(list.blocked.map((s: any) => s.id), ['blockedsong']);
      assert.equal((await post('/admin/api/songs/unallow', { videoId: 'newsound001' })).status, 200);
      assert.equal(whitelist.allows('newsound001', [newcomer]), false);
      assert.equal((await post('/admin/api/songs/unallow', { videoId: 'newsound001' })).status, 404);
      assert.equal((await post('/admin/api/songs/allow', { videoId: 'short', noWomenConfirmed: true })).status, 400);
    });

    test('a song allowed by itself reaches the send-time gate, and every decision is kept across a restart', async () => {
      await post('/admin/api/songs/allow', { videoId: 'newsound001', title: 'New Sound', artist: 'Newcomer Band', artistIds: [newcomer], noWomenConfirmed: true });
      await post('/admin/api/artists/allow', { id: stranger, name: 'Stranger Band', noWomenConfirmed: true });
      await post('/admin/api/artists/block', { id: night, name: 'The Night Owls' });
      const reborn = new ZemerWhitelist({ baseUrl: content.url, state: catalog, checkEveryMs: 0, retryAfterMs: 0, now: () => clock });
      await reborn.ready();
      assert.equal(reborn.allows('newsound001', [newcomer]), true);
      assert.equal(reborn.allows('x', [stranger]), true);
      assert.equal(reborn.allows('x', [night]), false);
    });
  });

  describe('the settings', () => {
    test('lists every setting with where its value comes from and whether it can change while the bot runs', async () => {
      env.MAX_DOWNLOAD_MB = '30';
      const d = await json(await get('/admin/api/settings'));
      const by = Object.fromEntries(d.settings.map((s: any) => [s.key, s]));
      assert.equal(by.DIGEST_TIME.value, '09:00');
      assert.equal(by.DIGEST_TIME.source, 'environment');
      assert.equal(by.DIGEST_TIME.live, true);
      assert.equal(by.SONG_GAP_SECONDS.source, 'default');
      assert.equal(by.SONG_GAP_SECONDS.default, '5');
      assert.equal(by.MAX_DOWNLOAD_MB.value, '30');
      assert.equal(by.MAX_DOWNLOAD_MB.live, false);
      assert.deepEqual(d.settings.filter((s: any) => s.live).map((s: any) => s.key).sort(), [...LIVE_KEYS].sort());
      assert.match(d.restart, /change it in Render/);
    });

    test('never shows a secret’s value anywhere, only whether it is set', async () => {
      env.MATRIX_PASSWORD = 'matrix-password-9981';
      const text = (await (await get('/admin/api/settings')).text()) + (await (await get('/admin/api/overview')).text()) + (await (await get('/admin/api/log')).text());
      for (const secret of [TOKEN, SECRET_IN_ENV, 'matrix-password-9981']) assert.ok(!text.includes(secret), `${secret} must not appear`);
      const d = JSON.parse((await (await get('/admin/api/settings')).text())) as { settings: any[] };
      const token = d.settings.find((s) => s.key === 'ADMIN_TOKEN');
      assert.deepEqual([token.secret, token.isSet, token.value, token.environment], [true, true, null, null]);
      assert.equal(d.settings.find((s) => s.key === 'R2_ACCESS_KEY_ID').isSet, false);
      assert.equal(d.settings.find((s) => s.key === 'MATRIX_ROOM_ID').secret, false);
      const attempt = await post('/admin/api/settings/set', { key: 'ADMIN_TOKEN', value: 'something' });
      assert.equal(attempt.status, 400, 'a secret can not be changed here');
    });

    test('changes the daily message’s time and the quiet hours for the running jobs, and going back follows Render again', async () => {
      assert.equal(jobs.report().digest.at, '09:00');
      const set = await json(await post('/admin/api/settings/set', { key: 'DIGEST_TIME', value: '9:45' }));
      assert.equal(set.value, '09:45');
      assert.equal(jobs.report().digest.at, '09:45', 'the jobs read it again');
      await post('/admin/api/settings/set', { key: 'QUIET_HOURS', value: '23:30 - 06:15' });
      assert.equal(jobs.report().quiet, '23:30-06:15');
      await post('/admin/api/settings/set', { key: 'DIGEST_TIME', value: 'off' });
      assert.equal(jobs.report().digest.at, null);

      const shown = (await json(await get('/admin/api/settings'))).settings.find((s: any) => s.key === 'DIGEST_TIME');
      assert.deepEqual([shown.value, shown.source, shown.environment], ['off', 'override', '09:00'], 'what Render says is shown beside it');
      const entries = admin.audit.list().filter((e) => e.what === 'setting DIGEST_TIME');
      assert.deepEqual(entries.map((e) => [e.from, e.to]), [['09:45', 'off'], ['09:00', '09:45']], 'what, from what to what, newest first');

      await post('/admin/api/settings/clear', { key: 'DIGEST_TIME' });
      assert.equal(jobs.report().digest.at, '09:00');
      assert.equal((await json(await get('/admin/api/settings'))).settings.find((s: any) => s.key === 'DIGEST_TIME').source, 'environment');
    });

    test('refuses a value that is not valid, and a setting that needs a restart', async () => {
      for (const [key, value] of [['DIGEST_TIME', '25:00'], ['DIGEST_TIME', 'noon'], ['QUIET_HOURS', '22:00'], ['SONG_GAP_SECONDS', '301'], ['SONG_GAP_SECONDS', 'abc'], ['ALBUM_DOWNLOADS', '0'], ['ALBUM_DOWNLOADS', '6'], ['DOWNLOADS_AHEAD', '11'], ['ONEDRIVE_MAX_MB_PER_MONTH', '-1'], ['ONEDRIVE_MAX_MB_PER_MONTH', 'unlimited'], ['ONEDRIVE_MAX_MB_PER_MONTH', '4001']]) {
        const res = await post('/admin/api/settings/set', { key, value });
        assert.equal(res.status, 400, `${key}=${value}`);
      }
      const restart = await post('/admin/api/settings/set', { key: 'MAX_DOWNLOAD_MB', value: '50' });
      assert.equal(restart.status, 400);
      assert.match((await json(restart)).error, /change it in Render/);
      assert.equal((await post('/admin/api/settings/set', { key: 'NOT_A_SETTING', value: '1' })).status, 400);
      assert.equal(admin.audit.list().length, 0);
    });

    test('the settings that can change are read again by the code that uses them, and kept across a restart', () => {
      const settings = new LiveSettings({ env: {}, state: catalog });
      const started = { hour: 9, minute: 0 };
      assert.deepEqual(settings.digestAt(started), started);
      assert.equal(settings.songGapMs(5000), 5000);
      assert.equal(settings.albumDownloads(undefined), undefined);
      assert.equal(settings.cloudBudget(1500 * 1048576), 1500 * 1048576);
      settings.set('DIGEST_TIME', '07:05');
      settings.set('SONG_GAP_SECONDS', '12');
      settings.set('ALBUM_DOWNLOADS', '2');
      settings.set('DOWNLOADS_AHEAD', '4');
      settings.set('ONEDRIVE_MAX_MB_PER_MONTH', '250');
      settings.set('QUIET_HOURS', 'off');
      const again = new LiveSettings({ env: {}, state: catalog });
      assert.deepEqual(again.digestAt(started), { hour: 7, minute: 5 });
      assert.equal(again.songGapMs(5000), 12_000);
      assert.equal(again.albumDownloads(undefined), 2);
      assert.equal(again.downloadsAhead(undefined), 4);
      assert.equal(again.cloudBudget(undefined), 250 * 1048576);
      assert.equal(again.quiet({ from: started, to: started }), undefined);
    });

    test('every setting the code reads is in the list', () => {
      const known = new Set(SETTINGS.map((s) => s.key));
      const missing = new Set<string>();
      const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : name.endsWith('.ts') ? [join(dir, name)] : []));
      const root = fileURLToPath(new URL('..', import.meta.url));
      for (const file of [...walk(join(root, 'src')), ...walk(join(root, 'deploy/cloud'))]) {
        const code = readFileSync(file, 'utf8');
        for (const match of code.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})\b|\benv\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g)) {
          const name = match[1] ?? match[2]!;
          if (!known.has(name)) missing.add(`${name} (${file.slice(root.length)})`);
        }
      }
      assert.deepEqual([...missing], [], 'add these to SETTINGS in src/admin/settings.ts');
    });
  });

  describe('following', () => {
    test('lists, adds and removes the artists you follow, and records it', async () => {
      catalog.add({ title: 'Song', artist: 'Yoely Weiss', url: 'https://www.music-table.com/post/a#0' });
      assert.deepEqual((await json(await get('/admin/api/follows'))).following, []);
      const added = await json(await post('/admin/api/follows/add', { name: 'yoely weiss' }));
      assert.match(added.message, /Following Yoely Weiss/);
      assert.deepEqual((await json(await get('/admin/api/follows'))).following.map((a: any) => a.name), ['Yoely Weiss']);
      assert.equal((await post('/admin/api/follows/add', { name: 'nobody here' })).status, 404);
      assert.equal((await post('/admin/api/follows/add', { name: '  ' })).status, 400);
      assert.match((await json(await post('/admin/api/follows/remove', { name: 'Yoely Weiss' }))).message, /Stopped following/);
      assert.deepEqual((await json(await get('/admin/api/follows'))).following, []);
      assert.deepEqual(admin.audit.list().map((e) => e.what), ['unfollow artist', 'follow artist']);
    });
  });

  describe('the record of changes', () => {
    test('is shown newest first, is bounded, and survives a restart', async () => {
      for (let i = 0; i < 230; i += 1) admin.audit.add({ what: `change ${i}`, detail: 'x'.repeat(500) });
      const d = await json(await get('/admin/api/audit'));
      assert.equal(d.entries.length, 200);
      assert.equal(d.entries[0].what, 'change 229');
      assert.equal(d.entries[0].detail.length, 240, 'a long field is cut');
      const reborn = new AdminConsole();
      reborn.provide({ catalog });
      assert.equal(reborn.audit.list()[0]?.what, 'change 229');
    });
  });
});

describe('the log kept for the console', () => {
  test('keeps the last lines only', () => {
    const ring = new LogRing({ size: 50 });
    for (let i = 0; i < 80; i += 1) ring.add(`line ${i}`);
    assert.equal(ring.size, 50);
    assert.equal(ring.total, 80);
    assert.equal(ring.lines({ limit: 500 })[0]?.text, 'line 30');
    assert.equal(ring.lines({ limit: 2 }).map((l) => l.text).join(), 'line 78,line 79');
    ring.add('first\nsecond\n\nthird');
    assert.equal(ring.size, 50);
    assert.equal(ring.lines({ limit: 3 }).map((l) => l.text).join(), 'first,second,third');
  });

  test('masks secrets: the settings’ values, bearer tokens, key=value pairs, passwords in addresses', () => {
    const env = { ADMIN_TOKEN: 'hunter2hunter2', SECRET_KEY: 's3cr3t-master', R2_ACCESS_KEY_ID: 'AKIA1234567890', PORT: '8080', ALERT_URL: 'https://ntfy.sh/my-private-topic-key?token=abcdef', ZEMER_SEARCH_URL: 'https://search.zemer.io', DIGEST_TIME: '09:00' };
    const secrets = secretValues(env);
    assert.ok(secrets.includes('hunter2hunter2') && secrets.includes('AKIA1234567890') && secrets.includes('s3cr3t-master'));
    assert.ok(!secrets.includes('8080') && !secrets.includes('09:00') && !secrets.includes('https://search.zemer.io'), 'ordinary settings are not masked');
    assert.ok(secrets.includes(env.ALERT_URL), 'an address that carries a token is');
    for (const line of [
      'login with hunter2hunter2 ok',
      'Authorization: Bearer abcdefghijklmnop',
      'GET /x?access_token=abcdef12345&y=1',
      'connect postgres://user:p4ssw0rd@db.example/x',
      'token syt_abcdefghijklmnopqrstuvwx',
      'password=letmein99',
    ]) {
      const masked = redact(line, secrets);
      assert.match(masked, /‹hidden›/, line);
      for (const leak of ['hunter2hunter2', 'abcdefghijklmnop', 'abcdef12345', 'p4ssw0rd', 'syt_abcdefghijklmnopqrstuvwx', 'letmein99']) assert.ok(!masked.includes(leak), `${leak} leaked from: ${line}`);
    }
    assert.equal(redact('searching "achas" took 0.4s', secrets), 'searching "achas" took 0.4s');
    assert.ok(redact('x'.repeat(5000)).length <= 2001);
  });

  test('taps the console: lines are kept, still written, and nothing is kept twice', () => {
    const written: string[] = [];
    const fake = { log: (...a: unknown[]) => void written.push(a.join(' ')), info: (...a: unknown[]) => void written.push(a.join(' ')), warn: (...a: unknown[]) => void written.push(`warn ${a.join(' ')}`), error: (...a: unknown[]) => void written.push(`error ${a.join(' ')}`) };
    const ring = new LogRing();
    tapConsole(ring, fake);
    fake.log('hello', 42);
    fake.warn('careful');
    fake.error(new Error('boom').message);
    assert.deepEqual(written, ['hello 42', 'warn careful', 'error boom']);
    assert.deepEqual(ring.lines().map((l) => [l.level, l.text]), [['info', 'hello 42'], ['warn', 'careful'], ['error', 'boom']]);
  });
});
