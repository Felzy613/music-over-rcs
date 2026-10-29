import { artistKey, splitArtists } from './artists.ts';
import type { Album } from './bot.ts';
import type { Category } from './views.ts';

// How a menu's lines read (the owner asked for a streaming app's menu, 2026-10-20): one message per line so each can be
// 👍'd, no headings (the marks tell the kinds apart, and a heading would be a message that can't be 👍'd): 🎤 an artist,
// 💿 an album with its number, a song as "Title — Artist" (the runner puts 🎵 in front), 📦 an album's zip. The last line
// says what else can be done, and a 👍 on it comes back to its menu.

/** How many of each kind a menu shows first, and how many more each "… more" shows. */
export const FIRST_PAGE = 5;
export const NEXT_PAGE = 8;

/** "A", "A & B", "A, B & C". */
export const joinNames = (names: string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`);

/** A credit short enough for one line: "A", "A & B", or "A & 7 more" for a long one. */
export function shortCredit(credit: string): string {
  const names = splitArtists(credit);
  if (names.length <= 2) return names.length > 0 ? joinNames(names) : credit.trim();
  return `${names[0]} & ${names.length - 1} more`;
}

/** A title as it is shown: without the track number some of music-table.com's songs start with ("01 Kumzitz"). */
export const shownTitle = (title: string): string => title.replace(/^\d{1,3}[.)]?\s+(?=\p{L})/u, '').trim() || title;

/** The first artist credited, by which a list is told to be one artist's. */
export const mainArtist = (credit: string): string => splitArtists(credit)[0] ?? credit.trim();

/** A song in a list: "Title", or "Title — Artist" when the list isn't all theirs. */
export const songLine = (song: { title: string; artist: string }, credit: boolean): string =>
  credit && song.artist ? `${shownTitle(song.title)} — ${shortCredit(song.artist)}` : shownTitle(song.title);

/** A release of one song (or a song and its versions), which is listed as its song rather than as an album of it. */
export const isSingle = (album: Album): boolean => Boolean(album.single) || album.songs === 1;

/** An album in a list: "💿 Title · 2008 · 14 songs", with " — Artist" after the title when the list isn't all theirs. */
export function albumLine(album: Album, credit = false): string {
  const size = isSingle(album) ? 'single' : album.songs ? `${album.songs} songs` : undefined;
  const details = [album.year, size].filter((detail) => detail !== undefined);
  return `💿 ${album.title}${credit && album.artist ? ` — ${shortCredit(album.artist)}` : ''}${details.map((detail) => ` · ${detail}`).join('')}`;
}

/** An artist in a menu. */
export const artistLine = (name: string): string => `🎤 ${name}`;

/** Whether a line by `credit` leaves the artist out: when the menu's artists are just one, and the line is theirs alone. */
export function creditNeeded(credit: string, onlyArtist: { name: string; aka?: string | undefined } | undefined): boolean {
  if (!onlyArtist) return true;
  const key = artistKey(credit);
  return key !== artistKey(onlyArtist.name) && (!onlyArtist.aka || key !== artistKey(onlyArtist.aka));
}

/** '"albums more" or "songs more"', '"artists more", "albums more" or "songs more"'. */
export const orList = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`);

/**
 * A menu's last line: what "… more" can still show, and that an album's number opens it. Where every line is numbered
 * instead (a chat a 👍 can't reach), `numbered` says to reply with a number.
 */
export function closingLine(more: Category[], hasAlbums: boolean, hasSongs: boolean): { text: string; numbered: string } {
  const paging = more.length === 1 ? `Text "${more[0]} more" for ${NEXT_PAGE} more ${more[0]}` : more.length > 1 ? `Text ${orList(more.map((kind) => `"${kind} more"`))} for ${NEXT_PAGE} more` : '';
  if (paging) {
    return {
      text: `${paging}${hasAlbums ? ", or an album's number for its songs" : ''}.`,
      numbered: `${paging}, or reply with a number to pick one.`,
    };
  }
  return {
    text: hasAlbums ? "Text an album's number for its songs." : hasSongs ? 'Tap 👍 on a song to get it.' : 'Tap 👍 on one to open it.',
    numbered: 'Reply with a number to pick one.',
  };
}

/** The whole help, as one message: every command (a message has to start with one), as far as this bot has them. */
export function helpText(has: { browse: boolean; follows: boolean; finder: boolean; releases?: boolean }): string {
  return [
    'Start each message with a command:',
    'search <words> — artists, albums and songs',
    ...(has.finder ? ['artist / album / song <words> — just that kind'] : ['song <words> — just songs']),
    'artists more · albums more · songs more — 8 more ("more" repeats the last)',
    ...(has.finder
      ? [
          '👍 a 🎤 artist — newest albums and top songs',
          '👍 a 💿 album, or text its number — its songs; 👍 a song or text its number to get it',
          '👍 📦 or text "zip" — the whole album as one zip',
        ]
      : ['👍 a song to get it']),
    '👍 any line of an earlier list — back to that list',
    'all — every song on the list (up to 20)',
    ...(has.finder ? ['zemer <words> — Zemer only'] : []),
    ...(has.browse
      ? has.releases
        ? ['new — the newest releases, from Zemer and music-table.com', 'trending · chanukah · purim · wedding · vocal — music-table.com lists']
        : ['trending · new · chanukah · purim · wedding · vocal — music-table.com lists']
      : []),
    ...(has.follows ? ['follow / unfollow <artist> · following'] : []),
  ].join('\n');
}
