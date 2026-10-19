import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { AudioCache, taggedFetch } from '../src/library/audio-cache.ts';
import { audioTypeOf, hasCover, headOfBlob, isMp3, readTextTags, writeTags, writeTagsToBlob, type CoverPicture, type SongTags } from '../src/library/id3.ts';
import { extensionOf, nameSong, songTags } from '../src/library/naming.ts';

const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const syncsafe = (n: number) => Uint8Array.of((n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f);
const plain = (n: number) => Uint8Array.of(n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);

/** An ID3v2 frame, in v2.3 (plain size) or v2.4 (syncsafe size). */
const frame = (id: string, body: Uint8Array, major = 3) => concat(bytes(id), major === 4 ? syncsafe(body.length) : plain(body.length), Uint8Array.of(0, 0), body);
const textFrame = (id: string, value: string, major = 3) => frame(id, concat(Uint8Array.of(0), bytes(value)), major);
const tag = (major: number, ...frames: Uint8Array[]) => {
  const body = concat(...frames, new Uint8Array(64));
  return concat(bytes('ID3'), Uint8Array.of(major, 0, 0), syncsafe(body.length), body);
};
const PICTURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4);
/** A picture frame: v2.3 with a Latin-1 description, or v2.4 with a UTF-8 one (which v2.3 can't hold). */
const pictureFrame = (major: number) => frame('APIC', concat(Uint8Array.of(major === 4 ? 3 : 0), bytes('image/png'), Uint8Array.of(0, 3), bytes('thumb'), Uint8Array.of(0), PICTURE), major);
/** A few MPEG audio frames' worth of bytes: what must come through untouched. */
const AUDIO = concat(Uint8Array.of(0xff, 0xfb, 0x90, 0x64), Uint8Array.from({ length: 400 }, (_, i) => i % 251));
const ID3V1 = concat(bytes('TAG'), new Uint8Array(125).fill(0x41));
/** The start of an M4A (an MP4 "ftyp" box): what the site sometimes serves as an MP3. */
const M4A = concat(Uint8Array.of(0, 0, 0, 0x1c), bytes('ftypM4A \0\0\0\0M4A isommp42'), new Uint8Array(64));

const TAGS: SongTags = { title: 'Derech (feat. Zusha)', artist: 'Ishay Ribo', albumArtist: 'Ishay Ribo', album: 'Derech (feat. Zusha) - Single', track: '1/1', year: '2026' };
const endsWith = (data: Uint8Array, tail: Uint8Array) => Buffer.from(data.subarray(data.length - tail.length)).equals(Buffer.from(tail));

