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
  upload(path: string, data: Blob): Promise<void>;
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
  /** Told when saving songs starts failing (with what is wrong) and when it works again (undefined). */
  onProblem?: ((problem: string | undefined, needsLogin: boolean) => void) | undefined;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Songs waiting to be saved. More than this and the newest are not saved (the song is whole in memory until then). */
const MAX_WAITING = 3;
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
    const tagged = await tagSong(url, audio, { tagsOf: this.#options.tagsOf, fetchCover: this.#options.fetchCover });
    await drive.upload(place, tagged.data);
    state.setState(marker, '1');
    state.setState('onedrive.error', '');
    addArchived(state, tagged.bytes, when);
    this.#options.log?.(`saved ${place} to OneDrive (${(tagged.bytes / 1048576).toFixed(1)} MB)`);
  }
}
