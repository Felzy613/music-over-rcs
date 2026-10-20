import { openAsBlob } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioFetchError, type DownloadedAudio } from './audio-fetch.ts';
import { ALL_WORDS, joinLists, type Bot } from './bot.ts';
import type { DownloadedImage } from './image-fetch.ts';
import type { Picture, PreparedPicture } from './library/images.ts';
import { writeWithCrc32, zipBlob, zipEntryOverhead, zipName, zipSize } from './library/zip.ts';
import type { AlbumSong, Chip, Incoming, NumberedChoice, Reply } from './types.ts';

/**
 * Every message the bot writes starts with this. In a chat with yourself the bot's replies look like your own
 * messages, so this marker is how it tells them apart and never answers itself.
 */
export const BOT_MARK = '🎵';
/** Or with one of these, which say what the message is: an album to pick (💿), an artist's name over a list (🎤). */
export const KIND_MARKS = ['💿', '🎤'] as const;
/** What an add-on passes on from elsewhere (see extensions.ts) starts with this instead; the bot never answers those either. */
export const RELAY_MARK = '🤖';
/** An invisible left-to-right mark (U+200E). */
const LEFT_TO_RIGHT = '\u200e';
/**
 * A list's closing line (how to pick from it: 'Text "more" for more of …') is neither a song nor an album, so where a 👍
 * picks it shows no mark (the owner asked for no 🎵 there, 2026-10-18): it starts with this invisible left-to-right
 * mark instead, which is what tells the bot it wrote it.
 */
export const HINT_MARK = LEFT_TO_RIGHT;
const isBotText = (text: string): boolean => [BOT_MARK, ...KIND_MARKS, RELAY_MARK, HINT_MARK].some((mark) => text.startsWith(mark));

const SEEN_LIMIT = 2000;
/** Message ids kept in the resume point. */
const RESUME_IDS = 200;
/** After a restart, requests older than this are not answered. */
const CATCH_UP_MS = 2 * 60 * 60_000;
/**
 * In a chat with yourself, a phone can show one text twice (as sent and as received), and the bridge passes both on.
 * A request repeated word for word within this long is taken as an echo of the first, not a new request.
 */
const REPEAT_WINDOW_MS = 20_000;
/** Songs downloading at once, ahead of their turn to be sent (unless the runner is told another number). */
const DOWNLOADS_AHEAD = 3;
/** Covers being drawn at once, ahead of their turn. Each is a separate drawing process, so only a couple. */
const PICTURES_AHEAD = 2;
const CHOICE_HINT = 'Reply with a number to choose.';
/** What a number gets where a 👍 picks and the list has no numbers. */
const LIKE_HINT = 'To get a song from the list, tap 👍 on it.';
/** How long a list of options stays pickable. The list is still on screen, so a 👍 or a number is still an answer to it. */
const CHOICE_TTL_MS = 30 * 60_000;
/** The most one file may weigh, unless told otherwise: Google Messages and the bridge take about 100 MB. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Circuit breaker: the most answers (and announcements) sent in a minute, unless the runner is told another number. */
const MAX_ANSWERS_PER_MINUTE = 30;
/** The most messages one answer may have; the rest is dropped. The longest real one, an album's songs, is about 50. */
const MAX_MESSAGES_PER_ANSWER = 200;
const ERROR_NOTICE = 'Something went wrong on my side. Please try again in a moment.';

/** Hebrew words (with the spaces between them) followed by something that isn't Hebrew. */
const HEBREW_THEN_MORE = /[\u0590-\u05ff](?:[\u0590-\u05ff\s]*[\u0590-\u05ff])?(?=\s*[^\s\u0590-\u05ff])/gu;

/**
 * A message as the bot sends it: starting with its mark, and laid out left to right like the rest. A phone lays a
 * message out right to left when its first letter is Hebrew ("🎵 שבת — Yoely Weiss"), and pulls what follows a Hebrew
 * title into it ("💿 אלעזר ליפא׳לע · 2025 · 15 songs" shows as "15 · 2025 · אלעזר ליפא׳לע songs"), so an invisible
 * left-to-right mark goes after the bot's own mark and after each stretch of Hebrew that something else follows.
 */
export const markBotText = (text: string): string => {
  const marked = isBotText(text) ? text : `${BOT_MARK} ${text}`;
  if (!/[\u0590-\u05ff]/.test(marked) || marked.includes(LEFT_TO_RIGHT)) return marked;
  return leftToRight(marked);
};

/** A list's closing line as the bot sends it where a 👍 picks: starting with HINT_MARK, and laid out left to right. */
export const markHint = (text: string): string => {
  if (text.startsWith(HINT_MARK)) return text;
  return `${HINT_MARK}${/[\u0590-\u05ff]/.test(text) ? leftToRight(text) : text}`;
};

/** A left-to-right mark after each stretch of Hebrew that something else follows, and after the first word when it is Hebrew. */
function leftToRight(text: string): string {
  const runs = text.replace(HEBREW_THEN_MORE, (run) => `${run}${LEFT_TO_RIGHT}`);
  const firstLetter = /\p{L}/u.exec(runs)?.[0] ?? '';
  return /[\u0590-\u05ff]/.test(firstLetter) ? runs.replace(/^(\S+ ?)/u, `$1${LEFT_TO_RIGHT}`) : runs;
}

