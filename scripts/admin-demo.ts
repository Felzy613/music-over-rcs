import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { AdminAccount, Sessions, sessionBinding } from '../src/admin/account.ts';
import { AdminConsole, type ConnectDeps } from '../src/admin/console.ts';
import { LogRing, secretValues } from '../src/admin/log-ring.ts';
import { SignIn } from '../src/admin/sign-in.ts';
import { Catalog } from '../src/catalog.ts';
import { Onboarding } from '../src/cloud/onboarding.ts';
import { createCloudWeb } from '../src/cloud/web.ts';
import { catalogFollows } from '../src/library/follows.ts';
import { LibraryJobs } from '../src/library/jobs.ts';
import { personOf } from '../src/people.ts';
import { MusicTable } from '../src/sources/music-table.ts';
import { YouTubeMusic } from '../src/sources/youtube-music.ts';
import { createNewReleases, ZemerReleases } from '../src/sources/zemer-releases.ts';
import { ZemerWhitelist } from '../src/sources/zemer-whitelist.ts';
import { startMockMusicTable } from '../test/helpers/mock-music-table.ts';
import { artistId, startMockYouTubeMusic } from '../test/helpers/mock-youtube-music.ts';
import { startMockZemerContent, type MockArtist } from '../test/helpers/mock-zemer-content.ts';
import { startMockZemerReleases } from '../test/helpers/mock-zemer-releases.ts';

// The management console (docs/admin.md) on made-up data, with no accounts and no network: the real console and door in front of
// the mock servers the tests use (a Zemer artist list that has turned the bot away, YouTube Music, Zemer's releases feed,
// music-table.com), an in-memory catalog, and a pretend host status. Nothing here reaches anything real.
//   npm run simulate:admin -- --open          then sign in on the real sign-in page: any user name, password "demo-password"
//   --auto                                    skip the sign-in page (this machine only)
//   --port 8789                               where to listen (127.0.0.1 only)
const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8789;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('--port must be a number from 1 to 65535');
  process.exit(2);
}

const TOKEN = 'demo-password';
const env: NodeJS.ProcessEnv = { ADMIN_TOKEN: TOKEN, SECRET_KEY: 'demo-master-secret', R2_SECRET_ACCESS_KEY: 'demo-r2-secret', DIGEST_TIME: '09:00', MAX_DOWNLOAD_MB: '30', DOWNLOADS_AHEAD: '1', YOUTUBE_RELAY: 'r2', RENDER_GIT_COMMIT: '3f9c2ab71d0e5c48a6b19e07d2f4c8a5b0e1d6f3', TZ: 'America/New_York' };

const names = ['The Night Owls', 'Yossi Rotner', 'Mira Vale', 'Rina Cohen', 'Shloime Daskal', 'Beri Weber', 'Avraham Fried', 'Lipa Schmeltzer', 'Dovid Gabay', 'Mendy Jerufi', 'Miami Boys Choir', 'Shira Choir'];
const female = new Set(['Mira Vale', 'Rina Cohen', 'Shira Choir']);
const listed: MockArtist[] = names.map((name) => ({ id: artistId(name), name, ...(female.has(name) ? { female: true } : {}) }));
for (let i = 1; i <= 60; i += 1) listed.push({ id: artistId(`Band Number ${i}`), name: `Band Number ${i}`, ...(i % 7 === 0 ? { altName: `להקה ${i}` } : {}) });

