import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SongArchive, type Drive } from '../src/archive/archiver.ts';
import { OneDriveError } from '../src/archive/onedrive.ts';
import type { DownloadedAudio } from '../src/audio-fetch.ts';
import { Catalog } from '../src/catalog.ts';
import { parseCloudBudget } from '../src/config.ts';
import { readTextTags } from '../src/library/id3.ts';
import { setUpLibrary } from '../src/library/setup.ts';
import { archivedThisMonth } from '../src/usage.ts';

const MPEG = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, ...Array.from({ length: 400 }, (_, i) => i % 251)]);
const song = (name = 'Ishay Ribo - Derech.mp3', data: Uint8Array = MPEG, mimeType = 'audio/mpeg'): DownloadedAudio => ({ data: new Blob([data], { type: mimeType }), fileName: name, mimeType, bytes: data.length });

class FakeDrive implements Drive {
  signedIn = true;
  files = new Map<string, Uint8Array>();
  uploads: string[] = [];
  /** What each upload was handed: a Blob (read a piece at a time) or bytes already in memory. */
  sources: string[] = [];
  existing = new Set<string>();
  failWith: Error | undefined;
  /** Held back until the test lets it go, to see what waits. */
  gate: Promise<void> | undefined;
  connected = () => this.signedIn;
  exists = async (path: string) => this.existing.has(path) || this.files.has(path);
  upload = async (path: string, data: Uint8Array | Blob) => {
    await this.gate;
    if (this.failWith) throw this.failWith;
    this.uploads.push(path);
    this.sources.push(data instanceof Blob ? 'blob' : 'bytes');
    this.files.set(path, data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data);
  };
}

function setUp(options: { budget?: number } = {}) {
  const drive = new FakeDrive();
  const state = new Catalog(':memory:');
  const logs: string[] = [];
  const problems: Array<[string | undefined, boolean]> = [];
  const archive = new SongArchive({
    drive,
    state,
    placeOf: (_url, audio) => `Ishay Ribo/Singles/${audio.fileName.replace(/^.* - /, '')}`,
    monthlyBudgetBytes: options.budget,
    delayMs: 0,
    sleep: async () => {},
    onProblem: (problem, needsLogin) => void problems.push([problem, needsLogin]),
    log: (line) => logs.push(line),
    now: () => new Date('2026-10-14T12:00:00Z'),
  });
  return { drive, state, logs, problems, archive };
}