/** A line with its number shown after its mark: "💿 2. Shuki · 2024 · 12 songs", "3. Escape" (and then "🎵 3. Escape"). */
export const withNumber = (text: string, n: number): string => {
  const mark = [...KIND_MARKS, BOT_MARK].find((one) => text.startsWith(one));
  return mark ? `${mark} ${n}. ${text.slice(mark.length).trimStart()}` : `${n}. ${text}`;
};

/** A thumbs up, in any skin tone. */
export const isLike = (key: string): boolean => /^👍[\u{1F3FB}-\u{1F3FF}]?\uFE0F?$/u.test(key.trim());

/** A message in a chat, reduced to what the runner needs, whatever platform it came from. */
export interface ChatMessage {
  id: string;
  timestamp: string;
  text?: string | undefined;
  /** 'TEXT' (or undefined) for plain text; anything else is ignored. */
  type?: string | undefined;
  hasAttachments: boolean;
  isDeleted: boolean;
  /** A delivery failure notice emitted by the mautrix Google Messages bot. */
  bridgeSendFailure?: boolean | undefined;
  /** A reaction (👍…) to another message, rather than a message of its own. */
  reaction?: { to: string; key: string } | undefined;
  /** A picture sent from the phone (not one the bot sent), when the platform passes those on. */
  picture?: IncomingPicture | undefined;
}

/** A picture sent from the phone: where to download it, and the text sent with it. */
export interface IncomingPicture {
  /** Where the platform keeps it (an mxc:// address on Matrix). */
  url: string;
  mimeType: string;
  name: string;
  /** The text sent with the picture, if any. */
  caption?: string;
  /** The message it belongs to. A picture can arrive more than once (a preview, then the full picture), all with this. */
  of: string;
  bytes?: number;
  /** When it was sent from the phone (Unix ms), which can be long before it arrives. */
  sentAt?: number;
  /** False when this is only a preview and the full picture is still on its way. */
  complete?: boolean;
}

/** What the runner needs from a chat platform: read what's new in one chat, and write to it. */
export interface ChatClient {
  /** Messages the runner may not have seen yet, oldest first. Repeats are fine; the runner de-duplicates by id. */
  listMessages(chatID: string): Promise<ChatMessage[]>;
  /** Sends a text; returns the message's id when the platform gives one (a 👍 on it can then be matched). */
  sendText(chatID: string, text: string): Promise<string | void>;
  sendAudio(chatID: string, audio: DownloadedAudio): Promise<string | void>;
  /** Sends a file that isn't audio or a picture (an album's ZIP). Platforms that can't leave it out, and the songs go one by one. */
  sendFile?(chatID: string, file: { data: Blob; fileName: string; mimeType: string; bytes: number }): Promise<string | void>;
  /** Sends a picture (album art). Platforms that can't leave it out, and pictures are skipped. */
  sendImage?(chatID: string, image: DownloadedImage): Promise<string | void>;
  /**
   * True when a 👍 tapped on a message reaches the bot. Then lists go one entry per message, without numbers, and a
   * 👍 picks; otherwise each list is one numbered message, and a number picks.
   */
  readonly reactions?: boolean;
  /** Shows or clears "typing…" in the chat. Platforms that can't do this leave it out. */
  setTyping?(chatID: string, typing: boolean): Promise<void>;
  /** What a message in the chat says, by its id (undefined when it's gone or has no text). Platforms that can't leave it out. */
  messageText?(chatID: string, messageId: string): Promise<string | undefined>;
}

/**
 * The options on offer: the list's chips (what "all" sends, and what "2" means where every line is numbered), the
 * numbers shown where a 👍 picks the rest (an album's), since when, and for how long.
 */
export interface PendingChoices {
  chips: Chip[];
  numbers?: NumberedChoice[];
  at: number;
  validMs: number;
}

/**
 * Where the options on offer are kept outside this process, so a list sent by another one (the daily message sent
 * from the command line) or offered before a restart still answers a number. The newest list wins.
 */
export interface ChoiceStore {
  load(): PendingChoices | undefined;
  save(choices: PendingChoices | undefined): void;
}

/** Which sent messages stand for one song, so a 👍 on one gets that song. Kept beyond this process when given. */
export interface MessageLinks {
  link(messageId: string, postback: string): void;
  lookup(messageId: string): string | undefined;
}

/** How far the runner got in the chat, so a restart answers what arrived while it was down instead of dropping it. */
export interface ResumePoint {
  /** When the newest message dealt with was sent (Unix ms). */
  at: number;
  /** The newest messages dealt with, so none is answered twice. */
  ids: string[];
}

/** Where the resume point is kept beyond this process. */
export interface ResumeStore {
  load(): ResumePoint | undefined;
  save(point: ResumePoint): void;
}

