import '../src/load-env.ts';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { upsertEnvLine } from '../src/dotenv.ts';
import { DEFAULT_HOMESERVER, describeMatrixError, MatrixClient } from '../src/matrix/client.ts';

// Signs in to your homeserver once and saves the access token to .env. The password is typed here (hidden),
// sent to the homeserver and never stored; everything after this uses the token.
function ask(question: string, hidden = false): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(question);
    muted = hidden;
    rl.question('', (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(hidden ? answer : answer.trim());
    });
  });
}

const fallback = process.env.MATRIX_HOMESERVER?.trim() || DEFAULT_HOMESERVER;
const homeserver = (await ask(`Homeserver [${fallback}]: `)) || fallback;
const user = await ask('Username: ');
const password = await ask('Password: ', true);

try {
  const { accessToken, userId } = await MatrixClient.login(homeserver, user, password);
  let text = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  text = upsertEnvLine(text, 'MATRIX_HOMESERVER', homeserver);
  text = upsertEnvLine(text, 'MATRIX_ACCESS_TOKEN', accessToken);
  writeFileSync('.env', text, { mode: 0o600 });
  chmodSync('.env', 0o600);
  console.log(`Signed in as ${userId}. Saved MATRIX_HOMESERVER and MATRIX_ACCESS_TOKEN to .env (the token is not shown).`);
  process.stdin.unref(); // readline leaves stdin open, which would otherwise keep this process alive
} catch (err) {
  console.error(describeMatrixError(err, homeserver));
  process.exit(1);
}
