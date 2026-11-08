/**
 * The host's one turn at a time for sending a file to a chat.
 *
 * A song costs the host several times its own size while it is fetched, tagged and uploaded, and the cloud host's 512 MB hold one of
 * those, not two (a 27 MB song on top of 334 MB in use got the host killed on 2026-10-18). With several chats on one host, every
 * runner sends its files through one gate, so only one unit of work (a song, an album's zip, a few of an album's songs coming to
 * disk) is under way at a time, host-wide.
 *
 * A turn is a unit of work, not a whole answer: an `all` of twenty songs is twenty turns, and it waits between them (the gap
 * between songs is the runner's, outside the gate). Owners are served round-robin, so one waiting for the gate sits behind at most
 * one unit of anybody else's work (or, when that owner's unit is the first half of a file's turn, behind that file's two halves);
 * within an owner the units go first come, first served.
 *
 * A unit may also have things it started that are still under way when its work ends (the downloads a song's turn started for the
 * songs after it). It keeps the gate until they are in hand (`settle`), so that nothing it started runs while another owner's file is
 * under way. But while nobody else is waiting, the next unit of the same owner takes the gate over at once, with those still under
 * way (they become that unit's to wait for): a chat alone on the host is paced by its own gap and downloads, not held up by the
 * slowest download ahead of the file it is sending.
 */

/** Why a unit never ran: the owner gave up its place in line (see `run`'s `signal`). */
export class GateAborted extends Error {
  constructor() {
    super('gave up waiting for a turn at the delivery gate');
    this.name = 'GateAborted';
  }
}

export const isGateAborted = (err: unknown): err is GateAborted => err instanceof GateAborted;

export interface DeliveryGate {
  /**
   * Runs `work` when it is `owner`'s turn, and gives the result (or the failure) back; the gate is released when `work` ends, whichever
   * way, so a unit that throws never wedges the others. When the gate is free `work` starts at once, in this very call. A `signal` that
   * aborts while the unit is still waiting takes it out of the line and rejects with `GateAborted`; a unit that has started is not
   * interrupted (it may watch the signal itself). `first` marks a unit that is only the first half of a file's turn (the downloads
   * that start before the song's own turn): if its owner has another unit waiting when it ends, that one goes next, so a file's
   * two halves are not split by somebody else's whole unit. `settle` is what the unit started and has not finished when `work` ends:
   * the gate stays with the owner until it is done (a failure of it is ignored; the unit's own result is what `run` gives, once it
   * is done), except that while nobody else is waiting, the owner's next unit starts at once and takes over the wait. `settle` is
   * asked for when `work` ends.
   */
  run<T>(owner: string, work: () => Promise<T> | T, options?: { signal?: AbortSignal; first?: boolean; settle?: () => Promise<unknown> | unknown }): Promise<T>;
  /** Whether a unit is running or waiting, for any owner. */
  busy(): boolean;
  /** Whose unit is running now. */
  running(): string | undefined;
  /** Units waiting for their turn (not the one running): one owner's, or everybody's. */
  pending(owner?: string): number;
  /** Whether somebody other than `owner` is waiting, so a long job of `owner`'s should hand the gate over at its next natural pause. */
  contended(owner: string): boolean;
}

interface Entry {
  owner: string;
  work: () => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  first: boolean;
  /** What the unit started and keeps the gate for after its work has ended (see `run`). */
  settle?: () => Promise<unknown> | unknown;
  /** Stops listening for the abort signal once the unit has started. */
  detach?: () => void;
}

