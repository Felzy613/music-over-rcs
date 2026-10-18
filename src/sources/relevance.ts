import { tokenize } from '../query.ts';
import { splitTitle } from './titles.ts';

/** What the ranking needs to know about a search result: its title, or failing that the words in its address. */
export interface Titled {
  slug: string;
  title: string;
}

/** Edit distance where swapping two neighbouring letters counts as one edit, so "wiess" is one edit from "weiss". */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** How many typos a typed word of this length may contain and still mean the same word. Short words must be exact. */
export const allowedEdits = (length: number): number => (length >= 8 ? 2 : length >= 5 ? 1 : 0);

/**
 * How far a word may be from the spelling the site uses and still be corrected to it. This is looser than matching,
 * because a correction is only made to a word the site really uses and only when there is one clear best candidate:
 * "avrohom" is two edits from "avraham", and "shlomo" from "shloime", which is how the site spells them.
 */
export const correctableEdits = (length: number): number => (length >= 6 ? 2 : length >= 4 ? 1 : 0);

/** True when `correct` could change this word: long enough, and written with letters the site's titles use. */
export const canBeCorrected = (token: string): boolean => correctableEdits(token.length) > 0 && /\p{Script=Latin}/u.test(token);

/**
 * True when a title word is what the typed token means: it starts with the token, or is within the typo allowance. A
 * word in Hebrew letters is what a token in Latin letters means when it can be read that way ("vnusni" for "ונתנו").
 */
export function wordMatches(token: string, word: string): boolean {
  if (word.startsWith(token)) return true;
  if (HEBREW.test(word)) return soundsLike(token, word);
  const edits = allowedEdits(token.length);
  return edits > 0 && Math.abs(word.length - token.length) <= edits && editDistance(token, word) <= edits;
}

// Hebrew and Yiddish typed in Latin letters. Many of Zemer's titles are in Hebrew letters ("אלעזר ליפא׳לע") while
// requests are typed in Latin ones ("elazar lipa'le"), and there is no one way to spell a Hebrew word in Latin: vowels
// are mostly left unwritten, א and ע are silent, ת is "t" or "s", ח is "ch" or "h". So a Hebrew word is read letter by
// letter, each letter as any of the ways it is written, with any vowels in between.

const HEBREW = /[א-תװ-ײ]/;
const LATIN_VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
/** How each letter may be written in Latin letters; '' for one that may not be written at all (a vowel, or silent). */
const READINGS: Record<string, string[]> = {
  א: [''],
  ב: ['b', 'v', 'bh', 'w'],
  ג: ['g', 'gh', 'j'],
  ד: ['d', 'dh'],
  ה: ['h', ''],
  ו: ['v', 'w', ''],
  ז: ['z', 's'],
  ח: ['ch', 'kh', 'h', 'x', 'c'],
  ט: ['t', 'th'],
  י: ['y', 'j', ''],
  כ: ['k', 'ch', 'kh', 'c', 'ck', 'q', 'h'],
  ך: ['k', 'ch', 'kh', 'c', 'h'],
  ל: ['l'],
  מ: ['m'],
  ם: ['m'],
  נ: ['n'],
  ן: ['n'],
  ס: ['s', 'c', 'z'],
  ע: [''],
  פ: ['p', 'f', 'ph'],
  ף: ['f', 'p', 'ph'],
  צ: ['tz', 'ts', 'z', 'c', 's', 'tc'],
  ץ: ['tz', 'ts', 'z', 'c', 's'],
  ק: ['k', 'q', 'c', 'ck'],
  ר: ['r'],
  ש: ['sh', 's', 'sch', 'sz'],
  ת: ['t', 's', 'th'],
  װ: ['v', 'w'],
  ױ: [''],
  ײ: ['y', ''],
};

/**
 * True when a token typed in Latin letters can be read as this word in Hebrew letters: "vnusni" as "ונתנו", "lipale" as
 * "ליפא׳לע", "shabbos" as "שבת". Doubled letters count once ("shabbos" is "shabos"). A word of fewer than two letters
 * that are written (not vowels or silent) is too short to tell anything apart and matches only itself.
 */
