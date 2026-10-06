import '../src/load-env.ts';
import { fetchAudio } from '../src/audio-fetch.ts';
import { BeeperClient, describeBeeperError } from '../src/beeper/client.ts';
import { markBotText } from '../src/runner.ts';
import { loadBeeperConfig } from '../src/config.ts';

// Sends one message (or one audio file) into the watched chat, to check the whole path without the bot running.
const args = process.argv.slice(2);
const audioAt = args.indexOf('--audio');
const audioUrl = audioAt >= 0 ? args[audioAt + 1] : undefined;

if (args.length === 0 || (audioAt >= 0 && !audioUrl)) {
  console.error('usage: npm run beeper-send -- "hello"');
  console.error('       npm run beeper-send -- --audio https://example.com/file.mp3');
  process.exit(1);
}

let baseUrl: string | undefined;
try {
  const config = loadBeeperConfig();
  baseUrl = config.baseUrl;
  const beeper = new BeeperClient({ token: config.token, baseUrl: config.baseUrl });
  if (audioUrl) {
    const audio = await fetchAudio(audioUrl, undefined, { maxBytes: config.maxDownloadMb * 1024 * 1024 });
    await beeper.sendAudio(config.chatID, audio);
    console.log(`sent ${audio.fileName} (${audio.bytes} bytes). Check your phone.`);
  } else {
    // The marker keeps a running bot from treating this test message as a song request.
    await beeper.sendText(config.chatID, markBotText(args.join(' ')));
    console.log('sent. Check your phone.');
  }
} catch (err) {
  console.error(describeBeeperError(err, baseUrl));
  process.exit(1);
}
