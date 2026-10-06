import '../src/load-env.ts';
import { dirname, join, resolve } from 'node:path';
import { checkAudio } from '../src/audio-check.ts';
import { fetchAudio } from '../src/audio-fetch.ts';
import { Catalog, choicesIn, linksIn } from '../src/catalog.ts';
import { loadMatrixConfig, parsePrefetchMb } from '../src/config.ts';
import { createPictures } from '../src/library/images.ts';
import { AudioCache } from '../src/library/audio-cache.ts';
import { LibraryJobs, localDay, parseDailyTime, STATE } from '../src/library/jobs.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { createRunner, markBotText } from '../src/runner.ts';
import { musicTableFromEnv, resolvingAudio } from '../src/sources/music-table.ts';
import type { Reply } from '../src/types.ts';

// The bot's library: the catalog kept in step with music-table.com, the songs kept ready, the daily message.
//   npm run library -- status                  what's in it, and when things last happened
//   npm run library -- sync                    read the site's newest posts into the catalog now
//   npm run library -- scan                    read the whole site (every post, song and artist) into the catalog
//   npm run library -- prefetch                sync, then download the songs worth keeping ready
//   npm run library -- digest [--days 3]       show the daily message as it would go out now (nothing is sent)
//   npm run library -- digest --send           send it now to your chat (MATRIX_ROOM_ID), as the bot would
const args = process.argv.slice(2);
const command = args[0] ?? 'status';
const daysAt = args.indexOf('--days');
const days = daysAt >= 0 ? Number(args[daysAt + 1]) : undefined;
if (days !== undefined && !(days > 0 && days <= 60)) {
  console.error('--days must be a number from 1 to 60');
  process.exit(2);
}

const env = process.env;
const dbPath = env.CATALOG_DB?.trim() || 'data/catalog.db';
const catalog = new Catalog(dbPath);
const musicTable = musicTableFromEnv();
if (!musicTable) {
  console.error('MUSIC_TABLE is off in .env, so there is no site to keep in step with.');
  process.exit(1);
}
const maxBytes = (Number(env.MAX_DOWNLOAD_MB) || 100) * 1024 * 1024;
const audio = resolvingAudio(
  musicTable,
  {
    checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true, maxBytes }),
    fetchAudio: (url, title) => fetchAudio(url, title, { maxBytes }),
  },
  { maxBytes },
);
const digestAt = parseDailyTime(env.DIGEST_TIME);
const prefetchMb = parsePrefetchMb(env.PREFETCH_MB);
if (prefetchMb instanceof Error) {
  console.error(prefetchMb.message);
  process.exit(1);
}
const limited = Number.isFinite(prefetchMb);
const cache =
  prefetchMb > 0
    ? new AudioCache({ dir: join(dirname(resolve(dbPath)), 'audio-cache'), index: catalog, maxBytes: limited ? prefetchMb * 1024 * 1024 : undefined })
    : undefined;

let announce: (replies: Reply[]) => Promise<void> = async () => {
  throw new Error('nothing to send through');
};
const jobs = new LibraryJobs({
  musicTable,
  catalog,
  announce: (replies) => announce(replies),
  digestAt: digestAt instanceof Error ? undefined : digestAt,
  cache,
  fetchAudio: audio.fetchAudio,
  log: (line) => console.log(line),
});
const since = days ? new Date(Date.now() - days * 24 * 60 * 60_000) : undefined;
const when = (iso: string | undefined) => (iso ? new Date(iso).toLocaleString() : 'never');