describe('saving sent songs to the cloud folder', () => {
  test('uploads the song as it was sent, straight from its Blob, to its place, without making the caller wait', async () => {
    const { drive, state, archive, logs } = setUp();
    archive.offer('https://x.test/1', song());
    assert.equal(drive.uploads.length, 0, 'offer returns before anything is uploaded');
    await archive.idle();
    assert.deepEqual(drive.uploads, ['Ishay Ribo/Singles/Derech.mp3']);
    assert.deepEqual(drive.sources, ['blob'], 'the Blob is handed over, to be read a piece at a time, not copied into bytes first');
    assert.deepEqual(drive.files.get('Ishay Ribo/Singles/Derech.mp3'), MPEG, 'byte for byte what was sent: it was tagged when it was fetched to be sent, and is not tagged again');
    assert.equal(archivedThisMonth(state, new Date('2026-10-20T00:00:00Z')), MPEG.length, 'the upload is counted for the month');
    assert.ok(logs.some((line) => /saved Ishay Ribo\/Singles\/Derech\.mp3 to OneDrive/.test(line)));
  });

  test('saves a song once however often it is sent, and not at all if it is already there', async () => {
    const { drive, archive, state } = setUp();
    archive.offer('https://x.test/1', song());
    await archive.idle();
    archive.offer('https://x.test/1', song());
    await archive.idle();
    assert.equal(drive.uploads.length, 1);

    drive.existing.add('Ishay Ribo/Singles/Other.mp3');
    archive.offer('https://x.test/2', song('Ishay Ribo - Other.mp3'));
    await archive.idle();
    assert.equal(drive.uploads.length, 1, 'a copy already in the folder is left alone');
    assert.equal(state.getState('archive.done:Ishay Ribo/Singles/Other.mp3'), '1', 'and remembered, so it is not asked about again');
  });

  test('does nothing until OneDrive is signed in', async () => {
    const { drive, archive } = setUp();
    drive.signedIn = false;
    archive.offer('https://x.test/1', song());
    await archive.idle();
    assert.equal(drive.uploads.length, 0);
    assert.equal(archive.pending(), 0);
  });

  test('stops for the rest of the month once its allowance is used, says so once, and starts again next month', async () => {
    const { drive, archive, logs, state } = setUp({ budget: 600 });
    archive.offer('https://x.test/1', song());
    await archive.idle();
    assert.equal(drive.uploads.length, 1);
    for (const n of [2, 3]) {
      archive.offer(`https://x.test/${n}`, song(`Ishay Ribo - Song ${n}.mp3`));
      await archive.idle();
    }
    assert.equal(drive.uploads.length, 1, 'over the allowance');
    assert.equal(logs.filter((line) => /allowance/.test(line)).length, 1, 'said once');
    // A new month: a fresh allowance.
    const next = new SongArchive({ drive, state, placeOf: (_u, a) => `Ishay Ribo/Singles/${a.fileName.replace(/^.* - /, '')}`, monthlyBudgetBytes: 600, delayMs: 0, sleep: async () => {}, now: () => new Date('2026-11-01T00:00:00Z') });
    next.offer('https://x.test/4', song('Ishay Ribo - Song 4.mp3'));
    await next.idle();
    assert.equal(drive.uploads.length, 2);
  });

  test('keeps at most three songs waiting behind the one being saved', async () => {
    const { drive, archive, logs } = setUp();
    let release!: () => void;
    drive.gate = new Promise<void>((resolve) => (release = resolve));
    for (let n = 1; n <= 6; n++) archive.offer(`https://x.test/${n}`, song(`Ishay Ribo - Song ${n}.mp3`));
    assert.equal(archive.pending(), 4, 'one being saved and three waiting');
    assert.equal(logs.filter((line) => /already waiting/.test(line)).length, 2);
    release();
    await archive.idle();
    assert.deepEqual(drive.uploads, ['Song 1', 'Song 2', 'Song 3', 'Song 4'].map((name) => `Ishay Ribo/Singles/${name}.mp3`));
  });

  test('a song offered just as the worker finishes is still saved', async () => {
    const { drive, archive } = setUp();
    archive.offer('https://x.test/1', song('Ishay Ribo - One.mp3'));
    await Promise.resolve();
    archive.offer('https://x.test/2', song('Ishay Ribo - Two.mp3'));
    await archive.idle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await archive.idle();
    assert.equal(drive.uploads.length, 2);
  });

  test('a song waits a few seconds before it is saved, so the send that fetched it is over', async () => {
    const drive = new FakeDrive();
    const waits: number[] = [];
    const archive = new SongArchive({ drive, state: new Catalog(':memory:'), placeOf: (_u, a) => `A/B/${a.fileName}`, sleep: async (ms) => void waits.push(ms) });
    archive.offer('https://x.test/1', song('A - one.mp3'));
    await archive.idle();
    assert.deepEqual(waits, [5000]);
    assert.equal(drive.uploads.length, 1);
  });

  test('a big song waits longer: half a second more for each MB, up to 30 s, while the bridge and the homeserver hand it on to Google', async () => {
    const MB = 1048576;
    const delayFor = async (songMb: number): Promise<number> => {
      const waits: number[] = [];
      const archive = new SongArchive({ drive: new FakeDrive(), state: new Catalog(':memory:'), placeOf: (_u, a) => `A/B/${a.fileName}`, sleep: async (ms) => void waits.push(ms) });
      const data = new Uint8Array(songMb * MB);
      data.set([0xff, 0xfb]);
      archive.offer('https://x.test/s', song('A - song.mp3', data));
      await archive.idle();
      return waits[0]!;
    };
    assert.equal(await delayFor(1), 5500);
    assert.equal(await delayFor(27), 5000 + 13_500);
    assert.equal(await delayFor(60), 30_000, 'but never more than 30 s');
  });

  test('a song waits for memory to come free, and goes ahead once it does', async () => {
    const drive = new FakeDrive();
    const state = new Catalog(':memory:');
    const MB = 1048576;
    let used = 480 * MB; // of a 512 MB host
    const waits: number[] = [];
    const archive = new SongArchive({
      drive,
      state,
      placeOf: (_u, a) => `A/B/${a.fileName}`,
        memory: () => ({ limit: 512 * MB, used }),
      delayMs: 0,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 4) used = 250 * MB; // other work finished (the first wait is the short pause before saving)
      },
    });
    archive.offer('https://x.test/1', song('A - one.mp3'));
    await archive.idle();
    assert.deepEqual(waits.filter((ms) => ms === 3000), [3000, 3000, 3000]);
    assert.deepEqual(drive.uploads, ['A/B/A - one.mp3']);
  });

  test('a song needs only a couple of upload pieces and some room to spare, however big it is; with less than that it is skipped, with a note', async () => {
    const MB = 1048576;
    const fits = async (songMb: number, usedMb: number): Promise<{ saved: boolean; note: string | undefined }> => {
      const drive = new FakeDrive();
      const logs: string[] = [];
      const data = new Uint8Array(songMb * MB);
      data.set([0xff, 0xfb]);
      const archive = new SongArchive({ drive, state: new Catalog(':memory:'), placeOf: (_u, a) => `A/B/${a.fileName}`, memory: () => ({ limit: 512 * MB, used: usedMb * MB }), delayMs: 0, sleep: async () => {}, log: (line) => logs.push(line) });
      archive.offer('https://x.test/s', song('A - song.mp3', data));
      await archive.idle();
      return { saved: drive.uploads.length === 1, note: logs.find((line) => /too little memory/.test(line)) };
    };
    // 512 − used must be at least 2 × 10 (the piece being sent and the next being read) + 80 to spare, whatever the song's size.
    assert.equal((await fits(5, 412)).saved, true, '100 free needs 100');
    assert.equal((await fits(30, 412)).saved, true, 'the same for a 30 MB song: it is not copied');
    assert.equal((await fits(5, 413)).saved, false, '99 free needs 100');
    const skipped = await fits(30, 413);
    assert.equal(skipped.saved, false);
    assert.match(skipped.note!, /not saving A\/B\/A - song\.mp3 to OneDrive: it is 30 MB and this host has too little memory/);
  });

  test('failures are said once they repeat, and when saving works again', async () => {
    const { drive, archive, problems, state } = setUp();
    drive.failWith = new Error('OneDrive refused a file (HTTP 507: out of space)');
    for (let n = 1; n <= 5; n++) {
      archive.offer(`https://x.test/${n}`, song(`Ishay Ribo - Song ${n}.mp3`));
      await archive.idle();
    }
    assert.deepEqual(problems, [['OneDrive refused a file (HTTP 507: out of space)', false]], 'after three in a row, once');
    assert.match(state.getState('onedrive.error') ?? '', /out of space/);
    drive.failWith = undefined;
    archive.offer('https://x.test/6', song('Ishay Ribo - Song 6.mp3'));
    await archive.idle();
    assert.deepEqual(problems.at(-1), [undefined, false]);
    assert.equal(state.getState('onedrive.error'), '');
  });

  test('a sign-in that no longer works is said at once, with the need to sign in again', async () => {
    const { drive, archive, problems } = setUp();
    drive.failWith = new OneDriveError('Microsoft would not renew the OneDrive sign-in (invalid_grant).', { needsLogin: true });
    archive.offer('https://x.test/1', song());
    await archive.idle();
    assert.deepEqual(problems, [['Microsoft would not renew the OneDrive sign-in (invalid_grant).', true]]);
  });

  test('a song of any type is saved exactly as it was sent', async () => {
    const { drive, archive } = setUp();
    const ogg = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3]);
    archive.offer('https://x.test/1', song('Ishay Ribo - Derech.ogg', ogg, 'audio/ogg'));
    await archive.idle();
    assert.deepEqual(drive.files.get('Ishay Ribo/Singles/Derech.ogg'), ogg);
  });
});

