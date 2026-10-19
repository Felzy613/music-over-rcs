import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { containerMemory, MemoryWatch, memoryCheck, processMemory, type ProcessMemory } from '../src/cloud/memory.ts';

const files = (max: string, stat: string) => (path: string): string => {
  if (path.endsWith('memory.max')) return max;
  if (path.endsWith('memory.stat')) return stat;
  throw new Error('ENOENT');
};
const STAT = 'anon 100000000\nfile 300000000\nkernel 5000000\nshmem 2000000\n';

test('reads the container’s limit and what really uses it (anonymous and shared memory, not the file cache)', () => {
  assert.deepEqual(containerMemory(files('536870912\n', STAT)), { limit: 536870912, used: 102000000 });
});

test('there is no answer where there is no limit or no container', () => {
  assert.equal(containerMemory(files('max\n', STAT)), undefined);
  assert.equal(containerMemory(files('536870912', 'nothing useful')), undefined);
  assert.equal(containerMemory(() => {
    throw new Error('ENOENT');
  }), undefined);
});

test('the bot’s check uses the container when there is one, else its own share when told one, else none', () => {
  const container = () => ({ limit: 512, used: 100 });
  assert.deepEqual(memoryCheck({}, { container })!(), { limit: 512, used: 100 });
  assert.deepEqual(memoryCheck({ BOT_MEMORY_MB: '220' }, { container: () => undefined, rss: () => 123 })!(), { limit: 220 * 1048576, used: 123 });
  assert.equal(memoryCheck({}, { container: () => undefined }), undefined);
  assert.equal(memoryCheck({ BOT_MEMORY_MB: 'lots' }, { container: () => undefined }), undefined);
});

// ---- who holds the memory

/** A made-up /proc: pid -> what its status and cmdline files say. */
function fakeProc(table: Record<string, { name: string; cmdline: string; rssKb?: number; anonKb?: number }>) {
  return {
    pids: () => Object.keys(table),
    read: (path: string): string => {
      const [, , pid, file] = path.split('/');
      const entry = table[pid!];
      if (!entry) throw new Error('ENOENT');
      if (file === 'cmdline') return entry.cmdline.split(' ').join('\0') + '\0';
      return `Name:\t${entry.name}\nState:\tS (sleeping)\n${entry.rssKb === undefined ? '' : `VmRSS:\t${entry.rssKb} kB\n`}${entry.anonKb === undefined ? '' : `RssAnon:\t${entry.anonKb} kB\n`}`;
    },
  };
}

test('names each process by what it runs, adds up the ones of a kind, and puts the biggest first', () => {
  const proc = fakeProc({
    '1': { name: 'tini', cmdline: 'tini -- node entrypoint.ts', rssKb: 800, anonKb: 100 },
    '7': { name: 'node', cmdline: 'node --disable-warning=ExperimentalWarning deploy/cloud/entrypoint.ts', rssKb: 61_440, anonKb: 40_960 },
    '60': { name: 'litestream', cmdline: '/usr/local/bin/litestream replicate -config /etc/litestream.yml', rssKb: 51_200, anonKb: 25_600 },
    '61': { name: 'python', cmdline: '/opt/venv/bin/python -m synapse.app.homeserver -c /data/synapse/homeserver.yaml', rssKb: 204_800, anonKb: 153_600 },
    '62': { name: 'node', cmdline: 'node --expose-gc --max-old-space-size=120 /app/src/cloud-main.ts', rssKb: 184_320, anonKb: 143_360 },
    '63': { name: 'mautrix-gmessage', cmdline: '/usr/local/bin/mautrix-gmessages -c /data/gmessages/config.yaml', rssKb: 92_160, anonKb: 71_680 },
    '90': { name: 'litestream', cmdline: '/usr/local/bin/litestream restore -config /etc/litestream.yml /data/catalog.db', rssKb: 30_720, anonKb: 10_240 },
    '2': { name: 'kthreadd', cmdline: '' }, // a kernel thread: no VmRSS
  });
  assert.deepEqual(processMemory(proc), [
    { name: 'synapse', count: 1, anonMb: 150, rssMb: 200 },
    { name: 'bot', count: 1, anonMb: 140, rssMb: 180 },
    { name: 'bridge', count: 1, anonMb: 70, rssMb: 90 },
    { name: 'supervisor', count: 1, anonMb: 40, rssMb: 60 },
    { name: 'litestream', count: 2, anonMb: 35, rssMb: 80 },
    { name: 'tini', count: 1, anonMb: 0, rssMb: 1 },
  ]);
});

