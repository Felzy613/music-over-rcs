import { tagSong } from '../library/audio-cache.ts';
import type { CoverPicture, SongTags } from '../library/id3.ts';
import type { DownloadedAudio } from '../audio-fetch.ts';
import { addArchived, archivedThisMonth } from '../usage.ts';

interface StateStore {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

/** Where songs are saved: a cloud folder (OneDrive). */
export interface Drive {
  connected(): boolean;
  exists(path: string): Promise<boolean>;
  upload(path: string, data: Uint8Array): Promise<void>;
}

export interface SongArchiveOptions {
  drive: Drive;
  state: StateStore;
  /** Where a song goes in the folder: "Artist/Album/01 Title.mp3". */
  placeOf: (url: string, audio: { fileName: string; mimeType: string }) => string;
  tagsOf: (url: string, audio: { fileName: string; mimeType: string }) => SongTags | undefined;
  fetchCover?: ((url: string) => Promise<CoverPicture | undefined>) | undefined;
  /** The most to upload in a calendar month, in bytes. Undefined for no limit. */
  monthlyBudgetBytes?: number | undefined;
  /**
   * What memory there is and how much is used, for a host with little (see memory.ts). Beyond the copy the bot already holds, a song
   * takes two more copies of its size while it is tagged and uploaded; when that doesn't fit with some room to spare, the song waits a
   * while for other work to finish, and is skipped if it never does: the song has been sent in any case, and a crashed host helps
   * nobody. Undefined for no limit.
   */
  memory?: (() => { limit: number; used: number } | undefined) | undefined;
  /** How long a song waits before it is saved, so that the send that fetched it is over and its memory is free (default 5 s). */
  delayMs?: number | undefined;
  /** Test hook: a wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Told when saving songs starts failing (with what is wrong) and when it works again (undefined). */
  onProblem?: ((problem: string | undefined, needsLogin: boolean) => void) | undefined;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Songs waiting to be saved. More than this and the newest are not saved (the song is whole in memory until then). */
const MAX_WAITING = 3;
/** Memory kept free beyond what a song needs, in bytes. */
const MEMORY_HEADROOM = 40 * 1048576;
/** Failed saves in a row before it is called a problem. */
const FAILURES_BEFORE_PROBLEM = 3;

/**
 * Saves each song the bot sends to a cloud folder, tagged and sorted like a music library, without making the person who
 * asked for it wait: the song is offered after it is fetched, and a single worker uploads it in the background. A song
 * already saved is not saved again, and nothing is saved once the month's allowance is used (uploads share the host's
 * outbound traffic with the songs sent to Google Messages).
 */
export class SongArchive {
  #options: SongArchiveOptions;
  #queue: Array<{ url: string; audio: DownloadedAudio }> = [];
  #working: Promise<void> | undefined;
  #failures = 0;
  #told = false;
  #budgetNoticeMonth: string | undefined;

  constructor(options: SongArchiveOptions) {
    this.#options = options;
  }

  /** How many songs are waiting or being saved. */
  pending(): number {
    return this.#queue.length + (this.#working ? 1 : 0);
  }

  /** Resolves when everything offered so far has been dealt with. */
  async idle(): Promise<void> {
    while (this.#working) await this.#working;
  }

  /** Offers a song that was just fetched. Returns at once. */
  offer(url: string, audio: DownloadedAudio): void {
    if (!this.#options.drive.connected()) return;
    if (this.#queue.length >= MAX_WAITING) {
      this.#options.log?.(`not saving ${audio.fileName} to OneDrive: ${MAX_WAITING} songs are already waiting`);
      return;
    }
    this.#queue.push({ url, audio });
    if (!this.#working) this.#start();
  }

  #start(): void {
    this.#working = this.#work().finally(() => {
      this.#working = undefined;
      // A song offered just as the worker finished still gets its turn.
      if (this.#queue.length > 0) this.#start();
    });
  }

  async #work(): Promise<void> {
    for (let item = this.#queue.shift(); item; item = this.#queue.shift()) {
      try {
        await (this.#options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(this.#options.delayMs ?? 5000);
        await this.#save(item.url, item.audio);
        this.#failures = 0;
        if (this.#told) {
          this.#told = false;
          this.#options.onProblem?.(undefined, false);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const needsLogin = (err as { needsLogin?: boolean }).needsLogin === true;
        this.#failures += 1;
        this.#options.state.setState('onedrive.error', message);
        this.#options.log?.(`could not save ${item.audio.fileName} to OneDrive: ${message}`);
        if ((needsLogin || this.#failures >= FAILURES_BEFORE_PROBLEM) && !this.#told) {
          this.#told = true;
          this.#options.onProblem?.(message, needsLogin);
        }
      }
    }
  }

  /** Waits (up to two minutes) until this song fits in the memory there is to spare; false, with a note, if it never does. */
  async #roomFor(bytes: number, place: string): Promise<boolean> {
    const memory = this.#options.memory;
    if (!memory) return true;
    const sleep = this.#options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    // Two more copies of the song, one upload piece (10 MiB), and room to spare for everything else that may move meanwhile.
    const needed = 2 * bytes + 10 * 1048576 + MEMORY_HEADROOM;
    for (let waited = 0; waited <= 120_000; waited += 3000) {
      // The bot runs with --expose-gc on a small host: free what the send left behind before measuring.
      (globalThis as { gc?: () => void }).gc?.();
      const use = memory();
      if (!use || use.limit - use.used >= needed) return true;
      await sleep(3000);
    }
    this.#options.log?.(`not saving ${place} to OneDrive: it is ${(bytes / 1048576).toFixed(0)} MB and this host has too little memory to spare for it`);
    return false;
  }

  async #save(url: string, audio: DownloadedAudio): Promise<void> {
    const { drive, state, now } = this.#options;
    const place = this.#options.placeOf(url, audio);
    const marker = `archive.done:${place}`;
    if (state.getState(marker)) return;
    const budget = this.#options.monthlyBudgetBytes;
    const when = now?.() ?? new Date();
    if (budget !== undefined && archivedThisMonth(state, when) + audio.bytes > budget) {
      const month = when.toISOString().slice(0, 7);
      if (this.#budgetNoticeMonth !== month) {
        this.#budgetNoticeMonth = month;
        this.#options.log?.(`not saving songs to OneDrive for the rest of ${month}: the month's allowance (${Math.round(budget / 1048576)} MB) is used`);
      }
      return;
    }
    if (await drive.exists(place)) {
      state.setState(marker, '1');
      return;
    }
    if (!(await this.#roomFor(audio.bytes, place))) return;
    const tagged = await tagSong(url, audio, { tagsOf: this.#options.tagsOf, fetchCover: this.#options.fetchCover });
    await drive.upload(place, tagged.data);
    state.setState(marker, '1');
    state.setState('onedrive.error', '');
    addArchived(state, tagged.bytes, when);
    this.#options.log?.(`saved ${place} to OneDrive (${(tagged.bytes / 1048576).toFixed(1)} MB)`);
  }
}
