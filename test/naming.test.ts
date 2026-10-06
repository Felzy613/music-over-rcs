import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { catalogNaming, cleanName, namedFetch, nameSong, sentFileName, songPath, splitGuests, type SongFacts } from '../src/library/naming.ts';

const site = 'https://www.music-table.com/post/';
const single = (artist: string, title: string, category = ''): SongFacts => ({
  artist,
  title,
  url: `${site}x#0`,
  post: { slug: 'x', title: `${artist} - ${title}`, songs: 1, category },
});
const onAlbum = (postTitle: string, artist: string, title: string, index: number, songs = 8): SongFacts => ({
  artist,
  title,
  url: `${site}album#${index}`,
  post: { slug: 'album', title: postTitle, songs, category: '' },
});
const place = (facts: SongFacts) => songPath(nameSong(facts), '.mp3');
const sent = (facts: SongFacts) => sentFileName(nameSong(facts), 'mp3');

describe('naming: sorted by artist and album', () => {
  test('a single goes in its artist\'s Singles folder; guests go in its name, not the folder', () => {
    assert.equal(place(single('Ishay Ribo ft. Zusha', 'Derech')), 'Ishay Ribo/Singles/Derech (feat. Zusha).mp3');
    assert.equal(sent(single('Ishay Ribo ft. Zusha', 'Derech')), 'Ishay Ribo - Derech (feat. Zusha).mp3');
    assert.equal(place(single('Lipa Schmeltzer x Sruly Green', 'I Need My Afikoman')), 'Lipa Schmeltzer x Sruly Green/Singles/I Need My Afikoman.mp3', 'a duet is the artist');
    assert.equal(place(single('Mordechai Shapiro', 'Chaneinu (feat. Someone)')), 'Mordechai Shapiro/Singles/Chaneinu (feat. Someone).mp3');
    assert.equal(place(single('Band Ft. Guest', 'Song (Ft. Guest)')), 'Band/Singles/Song (Ft. Guest).mp3', 'guests already named are not named twice');
  });

  test('an album\'s songs are numbered in their album\'s folder, by the number in their name or their place on the post', () => {
    const elul = 'Yumi Gelb Ft. Braunstein, Berger & Lebron - Elul Collection (Live)';
    const credit = 'Yumi Gelb Ft. Braunstein, Berger & Lebron';
    assert.equal(place(onAlbum(elul, credit, '01 Elul Live Kumzitz (feat. Meilech Braunstein)', 0)), 'Yumi Gelb/Elul Collection (Live)/01 Elul Live Kumzitz (feat. Meilech Braunstein).mp3');
    assert.equal(sent(onAlbum(elul, credit, '01 Elul Live Kumzitz (feat. Meilech Braunstein)', 0)), 'Yumi Gelb - 01 Elul Live Kumzitz (feat. Meilech Braunstein).mp3');
    assert.equal(place(onAlbum('Yoely Davidowitz - Ananim (Full Album)', 'Yoely Davidowitz', '02. Sukkas Dovid', 1)), 'Yoely Davidowitz/Ananim/02 Sukkas Dovid.mp3');
    assert.equal(place(onAlbum('Mordechai Kohn - Elul Kumzitz', 'Mordechai Kohn', '03 - Shema Koleini', 2)), 'Mordechai Kohn/Elul Kumzitz/03 Shema Koleini.mp3');
    assert.equal(place(onAlbum('TYH Nation - The 12 Pesukim (Part 2)', 'TYH Nation', '04 Kol Yisrael', 0)), 'TYH Nation/The 12 Pesukim (Part 2)/04 Kol Yisrael.mp3', 'its own number, not its place');
    assert.equal(place(onAlbum('EKEV - Hoda\'ah (EP)', 'EKEV', 'You', 1, 3)), "EKEV/Hoda'ah (EP)/02 You.mp3", 'no number: its place on the post');
    assert.equal(place(onAlbum('Mordechai Shapiro - Chaneinu / Just The Way You Are', 'Mordechai Shapiro', 'Chaneinu', 0, 2)), 'Mordechai Shapiro/Chaneinu - Just The Way You Are/01 Chaneinu.mp3');
  });

  test('songs with no artist: a wedding\'s recording, a compilation, a credit only in the title', () => {
    assert.equal(place(onAlbum("May 31 '26", '', '04 Chuppa_1 (feat. Avrum Mordche Schwartz)', 3, 12)), "Weddings & Events/May 31 '26/04 Chuppa 1 (feat. Avrum Mordche Schwartz).mp3");
    assert.equal(sent(onAlbum("May 31 '26", '', '04 Chuppa 1', 3, 12)), "May 31 '26 - 04 Chuppa 1.mp3", 'led by the wedding');
    assert.equal(place(onAlbum("July 25 '26", '', '01', 0, 12)), "Weddings & Events/July 25 '26/01 July 25 '26.mp3", 'a file named only by its number');
    assert.equal(place(onAlbum('Songs Of Chizuk & Tefilla (Playlist)', '', '01 Ana', 0, 5)), 'Various Artists/Songs Of Chizuk & Tefilla (Playlist)/01 Ana.mp3');
    assert.equal(place({ artist: '', title: 'Yitzy Waldner & Yechiel Schron- Mizmor Lesoida (Vocal)', url: 'https://x.test/1.mp3' }), 'Yitzy Waldner & Yechiel Schron/Singles/Mizmor Lesoida (Vocal).mp3');
    assert.equal(place({ artist: '', title: 'Niggun', url: 'https://x.test/2.mp3' }), 'Unknown Artist/Singles/Niggun.mp3');
    assert.equal(sent({ artist: '', title: 'Niggun', url: 'https://x.test/2.mp3' }), 'Niggun.mp3');
  });

  test('the upload\'s notes are not part of the name', () => {
    assert.equal(place(single('Sruly Green', 'Your Smile (Official Music Video)')), 'Sruly Green/Singles/Your Smile.mp3');
    assert.equal(place(onAlbum('Yossi Brill Productions - A Night In Passaic', 'Yossi Brill Productions', '06 Second Dance 2 - 44.1kHz - 24Bit', 5)), 'Yossi Brill Productions/A Night In Passaic/06 Second Dance 2.mp3');
    assert.equal(place(single('Motty Ilowitz', 'Lev Layeled (Live Performance)')), 'Motty Ilowitz/Singles/Lev Layeled (Live Performance).mp3', 'what the song is stays');
  });

  test('names are safe on any disk: no slashes, colons or reserved characters, no hidden files, not too long', () => {
    assert.equal(cleanName('Chaneinu / Just The Way You Are'), 'Chaneinu - Just The Way You Are');
    assert.equal(cleanName('Live: Night 1'), 'Live - Night 1');
    assert.equal(cleanName('AC/DC'), 'AC-DC');
    assert.equal(cleanName('Say "Shalom"?*'), "Say 'Shalom'");
    assert.equal(cleanName('..hidden'), 'hidden');
    assert.equal(cleanName('Trailing...'), 'Trailing');
    assert.equal(cleanName('ונתנו by Lipa'), 'ונתנו by Lipa', 'Hebrew stays');
    assert.equal(Array.from(cleanName('x'.repeat(300))).length, 120);
    const parts = place(single('A/B', '../../etc')).split('/');
    assert.deepEqual(parts.slice(0, 2), ['A-B', 'Singles'], 'never a path out of the folder');
    assert.equal(parts.length, 3);
  });

  test('guests are split off the credit, a duet is not', () => {
    assert.deepEqual(splitGuests('Malchus Choir ft. Yisroel Adler, Dudi Kalisch'), { main: 'Malchus Choir', guests: 'Yisroel Adler, Dudi Kalisch' });
    assert.deepEqual(splitGuests('Shmili Landau (feat. Duvid Berger)'), { main: 'Shmili Landau', guests: 'Duvid Berger' });
    assert.deepEqual(splitGuests('Eli Marcus & Baruch Levine'), { main: 'Eli Marcus & Baruch Levine', guests: undefined });
  });
});

