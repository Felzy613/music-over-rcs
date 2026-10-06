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

/** True when a title word is what the typed token means: it starts with the token, or is within the typo allowance. */
export function wordMatches(token: string, word: string): boolean {
  if (word.startsWith(token)) return true;
  const edits = allowedEdits(token.length);
  return edits > 0 && Math.abs(word.length - token.length) <= edits && editDistance(token, word) <= edits;
}

export interface Fit {
  /** How many of the typed words appear in the title (typos allowed). */
  matched: number;
  /** The request is the whole title, or exactly the song's name, and nothing more or less. */
  exact: boolean;
}

const titleText = (hit: Titled): string => hit.title || hit.slug.replace(/-/g, ' ');

export function titleWords(hit: Titled): string[] {
  return tokenize(titleText(hit));
}

export function fit(hit: Titled, wanted: string[]): Fit {
  const words = titleWords(hit);
  const song = tokenize(splitTitle(titleText(hit)).title);
  const count = (list: string[]): number => wanted.filter((token) => list.some((word) => wordMatches(token, word))).length;
  const matched = count(words);
  // The song's name alone only counts when the typed words are really in the song's name, not the artist's.
  const exact =
    wanted.length > 0 &&
    matched === wanted.length &&
    (words.length === wanted.length || (song.length === wanted.length && count(song) === wanted.length));
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
