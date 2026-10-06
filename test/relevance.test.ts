import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  allowedEdits,
  canBeCorrected,
  correct,
  correctableEdits,
  editDistance,
  fewestMatches,
  fit,
  namesSong,
  pick,
  rankSongs,
  searchWords,
  wordMatches,
} from '../src/sources/relevance.ts';

const post = (title: string, slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')) => ({ slug, title });

describe('editDistance', () => {
  test('counts insertions, deletions, substitutions, and a swapped pair as one edit', () => {
    assert.equal(editDistance('weiss', 'weiss'), 0);
    assert.equal(editDistance('weiss', 'wiess'), 1, 'two neighbouring letters swapped');
    assert.equal(editDistance('shabbos', 'shabos'), 1);
    assert.equal(editDistance('chuppah', 'chupa'), 2);
    assert.equal(editDistance('kitten', 'sitting'), 3);
    assert.equal(editDistance('', 'abc'), 3);
    assert.equal(editDistance('abc', ''), 3);
  });
});

describe('wordMatches', () => {
  test('a typed word matches a title word it starts, or one within the typo allowance for its length', () => {
    assert.ok(wordMatches('shab', 'shabbos'), 'a prefix');
    assert.ok(wordMatches('wiess', 'weiss'), 'one typo in a five-letter word');
    assert.ok(wordMatches('shabbus', 'shabbos'), 'one typo in a seven-letter word');
    assert.ok(wordMatches('mordechia', 'mordechai'), 'a swap in a nine-letter word');
    assert.ok(!wordMatches('wiss', 'weis'), 'four-letter words must be exact');
    assert.ok(wordMatches('weess', 'weiss'), 'but five letters may have one typo');
    assert.ok(!wordMatches('wxxss', 'weiss'), 'two typos in a five-letter word is too many');
    assert.ok(!wordMatches('zzzz', 'shabbos'));
  });

  test('how many typos are allowed grows with the length of the word', () => {
    assert.deepEqual([3, 4, 5, 7, 8, 12].map(allowedEdits), [0, 0, 1, 1, 2, 2]);
  });
});

describe('fit', () => {
  const shabbos = post('Yoely Weiss - Shabbos');

  test('the whole title, or exactly the song name, is an exact match', () => {
    assert.deepEqual(fit(shabbos, ['yoely', 'weiss', 'shabbos']), { matched: 3, exact: true });
    assert.deepEqual(fit(shabbos, ['shabbos']), { matched: 1, exact: true }, 'the song name alone');
  });

  test('words that only match the artist do not make a song-name match', () => {
    assert.deepEqual(fit(shabbos, ['weiss']), { matched: 1, exact: false });
    assert.deepEqual(fit(shabbos, ['yoely', 'weiss']), { matched: 2, exact: false });
  });

  test('typos still count, and extra words in the title or the request stop it being exact', () => {
    assert.deepEqual(fit(shabbos, ['yoely', 'wiess', 'shabbos']), { matched: 3, exact: true });
    assert.equal(fit(post('Oneg Shabbos'), ['shabbos']).exact, false, 'the title has another word');
    assert.deepEqual(fit(shabbos, ['yoely', 'weiss', 'shabbos', 'mp3']), { matched: 3, exact: false });
  });

  test('falls back to the words in the address when a result has no title', () => {
    assert.deepEqual(fit({ slug: 'yoely-weiss-shabbos', title: '' }, ['yoely', 'weiss', 'shabbos']), { matched: 3, exact: true });
  });
});

describe('searchWords', () => {
  test('the words as written, then without the apostrophes and hyphens inside a word, then each two neighbours run together', () => {
    assert.deepEqual(searchWords('V’Nusni'), ['v', 'nusni', 'vnusni']);
    assert.ok(searchWords("Mi'Ma'amakim").includes('mimaamakim'));
    assert.ok(searchWords('U’v’tuvcha HaGadol').includes('uvtuvcha'));
    assert.ok(searchWords('Yom-Tov').includes('yomtov'));
    assert.ok(searchWords('A Git Yom Tov').includes('yomtov'));
  });
});

describe('namesSong', () => {
  const vnusni = { title: 'V’Nusni', artist: 'Lipa Schmeltzer' };

  test('the title with or without its apostrophes, alone or with some of the artist\'s name before or after it', () => {
    for (const words of [['vnusni'], ['v', 'nusni'], ['lipa', 'vnusni'], ['lipa', 'schmeltzer', 'vnusni'], ['shmeltzer', 'vnusni'], ['vnusni', 'lipa']]) {
      assert.ok(namesSong(vnusni, words), words.join(' '));
    }
  });

  test('not with part of the title, a typo in it, another word in it, or only the artist', () => {
    for (const words of [['lipa'], ['lipa', 'schmeltzer'], ['vnusn'], ['vnusin'], ['vnusni', 'remix'], ['lipa', 'yeah', 'vnusni']]) {
      assert.ok(!namesSong(vnusni, words), words.join(' '));
    }
  });

  test('a track number in front of the title may be left out', () => {
    assert.ok(namesSong({ title: "02 The Bochurim's Kumzitz", artist: 'Yehuda Langer' }, ['the', 'bochurims', 'kumzitz']));
  });
});

describe('rankSongs', () => {
  const songs = [
    { title: 'ShabbaTrump', artist: 'Lipa Schmeltzer' },
    { title: 'V’Nusni', artist: 'Lipa Schmeltzer' },
    { title: 'Nusni Remix', artist: 'Someone Else' },
  ];

  test('finds a song typed without its apostrophes, or with a typo in a long word', () => {
    assert.deepEqual(rankSongs(songs, ['lipa', 'vnusni'], 5), [songs[1]]);
    assert.deepEqual(rankSongs(songs, ['vnusni'], 5), [songs[1], songs[2]], '"nusni" is a letter off, so it comes after');
    assert.deepEqual(rankSongs(songs, ['shmeltzer'], 5), [songs[0], songs[1]], 'the shorter title first');
  });

  test('the song the words name comes first, and a word in the title counts more than one in the artist\'s name', () => {
    const shabbos = [{ title: 'Kodesh Shabbos', artist: 'A' }, { title: 'Shabbos', artist: 'B' }];
    assert.deepEqual(rankSongs(shabbos, ['shabbos'], 5), [shabbos[1], shabbos[0]]);
    assert.deepEqual(rankSongs([...songs, { title: 'Schmeltzer Medley', artist: 'Band' }], ['schmeltzer'], 5)[0]?.title, 'Schmeltzer Medley');
  });

  test('three or more words may miss one, but only when no song has them all; short requests must match fully', () => {
    assert.deepEqual(rankSongs(songs, ['lipa', 'schmeltzer', 'zzzz'], 5), [songs[0], songs[1]]);
    assert.deepEqual(rankSongs(songs, ['lipa', 'zzzz'], 5), []);
    assert.deepEqual(rankSongs(songs, ['zzzz'], 5), []);
    assert.deepEqual(rankSongs(songs, [], 5), []);
  });

  test('respects the limit', () => {
    assert.equal(rankSongs(songs, ['lipa'], 1).length, 1);
  });
});

describe('fewestMatches', () => {
  test('short requests must match fully; a request of three or more may miss one word', () => {
    assert.deepEqual([1, 2, 3, 4, 6].map((n) => fewestMatches(Array.from({ length: n }, () => 'x'))), [1, 2, 2, 3, 5]);
  });
});

describe('pick', () => {
  const hits = [
    post('Yoely Weiss - Purim 26'),
    post('Mendy Weiss - Full Album'),
    post('Yoely Weiss - Shabbos'),
    post('Oneg Shabbos'),
    post('Simche Friedman - Oneg Shabbos'),
  ];

  test('keeps the results that match every word, in the order the site gave them', () => {
    const picked = pick(hits, ['weiss']);
    assert.deepEqual(picked.hits.map((hit) => hit.title), ['Yoely Weiss - Purim 26', 'Mendy Weiss - Full Album', 'Yoely Weiss - Shabbos']);
    assert.ok(picked.complete);
    assert.ok(!picked.exact);
  });

  test('an exact title stands alone', () => {
    const picked = pick(hits, ['yoely', 'weiss', 'shabbos']);
    assert.deepEqual(picked.hits.map((hit) => hit.title), ['Yoely Weiss - Shabbos']);
    assert.ok(picked.exact && picked.complete);
  });

  test('several exact titles are all kept, so the user can choose', () => {
    const two = [post('A Band - Shabbos'), post('Other Band - Shabbos'), post('Oneg Shabbos')];
    const picked = pick(two, ['shabbos']);
    assert.deepEqual(picked.hits.map((hit) => hit.title), ['A Band - Shabbos', 'Other Band - Shabbos']);
    assert.ok(picked.exact);
  });

  test('results that miss a word are used only when none has every word, and only for requests of three or more', () => {
    const picked = pick(hits, ['yoely', 'weiss', 'zzzzzz']);
    assert.deepEqual(
      picked.hits.map((hit) => hit.title),
      ['Yoely Weiss - Purim 26', 'Yoely Weiss - Shabbos'],
      'both match two of three words',
    );
    assert.ok(!picked.complete, 'so the caller knows a typo may be involved');
    assert.deepEqual(pick(hits, ['weiss', 'zzzzzz']).hits, [], 'a two-word request must match both');
    assert.deepEqual(pick(hits, []).hits, []);
  });

  test('a request of four words may miss one: three of four is enough, two of four is not', () => {
    const list = [post('Alpha Band - Delta'), post('Alpha Beta Band - Delta Song')];
    const picked = pick(list, ['alpha', 'beta', 'delta', 'omega']);
    assert.deepEqual(picked.hits.map((hit) => hit.title), ['Alpha Beta Band - Delta Song']);
    assert.ok(!picked.complete);
  });
});

describe('correct', () => {
  const results = [post('Yoely Weiss - Shabbos'), post('Mendy Weiss - Full Album'), post('Yoely Klein - Pesukei Dezimra')];

  test('replaces a word no result uses with the closest word the results do use', () => {
    assert.deepEqual(correct(['yoely', 'wiess', 'shabbos'], results), ['yoely', 'weiss', 'shabbos']);
    assert.deepEqual(correct(['yoely', 'weiss', 'shabos'], results), ['yoely', 'weiss', 'shabbos']);
  });

  test('leaves words alone that the results use, or that only start a word the results use', () => {
    assert.equal(correct(['yoely', 'weiss', 'shabbos'], results), undefined);
    assert.equal(correct(['yoe', 'wei', 'shab'], results), undefined, 'partial words are not typos');
  });

  test('a long word may be two edits from the site\'s spelling, because names are spelled many ways', () => {
    const fried = [post('Avraham Fried - Veyeda'), post('Avraham Fried - Shalom Aleichem')];
    assert.deepEqual(correct(['avrohom', 'fried'], fried), ['avraham', 'fried']);
    assert.equal(correct(['avrhm'], fried), undefined, 'a five-letter word is only allowed one edit');
    assert.equal(wordMatches('avrohom', 'avraham'), false, 'matching stays strict: only a correction the site confirms is applied');
  });

  test('a word that exists on the site, but never beside the other words, is judged by what the other words bring up', () => {
    const alone = new Map([
      ['avrohom', [post('Avrohom Mordechai Shwartz - Nishmas')]],
      ['fried', [post('Avraham Fried - Veyeda'), post("Shia Fried - K'ayol Ta'arog")]],
    ]);
    assert.deepEqual(correct(['avrohom', 'fried'], [], alone), ['avraham', 'fried']);
    // When some result really has the word beside the others, it is not a typo.
    assert.equal(correct(['avrohom', 'fried'], [post('Avrohom Fried - Something')], alone), undefined);
  });

  test('when several spellings are equally close, the one the site uses far more wins, and a toss-up changes nothing', () => {
    const many = [post('Shloime Daskal - A'), post('Shloime Daskal - B'), post('Yanky & Shloime Daskal - C'), post('Shloimy Daskal - D')];
    assert.deepEqual(correct(['shlomo', 'daskal'], many), ['shloime', 'daskal']);
    assert.equal(correct(['shlomo', 'daskal'], [post('Shloime Daskal - A'), post('Shloimy Daskal - B')]), undefined);
  });

  test('does not guess: short words, ties and far-off words stay as typed', () => {
    assert.equal(correct(['yoe', 'wss'], results), undefined, 'under four letters');
    assert.equal(correct(['qqqqq'], results), undefined, 'nothing is close');
    assert.equal(correct(['wexss'], [post('A Weiss - B'), post('A Weess - B')]), undefined, 'two equally close words');
  });
});

describe('canBeCorrected', () => {
  test('needs a word long enough to have a typo, written in the letters the site\'s titles use', () => {
    assert.equal(canBeCorrected('wiess'), true);
    assert.equal(canBeCorrected('weis'), true, 'four letters may be one edit off');
    assert.equal(canBeCorrected('abc'), false);
    assert.equal(canBeCorrected('שבת'), false);
    assert.equal(canBeCorrected('קודש'), false, 'a Hebrew word is not a misspelling of a title written in Latin letters');
    assert.equal(canBeCorrected('café'), true);
  });

  test('edits allowed by length', () => {
    assert.deepEqual([3, 4, 5, 6, 12].map(correctableEdits), [0, 1, 1, 2, 2]);
  });
});
