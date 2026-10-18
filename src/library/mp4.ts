/**
 * Reads and writes the tags inside an M4A (MP4 audio) the way iTunes does (moov › udta › meta › ilst), so music apps
 * show a song's real artist, album, number and title. The audio is never touched: when the tags make the file's index
 * (moov) bigger and it comes before the audio, the index's pointers into the audio are moved by as much. A fragmented
 * M4A (YouTube's, which come in pieces the way they are streamed) is first put back together as an ordinary one. No
 * dependencies.
 */
import type { CoverPicture, SongTags } from './id3.ts';

interface Box {
  type: string;
  start: number;
  /** The header's length: 8, or 16 with a 64-bit size. */
  header: number;
  /** The whole box, header included. */
  size: number;
}

const latin1 = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
const latin1Bytes = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);

/** The boxes between two offsets, or nothing when they don't fit together exactly (a damaged or unusual file). */
function boxesIn(data: Uint8Array, from: number, to: number): Box[] | undefined {
  const out: Box[] = [];
  const dv = view(data);
  let at = from;
  while (at + 8 <= to) {
    let size = dv.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return undefined;
      size = Number(dv.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) {
      size = to - at; // the last box, running to the end
    }
    if (size < header || at + size > to) return undefined;
    out.push({ type: latin1(data, at + 4, at + 8), start: at, header, size });
    at += size;
  }
  return at === to || to - at < 8 ? out : undefined;
}

const childrenOf = (data: Uint8Array, box: Box, skip = 0) => boxesIn(data, box.start + box.header + skip, box.start + box.size);
const bytesOf = (data: Uint8Array, box: Box) => data.subarray(box.start, box.start + box.size);

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  const out = new Uint8Array(8 + body.length);
  view(out).setUint32(0, out.length);
  out.set(latin1Bytes(type), 4);
  out.set(body, 8);
  return out;
}

/** The parts of a file worth tagging: its top-level boxes, the index (moov), and inside it what holds the tags. */
interface Layout {
  moov: Box;
  moovChildren: Box[];
  udta?: Box | undefined;
  udtaChildren: Box[];
  meta?: Box | undefined;
  metaChildren: Box[];
  ilstChildren: Box[];
}

/** Reads where the tags go, or nothing when this isn't an M4A this can safely write to. */
function layoutOf(data: Uint8Array): Layout | undefined {
  const top = boxesIn(data, 0, data.length);
  if (!top || top[0]?.type !== 'ftyp') return undefined;
  // A fragmented file (moof) points into its audio from places this doesn't rewrite.
  if (top.some((b) => b.type === 'moof')) return undefined;
  const moov = top.find((b) => b.type === 'moov');
  const moovChildren = moov && childrenOf(data, moov);
  if (!moov || !moovChildren) return undefined;
  const udta = moovChildren.find((b) => b.type === 'udta');
  const udtaChildren = udta ? childrenOf(data, udta) : [];
  if (!udtaChildren) return undefined;
  const meta = udtaChildren.find((b) => b.type === 'meta');
  let metaChildren: Box[] = [];
  if (meta) {
    // iTunes' meta has 4 bytes of version and flags before its boxes; a QuickTime-style one (no version) isn't ours.
    const children = childrenOf(data, meta, 4);
    if (!children || children[0]?.type !== 'hdlr') return undefined;
    metaChildren = children;
  }
  const ilst = metaChildren.find((b) => b.type === 'ilst');
  const ilstChildren = ilst ? childrenOf(data, ilst) : [];
  if (!ilstChildren) return undefined;
  return { moov, moovChildren, udta, udtaChildren, meta, metaChildren, ilstChildren };
}

/** Whether data is an M4A whose tags can be written. */
export function isMp4(data: Uint8Array): boolean {
  return layoutOf(data) !== undefined;
}

/** Whether the M4A's tags have a cover. */
export function hasMp4Cover(data: Uint8Array): boolean {
  return layoutOf(data)?.ilstChildren.some((item) => item.type === 'covr') ?? false;
}