test('an older kernel without RssAnon is counted by its resident size, and a process that ends while being read is left out', () => {
  const proc = fakeProc({ '5': { name: 'sh', cmdline: 'sh -c something', rssKb: 2048 } });
  assert.deepEqual(processMemory({ ...proc, pids: () => ['5', '404'] }), [{ name: 'sh', count: 1, anonMb: 2, rssMb: 2 }]);
});

test('where /proc cannot be listed (a Mac) there is nothing to say', () => {
  assert.deepEqual(
    processMemory({
      pids: () => {
        throw new Error('ENOENT');
      },
    }),
    [],
  );
});

// ---- the watch

function watchSetUp(options: { warnAtPercent?: number; warmUpMs?: number; firstReportMs?: number } = {}) {
  const MB = 1048576;
  const logs: string[] = [];
  let used = 300;
  let clock = Date.parse('2026-10-18T22:00:00Z');
  let reads = 0;
  const holders: ProcessMemory[] = [
    { name: 'synapse', count: 1, anonMb: 150, rssMb: 200 },
    { name: 'bot', count: 1, anonMb: 140, rssMb: 180 },
  ];
  const watch = new MemoryWatch({
    log: (line) => logs.push(line),
    read: () => (reads++, { limit: 512 * MB, used: used * MB }),
    processes: () => holders,
    current: () => 400 * MB,
    now: () => new Date(clock),
    ...options,
  });
  return { watch, logs, setUsed: (mb: number) => void (used = mb), tick: (ms: number) => void (clock += ms), reads: () => reads };
}

test('below the line it says nothing, but remembers the highest it saw and who held it then', () => {
  const { watch, logs, setUsed, tick } = watchSetUp();
  watch.check();
  setUsed(380);
  tick(5000);
  watch.check();
  setUsed(330);
  tick(5000);
  watch.check();
  assert.deepEqual(logs, []);
  const report = watch.report()!;
  assert.equal(report.usedMb, 330);
  assert.equal(report.limitMb, 512);
  assert.equal(report.percent, 64);
  assert.equal(report.currentMb, 400);
  assert.deepEqual(report.peak, { usedMb: 380, percent: 74, at: '2026-10-18T22:00:05.000Z', processes: [{ name: 'synapse', count: 1, anonMb: 150, rssMb: 200 }, { name: 'bot', count: 1, anonMb: 140, rssMb: 180 }] });
  assert.equal(report.warnAtPercent, 85);
});

test('past 85% it says who holds the memory, repeats only every 15 seconds while it stays high, and says when it is back down', () => {
  const { watch, logs, setUsed, tick } = watchSetUp();
  setUsed(450); // 88%
  watch.check();
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^memory: 450 of 512 MB in use \(88%\) - synapse 150 MB, bot 140 MB \(anonymous memory\)$/);
  tick(5000);
  watch.check();
  tick(5000);
  watch.check();
  assert.equal(logs.length, 1, 'not again within 15 s');
  tick(5000);
  setUsed(470);
  watch.check();
  assert.equal(logs.length, 2);
  assert.match(logs[1]!, /470 of 512 MB in use \(92%\)/);
  // down to 85%: not yet "back down" (it must be 5 points under the line)
  setUsed(436);
  tick(5000);
  watch.check();
  assert.equal(logs.length, 2);
  setUsed(380);
  tick(5000);
  watch.check();
  assert.equal(logs.length, 3);
  assert.match(logs[2]!, /^memory: back down to 380 of 512 MB \(74%\)$/);
  setUsed(300);
  tick(5000);
  watch.check();
  assert.equal(logs.length, 3, 'said once');
  assert.equal(watch.report()!.peak!.usedMb, 470, 'the high stays on record');
});

test('a routine line, with who holds what, is written 90 seconds after the start and then every six hours', () => {
  const { watch, logs, tick, setUsed } = watchSetUp();
  setUsed(252);
  watch.check();
  tick(60_000);
  watch.check();
  assert.deepEqual(logs, [], 'not yet');
  tick(31_000);
  watch.check();
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /^memory \(routine check\): 252 of 512 MB in use \(49%\) - synapse 150 MB, bot 140 MB \(anonymous memory\)$/);
  tick(5 * 3_600_000);
  watch.check();
  assert.equal(logs.length, 1, 'not before six hours');
  tick(3_600_000);
  watch.check();
  assert.equal(logs.length, 2);
  // a high reading says so in its own words, and then the routine line waits for its turn
  setUsed(460);
  tick(6 * 3_600_000);
  watch.check();
  assert.equal(logs.length, 3);
  assert.match(logs[2]!, /^memory: 460 of 512 MB/);
});