try {
  if (command === 'status') {
    const newest = catalog.newestPosts(1)[0];
    const kept = cache?.stats();
    console.log(`catalog:        ${catalog.count()} songs by ${catalog.artistCount()} artists, ${catalog.postCount()} music-table.com posts known`);
    console.log(`whole site:     ${catalog.getState(STATE.scanDone) ? `read ${when(catalog.getState(STATE.scanDone))}` : `${catalog.getState(STATE.scanOffset) ?? 0} posts read so far (the bot reads the rest in the background; npm run library -- scan does it now)`}`);
    console.log(`newest post:    ${newest ? `${newest.title} (${new Date(newest.publishedAt).toLocaleDateString()})` : 'none yet; run: npm run library -- sync'}`);
    console.log(`last sync:      ${when(catalog.getState(STATE.lastSync))}`);
    console.log(`kept ready:     ${cache ? `${kept!.files} songs, ${(kept!.bytes / 1048576).toFixed(0)} MB ${limited ? `of ${prefetchMb} MB` : '(no size limit)'}, in ${cache.dir}` : 'off (PREFETCH_MB=0)'}`);
    const time = digestAt instanceof Error ? `invalid DIGEST_TIME: ${digestAt.message}` : digestAt ? `${String(digestAt.hour).padStart(2, '0')}:${String(digestAt.minute).padStart(2, '0')} every day` : 'off';
    console.log(`daily message:  ${time}; last sent ${when(catalog.getState(STATE.digestSentAt))}${catalog.getState(STATE.digestDate) === localDay(new Date()) ? ' (done for today)' : ''}`);
    const top = catalog.mostPlayed(5);
    if (top.length > 0) console.log(`most played:    ${top.map((track) => `${track.title} ×${track.plays}`).join(', ')}`);
    const followed = catalog.followed();
    console.log(`following:      ${followed.length > 0 ? followed.map((artist) => `${artist.name}${artist.auto ? ' (from plays)' : ''}`).join(', ') : 'nobody yet (text "follow <artist>")'}`);
    let problems: Array<{ message: string; since: string }> = [];
    try {
      problems = JSON.parse(catalog.getState('health.problems') || '[]');
    } catch {
      // nothing saved yet
    }
    console.log(`health:         ${problems.length === 0 ? 'nothing wrong that the bot knows of' : problems.map((p) => `${p.message} (since ${new Date(p.since).toLocaleString()})`).join('\n                ')}`);
  } else if (command === 'sync') {
    await jobs.sync();
  } else if (command === 'scan') {
    console.log('Reading every post on music-table.com, 50 at a time with a pause between requests…');
    let last = 0;
    const posts = await jobs.scanAll({
      progress: (done) => {
        if (done - last >= 500) {
          last = done;
          console.log(`  ${done} posts`);
        }
      },
    });
    console.log(`Done: ${posts} posts, ${catalog.count()} songs and ${catalog.artistCount()} artists in the catalog.`);
  } else if (command === 'prefetch') {
    if (!cache) throw new Error('PREFETCH_MB is 0, so no songs are kept ready');
    await jobs.sync();
    await jobs.keepReady();
    const kept = cache.stats();
    console.log(`${kept.files} songs kept ready (${(kept.bytes / 1048576).toFixed(0)} MB) in ${cache.dir}`);
  } else if (command === 'digest' && args.includes('--send')) {
    const config = loadMatrixConfig();
    const matrix = new MatrixClient({ token: config.token, homeserver: config.homeserver });
    await matrix.joinRoom(config.roomID);
    // The same path the bot uses, so it looks exactly as it will each morning.
    const runner = createRunner({
      chat: matrix,
      bot: { handle: async () => [] },
      chatID: config.roomID,
      fetchAudio: audio.fetchAudio,
      prepareImage: createPictures({ log: (line) => console.log(line) }),
      // Kept where the bot looks, so replying with a number from this message works.
      choices: choicesIn(catalog),
      links: linksIn(catalog),
      log: (line) => console.log(line),
    });
    announce = (replies) => runner.announce(replies);
    const sent = await jobs.sendDigest(since);
    console.log(sent > 0 ? 'Check your phone.' : 'Nothing new to send.');
  } else if (command === 'digest') {
    const { replies } = await jobs.previewDigest(since);
    if (replies.length === 0) console.log(`Nothing new${days ? ` in the last ${days} days` : ' since the last daily message'}. Try --days 3.`);
    for (const reply of replies) {
      if (reply.kind === 'image') console.log(`  [picture] ${reply.url}`);
      else if (reply.kind === 'collage') console.log(`  [one picture of ${reply.images.length} numbered covers]`);
      else if (reply.kind === 'text') console.log(`  ${markBotText(reply.text).replaceAll('\n', '\n  ')}`);
    }
    if (replies.length > 0) console.log('\nNothing was sent. Add --send to send it to your chat now.');
  } else {
    console.error('usage: npm run library -- status | sync | scan | prefetch | digest [--days N] [--send]');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  catalog.close();
}
