import './load-env.ts';
import { checkAudio } from './audio-check.ts';
import { fetchAudio } from './audio-fetch.ts';
import { createBot } from './bot.ts';
import { Catalog, choicesIn, linksIn } from './catalog.ts';
import { Health, BridgeWatch, bridgeStatus, online } from './health.ts';
import { bridgeRestarter } from './bridge-restart.ts';
import { loadExtensions, startExtensions, stopExtensions, type ExtensionChat } from './extensions.ts';
import { loadMatrixConfig } from './config.ts';
import { describeMatrixError, MatrixClient } from './matrix/client.ts';
import { setUpLibrary } from './library/setup.ts';
import { createRunner, type IncomingPicture } from './runner.ts';
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
    archiveDir: config.archiveDir,
    onArchive: (problem) => (problem ? health.problem('archive', problem) : health.ok('archive', 'Fixed: the songs folder on the drive can be used again.')),
    quiet: config.quiet,
    // With no internet at all, that's the one thing said; the site isn't blamed for it.
    onSite: (ok, problem) =>
      ok ? health.ok('site', 'Fixed: music-table.com is answering again.') : health.has('internet') ? undefined : health.problem('site', problem ?? "music-table.com isn't answering."),
    log,
  });
  // Add-ons kept outside this repository, in extensions/ (see src/extensions.ts). One that fails is left out.
  const extensions = await loadExtensions({ state: catalog, health, env: process.env, log, download: (url) => matrix.downloadMedia(url) });
  const assistant = extensions.find((extension) => extension.assistant)?.assistant;
  const pictureTakers = extensions.filter((extension) => extension.onPicture);
  const prepareImage = extensions.reduce((prepare, extension) => extension.pictures?.(prepare) ?? prepare, library.prepareImage);
  const bot = createBot({
    catalog,
    checkAudio: library.checkAudio,
    onPlay: library.onPlay,
    browse: library.browse,
    follows: library.follows,
    ...(assistant ? { assistant } : {}),
    ...(musicTable ? { source: createMusicTableSource({ musicTable, catalog }) } : {}),
  });
  const bridge = new BridgeWatch({
    health,
    status: () => bridgeStatus({ url: config.bridgeUrl, token: config.token, userId }),
    online,
    restart: bridgeRestarter(),
    log,
  });
  const runner = createRunner({
    chat: matrix,
    bot,
    chatID: config.roomID,
    fetchAudio: library.fetchAudio,
    prepareImage,
    choices: choicesIn(catalog),
    links: linksIn(catalog),
    pollMs: config.pollMs,
    songGapMs: config.songGapMs,
    onBridgeSendFailure: () => bridge.sendFailed(),
    ...(pictureTakers.length > 0 ? { onPicture: (picture: IncomingPicture) => pictureTakers.forEach((extension) => extension.onPicture!(picture)) } : {}),
    log,
    // Half a minute without the homeserver is worth a word; it comes back on its own when it's restarted.
    onPoll: (ok, failures, error) => {
      if (ok) health.ok('homeserver', 'Fixed: the bot can reach the Matrix homeserver again.');
      else if (failures >= 20) health.problem('homeserver', `The bot can't reach the Matrix homeserver (${error ?? 'no answer'}). Start it: npm run stack -- start`);
    },
  });
  await runner.start();
  library.start((replies) => runner.announce(replies));
  const chat: ExtensionChat = {
    announce: (replies) => runner.announce(replies),
    post: (text) => matrix.sendText(config.roomID, text),
    react: (messageId, key) => matrix.sendReaction(config.roomID, messageId, key),
    unreact: (reactionId) => matrix.redact(config.roomID, reactionId),
  };
  startExtensions(extensions, chat, health);
  // If the internet is back but Google Messages stays disconnected, restart its stale bridge session automatically.
  const watching = setInterval(() => void bridge.check(), 60_000);
  watching.unref();
  void bridge.check();
  log(
    `signed in as ${userId}, watching room ${config.roomID}, ${catalog.count()} tracks in ${config.dbPath}, music-table.com ${musicTable ? 'on' : 'off'}, ${library.summary}${extensions.map((extension) => `, ${extension.summary ?? extension.name}`).join('')}. Text "search" and a song name in that chat.`,
  );

  const shutdown = async () => {
    log('shutting down');
    clearInterval(watching);
    await stopExtensions(extensions, log);
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