export interface RunnerOptions {
  chat: ChatClient;
  bot: Bot;
  chatID: string;
  fetchAudio(url: string, title: string | undefined): Promise<DownloadedAudio>;
  /** Gets a picture ready to send (a song's card, the daily collage). Without it, pictures are skipped. */
  prepareImage?(picture: Picture): Promise<PreparedPicture>;
  pollMs?: number;
  /** How often "typing…" is renewed while a request is being worked on. It has to be shorter than the platform's timeout. */
  typingRefreshMs?: number;
  /** Keeps the options on offer beyond this process. Without it they live only here. */
  choices?: ChoiceStore;
  /** Keeps which messages stand for which song. Without it, only this run's messages answer a 👍. */
  links?: MessageLinks;
  /** Keeps how far the runner got. With it, a start answers requests that arrived while the bot was down; without, it starts from now. */
  resume?: ResumeStore;
  /** The oldest request still answered after a restart (default 2 hours): older ones are left alone. */
  catchUpMs?: number;
  /** Songs downloading at once, ahead of their turn (default 3). A small host holds each whole file in memory, so it sets fewer. */
  downloadsAhead?: number;
  /**
   * Circuit breaker: at most this many answers (and announcements) a minute; past it, a request gets no answer (default
   * 30). It counts answers, not messages: a loop (the bot answering itself) shows as answer after answer, while a long
   * list (an album's songs, one message each so each can be 👍'd) is one answer, and it has to arrive whole.
   */
  maxAnswersPerMinute?: number;
  /**
   * The least time between two songs, so the phone has sent one before the next arrives (three 👍 in a row, "all").
   * A song's card waits with it. 0, the default, sends them as fast as they're ready.
   */
  songGapMs?: number;
  /** The most one file sent to the chat may weigh, in bytes; an album bigger than this goes as several ZIPs. Defaults to 100 MB. */
  maxFileBytes?: number;
  /** Where an album's songs wait on disk while its ZIP is made and sent (the system's temporary folder unless given). */
  spoolDir?: string;
  /** Waits; tests pass one that doesn't. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  /** Told after each poll whether the chat answered, and how many times in a row it hasn't. */
  onPoll?: (ok: boolean, failuresInARow: number, error?: string) => void;
  /** Gets each picture sent from the phone (they're not requests; an add-on can take them). Without it they're ignored. */
  onPicture?: (picture: IncomingPicture) => void;
  /** Restarts the Google Messages bridge after it reports that a message could not be delivered. */
  onBridgeSendFailure?: () => void | Promise<void>;
}