/** An ilst item: its name, and one "data" box holding the value with its type (1 text, 0 binary, 13 JPEG, 14 PNG). */
function item(type: string, dataType: number, payload: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  view(head).setUint32(0, dataType);
  return box(type, box('data', head, payload));
}

const text = (type: string, value: string) => item(type, 1, new TextEncoder().encode(value));

/** "3/12" as iTunes keeps it: two 16-bit numbers between padding. */
function trackItem(track: string): Uint8Array | undefined {
  const match = /^(\d+)(?:\/(\d+))?$/.exec(track);
  if (!match) return undefined;
  const payload = new Uint8Array(8);
  view(payload).setUint16(2, Math.min(Number(match[1]), 0xffff));
  view(payload).setUint16(4, Math.min(Number(match[2] ?? 0), 0xffff));
  return item('trkn', 0, payload);
}

/** The handler that says a meta box holds iTunes-style tags. */
const HDLR = box('hdlr', new Uint8Array(8), latin1Bytes('mdirappl'), new Uint8Array(9));

/**
 * The M4A with its tags replaced by these. Its cover is kept (one is added only when there's none), and everything
 * else in the old tags (the encoder's name, say) goes. The audio is untouched. Nothing when the data isn't an M4A
 * this can safely write to.
 */
export function writeMp4Tags(original: Uint8Array, tags: SongTags, cover?: CoverPicture): Uint8Array | undefined {
  const data = isFragmented(original) ? unfragment(original) : original;
  const layout = data && layoutOf(data);
  if (!data || !layout) return undefined;
  const { moov, moovChildren, udta, udtaChildren, meta, metaChildren, ilstChildren } = layout;

  const keptCover = ilstChildren.find((b) => b.type === 'covr');
  const coverType = cover?.mimeType === 'image/png' ? 14 : cover?.mimeType === 'image/jpeg' ? 13 : undefined;
  const items = [
    text('©nam', tags.title),
    text('©ART', tags.artist),
    text('aART', tags.albumArtist),
    text('©alb', tags.album),
    ...(tags.track ? [trackItem(tags.track)].filter((part): part is Uint8Array => !!part) : []),
    ...(tags.year ? [text('©day', tags.year)] : []),
    ...(keptCover ? [bytesOf(data, keptCover)] : cover && coverType ? [item('covr', coverType, cover.data)] : []),
  ];
  const hdlr = metaChildren.find((b) => b.type === 'hdlr');
  const newMeta = box(
    'meta',
    new Uint8Array(4),
    hdlr ? bytesOf(data, hdlr) : HDLR,
    box('ilst', ...items),
    ...metaChildren.filter((b) => b.type !== 'hdlr' && b.type !== 'ilst').map((b) => bytesOf(data, b)),
  );
  const newUdta = box('udta', ...udtaChildren.filter((b) => b !== meta).map((b) => bytesOf(data, b)), newMeta);
  const newMoov = box('moov', ...moovChildren.filter((b) => b !== udta).map((b) => bytesOf(data, b)), newUdta);

  // The audio after the index moves by as much as the index grew; the index's pointers to it move with it.
  const delta = newMoov.length - moov.size;
  const moovEnd = moov.start + moov.size;
  if (delta !== 0 && !shiftChunkOffsets(newMoov, moovEnd, delta)) return undefined;
  return concat([data.subarray(0, moov.start), newMoov, data.subarray(moovEnd)]);
}

/**
 * Moves every chunk offset (stco, co64) in an index that points past `after` by `delta`. False when an offset would no
 * longer fit, or the index can't be read.
 */
