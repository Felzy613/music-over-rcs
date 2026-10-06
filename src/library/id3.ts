/**
 * Reads and writes the tags inside an MP3 (ID3), so music apps show a song's real artist, album, number and title
 * instead of whatever the upload had. Written as ID3v2.3, which every app and Windows Explorer read. No dependencies.
 */

/** The tags a song gets. */
export interface SongTags {
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  /** Its number on the album, "3/12". */
  track?: string | undefined;
  /** The year it came out, "2026". */
  year?: string | undefined;
  /** Where its cover is, to add one when the file has none. */
  cover?: string | undefined;
}

/** A picture to put in the file as its cover. */
export interface CoverPicture {
  data: Uint8Array;
  mimeType: string;
}

interface Frame {
  id: string;
  body: Uint8Array;
}

/** The ID3 tags at the start of a file: where the audio begins, and the frames worth keeping (pictures, chapters). */
interface ReadTag {
  audioStart: number;
  kept: Frame[];
}

/** Frames that are kept from the old tag: its pictures, and a video's chapters (which name the parts of a medley). */
const KEPT = new Set(['APIC', 'CHAP', 'CTOC']);
/** Room left in the tag, so a music app can edit it without rewriting the whole file. */
const PADDING = 2048;

const latin1 = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));
const syncsafe = (bytes: Uint8Array, at: number): number => ((bytes[at]! & 0x7f) << 21) | ((bytes[at + 1]! & 0x7f) << 14) | ((bytes[at + 2]! & 0x7f) << 7) | (bytes[at + 3]! & 0x7f);
const plain32 = (bytes: Uint8Array, at: number): number => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;

/** Reads the ID3v2 tag (or tags) at the start of the data. Frames it can't be sure of are left out, never guessed. */
function readTags(data: Uint8Array): ReadTag {
  let at = 0;
  const kept: Frame[] = [];
  let first = true;
  while (data.length >= at + 10 && latin1(data, at, at + 3) === 'ID3') {
    const major = data[at + 3]!;
    const flags = data[at + 5]!;
    const size = syncsafe(data, at + 6);
    const end = Math.min(data.length, at + 10 + size + (major === 4 && flags & 0x10 ? 10 : 0));
    // Only the first tag's frames are read, and only when they're stored plainly (no whole-tag unsynchronisation).
    if (first && (major === 3 || major === 4) && !(flags & 0x80)) kept.push(...readFrames(data, at, major, flags, at + 10 + size));
    first = false;
    at = end;
  }
  return { audioStart: at, kept };
}

