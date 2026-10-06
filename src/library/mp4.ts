/**
 * Reads and writes the tags inside an M4A (MP4 audio) the way iTunes does (moov › udta › meta › ilst), so music apps
 * show a song's real artist, album, number and title. The audio is never touched: when the tags make the file's index
 * (moov) bigger and it comes before the audio, the index's pointers into the audio are moved by as much. No
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
export function writeMp4Tags(data: Uint8Array, tags: SongTags, cover?: CoverPicture): Uint8Array | undefined {
  const layout = layoutOf(data);
  if (!layout) return undefined;
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