function shiftChunkOffsets(moov: Uint8Array, after: number, delta: number): boolean {
  const dv = view(moov);
  const walk = (from: number, to: number): boolean => {
    const children = boxesIn(moov, from, to);
    if (!children) return false;
    for (const child of children) {
      const bodyStart = child.start + child.header;
      if (['trak', 'mdia', 'minf', 'stbl'].includes(child.type)) {
        if (!walk(bodyStart, child.start + child.size)) return false;
      } else if (child.type === 'stco' || child.type === 'co64') {
        const wide = child.type === 'co64';
        const count = dv.getUint32(bodyStart + 4);
        const first = bodyStart + 8;
        if (first + count * (wide ? 8 : 4) > child.start + child.size) return false;
        for (let i = 0; i < count; i += 1) {
          const at = first + i * (wide ? 8 : 4);
          const offset = wide ? Number(dv.getBigUint64(at)) : dv.getUint32(at);
          if (offset < after) continue;
          const moved = offset + delta;
          if (wide) dv.setBigUint64(at, BigInt(moved));
          else if (moved > 0xffffffff) return false;
          else dv.setUint32(at, moved);
        }
      }
    }
    return true;
  };
  return walk(8, moov.length);
}

/** Whether the M4A comes in fragments (moof boxes, each with its piece of the audio), as YouTube streams it. */
export function isFragmented(data: Uint8Array): boolean {
  const top = boxesIn(data, 0, data.length);
  return !!top && top[0]?.type === 'ftyp' && top.some((b) => b.type === 'moof');
}

const childOf = (data: Uint8Array, parent: Box | undefined, type: string, skip = 0): Box | undefined =>
  parent ? childrenOf(data, parent, skip)?.find((b) => b.type === type) : undefined;

/** A full box's version (0 or 1) and flags. */
const versionOf = (data: Uint8Array, b: Box): number => data[b.start + b.header]!;
const flagsOf = (data: Uint8Array, b: Box): number => view(data).getUint32(b.start + b.header) & 0xffffff;

/** A copy of a box (mvhd, tkhd, mdhd) with its duration set, where its version puts it. */
function withDuration(data: Uint8Array, b: Box, at: { v0: number; v1: number }, duration: number): Uint8Array | undefined {
  const copy = bytesOf(data, b).slice();
  const dv = view(copy);
  const v1 = copy[b.header] === 1;
  const offset = b.header + (v1 ? at.v1 : at.v0);
  if (offset + (v1 ? 8 : 4) > copy.length) return undefined;
  if (v1) dv.setBigUint64(offset, BigInt(duration));
  else if (duration > 0xffffffff) return undefined;
  else dv.setUint32(offset, duration);
  return copy;
}

/** A full box (version 0, no flags) of 32-bit numbers. */
function fullBox(type: string, values: number[]): Uint8Array {
  const body = new Uint8Array(4 + values.length * 4);
  values.forEach((value, i) => view(body).setUint32(4 + i * 4, value));
  return box(type, body);
}

/**
 * A fragmented M4A put back together as an ordinary one: one index (moov) with every sample's size and duration in its
 * tables, then all the audio in one piece (mdat). The audio bytes, the codec's settings and the edit list (the
 * encoder's delay at the start) are kept as they are. Nothing when it isn't one audio track this can read safely; an
 * ordinary M4A is returned as it is.
 */
