import type { NewTrack } from './catalog.ts';

/** Minimal RFC 4180 parser: quoted fields, "" escapes, CRLF or LF, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');

  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((value) => value.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (src[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
  }
  endRow();
  return rows;
}

export function tracksFromCsv(text: string): NewTrack[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const columns = header.map((name) => name.trim().toLowerCase());
  const titleAt = columns.indexOf('title');
  const urlAt = columns.indexOf('url');
  const artistAt = columns.indexOf('artist');
  if (titleAt < 0 || urlAt < 0) {
    throw new Error('CSV needs a header row with at least the columns title,url (artist is optional)');
  }
  return rows.map((row) => ({
    title: row[titleAt] ?? '',
    artist: artistAt >= 0 ? (row[artistAt] ?? '') : '',
    url: row[urlAt] ?? '',
  }));
}

export function tracksFromJson(text: string): NewTrack[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('JSON must be an array of { title, artist, url } objects');
  return data.map((item: unknown) => {
    const o = (item ?? {}) as Record<string, unknown>;
    return { title: String(o.title ?? ''), artist: String(o.artist ?? ''), url: String(o.url ?? '') };
  });
}