describe('id3: the tags inside an MP3', () => {
  test("the upload's tags are replaced by the song's own; its picture stays, the audio is untouched, the old ID3v1 tag goes", () => {
    const upload = concat(tag(3, textFrame('TIT2', 'Derech - Ishay Ribo feat. Zusha (Official Audio)'), textFrame('TCON', 'People & Blogs'), pictureFrame(3)), AUDIO, ID3V1);
    const written = writeTags(upload, TAGS)!;
    assert.deepEqual(readTextTags(written), {
      TIT2: 'Derech (feat. Zusha)',
      TPE1: 'Ishay Ribo',
      TPE2: 'Ishay Ribo',
      TALB: 'Derech (feat. Zusha) - Single',
      TRCK: '1/1',
      TYER: '2026',
      APIC: '',
    });
    assert.ok(endsWith(written, AUDIO), 'the audio, exactly, and nothing after it');
    assert.equal(hasCover(written), true);
    assert.deepEqual(writeTags(written, TAGS), written, 'writing the same tags again changes nothing');
  });

  test('Hebrew and curly quotes are kept; a v2.4 picture is carried over; a cover is added only when there is none', () => {
    const v24 = concat(tag(4, textFrame('TIT2', 'old', 4), pictureFrame(4)), AUDIO);
    const hebrew = writeTags(v24, { ...TAGS, title: 'V’Nusni - ונתנו' }, { data: Uint8Array.of(9, 9), mimeType: 'image/jpeg' })!;
    assert.equal(readTextTags(hebrew).TIT2, 'V’Nusni - ונתנו');
    assert.ok(Buffer.from(hebrew).includes(Buffer.from(PICTURE)), 'its own picture');
    assert.ok(!Buffer.from(hebrew).includes(Buffer.from([0, 3, 0, 9, 9])), 'no second one');
    assert.ok(endsWith(hebrew, AUDIO));

    const bare = concat(tag(4, textFrame('TSSE', 'Lavf', 4)), AUDIO);
    assert.equal(hasCover(bare), false);
    const covered = writeTags(bare, TAGS, { data: Uint8Array.of(9, 9), mimeType: 'image/jpeg' })!;
    assert.equal(hasCover(covered), true);
    assert.ok(endsWith(covered, AUDIO));
    assert.ok(endsWith(writeTags(AUDIO, TAGS)!, AUDIO), 'a file with no tag at all');
  });

  test('only MP3s are written: not an MP4 or AAC file, not a web page', () => {
    assert.equal(isMp3(concat(tag(3, textFrame('TIT2', 'x')), AUDIO)), true);
    assert.equal(writeTags(concat(Uint8Array.of(0, 0, 0, 0x20), bytes('ftypM4A ')), TAGS), undefined);
    assert.equal(writeTags(Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 0, 0), TAGS), undefined, 'AAC shares the sync bits');
    assert.equal(writeTags(bytes('<!doctype html>'), TAGS), undefined);
  });

  test("a song file's real type is told from its first bytes", () => {
    assert.equal(audioTypeOf(concat(tag(3, textFrame('TIT2', 'x')), AUDIO)), 'audio/mpeg');
    assert.equal(audioTypeOf(M4A), 'audio/mp4');
    assert.equal(audioTypeOf(bytes('OggS\0\u0002')), 'audio/ogg');
    assert.equal(audioTypeOf(bytes('fLaC\0\0')), 'audio/flac');
    assert.equal(audioTypeOf(bytes('RIFF\0\0\0\0WAVEfmt ')), 'audio/wav');
    assert.equal(audioTypeOf(bytes('<!doctype html>')), undefined);
  });

  test('the tags match the folders: a single is its own album, an album song carries its number', () => {
    const single = nameSong({ artist: 'Ishay Ribo ft. Zusha', title: 'Derech', url: 'https://x.test/post/derech#0' });
    assert.deepEqual(songTags(single, { releasedAt: '2026-09-01T10:00:00Z', cover: 'https://x.test/c.jpg' }), { ...TAGS, cover: 'https://x.test/c.jpg' });
    const albumSong = nameSong({
      artist: 'Yumi Gelb Ft. Braunstein',
      title: '03 Elul Melodies (feat. Chaim Horowitz)',
      url: 'https://x.test/post/elul#2',
      post: { slug: 'elul', title: 'Yumi Gelb Ft. Braunstein - Elul Collection (Live)', songs: 8, category: '' },
    });
    // Every artist goes in the artist tag, the guests the title names among them (and out of the title).
    assert.deepEqual(songTags(albumSong), {
      title: 'Elul Melodies',
      artist: 'Yumi Gelb; Chaim Horowitz',
      albumArtist: 'Yumi Gelb',
      album: 'Elul Collection (Live)',
      track: '3/8',
    });
    assert.equal(songTags(albumSong, { artist: 'Yumi Gelb Ft. Braunstein' }).artist, 'Yumi Gelb; Braunstein; Chaim Horowitz');
  });
});

