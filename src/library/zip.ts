import { crc32 } from 'node:zlib';

// A ZIP writer for albums: a few audio files in one archive. Audio is already compressed, so files are stored as they
// are (method 0), which keeps this to headers and a checksum. Names are UTF-8 (flag bit 11), so Hebrew titles survive.
// No ZIP64: an archive is under 4 GB and 65,535 files by a wide margin, since a chat takes about 100 MB.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const UTF8_NAMES = 0x0800;
const VERSION = 20;
/** 1 January 1980, midnight: the earliest time a ZIP can hold, used when the entries have no time worth keeping. */
const DOS_DATE_1980 = (1 << 5) | 1;

const encoder = new TextEncoder();

/** What a file adds to an archive besides its data: the two headers, each with the name. */
export function zipEntryOverhead(name: string): number {
  const length = encoder.encode(name).length;
  return LOCAL_HEADER + length + CENTRAL_HEADER + length;
}

/** The size of an archive of entries with these names and sizes, before building it. */
export function zipSize(entries: ReadonlyArray<{ name: string; size: number }>): number {
  return END_RECORD + entries.reduce((total, entry) => total + zipEntryOverhead(entry.name) + entry.size, 0);
}

/** Makes an entry name safe inside an archive: no folders, no characters a file system refuses, at most 120 characters. */
export function zipName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return Array.from(cleaned).slice(0, 120).join('') || 'file';
}

/** The archive holding these files, in this order. */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > 0xfffe) throw new Error('too many files for one archive');
  const out = new Uint8Array(zipSize(entries.map((entry) => ({ name: entry.name, size: entry.data.length }))));
  const view = new DataView(out.buffer);
  let at = 0;
  const central: Array<{ name: Uint8Array; crc: number; size: number; offset: number }> = [];

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    if (entry.data.length > 0xfffffffe || at > 0xfffffffe) throw new Error('the archive is too big');
    central.push({ name, crc, size: entry.data.length, offset: at });
    view.setUint32(at, 0x04034b50, true); // local file header
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, UTF8_NAMES, true);
    view.setUint16(at + 8, 0, true); // stored
    view.setUint16(at + 10, 0, true); // time
    view.setUint16(at + 12, DOS_DATE_1980, true);
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, entry.data.length, true);
    view.setUint32(at + 22, entry.data.length, true);
    view.setUint16(at + 26, name.length, true);
    view.setUint16(at + 28, 0, true); // no extra field
    out.set(name, at + LOCAL_HEADER);
    out.set(entry.data, at + LOCAL_HEADER + name.length);
    at += LOCAL_HEADER + name.length + entry.data.length;
  }

  const centralStart = at;
  for (const entry of central) {
    view.setUint32(at, 0x02014b50, true); // central directory header
    view.setUint16(at + 4, VERSION, true); // made by
    view.setUint16(at + 6, VERSION, true); // needed to extract
    view.setUint16(at + 8, UTF8_NAMES, true);
    view.setUint16(at + 10, 0, true); // stored
    view.setUint16(at + 12, 0, true);
    view.setUint16(at + 14, DOS_DATE_1980, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.size, true);
    view.setUint32(at + 24, entry.size, true);
    view.setUint16(at + 28, entry.name.length, true);
    // extra field, comment, disk number, internal and external attributes: all zero
    view.setUint32(at + 42, entry.offset, true);
    out.set(entry.name, at + CENTRAL_HEADER);
    at += CENTRAL_HEADER + entry.name.length;
  }

  view.setUint32(at, 0x06054b50, true); // end of central directory
  view.setUint16(at + 8, central.length, true);
  view.setUint16(at + 10, central.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}
