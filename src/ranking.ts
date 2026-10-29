import { artistKey } from './artists.ts';
import type { Album, ArtistRef, FoundSong } from './bot.ts';
import { tokenize } from './query.ts';
import { fitsAll, namesSong, searchWords, soundsLike, wordMatches } from './sources/relevance.ts';

// The order of a search's menu (2026-10-20): what the words name first, then what was played most or came out last.
// Every category keeps the relevance gate it had (`fitsAll`, and for artists that the words cover their name), and
// nothing here picks for the owner: a typo of an artist's name is offered, below the artists the words spell exactly,
// and never opened on its own.

/** A song or album as it is matched: its title, and its artist's name in both alphabets. */
const matchable = (item: { title: string; artist: string; aka?: string | undefined }): { title: string; artist: string } => ({
  title: item.title,
  artist: item.aka ? `${item.artist} ${item.aka}` : item.artist,
});

const HEBREW = /[א-תװ-ײ]/;

/** How well a typed word matches one of these words: 3 it is one, 2 the start of one (or a Hebrew one read its way), 1 a typo away, 0 not. */
function closeness(token: string, words: string[]): number {
  let best = 0;
  for (const word of words) {
    if (word === token) return 3;
    if (word.startsWith(token) || (HEBREW.test(word) && soundsLike(token, word))) best = 2;
    else if (best === 0 && wordMatches(token, word)) best = 1;
  }
  return best;
}

/** How well the words name an artist: undefined when they don't (a word not in the name, or less than half the name). */
export function artistMatch(artist: { name: string; aka?: string | undefined }, tokens: string[]): { tier: number; coverage: number } | undefined {
  const words = tokens.filter((token) => token.length >= 2);
  if (words.length === 0 || words.length < tokens.length) return undefined;
  let best: { tier: number; coverage: number } | undefined;
  for (const name of [artist.name, artist.aka]) {
    const parts = tokenize(name ?? '');
    if (parts.length === 0) continue;
    const tiers = words.map((word) => closeness(word, parts));
    if (tiers.some((tier) => tier === 0)) continue;
    const covered = parts.filter((part) => words.some((word) => wordMatches(word, part) || (HEBREW.test(part) && soundsLike(word, part)))).length;
    if (covered * 2 < parts.length) continue;
    const match = { tier: Math.min(...tiers), coverage: covered / parts.length };
    if (!best || match.tier > best.tier || (match.tier === best.tier && match.coverage > best.coverage)) best = match;
  }
  return best;
}

/**
 * The artists the words name, best first: the ones every word spells exactly, then the ones they start, then a typo away
 * ("achas" for Nachas: offered, never trusted); then the ones whose name the words cover most; then the source's order.
 */
export function rankArtists<T extends { name: string; aka?: string | undefined }>(artists: T[], tokens: string[]): T[] {
  return artists
    .flatMap((artist, i) => {
      const match = artistMatch(artist, tokens);
      return match ? [{ artist, i, ...match }] : [];
    })
    .sort((a, b) => b.tier - a.tier || b.coverage - a.coverage || a.i - b.i)
    .map((entry) => entry.artist);
}

/** A title without what only says who else is on it: "Achas (feat. X)" is the song "Achas". */
export const withoutGuests = (title: string): string => title.replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '').trim() || title;

/** A song as two sources would both spell it (a single "Achas (feat. X)" is the song "Achas"), so the same song from each is told apart from different ones. */
export const songKey = (song: { title: string; artist: string }): string => `${tokenize(withoutGuests(song.title)).join(' ')}|${tokenize(song.artist).join(' ')}`;

/** What tells a release apart from the others of its kind, whoever lists it: a single is its song, an album its title. */
export const releaseKey = (kind: 'single' | 'album', release: { title: string; artist: string }): string => `${kind}|${songKey(release)}`;

/** A title without who else is on it or that it was recorded live, for naming it: "Achas (feat. X)", "Achas (Live)". */
export const plainTitle = (title: string): string => withoutGuests(title).replace(/\s*[([]live[^)\]]*[)\]]/gi, '').trim() || title;

