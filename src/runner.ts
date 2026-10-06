import { AudioFetchError, type DownloadedAudio } from './audio-fetch.ts';
import { ALL_WORDS, joinLists, type Bot } from './bot.ts';
import type { DownloadedImage } from './image-fetch.ts';
import type { Picture, PreparedPicture } from './library/images.ts';
import type { Chip, Incoming, Reply } from './types.ts';

/**
 * Every message the bot writes starts with this. In a chat with yourself the bot's replies look like your own
 * messages, so this marker is how it tells them apart and never answers itself.
 */
export const BOT_MARK = '🎵';

const SEEN_LIMIT = 2000;
/**
 * In a chat with yourself, a phone can show one text twice (as sent and as received), and the bridge passes both on.
 * A request repeated word for word within this long is taken as an echo of the first, not a new request.
 */
const REPEAT_WINDOW_MS = 20_000;
/** Songs downloading at once, ahead of their turn to be sent. */
const DOWNLOADS_AHEAD = 3;
const CHOICE_HINT = 'Reply with a number to choose.';
/** What a number gets where a 👍 picks: lists there have no numbers. */
const LIKE_HINT = 'To get a song from the list, tap 👍 on it.';
/** How long a list of options stays pickable. The list is still on screen, so a 👍 or a number is still an answer to it. */
const CHOICE_TTL_MS = 30 * 60_000;
const ERROR_NOTICE = 'Something went wrong on my side. Please try again in a moment.';

export const markBotText = (text: string): string => (text.startsWith(BOT_MARK) ? text : `${BOT_MARK} ${text}`);

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
  /** A reaction (👍…) to another message, rather than a message of its own. */
  reaction?: { to: string; key: string } | undefined;
}

/** What the runner needs from a chat platform: read what's new in one chat, and write to it. */
export interface ChatClient {
  /** Messages the runner may not have seen yet, oldest first. Repeats are fine; the runner de-duplicates by id. */
  listMessages(chatID: string): Promise<ChatMessage[]>;
  /** Sends a text; returns the message's id when the platform gives one (a 👍 on it can then be matched). */
  sendText(chatID: string, text: string): Promise<string | void>;
  sendAudio(chatID: string, audio: DownloadedAudio): Promise<string | void>;
  /** Sends a picture (album art). Platforms that can't leave it out, and pictures are skipped. */
  sendImage?(chatID: string, image: DownloadedImage): Promise<string | void>;
  /**
   * True when a 👍 tapped on a message reaches the bot. Then lists go one entry per message, without numbers, and a
   * 👍 picks; otherwise each list is one numbered message, and a number picks.
   */
  readonly reactions?: boolean;
  /** Shows or clears "typing…" in the chat. Platforms that can't do this leave it out. */
  setTyping?(chatID: string, typing: boolean): Promise<void>;
}

/** The numbered options on offer: what "2" means right now, since when, and for how long. */
export interface PendingChoices {
  chips: Chip[];
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
  /** Circuit breaker: stop sending once this many messages went out in the last minute. */
  maxSendsPerMinute?: number;
  /**
   * The least time between two songs, so the phone has sent one before the next arrives (three 👍 in a row, "all").
   * A song's card waits with it. 0, the default, sends them as fast as they're ready.
   */
  songGapMs?: number;
  /** Waits; tests pass one that doesn't. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  /** Told after each poll whether the chat answered, and how many times in a row it hasn't. */
  onPoll?: (ok: boolean, failuresInARow: number, error?: string) => void;
}

