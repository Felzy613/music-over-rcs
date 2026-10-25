import './load-env.ts';
import { checkAudio } from './audio-check.ts';
import { fetchAudio } from './audio-fetch.ts';
import { BeeperClient, describeBeeperError } from './beeper/client.ts';
import { youTubeRelayFromEnv } from './cloud/youtube-relay.ts';
import { createBot } from './bot.ts';
import { Catalog, choicesIn, linksIn, viewsIn } from './catalog.ts';
import { Health } from './health.ts';
import { loadBeeperConfig } from './config.ts';
import { setUpLibrary } from './library/setup.ts';
import { createRunner } from './runner.ts';
import { musicTableFromEnv, resolvingAudio } from './sources/music-table.ts';
import { songSources } from './sources/songs.ts';
import { gatedAudioCheck, resolvingYouTubeAudio, youTubeGate, youTubeMusicFromEnv } from './sources/youtube-music.ts';
import { zemerSearchFromEnv } from './sources/zemer.ts';
import { zemerWhitelistFromEnv } from './sources/zemer-whitelist.ts';

// Answers song requests typed into one Google Messages chat (your "message yourself" chat), through Beeper Desktop.
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
let baseUrl: string | undefined;

try {
  const config = loadBeeperConfig();
  baseUrl = config.baseUrl;
  const maxBytes = config.maxDownloadMb * 1024 * 1024;

  const beeper = new BeeperClient({ token: config.token, baseUrl: config.baseUrl });
  await beeper.info();

  // This machine downloads the file, so private addresses (a NAS, say) are fine and any audio format will do.
  const catalog = new Catalog(config.dbPath);
  // A search asks Zemer's catalog first, then music-table.com (YOUTUBE_MUSIC=off and MUSIC_TABLE=off turn them off;
  // SONG_SOURCES sets which is asked first). Zemer's songs are YouTube Music's, so their audio comes from there.
  const musicTable = musicTableFromEnv();
  // YouTube turns the cloud host away at its player, so there songs come through the Cloudflare Worker (YOUTUBE_RELAY=r2).
  const youTube = youTubeMusicFromEnv(process.env, { log, relay: youTubeRelayFromEnv(process.env, { log }) });
  // Whether songs can be had (from this host, or through the relay), learned and logged at start.
  void youTube?.checkStreams();
  const zemer = youTube && zemerSearchFromEnv(process.env, { log });
  void zemer?.check();
  const whitelist = youTube && zemerWhitelistFromEnv(process.env, { state: catalog });
  const audio = resolvingYouTubeAudio(
    youTube,
    resolvingAudio(
      musicTable,
      {
        checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true, maxBytes }),
        fetchAudio: (url, title) => fetchAudio(url, title, { maxBytes }),
      },
      { maxBytes },
    ),
    { maxBytes },
  );
  // What's wrong, shown on the Mac: the chat can't carry news of its own breakdown.
  const health = new Health({ log, save: (problems) => catalog.setState('health.problems', JSON.stringify(problems)) });
  catalog.setState('health.problems', '[]');
  // Zemer's artist list is what YouTube Music songs are filtered by, and it changes through the day: kept current while the
  // bot runs, with a note on the Mac if it goes a day without updating (the last good list is used meanwhile).
  const stopWatching = whitelist?.watch((error) => {
    if (error === undefined) health.ok('whitelist', "Fixed: Zemer's artist list is updating again.");
    else if (whitelist.ageMs > 24 * 60 * 60_000) health.problem('whitelist', `Zemer's artist list hasn't updated for a day (${error}). YouTube Music songs are being checked against the old list.`);
  });
  void whitelist?.warm().then(() => whitelist.loaded && log(`Zemer's artist list: ${whitelist.size.artists} artists, ${whitelist.size.blocked} blocked songs`));

  // Songs kept on disk (the most played, the newest, the most viewed), album art, and the daily new-music message.
  const library = setUpLibrary({
    catalog,
    musicTable,
    audio,
    dbPath: config.dbPath,
    digestAt: config.digestAt,
    prefetchMb: config.prefetchMb,
    archiveDir: config.archiveDir,
    onArchive: (problem) => (problem ? health.problem('archive', problem) : health.ok('archive', 'Fixed: the songs folder on the drive can be used again.')),
    quiet: config.quiet,
    onSite: (ok, problem) => (ok ? health.ok('site', 'Fixed: music-table.com is answering again.') : health.problem('site', problem ?? "music-table.com isn't answering.")),
    log,
  });
  const sources = songSources({ catalog, musicTable, youTube, whitelist, zemer });
  // A YouTube Music song is checked against the list as it stands when it is sent, not only when it was found.
  const gate = youTube && whitelist ? youTubeGate({ youTube, whitelist, catalog }) : undefined;
  const bot = createBot({
    catalog,
    checkAudio: gatedAudioCheck(gate, library.checkAudio),
    onPlay: library.onPlay,
    browse: library.browse,
    follows: library.follows,
    // The chat's menus and where it is in them, kept across restarts.
    views: viewsIn(catalog),
    ...sources,
  });
  const runner = createRunner({
    chat: beeper,
    bot,
    chatID: config.chatID,
    fetchAudio: library.fetchAudio,
    prepareImage: library.prepareImage,
    choices: choicesIn(catalog),
    links: linksIn(catalog),
    pollMs: config.pollMs,
    songGapMs: config.songGapMs,
    log,
    onPoll: (ok, failures, error) => {
      if (ok) health.ok('beeper', 'Fixed: the bot can reach Beeper Desktop again.');
      else if (failures >= 20) health.problem('beeper', `The bot can't reach Beeper Desktop (${error ?? 'no answer'}). Is it running?`);
    },
  });
  await runner.start();
  library.start((replies) => runner.announce(replies));
  log(
    `watching chat ${config.chatID}, ${catalog.count()} tracks in ${config.dbPath}, YouTube Music ${youTube ? 'on' : 'off'}, music-table.com ${musicTable ? 'on' : 'off'}, ${library.summary}. Text "search" and a song name in that chat.`,
  );

  const shutdown = async () => {
    log('shutting down');
    stopWatching?.();
    await library.stop();
    await runner.stop();
    catalog.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
} catch (err) {
  console.error(describeBeeperError(err, baseUrl));
  process.exit(1);
}