function readFrames(data: Uint8Array, start: number, major: number, flags: number, end: number): Frame[] {
  let at = start + 10;
  if (flags & 0x40) at += major === 4 ? syncsafe(data, at) : 4 + plain32(data, at); // an extended header
  const frames: Frame[] = [];
  while (at + 10 <= end && data[at] !== 0) {
    const id = latin1(data, at, at + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = major === 4 ? frameSize(data, at, end) : plain32(data, at + 4);
    const format = data[at + 9]!;
    const bodyStart = at + 10;
    if (size <= 0 || bodyStart + size > end) break;
    // Compressed, encrypted, grouped or unsynchronised frames aren't copied.
    const plain = major === 4 ? (format & 0x4f) === 0 : (format & 0xe0) === 0;
    if (plain && KEPT.has(id)) {
      const body = data.slice(bodyStart, bodyStart + size);
      if (id === 'APIC') {
        const picture = major === 4 ? asV23Picture(body) : body;
        if (picture) frames.push({ id, body: picture });
      } else if (major === 3) {
        frames.push({ id, body }); // chapters hold frames of their own, in their tag's version: only v2.3 ones fit
      }
    }
    at = bodyStart + size;
  }
  return frames;
}

/**
 * A v2.4 frame's size. It should be stored "syncsafe", but some writers (older iTunes) store it plainly; the one that
 * lands on the next frame, the padding or the end of the tag is taken.
 */
function frameSize(data: Uint8Array, at: number, end: number): number {
  const safe = syncsafe(data, at + 4);
  const plain = plain32(data, at + 4);
  if (safe === plain) return safe;
  const fits = (size: number) => {
    const next = at + 10 + size;
    return next === end || (next < end && (data[next] === 0 || (next + 4 <= end && /^[A-Z0-9]{4}$/.test(latin1(data, next, next + 4)))));
  };
  return fits(safe) || !fits(plain) ? safe : plain;
}

/** A v2.4 picture frame as v2.3: the same picture, its description dropped when it's in an encoding v2.3 lacks. */
function asV23Picture(body: Uint8Array): Uint8Array | undefined {
  const encoding = body[0];
  if (encoding === 0 || encoding === 1) return body;
  const mimeEnd = body.indexOf(0, 1);
  if (mimeEnd < 0 || mimeEnd + 2 > body.length) return undefined;
  const type = body[mimeEnd + 1]!;
  let at = mimeEnd + 2;
  if (encoding === 3) {
    const descEnd = body.indexOf(0, at);
    if (descEnd < 0) return undefined;
    at = descEnd + 1;
  } else {
    while (at + 1 < body.length && (body[at] !== 0 || body[at + 1] !== 0)) at += 2;
    at += 2;
  }
  if (at > body.length) return undefined;
  return concat([Uint8Array.of(0), body.subarray(1, mimeEnd + 1), Uint8Array.of(type, 0), body.subarray(at)]);
}

/** Whether data is an MP3: its tags, then the first MPEG audio frame. */
export function isMp3(data: Uint8Array): boolean {
  const at = readTags(data).audioStart;
  // Some files have a little padding before the first frame.
  for (let i = at; i < Math.min(data.length - 1, at + 4096); i += 1) {
    if (data[i] === 0xff && (data[i + 1]! & 0xe0) === 0xe0) return (data[i + 1]! & 0x06) !== 0; // not AAC (layer 00)
    if (data[i] !== 0) return false;
  }
  return false;
}

/** Whether the file's tag has a picture. */
export function hasCover(data: Uint8Array): boolean {
  return readTags(data).kept.some((frame) => frame.id === 'APIC');
}

/**
 * The MP3 with its tags replaced by these. The old tag's pictures and chapters are kept (a cover is added only when
 * there's none), everything else in it (a video's title, its channel, "People & Blogs") goes, and so does an old
 * ID3v1 tag at the end. The audio itself is untouched. Nothing when the data isn't an MP3.
 */
export function writeTags(data: Uint8Array, tags: SongTags, cover?: CoverPicture): Uint8Array | undefined {
  if (!isMp3(data)) return undefined;
  const { audioStart, kept } = readTags(data);
  let audioEnd = data.length;
  if (audioEnd - audioStart >= 128 && latin1(data, audioEnd - 128, audioEnd - 125) === 'TAG') audioEnd -= 128;

  const frames: Frame[] = [
    text('TIT2', tags.title),
    text('TPE1', tags.artist),
    text('TPE2', tags.albumArtist),
    text('TALB', tags.album),
    ...(tags.track ? [text('TRCK', tags.track)] : []),
    ...(tags.year ? [text('TYER', tags.year)] : []),
    ...kept,
  ];
  if (cover && !kept.some((frame) => frame.id === 'APIC')) frames.push(picture(cover));

  const body = concat([...frames.map(frameBytes), new Uint8Array(PADDING)]);
  const header = new Uint8Array(10);
  header.set([0x49, 0x44, 0x33, 3, 0, 0]);
  header.set(syncsafeBytes(body.length), 6);
  return concat([header, body, data.subarray(audioStart, audioEnd)]);
}

/** A text frame: plain Latin-1 when it fits, otherwise UTF-16 (Hebrew, curly quotes). */
function text(id: string, value: string): Frame {
  const plain = /^[\u0000-ÿ]*$/.test(value);
  if (plain) return { id, body: concat([Uint8Array.of(0), Uint8Array.from(value, (char) => char.charCodeAt(0))]) };
  const utf16 = new Uint8Array(2 + value.length * 2);
  utf16.set([0xff, 0xfe]);
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    utf16[2 + i * 2] = unit & 0xff;
    utf16[3 + i * 2] = unit >> 8;
  }
  return { id, body: concat([Uint8Array.of(1), utf16]) };
}

/** A front-cover picture frame. */
function picture(cover: CoverPicture): Frame {
  const mime = Uint8Array.from(cover.mimeType, (char) => char.charCodeAt(0) & 0xff);
  return { id: 'APIC', body: concat([Uint8Array.of(0), mime, Uint8Array.of(0, 3, 0), cover.data]) };
}

function frameBytes(frame: Frame): Uint8Array {
  const header = new Uint8Array(10);
  header.set(Uint8Array.from(frame.id, (char) => char.charCodeAt(0)));
  new DataView(header.buffer).setUint32(4, frame.body.length);
  return concat([header, frame.body]);
}

function syncsafeBytes(n: number): Uint8Array {
  return Uint8Array.of((n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f);
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

/**
 * The text tags in a file, by frame id ("TIT2" → title), for checking what was written. Pictures and chapters are
 * listed by id with an empty value.
 */
export function readTextTags(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  if (latin1(data, 0, 3) !== 'ID3' || data[3] !== 3) return out;
  const end = 10 + syncsafe(data, 6);
  let at = 10;
  while (at + 10 <= end && data[at] !== 0) {
    const id = latin1(data, at, at + 4);
    const size = plain32(data, at + 4);
    const body = data.subarray(at + 10, at + 10 + size);
    out[id] = id.startsWith('T') ? decodeText(body) : '';
    at += 10 + size;
  }
  return out;
}

function decodeText(body: Uint8Array): string {
  const encoding = body[0];
  const rest = body.subarray(1);
  if (encoding === 0) return latin1(rest, 0, rest.length).replace(/\0+$/, '');
  if (encoding === 1) {
    const littleEndian = rest[0] === 0xff && rest[1] === 0xfe;
    return new TextDecoder(littleEndian ? 'utf-16le' : 'utf-16be').decode(rest.subarray(2)).replace(/\0+$/, '');
  }
  return new TextDecoder(encoding === 2 ? 'utf-16be' : 'utf-8').decode(rest).replace(/\0+$/, '');
}
