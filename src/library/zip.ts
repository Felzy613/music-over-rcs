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

/** An entry's local header: what comes just before its data. */
function localHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const out = new Uint8Array(LOCAL_HEADER + name.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x04034b50, true); // local file header
  view.setUint16(4, VERSION, true);
  view.setUint16(6, UTF8_NAMES, true);
  view.setUint16(8, 0, true); // stored
  view.setUint16(10, 0, true); // time
  view.setUint16(12, DOS_DATE_1980, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true); // no extra field
  out.set(name, LOCAL_HEADER);
  return out;
}

/** The central directory and the end record that close an archive whose entries start at `start` (the directory's offset). */
function directory(entries: ReadonlyArray<{ name: Uint8Array; crc: number; size: number; offset: number }>, start: number): Uint8Array {
  const length = entries.reduce((total, entry) => total + CENTRAL_HEADER + entry.name.length, 0);
  const out = new Uint8Array(length + END_RECORD);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const entry of entries) {
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
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, length, true);
  view.setUint32(at + 16, start, true);
  return out;
}

/** The headers and the directory for files of these names, checksums and sizes, in order. */
function layout(entries: ReadonlyArray<{ name: string; crc: number; size: number }>): { headers: Uint8Array[]; directory: Uint8Array } {
  if (entries.length > 0xfffe) throw new Error('too many files for one archive');
  const placed: Array<{ name: Uint8Array; crc: number; size: number; offset: number }> = [];
  const headers: Uint8Array[] = [];
  let at = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    if (entry.size > 0xfffffffe || at > 0xfffffffe) throw new Error('the archive is too big');
    placed.push({ name, crc: entry.crc, size: entry.size, offset: at });
    const header = localHeader(name, entry.crc, entry.size);
    headers.push(header);
    at += header.length + entry.size;
  }
  return { headers, directory: directory(placed, at) };
}

/** The archive holding these files, in this order. */
export function createZip(entries: readonly ZipEntry[]): Uint8Array {
  const { headers, directory: end } = layout(entries.map((entry) => ({ name: entry.name, crc: crc32(entry.data), size: entry.data.length })));
  const out = new Uint8Array(zipSize(entries.map((entry) => ({ name: entry.name, size: entry.data.length }))));
  let at = 0;
  entries.forEach((entry, i) => {
    out.set(headers[i]!, at);
    at += headers[i]!.length;
    out.set(entry.data, at);
    at += entry.data.length;
  });
  out.set(end, at);
  return out;
}

/** The CRC-32 a ZIP keeps for a file, read a chunk at a time, so the file is never copied whole. */
export async function blobCrc32(blob: Blob): Promise<number> {
  let crc = 0;
  for await (const chunk of blob.stream() as unknown as AsyncIterable<Uint8Array>) crc = crc32(chunk, crc);
  return crc;
}

/**
 * The same archive as `createZip`, made of the files as they are: the Blob it returns refers to them rather than copying
 * them into one buffer, which matters on a small host where a part of an album is tens of megabytes. Each entry brings
 * its checksum (`blobCrc32`), worked out when the file arrived.
 */
export function zipBlob(entries: ReadonlyArray<{ name: string; data: Blob; crc: number }>): Blob {
  const { headers, directory: end } = layout(entries.map((entry) => ({ name: entry.name, crc: entry.crc, size: entry.data.size })));
  return new Blob([...entries.flatMap((entry, i) => [headers[i]!, entry.data]), end] as unknown as ConstructorParameters<typeof Blob>[0], { type: 'application/zip' });
}
