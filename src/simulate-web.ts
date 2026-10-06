import './load-env.ts';
import { spawn } from 'node:child_process';
import { Catalog } from './catalog.ts';
import { createSimulator } from './simulator/server.ts';
import { Trace } from './simulator/trace.ts';
import { musicTableFromEnv } from './sources/music-table.ts';

// A Google-Messages-style chat in your browser, wired to the real bot: the same runner, catalog, music-table.com
// lookup and download-link code the phone setup uses, with a panel showing each step and how long it took.
//   --port 8788     where to listen (127.0.0.1 only)
//   --real-catalog  use your real catalog (CATALOG_DB); by default a fresh one in memory, so searches are live
//   --full          really download each file, as the bot does before sending it (slow, and uses the site's bandwidth)
//   --open          open the page in your browser
const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8788;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('--port must be a number from 1 to 65535');
  process.exit(2);
}

const trace = new Trace();
const catalog = new Catalog(flag('real-catalog') ? (process.env.CATALOG_DB ?? 'data/catalog.db') : ':memory:');
const musicTable = musicTableFromEnv(process.env, { onEvent: (event) => trace.site(event) });
void musicTable?.warm();
const maxMb = Number(process.env.MAX_DOWNLOAD_MB) || 100;

const simulator = createSimulator({ catalog, musicTable, trace, full: flag('full'), maxBytes: maxMb * 1024 * 1024 });
try {
  const { url } = await simulator.listen(port);
  console.log(`Message simulator: ${url}`);
  console.log(
    `${catalog.count()} saved tracks (${flag('real-catalog') ? 'your catalog' : 'a fresh in-memory catalog'}), music-table.com ${musicTable ? 'on' : 'off'}, ${flag('full') ? 'files are really downloaded' : 'files are checked but not downloaded'}.`,
  );
  console.log('Press Ctrl+C to stop.');
  if (flag('open')) spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  console.error(code === 'EADDRINUSE' ? `Port ${port} is already in use. Try --port ${port + 1}.` : err instanceof Error ? err.message : err);
  process.exit(1);
}

const shutdown = async () => {
  await simulator.close();
  catalog.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
