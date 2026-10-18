import './load-env.ts';
import { checkAudio } from './audio-check.ts';
import { fetchAudio } from './audio-fetch.ts';
import { createBot } from './bot.ts';
import { Catalog, choicesIn, linksIn, resumeIn } from './catalog.ts';
import { alertFromEnv, allNotify } from './alert.ts';
import { Health, BridgeWatch, bridgeStatus, macNotify, online } from './health.ts';
import { bridgeRestarter } from './bridge-restart.ts';
import { loadExtensions, startExtensions, stopExtensions, type ExtensionChat } from './extensions.ts';
import { loadMatrixConfig, parseCloudBudget } from './config.ts';
import { describeMatrixError, MatrixClient } from './matrix/client.ts';
import { setUpLibrary } from './library/setup.ts';
import { addSent } from './usage.ts';
import { oneDriveFromEnv } from './archive/onedrive.ts';
import { memoryCheck } from './cloud/memory.ts';
import { youTubeRelayFromEnv } from './cloud/youtube-relay.ts';
import { createRunner, type IncomingPicture } from './runner.ts';
import { sendStartupMessage, startupModeFrom } from './startup-message.ts';
import { musicTableFromEnv, resolvingAudio } from './sources/music-table.ts';
import { songSources } from './sources/songs.ts';
import { gatedAudioCheck, resolvingYouTubeAudio, youTubeGate, youTubeMusicFromEnv } from './sources/youtube-music.ts';
import { zemerSearchFromEnv } from './sources/zemer.ts';
import { zemerWhitelistFromEnv } from './sources/zemer-whitelist.ts';

// Answers song requests typed into one Google Messages chat, through the mautrix-gmessages bridge and a Matrix room.
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
let homeserver: string | undefined;