describe('id3: kept songs are tagged', () => {
  let dir: string;
  let catalog: Catalog;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mors-tags-'));
    catalog = new Catalog(':memory:');
  });
  afterEach(async () => {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  });

  const upload = () => concat(tag(3, textFrame('TIT2', 'video title')), AUDIO);
  const mp3 = (data: Uint8Array) => ({ data: new Blob([data]), fileName: 'x.mp3', mimeType: 'audio/mpeg', bytes: data.length });

  test('a song is tagged as it is kept, and sent that way', async () => {
    const kept = new AudioCache({ dir, index: catalog, placeOf: () => 'Ishay Ribo/Singles/Derech (feat. Zusha).mp3', tagsOf: () => TAGS });
    const sent = await kept.put('https://x.test/1', mp3(upload()));
    assert.equal(readTextTags(new Uint8Array(await sent.data.arrayBuffer())).TIT2, 'Derech (feat. Zusha)', 'the file that is sent');
    const onDisk = new Uint8Array(await readFile(join(dir, 'Ishay Ribo', 'Singles', 'Derech (feat. Zusha).mp3')));
    assert.equal(readTextTags(onDisk).TPE1, 'Ishay Ribo');
    assert.equal(sent.bytes, onDisk.length);
    assert.deepEqual((await kept.organize()).tagged, 0, 'nothing more to write');
  });

  test('songs kept before are tagged once, with a cover when they have none; again only when their tags change', async () => {
    const untagged = new AudioCache({ dir, index: catalog });
    await untagged.put('https://x.test/1', { ...mp3(upload()), fileName: 'One.mp3' });
    let tags: SongTags = { ...TAGS, cover: 'https://x.test/cover.jpg' };
    const covers: string[] = [];
    const kept = new AudioCache({
      dir,
      index: catalog,
      tagsOf: () => tags,
      fetchCover: async (url) => {
        covers.push(url);
        return { data: Uint8Array.of(7, 7, 7), mimeType: 'image/jpeg' };
      },
    });
    assert.equal((await kept.organize()).tagged, 1);
    const once = new Uint8Array(await readFile(join(dir, 'One.mp3')));
    assert.equal(readTextTags(once).TALB, 'Derech (feat. Zusha) - Single');
    assert.equal(hasCover(once), true);
    assert.deepEqual(covers, ['https://x.test/cover.jpg']);
    assert.equal(catalog.cachedAudio('https://x.test/1')?.bytes, once.length);
    assert.ok(endsWith(once, AUDIO));

    assert.equal((await kept.organize()).tagged, 0, 'tags you edit yourself are left alone');
    tags = { ...tags, title: 'Derech' }; // the title corrected on the site, say
    assert.equal((await kept.organize()).tagged, 1);
    assert.equal(readTextTags(new Uint8Array(await readFile(join(dir, 'One.mp3')))).TIT2, 'Derech');
    assert.deepEqual(covers.length, 1, 'its cover was already there');
  });

  test("a song the site calls an MP3 that is really an M4A is kept, named and sent as an M4A; one whose tags can't be written is left untouched", async () => {
    const placeOf = (_url: string, audio: { fileName: string; mimeType: string }) => `Shulem Lemmer/Singles/Mama Rachel Medley${extensionOf(audio)}`;
    const kept = new AudioCache({ dir, index: catalog, placeOf, tagsOf: () => TAGS });
    const sent = await kept.put('https://x.test/1', { ...mp3(M4A), fileName: 'Shulem Lemmer — Mama Rachel Medley.mp3' });
    assert.equal(sent.mimeType, 'audio/mp4');
    assert.equal(sent.fileName, 'Shulem Lemmer — Mama Rachel Medley.m4a');
    assert.deepEqual(await readdir(join(dir, 'Shulem Lemmer', 'Singles')), ['Mama Rachel Medley.m4a']);
    assert.deepEqual(new Uint8Array(await readFile(join(dir, 'Shulem Lemmer', 'Singles', 'Mama Rachel Medley.m4a'))), M4A, 'not a byte changed');
    assert.equal(catalog.cachedAudio('https://x.test/1')?.mimeType, 'audio/mp4');
  });

  test('one kept before as an MP3 is renamed to what it is', async () => {
    const placeOf = (_url: string, audio: { fileName: string; mimeType: string }) => `Shulem Lemmer/Singles/Mama Rachel Medley${extensionOf(audio)}`;
    await mkdir(join(dir, 'Shulem Lemmer', 'Singles'), { recursive: true });
    await writeFile(join(dir, 'Shulem Lemmer', 'Singles', 'Mama Rachel Medley.mp3'), M4A);
    const at = new Date().toISOString();
    catalog.saveCachedAudio({ url: 'https://x.test/1', file: 'Shulem Lemmer/Singles/Mama Rachel Medley.mp3', fileName: 'Mama Rachel Medley.mp3', mimeType: 'audio/mpeg', bytes: M4A.length, fetchedAt: at, usedAt: at });
    const kept = new AudioCache({ dir, index: catalog, placeOf, tagsOf: () => TAGS });
    assert.deepEqual(await kept.organize(), { state: undefined, moved: 0, sorted: 1, tagged: 0, failed: 0 });
    assert.deepEqual(await readdir(join(dir, 'Shulem Lemmer', 'Singles')), ['Mama Rachel Medley.m4a']);
    const back = await kept.get('https://x.test/1');
    assert.equal(back?.mimeType, 'audio/mp4');
    assert.equal(back?.fileName, 'Mama Rachel Medley.m4a');
    assert.deepEqual(await kept.organize(), { state: undefined, moved: 0, sorted: 0, tagged: 0, failed: 0 }, 'settled');
  });
});


