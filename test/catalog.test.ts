import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { Catalog } from '../src/catalog.ts';
import type { Track } from '../src/types.ts';
import { SAMPLE } from './helpers/sample.ts';

const titles = (tracks: Track[]) => tracks.map((track) => track.title);

function seeded(): Catalog {
  const catalog = new Catalog(':memory:');
  for (const track of SAMPLE) catalog.add(track);
  return catalog;
}

describe('Catalog.add', () => {
  test('stores a track and updates it when the same URL is added again', () => {
    const catalog = new Catalog(':memory:');
    const first = catalog.add(SAMPLE[0]);
    assert.deepEqual(first, { id: 1, ...SAMPLE[0] });

    const updated = catalog.add({ ...SAMPLE[0], title: 'Red Sunrise' });
    assert.equal(updated.id, first.id);
    assert.equal(catalog.count(), 1);
    assert.deepEqual(titles(catalog.search('sunrise')), ['Red Sunrise']);
    assert.deepEqual(catalog.search('blue'), [], 'the old title must leave the search index');
  });

  test('rejects blank titles and URLs that are not http(s)', () => {
    const catalog = new Catalog(':memory:');
    assert.throws(() => catalog.add({ title: '  ', url: 'https://x.test/a.mp3' }), /title is required/);
    assert.throws(() => catalog.add({ title: 'A', url: 'not a url' }), /not a valid URL/);
    assert.throws(() => catalog.add({ title: 'A', url: 'ftp://x.test/a.mp3' }), /http/);
    assert.equal(catalog.count(), 0);
  });

  test('artist is optional', () => {
    const catalog = new Catalog(':memory:');
    assert.equal(catalog.add({ title: 'Untitled Jam', url: 'https://x.test/jam.mp3' }).artist, '');
  });
});

describe('Catalog.search', () => {
  test('matches title words, artist words and "title by artist"', () => {
    const catalog = seeded();
    assert.deepEqual(titles(catalog.search('paper planes')), ['Paper Planes at Dawn']);
    assert.deepEqual(titles(catalog.search('mira vale')), ['Paper Planes at Dawn']);
    assert.deepEqual(titles(catalog.search('paper planes by mira vale')), ['Paper Planes at Dawn']);
  });

  test('matches word prefixes and ignores case', () => {
    assert.deepEqual(titles(seeded().search('PAP pla')), ['Paper Planes at Dawn']);
  });

  test('ignores accents in both directions', () => {
    const catalog = seeded();
    for (const query of ['ocean sombre', 'Océan', 'lea marchand', 'Léa']) {
      assert.deepEqual(titles(catalog.search(query)), ['Océan Sombre'], query);
    }
  });

  test('ranks title matches above artist-only matches', () => {
    const found = seeded().search('night');
    assert.equal(found.length, 3);
    assert.equal(found[0]?.title, 'Night Train');
  });

  test('puts the shorter title first when words tie', () => {
    assert.deepEqual(titles(seeded().search('blue horizon')), ['Blue Horizon', 'Blue Horizon (Live)']);
  });

  test('when no song has every word as typed, looks again more loosely: apostrophes left out, a typo in a long word', () => {
    const catalog = seeded();
    catalog.add({ title: 'V’Nusni', artist: 'Lipa Schmeltzer', url: 'https://cdn.example.test/vnusni.mp3' });
    for (const query of ['lipa vnusni', 'vnusni', 'lipa shmeltzer vnusni', "v'nusni"]) {
      assert.deepEqual(titles(catalog.search(query)), ['V’Nusni'], query);
    }
    assert.deepEqual(titles(catalog.search('paper plaens')), ['Paper Planes at Dawn']);
  });

  test('understands a leading "play" or "send me"', () => {
    const catalog = seeded();
    assert.deepEqual(titles(catalog.search('play paper planes')), ['Paper Planes at Dawn']);
    assert.deepEqual(titles(catalog.search('Send me mira vale')), ['Paper Planes at Dawn']);
  });

  test('returns nothing for blank or meaningless queries', () => {
    const catalog = seeded();
    for (const query of ['', '   ', '!!!', 'play', 'zzzzzz']) assert.deepEqual(catalog.search(query), [], query);
  });

  test('respects the limit', () => {
    assert.equal(seeded().search('blue', 1).length, 1);
  });

  test('survives search operators and SQL in the query', () => {
    const catalog = seeded();
    for (const query of ['"; DROP TABLE tracks; --', 'NEAR(', '* OR 1', 'a" OR "b', '(((', 'title:blue']) {
      assert.doesNotThrow(() => catalog.search(query), query);
    }
    assert.equal(catalog.count(), SAMPLE.length);
  });
});

describe('Catalog.remove', () => {
  test('removes the track from lookups and from search', () => {
    const catalog = seeded();
    const [train] = catalog.search('night train');
    assert.ok(train);
    assert.equal(catalog.remove(train.id), true);
    assert.equal(catalog.get(train.id), undefined);
    assert.deepEqual(catalog.search('train'), []);
    assert.equal(catalog.remove(train.id), false);
  });
});

describe('Catalog persistence', () => {
  test('creates the folder, survives a restart and keeps search working', () => {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
    try {
      const path = join(dir, 'nested', 'catalog.db');
      const first = new Catalog(path);
      first.add(SAMPLE[2]);
      first.close();

      const second = new Catalog(path);
      assert.equal(second.count(), 1);
      assert.deepEqual(titles(second.search('paper')), ['Paper Planes at Dawn']);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
