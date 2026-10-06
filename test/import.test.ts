import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseCsv, tracksFromCsv, tracksFromJson } from '../src/import.ts';

describe('parseCsv', () => {
  test('handles quotes, escaped quotes, commas and newlines inside fields', () => {
    const csv = 'a,b\n"x, y","say ""hi"""\n"line\nbreak",z\n';
    assert.deepEqual(parseCsv(csv), [
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['line\nbreak', 'z'],
    ]);
  });

  test('accepts CRLF, a BOM and blank lines, and does not need a trailing newline', () => {
    assert.deepEqual(parseCsv('﻿a,b\r\n\r\n1,2'), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('treats a quote in the middle of a field as an ordinary character', () => {
    assert.deepEqual(parseCsv('5" single,x'), [['5" single', 'x']]);
  });
});

describe('tracksFromCsv', () => {
  test('reads columns by header name, in any order, case-insensitively', () => {
    const rows = tracksFromCsv('URL,Title,Artist\nhttps://x.test/a.mp3,Song A,Band A\nhttps://x.test/b.mp3,Song B,\n');
    assert.deepEqual(rows, [
      { title: 'Song A', artist: 'Band A', url: 'https://x.test/a.mp3' },
      { title: 'Song B', artist: '', url: 'https://x.test/b.mp3' },
    ]);
  });

  test('artist column is optional', () => {
    assert.deepEqual(tracksFromCsv('title,url\nSong,https://x.test/a.mp3'), [
      { title: 'Song', artist: '', url: 'https://x.test/a.mp3' },
    ]);
  });

  test('explains a missing required column', () => {
    assert.throws(() => tracksFromCsv('name,link\nA,B'), /title,url/);
  });

  test('an empty file yields no rows', () => {
    assert.deepEqual(tracksFromCsv(''), []);
  });
});

describe('tracksFromJson', () => {
  test('reads an array of objects', () => {
    assert.deepEqual(tracksFromJson('[{"title":"A","artist":"B","url":"https://x.test/a.mp3"},{"title":"C","url":"u"}]'), [
      { title: 'A', artist: 'B', url: 'https://x.test/a.mp3' },
      { title: 'C', artist: '', url: 'u' },
    ]);
  });

  test('rejects anything that is not an array', () => {
    assert.throws(() => tracksFromJson('{"title":"A"}'), /array/);
  });
});
