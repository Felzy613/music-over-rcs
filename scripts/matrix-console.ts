import '../src/load-env.ts';
import { createInterface } from 'node:readline/promises';
import { loadMatrixConfig } from '../src/config.ts';
import { describeMatrixError, MatrixClient, type RoomEvent } from '../src/matrix/client.ts';
import { groupPastedLines } from '../src/matrix/paste.ts';

// A small chat window to the bridge bot. Use it to log the bridge in to Google Messages (`login google`).
// What you type goes to the bot as you typed it; its replies are printed. Your own messages are never echoed back.
// A pasted command that spans several lines (a cURL copied from browser devtools) is sent as one message.
const botArg = process.argv[2];
let homeserver: string | undefined;

try {
  const config = loadMatrixConfig(process.env, { room: false });
  homeserver = config.homeserver;
  const matrix = new MatrixClient({ token: config.token, homeserver });
  const { userId } = await matrix.whoami();
  const botId = botArg ?? `@gmessagesbot:${userId.slice(userId.indexOf(':') + 1)}`;

  const rooms = await matrix.listRooms();
  let roomId = rooms.find((room) => !room.invited && room.members <= 2 && room.heroes.includes(botId))?.id;
  if (!roomId) {
    roomId = await matrix.createDirectRoom(botId);
    console.log(`Opened a new chat with ${botId}.`);
  }
  console.log(`Chatting with ${botId}. Type "help" for the bridge's commands, "login google" to connect Google Messages.`);
  console.log('You can paste a command that spans several lines; it is sent as one message. Press Ctrl+C to leave.\n');

  const show = (events: RoomEvent[]) => {
    for (const event of events.filter((e) => e.sender !== userId)) {
      console.log(`bridge > ${event.body.replaceAll('\n', '\n         ')}`);
    }
  };
  show(await matrix.pollEvents(roomId));
  const timer = setInterval(() => {
    matrix.pollEvents(roomId!).then(show, (err: unknown) => console.error(describeMatrixError(err, homeserver)));
  }, 1000);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for await (const message of groupPastedLines(rl)) {
    await matrix.sendText(roomId, message.text);
    if (message.lines > 1) console.log(`(sent ${message.lines} pasted lines as one message)`);
  }
  clearInterval(timer);
  process.stdin.unref();
} catch (err) {
  console.error(describeMatrixError(err, homeserver));
  process.exit(1);
}