const content = await startMockZemerContent(listed);
content.blocked.global = ['blockedsong', 'oldblocked1', 'oldblocked2'];
const youMock = await startMockYouTubeMusic([
  { videoId: 'owlsong0001', title: 'Hold On', artists: ['The Night Owls'], album: 'Late Shift', duration: '3:41' },
  { videoId: 'newsound001', title: 'New Sound', artists: ['Newcomer Band'], album: 'Fresh', duration: '4:02' },
  { videoId: 'newsound002', title: 'Second Wind', artists: ['Newcomer Band'], album: 'Fresh', duration: '3:12' },
  { videoId: 'duet0000001', title: 'Together', artists: ['Newcomer Band', 'Rina Cohen'], duration: '3:55' },
  { videoId: 'hebrewsong1', title: 'הנחת תפילין', artists: ['Yossi Rotner'], album: 'רצועות', duration: '5:41' },
  { videoId: 'strangerson', title: 'Stranger Song', artists: ['Stranger Band'], duration: '2:58' },
]);
const feed = await startMockZemerReleases([
  { artistId: artistId('The Night Owls'), artistName: 'The Night Owls', title: 'Hold On', browseId: 'MPREb_owls0001', uploadDate: new Date(Date.now() - 20 * 3600_000).toISOString(), trackCount: 1, sampleVideoId: 'owlsong0001' },
  { artistId: artistId('Newcomer Band'), artistName: 'Newcomer Band', title: 'Fresh', browseId: 'MPREb_newcm001', uploadDate: new Date(Date.now() - 30 * 3600_000).toISOString(), trackCount: 8 },
  { artistId: artistId('Rina Cohen'), artistName: 'Rina Cohen', title: 'Her Single', browseId: 'MPREb_rina0001', uploadDate: new Date(Date.now() - 40 * 3600_000).toISOString(), trackCount: 1, sampleVideoId: 'hersingle01' },
]);
const site = await startMockMusicTable([
  { slug: 'yoely-weiss-shabbos', title: 'Yoely Weiss - Shabbos', files: [{ name: 'Yoely Weiss - Shabbos.mp3' }], publishedAt: new Date(Date.now() - 5 * 3600_000).toISOString(), views: 840, category: 'Singles' },
  { slug: 'mendy-weiss-two', title: 'Mendy Weiss - Two Songs', files: [{ name: 'One.mp3' }, { name: 'Two.mp3' }], publishedAt: new Date(Date.now() - 50 * 3600_000).toISOString(), views: 310, category: 'Singles' },
]);

const catalog = new Catalog(':memory:');
const ring = new LogRing({ secrets: () => secretValues(env) });
const log = (line: string): void => {
  ring.add(`${new Date().toISOString()} ${line}`);
  console.log(line);
};
// A copy of Zemer's list as the bot saved it while Zemer's server still answered it…
await new ZemerWhitelist({ baseUrl: content.url, state: catalog, checkEveryMs: 0, retryAfterMs: 0 }).ready();
// …and the list as the bot runs now: Zemer's server answers only its own app, so it is never asked and the saved copy is the list.
content.refusing = true;
const whitelist = new ZemerWhitelist({ baseUrl: content.url, state: catalog, offline: true });
await whitelist.ready();
const releases = createNewReleases({ feed: new ZemerReleases({ url: `${feed.url}/?page=zemer_releases` }), whitelist, catalog, log });
const youTube = new YouTubeMusic({ baseUrl: youMock.url, log });
const admin = new AdminConsole();
const signIn = new SignIn({ token: TOKEN, account: new AdminAccount({ state: catalog }), sessions: new Sessions({ state: catalog, binding: sessionBinding(TOKEN) }), log });
const settings = admin.liveSettings(catalog, env);
const announce = async (): Promise<void> => void log('daily message (demo): the chat would get it now');
const jobs = new LibraryJobs({
  musicTable: new MusicTable({ baseUrl: site.url, minIntervalMs: 0 }),
  catalog,
  announce,
  digestAt: () => settings.digestAt({ hour: 9, minute: 0 }),
  quiet: () => settings.quiet({ from: { hour: 22, minute: 0 }, to: { hour: 7, minute: 0 } }),
  fetchAudio: async () => {
    throw new Error('the demo downloads nothing');
  },
  releases,
  log,
});
await jobs.sync();
await jobs.syncReleases(0);
for (const song of [
  { title: 'Hold On', artist: 'The Night Owls', videoId: 'owlsong0001', ids: [artistId('The Night Owls')] },
  { title: 'New Sound', artist: 'Newcomer Band', videoId: 'newsound001', ids: [artistId('Newcomer Band')] },
  { title: 'Together', artist: 'Newcomer Band & Rina Cohen', videoId: 'duet0000001', ids: [artistId('Newcomer Band'), artistId('Rina Cohen')] },
  { title: 'הנחת תפילין', artist: 'Yossi Rotner', videoId: 'hebrewsong1', ids: [artistId('Yossi Rotner')] },
]) {
  catalog.add({ title: song.title, artist: song.artist, url: youTube.trackUrl(song.videoId), artistIds: song.ids });
}
catalog.add({ title: 'Shabbos', artist: 'Yoely Weiss', url: `${site.url}/post/yoely-weiss-shabbos#0` });
catalogFollows(catalog).follow(['yoely', 'weiss']);

