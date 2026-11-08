import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, test } from 'node:test';
import type { DownloadedAudio } from '../src/audio-fetch.ts';
import type { Drive } from '../src/archive/archiver.ts';
import { Catalog, type NewRelease } from '../src/catalog.ts';
import { DIGEST_STAGGER_MINUTES, LibraryJobs, localDay, STATE } from '../src/library/jobs.ts';
import { setUpLibrary } from '../src/library/setup.ts';
import { OWNER, personOf } from '../src/people.ts';
import { MusicTable } from '../src/sources/music-table.ts';
import type { NewReleases } from '../src/sources/zemer-releases.ts';
import type { Reply } from '../src/types.ts';
import { startMockMusicTable, type MockMusicTable } from './helpers/mock-music-table.ts';

// The background work for more than one person: each is sent the daily message and the alerts for the artists they follow through
// their own chat, at their own time, with their own marks, while the sync and the feeds are read once for everyone.

/** A time on a day in October 2026, in this machine's time zone (the schedule works in local time). */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute);
const iso = (date: Date) => date.toISOString();
const texts = (replies: Reply[]) => replies.flatMap((reply) => (reply.kind === 'text' ? [reply.text] : []));
/** The songs a daily message lists, by title, in the order listed. */
const songsIn = (replies: Reply[]) => texts(replies).filter((line) => line.endsWith(' · single')).map((line) => line.replace(/ — .*$/, ''));
const HOUR_MS = 60 * 60_000;

const ALICE = personOf('alice');
const BOB = personOf('bob');

type Who = 'owner' | 'alice' | 'bob';

