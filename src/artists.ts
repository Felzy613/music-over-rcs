import { tokenize } from './query.ts';

/**
 * The separate artists in a credit like "Mendy Weiss, Yoely Davidowitz & Yoely Samuel", "TYH Ft. Avraham Fried" or
 * "Matt Dubb x Itzik Dadya". Each name is kept as written.
 */
export function splitArtists(credit: string): string[] {
  const names = credit
    .split(/\s*,\s*|\s+&\s+|\s+\+\s+|\s+x\s+|\s+(?:ft|feat)\.?\s+|\s+featuring\s+|\s+and\s+|\s+with\s+|\s+vs\.?\s+/i)
    .map((name) => name.trim())
    .filter((name) => tokenize(name).length > 0 && name.length <= 60);
  return [...new Map(names.map((name) => [artistKey(name), name])).values()];
}

/** How an artist's name is compared: its words, lowercased, without punctuation. */
export const artistKey = (name: string): string => tokenize(name).join(' ');
