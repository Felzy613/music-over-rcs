import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { crc32 } from 'node:zlib';
import { createZip, zipEntryOverhead, zipName, zipSize } from '../src/library/zip.ts';
import { readZip } from './helpers/read-zip.ts';

describe('zip', () => {
  const files = [
    { name: '01 First.m4a', data: Uint8Array.from({ length: 5000 }, (_, i) => i % 251) },
    { name: '02 הנחת תפילין.m4a', data: new TextEncoder().encode('שלום') },
    { name: '03 Empty.m4a', data: new Uint8Array() },
  ];

  test('holds every file as it is, in order, with the right checksums and UTF-8 names', () => {
    const entries = readZip(createZip(files));
    assert.deepEqual(entries.map((entry) => entry.name), files.map((file) => file.name));
    entries.forEach((entry, i) => {
      assert.deepEqual(entry.data, files[i]!.data);
      assert.equal(entry.crc, crc32(files[i]!.data));
    });
  });

  test('its size is known before it is built', () => {
    const zip = createZip(files);
    assert.equal(zip.length, zipSize(files.map((file) => ({ name: file.name, size: file.data.length }))));
    assert.equal(zipEntryOverhead('abc'), 30 + 3 + 46 + 3);
    assert.equal(createZip([]).length, 22);
  });

  test('is a real archive: the system unzip accepts it and extracts the same bytes', (t) => {
    let unzip = '';
    try {
      unzip = execFileSync('which', ['unzip'], { encoding: 'utf8' }).trim();
    } catch {
      return t.skip('no unzip on this machine');
    }
    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    try {
      // Info-ZIP's unzip can't create a non-ASCII file name in a plain locale, which is its limit, not the archive's.
      const archive = join(dir, 'album.zip');
      writeFileSync(archive, createZip([files[0]!, files[2]!]));
      execFileSync(unzip, ['-tq', archive]);
      execFileSync(unzip, ['-qo', archive, '-d', join(dir, 'out')]);
      assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'out', '01 First.m4a'))), files[0]!.data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Hebrew names come out right in the extractor macOS itself uses', (t) => {
    if (process.platform !== 'darwin') return t.skip('ditto is macOS only');
    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    try {
      const archive = join(dir, 'album.zip');
      writeFileSync(archive, createZip([files[1]!]));
      execFileSync('ditto', ['-x', '-k', archive, join(dir, 'out')]);
      assert.deepEqual(new Uint8Array(readFileSync(join(dir, 'out', files[1]!.name))), files[1]!.data);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('zipName keeps a title usable as a file name', () => {
    assert.equal(zipName('AC/DC: Back In Black?'), 'AC_DC_ Back In Black_');
    assert.equal(zipName('  ..hidden..  '), 'hidden');
    assert.equal(zipName('///'), '_');
    assert.equal(zipName(''), 'file');
    assert.equal(Array.from(zipName('א'.repeat(300))).length, 120);
  });
});
