import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { createBot } from '../src/bot.ts';
import { Catalog, linksIn, viewsIn } from '../src/catalog.ts';
import { OWNER, personOf, scoped } from '../src/people.ts';
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

describe('Catalog.importFrom', () => {
  function withFile<T>(run: (path: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'catalog-import-'));
    try {
      return run(join(dir, 'old.db'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function oldCatalog(path: string): void {
    const old = new Catalog(path);
    for (const track of SAMPLE) old.add(track);
    old.recordPlay(2, new Date('2026-10-05T12:00:00Z'));
    old.recordPlay(2, new Date('2026-10-06T12:00:00Z'));
    old.follow(old.trackArtists(2)[0]!.id);
    old.savePost({ slug: 'a-post', title: 'A post', category: 'Singles', publishedAt: '2026-10-04T00:00:00Z', views: 7, audioFiles: 1 });
    old.setState('digest.last_date', '2026-10-06');
    old.setState('chat.choices', '{"stale":true}');
    old.setState('health.problems', '[{"key":"bridge"}]');
    old.setState('matrix.token', 'secret');
    old.linkMessage('$old-event', 'play:1');
    old.close();
  }

  test('carries songs, plays, follows, posts and the daily-message state over, with the same ids', () => {
    withFile((path) => {
      oldCatalog(path);
      const fresh = new Catalog(':memory:');
      const counts = fresh.importFrom(path);
      assert.equal(counts.tracks, SAMPLE.length);
      assert.equal(counts.plays, 2);
      assert.equal(counts.follows, 1);
      assert.equal(counts.posts, 1);
      assert.equal(fresh.count(), SAMPLE.length);
      assert.equal(fresh.get(2)?.title, SAMPLE[1].title, 'ids are kept');
      assert.deepEqual(fresh.mostPlayed(1).map((track) => [track.id, track.plays]), [[2, 2]]);
      assert.equal(fresh.followed().length, 1);
      assert.equal(fresh.sitePost('a-post')?.views, 7);
      assert.equal(fresh.getState('digest.last_date'), '2026-10-06');
      assert.deepEqual(titles(fresh.search(SAMPLE[0].title.split(' ')[0]!)).includes(SAMPLE[0].title), true, 'the search index was rebuilt by the import');
      fresh.close();
    });
  });

  test('leaves behind what belongs to the old chat and what is wrong right now', () => {
    withFile((path) => {
      oldCatalog(path);
      const fresh = new Catalog(':memory:');
      fresh.importFrom(path);
      assert.equal(fresh.getState('chat.choices'), undefined);
      assert.equal(fresh.getState('health.problems'), undefined);
      assert.equal(fresh.getState('matrix.token'), undefined);
      assert.equal(fresh.linkedPostback('$old-event'), undefined);
      fresh.close();
    });
  });

  test('refuses a catalog that already has songs, plays or follows, and changes nothing', () => {
    withFile((path) => {
      oldCatalog(path);
      const busy = new Catalog(':memory:');
      busy.add(SAMPLE[0]);
      assert.throws(() => busy.importFrom(path), /only be imported into an empty one/);
      assert.equal(busy.count(), 1);
      busy.close();
    });
  });

  test('a file that is not a catalog fails cleanly and leaves the target usable', () => {
    withFile((path) => {
      writeFileSync(path, 'this is not a database');
      const fresh = new Catalog(':memory:');
      assert.throws(() => fresh.importFrom(path));
      assert.equal(fresh.isEmpty(), true);
      fresh.add(SAMPLE[0]);
      assert.equal(fresh.count(), 1, 'the target still works');
      fresh.close();
    });
  });
});

describe('the chat’s views', () => {
  test('are kept with what they showed and which is current, across a reopen of the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'views-'));
    try {
      const path = join(dir, 'catalog.db');
      const first = new Catalog(path);
      const views = viewsIn(first);
      const menu = views.open({ kind: 'search', query: 'achas' });
      const album = views.open({ kind: 'album', albumId: 'MPREb_x', title: 'Achas' }, menu.id);
      menu.shown.push({ kind: 'song', id: 'abc', postback: 'play:1', label: 'Achas' });
      menu.lastMore = 'songs';
      views.save(menu);
      views.setCurrent(album.id);
      first.close();

      const again = viewsIn(new Catalog(path));
      assert.deepEqual(again.current(), { id: album.id, parent: menu.id, key: { kind: 'album', albumId: 'MPREb_x', title: 'Achas' }, shown: [] });
      assert.deepEqual(again.get(menu.id), { id: menu.id, key: { kind: 'search', query: 'achas' }, shown: [{ kind: 'song', id: 'abc', postback: 'play:1', label: 'Achas' }], lastMore: 'songs' });
      again.setCurrent(undefined);
      assert.equal(again.current(), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a month unused, or past the newest 300, they are cleared out when a new one is opened', () => {
    const catalog = new Catalog(':memory:');
    const old = catalog.openView({ kind: 'search', query: 'old' }, undefined, new Date('2026-08-01T00:00:00Z'));
    const kept = catalog.openView({ kind: 'search', query: 'kept' }, undefined, new Date('2026-10-01T00:00:00Z'));
    catalog.openView({ kind: 'search', query: 'new' }, undefined, new Date('2026-10-20T00:00:00Z'));
    assert.equal(catalog.view(old.id), undefined);
    assert.ok(catalog.view(kept.id));
    for (let i = 0; i < 305; i += 1) catalog.openView({ kind: 'search', query: `q${i}` }, undefined, new Date('2026-10-20T00:00:00Z'));
    assert.equal(catalog.view(kept.id), undefined, 'only the newest 300 are kept');
  });
});

describe('each person\'s views and message links', () => {
  const alice = personOf('alice');
  const bob = personOf('bob');
  const when = (day: number) => new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`);

  test('a view of one chat is not found by another, which can neither read, save nor touch it', () => {
    const catalog = new Catalog(':memory:');
    const mine = catalog.openView({ kind: 'search', query: 'mine' }, undefined, when(1));
    const hers = catalog.openView({ kind: 'search', query: 'hers' }, undefined, when(2), alice.chat);
    assert.ok(mine.id < hers.id, 'ids are one sequence for every chat');

    assert.deepEqual(catalog.view(mine.id), mine);
    assert.equal(catalog.view(hers.id), undefined, 'the owner does not see hers');
    assert.deepEqual(catalog.view(hers.id, 'alice'), hers);
    assert.equal(catalog.view(mine.id, 'alice'), undefined, 'she does not see the owner\'s');
    assert.equal(catalog.view(hers.id, 'bob'), undefined);

    // Saving or touching by another chat changes nothing.
    catalog.saveView({ ...hers, shown: [{ kind: 'song', id: 'x', postback: 'play:1', label: 'X' }] }, when(5));
    catalog.saveView({ ...mine, lastMore: 'songs' }, when(5), 'alice');
    catalog.touchView(hers.id, when(9));
    catalog.touchView(mine.id, when(9), 'bob');
    assert.deepEqual(catalog.view(hers.id, 'alice'), hers);
    assert.deepEqual(catalog.view(mine.id), mine);
    assert.deepEqual(catalog.recentViews(5, 'alice').map((v) => v.usedAt), [when(2).toISOString()]);
    assert.deepEqual(catalog.recentViews(5).map((v) => v.usedAt), [when(1).toISOString()]);

    // Their own chat can.
    const shown = [{ kind: 'song' as const, id: 'x', postback: 'play:1', label: 'X' }];
    catalog.saveView({ ...hers, shown }, when(6), 'alice');
    assert.deepEqual(catalog.view(hers.id, 'alice')?.shown, shown);
    catalog.touchView(hers.id, when(7), 'alice');
    assert.equal(catalog.recentViews(5, 'alice')[0]?.usedAt, when(7).toISOString());
  });

  test('a store belongs to one chat: its views and its current one are not shared', () => {
    const catalog = new Catalog(':memory:');
    const owners = viewsIn(catalog);
    const hers = viewsIn(catalog, scoped('chat.view', alice), alice.chat);
    const his = viewsIn(catalog, scoped('chat.view', bob), bob.chat);

    const menu = owners.open({ kind: 'search', query: 'achas' });
    const album = hers.open({ kind: 'album', albumId: 'MPREb_x', title: 'Achas' });
    owners.setCurrent(menu.id);
    hers.setCurrent(album.id);
    assert.deepEqual(owners.current(), menu);
    assert.deepEqual(hers.current(), album);
    assert.equal(his.current(), undefined, 'a third chat has none');
    assert.equal(owners.get(album.id), undefined);
    assert.equal(hers.get(menu.id), undefined);
    assert.equal(his.get(menu.id), undefined);
    assert.equal(catalog.getState('chat.view'), String(menu.id), 'the owner\'s pointer is the legacy key');
    assert.equal(catalog.getState('chat.view:alice'), String(album.id));

    // Pointed at another chat's view (a stale or copied number), a chat finds nothing and keeps nothing of it.
    hers.setCurrent(menu.id);
    assert.equal(hers.current(), undefined);
    his.setCurrent(album.id);
    assert.equal(his.current(), undefined);
    his.save({ ...album, lastMore: 'songs' });
    assert.equal(hers.get(album.id)?.lastMore, undefined);
    hers.setCurrent(undefined);
    assert.equal(hers.current(), undefined);
    assert.deepEqual(owners.current(), menu, 'and the owner\'s is untouched');
  });

  test('each chat keeps its newest 300, and no chat\'s opening clears another\'s', () => {
    const catalog = new Catalog(':memory:');
    const first = catalog.openView({ kind: 'search', query: 'owner first' }, undefined, when(1));
    const hers = catalog.openView({ kind: 'search', query: 'hers first' }, undefined, when(1), 'alice');
    for (let i = 0; i < 305; i += 1) catalog.openView({ kind: 'search', query: `a${i}` }, undefined, when(2), 'alice');
    assert.equal(catalog.view(hers.id, 'alice'), undefined, 'hers past the newest 300 are cleared');
    assert.ok(catalog.view(first.id), 'the owner\'s survived her flood');
    assert.equal(catalog.tableCounts().views, 301, 'her 300 and his 1');

    for (let i = 0; i < 305; i += 1) catalog.openView({ kind: 'search', query: `o${i}` }, undefined, when(3));
    assert.equal(catalog.view(first.id), undefined, 'the owner\'s are cleared by the owner\'s own');
    assert.equal(catalog.tableCounts().views, 600);
    assert.equal(catalog.recentViews(100, 'alice').length, 100);
    assert.equal(catalog.recentViews(100, 'alice')[0]?.key, JSON.stringify({ kind: 'search', query: 'a304' }));
    assert.equal(catalog.recentViews(1)[0]?.key, JSON.stringify({ kind: 'search', query: 'o304' }));
  });

  test('a person\'s views are cleared after a month unused, like the owner\'s', () => {
    const catalog = new Catalog(':memory:');
    const old = catalog.openView({ kind: 'search', query: 'old' }, undefined, new Date('2026-08-01T00:00:00Z'), 'alice');
    const kept = catalog.openView({ kind: 'search', query: 'kept' }, undefined, new Date('2026-10-01T00:00:00Z'), 'alice');
    catalog.openView({ kind: 'search', query: 'new' }, undefined, new Date('2026-10-20T00:00:00Z'), 'alice');
    assert.equal(catalog.view(old.id, 'alice'), undefined);
    assert.ok(catalog.view(kept.id, 'alice'));
  });

  test('a bot over one person\'s views says another\'s list is gone, and the owner\'s still works', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Sunrise Song', artist: 'Band One', url: 'https://x.test/a.mp3' });
    const botFor = (person: typeof OWNER) =>
      createBot({ catalog, checkAudio: async () => ({ ok: true, type: 'audio/mpeg' }), views: viewsIn(catalog, scoped('chat.view', person), person.chat) });
    const ask = (person: typeof OWNER, text: string) => botFor(person).handle({ from: 'me', messageId: 'm', text });
    const tap = (person: typeof OWNER, postback: string) => botFor(person).handle({ from: 'me', messageId: 'm', postback });

    const menu = await ask(OWNER, 'search sunrise');
    const hint = menu.find((reply) => reply.kind === 'text' && reply.postback?.startsWith('view:'));
    assert.ok(hint && hint.kind === 'text' && hint.postback);
    assert.deepEqual(await tap(alice, hint.postback), [{ kind: 'text', text: 'That list is gone; text "search" and a song to start again.' }]);
    const back = await tap(OWNER, hint.postback);
    assert.match(JSON.stringify(back), /Back to/);

    // The same search by her is a view of her own, with an id that is not the owner's.
    const hers = await ask(alice, 'search sunrise');
    const herHint = hers.find((reply) => reply.kind === 'text' && reply.postback?.startsWith('view:'));
    assert.ok(herHint && herHint.kind === 'text' && herHint.postback);
    assert.notEqual(herHint.postback, hint.postback);
    assert.match(JSON.stringify(await tap(alice, herHint.postback)), /Back to/);
    assert.deepEqual(await tap(bob, herHint.postback), [{ kind: 'text', text: 'That list is gone; text "search" and a song to start again.' }]);
  });

  test('only the text a message said is kept per person; a message\'s id is kept as it is', () => {
    const catalog = new Catalog(':memory:');
    const owner = linksIn(catalog);
    const hers = linksIn(catalog, 'alice');
    const his = linksIn(catalog, 'bob');
    const same = 'text:🎵 Sunrise Song — Band One';

    owner.link(same, 'play:1@10');
    hers.link(same, 'play:1@20');
    his.link(same, 'play:1@30');
    assert.equal(owner.lookup(same), 'play:1@10');
    assert.equal(hers.lookup(same), 'play:1@20');
    assert.equal(his.lookup(same), 'play:1@30');
    assert.equal(catalog.linkedPostback(same), 'play:1@10', 'the owner\'s key is the one it always was');
    assert.equal(catalog.linkedPostback('text:alice:🎵 Sunrise Song — Band One'), undefined);
    assert.equal(linksIn(catalog, 'carol').lookup(same), undefined, 'a third person was shown nothing');

    // An event id belongs to one room, so it is stored and found as it is, whoever asks.
    hers.link('$ev1', 'play:2@21');
    assert.equal(catalog.linkedPostback('$ev1'), 'play:2@21');
    assert.equal(owner.lookup('$ev1'), 'play:2@21');
    owner.link('$ev2', 'play:3@11');
    assert.equal(his.lookup('$ev2'), 'play:3@11');
  });

  test('a person\'s text key cannot be made by the owner\'s', () => {
    const catalog = new Catalog(':memory:');
    const owner = linksIn(catalog);
    const hers = linksIn(catalog, 'alice');
    hers.link('text:x', 'play:1@20');
    // The runner makes every owner key by putting "text:" before the message's words, so these are the only shapes it makes.
    for (const words of ['x', 'alice:x', '@alice:x', 'text@alice:x']) assert.equal(owner.lookup(`text:${words}`), undefined, words);
    assert.equal(catalog.linkedPostback('text@alice:x'), 'play:1@20');
  });
});

describe('the chat column of the views table', () => {
  function withDir<T>(run: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'views-chat-'));
    try {
      return run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The views table as it was before people: no chat column. A row in it, and the rest of the catalog not yet made. */
  function oldShaped(path: string): void {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE views (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        parent    INTEGER,
        kind      TEXT NOT NULL,
        key       TEXT NOT NULL,
        shown     TEXT NOT NULL DEFAULT '[]',
        last_more TEXT,
        at        TEXT NOT NULL,
        used_at   TEXT NOT NULL
      );
      INSERT INTO views (parent, kind, key, shown, at, used_at) VALUES (NULL, 'search', '{"kind":"search","query":"old"}', '[]', '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z');
    `);
    db.close();
  }

  const columnsOf = (path: string): Array<{ name: string; dflt_value: string | null; notnull: number }> => {
    const db = new DatabaseSync(path);
    try {
      return db.prepare('PRAGMA table_info(views)').all() as never;
    } finally {
      db.close();
    }
  };

  test('is added to a database made without it, and what was there becomes the owner\'s', () => {
    withDir((dir) => {
      const path = join(dir, 'catalog.db');
      oldShaped(path);
      assert.ok(!columnsOf(path).some((column) => column.name === 'chat'));

      const catalog = new Catalog(path);
      const chat = columnsOf(path).find((column) => column.name === 'chat');
      assert.ok(chat, 'added');
      assert.equal(chat.notnull, 1);
      assert.equal(chat.dflt_value, "''");
      assert.deepEqual(catalog.view(1), { id: 1, key: { kind: 'search', query: 'old' }, shown: [] });
      assert.equal(catalog.view(1, 'alice'), undefined);
      assert.equal(catalog.recentViews(5).length, 1);
      assert.equal(catalog.recentViews(5, 'alice').length, 0);
      const next = catalog.openView({ kind: 'search', query: 'new' }, undefined);
      assert.equal(next.id, 2, 'the numbers go on');
      catalog.close();
    });
  });

  test('opening the same file again, or a second connection at once, changes nothing and does not fail', () => {
    withDir((dir) => {
      const path = join(dir, 'catalog.db');
      oldShaped(path);
      const first = new Catalog(path);
      const second = new Catalog(path);
      const mine = first.openView({ kind: 'search', query: 'a' }, undefined);
      const hers = second.openView({ kind: 'search', query: 'b' }, undefined, new Date(), 'alice');
      assert.deepEqual(second.view(mine.id)?.key, { kind: 'search', query: 'a' }, 'one connection sees the other\'s');
      assert.deepEqual(first.view(hers.id, 'alice')?.key, { kind: 'search', query: 'b' });
      assert.equal(first.view(hers.id), undefined);
      first.close();
      second.close();
      const third = new Catalog(path);
      assert.equal(columnsOf(path).filter((column) => column.name === 'chat').length, 1);
      assert.equal(third.tableCounts().views, 3);
      third.close();
    });
  });

  test('a program that does not know the column (an older release, after a rollback) still adds views, which are the owner\'s', () => {
    withDir((dir) => {
      const path = join(dir, 'catalog.db');
      new Catalog(path).close();
      const db = new DatabaseSync(path);
      db.prepare("INSERT INTO views (parent, kind, key, shown, at, used_at) VALUES (NULL, 'search', '{\"kind\":\"search\",\"query\":\"older\"}', '[]', ?, ?)").run('2026-10-21T00:00:00.000Z', '2026-10-21T00:00:00.000Z');
      db.close();
      const catalog = new Catalog(path);
      assert.deepEqual(catalog.view(1)?.key, { kind: 'search', query: 'older' });
      assert.equal(catalog.view(1, 'alice'), undefined);
      catalog.close();
    });
  });

  test('a fresh catalog has the column too, and a view made the old way is the owner\'s', () => {
    withDir((dir) => {
      const path = join(dir, 'catalog.db');
      const catalog = new Catalog(path);
      const view = catalog.openView({ kind: 'list', page: { kind: 'new' } } as never, undefined);
      assert.deepEqual(catalog.view(view.id), view);
      assert.ok(columnsOf(path).some((column) => column.name === 'chat'));
      const raw = new DatabaseSync(path);
      assert.equal(raw.prepare('SELECT chat FROM views WHERE id = ?').get(view.id)?.chat, '', 'the owner\'s rows carry the empty chat');
      raw.close();
      catalog.close();
    });
  });
});