// What the owner has already decided, so there is something to see.
whitelist.consider(artistId('Newcomer Band'), 'Newcomer Band');
whitelist.consider(artistId('Dovid Cohen'), 'Dovid Cohen');
whitelist.admit(artistId('Moshe Stranger'), 'Moshe Stranger');
whitelist.refuse(artistId('Lipa Schmeltzer'), 'Lipa Schmeltzer');
whitelist.allowSong({ id: 'strangerson', title: 'Stranger Song', artist: 'Stranger Band', artistIds: [artistId('Stranger Band')] });
whitelist.unblockSong('oldblocked1', 'An old blocked song');
admin.provide({ catalog });
admin.audit.add({ what: 'allow artist', detail: `Moshe Stranger (${artistId('Moshe Stranger')})`, from: 'not on the list', to: 'allowed by you, no women credited' });
admin.audit.add({ what: 'setting QUIET_HOURS', from: '22:00-07:00', to: '23:00-06:30' });
for (const line of ['bot started (demo)', 'signed in as @me:localhost, watching room !demo:localhost', 'timeline: "search achas" phone→seen 1.2s · bot 1.0s (youtube 0.21s) · 12 msgs first +1.0s last +4.3s (0.30s each) · at Google +5.1s']) log(line);
ring.add('YouTube Music: downloading abc failed: HTTP 403', 'warn');
ring.add('could not read Zemer\'s new releases: the feed answered HTTP 500', 'error');

const startedAt = Date.now() - 3 * 3600_000 - 125_000;
admin.provide({
  catalog,
  env,
  startedAt,
  log,
  ring,
  settings,
  signIn,
  whitelist,
  youTube,
  releases,
  jobs: () => jobs,
  follows: catalogFollows(catalog),
  oneDrive: () => ({ connected: true, savedThisMonthMb: 312, monthlyLimitMb: settings.cloudBudget(1500 * 1048576) === undefined ? null : Math.round(settings.cloudBudget(1500 * 1048576)! / 1048576) }),
  status: () => ({
    phase: 'running',
    botEnabled: true,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    memoryMb: 61,
    memory: { limitMb: 512, usedMb: 301, percent: 59, peak: { usedMb: 388, percent: 76, at: new Date().toISOString(), processes: [] }, processes: [] },
    node: process.version,
    room: '!demo:localhost',
    bridge: { state: 'CONNECTED', rcsEnabled: true },
    problems: [{ key: 'releases', message: "Zemer's new releases have not been readable for 12 hours (made-up), so \"new\" and the daily message are music-table.com's alone.", since: new Date(Date.now() - 6 * 3600_000).toISOString() }],
    tracks: catalog.count(),
    timings: ['timeline: "search achas" phone→seen 1.2s · bot 1.0s (youtube 0.21s) · 12 msgs first +1.0s last +4.3s · at Google +5.1s', 'song: "Hold On" 4.2 MB fetch 5.0s tag 0.30s upload 0.60s'],
    oneDrive: { connected: true, savedThisMonthMb: 312, monthlyLimitMb: 1500 },
    sentThisMonthMb: 1900,
    sentTotalThisMonthMb: 1900 + 86,
    people: [alice()],
    edge: { lease: { holder: 'srv-demo-instance', expiresAt: Date.now() + 40_000 }, watchdog: Date.now() - 90_000, alertsWaiting: 0 },
  }),
});
catalog.setState(`usage.${new Date().toISOString().slice(0, 7)}.sent_bytes`, String(1900 * 1048576));
catalog.setState(`usage.${new Date().toISOString().slice(0, 7)}.archived_bytes`, String(312 * 1048576));

