import '../src/load-env.ts';
import { fetchAudio } from '../src/audio-fetch.ts';
import { loadMatrixConfig } from '../src/config.ts';
import { describeMatrixError, MatrixClient } from '../src/matrix/client.ts';
import { markBotText } from '../src/runner.ts';

// Sends one message (or one audio file) into the watched room, to check the whole path without the bot running.
const args = process.argv.slice(2);
const audioAt = args.indexOf('--audio');
const audioUrl = audioAt >= 0 ? args[audioAt + 1] : undefined;

if (args.length === 0 || (audioAt >= 0 && !audioUrl)) {
  console.error('usage: npm run matrix-send -- "hello"');
  console.error('       npm run matrix-send -- --audio https://example.com/file.mp3');
  process.exit(1);
}

let homeserver: string | undefined;
try {
  const config = loadMatrixConfig();
  homeserver = config.homeserver;
  const matrix = new MatrixClient({ token: config.token, homeserver });
  await matrix.joinRoom(config.roomID);
  if (audioUrl) {
    const audio = await fetchAudio(audioUrl, undefined, { maxBytes: config.maxDownloadMb * 1024 * 1024 });
    await matrix.sendAudio(config.roomID, audio);
    console.log(`sent ${audio.fileName} (${audio.bytes} bytes). Check your phone.`);
  } else {
    // The marker keeps a running bot from treating this test message as a song request.
    await matrix.sendText(config.roomID, markBotText(args.join(' ')));
    console.log('sent. Check your phone.');
  }
} catch (err) {
  console.error(describeMatrixError(err, homeserver));
  process.exit(1);
}
