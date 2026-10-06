import './load-env.ts';
import { checkAudio } from './audio-check.ts';
import { fetchAudio } from './audio-fetch.ts';
import { BeeperClient, describeBeeperError } from './beeper/client.ts';
import { createBot } from './bot.ts';
import { Catalog, choicesIn, linksIn } from './catalog.ts';
import { Health } from './health.ts';
import { loadBeeperConfig } from './config.ts';
import { setUpLibrary } from './library/setup.ts';
import { createRunner } from './runner.ts';
import { createMusicTableSource, musicTableFromEnv, resolvingAudio } from './sources/music-table.ts';

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
  // When the catalog has no match the bot looks on music-table.com (MUSIC_TABLE=off turns that off).
  const musicTable = musicTableFromEnv();
  void musicTable?.warm();
  const audio = resolvingAudio(
    musicTable,
    {
      checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true, maxBytes }),
      fetchAudio: (url, title) => fetchAudio(url, title, { maxBytes }),
    },
    { maxBytes },
  );
  // What's wrong, shown on the Mac: the chat can't carry news of its own breakdown.
  const health = new Health({ log, save: (problems) => catalog.setState('health.problems', JSON.stringify(problems)) });
  catalog.setState('health.problems', '[]');

  // Songs kept on disk (the most played, the newest, the most viewed), album art, and the daily new-music message.
  const library = setUpLibrary({
    catalog,
    musicTable,
    audio,
    dbPath: config.dbPath,
    digestAt: config.digestAt,
    prefetchMb: config.prefetchMb,
    quiet: config.quiet,
    onSite: (ok, problem) => (ok ? health.ok('site', 'Fixed: music-table.com is answering again.') : health.problem('site', problem ?? "music-table.com isn't answering.")),
    log,
  });
  const bot = createBot({
    catalog,
    checkAudio: library.checkAudio,
    onPlay: library.onPlay,
    browse: library.browse,
    follows: library.follows,
    ...(musicTable ? { source: createMusicTableSource({ musicTable, catalog }) } : {}),
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
    log,
    onPoll: (ok, failures, error) => {
      if (ok) health.ok('beeper', 'Fixed: the bot can reach Beeper Desktop again.');
      else if (failures >= 20) health.problem('beeper', `The bot can't reach Beeper Desktop (${error ?? 'no answer'}). Is it running?`);
    },
  });
  await runner.start();
  library.start((replies) => runner.announce(replies));
  log(
    `watching chat ${config.chatID}, ${catalog.count()} tracks in ${config.dbPath}, music-table.com ${musicTable ? 'on' : 'off'}, ${library.summary}. Text a song name in that chat.`,
  );

  const shutdown = async () => {
    log('shutting down');
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
