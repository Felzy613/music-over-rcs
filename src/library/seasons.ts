/** A time of year with music of its own: the holiday lists to point to, or vocal music when that's what many listen to. */
export interface Season {
  key: 'chanukah' | 'purim' | 'sefirah' | 'three-weeks';
  /** As it reads in a sentence: "Chanukah", "Sefirah", "the Three Weeks". */
  name: string;
  /** The category whose list fits it. */
  category: 'chanukah' | 'purim' | 'vocal';
  /** A line for the daily message and the lists, pointing to that category. */
  hint: string;
}

const SEASONS: Record<Season['key'], Season> = {
  chanukah: { key: 'chanukah', name: 'Chanukah', category: 'chanukah', hint: '🕎 Chanukah is here: text "chanukah" for Chanukah songs.' },
  purim: { key: 'purim', name: 'Purim', category: 'purim', hint: '🎭 Purim is coming: text "purim" for Purim songs.' },
  sefirah: { key: 'sefirah', name: 'Sefirah', category: 'vocal', hint: '🎤 It\'s Sefirah: text "vocal" for a cappella songs.' },
  'three-weeks': { key: 'three-weeks', name: 'the Three Weeks', category: 'vocal', hint: '🎤 It\'s the Three Weeks: text "vocal" for a cappella songs.' },
};

/** The day of the Jewish calendar for a date (by its civil date in this Mac's time zone). */
export function hebrewDate(date: Date): { day: number; month: string } {
  const parts = new Intl.DateTimeFormat('en-u-ca-hebrew', { day: 'numeric', month: 'long' }).formatToParts(date);
  return {
    day: Number(parts.find((part) => part.type === 'day')?.value),
    month: parts.find((part) => part.type === 'month')?.value ?? '',
  };
}

/**
 * The season a date falls in, if any:
 * - Chanukah: from 15 Kislev (the run-up) to 3 Tevet;
 * - Purim: 1 to 15 Adar (Adar II in a leap year);
 * - Sefirah: 16 Nisan to 5 Sivan;
 * - the Three Weeks: 17 Tamuz to 9 Av.
 */
export function seasonOn(date: Date): Season | undefined {
  const { day, month } = hebrewDate(date);
  if ((month === 'Kislev' && day >= 15) || (month === 'Tevet' && day <= 3)) return SEASONS.chanukah;
  if ((month === 'Adar' || month === 'Adar II') && day <= 15) return SEASONS.purim;
  if ((month === 'Nisan' && day >= 16) || month === 'Iyar' || (month === 'Sivan' && day <= 5)) return SEASONS.sefirah;
  if ((month === 'Tamuz' && day >= 17) || (month === 'Av' && day <= 9)) return SEASONS['three-weeks'];
  return undefined;
}