export interface Runner {
  /** Marks the chat's current messages as seen, so history is never replayed. */
  prime(): Promise<void>;
  /** Reads the chat once and answers any new requests. */
  tick(): Promise<void>;
  /** Sends messages the bot starts itself (the daily new-music message), never in the middle of answering a request. */
  announce(replies: Reply[]): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const normalize = (text: string | undefined): string => (text ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Watches one chat and answers song requests typed into it. */
export function createRunner(options: RunnerOptions): Runner {
  const { chat, bot, chatID } = options;
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? 1500;
  const typingRefreshMs = options.typingRefreshMs ?? 20_000;
  const maxSends = options.maxSendsPerMinute ?? 30;
  const songGapMs = options.songGapMs ?? 0;

  const seen = new Set<string>();
  const sendTimes: number[] = [];
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

  function allowSend(): boolean {
    const cutoff = now() - 60_000;
    while (sendTimes.length > 0 && sendTimes[0]! < cutoff) sendTimes.shift();
    if (sendTimes.length >= maxSends) return false;
    sendTimes.push(now());
    return true;
  }

  function shouldHandle(message: ChatMessage): boolean {
    if (message.isDeleted || message.hasAttachments) return false;
    if (message.type !== undefined && message.type !== 'TEXT') return false;
    const text = message.text?.trim();
    return Boolean(text) && !text!.startsWith(BOT_MARK);
  }

  function isRepeat(message: ChatMessage): boolean {
    return lastRequest !== undefined && lastRequest.text === normalize(message.text) && now() - lastRequest.at < REPEAT_WINDOW_MS;
  }

  async function respond(answer: Reply[]): Promise<void> {
    const replies = chat.reactions ? answer : joinLists(answer);
    // Songs start downloading ahead of their turn, so a song gets ready while its picture is drawn and sent; at most
    // DOWNLOADS_AHEAD at a time, so "all" doesn't fetch twenty files at once.
    const songs = replies.filter((reply): reply is Extract<Reply, { kind: 'audio' }> => reply.kind === 'audio');
    const files = new Map<Reply, Promise<DownloadedAudio>>();
    let started = 0;
    let sentSongs = 0;
    const startDownloads = (): void => {
      while (started < songs.length && started - sentSongs < DOWNLOADS_AHEAD) {
        const song = songs[started++]!;
        const file = options.fetchAudio(song.url, song.title);
        file.catch(() => {}); // handled when it's sent
        files.set(song, file);
      }
    };
    startDownloads();
    // The messages from the start (or from the song before) up to a song go together: the card waits with its song.
    const lastSong = replies.findLastIndex((reply) => reply.kind === 'audio');
    let songNext = true;
    for (const [i, reply] of replies.entries()) {
      if (songNext && i <= lastSong) {
        songNext = false;
        await songTurn();
      }
      if (!allowSend()) {
        log(`send limit reached (${maxSends} a minute); dropping the rest of this answer`);
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
        }
      } else if (reply.kind === 'image' || reply.kind === 'collage') {
        // A picture is a nicety: when it can't be shown, the answer goes on without it, and a song's name goes as text.
        const caption = reply.kind === 'image' && reply.caption ? markBotText(`${reply.caption.artist ? `${reply.caption.artist} — ` : ''}${reply.caption.title}`) : undefined;
        const sendCaption = async () => {
          if (caption && allowSend()) rememberLink(await chat.sendText(chatID, caption), reply.kind === 'image' ? reply.postback : undefined);
        };
        if (!chat.sendImage || !options.prepareImage) {
          await sendCaption();
          continue;
        }
        try {
          const prepared = await options.prepareImage(reply);
          rememberLink(await chat.sendImage(chatID, prepared.image), reply.kind === 'image' ? reply.postback : undefined);
          if (!prepared.captioned) await sendCaption();
        } catch (err) {
          log(`could not send a picture: ${errorText(err)}`);
          await sendCaption();
        }
      } else {
        if (reply.chips) setChoices({ chips: reply.chips, at: now(), validMs: reply.chipsValidMs ?? CHOICE_TTL_MS });
        // Options need a word on how to pick one, unless the text already gives it.
        const hint = !chat.reactions && reply.chips && !/\breply with a number\b/i.test(reply.text);
        rememberLink(await chat.sendText(chatID, markBotText(hint ? `${reply.text}\n\n${CHOICE_HINT}` : reply.text)), reply.postback);
      }
    }
  }

  /**
   * Shows "typing…" while a request is being worked on, renewing it before it lapses, and returns the function that
   * clears it. A failure here is logged once and never gets in the way of the answer.
   */
  function startTyping(): () => Promise<void> {
    if (!chat.setTyping) return async () => {};
    const setTyping = chat.setTyping.bind(chat);
    let failed = false;
    let queue: Promise<void> = Promise.resolve();
    // One call at a time and in order, so "stopped" can never overtake "started".
    const post = (typing: boolean): Promise<void> => {
      queue = queue.then(async () => {
        try {
          await setTyping(chatID, typing);
        } catch (err) {
          if (!failed) log(`typing indicator failed: ${errorText(err)}`);
          failed = true;
        }
      });
      return queue;
    };
    void post(true);
    const renew = setInterval(() => void post(true), typingRefreshMs);
    return async () => {
      clearInterval(renew);
      await post(false);
    };
  }

  async function handleMessage(message: ChatMessage): Promise<void> {
    const text = (message.text ?? '').trim();
    lastRequest = { text: normalize(text), at: now() };
    const offered = currentChoices();
    const listed = offered && now() - offered.at < offered.validMs ? offered.chips : [];
    const isNumber = /^\d{1,2}$/.test(text);
    // Where a 👍 picks, lists have no numbers, so a number picks nothing; it gets how to pick instead.
    const choice = isNumber && !chat.reactions ? listed[Number(text) - 1] : undefined;
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
        replies = [{ kind: 'text', text: chat.reactions ? LIKE_HINT : `Pick a number from 1 to ${listed.length}, or "search" for another song.` }];
      } else {
        try {
          replies = await bot.handle(incoming);
        } catch (err) {
          log(`bot error: ${errorText(err)}`);
          replies = [{ kind: 'text', text: ERROR_NOTICE }];
        }
      }
      await respond(replies);
    } finally {
      await stopTyping();
    }
  }

  /** A 👍 on a message that stands for a song gets that song. Any other reaction is just a reaction. */
  async function handleReaction(message: ChatMessage): Promise<void> {
    const postback = linkedTo(message.reaction!.to);
    if (!postback) return;
    log(`<- 👍 ${postback}`);
    const stopTyping = startTyping();
    try {
      let replies: Reply[];
      try {
        replies = await bot.handle({ from: chatID, messageId: message.id, postback });
      } catch (err) {
        log(`bot error: ${errorText(err)}`);
        replies = [{ kind: 'text', text: ERROR_NOTICE }];
      }
      await respond(replies);
    } finally {
      await stopTyping();
    }
  }

  async function prime(): Promise<void> {
    for (const message of await chat.listMessages(chatID)) remember(message.id);
  }

  /** Runs a job that sends on its own (an announcement), after whatever is under way, and makes polls wait for it. */
  async function exclusive(job: () => Promise<void>): Promise<void> {
    while (current) await current.catch(() => {});
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

  function tick(): Promise<void> {
    if (current) return current;
    const run = (async () => {
      try {
        const messages = await chat.listMessages(chatID);
        failures = 0;
        options.onPoll?.(true, 0);
        for (const message of messages) {
          if (seen.has(message.id)) continue;
          remember(message.id);
          if (message.reaction) {
            if (isLike(message.reaction.key)) await handleReaction(message);
            continue;
          }
          if (!shouldHandle(message)) continue;
          if (isRepeat(message)) {
            log(`ignoring a repeat of the last request (within ${REPEAT_WINDOW_MS / 1000} s): ${JSON.stringify(message.text?.trim())}`);
            continue;
          }
          await handleMessage(message);
        }
      } catch (err) {
        failures++;
        log(`poll failed (${failures} in a row): ${errorText(err)}`);
        options.onPoll?.(false, failures, errorText(err));
      } finally {
        current = undefined;
      }
    })();
    current = run;
    return run;
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    await tick();
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
    },
  };
}