test('the line can be moved, and where there is no container limit there is nothing to watch or report', () => {
  const low = watchSetUp({ warnAtPercent: 50 });
  low.setUsed(300);
  low.watch.check();
  assert.equal(low.logs.length, 1);

  const none = new MemoryWatch({ log: () => assert.fail('it has nothing to say'), read: () => undefined });
  none.check();
  none.start();
  assert.equal(none.report(), undefined);
  none.stop();
});

describe('a rise that stays', () => {
  /** The routine line is put off for ever, so that the log holds only what is being tested. */
  const NEVER = 1e12;
  /** Looks every 5 s for this many seconds with this much in use. */
  const stay = (set: ReturnType<typeof watchSetUp>, usedMb: number, seconds: number) => {
    set.setUsed(usedMb);
    for (let waited = 0; waited < seconds; waited += 5) {
      set.tick(5000);
      set.watch.check();
    }
  };

  test('is reported once, 45 s after it began, naming who holds it, and again when it has settled', () => {
    const set = watchSetUp({ warmUpMs: 0, firstReportMs: NEVER });
    stay(set, 250, 120); // resting
    assert.deepEqual(set.logs, []);
    stay(set, 360, 40); // up, but not for long enough yet
    assert.deepEqual(set.logs, []);
    stay(set, 360, 20);
    assert.equal(set.logs.length, 1);
    assert.match(set.logs[0]!, /^memory \(raised\): 360 of 512 MB in use \(70%\), 110 MB above its resting 250 MB for 45 s - synapse 150 MB, bot 140 MB \(anonymous memory\)$/);
    assert.ok(set.watch.report()!.raisedSince, 'and /status says it is up');
    assert.equal(set.watch.report()!.restMb, 250);
    stay(set, 365, 300); // it stays up for five minutes: said once
    assert.equal(set.logs.length, 1);
    stay(set, 285, 5); // down, but not yet within 30 MB of where it rested
    assert.equal(set.logs.length, 1);
    stay(set, 270, 5);
    assert.equal(set.logs.length, 2);
    assert.match(set.logs[1]!, /^memory \(settled\): 270 of 512 MB in use \(53%\), back to its resting 250 MB level \d+ s after it rose - synapse 150 MB, bot 140 MB \(anonymous memory\)$/);
    assert.equal(set.watch.report()!.raisedSince, undefined);
    stay(set, 255, 120);
    assert.equal(set.logs.length, 2, 'said once');
  });

  test('a blip, a rise of less than 60 MB, and a slow creep are not reported', () => {
    const set = watchSetUp({ warmUpMs: 0, firstReportMs: NEVER });
    stay(set, 250, 60);
    stay(set, 340, 30); // a blip: up for 30 s only
    stay(set, 255, 60);
    stay(set, 305, 300); // 55 MB above: not a rise
    stay(set, 250, 60);
    for (let mb = 250; mb < 290; mb += 0.5) stay(set, mb, 5 * 6); // creeping up by a MB a minute, for an hour and more
    assert.deepEqual(set.logs, []);
  });

  test('the start is left alone: nothing in the first three minutes', () => {
    const set = watchSetUp({ firstReportMs: NEVER }); // the default warm-up
    stay(set, 150, 30);
    stay(set, 260, 140); // up by 110 MB while everything settles in, and it stays: 170 s in
    assert.deepEqual(set.logs, []);
    stay(set, 262, 60); // the rest is read from here on
    stay(set, 380, 60);
    assert.equal(set.logs.length, 1);
    assert.match(set.logs[0]!, /^memory \(raised\): 380 of 512 MB in use \(74%\), 118 MB above its resting 262 MB/);
  });

  test('one that does not come back in half an hour is let go of, and a new rise from there is reported again', () => {
    const set = watchSetUp({ warmUpMs: 0, firstReportMs: NEVER, warnAtPercent: 95 });
    stay(set, 250, 120);
    stay(set, 360, 60);
    assert.equal(set.logs.length, 1);
    stay(set, 362, 31 * 60); // half an hour and more up there: it is the resting level now
    assert.equal(set.logs.length, 1, 'no more said about it');
    stay(set, 362, 20 * 60);
    stay(set, 440, 60); // 78 MB above the new level
    assert.equal(set.logs.filter((line) => /raised/.test(line)).length, 2);
    assert.match(set.logs.filter((line) => /raised/.test(line)).at(-1)!, /78 MB above its resting 362 MB/);
  });
});
