import './load-env.ts';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { checkAudio, MAX_BYTES } from './audio-check.ts';
import { createBot, joinLists } from './bot.ts';
import { Catalog } from './catalog.ts';
import { musicTableFromEnv, resolvingAudio } from './sources/music-table.ts';
import { songSources } from './sources/songs.ts';
import { gatedAudioCheck, resolvingYouTubeAudio, youTubeGate, youTubeMusicFromEnv } from './sources/youtube-music.ts';
import { zemerSearchFromEnv } from './sources/zemer.ts';
import { zemerWhitelistFromEnv } from './sources/zemer-whitelist.ts';
import type { Chip, Incoming, Reply } from './types.ts';

// A local stand-in for Google Messages: same bot, no accounts, no network except the URL checks and the lookups (a
// search asks YouTube Music, then the catalog and music-table.com; YOUTUBE_MUSIC=off and MUSIC_TABLE=off stop that).
// It never downloads any audio.
//   --offline  skip the URL checks and the YouTube Music and music-table.com lookups
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
const youTube = offline ? undefined : youTubeMusicFromEnv();
const zemer = youTube && zemerSearchFromEnv();
const whitelist = youTube && zemerWhitelistFromEnv(process.env, { state: catalog });
void whitelist?.warm();
const gate = youTube && whitelist ? youTubeGate({ youTube, whitelist, catalog }) : undefined;
const checkLink = resolvingYouTubeAudio(
  youTube,
  resolvingAudio(
    musicTable,
    {
      checkAudio: (url) => checkAudio(url),
      fetchAudio: async () => {
        throw new Error('the simulator never downloads audio');
      },
    },
    { maxBytes: MAX_BYTES },
  ),
  { maxBytes: MAX_BYTES },
).checkAudio;
const sources = songSources({ catalog, musicTable, youTube, whitelist, zemer });
const bot = createBot({
  catalog,
  checkAudio: offline ? async () => ({ ok: true, type: 'audio/mpeg' }) : gatedAudioCheck(gate, checkLink),
  ...sources,
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
  if (reply.kind === 'album') {
    console.log(`bot > [zip: ${reply.artist ? `${reply.artist} — ` : ''}${reply.title}, ${reply.songs.length} songs]`);
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
  : `${catalog.count()} tracks in ${dbPath}${offline ? ', URL checks skipped' : ''}${zemer ? ', Zemer on' : youTube ? ', YouTube Music on' : ''}${musicTable ? ', music-table.com on' : ''}`;
const intro = [`Local simulator (${mode})`];
const asked = [sources.finder?.name, sources.source?.name].filter((name): name is string => name !== undefined);
if (sources.musicTableFirst) asked.reverse();
if (asked.length > 0) intro.push(`A search asks ${asked.join(', then ')}, and keeps what it finds.`);
if (!demo && asked.length === 0 && catalog.count() === 0) {
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
