import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { AudioCache } from '../src/library/audio-cache.ts';
import { audioTypeOf, hasCover, isMp3, readTextTags, writeTags, type SongTags } from '../src/library/id3.ts';
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
    assert.deepEqual(songTags(albumSong), {
      title: 'Elul Melodies (feat. Chaim Horowitz)',
      artist: 'Yumi Gelb',
      albumArtist: 'Yumi Gelb',
      album: 'Elul Collection (Live)',
      track: '3/8',
    });
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
