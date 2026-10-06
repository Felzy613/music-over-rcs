// The site's categories worth a list, and the words that ask for each. Plain data, so the bot can use it without
// loading the rest of the library.

/** A category of music-table.com worth a list of its own. */
export interface CategoryInfo {
  /** As in the site's address: /new-music/categories/<slug>. */
  slug: string;
  name: string;
  emoji: string;
  /** What you can text to get it. */
  words: string[];
}

export const CATEGORIES: CategoryInfo[] = [
  { slug: 'chanukah', name: 'Chanukah', emoji: '🕎', words: ['chanukah', 'chanuka', 'hanukkah', 'hanukah', 'channukah', 'chanukah songs', 'chanukah music'] },
  { slug: 'purim', name: 'Purim', emoji: '🎭', words: ['purim', 'purim songs', 'purim music'] },
  {
    slug: 'weddings',
    name: 'Weddings & events',
    emoji: '💍',
    words: ['wedding', 'weddings', 'wedding music', 'wedding songs', 'chasuna', 'chasunah', 'chasuna music', 'simcha', 'simchas', 'events', 'dance', 'dancing'],
  },
  {
    slug: 'vocal',
    name: 'Vocal (a cappella)',
    emoji: '🎤',
    words: ['vocal', 'vocals', 'vocal music', 'acapella', 'a cappella', 'a capella', 'acappella', 'sefira', 'sefirah', 'sfira', 'three weeks', '3 weeks', 'the three weeks'],
  },
];

/** The category a message asks for, if it's just one of the words above. */
export const categoryFor = (phrase: string): CategoryInfo | undefined => CATEGORIES.find((category) => category.words.includes(phrase));
