import '../src/load-env.ts';
import { BeeperClient, describeBeeperError } from '../src/beeper/client.ts';
import { loadBeeperConfig } from '../src/config.ts';

// Lists your Beeper chats so you can find the ID of your "message yourself" chat. An optional word filters the list.
const filter = process.argv.slice(2).join(' ').trim().toLowerCase();
let baseUrl: string | undefined;

try {
  const config = loadBeeperConfig(process.env, { chat: false });
  baseUrl = config.baseUrl;
  const beeper = new BeeperClient({ token: config.token, baseUrl: config.baseUrl });
  const chats = (await beeper.listChats()).filter(
    (chat) => !filter || `${chat.title} ${chat.network} ${chat.accountID}`.toLowerCase().includes(filter),
  );

  if (chats.length === 0) console.log(filter ? `no chats match "${filter}"` : 'no chats found');
  for (const chat of chats) {
    const note = chat.selfOnly ? '   <- looks like your "message yourself" chat' : '';
    console.log(`${chat.id}\n    ${chat.network || chat.accountID} | ${chat.type} | ${chat.title || '(no title)'}${note}`);
  }
  console.log('\nPut the chat ID in .env as BEEPER_CHAT_ID. Tip: npm run beeper-chats -- google');
} catch (err) {
  console.error(describeBeeperError(err, baseUrl));
  process.exit(1);
}