try {
  const config = loadMatrixConfig();
  homeserver = config.homeserver;
  const maxBytes = config.maxDownloadMb * 1024 * 1024;

  const catalog = new Catalog(config.dbPath);
  // What goes out is counted (a cloud host's plan allows only so much a month; /status on the cloud host shows it).
  const matrix = new MatrixClient({ token: config.token, homeserver: config.homeserver, onUpload: (bytes) => addSent(catalog, bytes) });
  const { userId } = await matrix.whoami();
  // The bridge invites you to each chat it creates; joining accepts the invite and does nothing if you're in already.
  await matrix.joinRoom(config.roomID);

  // This machine downloads the file, so private addresses (a NAS, say) are fine and any audio format will do.
  // A search asks Zemer's catalog first, then music-table.com (YOUTUBE_MUSIC=off and MUSIC_TABLE=off turn them off;
  // SONG_SOURCES sets which is asked first). Zemer's songs are YouTube Music's, so their audio comes from there.
  const musicTable = musicTableFromEnv();
  // YouTube turns the cloud host away at its player, so there songs come through the Cloudflare Worker (YOUTUBE_RELAY=r2).
  const youTube = youTubeMusicFromEnv(process.env, { log, relay: youTubeRelayFromEnv(process.env, { log }) });
  // Whether songs can be had (from this host, or through the relay), learned and logged at start.
  void youTube?.checkStreams();
  const zemer = youTube && zemerSearchFromEnv(process.env, { log });
  // Whether Zemer's search answers this host, logged at start (without it, searches use YouTube Music's own search).
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
  // On a server (ALERT_URL set) problems are also sent to the alert Worker, which emails them.
  const health = new Health({ notify: allNotify(macNotify, alertFromEnv(process.env, log)), log, save: (problems) => catalog.setState('health.problems', JSON.stringify(problems)) });
  catalog.setState('health.problems', '[]');
  // Zemer's artist list is what YouTube Music songs are filtered by, and it changes through the day: kept current while the
  // bot runs, with a note on the Mac if it goes a day without updating (the last good list is used meanwhile).
  const stopWatching = whitelist?.watch((error) => {
    if (error === undefined) health.ok('whitelist', "Fixed: Zemer's artist list is updating again.");
    else if (whitelist.ageMs > 24 * 60 * 60_000) health.problem('whitelist', `Zemer's artist list hasn't updated for a day (${error}). YouTube Music songs are being checked against the old list.`);
  });
  void whitelist?.warm().then(() => whitelist.loaded && log(`Zemer's artist list: ${whitelist.size.artists} artists, ${whitelist.size.blocked} blocked songs`));

  // With ONEDRIVE_CLIENT_ID set, every song sent is also saved to the owner's OneDrive (signed in on the setup page).
  const oneDrive = oneDriveFromEnv(process.env, { state: catalog, log });
  const cloudBudget = parseCloudBudget(process.env.ONEDRIVE_MAX_MB_PER_MONTH);
  if (cloudBudget instanceof Error) throw cloudBudget;
  // Songs kept on disk (the most played, the newest, the most viewed), album art, and the daily new-music message.
  const library = setUpLibrary({
    catalog,
    musicTable,
    audio,
    dbPath: config.dbPath,
    ...(oneDrive
      ? {
          cloudFolder: oneDrive,
          cloudMonthlyBytes: cloudBudget,
          // On a small cloud host the OneDrive copy of a big song waits for memory, or is skipped, rather than crowd out sending.
          cloudMemory: memoryCheck(),
          onCloudFolder: (problem: string | undefined, needsLogin: boolean) =>
            problem
              ? health.problem('onedrive', `Songs are not being saved to OneDrive: ${problem}${needsLogin ? ' Open the setup page and sign in to OneDrive again.' : ''}`)
              : health.ok('onedrive', 'Fixed: songs are being saved to OneDrive again.'),
        }
      : {}),
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
  const sources = songSources({ catalog, musicTable, youTube, whitelist, zemer });
  // A YouTube Music song is checked against the list as it stands when it is sent, not only when it was found.
  const gate = youTube && whitelist ? youTubeGate({ youTube, whitelist, catalog }) : undefined;
  const bot = createBot({
    catalog,
    checkAudio: gatedAudioCheck(gate, library.checkAudio),
    onPlay: library.onPlay,
    browse: library.browse,
    follows: library.follows,
    ...(assistant ? { assistant } : {}),
    ...sources,
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
    // A restart (routine on a cloud host) answers what was sent while the bot was down instead of dropping it.
    resume: resumeIn(catalog),
    pollMs: config.pollMs,
    songGapMs: config.songGapMs,
    ...(config.downloadsAhead ? { downloadsAhead: config.downloadsAhead } : {}),
    maxFileBytes: maxBytes,
    onBridgeSendFailure: () => bridge.sendFailed(),
    ...(pictureTakers.length > 0 ? { onPicture: (picture: IncomingPicture) => pictureTakers.forEach((extension) => extension.onPicture!(picture)) } : {}),
    log,
    // Half a minute without the homeserver is worth a word; it comes back on its own when it's restarted.
    onPoll: (ok, failures, error) => {
      if (ok) health.ok('homeserver', 'Fixed: the bot can reach the Matrix homeserver again.');
      else if (failures >= 20) health.problem('homeserver', `The bot can't reach the Matrix homeserver (${error ?? 'no answer'}). It restarts on its own; if this lasts, restart the service in Render.`);
    },
  });
  await runner.start();
  // The daily message and the new-song alerts count as sent once the chat takes them, which it does even when the bridge
  // can't pass them on to Google Messages (unlinked, disconnected) and they would be lost. So they wait until it can;
  // the daily message tries again in half an hour, the alerts at the next round.
  library.start(async (replies) => {
    const blocked = ['bridge', 'internet'].find((key) => health.has(key));
    if (blocked) throw new Error(blocked === 'internet' ? 'the host has no internet' : 'the bridge is not connected to Google Messages');
    await runner.announce(replies);
  });
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
  // A word in the chat once the bot is up and the bridge can pass it on (the cloud host asks for it once, on its first start).
  let shuttingDown = false;
  void sendStartupMessage({
    mode: startupModeFrom(process.env),
    state: catalog,
    ready: async () => {
      await bridge.check();
      return !['bridge', 'internet'].some((key) => health.has(key));
    },
    send: (replies) => runner.announce(replies),
    stopped: () => shuttingDown,
    log,
  });
  log(
    `signed in as ${userId}, watching room ${config.roomID}, ${catalog.count()} tracks in ${config.dbPath}, Zemer ${zemer ? 'on' : youTube ? 'off (YouTube Music search instead)' : 'off'}, music-table.com ${musicTable ? 'on' : 'off'}, ${library.summary}${extensions.map((extension) => `, ${extension.summary ?? extension.name}`).join('')}. Text "search" and a song name in that chat.`,
  );

  const shutdown = async () => {
    log('shutting down');
    shuttingDown = true;
    clearInterval(watching);
    stopWatching?.();
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