export function unfragment(data: Uint8Array): Uint8Array | undefined {
  const top = boxesIn(data, 0, data.length);
  if (!top || top[0]?.type !== 'ftyp') return undefined;
  if (!top.some((b) => b.type === 'moof')) return data;
  const dv = view(data);
  const moov = top.find((b) => b.type === 'moov');
  const moovChildren = moov && childrenOf(data, moov);
  const traks = moovChildren?.filter((b) => b.type === 'trak') ?? [];
  const mvhd = moovChildren?.find((b) => b.type === 'mvhd');
  if (!moov || !moovChildren || traks.length !== 1 || !mvhd) return undefined;
  const trak = traks[0]!;
  const trakChildren = childrenOf(data, trak);
  const tkhd = trakChildren?.find((b) => b.type === 'tkhd');
  const mdia = trakChildren?.find((b) => b.type === 'mdia');
  const mdiaChildren = mdia && childrenOf(data, mdia);
  const mdhd = mdiaChildren?.find((b) => b.type === 'mdhd');
  const minf = mdiaChildren?.find((b) => b.type === 'minf');
  const minfChildren = minf && childrenOf(data, minf);
  const stbl = minfChildren?.find((b) => b.type === 'stbl');
  const stsd = childOf(data, stbl, 'stsd');
  if (!tkhd || !mdia || !mdiaChildren || !mdhd || !minf || !minfChildren || !stbl || !stsd) return undefined;
  const trackId = dv.getUint32(tkhd.start + tkhd.header + (versionOf(data, tkhd) === 1 ? 20 : 12));
  const movieScale = dv.getUint32(mvhd.start + mvhd.header + (versionOf(data, mvhd) === 1 ? 20 : 12));
  const mediaScale = dv.getUint32(mdhd.start + mdhd.header + (versionOf(data, mdhd) === 1 ? 20 : 12));
  if (!movieScale || !mediaScale) return undefined;

  // The defaults the fragments fall back on.
  let defaultDuration = 0;
  let defaultSize = 0;
  const mvex = moovChildren.find((b) => b.type === 'mvex');
  for (const trex of (mvex && childrenOf(data, mvex))?.filter((b) => b.type === 'trex') ?? []) {
    const at = trex.start + trex.header;
    if (dv.getUint32(at + 4) !== trackId) continue;
    defaultDuration = dv.getUint32(at + 12);
    defaultSize = dv.getUint32(at + 16);
  }

  // Every sample: where it is, how big, how long. Each fragment's samples follow one another in the file.
  const sizes: number[] = [];
  const durations: number[] = [];
  const pieces: Array<{ from: number; to: number }> = [];
  for (const moof of top.filter((b) => b.type === 'moof')) {
    for (const traf of childrenOf(data, moof)?.filter((b) => b.type === 'traf') ?? []) {
      const parts = childrenOf(data, traf);
      const tfhd = parts?.find((b) => b.type === 'tfhd');
      if (!parts || !tfhd) return undefined;
      const tf = flagsOf(data, tfhd);
      let at = tfhd.start + tfhd.header + 4;
      if (dv.getUint32(at) !== trackId) continue;
      at += 4;
      let base = moof.start;
      if (tf & 0x1) {
        base = Number(dv.getBigUint64(at));
        at += 8;
      }
      if (tf & 0x2) at += 4;
      let duration = defaultDuration;
      let size = defaultSize;
      if (tf & 0x8) (duration = dv.getUint32(at)), (at += 4);
      if (tf & 0x10) (size = dv.getUint32(at)), (at += 4);
      let next: number | undefined;
      for (const trun of parts.filter((b) => b.type === 'trun')) {
        const rf = flagsOf(data, trun);
        let p = trun.start + trun.header + 4;
        const count = dv.getUint32(p);
        p += 4;
        let position = next;
        if (rf & 0x1) (position = base + dv.getInt32(p)), (p += 4);
        if (rf & 0x4) p += 4;
        if (position === undefined) return undefined;
        const from = position;
        for (let i = 0; i < count; i += 1) {
          const sampleDuration = rf & 0x100 ? dv.getUint32(p) : duration;
          if (rf & 0x100) p += 4;
          const sampleSize = rf & 0x200 ? dv.getUint32(p) : size;
          if (rf & 0x200) p += 4;
          if (rf & 0x400) p += 4;
          // A sample shown at another time than it's decoded (video) needs a table this doesn't write.
          if (rf & 0x800) {
            if (dv.getInt32(p) !== 0) return undefined;
            p += 4;
          }
          if (p > trun.start + trun.size || !sampleSize) return undefined;
          sizes.push(sampleSize);
          durations.push(sampleDuration);
          position += sampleSize;
        }
        if (position > data.length) return undefined;
        pieces.push({ from, to: position });
        next = position;
      }
    }
  }
  if (sizes.length === 0) return undefined;

  // The tables: durations as runs (stts), every sample in one chunk (stsc, stco), each sample's size (stsz).
  const runs: number[] = [];
  for (const sampleDuration of durations) {
    if (runs.length > 0 && runs[runs.length - 1] === sampleDuration) runs[runs.length - 2]! += 1;
    else runs.push(1, sampleDuration);
  }
  const mediaDuration = durations.reduce((sum, d) => sum + d, 0);
  const movieDuration = Math.round((mediaDuration * movieScale) / mediaScale);
  const newStbl = box('stbl', bytesOf(data, stsd), fullBox('stts', [runs.length / 2, ...runs]), fullBox('stsc', [1, 1, sizes.length, 1]), fullBox('stsz', [0, sizes.length, ...sizes]), fullBox('stco', [1, 0]));
  const newMinf = box('minf', ...minfChildren.map((b) => (b === stbl ? newStbl : bytesOf(data, b))));
  const newMdhd = withDuration(data, mdhd, { v0: 16, v1: 24 }, mediaDuration);
  const newTkhd = withDuration(data, tkhd, { v0: 20, v1: 28 }, movieDuration);
  const newMvhd = withDuration(data, mvhd, { v0: 16, v1: 24 }, movieDuration);
  if (!newMdhd || !newTkhd || !newMvhd) return undefined;
  const newMdia = box('mdia', ...mdiaChildren.map((b) => (b === mdhd ? newMdhd : b === minf ? newMinf : bytesOf(data, b))));
  const newTrak = box('trak', ...(trakChildren ?? []).map((b) => (b === tkhd ? newTkhd : b === mdia ? newMdia : bytesOf(data, b))));
  const newMoov = box('moov', ...moovChildren.filter((b) => b.type !== 'mvex').map((b) => (b === mvhd ? newMvhd : b === trak ? newTrak : bytesOf(data, b))));
  // An ordinary M4A says so, rather than "dash".
  const ftyp = box('ftyp', latin1Bytes('M4A '), Uint8Array.of(0, 0, 2, 0), latin1Bytes('M4A isomiso2mp41'));

  const audioBytes = pieces.reduce((sum, piece) => sum + piece.to - piece.from, 0);
  const out = new Uint8Array(ftyp.length + newMoov.length + 8 + audioBytes);
  out.set(ftyp, 0);
  out.set(newMoov, ftyp.length);
  const mdatStart = ftyp.length + newMoov.length;
  view(out).setUint32(mdatStart, 8 + audioBytes);
  out.set(latin1Bytes('mdat'), mdatStart + 4);
  let at = mdatStart + 8;
  for (const piece of pieces) {
    out.set(data.subarray(piece.from, piece.to), at);
    at += piece.to - piece.from;
  }
  // The one chunk starts where the audio does.
  const written = boxPath(out, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']);
  if (!written) return undefined;
  view(out).setUint32(written.start + written.header + 8, mdatStart + 8);
  return out;
}

/** The box at the end of a path of box types from the top of the file ("moov", "trak", …), the first of each. */
function boxPath(data: Uint8Array, path: string[]): Box | undefined {
  let found: Box | undefined;
  for (const type of path) {
    const level = found ? childrenOf(data, found) : boxesIn(data, 0, data.length);
    found = level?.find((b) => b.type === type);
    if (!found) return undefined;
  }
  return found;
}

/** The tags in an M4A by item name ("©nam" → title, "trkn" → "3/12"); a cover is listed with an empty value. */
export function readMp4Tags(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const layout = layoutOf(data);
  for (const entry of layout?.ilstChildren ?? []) {
    const value = childrenOf(data, entry)?.find((b) => b.type === 'data');
    if (!value) continue;
    const payload = data.subarray(value.start + 16, value.start + value.size);
    const dataType = view(data).getUint32(value.start + 8);
    out[entry.type] =
      entry.type === 'trkn' ? `${view(payload).getUint16(2)}/${view(payload).getUint16(4)}` : dataType === 1 ? new TextDecoder().decode(payload) : '';
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