describe('library jobs: more than one chat', () => {
  let site: MockMusicTable | undefined;
  let catalog: Catalog;
  let table: MusicTable;
  let dir: string | undefined;
  afterEach(async () => {
    try {
      catalog?.close();
    } finally {
      await site?.close();
      site = undefined;
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function setUp(options: { digestAt?: { hour: number; minute: number } | undefined; quiet?: { from: { hour: number; minute: number }; to: { hour: number; minute: number } }; owner?: boolean; releases?: NewReleases } = {}) {
    site = await startMockMusicTable([]);
    table = new MusicTable({ baseUrl: site.url, minIntervalMs: 0 });
    catalog = new Catalog(':memory:');
    // The whole-site scan has its own tests; the site here has nothing on it, so the posts below are only the catalog's.
    catalog.setState(STATE.scanDone, iso(at(1, 0)));
    let clock = at(6, 8);
    const sent: Record<Who, Reply[][]> = { owner: [], alice: [], bob: [] };
    const failing = new Set<Who>();
    const logs: string[] = [];
    const reach =
      (who: Who) =>
      async (replies: Reply[]): Promise<void> => {
        if (failing.has(who)) throw new Error(`${who}'s chat is unreachable`);
        sent[who].push(replies);
      };
    const jobs = new LibraryJobs({
      musicTable: table,
      catalog,
      ...(options.owner === false ? {} : { announce: reach('owner') }),
      digestAt: 'digestAt' in options ? options.digestAt : { hour: 9, minute: 0 },
      ...(options.quiet ? { quiet: options.quiet } : {}),
      ...(options.releases ? { releases: options.releases } : {}),
      fetchAudio: async () => {
        throw new Error('no downloads in these tests');
      },
      log: (line) => logs.push(line),
      now: () => clock,
    });
    /** A post with its one song, as the site's sync would leave it. */
    const post = (slug: string, publishedAt: Date, extra: { artist?: string; seen?: Date } = {}): void => {
      const artist = extra.artist ?? 'Band';
      catalog.savePost({ slug, title: `${artist} - Song ${slug}`, category: 'Singles', publishedAt: iso(publishedAt), views: 0, audioFiles: 1 }, extra.seen ?? publishedAt);
      catalog.add({ title: `Song ${slug}`, artist, url: table.trackUrl({ slug }, 0), post: slug });
    };
    const follow = (artist: string, chat: string, since: Date): void => {
      catalog.follow(catalog.findArtist(artist.toLowerCase().split(' '))!.id, false, since, chat);
    };
    return {
      jobs,
      sent,
      failing,
      logs,
      reach,
      post,
      follow,
      site: site!,
      setClock: (date: Date) => {
        clock = date;
      },
    };
  }

  test('each person gets their own message once a day, at their own time, and the site is read once for those due together', async () => {
    const t = await setUp();
    t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
    t.jobs.addRecipient(BOB, { announce: t.reach('bob'), digestOffsetMinutes: 12 });
    assert.deepEqual(t.jobs.recipients().map((person) => person.id), ['owner', 'alice', 'bob']);
    t.post('p1', at(6, 7));
    await t.jobs.check();
    for (const who of ['owner', 'alice', 'bob'] as const) assert.equal(t.sent[who].length, 0, `${who}: before nine`);

    t.setClock(at(6, 9));
    await t.jobs.check();
    assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [1, 0, 0], 'the owner at nine');
    t.setClock(at(6, 9, DIGEST_STAGGER_MINUTES));
    await t.jobs.check();
    assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [1, 1, 0], 'the first person five minutes after');
    t.setClock(at(6, 9, 12));
    await t.jobs.check();
    assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [1, 1, 1], 'the next at the minute they were given');
    t.setClock(at(6, 9, 40));
    await t.jobs.check();
    t.setClock(at(6, 15));
    await t.jobs.check();
    assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [1, 1, 1], 'once a day each');

    for (const who of ['owner', 'alice', 'bob'] as const) {
      assert.deepEqual(songsIn(t.sent[who][0]!), ['Song p1'], who);
      assert.match(texts(t.sent[who][0]!)[0]!, /^New music · Tuesday, Oct 6\n1 new song on music-table\.com$/, 'the same message for everyone, in the same words');
    }
    // Each one's marks are their own.
    for (const chat of ['', 'alice', 'bob']) assert.ok(catalog.delivery('post.announced', 'p1', chat), `marked for ${chat || 'the owner'}`);
    assert.equal(catalog.getState('digest.last_date'), localDay(at(6, 9)));
    assert.equal(catalog.getState('digest.last_date:alice'), localDay(at(6, 9)));
    assert.equal(catalog.getState('digest.last_date:bob'), localDay(at(6, 9)));
    assert.ok(catalog.getState('digest.last_sent_at:alice') && catalog.getState('digest.last_sent_at:bob'));
    assert.equal(catalog.getState('digest.last_sent_at:carol'), undefined);
  });

  test('those due in the same round share one read of the site and one of Zemer’s feed, and still get a message each', async () => {
    const reads: string[] = [];
    const feed: NewReleases = {
      sync: async () => {
        reads.push('feed');
        return { ok: true, seen: 0, fresh: [] };
      },
      list: () => [],
      status: () => ({}) as never,
      toAnnounce: () => [],
      markAnnounced: () => {},
      toAlert: () => [],
      markAlerted: () => {},
    };
    const t = await setUp({ releases: feed });
    t.jobs.addRecipient(ALICE, { announce: t.reach('alice'), digestOffsetMinutes: 0 });
    t.jobs.addRecipient(BOB, { announce: t.reach('bob'), digestOffsetMinutes: 0 });
    t.post('p1', at(6, 7));
    await t.jobs.check(); // 8:00: the first look at the schedule; the site is read for the first time
    const siteReads = t.site.listReads;
    const feedReads = reads.length;
    t.setClock(at(6, 9));
    await t.jobs.check();
    assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [1, 1, 1]);
    assert.equal(t.site.listReads, siteReads + 1, 'one read of the site for three messages');
    assert.equal(reads.length - feedReads, 2, "and the feed: once for the round's own look and once before the messages, as with one person");
  });

  test('a message is built from what that person has not been told: marks, and the releases of their own chat', async () => {
    const release = (id: string, title: string): NewRelease => ({ id, title, artist: 'Zed', artistId: 'UC1', songs: 1, releasedAt: iso(at(6, 6)), firstSeenAt: iso(at(6, 6)) });
    const calls: string[] = [];
    const told: Record<string, string[]> = {};
    const feed: NewReleases = {
      sync: async () => ({ ok: true, seen: 0, fresh: [] }),
      list: () => [],
      status: () => ({}) as never,
      toAnnounce: (_since, chat = '') => {
        calls.push(`toAnnounce:${chat}`);
        return chat === 'alice' ? [release('R1', 'Only For Alice')] : [];
      },
      markAnnounced: (ids, _at, chat = '') => void (ids.length > 0 && (told[chat] = [...(told[chat] ?? []), ...ids])),
      toAlert: () => [],
      markAlerted: () => {},
    };
    const t = await setUp({ releases: feed });
    t.jobs.addRecipient(ALICE, { announce: t.reach('alice'), digestOffsetMinutes: 0 });
    t.jobs.addRecipient(BOB, { announce: t.reach('bob'), digestOffsetMinutes: 0 });
    t.post('p1', at(6, 7));
    t.post('p2', at(6, 7, 30));
    catalog.markAnnounced(['p1'], at(5, 9), 'alice'); // alice had p1 already
    await t.jobs.check();
    t.setClock(at(6, 9));
    await t.jobs.check();
    assert.deepEqual(songsIn(t.sent.owner[0]!), ['Song p2', 'Song p1']);
    assert.deepEqual(songsIn(t.sent.bob[0]!), ['Song p2', 'Song p1']);
    assert.deepEqual(songsIn(t.sent.alice[0]!).sort(), ['Only For Alice', 'Song p2'], "p1 was told to her already; and her chat's release is in hers");
    assert.ok([t.sent.owner[0]!, t.sent.bob[0]!].every((replies) => texts(replies).every((line) => !line.includes('Only For Alice'))));
    assert.deepEqual(told, { alice: ['R1'] }, 'and marked for her alone');
    assert.ok(calls.includes('toAnnounce:') && calls.includes('toAnnounce:alice') && calls.includes('toAnnounce:bob'));
  });

  describe('a person added while the host runs', () => {
    test('is seeded: nothing the evening they come, and their first message covers only what is new since they were added', async () => {
      const t = await setUp();
      t.post('old', at(4, 12)); // older than any message reaches
      await t.jobs.check(); // 8:00
      t.setClock(at(6, 9));
      await t.jobs.check();
      assert.equal(t.sent.owner.length, 0, 'the owner’s morning had nothing new, so no message, and the day counts as done');
      t.post('before', at(6, 11)); // out after the morning, nine hours before alice comes

      // alice comes at eight in the evening
      t.setClock(at(6, 20));
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
      assert.equal(catalog.getState('digest.since:alice'), iso(at(6, 20)), 'noted when she was first seen');
      t.post('dated-early', at(6, 17), { seen: at(6, 20, 30) }); // the site dates it three hours before it showed it
      await t.jobs.check();
      t.setClock(at(6, 20, 30));
      await t.jobs.check();
      assert.equal(t.sent.alice.length, 0, 'no surprise message the evening she is added');
      assert.equal(catalog.getState('digest.last_date:alice'), localDay(at(6, 20)), 'today counts as done for her');

      t.post('after', at(7, 6));
      t.setClock(at(7, 9));
      await t.jobs.check();
      assert.deepEqual(songsIn(t.sent.owner[0]!), ['Song after', 'Song dated-early', 'Song before'], 'the owner: the last day, as ever');
      assert.equal(t.sent.alice.length, 0, 'hers is five minutes later');
      t.setClock(at(7, 9, 5));
      await t.jobs.check();
      assert.deepEqual(songsIn(t.sent.alice[0]!), ['Song after', 'Song dated-early'], 'hers: nothing from before she came, though the last day held more');
      assert.equal(catalog.delivery('post.announced', 'before', 'alice'), undefined, 'and it is not marked as told to her');
      assert.ok(catalog.delivery('post.announced', 'after', 'alice'));
    });

    test('is not seeded again when the host restarts, or when their chat comes back', async () => {
      const t = await setUp();
      t.setClock(at(6, 12));
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
      const first = catalog.getState('digest.since:alice');
      assert.equal(first, iso(at(6, 12)));
      t.setClock(at(6, 14));
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') }); // the same person again: how she is reached is replaced
      assert.equal(catalog.getState('digest.since:alice'), first);
      assert.equal(t.jobs.recipients().filter((person) => person.id === 'alice').length, 1);

      // a new host process over the same catalog
      const again = new LibraryJobs({ musicTable: table, catalog, announce: t.reach('owner'), digestAt: { hour: 9, minute: 0 }, fetchAudio: async () => { throw new Error('no'); }, now: () => at(9, 12) });
      catalog.setState('digest.last_date:alice', localDay(at(8, 9)));
      again.addRecipient(ALICE, { announce: t.reach('alice') });
      assert.equal(catalog.getState('digest.since:alice'), first, 'she is not new any more');
      assert.equal(catalog.getState('digest.last_date:alice'), localDay(at(8, 9)), 'and her schedule is where it was');
    });

    test('the owner added the same way is seeded the way he always was, on the first look at the schedule', async () => {
      const t = await setUp({ owner: false });
      t.post('p1', at(6, 7));
      t.jobs.addRecipient(OWNER, { announce: t.reach('owner') });
      assert.equal(catalog.getState('digest.since'), undefined, 'no note of when: the plain key is the owner’s, as it was');
      assert.equal(catalog.getState('digest.last_date'), undefined);
      await t.jobs.check(); // 8:00, before the time
      assert.equal(catalog.getState('digest.last_date'), localDay(new Date(at(6, 8).getTime() - 24 * HOUR_MS)));
      t.setClock(at(6, 9));
      await t.jobs.check();
      assert.deepEqual(songsIn(t.sent.owner[0]!), ['Song p1'], 'that same morning');
    });
  });

  test('a host with no owner chat yet works for the people who have theirs, and sends the owner nothing', async () => {
    const t = await setUp({ owner: false });
    t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
    t.post('p1', at(6, 7));
    assert.deepEqual(t.jobs.recipients().map((person) => person.id), ['alice']);
    await t.jobs.check();
    t.setClock(at(6, 9, 5));
    await t.jobs.check();
    assert.equal(t.sent.alice.length, 1);
    assert.equal(t.sent.owner.length, 0);
    assert.equal(catalog.getState('digest.last_date'), undefined, 'the owner’s schedule is left alone');
    const reads = t.site.listReads;
    assert.equal(await t.jobs.sendDigest(), 0, 'sending to the owner is nothing when there is no chat');
    assert.equal(await t.jobs.alertFollowed(), 0);
    assert.equal(t.site.listReads, reads, 'and it does not even read the site');
    assert.deepEqual(songsIn((await t.jobs.previewDigest()).replies), ['Song p1'], 'a preview needs no chat: it is the owner’s, as ever');
  });

  describe('alerts for the artists someone follows', () => {
    test('go only to the follower, once, from their own follows, and are marked for them alone', async () => {
      const t = await setUp({ digestAt: undefined });
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
      t.jobs.addRecipient(BOB, { announce: t.reach('bob') });
      t.post('old-yw', at(1, 12), { artist: 'Yoely Weiss' });
      t.post('old-mw', at(1, 12), { artist: 'Mendy Weiss' });
      t.follow('Yoely Weiss', 'alice', at(5, 0));
      t.follow('Mendy Weiss', 'bob', at(5, 0));
      await t.jobs.check();
      assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [0, 0, 0], 'nothing to tell yet');

      t.setClock(at(6, 10));
      t.post('yw-new', at(6, 10), { artist: 'Yoely Weiss' });
      await t.jobs.check();
      assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [0, 1, 0], 'only alice follows Yoely Weiss');
      assert.deepEqual(
        t.sent.alice[0]!.map((reply) => (reply.kind === 'text' ? reply.text : `[${reply.kind}]`)),
        ['🔔 New from Yoely Weiss: Yoely Weiss — Song yw-new', 'Tap 👍 on it to get it.'],
      );
      assert.ok(catalog.delivery('post.alerted', 'yw-new', 'alice'));
      assert.equal(catalog.delivery('post.alerted', 'yw-new', 'bob'), undefined);
      assert.equal(catalog.delivery('post.alerted', 'yw-new', ''), undefined);
      t.setClock(at(6, 10, 1));
      await t.jobs.check();
      assert.equal(t.sent.alice.length, 1, 'not twice');

      t.setClock(at(6, 10, 30));
      t.post('mw-new', at(6, 10, 20), { artist: 'Mendy Weiss' });
      await t.jobs.check();
      assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [0, 1, 1], 'and Mendy Weiss only to bob');
    });

    test('are the owner’s as ever when the owner follows, and one person’s play does not silence another’s alert', async () => {
      const t = await setUp({ digestAt: undefined });
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
      t.post('old-yw', at(1, 12), { artist: 'Yoely Weiss' });
      t.follow('Yoely Weiss', '', at(5, 0));
      t.follow('Yoely Weiss', 'alice', at(5, 0));
      t.setClock(at(6, 10));
      t.post('yw-new', at(6, 10), { artist: 'Yoely Weiss' });
      catalog.recordPlay(catalog.postTracks('yw-new')[0]!.id, at(6, 10), 'alice'); // alice had it already
      await t.jobs.check();
      assert.equal(t.sent.owner.length, 1, 'the owner is told');
      assert.equal(t.sent.alice.length, 0, 'alice had it');
      assert.ok(catalog.sitePost('yw-new')?.alertedAt, "the owner's mark is on the post, where it always was");
      assert.equal(catalog.delivery('post.alerted', 'yw-new', 'alice'), undefined);
    });

    test('wait out the host’s quiet hours for everyone, and for a chat that cannot take them', async () => {
      const t = await setUp({ quiet: { from: { hour: 22, minute: 0 }, to: { hour: 7, minute: 0 } } });
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
      t.post('old-yw', at(1, 12), { artist: 'Yoely Weiss' });
      t.follow('Yoely Weiss', 'alice', at(5, 0));
      t.setClock(at(6, 23));
      t.post('yw-new', at(6, 22, 30), { artist: 'Yoely Weiss' });
      t.failing.add('alice');
      assert.equal(await t.jobs.alertFollowed('alice'), 0, 'quiet hours');
      t.setClock(at(7, 7, 5));
      assert.equal(await t.jobs.alertFollowed('alice'), 0, 'her chat is down');
      assert.equal(catalog.delivery('post.alerted', 'yw-new', 'alice'), undefined, 'not counted as sent');
      t.failing.delete('alice');
      t.setClock(at(7, 7, 10));
      assert.equal(await t.jobs.alertFollowed('alice'), 1);
      assert.equal(await t.jobs.alertFollowed('alice'), 0);
      assert.equal(await t.jobs.alertFollowed('bob'), 0, 'someone who is not sent to');
    });

    test('the site’s feed is watched while anyone sent to follows anyone, and not for someone who is not', async () => {
      const t = await setUp({ digestAt: undefined });
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
      t.post('old', at(1, 12), { artist: 'Yoely Weiss' });
      catalog.setState(STATE.lastSync, iso(at(6, 7, 50)));
      await t.jobs.check(); // 8:00: not due, and nobody follows anyone
      t.setClock(at(6, 8, 20));
      await t.jobs.check();
      assert.equal(t.site.feedReads, 0);
      t.follow('Yoely Weiss', 'carol', at(6, 0));
      t.setClock(at(6, 8, 40));
      await t.jobs.check();
      assert.equal(t.site.feedReads, 0, 'carol is not sent to');
      t.follow('Yoely Weiss', 'alice', at(6, 0));
      t.setClock(at(6, 9, 0));
      await t.jobs.check();
      assert.equal(t.site.feedReads, 1, 'alice follows');
      t.setClock(at(6, 9, 5));
      await t.jobs.check();
      assert.equal(t.site.feedReads, 1, 'and once for all of them, every fifteen minutes');
    });
  });

  describe('a person whose chat cannot be reached', () => {
    test('does not hold up the others: theirs is tried again in half an hour, and nobody is told twice', async () => {
      const t = await setUp();
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice'), digestOffsetMinutes: 0 });
      t.jobs.addRecipient(BOB, { announce: t.reach('bob'), digestOffsetMinutes: 0 });
      t.post('p1', at(6, 7));
      t.failing.add('alice');
      await t.jobs.check();
      t.setClock(at(6, 9));
      await t.jobs.check();
      assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [1, 0, 1], 'the owner and bob had theirs');
      assert.ok(t.logs.some((line) => line.startsWith("daily message to alice could not be sent (trying again in 30 minutes): alice's chat is unreachable")), t.logs.join('\n'));
      assert.equal(catalog.delivery('post.announced', 'p1', 'alice'), undefined, 'nothing is marked as told to her');
      assert.equal(catalog.getState('digest.last_date:alice'), localDay(at(5, 9)), 'her day is not done: it still says yesterday');

      t.failing.delete('alice');
      t.setClock(at(6, 9, 10));
      await t.jobs.check();
      assert.equal(t.sent.alice.length, 0, 'not before the half hour');
      t.setClock(at(6, 9, 31));
      await t.jobs.check();
      assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [1, 1, 1], 'and then hers goes, and only hers');
      assert.deepEqual(songsIn(t.sent.alice[0]!), ['Song p1']);
    });

    test('a failing alert is logged once and tried again every minute, and the others still get theirs', async () => {
      const t = await setUp({ digestAt: undefined });
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
      t.jobs.addRecipient(BOB, { announce: t.reach('bob') });
      t.post('old', at(1, 12), { artist: 'Yoely Weiss' });
      t.follow('Yoely Weiss', 'alice', at(5, 0));
      t.follow('Yoely Weiss', 'bob', at(5, 0));
      t.failing.add('alice');
      t.setClock(at(6, 10));
      t.post('yw-new', at(6, 10), { artist: 'Yoely Weiss' });
      await t.jobs.check();
      t.setClock(at(6, 10, 1));
      await t.jobs.check();
      assert.deepEqual([t.sent.alice.length, t.sent.bob.length], [0, 1], 'bob was told, alice could not be');
      assert.equal(t.logs.filter((line) => line.startsWith('could not send the new-song alert to alice (it is tried again every minute)')).length, 1, 'said once');
      assert.deepEqual(t.jobs.report().people.map((person) => [person.id, person.alertFailing]), [['alice', true], ['bob', false]]);
      assert.equal(t.jobs.report().alertFailing, false, 'the owner’s own flag is the owner’s');
      t.failing.delete('alice');
      t.setClock(at(6, 10, 2));
      await t.jobs.check();
      assert.deepEqual([t.sent.alice.length, t.sent.bob.length], [1, 1]);
      assert.deepEqual(t.jobs.report().people.map((person) => person.alertFailing), [false, false]);
    });

    test('a failure that is not the chat’s is kept to that person: the others still get theirs and the round carries on', async () => {
      const t = await setUp();
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice'), digestOffsetMinutes: 0 });
      t.jobs.addRecipient(BOB, { announce: t.reach('bob'), digestOffsetMinutes: 0 });
      t.post('p1', at(6, 7));
      const original = catalog.postsToAnnounce.bind(catalog);
      catalog.postsToAnnounce = (since, limit, chat = '') => {
        if (chat === 'alice') throw new Error('alice’s marks are unreadable');
        return original(since, limit, chat);
      };
      await t.jobs.check();
      t.setClock(at(6, 9));
      await t.jobs.check();
      assert.deepEqual([t.sent.owner.length, t.sent.alice.length, t.sent.bob.length], [1, 0, 1]);
      assert.ok(t.logs.some((line) => line === 'the daily message for alice failed: alice’s marks are unreadable'), t.logs.join('\n'));
      assert.equal(t.jobs.report().lastRoundError, null, 'the round itself went on');
    });

    test('the owner’s failure is thrown as ever, but only after the people have had their turn', async () => {
      const t = await setUp();
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice'), digestOffsetMinutes: 0 });
      t.post('p1', at(6, 7));
      const original = catalog.postsToAnnounce.bind(catalog);
      catalog.postsToAnnounce = (since, limit, chat = '') => {
        if (chat === '') throw new Error('the owner’s marks are unreadable');
        return original(since, limit, chat);
      };
      await t.jobs.check();
      t.setClock(at(6, 9));
      await t.jobs.check();
      assert.equal(t.sent.alice.length, 1);
      assert.equal(t.jobs.report().lastRoundError, 'the owner’s marks are unreadable');
    });

    test('an announce that throws at once, not by rejecting, is the same', async () => {
      const t = await setUp();
      t.jobs.addRecipient(ALICE, {
        announce: () => {
          throw new TypeError('the runner is gone');
        },
        digestOffsetMinutes: 0,
      });
      t.post('p1', at(6, 7));
      await t.jobs.check();
      t.setClock(at(6, 9));
      await t.jobs.check();
      assert.equal(t.sent.owner.length, 1);
      assert.ok(t.logs.some((line) => line.includes('daily message to alice could not be sent') && line.includes('the runner is gone')));
    });
  });

  describe('removing a person', () => {
    test('stops what goes to them, leaves what they were told, and adding them again carries on', async () => {
      const t = await setUp();
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice'), digestOffsetMinutes: 0 });
      t.post('p1', at(6, 7));
      await t.jobs.check();
      t.setClock(at(6, 9));
      await t.jobs.check();
      assert.deepEqual([t.sent.owner.length, t.sent.alice.length], [1, 1]);

      assert.equal(t.jobs.removeRecipient('alice'), true);
      assert.equal(t.jobs.removeRecipient('alice'), false, 'already gone');
      assert.deepEqual(t.jobs.recipients().map((person) => person.id), ['owner']);
      assert.deepEqual(t.jobs.report().people, []);
      t.post('p2', at(7, 6));
      t.setClock(at(7, 9));
      await t.jobs.check();
      assert.deepEqual([t.sent.owner.length, t.sent.alice.length], [2, 1], 'nothing more for alice');
      assert.equal(await t.jobs.sendDigest(undefined, 'alice'), 0);
      assert.equal(await t.jobs.alertFollowed('alice'), 0);
      assert.equal(catalog.getState('digest.last_date:alice'), localDay(at(6, 9)), 'her state stays');

      t.jobs.addRecipient(ALICE, { announce: t.reach('alice'), digestOffsetMinutes: 0 });
      t.setClock(at(8, 9));
      await t.jobs.check();
      assert.equal(t.sent.alice.length, 2);
      assert.deepEqual(songsIn(t.sent.alice[1]!), ['Song p2'], 'what she missed, once, and not what she had');
    });

    test('someone removed while the round is sending to the others is skipped', async () => {
      const t = await setUp();
      let owners = 0;
      t.jobs.addRecipient(OWNER, {
        announce: async (replies) => {
          owners += 1;
          t.sent.owner.push(replies);
          t.jobs.removeRecipient('alice'); // while the owner's message is on its way
        },
      });
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice'), digestOffsetMinutes: 0 });
      t.post('p1', at(6, 7));
      await t.jobs.check();
      t.setClock(at(6, 9));
      await t.jobs.check();
      assert.equal(owners, 1);
      assert.equal(t.sent.alice.length, 0);
    });
  });

  describe('the time of the daily message', () => {
    test('is the host’s plus a few minutes for each person after the owner, kept inside the day; a time of their own is theirs', async () => {
      const t = await setUp({ digestAt: { hour: 23, minute: 58 } });
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
      t.jobs.addRecipient(BOB, { announce: t.reach('bob'), digestAt: { hour: 7, minute: 30 } });
      assert.deepEqual(t.jobs.report().people.map((person) => [person.id, person.digest.at]), [['alice', '23:59'], ['bob', '07:30']]);
      assert.equal(t.jobs.report().digest.at, '23:58', 'the owner’s is the host’s exactly');
    });

    test('off is off for everyone', async () => {
      const t = await setUp({ digestAt: undefined });
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
      t.post('p1', at(6, 7));
      await t.jobs.check();
      t.setClock(at(6, 10));
      await t.jobs.check();
      t.setClock(at(7, 10));
      await t.jobs.check();
      assert.deepEqual([t.sent.owner.length, t.sent.alice.length], [0, 0]);
      assert.deepEqual(t.jobs.report().people.map((person) => person.digest.at), [null]);
    });

    test('by default each person after the owner is a step later than the one before', async () => {
      const t = await setUp();
      t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
      t.jobs.addRecipient(BOB, { announce: t.reach('bob') });
      assert.deepEqual(t.jobs.report().people.map((person) => person.digest.at), ['09:05', '09:10']);
    });

    test('a live setting is followed for the people as for the owner', async () => {
      let time: { hour: number; minute: number } | undefined = { hour: 9, minute: 0 };
      const t = await setUp({ digestAt: undefined });
      const live = new LibraryJobs({ musicTable: table, catalog, announce: t.reach('owner'), digestAt: () => time, fetchAudio: async () => { throw new Error('no'); }, now: () => at(6, 8) });
      live.addRecipient(ALICE, { announce: t.reach('alice') });
      assert.equal(live.report().people[0]!.digest.at, '09:05');
      time = { hour: 10, minute: 15 };
      assert.equal(live.report().people[0]!.digest.at, '10:20');
      time = undefined;
      assert.equal(live.report().people[0]!.digest.at, null);
    });
  });

  test('the console’s actions take a person by id and default to the owner', async () => {
    const t = await setUp();
    t.jobs.addRecipient(ALICE, { announce: t.reach('alice') });
    t.post('p1', at(6, 7));
    t.setClock(at(6, 10));
    const preview = await t.jobs.previewDigest(undefined, 'alice');
    assert.deepEqual(songsIn(preview.replies), ['Song p1']);
    assert.equal(t.sent.alice.length, 0, 'a preview sends and marks nothing');
    assert.deepEqual((await t.jobs.previewDigest(undefined, 'nobody')).replies, []);
    assert.equal(await t.jobs.sendDigest(undefined, 'alice'), 1);
    assert.deepEqual([t.sent.owner.length, t.sent.alice.length], [0, 1], 'only the one asked');
    assert.equal(await t.jobs.sendDigest(), 1);
    assert.deepEqual([t.sent.owner.length, t.sent.alice.length], [1, 1]);
    assert.ok(t.logs.includes('daily message sent to alice: 1 new release'));
    assert.ok(t.logs.includes('daily message sent: 1 new release'), 'the owner’s line is the one it always was');
  });

  test('with no one but the owner nothing changes: the plain keys, the owner’s marks, and a report with no people', async () => {
    dir = mkdtempSync(join(tmpdir(), 'recipients-'));
    const file = join(dir, 'catalog.db');
    site = await startMockMusicTable([]);
    table = new MusicTable({ baseUrl: site.url, minIntervalMs: 0 });
    catalog = new Catalog(file);
    catalog.setState(STATE.scanDone, iso(at(1, 0)));
    let now = at(6, 8);
    const sent: Reply[][] = [];
    const jobs = new LibraryJobs({
      musicTable: table,
      catalog,
      announce: async (replies) => void sent.push(replies),
      digestAt: { hour: 9, minute: 0 },
      fetchAudio: async () => {
        throw new Error('no');
      },
      now: () => now,
    });
    catalog.savePost({ slug: 'p1', title: 'Band - Song p1', category: 'Singles', publishedAt: iso(at(6, 7)), views: 0, audioFiles: 1 }, at(6, 7));
    catalog.add({ title: 'Song p1', artist: 'Band', url: table.trackUrl({ slug: 'p1' }, 0), post: 'p1' });
    await jobs.check();
    now = at(6, 9);
    await jobs.check();
    assert.equal(sent.length, 1);
    assert.deepEqual(jobs.recipients(), [OWNER]);
    assert.deepEqual(jobs.report().people, []);
    assert.ok(catalog.sitePost('p1')?.announcedAt, "the owner's mark is on the post, where it always was");

    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const keys = db.prepare('SELECT key FROM state ORDER BY key').all().map((row) => String(row.key));
      assert.deepEqual(keys, ['digest.last_date', 'digest.last_sent_at', 'library.last_sync', 'library.scan_done'], 'only the keys there have always been');
      const chats = db.prepare('SELECT DISTINCT chat FROM deliveries').all().map((row) => String(row.chat));
      assert.deepEqual(chats, [''], 'only the owner has marks');
    } finally {
      db.close();
    }
  });
});

