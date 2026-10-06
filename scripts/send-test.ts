import '../src/load-env.ts';
import { loadConfig } from '../src/config.ts';
import { RbmClient, RbmError, ServiceAccountAuth } from '../src/rbm/client.ts';

// Sends straight to a tester phone, bypassing the webhook: isolates credential and file-URL problems.
const [phone, ...rest] = process.argv.slice(2);
const audioAt = rest.indexOf('--audio');
const audioUrl = audioAt >= 0 ? rest[audioAt + 1] : undefined;

if (!phone || (audioAt >= 0 && !audioUrl)) {
  console.error('usage: npm run send-test -- +15551234567 "hello"');
  console.error('       npm run send-test -- +15551234567 --audio https://example.com/file.mp3');
  process.exit(1);
}

try {
  const config = loadConfig(process.env, { webhook: false });
  const rbm = new RbmClient({
    agentId: config.agentId,
    region: config.region,
    trafficType: config.trafficType,
    auth: ServiceAccountAuth.fromFile(config.keyPath),
  });
  if (audioUrl) {
    await rbm.sendAudio(phone, audioUrl);
    console.log('Audio message accepted by the RBM API. Google fetches the file, then delivers it.');
  } else {
    await rbm.sendText(phone, rest.join(' ') || 'Hello from Music over RCS');
    console.log('Text message accepted by the RBM API.');
  }
} catch (err) {
  if (err instanceof RbmError) console.error(`${err.message}\n${err.body}`);
  else console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