// A pretend host for the Connect page: the bridge's replies are canned, nothing is linked, and OneDrive's sign-in waits for a made-up code.
// The made-up second person, alice, goes through the real onboarding gate (src/cloud/onboarding.ts): pick her on the Connect page, link her,
// and watch the page wait for her to text herself.
const bridgeSays: Array<{ at: string; text: string }> = [];
const aliceSays: Array<{ at: string; text: string }> = [];
let linkedPhone = false;
let aliceLinked = false;
let aliceChat = false;
let chosenRoom: string | undefined = '!demo:localhost';
let driveLogin: 'none' | 'pending' | 'done' = 'none';
const say = (text: string): void => void bridgeSays.push({ at: new Date().toISOString(), text });
const gate = new Onboarding({ state: catalog, person: personOf('alice') });
function alice() {
  const bridge = aliceLinked ? { state: 'CONNECTED', rcsEnabled: true } : { state: undefined };
  return {
    id: 'alice',
    phase: aliceLinked && aliceChat ? 'running' : 'setup',
    roomMissing: false,
    room: aliceChat ? '!alice:localhost' : null,
    roomGone: null,
    error: null,
    bridge,
    simNumber: aliceLinked,
    onboarding: gate.evaluate({ login: aliceLinked ? 'linked' : 'none', simNumber: aliceLinked, chatFound: aliceChat }),
    problems: [],
    sentThisMonthMb: aliceChat ? 86 : 0,
    monthlyLimitMb: 1000,
  };
}
const connect: ConnectDeps = {
  async state(person) {
    if (person === 'alice') {
      const one = alice();
      return { phase: one.phase, botEnabled: true, room: one.room, roomGone: null, bridge: one.bridge, problems: [], person: 'alice', error: null, simNumber: one.simNumber, onboarding: one.onboarding };
    }
    return {
      phase: linkedPhone ? (chosenRoom ? 'running' : 'setup') : 'setup',
      botEnabled: true,
      room: chosenRoom ?? null,
      roomGone: null,
      bridge: linkedPhone ? { state: 'CONNECTED', rcsEnabled: true } : { state: undefined, error: 'no Google Messages login yet' },
      problems: [],
    };
  },
  pair: {
    async send(text, person) {
      if (person === 'alice') {
        const reply = (line: string): void => void aliceSays.push({ at: new Date().toISOString(), text: line });
        if (text === 'login google') reply('Demo bridge: open https://messages.google.com/web in a private window, start signing in, and copy the request the page makes as cURL. Then send it to me here.');
        else if (text === 'logout') reply('Demo bridge: your logins: alice@example.com/1 (CONNECTED). Send `logout <login id>` to sign one out.');
        else if (text.startsWith('logout ')) {
          reply('Demo bridge: logged out.');
          aliceLinked = false;
          aliceChat = false;
        } else {
          reply(`Demo bridge: got ${text.length} characters. Now tap the emoji 🐢 in Google Messages on the phone.`);
          setTimeout(() => (aliceLinked = true), 4000);
          setTimeout(() => (aliceChat = true), 25_000);
        }
        return;
      }
      if (text === 'login google') {
        say('Demo bridge: open https://messages.google.com/web in a private window, start signing in, and copy the request the page makes as cURL. Then send it to me here.');
      } else {
        say(`Demo bridge: got ${text.length} characters. Now tap the emoji 🐢 in Google Messages on your phone.`);
        setTimeout(() => (linkedPhone = true), 6000);
      }
    },
    async log(person) {
      return person === 'alice' ? aliceSays : bridgeSays;
    },
  },
  rooms: (phone, person) => (person === 'alice' ? (aliceChat ? ['!alice:localhost'] : []) : phone && phone.length < 9 ? [] : ['!selfchat:localhost']),
  setRoom: (room) => void (chosenRoom = room),
  knownPhone: (person) => (person === 'alice' ? undefined : '5551234567'),
  people: () => [{ id: 'alice' }],
  oneDrive: {
    status: () => ({ connected: driveLogin === 'done', savedThisMonthMb: 312, monthlyLimitMb: 1500, login: driveLogin === 'pending' ? { state: 'pending', verificationUri: 'https://microsoft.com/devicelogin', userCode: 'ABCD1234' } : { state: driveLogin } }),
    async start() {
      driveLogin = 'pending';
      setTimeout(() => (driveLogin = 'done'), 15_000);
      return { state: 'pending' };
    },
  },
  testAlert: async () => {},
};
admin.provide({ connect });

const web = createCloudWeb({
  adminToken: TOKEN,
  admin,
  signIn,
  status: () => ({}),
  pair: { send: async () => {}, log: async () => [] },
  rooms: () => [],
  setRoom: () => {},
  people: () => [{ id: 'alice' }],
  canImport: () => false,
  importCatalog: () => ({}),
});
// With --auto, on this machine only, the password is filled in for a request that has none, so the sign-in page is skipped.
if (args.includes('--auto')) {
  web.prependListener('request', (req) => {
    req.headers.authorization ??= `Bearer ${TOKEN}`;
  });
}
await new Promise<void>((resolve, reject) => {
  web.once('error', reject);
  web.listen(port, '127.0.0.1', resolve);
});
const url = `http://127.0.0.1:${(web.address() as AddressInfo).port}/admin/`;
console.log(`Admin console demo: ${url}`);
console.log(`Made-up data only; Zemer's artist list is the saved copy and is never asked, as it is for real. Sign in with any user name and the password "${TOKEN}" (or start with --auto). Press Ctrl+C to stop.`);
if (args.includes('--open')) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();

const shutdown = async (): Promise<void> => {
  web.close();
  web.closeAllConnections();
  await Promise.all([content.close(), youMock.close(), feed.close(), site.close()]);
  catalog.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
