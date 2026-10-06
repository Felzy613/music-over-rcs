import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { AudioCache } from '../src/library/audio-cache.ts';
import type { SongTags } from '../src/library/id3.ts';
import { hasMp4Cover, isMp4, readMp4Tags, writeMp4Tags } from '../src/library/mp4.ts';
import { extensionOf } from '../src/library/naming.ts';

const bytes = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
const u64 = (n: number) => concat(u32(Math.floor(n / 2 ** 32)), u32(n % 2 ** 32));
const box = (type: string, ...parts: Uint8Array[]) => {
  const body = concat(...parts);
  return concat(u32(8 + body.length), bytes(type), body);
};
const dataItem = (type: string, dataType: number, payload: Uint8Array) => box(type, box('data', u32(dataType), u32(0), payload));

/** The audio, in three chunks: what must be found, unchanged, wherever the index says it is. */
const CHUNKS = [bytes('first chunk of audio'), bytes('second'), bytes('the third and last chunk')];

/**
 * A small M4A: ftyp, the index (moov: a track whose chunk table points into mdat, then udta › meta › ilst with an
 * encoder tag and a chapter list), and the audio (mdat), with the index before the audio or after it.
 */
function m4a(options: { moovFirst?: boolean; wide?: boolean; udta?: 'tags' | 'cover' | 'none' | 'quicktime' } = {}): Uint8Array {
  const { moovFirst = true, wide = false, udta = 'tags' } = options;
  const ftyp = box('ftyp', bytes('M4A '), u32(0), bytes('M4A isom'));
  const items = [dataItem('©too', 1, bytes('Lavf59.16.100')), ...(udta === 'cover' ? [dataItem('covr', 14, bytes('OLD PNG'))] : [])];
  const hdlr = box('hdlr', new Uint8Array(8), bytes('mdirappl'), new Uint8Array(9));
  const meta = udta === 'quicktime' ? box('meta', hdlr, box('ilst', ...items)) : box('meta', u32(0), hdlr, box('ilst', ...items));
  const udtaBox = udta === 'none' ? new Uint8Array(0) : box('udta', box('chpl', bytes('chapters')), meta);
  const moovWith = (offsets: number[]) =>
    box(
      'moov',
      box('mvhd', new Uint8Array(100)),
      box('trak', box('mdia', box('minf', box('stbl', box('stsz', new Uint8Array(12)), box(wide ? 'co64' : 'stco', u32(0), u32(offsets.length), ...offsets.map(wide ? u64 : u32)))))),
      udtaBox,
    );
  const mdatBody = concat(...CHUNKS);
  const moovSize = moovWith(CHUNKS.map(() => 0)).length;
  const mdatStart = moovFirst ? ftyp.length + moovSize : ftyp.length;
  const offsets: number[] = [];
  let at = mdatStart + 8;
  for (const chunk of CHUNKS) {
    offsets.push(at);
    at += chunk.length;
  }
  const mdat = box('mdat', mdatBody);
  return moovFirst ? concat(ftyp, moovWith(offsets), mdat) : concat(ftyp, mdat, moovWith(offsets));
}

/** The chunk offsets in a file's index. */
function chunkOffsets(data: Uint8Array): number[] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const found: number[] = [];
  const walk = (from: number, to: number) => {
    for (let at = from; at + 8 <= to; ) {
      const size = dv.getUint32(at);
      const type = String.fromCharCode(...data.subarray(at + 4, at + 8));
      if (['moov', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) walk(at + 8, at + size);
      if (type === 'stco' || type === 'co64') {
        const count = dv.getUint32(at + 12);
        for (let i = 0; i < count; i += 1) found.push(type === 'co64' ? Number(dv.getBigUint64(at + 16 + i * 8)) : dv.getUint32(at + 16 + i * 4));
      }
      at += size;
    }
  };
  walk(0, data.length);
  return found;
}
const audioIntact = (data: Uint8Array) =>
  chunkOffsets(data).every((offset, i) => Buffer.from(data.subarray(offset, offset + CHUNKS[i]!.length)).equals(Buffer.from(CHUNKS[i]!)));

const TAGS: SongTags = { title: 'Mama Rachel Medley (feat. Zaltz Band)', artist: 'Shulem Lemmer', albumArtist: 'Shulem Lemmer', album: 'Mama Rachel Medley (feat. Zaltz Band) - Single', track: '1/1', year: '2026' };
const JPEG = { data: bytes('NEW JPEG'), mimeType: 'image/jpeg' };

