import '../src/load-env.ts';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { checkAudio } from '../src/audio-check.ts';
import { Catalog } from '../src/catalog.ts';
import { tracksFromCsv, tracksFromJson } from '../src/import.ts';
import { musicTableFromEnv } from '../src/sources/music-table.ts';
import type { Track } from '../src/types.ts';

const USAGE = `Usage: npm run catalog -- <command>

  add <title> <artist> <url>     add a track, or update it if the URL is already there
  import <file.csv|file.json>    bulk add; CSV needs a header row: title,artist,url
  list [limit]                   show the newest tracks
  search <words...>              run a query exactly as the bot would
  remove <id>                    delete a track
  check                          test every URL the way the agent does (reachable, audio type, size)

Catalog entries must be direct links to MP3/AAC/OGG files, up to 100 MiB, that you have the right to use.
Songs the bot finds on music-table.com are stored here too, as links to their posts (see "npm run music-table").
`;

const label = (track: Track): string => `${track.artist ? `${track.artist} - ` : ''}${track.title}`;

async function run(command: string | undefined, args: string[], catalog: Catalog): Promise<number> {
  switch (command) {
    case 'add': {
      const [title, artist, url] = args;
      if (!title || artist === undefined || !url) {
        console.error('usage: add <title> <artist> <url>');
        return 1;
      }
      const track = catalog.add({ title, artist, url });
      console.log(`saved #${track.id}: ${label(track)}`);
      return 0;
    }
    case 'import': {
      const file = args[0];
      if (!file) {
        console.error('usage: import <file.csv|file.json>');
        return 1;
      }
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        console.error(`can't find "${file}" (looked in ${process.cwd()}).`);
        console.error('Create it as a CSV with a header row, then one track per line:\n');
        console.error('  title,artist,url');
        console.error('  Song Name,Artist Name,https://your-host.example/path/song.mp3\n');
        console.error('Or add a single track: npm run catalog -- add "Song Name" "Artist Name" <url>');
        return 1;
      }
      const rows = extname(file).toLowerCase() === '.json' ? tracksFromJson(text) : tracksFromCsv(text);
      let saved = 0;
      const problems: string[] = [];
      rows.forEach((row, i) => {
        try {
          catalog.add(row);
          saved++;
        } catch (err) {
          problems.push(`row ${i + 1} (after the header): ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      console.log(`imported ${saved} of ${rows.length} rows`);
      for (const problem of problems) console.error(`  ${problem}`);
      return problems.length > 0 ? 1 : 0;
    }
    case 'list': {
      for (const track of catalog.list(Number(args[0]) || 50)) console.log(`#${track.id} ${label(track)}\n     ${track.url}`);
      console.log(`\n${catalog.count()} tracks in total`);
      return 0;
    }
    case 'search': {
      const found = catalog.search(args.join(' '), 10);
      for (const track of found) console.log(`#${track.id} ${label(track)}`);
      if (found.length === 0) console.log('no match');
      return 0;
    }
    case 'remove': {
      const removed = catalog.remove(Number(args[0]));
      console.log(removed ? `removed #${args[0]}` : `no track with id ${args[0]}`);
      return removed ? 0 : 1;
    }
    case 'check': {
      const tracks = catalog.all();
      const failures = new Map<number, string | undefined>();
      // Tracks found on music-table.com are links to posts, turned into a download link only when played.
      // Checking them all here would mean a burst of requests to somebody's small site, so they are skipped.
      const musicTable = musicTableFromEnv();
      const onSite = new Set(tracks.filter((track) => musicTable?.parseTrackUrl(track.url)).map((track) => track.id));
      const queue = tracks.filter((track) => !onSite.has(track.id));
      const worker = async () => {
        for (let track = queue.shift(); track; track = queue.shift()) {
          const result = await checkAudio(track.url);
          failures.set(track.id, result.ok ? undefined : result.reason);
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      let bad = 0;
      for (const track of tracks) {
        if (onSite.has(track.id)) {
          console.log(`skip  #${track.id} ${label(track)}: on music-table.com, checked when played (npm run music-table -- check ${track.url})`);
          continue;
        }
        const reason = failures.get(track.id);
        if (reason === undefined) {
          console.log(`ok    #${track.id} ${label(track)}`);
        } else {
          bad++;
          console.log(`FAIL  #${track.id} ${label(track)}: ${reason}\n      ${track.url}`);
        }
      }
      const skipped = onSite.size > 0 ? `, ${onSite.size} on music-table.com not checked` : '';
      console.log(`\n${tracks.length - bad - onSite.size} ok, ${bad} failing${skipped}`);
      return bad > 0 ? 1 : 0;
    }
    default:
      console.log(USAGE);
      return command === undefined ? 0 : 1;
  }
}

const [command, ...args] = process.argv.slice(2);
const catalog = new Catalog(process.env.CATALOG_DB ?? 'data/catalog.db');
try {
  process.exitCode = await run(command, args, catalog);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  catalog.close();
}