export interface Runner {
  /**
   * Marks the chat's current messages as seen, so history is never replayed. With a resume point, messages sent after
   * it (while the bot was down) are kept to be answered by the next tick instead.
   */
  prime(): Promise<void>;
  /** Reads the chat once and answers any new requests. */
  tick(): Promise<void>;
  /** Sends messages the bot starts itself (the daily new-music message), never in the middle of answering a request. */
  announce(replies: Reply[]): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** On a small host the bot runs with --expose-gc: an album's part, once sent, is given back at once instead of whenever. */
const freeMemory = (): void => (globalThis as { gc?: () => void }).gc?.();

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const normalize = (text: string | undefined): string => (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Watches one chat and answers song requests typed into it. */
export function createRunner(options: RunnerOptions): Runner {
  const { chat, bot, chatID } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 1500;
  const typingRefreshMs = options.typingRefreshMs ?? 20_000;
  const maxAnswers = options.maxAnswersPerMinute ?? MAX_ANSWERS_PER_MINUTE;
  const songGapMs = options.songGapMs ?? 0;
  const catchUpMs = options.catchUpMs ?? CATCH_UP_MS;
  const downloadsAhead = Math.max(1, options.downloadsAhead ?? DOWNLOADS_AHEAD);

  const seen = new Set<string>();
  /** Messages that arrived while the bot was down, answered by the first tick. */
  const backlog: ChatMessage[] = [];
  /** When the newest message dealt with was sent, and whether that has changed since the resume point was saved. */
  let lastAt = 0;
  let unsaved = false;
  /** When each answer of the last minute was sent. */
  const answerTimes: number[] = [];
  /** The list of options last offered. A pick keeps it, so another number from the same list works; a new search ends it. */
  let pending: PendingChoices | undefined;
  /** This run's messages that stand for a song, for when no store is given. */
  const localLinks = new Map<string, string>();

  function rememberLink(messageId: string | void, postback: string | undefined): void {
    if (!messageId || !postback) return;
    try {
      if (options.links) options.links.link(messageId, postback);
      else {
        localLinks.set(messageId, postback);
        if (localLinks.size > 500) localLinks.delete(localLinks.keys().next().value!);
      }
    } catch (err) {
      log(`could not remember which song a message stands for: ${errorText(err)}`);
    }
  }

  /**
   * When the phone is slow to confirm a send, the bridge calls it undelivered and then shows the phone's own copy of
   * it as a new message with another id, and that copy is what a 👍 lands on. A song's text is kept as a link too,
   * so such a copy still answers.
   */
  const textKey = (text: string): string => `text:${text.trim().replace(/\s+/g, ' ')}`;

  /** Sends a text that may stand for a song, and remembers which. */
  async function sendLinkedText(text: string, postback: string | undefined): Promise<void> {
    const id = await chat.sendText(chatID, text);
    rememberLink(id, postback);
    rememberLink(textKey(text), postback);
  }

  /** The song a 👍 on this message asks for: the message itself, or else a copy of one that stood for a song. */
  async function postbackFor(messageId: string): Promise<string | undefined> {
    const direct = linkedTo(messageId);
    if (direct || !chat.messageText) return direct;
    try {
      const text = await chat.messageText(chatID, messageId);
      const copied = text ? linkedTo(textKey(text)) : undefined;
      if (copied) log(`a 👍 on a copy of a message (the phone's, with another id) was matched by what it says`);
      return copied;
    } catch (err) {
      log(`could not read the message a 👍 is on: ${errorText(err)}`);
      return undefined;
    }
  }

  function linkedTo(messageId: string): string | undefined {
    try {
      return options.links ? options.links.lookup(messageId) : localLinks.get(messageId);
    } catch (err) {
      log(`could not look up which song a message stands for: ${errorText(err)}`);
      return undefined;
    }
  }

  /** The newest list on offer, here or in the store. */
  function currentChoices(): PendingChoices | undefined {
    try {
      const stored = options.choices?.load();
      if (stored && (!pending || stored.at > pending.at)) pending = stored;
    } catch (err) {
      log(`could not read the options on offer: ${errorText(err)}`);
    }
    return pending;
  }

  function setChoices(next: PendingChoices | undefined): void {
    pending = next;
    try {
      options.choices?.save(next);
    } catch (err) {
      log(`could not keep the options on offer: ${errorText(err)}`);
    }
  }
  let lastRequest: { text: string; at: number } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = true;
  let current: Promise<void> | undefined;
  /** The answers with a song, picture or album in them, sent one at a time, in the order they were asked for (see `send`). */
  let delivery: Promise<void> = Promise.resolve();
  /** How many of those are waiting or under way. */
  let delivering = 0;
  let failures = 0;
  /** When the last song went out, so the next one waits its turn. */
  let lastSongAt: number | undefined;
  /** Ends a wait for a song's turn early, when the runner is stopping. */
  let wake: (() => void) | undefined;

  function pause(ms: number): Promise<void> {
    if (options.sleep) return options.sleep(ms);
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(waiting);
        wake = undefined;
        resolve();
      };
      const waiting = setTimeout(done, ms);
      wake = done;
    });
  }

  /** Waits until the last song has had songGapMs to go out from the phone. */
  async function songTurn(): Promise<void> {
    if (lastSongAt === undefined) return;
    const wait = lastSongAt + songGapMs - now();
    if (wait <= 0) return;
    log(`next song in ${Math.ceil(wait / 1000)} s`);
    await pause(wait);
  }

  function remember(id: string): void {
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
  }

  function allowAnswer(): boolean {
    const cutoff = now() - 60_000;
    while (answerTimes.length > 0 && answerTimes[0]! < cutoff) answerTimes.shift();
    if (answerTimes.length >= maxAnswers) return false;
    answerTimes.push(now());
    return true;
  }

  function shouldHandle(message: ChatMessage): boolean {
    if (message.isDeleted || message.hasAttachments) return false;
    if (message.type !== undefined && message.type !== 'TEXT') return false;
    const text = message.text?.trim();
    return Boolean(text) && !isBotText(text!);
  }

  function isRepeat(message: ChatMessage): boolean {
    return lastRequest !== undefined && lastRequest.text === normalize(message.text) && now() - lastRequest.at < REPEAT_WINDOW_MS;
  }

  /**
   * An album, as one ZIP of its songs (named like the album, each song "01 Title.m4a"), or, when it is bigger than
   * maxFileBytes (100 MB: what the bridge and Google Messages take), as several, each saying which part it is. The songs
   * are downloaded in album order (downloadsAhead at a time) and each is written to a folder on disk as soon as it is in
   * hand, so the album is never held in memory: the ZIP is made of the files as they are on disk, and the chat streams it
   * from there. A chat that can't take a file gets the songs one by one instead. A song that can't be had is left out,
   * and the chat is told.
   */
  async function sendAlbum(album: Extract<Reply, { kind: 'album' }>): Promise<void> {
    const missing: string[] = [];
    const said = async (text: string): Promise<void> => {
      await chat.sendText(chatID, markBotText(text));
    };
    // The songs in album order, the next ones downloading while one is used, never more than downloadsAhead at once.
    const ahead: Array<Promise<DownloadedAudio | undefined>> = [];
    let started = 0;
    const next = (): Promise<DownloadedAudio | undefined> => {
      while (started < album.songs.length && ahead.length < downloadsAhead) {
        const song = album.songs[started++]!;
        ahead.push(
          options.fetchAudio(song.url, song.title).catch((err: unknown) => {
            log(`could not get ${song.title} ready: ${errorText(err)}`);
            missing.push(song.title);
            return undefined;
          }),
        );
      }
      return ahead.shift()!;
    };
    let had = 0;

    if (!chat.sendFile) {
      for (const song of album.songs) {
        const file = await next();
        if (!file) continue;
        had += 1;
        await songTurn();
        try {
          await chat.sendAudio(chatID, file);
          lastSongAt = now();
          log(`-> audio ${song.title}`);
        } catch (err) {
          log(`could not send audio: ${errorText(err)}`);
          missing.push(song.title);
        }
        freeMemory();
      }
    } else {
      const sendFile = chat.sendFile.bind(chat);
      const limit = options.maxFileBytes ?? MAX_FILE_BYTES;
      const digits = Math.max(2, String(Math.max(...album.songs.map((song) => song.number))).length);
      const stem = (song: AlbumSong): string => zipName(`${String(song.number).padStart(digits, '0')} ${song.title}`);
      const folder = await mkdtemp(join(options.spoolDir ?? tmpdir(), 'album-'));
      try {
        // Every song on disk first, with the checksum its place in the ZIP needs; then the parts are known exactly.
        const songs: Array<{ name: string; data: Blob; crc: number }> = [];
        for (const song of album.songs) {
          const file = await next();
          if (!file) continue;
          had += 1;
          const extension = /\.[a-z0-9]{2,5}$/i.exec(file.fileName)?.[0].toLowerCase() ?? '.audio';
          const path = join(folder, `${String(songs.length + 1).padStart(3, '0')}${extension}`);
          const crc = await writeWithCrc32(file.data, path);
          songs.push({ name: `${stem(song)}${extension}`, data: await openAsBlob(path, { type: file.mimeType }), crc });
          freeMemory(); // the song as it was downloaded, now that it is on disk
        }
        const parts: Array<typeof songs> = [];
        let used = zipSize([]);
        for (const song of songs) {
          const cost = zipEntryOverhead(song.name) + song.data.size;
          if (parts.length === 0 || (parts.at(-1)!.length > 0 && used + cost > limit)) {
            parts.push([]);
            used = zipSize([]);
          }
          parts.at(-1)!.push(song);
          used += cost;
        }
        const base = zipName(`${album.artist ? `${album.artist} - ` : ''}${album.title}`);
        for (const [i, part] of parts.entries()) {
          const fileName = `${base}${parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : ''}.zip`;
          const zip = zipBlob(part);
            await songTurn();
          try {
            await sendFile(chatID, { data: zip, fileName, mimeType: 'application/zip', bytes: zip.size });
          } catch (err) {
            log(`could not send the zip: ${errorText(err)}`);
            return said(`I couldn't send "${album.title}" as a zip.`);
          } finally {
            freeMemory();
          }
          lastSongAt = now();
          log(`-> zip ${fileName} (${part.length} songs, ${zip.size} bytes)`);
        }
      } finally {
        await rm(folder, { recursive: true, force: true }).catch((err: unknown) => log(`could not clear ${folder}: ${errorText(err)}`));
      }
    }
    if (had === 0) return said(`I couldn't get any of "${album.title}".`);
    if (missing.length > 0) await said(`I couldn't get ${missing.length === 1 ? 'one song' : `${missing.length} songs`} of "${album.title}": ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}.`);
  }

  async function respond(answer: Reply[]): Promise<void> {
    if (answer.length === 0) return;
    if (!allowAnswer()) {
      log(`answer limit reached (${maxAnswers} a minute); not sending this answer`);
      return;
    }
    const replies = chat.reactions ? answer : joinLists(answer);
    // Songs start downloading ahead of their turn, so a song gets ready while its picture is drawn and sent; at most
    // DOWNLOADS_AHEAD at a time, so "all" doesn't fetch twenty files at once.
    const songs = replies.filter((reply): reply is Extract<Reply, { kind: 'audio' }> => reply.kind === 'audio');
    const files = new Map<Reply, Promise<DownloadedAudio>>();
    let started = 0;
    let sentSongs = 0;
    const startDownloads = (): void => {
      while (started < songs.length && started - sentSongs < downloadsAhead) {
        const song = songs[started++]!;
        const file = options.fetchAudio(song.url, song.title);
        file.catch(() => {}); // handled when it's sent
        files.set(song, file);
      }
    };
    startDownloads();
    // Covers are drawn ahead too, so a song's card is ready when its turn comes instead of being drawn after the wait.
    const pictures = replies.filter((reply): reply is Picture => reply.kind === 'image' || reply.kind === 'collage');
    const drawn = new Map<Reply, Promise<PreparedPicture>>();
    let drawing = 0;
    let sentPictures = 0;
    const startPictures = (): void => {
      if (!chat.sendImage || !options.prepareImage) return;
      while (drawing < pictures.length && drawing - sentPictures < PICTURES_AHEAD) {
        const picture = pictures[drawing++]!;
        const card = options.prepareImage(picture);
        card.catch(() => {}); // handled when it's sent
        drawn.set(picture, card);
      }
    };
    startPictures();
    // The messages from the start (or from the song before) up to a song go together: the card waits with its song.
    const lastSong = replies.findLastIndex((reply) => reply.kind === 'audio');
    let songNext = true;
    for (const [i, reply] of replies.entries()) {
      if (songNext && i <= lastSong) {
        songNext = false;
        await songTurn();
      }
      if (i >= MAX_MESSAGES_PER_ANSWER) {
        log(`an answer of ${replies.length} messages; dropping all after the first ${MAX_MESSAGES_PER_ANSWER}`);
        return;
      }
      if (reply.kind === 'audio') {
        songNext = true;
        let file: DownloadedAudio | undefined;
        try {
          file = await files.get(reply)!;
        } catch (err) {
          log(`could not get ${reply.title ?? reply.url} ready: ${errorText(err)}`);
          const why = err instanceof AudioFetchError ? `: ${err.message}` : '';
          await chat.sendText(chatID, markBotText(`I couldn't send ${reply.title ? `"${reply.title}"` : 'that file'}${why}.`));
        } finally {
          // This one is in hand (or failed), so the next can start: never more than DOWNLOADS_AHEAD at once.
          sentSongs += 1;
          startDownloads();
        }
        if (!file) continue; // one song that can't be sent doesn't stop the others
        try {
          await chat.sendAudio(chatID, file);
          lastSongAt = now();
          log(`-> audio ${reply.title ?? reply.url}`);
        } catch (err) {
          log(`could not send audio: ${errorText(err)}`);
          await chat.sendText(chatID, markBotText(`I couldn't send ${reply.title ? `"${reply.title}"` : 'that file'}.`));
        } finally {
          // What downloading, tagging and uploading the song left behind is given back now: on 2026-10-19 a 27 MB song's buffers
          // kept the host near 470 of 512 MB for two minutes after it was sent, until a collection happened to run.
          freeMemory();
        }
      } else if (reply.kind === 'image' || reply.kind === 'collage') {
        // A picture is a nicety: when it can't be shown, the answer goes on without it, and a song's name goes as text.
        const caption = reply.kind === 'image' && reply.caption ? markBotText(`${reply.caption.artist ? `${reply.caption.artist} — ` : ''}${reply.caption.title}`) : undefined;
        const sendCaption = async () => {
          if (caption) await sendLinkedText(caption, reply.kind === 'image' ? reply.postback : undefined);
        };
        if (!chat.sendImage || !options.prepareImage) {
          await sendCaption();
          continue;
        }
        try {
          const prepared = await (drawn.get(reply) ?? options.prepareImage(reply));
          rememberLink(await chat.sendImage(chatID, prepared.image), reply.kind === 'image' ? reply.postback : undefined);
          if (!prepared.captioned) await sendCaption();
        } catch (err) {
          log(`could not send a picture: ${errorText(err)}`);
          await sendCaption();
        } finally {
          sentPictures += 1;
          startPictures();
        }
      } else if (reply.kind === 'album') {
        await sendAlbum(reply);
      } else {
        if (reply.chips) {
          setChoices({ chips: reply.chips, ...(reply.numbers ? { numbers: reply.numbers } : {}), at: now(), validMs: reply.chipsValidMs ?? CHOICE_TTL_MS });
        }
        // Options need a word on how to pick one, unless the text already gives it.
        const hint = !chat.reactions && reply.chips && !/\breply with a number\b/i.test(reply.text);
        // Where a 👍 picks, a numbered line (an album, a song of an album) shows its number: texting it picks that line.
        const shown = chat.reactions && reply.number !== undefined ? withNumber(reply.text, reply.number) : reply.text;
        const text = hint ? [shown, CHOICE_HINT].filter(Boolean).join('\n\n') : shown;
        // A message with no words only carries its list's chips: where a 👍 picks, nothing more is said.
        if (!text.trim()) continue;
        // A list's closing line says how to pick from it; where a 👍 picks, it is not one of the list's 🎵 lines.
        await sendLinkedText(chat.reactions && reply.chips ? markHint(text) : markBotText(text), reply.postback);
        // What the bot said, in the host's log too: an answer that explains a failure is otherwise invisible there.
        log(`-> ${JSON.stringify(text.length > 160 ? `${text.slice(0, 160)}…` : text)}`);
      }
    }
  }

  /** Requests being worked on right now (one may be on its way to the phone while another is looked up), and what keeps "typing…" up. */
  let typingFor = 0;
  let typingFailed = false;
  let typingRenew: NodeJS.Timeout | undefined;
  let typingQueue: Promise<void> = Promise.resolve();

  /** One call at a time and in order, so "stopped" can never overtake "started". */
  function postTyping(typing: boolean): Promise<void> {
    const setTyping = chat.setTyping!.bind(chat);
    typingQueue = typingQueue.then(async () => {
      try {
        await setTyping(chatID, typing);
      } catch (err) {
        if (!typingFailed) log(`typing indicator failed: ${errorText(err)}`);
        typingFailed = true;
      }
    });
    return typingQueue;
  }

  /**
   * Shows "typing…" while a request is being worked on, renewing it before it lapses, and returns the function that
   * clears it. It stays up while any request is still being worked on, and calling the function again does nothing. A
   * failure here is logged once and never gets in the way of the answer.
   */
  function startTyping(): () => Promise<void> {
    if (!chat.setTyping) return async () => {};
    typingFor += 1;
    if (typingFor === 1) {
      typingFailed = false;
      void postTyping(true);
      typingRenew = setInterval(() => void postTyping(true), typingRefreshMs);
    }
    let stopped = false;
    return async () => {
      if (stopped) return;
      stopped = true;
      typingFor -= 1;
      if (typingFor > 0) return;
      clearInterval(typingRenew);
      await postTyping(false);
    };
  }

  /**
   * Sends the bot's answer to one request, then calls `done` (which clears "typing…"). An answer of text alone goes out
   * at once. One with a song, a picture or an album waits its turn behind the ones handed over before it, and is not
   * waited for: the poll goes on, so a request made while a song is on its way is read and answered then, not after the
   * song. They go one at a time because the songs have to arrive in the order they were asked for, and a small host
   * can't hold two downloads' worth of memory.
   */
  async function send(replies: Reply[], done: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await respond(replies);
      } finally {
        await done();
      }
    };
    if (replies.every((reply) => reply.kind === 'text')) return run();
    delivering += 1;
    delivery = delivery.then(async () => {
      try {
        await run();
      } catch (err) {
        failed('sending', err);
      } finally {
        delivering -= 1;
        // Nothing is half-answered now, unless a poll is partway through (it saves its own point when it ends).
        if (!current) checkpoint();
      }
    });
  }

  /** Waits until every answer handed over for delivery has been sent. */
  async function idle(): Promise<void> {
    while (delivering > 0) await delivery;
  }

  /** A poll or a delivery that failed: counted the same, since either means the chat isn't taking what the bot says. */
  function failed(what: 'poll' | 'sending', err: unknown): void {
    failures++;
    log(`${what} failed (${failures} in a row): ${errorText(err)}`);
    options.onPoll?.(false, failures, errorText(err));
  }

  async function handleMessage(message: ChatMessage): Promise<void> {
    const text = (message.text ?? '').trim();
    lastRequest = { text: normalize(text), at: now() };
    const offered = currentChoices();
    const valid = offered !== undefined && now() - offered.at < offered.validMs;
    const listed = valid ? offered.chips : [];
    // Where a 👍 picks, only some lines have numbers (an album's, which lists its songs); elsewhere every line has one.
    const numbered = valid && chat.reactions ? (offered.numbers ?? []) : [];
    const isNumber = /^\d{1,2}$/.test(text);
    const choice = !isNumber ? undefined : chat.reactions ? numbered.find((entry) => entry.number === Number(text)) : listed[Number(text) - 1];
    // "all": every song on the list. Like a number, it keeps the list.
    const all = listed.length > 0 && ALL_WORDS.has(normalize(text).replace(/[^\p{L}\p{N} ]/gu, '')) ? listed : undefined;
    // A number meant for the list stays within it; anything else moves on from it.
    const outOfRange = isNumber && listed.length > 0 && !choice;
    if (!(isNumber || all) || listed.length === 0) setChoices(undefined);
    log(`<- ${choice ? `choice ${text}` : JSON.stringify(text)}`);

    const stopTyping = startTyping();
    try {
      const base = { from: chatID, messageId: message.id };
      const incoming: Incoming = choice
        ? { ...base, postback: choice.postback }
        : all
          ? { ...base, postback: `all:${all.map((chip) => chip.postback).join('|')}` }
          : { ...base, text };
      let replies: Reply[];
      if (outOfRange) {
        const range = numbered.length > 0 ? `${numbered[0]!.number} to ${numbered.at(-1)!.number}` : '';
        replies = [
          {
            kind: 'text',
            text: !chat.reactions
              ? `Pick a number from 1 to ${listed.length}, or "search" for another song.`
              : numbered.length > 0
                ? `Text a number from the list (${range}), or tap 👍 on a song.`
                : LIKE_HINT,
          },
        ];
      } else {
        try {
          replies = await bot.handle(incoming);
        } catch (err) {
          log(`bot error: ${errorText(err)}`);
          replies = [{ kind: 'text', text: ERROR_NOTICE }];
        }
      }
      await send(replies, stopTyping);
    } catch (err) {
      await stopTyping();
      throw err;
    }
  }

  /**
   * 👍s on messages that stand for songs get those songs. Any other reaction is just a reaction. 👍s read together
   * (five songs picked in a few seconds) are answered together: the songs are looked up at once and their downloads
   * and covers run ahead of their turns as one line, instead of each waiting for the one before to be sent. The songs
   * still go out in the order they were picked, songGapMs apart.
   */
  async function handleReactions(reactions: ChatMessage[]): Promise<void> {
    const postbacks = await Promise.all(reactions.map((reaction) => postbackFor(reaction.reaction!.to)));
    const asked = reactions.flatMap((reaction, i) => (postbacks[i] ? [{ reaction, postback: postbacks[i]! }] : []));
    if (asked.length < reactions.length) log('ignoring a 👍 on a message that does not stand for a song');
    if (asked.length === 0) return;
    for (const { postback } of asked) log(`<- 👍 ${postback}`);
    const stopTyping = startTyping();
    try {
      let failed = false;
      const answers = await Promise.all(
        asked.map(async ({ reaction, postback }): Promise<Reply[]> => {
          try {
            return await bot.handle({ from: chatID, messageId: reaction.id, postback });
          } catch (err) {
            log(`bot error: ${errorText(err)}`);
            // One apology for the lot, however many songs failed.
            if (failed) return [];
            failed = true;
            return [{ kind: 'text', text: ERROR_NOTICE }];
          }
        }),
      );
      await send(answers.flat(), stopTyping);
    } catch (err) {
      await stopTyping();
      throw err;
    }
  }

  /**
   * Writes down how far the runner got. Called when nothing is half-answered, so a crash repeats work rather than losing
   * it: not while a song or album handed over for delivery is still on its way.
   */
  function checkpoint(): void {
    if (!options.resume || !unsaved || delivering > 0) return;
    unsaved = false;
    try {
      options.resume.save({ at: lastAt, ids: [...seen].slice(-RESUME_IDS) });
    } catch (err) {
      log(`could not keep where the bot got to: ${errorText(err)}`);
    }
  }

  async function prime(): Promise<void> {
    let point: ResumePoint | undefined;
    try {
      point = options.resume?.load();
    } catch (err) {
      log(`could not read where the bot got to: ${errorText(err)}`);
    }
    if (point) {
      lastAt = point.at;
      for (const id of point.ids) remember(id);
    }
    const listed = await chat.listMessages(chatID);
    for (const message of listed) {
      const at = Date.parse(message.timestamp);
      // Sent after the last one dealt with, not dealt with, recent enough to still be wanted, and something the bot acts on
      // (not its own earlier replies, which a restarted client reads back): it arrived while the bot was down.
      const wanted = Boolean(message.reaction || message.picture || message.bridgeSendFailure) || shouldHandle(message);
      if (point && wanted && !point.ids.includes(message.id) && at > point.at && now() - at <= catchUpMs) backlog.push(message);
      else remember(message.id);
      if (!point && at > lastAt) lastAt = at;
    }
    if (backlog.length > 0) log(`${backlog.length} message${backlog.length === 1 ? '' : 's'} arrived while the bot was down; answering ${backlog.length === 1 ? 'it' : 'them'} now`);
    // The first run has no resume point yet; writing one now means a restart before the first request still has one.
    if (!point) unsaved = true;
    checkpoint();
  }

  /** Runs a job that sends on its own (an announcement), after whatever is under way, and makes polls wait for it. */
  async function exclusive(job: () => Promise<void>): Promise<void> {
    while (current || delivering > 0) await (current ?? delivery).catch(() => {});
    const run = (async () => {
      try {
        await job();
      } finally {
        current = undefined;
      }
    })();
    current = run;
    return run;
  }

  /** Reads the chat once and starts answering what's new. Songs and albums are sent in the background (see `send`). */
  function poll(): Promise<void> {
    if (current) return current;
    const run = (async () => {
      try {
        const listed = await chat.listMessages(chatID);
        // Read first: a poll that fails keeps the backlog for the next one.
        const messages = [...backlog.splice(0), ...listed];
        failures = 0;
        options.onPoll?.(true, 0);
        // 👍s are held until a request that is not one (or the end of what was read), then answered together.
        let likes: ChatMessage[] = [];
        const answerLikes = async (): Promise<void> => {
          const batch = likes;
          likes = [];
          if (batch.length > 0) await handleReactions(batch);
        };
        for (const message of messages) {
          if (seen.has(message.id)) continue;
          remember(message.id);
          const at = Date.parse(message.timestamp);
          if (at > lastAt) lastAt = at;
          unsaved = true;
          if (message.bridgeSendFailure) {
            log('the Google Messages bridge reported a message delivery failure');
            await options.onBridgeSendFailure?.();
            continue;
          }
          if (message.reaction) {
            if (isLike(message.reaction.key)) likes.push(message);
            continue;
          }
          if (message.picture) {
            try {
              options.onPicture?.(message.picture);
            } catch (err) {
              log(`could not take a picture from the phone: ${errorText(err)}`);
            }
            continue;
          }
          if (!shouldHandle(message)) continue;
          if (isRepeat(message)) {
            log(`ignoring a repeat of the last request (within ${REPEAT_WINDOW_MS / 1000} s): ${JSON.stringify(message.text?.trim())}`);
            continue;
          }
          await answerLikes();
          await handleMessage(message);
          checkpoint();
        }
        await answerLikes();
        checkpoint();
      } catch (err) {
        failed('poll', err);
      } finally {
        current = undefined;
      }
    })();
    current = run;
    return run;
  }

  /** Reads the chat once and answers what's new, songs and albums included: it returns when they've been sent. */
  async function tick(): Promise<void> {
    await poll();
    await idle();
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    await poll();
    if (stopped) return;
    timer = setTimeout(() => void loop(), Math.min(pollMs * 2 ** Math.min(failures, 4), 15_000));
  }

  return {
    prime,
    tick,
    announce(replies) {
      return exclusive(async () => {
        log(`-> announcement (${replies.length} message${replies.length === 1 ? '' : 's'})`);
        await respond(replies);
      });
    },
    async start() {
      await prime();
      stopped = false;
      timer = setTimeout(() => void loop(), pollMs);
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      wake?.(); // a song waiting its turn goes now
      await current;
      await idle();
    },
  };
}
