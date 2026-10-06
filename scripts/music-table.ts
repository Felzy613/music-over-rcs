import '../src/load-env.ts';
import { checkAudio } from '../src/audio-check.ts';
import { megabytes } from '../src/audio-check.ts';
import { MusicTable, MusicTableError, musicTableFromEnv, tracksOf } from '../src/sources/music-table.ts';

// Try the music-table.com source by hand. Neither command downloads any audio.
const USAGE = `Usage:
  npm run music-table -- search <words>      what the bot would find for those words, with each post's files
  npm run music-table -- check <post link>   resolve a post's download link and check it (type and size only)`;

const [command, ...rest] = process.argv.slice(2);
const table = musicTableFromEnv() ?? new MusicTable();
const mb = (bytes: number) => (bytes > 0 ? `${megabytes(bytes)} MB` : 'size unknown');

try {
  if (command === 'search' && rest.length > 0) {
    const query = rest.join(' ');
    const hits = await table.search(query);
    console.log(`${hits.length} results on music-table.com for "${query}" (checking the first 5 for MP3 files):`);
    let n = 0;
    for (const hit of hits) {
      n += 1;
      if (n > 5) {
        console.log(`  ${n}. ${hit.title || hit.slug}   (not checked)`);
        continue;
      }
      try {
        const post = await table.getPost(hit.slug);
        if (post.files.length === 0) {
          console.log(`  ${n}. ${post.title}   no MP3 download (video or news only), skipped`);
          continue;
        }
        console.log(`  ${n}. ${post.title}`);
        for (const track of tracksOf(table, post)) {
          const file = post.files[Number(track.url.split('#')[1])]!;
          console.log(`       ${track.artist ? `${track.artist} — ` : ''}${track.title}   ${file.name}, ${mb(file.size)}`);
        }
      } catch (err) {
        console.log(`  ${n}. ${hit.title || hit.slug}   could not read: ${err instanceof Error ? err.message : err}`);
      }
    }
  } else if (command === 'check' && rest.length === 1) {
    const arg = rest[0]!;
    const ref = table.parseTrackUrl(arg) ?? table.parseTrackUrl(`${table.baseUrl}/post/${arg}`);
    if (!ref) throw new MusicTableError('give a post link such as https://www.music-table.com/post/some-post');
    const link = await table.resolveUrl(table.trackUrl(ref, ref.index));
    // Show where the link points, never the token inside it.
    console.log(`download link: ${new URL(link).host}${new URL(link).pathname.slice(0, 60)}… (token hidden)`);
    const check = await checkAudio(link, { allowPrivateHosts: true, allowAnyAudio: true });
    console.log(check.ok ? `ok: ${check.type}, ${check.bytes === undefined ? 'size unknown' : mb(check.bytes)}` : `not usable: ${check.reason}`);
    if (!check.ok) process.exitCode = 1;
  } else {
    console.log(USAGE);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof MusicTableError ? `music-table.com: ${err.message}` : err);
  process.exitCode = 1;
}