const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * How well the words fit a song: 3 they name it (its title, give or take "(feat. …)" and "(Live)", either alphabet), 2
 * every word is in its title, 1 it fits only with its artist's name, 0 it doesn't fit. The artist's own name in a title
 * doesn't count as the title's ("Lipa Schmeltzer X Sruly Green - i need my Afikoman" is not more about "lipa schmeltzer"
 * than his other songs).
 */
export function songTier(song: { title: string; artist: string; aka?: string | undefined }, tokens: string[]): number {
  const item = matchable(song);
  if (!fitsAll(item, tokens)) return 0;
  if (namesSong(item, tokens) || namesSong({ ...item, title: plainTitle(song.title) }, tokens)) return 3;
  const artist = new Set(tokenize(fold(item.artist)));
  const own = tokenize(fold(song.title)).filter((word) => !artist.has(word));
  const title = searchWords(own.length > 0 ? own.join(' ') : fold(song.title));
  return tokens.every((token) => closeness(fold(token), title) > 0) ? 2 : 1;
}

/**
 * The songs that fit the words, best first: the ones they name, then the ones with every word in the title, then the
 * ones that fit only with the artist's name; within each, the most played first (none said is none), a song before a
 * video of it, and then the source's order. ("achas": Mordechai Shapiro's 1.5 million plays first, all 30-odd songs
 * called "Achas" before any "Achas Shoalti".)
 */
export function rankSongs<T extends FoundSong>(songs: T[], tokens: string[]): T[] {
  return songs
    .flatMap((song, i) => {
      const tier = songTier(song, tokens);
      return tier > 0 ? [{ song, i, tier }] : [];
    })
    .sort((a, b) => b.tier - a.tier || (b.song.plays ?? 0) - (a.song.plays ?? 0) || Number(Boolean(a.song.video)) - Number(Boolean(b.song.video)) || a.i - b.i)
    .map((entry) => entry.song);
}

/** An album's title without what tells its editions apart: "X (Yinglish Version)" and "X - גרסה עברית" are both "X". */
export const baseTitle = (title: string): string => artistKey(title.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').replace(/\s+[-–—]\s+.*$/, '')) || artistKey(title);

/**
 * One line for each album, its editions folded into it ("אלעזר ליפא׳לע", its Yinglish and its Hebrew editions): in the
 * place of the first of them, shown as the edition that is just the album's name (or else the first). Only one artist's
 * albums are editions of each other.
 */
export function foldEditions<T extends { title: string; artist: string }>(albums: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const album of albums) {
    const key = `${artistKey(album.artist)}|${baseTitle(album.title)}`;
    groups.set(key, [...(groups.get(key) ?? []), album]);
  }
  const out: T[] = [];
  for (const group of groups.values()) out.push(group.find((album) => artistKey(album.title) === baseTitle(album.title)) ?? group[0]!);
  return out;
}

const yearOf = (album: Album): number => album.year ?? (album.released ? new Date(album.released).getUTCFullYear() : 0);
const dayOf = (album: Album): number => (album.released ? Date.parse(album.released) || 0 : 0);

/** Newest first: by year, then (within a year) by release date, then the one with more songs. */
export const newestFirst = (a: Album, b: Album): number => yearOf(b) - yearOf(a) || dayOf(b) - dayOf(a) || (b.songs ?? 0) - (a.songs ?? 0);

/**
 * The albums that fit the words, best first: the ones the words name, then the newest, then the ones with more songs,
 * each album's editions folded into one line.
 */
export function rankAlbums<T extends Album>(albums: T[], tokens: string[]): T[] {
  const fitting = albums.filter((album) => fitsAll(matchable(album), tokens));
  const named = (album: T): boolean => namesSong(matchable(album), tokens);
  return foldEditions([...fitting].sort((a, b) => Number(named(b)) - Number(named(a)) || newestFirst(a, b)));
}