describe('id3: the tags put on a song held as a Blob', () => {
  const COVER: CoverPicture = { data: Uint8Array.of(9, 9, 9), mimeType: 'image/jpeg' };
  const blobOf = (data: Uint8Array) => new Blob([data], { type: 'audio/mpeg' });
  const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());
  const chapter = frame('CHAP', concat(bytes('ch1\0'), new Uint8Array(16), textFrame('TIT2', 'Part one')));
  const longAudio = concat(AUDIO, ...Array.from({ length: 300 }, () => AUDIO)); // ~120 KB
  // a v2.4 tag with a footer (flag 0x10): ten bytes after the tag that are not audio
  const withFooter = (() => {
    const body = concat(textFrame('TIT2', 'old', 4), new Uint8Array(16));
    return concat(bytes('ID3'), Uint8Array.of(4, 0, 0x10), syncsafe(body.length), body, bytes('3DI'), Uint8Array.of(4, 0, 0x10), syncsafe(body.length));
  })();

  const FILES: Record<string, Uint8Array> = {
    'an upload: a tag with a picture and junk, an ID3v1 tag at the end': concat(tag(3, textFrame('TIT2', 'Derech - Ishay Ribo (Official Audio)'), textFrame('TCON', 'People & Blogs'), pictureFrame(3)), AUDIO, ID3V1),
    'a v2.4 tag with a picture': concat(tag(4, textFrame('TIT2', 'old', 4), pictureFrame(4)), AUDIO),
    'a tag without a picture': concat(tag(4, textFrame('TSSE', 'Lavf', 4)), AUDIO),
    'chapters of a medley': concat(tag(3, textFrame('TIT2', 'Medley'), chapter), AUDIO),
    'no tag at all': AUDIO,
    'an ID3v1 tag only': concat(AUDIO, ID3V1),
    'two tags one after the other': concat(tag(3, textFrame('TIT2', 'first')), tag(3, textFrame('TIT2', 'second'), pictureFrame(3)), AUDIO),
    'a v2.4 tag with a footer': concat(withFooter, AUDIO, ID3V1),
    'padding before the first frame': concat(tag(3, textFrame('TIT2', 'old')), new Uint8Array(20), AUDIO),
    'a long song': concat(tag(3, textFrame('TIT2', 'old'), pictureFrame(3)), longAudio, ID3V1),
    'less than 128 bytes of audio after the tag': concat(tag(3, textFrame('TIT2', 'old')), AUDIO.subarray(0, 40)),
    'a tag that claims more than the file holds': concat(tag(3, textFrame('TIT2', 'old')).subarray(0, 30), new Uint8Array(0)),
  };

  test('gives the very file writeTags gives, for each kind of MP3, with a cover and without', async () => {
    for (const [name, file] of Object.entries(FILES)) {
      for (const cover of [undefined, COVER]) {
        const expected = writeTags(file, TAGS, cover);
        const asked: string[] = [];
        const written = await writeTagsToBlob(blobOf(file), TAGS, cover ? async () => (asked.push('cover'), cover) : undefined);
        if (!expected) {
          assert.equal(written, undefined, `${name}: not an MP3, so nothing`);
          continue;
        }
        assert.ok(written, name);
        assert.ok(Buffer.from(await bytesOf(written)).equals(Buffer.from(expected)), `${name}${cover ? ' with a cover' : ''}: the same bytes`);
        assert.equal(written.size, expected.length, name);
        assert.equal(asked.length, hasCover(file) || !cover ? 0 : 1, `${name}: the cover is asked for only when the song has none`);
      }
    }
  });

  test('is what two passes (the tags, then a cover) used to give, in one pass', async () => {
    for (const name of ['a tag without a picture', 'chapters of a medley', 'no tag at all', 'an ID3v1 tag only']) {
      const file = FILES[name]!;
      const twoPasses = writeTags(writeTags(file, TAGS)!, TAGS, COVER)!;
      const onePass = (await writeTagsToBlob(blobOf(file), TAGS, async () => COVER))!;
      assert.ok(Buffer.from(await bytesOf(onePass)).equals(Buffer.from(twoPasses)), name);
    }
  });

  test('a cover that cannot be had leaves the song tagged without one', async () => {
    const file = FILES['a tag without a picture']!;
    const written = (await writeTagsToBlob(blobOf(file), TAGS, async () => undefined))!;
    assert.equal(hasCover(await bytesOf(written)), false);
    assert.equal(readTextTags(await bytesOf(written)).TIT2, TAGS.title);
  });

  test('what is not an MP3 comes back as nothing: an M4A, noise, an empty file', async () => {
    assert.equal(await writeTagsToBlob(new Blob([M4A]), TAGS), undefined);
    assert.equal(await writeTagsToBlob(new Blob([new Uint8Array(500).fill(7)]), TAGS), undefined);
    assert.equal(await writeTagsToBlob(new Blob([]), TAGS), undefined);
  });

  test('the type is kept (or given), and the audio is not read: only the front and three bytes at the end', async () => {
    const file = concat(tag(3, textFrame('TIT2', 'old'), pictureFrame(3)), ...Array.from({ length: 40 }, () => longAudio), ID3V1); // ~5 MB
    const reads: number[] = [];
    const original = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = function (this: Blob) {
      reads.push(this.size);
      return original.call(this);
    };
    try {
      const written = (await writeTagsToBlob(blobOf(file), TAGS))!;
      assert.equal(written.type, 'audio/mpeg');
      const retyped = (await writeTagsToBlob(blobOf(file), TAGS, undefined, 'audio/x-test'))!;
      assert.equal(retyped.type, 'audio/x-test');
    } finally {
      Blob.prototype.arrayBuffer = original;
    }
    assert.ok(file.length > 4_000_000);
    assert.ok(Math.max(...reads) <= 10 + 4098 + 1500, `the biggest read was ${Math.max(...reads)} bytes`);
    assert.ok(reads.reduce((sum, n) => sum + n, 0) < 20_000, `${reads.reduce((sum, n) => sum + n, 0)} bytes read in all`);
  });

  test('the front of a song: every tag, then 4 KiB of audio; and where the audio starts', async () => {
    const two = FILES['two tags one after the other']!;
    const front = await headOfBlob(blobOf(concat(two, new Uint8Array(10_000))));
    assert.equal(front.audioStart, two.length - AUDIO.length);
    assert.equal(front.head.length, front.audioStart + 4098);
    assert.equal(isMp3(front.head), true);
    assert.deepEqual(await headOfBlob(new Blob([])), { head: new Uint8Array(0), audioStart: 0 });
  });

  test('taggedFetch gives a Blob made of the new tag and the original audio, with a cover once; a song called an MP3 that is an M4A is named for what it is', async () => {
    const file = FILES['an upload: a tag with a picture and junk, an ID3v1 tag at the end']!;
    let covers = 0;
    const fetchTagged = taggedFetch(async () => ({ data: blobOf(file), fileName: 'Raw upload.mp3', mimeType: 'audio/mpeg', bytes: file.length }), {
      tagsOf: () => ({ ...TAGS, cover: 'https://x.test/c.jpg' }),
      fetchCover: async () => (covers++, COVER),
    });
    const song = await fetchTagged('https://x.test/a');
    const written = await bytesOf(song.data);
    assert.equal(song.bytes, written.length);
    assert.equal(readTextTags(written).TIT2, TAGS.title);
    assert.ok(endsWith(written, AUDIO));
    assert.equal(covers, 0, 'it has a picture of its own');

    const bare = await taggedFetch(async () => ({ data: blobOf(FILES['no tag at all']!), fileName: 'x.mp3', mimeType: 'audio/mpeg', bytes: AUDIO.length }), {
      tagsOf: () => ({ ...TAGS, cover: 'https://x.test/c.jpg' }),
      fetchCover: async () => (covers++, COVER),
    })('https://x.test/b');
    assert.equal(covers, 1);
    assert.equal(hasCover(await bytesOf(bare.data)), true);

    // an M4A the site calls an MP3: with no tags to write it is just named and typed for what it is
    const m4a = await taggedFetch(async () => ({ data: new Blob([M4A], { type: 'audio/mpeg' }), fileName: 'Song.mp3', mimeType: 'audio/mpeg', bytes: M4A.length }), { tagsOf: () => undefined })('https://x.test/c');
    assert.equal(m4a.mimeType, 'audio/mp4');
    assert.equal(m4a.fileName, 'Song.m4a');
    assert.equal(m4a.data.type, 'audio/mp4');
    assert.deepEqual(await bytesOf(m4a.data), M4A);
    // and with tags the M4A writer cannot use (this one is only a header), it still goes as an M4A, untouched
    const untouched = await taggedFetch(async () => ({ data: new Blob([M4A], { type: 'audio/mpeg' }), fileName: 'Song.mp3', mimeType: 'audio/mpeg', bytes: M4A.length }), { tagsOf: () => TAGS })('https://x.test/d');
    assert.equal(untouched.mimeType, 'audio/mp4');
    assert.deepEqual(await bytesOf(untouched.data), M4A);

    // something that cannot be tagged at all is returned as it was
    const ogg = { data: new Blob([Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 1)], { type: 'audio/ogg' }), fileName: 'a.ogg', mimeType: 'audio/ogg', bytes: 5 };
    assert.equal(await taggedFetch(async () => ogg, { tagsOf: () => TAGS })('https://x.test/e'), ogg);
  });
});