describe('the library around people', () => {
  let catalog: Catalog;
  let site: MockMusicTable | undefined;
  afterEach(async () => {
    catalog?.close();
    await site?.close();
    site = undefined;
  });

  const audio = (): DownloadedAudio => {
    const data = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, ...Array.from({ length: 400 }, (_, i) => i % 251)]);
    return { data: new Blob([data], { type: 'audio/mpeg' }), fileName: 'raw.mp3', mimeType: 'audio/mpeg', bytes: data.length };
  };
  const drive: Drive = { connected: () => true, exists: async () => false, upload: async () => {} };

  function library(options: { withSite?: boolean } = {}) {
    catalog = new Catalog(':memory:');
    catalog.add({ title: 'Derech', artist: 'Ishay Ribo', url: 'https://x.test/derech' });
    return {
      catalog,
      make: () =>
        setUpLibrary({
          catalog,
          musicTable: options.withSite && site ? new MusicTable({ baseUrl: site.url, minIntervalMs: 0 }) : undefined,
          audio: { checkAudio: async () => ({ ok: true }) as never, fetchAudio: async () => audio() },
          dbPath: ':memory:',
          digestAt: { hour: 9, minute: 0 },
          prefetchMb: 0,
          cloudFolder: drive,
          log: () => {},
        }),
    };
  }

  test('the owner’s songs are offered to OneDrive and a person’s never are', async () => {
    const { make } = library();
    const lib = make();
    const offered: string[] = [];
    lib.archive!.offer = (url) => void offered.push(url);
    await lib.forPerson(OWNER).fetchAudio('https://x.test/derech', 'Derech');
    assert.deepEqual(offered, ['https://x.test/derech'], 'the owner’s');
    const alice = await lib.forPerson(ALICE).fetchAudio('https://x.test/derech', 'Derech');
    assert.deepEqual(offered, ['https://x.test/derech'], 'alice’s is not added');
    assert.match(alice.fileName, /Ishay Ribo - Derech/, 'but it is named and tagged the same');
    assert.equal(lib.forPerson(OWNER).fetchAudio, lib.fetchAudio, 'the owner’s are the library’s own');
  });

  test('a person’s plays and follows are their own', async () => {
    const { make } = library();
    const lib = make();
    const derech = catalog.byUrl('https://x.test/derech')!;
    lib.forPerson(ALICE).onPlay(derech);
    lib.forPerson(OWNER).onPlay(derech);
    lib.onPlay(derech);
    const ribo = catalog.findArtist(['ishay', 'ribo'])!;
    assert.equal(catalog.playedSongsBy(ribo.id, 'alice'), 1);
    assert.equal(catalog.playedSongsBy(ribo.id, 'bob'), 0);
    assert.equal(lib.forPerson(ALICE).follows.follow(['ishay', 'ribo'])?.name, 'Ishay Ribo');
    assert.equal(catalog.followState(ribo.id, 'alice'), 'on');
    assert.equal(catalog.followState(ribo.id), undefined, 'not the owner’s');
    assert.deepEqual(lib.forPerson(BOB).follows.list(), []);
    assert.deepEqual(lib.follows.list(), []);
    assert.deepEqual(lib.forPerson(ALICE).follows.list(), [{ name: 'Ishay Ribo', auto: false }]);
  });

  test('people can be added before the jobs start or after, and the owner’s announce is optional', async () => {
    site = await startMockMusicTable([]);
    const { make } = library({ withSite: true });
    const lib = make();
    lib.addRecipient(ALICE, { announce: async () => {} });
    lib.addRecipient(BOB, { announce: async () => {} });
    lib.removeRecipient('bob'); // before there are any jobs
    lib.start(); // no owner chat yet
    try {
      assert.deepEqual(lib.jobs!.recipients().map((person) => person.id), ['alice'], 'alice, and not the owner, not bob');
      lib.addRecipient(OWNER, { announce: async () => {} });
      lib.addRecipient(BOB, { announce: async () => {} });
      assert.deepEqual(lib.jobs!.recipients().map((person) => person.id), ['owner', 'alice', 'bob']);
      lib.removeRecipient('alice');
      assert.deepEqual(lib.jobs!.recipients().map((person) => person.id), ['owner', 'bob']);
    } finally {
      await lib.stop();
    }
  });

  test('the owner’s announce given to start is the first recipient, as it has always been', async () => {
    site = await startMockMusicTable([]);
    const { make } = library({ withSite: true });
    const lib = make();
    lib.addRecipient(ALICE, { announce: async () => {} });
    lib.start(async () => {});
    try {
      assert.deepEqual(lib.jobs!.recipients().map((person) => person.id), ['owner', 'alice']);
    } finally {
      await lib.stop();
    }
  });
});
