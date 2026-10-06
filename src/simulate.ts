import './load-env.ts';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { checkAudio, MAX_BYTES } from './audio-check.ts';
import { createBot, joinLists } from './bot.ts';
import { Catalog } from './catalog.ts';
import { createMusicTableSource, musicTableFromEnv, resolvingAudio } from './sources/music-table.ts';
import type { Chip, Incoming, Reply } from './types.ts';

// A local stand-in for Google Messages: same bot, no accounts, no network except the URL checks and, when the
// catalog has no match, a look on music-table.com (MUSIC_TABLE=off stops that). It never downloads any audio.
//   --offline  skip the URL checks and the music-table.com lookups
//   --demo     use three made-up tracks held in memory (implies --offline), to try it before you have a catalog
const demo = process.argv.includes('--demo');
const offline = demo || process.argv.includes('--offline');
const dbPath = demo ? ':memory:' : (process.env.CATALOG_DB ?? 'data/catalog.db');

const DEMO_TRACKS = [
  { title: 'Blue Horizon', artist: 'The Night Owls', url: 'https://demo.invalid/blue-horizon.mp3' },
  { title: 'Blue Horizon (Live)', artist: 'The Night Owls', url: 'https://demo.invalid/blue-horizon-live.mp3' },
  { title: 'Paper Planes at Dawn', artist: 'Mira Vale', url: 'https://demo.invalid/paper-planes.mp3' },
];

const catalog = new Catalog(dbPath);
if (demo) {
  for (const track of DEMO_TRACKS) catalog.add(track);
}
const musicTable = offline ? undefined : musicTableFromEnv();
void musicTable?.warm();
const checkLink = resolvingAudio(
  musicTable,
  {
    checkAudio: (url) => checkAudio(url),
    fetchAudio: async () => {
      throw new Error('the simulator never downloads audio');
    },
  },
  { maxBytes: MAX_BYTES },
).checkAudio;
const bot = createBot({
  catalog,
  checkAudio: offline ? async () => ({ ok: true, type: 'audio/mpeg' }) : checkLink,
  ...(musicTable ? { source: createMusicTableSource({ musicTable, catalog }) } : {}),
});

let chips: Chip[] = [];

function print(reply: Reply): void {
  if (reply.kind === 'audio') {
    console.log(`bot > [audio file] ${reply.url}`);
    return;
  }
  if (reply.kind === 'image') {
    console.log(`bot > [picture] ${reply.url}${reply.caption ? `\n      ${reply.caption.artist ? `${reply.caption.artist} — ` : ''}${reply.caption.title}` : ''}`);
    return;
  }
  if (reply.kind === 'collage') {
    console.log(`bot > [one picture of ${reply.images.length} numbered covers]`);
    return;
  }
  console.log(`bot > ${reply.text.replaceAll('\n', '\n      ')}`);
  if (reply.chips) {
    chips = reply.chips;
    console.log(`      ${reply.chips.map((chip, i) => `[${i + 1}] ${chip.label}`).join('   ')}`);
  }
}

const mode = demo
  ? 'demo: 3 made-up tracks'
  : `${catalog.count()} tracks in ${dbPath}${offline ? ', URL checks skipped' : ''}${musicTable ? ', music-table.com on' : ''}`;
const intro = [`Local simulator (${mode})`];
if (musicTable) intro.push('When the catalog has no match, the bot looks on music-table.com and keeps what it finds.');
if (!demo && !musicTable && catalog.count() === 0) {
  intro.push('The catalog is empty, so every request will answer "No match".');
  intro.push('Add tracks first (see the README), or try the made-up catalog: npm run simulate -- --demo');
}
if (demo) intro.push('Try: paper planes, night owls, blue horizon, hi');
intro.push('Type a request as you would in Google Messages. Type a number to tap a chip, "quit" or "exit" to leave.', '');
console.log(intro.join('\n'));

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you > ' });
// With piped input the stream can end while a request is still being answered; prompting then would throw.
let closed = false;
rl.on('close', () => {
  closed = true;
});
const prompt = () => {
  if (!closed) rl.prompt();
};
prompt();
for await (const line of rl) {
  const input = line.trim();
  if (input === 'quit' || input === 'exit') break;
  if (input) {
    const tapped = /^\d+$/.test(input) ? chips[Number(input) - 1] : undefined;
    const base = { from: '+15550000000', messageId: randomUUID() };
    const msg: Incoming = tapped ? { ...base, postback: tapped.postback } : { ...base, text: input };
    chips = [];
    for (const reply of joinLists(await bot.handle(msg))) print(reply);
  }
  prompt();
}
rl.close();
catalog.close();
