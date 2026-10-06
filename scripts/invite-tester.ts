import '../src/load-env.ts';
import { loadConfig } from '../src/config.ts';
import { mask } from '../src/handler.ts';
import { RbmClient, RbmError, ServiceAccountAuth } from '../src/rbm/client.ts';

const phone = process.argv[2];
if (!phone) {
  console.error('usage: npm run invite-tester -- +15551234567');
  process.exit(1);
}

try {
  const config = loadConfig(process.env, { webhook: false });
  const rbm = new RbmClient({
    agentId: config.agentId,
    region: config.region,
    auth: ServiceAccountAuth.fromFile(config.keyPath),
  });
  await rbm.inviteTester(phone);
  console.log(`Invite sent to ${mask(phone)}. Accept it on that phone in Google Messages (RCS chat features must be on).`);
  console.log('Google allows 20 invites a day and 200 in total per agent.');
} catch (err) {
  if (err instanceof RbmError) console.error(`${err.message}\n${err.body}`);
  else console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
