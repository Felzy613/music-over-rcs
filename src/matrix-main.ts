import './load-env.ts';
import './admin/capture.ts';
import { loadMatrixConfig } from './config.ts';
import { addChat, startHost } from './host.ts';
import { describeMatrixError } from './matrix/client.ts';
import { OWNER } from './people.ts';

// Answers song requests typed into one Google Messages chat, through the mautrix-gmessages bridge and a Matrix room. This file is only the
// entry point (`npm run matrix`, and the cloud host's cloud-main.ts imports it once the chat is chosen): what the bot is made of is
// built in src/host.ts, once for everything the chats share (`startHost`) and once for each person's own chat (`addChat`). Here there is
// the one chat, the owner's, from MATRIX_ACCESS_TOKEN and MATRIX_ROOM_ID.
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
let homeserver: string | undefined;

try {
  // The owner's own token and room are this chat's; what is left is what every chat on the host shares.
  const { token, roomID, ...shared } = loadMatrixConfig();
  homeserver = shared.homeserver;

  const host = await startHost({ config: shared, log });

  const shutdown = async (code = 0) => {
    log('shutting down');
    await host.stop();
    process.exit(code);
  };
  await addChat(host, OWNER, {
    token,
    roomID,
    // A chat deleted on the phone takes its room with it, and the bot would go on running without hearing from it. Stopping makes the host
    // start the bot again, and that start (cloud-main.ts) says the chat is gone, mails it, and waits for a new chat to be chosen.
    onRoomGone: (room) => {
      log(`the chat room ${room} is gone (the homeserver no longer knows it or won't let the bot in); stopping so the host can wait for a new chat to be chosen`);
      void shutdown(1);
    },
  });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
} catch (err) {
  console.error(describeMatrixError(err, homeserver));
  process.exit(1);
}