describe('mp4: the tags inside an M4A', () => {
  test("the upload's tags are replaced; the audio is found where the index says, though the index grew in front of it", () => {
    const upload = m4a();
    assert.ok(audioIntact(upload), 'the test file itself is right');
    const written = writeMp4Tags(upload, TAGS)!;
    assert.deepEqual(readMp4Tags(written), {
      '©nam': 'Mama Rachel Medley (feat. Zaltz Band)',
      '©ART': 'Shulem Lemmer',
      aART: 'Shulem Lemmer',
      '©alb': 'Mama Rachel Medley (feat. Zaltz Band) - Single',
      trkn: '1/1',
      '©day': '2026',
    });
    assert.notDeepEqual(chunkOffsets(written), chunkOffsets(upload), 'the pointers moved');
    assert.ok(audioIntact(written), 'and still point at the same audio');
    assert.ok(Buffer.from(written).includes(Buffer.from('chapters')), 'chapters are kept');
    assert.ok(!Buffer.from(written).includes(Buffer.from('Lavf59')), "the encoder's tag is gone");
    assert.deepEqual(writeMp4Tags(written, TAGS), written, 'writing the same tags again changes nothing');
  });

  test('with the index after the audio, nothing points past it, so nothing moves; 64-bit tables move too', () => {
    const after = m4a({ moovFirst: false });
    const written = writeMp4Tags(after, TAGS)!;
    assert.deepEqual(chunkOffsets(written), chunkOffsets(after));
    assert.ok(audioIntact(written));
    const wide = writeMp4Tags(m4a({ wide: true }), TAGS)!;
    assert.ok(audioIntact(wide));
  });

  test('a cover is kept, or added (JPEG or PNG) when there is none', () => {
    const kept = writeMp4Tags(m4a({ udta: 'cover' }), TAGS, JPEG)!;
    assert.ok(Buffer.from(kept).includes(Buffer.from('OLD PNG')));
    assert.ok(!Buffer.from(kept).includes(Buffer.from('NEW JPEG')), 'no second cover');
    const bare = m4a();
    assert.equal(hasMp4Cover(bare), false);
    const added = writeMp4Tags(bare, TAGS, JPEG)!;
    assert.equal(hasMp4Cover(added), true);
    assert.ok(audioIntact(added));
  });

  test('a file with no tags at all gets them; Hebrew and curly quotes are kept', () => {
    const written = writeMp4Tags(m4a({ udta: 'none' }), { ...TAGS, title: 'V’Nusni - ונתנו' })!;
    assert.equal(readMp4Tags(written)['©nam'], 'V’Nusni - ונתנו');
    assert.ok(Buffer.from(written).includes(Buffer.from('mdirappl')), 'marked as iTunes-style tags');
    assert.ok(audioIntact(written));
  });

  test("files it can't safely write to are left alone: fragmented, QuickTime-style tags, not an MP4", () => {
    const fragmented = concat(m4a(), box('moof', new Uint8Array(16)));
    assert.equal(writeMp4Tags(fragmented, TAGS), undefined);
    assert.equal(writeMp4Tags(m4a({ udta: 'quicktime' }), TAGS), undefined);
    assert.equal(writeMp4Tags(bytes('ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000'), TAGS), undefined);
    assert.equal(isMp4(m4a().subarray(0, 60)), false, 'cut short');
  });
});

describe('mp4: kept M4A songs are tagged', () => {
  let dir: string;
  let catalog: Catalog;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mors-mp4-'));
    catalog = new Catalog(':memory:');
  });
  afterEach(async () => {
    catalog.close();
    await rm(dir, { recursive: true, force: true });
  });

  test('one the site calls an MP3 is kept, tagged and sent as an M4A', async () => {
    const placeOf = (_url: string, audio: { fileName: string; mimeType: string }) => `Shulem Lemmer/Singles/Mama Rachel Medley${extensionOf(audio)}`;
    const kept = new AudioCache({ dir, index: catalog, placeOf, tagsOf: () => TAGS });
    const upload = m4a();
    const sent = await kept.put('https://x.test/1', { data: new Blob([upload]), fileName: 'Mama Rachel Medley.mp3', mimeType: 'audio/mpeg', bytes: upload.length });
    assert.equal(sent.mimeType, 'audio/mp4');
    assert.equal(sent.fileName, 'Mama Rachel Medley.m4a');
    const onDisk = new Uint8Array(await readFile(join(dir, 'Shulem Lemmer', 'Singles', 'Mama Rachel Medley.m4a')));
    assert.equal(readMp4Tags(onDisk)['©ART'], 'Shulem Lemmer');
    assert.ok(audioIntact(onDisk));
    assert.deepEqual(new Uint8Array(await sent.data.arrayBuffer()), onDisk, 'the file sent is the one kept');
    assert.deepEqual(await readdir(join(dir, 'Shulem Lemmer', 'Singles')), ['Mama Rachel Medley.m4a']);
    assert.equal((await kept.organize()).tagged, 0, 'nothing more to write');
  });

  test('an M4A kept before is tagged once, with a cover', async () => {
    const untagged = new AudioCache({ dir, index: catalog });
    const upload = m4a();
    await untagged.put('https://x.test/1', { data: new Blob([upload]), fileName: 'Song.m4a', mimeType: 'audio/mp4', bytes: upload.length });
    const kept = new AudioCache({ dir, index: catalog, tagsOf: () => ({ ...TAGS, cover: 'https://x.test/cover.jpg' }), fetchCover: async () => JPEG });
    assert.equal((await kept.organize()).tagged, 1);
    const onDisk = new Uint8Array(await readFile(join(dir, 'Song.m4a')));
    assert.equal(hasMp4Cover(onDisk), true);
    assert.equal(readMp4Tags(onDisk).trkn, '1/1');
    assert.ok(audioIntact(onDisk));
    assert.equal(catalog.cachedAudio('https://x.test/1')?.bytes, onDisk.length);
    assert.equal((await kept.organize()).tagged, 0);
  });
});