describe('naming: from the catalog', () => {
  test('a post with several songs is an album; one with one song is a single; a song not in the catalog is named from its file', async () => {
    const catalog = new Catalog(':memory:');
    try {
      catalog.savePost({ slug: 'two', title: 'Mordechai Shapiro - Chaneinu / Just The Way You Are', category: '', publishedAt: new Date().toISOString(), views: 0, audioFiles: 2 });
      catalog.add({ title: 'Chaneinu', artist: 'Mordechai Shapiro', url: `${site}two#0`, post: 'two' });
      catalog.add({ title: 'Just The Way You Are', artist: 'Mordechai Shapiro', url: `${site}two#1`, post: 'two' });
      catalog.add({ title: 'Derech', artist: 'Ishay Ribo ft. Zusha', url: `${site}derech#0`, post: 'derech' });
      const naming = catalogNaming(catalog);
      const mp3 = { fileName: 'whatever.mp3', mimeType: 'audio/mpeg' };
      assert.equal(naming.placeOf(`${site}two#1`, mp3), 'Mordechai Shapiro/Chaneinu - Just The Way You Are/02 Just The Way You Are.mp3');
      assert.equal(naming.placeOf(`${site}derech#0`, mp3), 'Ishay Ribo/Singles/Derech (feat. Zusha).mp3', 'its post not synced yet: a single');
      assert.equal(naming.placeOf('https://x.test/a.mp3', { fileName: 'Zusha — Roof Over My Head.mp3', mimeType: 'audio/mpeg' }), 'Zusha/Singles/Roof Over My Head.mp3');
      assert.equal(naming.fileNameOf(`${site}two#0`, { fileName: 'x.m4a', mimeType: 'audio/mp4' }), 'Mordechai Shapiro - 01 Chaneinu.m4a', 'its own type');

      const fetchNamed = namedFetch(async () => ({ data: new Blob(['x']), fileName: 'Mordechai Shapiro — Chaneinu.mp3', mimeType: 'audio/mpeg', bytes: 1 }), naming.fileNameOf);
      assert.equal((await fetchNamed(`${site}two#0`, 'Mordechai Shapiro — Chaneinu')).fileName, 'Mordechai Shapiro - 01 Chaneinu.mp3', 'the file that is sent');
    } finally {
      catalog.close();
    }
  });
});