export function createDeliveryGate(): DeliveryGate {
  /** Each owner's units that are waiting, in the order they were handed over. An owner with nothing waiting has no entry. */
  const queues = new Map<string, Entry[]>();
  /**
   * The owners waiting for a turn, in the order they get it. An owner is here only while it has a unit waiting and none running:
   * when its unit ends it goes to the back, behind everybody who was already waiting, which is what makes the service round-robin.
   */
  const ring: string[] = [];
  let runningOwner: string | undefined;
  /** The unit that has the gate (a later unit of the same owner may take it over while this one only waits for its `settle`). */
  let holder: Entry | undefined;
  /** While the holder's work has ended and it only keeps the gate for what it started: when that is in hand. */
  let settling: Promise<void> | undefined;

  function release(owner: string, first: boolean): void {
    runningOwner = undefined;
    holder = undefined;
    settling = undefined;
    if (queues.has(owner) && !ring.includes(owner)) {
      if (first) ring.unshift(owner);
      else ring.push(owner);
    }
    pump();
  }

  /** `inherited` is what the unit before it (of the same owner) was still waiting for when this one took the gate over. */
  function start(entry: Entry, inherited?: Promise<void>): void {
    holder = entry;
    settling = undefined;
    entry.detach?.();
    let outcome: Promise<unknown>;
    try {
      outcome = Promise.resolve(entry.work());
    } catch (err) {
      outcome = Promise.reject(err);
    }
    outcome.then(
      (value) => finish(entry, inherited, () => entry.resolve(value)),
      (reason: unknown) => finish(entry, inherited, () => entry.reject(reason)),
    );
  }

  /** The unit's work has ended (whichever way): it gives the gate up when what it started is in hand, and only then is its result known. */
  function finish(entry: Entry, inherited: Promise<void> | undefined, answer: () => void): void {
    // Released first, so whoever continues after this unit finds the gate already on its way to the next one. A unit whose place was
    // taken over by the next of its owner has nothing to release: the gate is that unit's.
    const done = (): void => {
      if (holder === entry) release(entry.owner, entry.first);
      answer();
    };
    const waits: Array<Promise<unknown>> = [];
    if (inherited) waits.push(inherited);
    if (entry.settle) {
      try {
        waits.push(Promise.resolve(entry.settle()));
      } catch (err) {
        waits.push(Promise.reject(err));
      }
    }
    if (waits.length === 0) {
      done();
      return;
    }
    const inHand = Promise.all(waits.map((wait) => wait.catch(() => {}))).then(() => {});
    if (holder === entry) {
      settling = inHand;
      pump(); // the next unit of this owner, if it is waiting and nobody else is, takes over now
    }
    void inHand.then(done);
  }

  function pump(): void {
    if (runningOwner !== undefined) {
      const queue = settling ? queues.get(runningOwner) : undefined;
      if (!queue || ring.length > 0) return;
      const entry = queue.shift()!;
      if (queue.length === 0) queues.delete(runningOwner);
      start(entry, settling);
      return;
    }
    const owner = ring.shift();
    if (owner === undefined) return;
    const queue = queues.get(owner)!;
    const entry = queue.shift()!;
    if (queue.length === 0) queues.delete(owner);
    runningOwner = owner;
    start(entry);
  }

  return {
    run<T>(owner: string, work: () => Promise<T> | T, options?: { signal?: AbortSignal; first?: boolean; settle?: () => Promise<unknown> | unknown }): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(new GateAborted());
          return;
        }
        const entry: Entry = { owner, work, resolve: resolve as (value: unknown) => void, reject, first: options?.first ?? false, ...(options?.settle ? { settle: options.settle } : {}) };
        let queue = queues.get(owner);
        if (!queue) {
          queue = [];
          queues.set(owner, queue);
        }
        queue.push(entry);
        if (owner !== runningOwner && !ring.includes(owner)) ring.push(owner);
        if (signal) {
          const giveUp = (): void => {
            const waiting = queues.get(owner);
            const at = waiting ? waiting.indexOf(entry) : -1;
            if (!waiting || at < 0) return; // it has started: not interrupted
            waiting.splice(at, 1);
            if (waiting.length === 0) {
              queues.delete(owner);
              const place = ring.indexOf(owner);
              if (place >= 0) ring.splice(place, 1);
            }
            reject(new GateAborted());
          };
          signal.addEventListener('abort', giveUp, { once: true });
          entry.detach = () => signal.removeEventListener('abort', giveUp);
        }
        pump();
      });
    },
    busy: () => runningOwner !== undefined || queues.size > 0,
    running: () => runningOwner,
    pending(owner) {
      if (owner !== undefined) return queues.get(owner)?.length ?? 0;
      let total = 0;
      for (const queue of queues.values()) total += queue.length;
      return total;
    },
    contended(owner) {
      for (const [other, queue] of queues) if (other !== owner && queue.length > 0) return true;
      return false;
    },
  };
}
