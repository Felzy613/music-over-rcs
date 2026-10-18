import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import { AudioCache } from '../src/library/audio-cache.ts';
import type { SongTags } from '../src/library/id3.ts';
import { hasMp4Cover, isFragmented, isMp4, readMp4Tags, unfragment, writeMp4Tags } from '../src/library/mp4.ts';
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

  test("files it can't safely write to are left alone: a fragment it can't read, QuickTime-style tags, not an MP4", () => {
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

/**
 * A fragmented M4A shaped like YouTube's (October 2026): ftyp "dash", an index with empty sample tables, the
 * fragments' defaults (trex), an edit list holding the encoder's delay, a segment index (sidx), then a fragment (moof)
 * and its audio (mdat) for every few samples. Each moof's tfhd says the offsets count from the moof and gives the
 * samples' duration; its trun gives where the audio starts and each sample's size.
 */
function fragmentedM4a(samples: Uint8Array[], perFragment = 3): Uint8Array {
  const full = (type: string, flags: number, ...parts: Uint8Array[]) => box(type, u32(flags), ...parts);
  const mp4a = box('mp4a', new Uint8Array(28), box('esds', u32(0), bytes('decoder settings')));
  const moov = box(
    'moov',
    full('mvhd', 0, u32(0), u32(0), u32(1000), u32(0), new Uint8Array(80)),
    box('mvex', full('trex', 0, u32(1), u32(1), u32(0), u32(0), u32(0))),
    box(
      'trak',
      full('tkhd', 7, u32(0), u32(0), u32(1), u32(0), u32(0), new Uint8Array(60)),
      box('edts', full('elst', 0, u32(1), u32(0), u32(1024), u32(0x10000))),
      box(
        'mdia',
        full('mdhd', 0, u32(0), u32(0), u32(44100), u32(0), u32(0x55c40000)),
        full('hdlr', 0, u32(0), bytes('soun'), new Uint8Array(13)),
        box(
          'minf',
          full('smhd', 0, u32(0)),
          box('dinf', full('dref', 0, u32(1), full('url ', 1))),
          box('stbl', full('stsd', 0, u32(1), mp4a), full('stts', 0, u32(0)), full('stsc', 0, u32(0)), full('stsz', 0, u32(0), u32(0)), full('stco', 0, u32(0))),
        ),
      ),
    ),
  );
  const fragments: Uint8Array[] = [];
  for (let i = 0; i < samples.length; i += perFragment) {
    const some = samples.slice(i, i + perFragment);
    const moofFor = (dataOffset: number) =>
      box(
        'moof',
        full('mfhd', 0, u32(i / perFragment + 1)),
        box('traf', full('tfhd', 0x2002a, u32(1), u32(1), u32(1024), u32(0)), full('tfdt', 0, u32(i * 1024)), full('trun', 0x201, u32(some.length), u32(dataOffset), ...some.map((sample) => u32(sample.length)))),
      );
    const size = moofFor(0).length;
    fragments.push(moofFor(size + 8), box('mdat', ...some));
  }
  return concat(box('ftyp', bytes('dash'), u32(0), bytes('iso6mp41')), moov, full('sidx', 0, new Uint8Array(24)), ...fragments);
}

describe('mp4: a fragmented M4A (YouTube’s) is put back together', () => {
  const samples = Array.from({ length: 8 }, (_, i) => bytes(`sample ${i} `.repeat(i + 1)));
  const read = (data: Uint8Array, at: number) => new DataView(data.buffer, data.byteOffset).getUint32(at);
  /** The first box of this type anywhere in the data (enough for one small file). */
  const find = (data: Uint8Array, type: string) => {
    for (let at = 4; at + 4 <= data.length; at += 1) if (String.fromCharCode(...data.subarray(at, at + 4)) === type) return at - 4;
    return -1;
  };

  test('into one index with every sample in its tables and all the audio in one piece, the audio bytes unchanged', () => {
    const fragmented = fragmentedM4a(samples);
    assert.equal(isFragmented(fragmented), true);
    const plain = unfragment(fragmented)!;
    assert.ok(plain);
    assert.equal(isFragmented(plain), false);
    assert.equal(find(plain, 'moof'), -1);
    assert.equal(find(plain, 'mvex'), -1);
    assert.equal(String.fromCharCode(...plain.subarray(8, 12)), 'M4A ', 'it says it is an ordinary M4A');
    // Every sample's size, one chunk holding them all, and that chunk where the audio starts.
    const stsz = find(plain, 'stsz');
    assert.equal(read(plain, stsz + 16), samples.length);
    assert.deepEqual(samples.map((_, i) => read(plain, stsz + 20 + i * 4)), samples.map((sample) => sample.length));
    const stts = find(plain, 'stts');
    assert.deepEqual([read(plain, stts + 12), read(plain, stts + 16), read(plain, stts + 20)], [1, samples.length, 1024], 'one run: every sample 1024 long');
    const stco = find(plain, 'stco');
    const audioStart = read(plain, stco + 16);
    assert.deepEqual(plain.subarray(audioStart), concat(...samples));
    assert.equal(String.fromCharCode(...plain.subarray(audioStart - 4, audioStart)), 'mdat');
    // The durations: the track's samples at 44,100 a second, the movie's at 1,000.
    const mdhd = find(plain, 'mdhd');
    assert.equal(read(plain, mdhd + 24), samples.length * 1024);
    const mvhd = find(plain, 'mvhd');
    assert.equal(read(plain, mvhd + 24), Math.round((samples.length * 1024 * 1000) / 44100));
    assert.notEqual(find(plain, 'elst'), -1, 'the encoder’s delay at the start is kept');
    assert.notEqual(find(plain, 'esds'), -1, 'the codec’s settings are kept');
  });

  test('tagging one puts it back together first, then writes the tags; an ordinary one is left as it is', () => {
    const tagged = writeMp4Tags(fragmentedM4a(samples), TAGS)!;
    assert.ok(tagged);
    assert.equal(isFragmented(tagged), false);
    assert.equal(readMp4Tags(tagged)['©nam'], TAGS.title);
    const stco = find(tagged, 'stco');
    assert.deepEqual(tagged.subarray(read(tagged, stco + 16)), concat(...samples), 'the tags moved the audio, and the index with it');
    const ordinary = m4a();
    assert.equal(unfragment(ordinary), ordinary);
  });

  test('a file whose audio is cut off, or whose fragment says nothing about its samples, is not guessed at', () => {
    const whole = fragmentedM4a(samples);
    assert.equal(unfragment(whole.subarray(0, whole.length - 5)), undefined);
    assert.equal(unfragment(concat(fragmentedM4a([]), box('moof', box('traf')))), undefined);
  });
});
