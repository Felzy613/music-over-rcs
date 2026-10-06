import './load-env.ts';
import { checkAudio } from './audio-check.ts';
import { fetchAudio } from './audio-fetch.ts';
import { createBot } from './bot.ts';
import { Catalog, choicesIn, linksIn } from './catalog.ts';
import { catalogBrowse } from './library/browse.ts';
import { loadMatrixConfig } from './config.ts';
import { describeMatrixError, MatrixClient } from './matrix/client.ts';
import { setUpLibrary } from './library/setup.ts';
import { createRunner } from './runner.ts';
import { createMusicTableSource, musicTableFromEnv, resolvingAudio } from './sources/music-table.ts';

// Answers song requests typed into one Google Messages chat, through the mautrix-gmessages bridge and a Matrix room.
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
let homeserver: string | undefined;

try {
  const config = loadMatrixConfig();
  homeserver = config.homeserver;
  const maxBytes = config.maxDownloadMb * 1024 * 1024;

  const matrix = new MatrixClient({ token: config.token, homeserver: config.homeserver });
  const { userId } = await matrix.whoami();
  // The bridge invites you to each chat it creates; joining accepts the invite and does nothing if you're in already.
  await matrix.joinRoom(config.roomID);

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
  // Songs kept on disk (the most played, the newest, the most viewed), album art, and the daily new-music message.
  const library = setUpLibrary({
    catalog,
    musicTable,
    audio,
    dbPath: config.dbPath,
    digestAt: config.digestAt,
    prefetchMb: config.prefetchMb,
    log,
  });
  const bot = createBot({
    catalog,
    checkAudio: library.checkAudio,
    onPlay: library.onPlay,
    browse: catalogBrowse(catalog),
    ...(musicTable ? { source: createMusicTableSource({ musicTable, catalog }) } : {}),
  });
  const runner = createRunner({
    chat: matrix,
    bot,
    chatID: config.roomID,
    fetchAudio: library.fetchAudio,
    prepareImage: library.prepareImage,
    choices: choicesIn(catalog),
    links: linksIn(catalog),
    pollMs: config.pollMs,
    log,
  });
  await runner.start();
  library.start((replies) => runner.announce(replies));
  log(
    `signed in as ${userId}, watching room ${config.roomID}, ${catalog.count()} tracks in ${config.dbPath}, music-table.com ${musicTable ? 'on' : 'off'}, ${library.summary}. Text a song name in that chat.`,
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
  console.error(describeMatrixError(err, homeserver));
  process.exit(1);
}