export function soundsLike(token: string, word: string): boolean {
  const latin = token
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .replace(/(.)\1+/g, '$1');
  const letters = [...word.normalize('NFD').replace(/[^א-תװ-ײ]/g, '')];
  if (latin.length < 2 || letters.length < 2 || /\p{Script=Latin}/u.test(word) || letters.some((letter) => !READINGS[letter])) return false;
  if (letters.filter((letter) => READINGS[letter]!.some(Boolean)).length < 2 && latin.replace(/[aeiouy]/g, '').length > 1) return false;
  // Which (Latin position, Hebrew position) pairs have been tried: each is tried once, so this is quick.
  const tried = new Set<number>();
  const width = letters.length + 1;
  const walk = (at: number, letter: number): boolean => {
    if (at === latin.length && letter === letters.length) return true;
    const key = at * width + letter;
    if (tried.has(key)) return false;
    tried.add(key);
    // An unwritten vowel in the Latin spelling.
    if (at < latin.length && LATIN_VOWELS.has(latin[at]!) && walk(at + 1, letter)) return true;
    if (letter === letters.length) return false;
    return READINGS[letters[letter]!]!.some((reading) => latin.startsWith(reading, at) && walk(at + reading.length, letter + 1));
  };
  return walk(0, 0);
}

/** Apostrophes, hyphens and the like between two letters of one word: "V’Nusni", "Mi'Ma'amakim", "Yom-Tov". */
const JOINERS = /(?<=[\p{L}\p{N}])['’‘ʼ`´׳״-]+(?=[\p{L}\p{N}])/gu;

/** Without accents ("Océan" as "Ocean"), the way the catalog's own search compares. Other alphabets keep their marks. */
const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * A title's words in every form they may be typed in: as written ("v", "nusni"), with the apostrophes and hyphens
 * inside a word left out ("vnusni", "mimaamakim"), and two neighbouring words run together ("yom tov" as "yomtov").
 */
export function searchWords(text: string): string[] {
  const words = tokenize(text);
  const pairs = words.slice(1).map((word, i) => `${words[i]}${word}`);
  return [...new Set([...words, ...tokenize(text.replace(JOINERS, '')), ...pairs])];
}

/**
 * True when the words name this one song: its title as written, give or take apostrophes and spaces ("vnusni" for
 * "V’Nusni"), alone or with words of the artist's name before or after it ("lipa vnusni", "vnusni lipa schmeltzer").
 * The title must be all there and spelled right; the artist's words may be a typo off. A track number in front of
 * the title ("02 Kumzitz") may be left out, and a title in Hebrew letters is named by the words it can be read as
 * ("elazar lipale" for "אלעזר ליפא׳לע").
 */
export function namesSong(song: { title: string; artist: string }, wanted: string[]): boolean {
  const title = tokenize(fold(song.title));
  const forms = new Set([title.join('')]);
  if (title.length > 1 && /^\d+$/.test(title[0]!)) forms.add(title.slice(1).join(''));
  // A title written in both alphabets is named by either one: "Higale Na הגלה נא" (one read as the other), or
  // "ליפא פאַר א גוּט יאָר - Lipa’s Tekiyos" (one on each side of a dash). Not "אלעזר ליפא׳לע (Yinglish Version)".
  const hebrew = title.filter((word) => HEBREW.test(word)).join('');
  const latin = title.filter((word) => !HEBREW.test(word)).join('');
  if (hebrew && latin) {
    const sides = song.title.split(/\s[-–—|]\s/);
    const halves = sides.length === 2 && sides.some((side) => !HEBREW.test(side)) && sides.some((side) => !/\p{Script=Latin}/u.test(side));
    if (halves || soundsLike(latin, hebrew)) {
      forms.add(hebrew);
      forms.add(latin);
    }
  }
  const isTitle = (typed: string): boolean => forms.has(typed) || [...forms].some((form) => HEBREW.test(form) && soundsLike(typed, form));
  const artist = searchWords(fold(song.artist));
  const tokens = wanted.map(fold);
  const byArtist = (token: string): boolean => artist.some((word) => wordMatches(token, word));
  // Words of the artist's name may lead (start) and trail (end); what's between them must be the title.
  for (let start = 0; start < tokens.length; start += 1) {
    for (let end = tokens.length; end > start; end -= 1) {
      if (isTitle(tokens.slice(start, end).join(''))) return true;
      if (!byArtist(tokens[end - 1]!)) break;
    }
    if (!byArtist(tokens[start]!)) break;
  }
  return false;
}

/** How close a typed word comes to any of these words: 3 the same word, 2 the start of one, 1 a typo away, 0 not. */
function closeness(token: string, words: string[]): number {
  let best = 0;
  for (const word of words) {
    if (word === token) return 3;
    // A Hebrew word read the way the token spells it is as good as the start of one.
    if (word.startsWith(token) || (HEBREW.test(word) && soundsLike(token, word))) best = 2;
    else if (best === 0 && wordMatches(token, word)) best = 1;
  }
  return best;
}

/**
 * True when every word of the request is in the song's title or artist, an apostrophe or a typo forgiven. Stricter than
 * `rankSongs`, which lets a request of three or more words miss one: for a source asked first, a song that misses a word
 * is a different song ("higale na" is not "Hava Nagila"), and the next source should get to answer.
 */
export function fitsAll(song: { title: string; artist: string }, wanted: string[]): boolean {
  const tokens = wanted.map(fold);
  if (tokens.length === 0) return false;
  const title = searchWords(fold(song.title));
  const artist = searchWords(fold(song.artist));
  return tokens.every((token) => closeness(token, title) > 0 || closeness(token, artist) > 0);
}

/** True when at least one word of the request is in the title (an apostrophe or a typo forgiven): the request is about this title, not only its artist. */
export function touchesTitle(song: { title: string }, wanted: string[]): boolean {
  const title = searchWords(fold(song.title));
  return wanted.map(fold).some((token) => closeness(token, title) > 0);
}

/**
 * The songs that fit the words, best first: the looser search for when the exact one finds nothing. Apostrophes and
 * spaces may be left out or put in ("vnusni" finds "V’Nusni"), a longer word may be a letter or two off ("shmeltzer"
 * finds "Schmeltzer"), and, as on the site, a request of three or more words may miss one when no song has them all.
 * A song the words name comes first, then the closest, then the shortest title.
 */
export function rankSongs<T extends { title: string; artist: string }>(songs: Iterable<T>, wanted: string[], limit: number): T[] {
  const tokens = wanted.map(fold);
  if (tokens.length === 0) return [];
  const scored: Array<{ song: T; matched: number; score: number; named: boolean; length: number }> = [];
  for (const song of songs) {
    const title = searchWords(fold(song.title));
    const artist = searchWords(fold(song.artist));
    let matched = 0;
    let score = 0;
    for (const token of tokens) {
      const inTitle = closeness(token, title);
      const best = Math.max(inTitle, closeness(token, artist));
      if (best === 0) continue;
      matched += 1;
      // A word found in the title counts a little more than one found only in the artist's name.
      score += best + (inTitle > 0 ? 0.5 : 0);
    }
    if (matched < fewestMatches(tokens)) continue;
    scored.push({ song, matched, score, named: namesSong(song, tokens), length: tokenize(song.title).length });
  }
  const full = scored.filter((entry) => entry.matched === tokens.length);
  return (full.length > 0 ? full : scored)
    .sort((a, b) => Number(b.named) - Number(a.named) || b.matched - a.matched || b.score - a.score || a.length - b.length)
    .slice(0, limit)
    .map((entry) => entry.song);
}

export interface Fit {
  /** How many of the typed words appear in the title (typos allowed, apostrophes and spaces too: see searchWords). */
  matched: number;
  /** The request is the whole title, or exactly the song's name (with or without some of the artist's), and nothing more or less. */
  exact: boolean;
}

const titleText = (hit: Titled): string => hit.title || hit.slug.replace(/-/g, ' ');

export function titleWords(hit: Titled): string[] {
  return tokenize(titleText(hit));
}

export function fit(hit: Titled, wanted: string[]): Fit {
  const text = titleText(hit);
  const words = titleWords(hit);
  const song = tokenize(splitTitle(text).title);
  const count = (list: string[]): number => wanted.filter((token) => list.some((word) => wordMatches(token, word))).length;
  const matched = count(searchWords(text));
  // The song's name alone only counts when the typed words are really in the song's name, not the artist's.
  const exact =
    wanted.length > 0 &&
    matched === wanted.length &&
    (words.length === wanted.length || (song.length === wanted.length && count(song) === wanted.length) || namesSong(splitTitle(text), wanted));
  return { matched, exact };
}

/** A request of three or more words may miss one (a typo, or a word like "mp3"); shorter ones must match fully. */
export const fewestMatches = (wanted: string[]): number => (wanted.length >= 3 ? wanted.length - 1 : wanted.length);

export interface Pick<T> {
  hits: T[];
  /** Some result matched every word asked for. When none did, the request may contain a typo. */
  complete: boolean;
  /** The results are exact title matches. */
  exact: boolean;
}

/**
 * Chooses which of the site's results to look at. The site's own search matches any single word, so this keeps what
 * fits the whole request: the results that match every word if there are any, otherwise those missing at most one.
 * Exact title matches stand alone when there are any. Results keep the order the site gave them.
 */
export function pick<T extends Titled>(hits: T[], wanted: string[]): Pick<T> {
  if (wanted.length === 0) return { hits: [], complete: false, exact: false };
  const scored = hits.map((hit) => ({ hit, ...fit(hit, wanted) }));
  const full = scored.filter((entry) => entry.matched === wanted.length);
  const pool = full.length > 0 ? full : scored.filter((entry) => entry.matched >= fewestMatches(wanted));
  const exact = pool.filter((entry) => entry.exact);
  return { hits: (exact.length > 0 ? exact : pool).map((entry) => entry.hit), complete: full.length > 0, exact: exact.length > 0 };
}

/**
 * Replaces typed words that don't fit with the closest word the site really uses ("wiess" becomes "weiss"), so the
 * search can be repeated with the right spelling. Returns nothing when no word needed changing.
 *
 * A word is judged against what the site shows next to the other words: the combined results (`titles`) and what
 * each of the other words brings up on its own (`alone`, by word). What the word itself brings up on its own is left
 * out, because a word that exists somewhere on the site is no proof it belongs with the others: "avrohom" appears in
 * one unrelated title, while "fried" brings up "Avraham Fried".
 */
export function correct(wanted: string[], titles: Titled[], alone: ReadonlyMap<string, Titled[]> = new Map()): string[] | undefined {
  let changed = false;
  const fixed = wanted.map((token) => {
    if (!canBeCorrected(token)) return token;
    // How many of these titles use each word.
    const uses = new Map<string, number>();
    const count = (hit: Titled): void => {
      for (const word of new Set(titleWords(hit))) uses.set(word, (uses.get(word) ?? 0) + 1);
    };
    titles.forEach(count);
    for (const [other, hits] of alone) if (other !== token) hits.forEach(count);
    if ([...uses.keys()].some((word) => word.startsWith(token))) return token;

    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    let tied: string[] = [];
    for (const word of uses.keys()) {
      if (Math.abs(word.length - token.length) > 2) continue;
      // "lshabbos" contains "shabbos": a different word (a Hebrew prefix), not a misspelling of it.
      if (word.includes(token) || token.includes(word)) continue;
      const distance = editDistance(token, word);
      if (distance > correctableEdits(token.length)) continue;
      if (distance < bestDistance) {
        best = word;
        bestDistance = distance;
        tied = [word];
      } else if (distance === bestDistance) {
        tied.push(word);
      }
    }
    if (tied.length > 1) {
      // Several spellings are equally close ("shloime" and "shloimy" for "shlomo"): go with the one the site uses
      // clearly more, and with none when it is a toss-up.
      const ranked = [...tied].sort((a, b) => uses.get(b)! - uses.get(a)!);
      best = uses.get(ranked[0]!)! > uses.get(ranked[1]!)! * 2 ? ranked[0] : undefined;
    }
    if (best) {
      changed = true;
      return best;
    }
    return token;
  });
  return changed ? fixed : undefined;
}