describe('the monthly allowance setting', () => {
  test('is 1500 MB unless set, can be unlimited, and must be a number', () => {
    assert.equal(parseCloudBudget(undefined), 1500 * 1048576);
    assert.equal(parseCloudBudget('800'), 800 * 1048576);
    assert.equal(parseCloudBudget('0'), 0);
    assert.equal(parseCloudBudget('unlimited'), undefined);
    assert.ok(parseCloudBudget('lots') instanceof Error);
    assert.ok(parseCloudBudget('-5') instanceof Error);
  });
});

describe('the library offers each song it fetches to be sent', () => {
  test('a fetched song comes back with its tags written in, and is saved in the background under its proper place', async () => {
    const catalog = new Catalog(':memory:');
    const url = 'https://x.test/derech';
    catalog.add({ title: 'Derech', artist: 'Ishay Ribo ft. Zusha', url });
    const drive = new FakeDrive();
    const logs: string[] = [];
    const library = setUpLibrary({
      catalog,
      musicTable: undefined,
      audio: { checkAudio: async () => ({ ok: true }) as never, fetchAudio: async () => song('raw upload name.mp3') },
      dbPath: ':memory:',
      digestAt: undefined,
      prefetchMb: 0,
      cloudFolder: drive,
      log: (line) => logs.push(line),
    });
    const sent = await library.fetchAudio(url, 'Derech');
    assert.match(sent.fileName, /Ishay Ribo - Derech \(feat\. Zusha\)\.mp3/, 'sent under its proper name');
    const tags = readTextTags(new Uint8Array(await sent.data.arrayBuffer()));
    assert.deepEqual(
      [tags.TIT2, tags.TPE1, tags.TPE2, tags.TALB],
      ['Derech', 'Ishay Ribo; Zusha', 'Ishay Ribo', 'Derech - Single'],
      'every artist, so a music app lists it under each; the guest out of the title, since the artists say it',
    );
    await library.archive!.idle();
    assert.deepEqual(drive.uploads, ['Ishay Ribo/Singles/Derech (feat. Zusha).mp3']);
    assert.deepEqual(drive.files.get('Ishay Ribo/Singles/Derech (feat. Zusha).mp3'), new Uint8Array(await sent.data.arrayBuffer()), 'the copy in OneDrive is the file that was sent, tags and all, not a second tagging of it');
    assert.match(library.summary, /songs sent are saved to OneDrive/);
  });

  test('without a cloud folder nothing is saved, and a song is still sent tagged', async () => {
    const library = setUpLibrary({ catalog: new Catalog(':memory:'), musicTable: undefined, audio: { checkAudio: async () => ({ ok: true }) as never, fetchAudio: async () => song() }, dbPath: ':memory:', digestAt: undefined, prefetchMb: 0, log: () => {} });
    assert.equal(library.archive, undefined);
    const sent = await library.fetchAudio('https://x.test/a');
    assert.ok(sent.bytes > MPEG.length);
    assert.ok(readTextTags(new Uint8Array(await sent.data.arrayBuffer())).TIT2);
  });
});
