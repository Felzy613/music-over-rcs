import type { AudioCheck } from './audio-check.ts';
import type { ListedTrack } from './catalog.ts';
import type { Browse, ListPage } from './library/browse.ts';
import { categoryFor } from './library/category-list.ts';
import type { Follows } from './library/follows.ts';
import { seasonOn } from './library/seasons.ts';
import { parseQuery, tokenize } from './query.ts';
import { editDistance, namesSong } from './sources/relevance.ts';
import { splitTitle } from './sources/titles.ts';
import type { Chip, Incoming, Reply, Track } from './types.ts';

/** A problem with an outside source whose message is fit to show to the user. */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

/**
 * Somewhere to look when the catalog has no match. It returns tracks that are already stored in the catalog,
 * so choices and replies work the same as for any other track.
 */
export interface TrackSource {
  name: string;
  lookup(query: string, limit: number): Promise<Track[]>;
}

export interface BotDeps {
  catalog: {
    search(query: string, limit?: number): Track[];
    get(id: number): Track | undefined;
    /** The songs of one music-table.com post (an album's tracks), for picking an album from a list. */
    postTracks?(slug: string): Track[];
  };
  checkAudio(url: string): Promise<AudioCheck>;
  source?: TrackSource;
  /** Hears about every song about to be sent, so the most played ones can be kept ready. */
  onPlay?: (track: Track) => void;
  /** Lists to browse: "trending", "new", an artist's songs, holidays, and "more". */
  browse?: Browse;
  /** Artists you follow ("follow …", "unfollow …", "following"), and following for you after several plays. */
  follows?: Follows;
  /** An assistant elsewhere (an add-on, see extensions.ts) that messages starting with its word go to. */
  assistant?: Assistant;
  now?: () => Date;
}

/** An AI assistant elsewhere that a message starting with its word is passed on to; its answers come back on their own. */
export interface Assistant {
  /** The first word that passes a message on, lowercase ("jarvis"). */
  word: string;
  /** Its name in the chat ("Jarvis"). */
  name: string;
  /**
   * Passes the message on (with any pictures sent just before it), `origin` being the chat message it came from.
   * Resolves to a word for the chat, if one is needed; rejects with a reason fit to show.
   */
  forward(text: string, origin?: string): Promise<string | undefined>;
}

export interface Bot {
  handle(msg: Incoming): Promise<Reply[]>;
}

const MAX_CHOICES = 5;
const MAX_QUERY_CHARS = 200;
const MAX_CHIP_LABEL = 25;
/** A message starting with one of these gets the help. */
const GREETINGS = new Set(['help', 'hi', 'hello', 'hey', 'start', 'menu', 'commands']);
/**
 * Every message starts with its command, so a song's name is never taken for a command or the other way round.
 * "search" (a letter off is fine: "serach", "seach") and what to look for searches.
 */
const FIRST_WORD = /^\s*(\p{L}+)[\s:,-]*/u;
const isSearch = (word: string): boolean => editDistance(word.toLowerCase(), 'search') <= 1;

/** What follows a message's first word when that word is `word` ("Jarvis, look at this" → "look at this"), else undefined. */
export function afterWord(text: string, word: string): string | undefined {
  const first = FIRST_WORD.exec(text);
  return first && first[1]!.toLowerCase() === word ? text.slice(first[0].length).trim() : undefined;
}

export const HELP_TEXT =
  'Text "search" and a song name (artist and title work best), and I\'ll send you the audio file.\nExample: search blue horizon night owls';

/** The help when the lists are there too: every command, since a message has to start with one. */
export const BROWSE_HELP_TEXT = [
  'Start each message with a command:',
  '"search" and a song or an artist, like "search lipa vnusni".',
  '"trending", "new", "chanukah", "purim", "wedding" or "vocal" for lists, "more" for the next ones, and "all" for every song on a list.',
  '"follow" and an artist to get their new songs as soon as they\'re out ("unfollow", "following").',
  'Tap 👍 on a song in a list to get it.',
].join('\n');

const TRENDING = new Set(['trending', 'top', 'top songs', 'top 10', 'popular', 'hot', 'whats hot', 'what s hot', 'trending songs', 'charts']);
const NEWEST = new Set(['new', 'newest', 'latest', 'new music', 'new songs', 'new releases', 'whats new', 'what s new', 'latest music']);
const MORE = new Set(['more', 'next', 'show more', 'more please', 'next page']);
/** "all" sends every song on the list on screen (the runner turns it into an `all:` postback); at most this many. */
export const ALL_WORDS = new Set(['all', 'all of them', 'send all', 'send them all', 'get all', 'everything', 'all please']);
const MAX_ALL = 20;
const LIST_SIZE = 10;
/** A list of songs stays pickable by number for a couple of hours; "Which one?" for half an hour. */
const LIST_VALID_MS = 2 * 60 * 60_000;
const CHOICE_VALID_MS = 30 * 60_000;

export function describe(track: Track): string {
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}

const say = (text: string, chips?: Chip[]): Reply => (chips ? { kind: 'text', text, chips } : { kind: 'text', text });

function chipLabel(n: number, title: string): string {
  const chars = Array.from(`${n}. ${title}`);
  return chars.length <= MAX_CHIP_LABEL ? chars.join('') : `${chars.slice(0, MAX_CHIP_LABEL - 1).join('')}…`;
}

/** Both lists, without repeats, the first one's order first, at most `limit`. */
function merge(first: Track[], second: Track[], limit: number): Track[] {
  const seen = new Set<number>();
  const out: Track[] = [];
  for (const track of [...first, ...second]) {
    if (out.length >= limit) break;
    if (seen.has(track.id)) continue;
    seen.add(track.id);
    out.push(track);
  }
  return out;
}

/**
 * A list as messages: a heading, one message per entry, without numbers (a 👍 on it gets that entry), and a last line
 * on how to pick. Its chips are the list itself: every song shown so far, for "all", and numbered for the chats where
 * a 👍 can't reach the bot (see joinLists).
 */
function listReplies(heading: string, entries: Array<{ line: string; postback: string }>, closing: string, chips: Chip[], validMs: number): Reply[] {
  return [
    { kind: 'text', text: heading },
    ...entries.map((entry): Reply => ({ kind: 'text', text: entry.line, postback: entry.postback })),
    { kind: 'text', text: closing, chips, chipsValidMs: validMs },
  ];
}

type TextReply = Extract<Reply, { kind: 'text' }>;

/**
 * For chats where a 👍 can't reach the bot (Beeper, RCS for Business, a terminal), where a number picks instead: each
 * song in a list (and each cover in a collage) gets its number from the list's chips, a list's lines are folded back
 * into one message under its heading, and how to pick says to reply with a number. Everything else is left as it is.
 */
export function joinLists(answer: Reply[]): Reply[] {
  const numbers = new Map<string, number>();
  for (const reply of answer) {
    if (reply.kind === 'text' && reply.chips) reply.chips.forEach((chip, i) => numbers.set(chip.postback, i + 1));
  }
  const replies = answer.map((reply): Reply => {
    if (reply.kind === 'collage') {
      return { ...reply, images: reply.images.map((image) => (numbers.has(image.postback) ? { ...image, number: numbers.get(image.postback)! } : image)) };
    }
    if (reply.kind !== 'text') return reply;
    if (reply.chips) return { ...reply, text: reply.text.replace(/^Tap 👍 on (?:one|a song|it) to\b/m, 'Reply with a number to') };
    const n = reply.postback === undefined ? undefined : numbers.get(reply.postback);
    return n === undefined ? reply : { ...reply, text: `${n}. ${reply.text}` };
  });
  const out: Reply[] = [];
  const isLine = (reply: Reply | undefined): reply is TextReply => reply?.kind === 'text' && Boolean(reply.postback) && !reply.chips;
  for (let i = 0; i < replies.length; i += 1) {
    const reply = replies[i]!;
    if (isLine(reply)) {
      const lines: string[] = [];
      let j = i;
      while (isLine(replies[j])) lines.push((replies[j] as TextReply).text), (j += 1);
      const closing = replies[j];
      if (closing?.kind === 'text' && closing.chips) {
        const before = out.at(-1);
        const heading = before?.kind === 'text' && !before.postback && !before.chips ? (out.pop() as TextReply).text : undefined;
        out.push({
          kind: 'text',
          text: [...(heading !== undefined ? [heading] : []), ...lines, '', closing.text].join('\n'),
          chips: closing.chips,
          ...(closing.chipsValidMs !== undefined ? { chipsValidMs: closing.chipsValidMs } : {}),
        });
        i = j;
        continue;
      }
    }
    out.push(reply);
  }
  return out;
}

/** "Oct 5", or "Sep 21, 2024" for another year. */
function shortDate(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function createBot(deps: BotDeps): Bot {
  const now = deps.now ?? (() => new Date());

  /** One page of a list: the heading, ten songs, and how to go on. Where numbers pick, they run on across pages. */
  async function showList(page: ListPage, heading: string, empty: string): Promise<Reply[]> {
    const browse = deps.browse!;
    const fetch = async (limit: number, offset: number): Promise<ListedTrack[]> =>
      page.kind === 'trending'
        ? browse.trending(limit, offset)
        : page.kind === 'new'
          ? browse.newest(limit, offset)
          : page.kind === 'category'
            ? ((await browse.category?.(page.category ?? '', limit, offset)) ?? [])
            : browse.artistSongs(page.artistId ?? -1, limit, offset);
    let got: ListedTrack[];
    try {
      got = await fetch(LIST_SIZE + 1, page.shown);
    } catch (err) {
      if (err instanceof SourceError) return [say(`I couldn't get that list from music-table.com: ${err.message}.`)];
      throw err;
    }
    if (got.length === 0) {
      browse.setPage(undefined);
      return [say(page.shown === 0 ? empty : "That's all of them.")];
    }
    const songs = got.slice(0, LIST_SIZE);
    const more = got.length > LIST_SIZE;
    const next: ListPage = { ...page, shown: page.shown + songs.length, title: heading };
    browse.setPage(more ? next : undefined);
    const today = now();
    const line = (track: ListedTrack): string => {
      const when = shortDate(track.releasedAt, today);
      let name: string;
      if (track.album) {
        const parts = splitTitle(track.album.title);
        const title = parts.title || track.album.title;
        name = `${page.kind === 'artist' || !parts.artist ? title : `${parts.artist} — ${title}`} · album, ${track.album.songs} songs`;
      } else {
        name = page.kind === 'artist' ? track.title : describe(track);
      }
      return `${name}${when ? ` · ${when}` : ''}`;
    };
    const shownSoFar = [...(page.shown > 0 ? await fetch(page.shown, 0) : []), ...songs];
    // Picking an album lists its songs; picking a song sends it.
    const pick = (track: ListedTrack): string => (track.album && track.post ? `post:${track.post}` : `play:${track.id}`);
    return listReplies(
      page.shown === 0 ? heading : `${heading} (continued)`,
      songs.map((track) => ({ line: line(track), postback: pick(track) })),
      `Tap 👍 on one to get it${more ? ', or text "more" for the next ones' : ''}.`,
      shownSoFar.map((track, i) => ({ label: chipLabel(i + 1, track.album ? splitTitle(track.album.title).title || track.title : track.title), postback: pick(track) })),
      LIST_VALID_MS,
    );
  }

  /** Every song on a list: songs as they are, albums as all their songs, files only (no cards), up to MAX_ALL. */
  async function playAll(postbacks: string[]): Promise<Reply[]> {
    const tracks: Track[] = [];
    const seen = new Set<number>();
    for (const postback of postbacks) {
      const id = /^play:(\d+)$/.exec(postback)?.[1];
      const slug = /^post:(.+)$/.exec(postback)?.[1];
      const found = id !== undefined ? [deps.catalog.get(Number(id))] : slug !== undefined ? (deps.catalog.postTracks?.(slug) ?? []) : [];
      for (const track of found) {
        if (track && !seen.has(track.id)) {
          seen.add(track.id);
          tracks.push(track);
        }
      }
    }
    if (tracks.length === 0) return [say('Those songs are no longer in the catalog.')];
    const chosen = tracks.slice(0, MAX_ALL);
    const checks = await Promise.all(chosen.map((track) => deps.checkAudio(track.url)));
    const refused: string[] = [];
    const files: Reply[] = [];
    chosen.forEach((track, i) => {
      const check = checks[i]!;
      if (!check.ok) {
        refused.push(describe(track));
        return;
      }
      try {
        deps.onPlay?.(track);
      } catch {
        // counting plays must never stop a song
      }
      files.push({ kind: 'audio', url: track.url, title: describe(track) });
    });
    const count = files.length === 1 ? '1 song' : `${files.length} songs`;
    const capped = tracks.length > MAX_ALL ? ` (the first ${MAX_ALL} of ${tracks.length})` : '';
    return [
      say(`🎵 Here come all ${count}${capped}:`),
      ...files,
      ...(refused.length > 0 ? [say(`I couldn't send ${refused.join(', ')}.`)] : []),
    ];
  }

  /** "trending", "new", a holiday, "more" or an artist's name, when the lists are there. */
  async function browseFor(tokens: string[]): Promise<Reply[] | undefined> {
    const browse = deps.browse;
    if (!browse) return undefined;
    const phrase = tokens.join(' ');
    // In a season with its own music, the general lists point to it.
    const season = seasonOn(now());
    const withSeason = (heading: string) => (season ? `${heading}\n${season.hint}` : heading);
    if (TRENDING.has(phrase)) return showList({ kind: 'trending', shown: 0 }, withSeason('🔥 Trending on music-table.com'), 'Nothing is trending yet: the catalog is still being filled. Try again in a few minutes.');
    if (NEWEST.has(phrase)) return showList({ kind: 'new', shown: 0 }, withSeason('🆕 New on music-table.com'), 'No new songs yet: the catalog is still being filled. Try again in a few minutes.');
    const category = browse.category ? categoryFor(phrase) : undefined;
    if (category) {
      return showList(
        { kind: 'category', category: category.slug, shown: 0 },
        `${category.emoji} ${category.name} · most popular first`,
        `I couldn't find ${category.name} songs on music-table.com right now.`,
      );
    }
    if (MORE.has(phrase)) {
      const page = browse.page();
      if (!page) return [say('Text "trending", "new" or "search" and an artist first; then "more" shows the next ones.')];
      return showList(page, page.title ?? 'More', "That's all of them.");
    }
    return undefined;
  }

  /** "follow …", "unfollow …" and "following". */
  function followFor(tokens: string[]): Reply[] | undefined {
    const follows = deps.follows;
    if (!follows) return undefined;
    const [first, second] = tokens;
    const unfollowing = first === 'unfollow' || (first === 'stop' && second === 'following');
    if (first === 'follow' || unfollowing) {
      const who = tokens.slice(unfollowing && first === 'stop' ? 2 : 1);
      if (who.length === 0) return [say(`Text "${unfollowing ? 'unfollow' : 'follow'}" and an artist's name, like "${unfollowing ? 'unfollow' : 'follow'} yoely weiss".`)];
      if (unfollowing) {
        const result = follows.unfollow(who);
        if (!result) return [say(`I don't know an artist called "${who.join(' ')}".`)];
        return [say(result.was ? `Stopped following ${result.artist.name}.` : `You weren't following ${result.artist.name}; I won't start on my own.`)];
      }
      const artist = follows.follow(who);
      if (!artist) return [say(`I don't know an artist called "${who.join(' ')}". Try their full name as the site writes it.`)];
      return [say(`🔔 Following ${artist.name}. Their new songs will come to you as soon as they're out.`)];
    }
    const phrase = tokens.join(' ');
    if (['following', 'who do i follow', 'my artists', 'followed', 'follows'].includes(phrase)) {
      const list = follows.list();
      if (list.length === 0) return [say('You don\'t follow anyone yet. Text "follow" and an artist\'s name, like "follow yoely weiss".')];
      const names = list.map((artist) => `${artist.name}${artist.auto ? ' (from your plays)' : ''}`);
      return [say(`🔔 You follow: ${names.join(', ')}.\nText "unfollow" and a name to stop.`)];
    }
    return undefined;
  }

  /** An artist's songs, when the words are just an artist's name. */
  function artistList(tokens: string[]): Promise<Reply[]> | undefined {
    const artist = deps.browse?.artist(tokens);
    if (!artist) return undefined;
    const releases = deps.browse!.artistReleases(artist.id);
    const count = releases === 1 ? '1 release' : `${releases} releases`;
    return showList({ kind: 'artist', artistId: artist.id, shown: 0 }, `🎤 ${artist.name} · ${count}, newest first`, `I have no songs by ${artist.name}.`);
  }

  async function play(track: Track): Promise<Reply[]> {
    const check = await deps.checkAudio(track.url);
    if (!check.ok) return [say(`I can't send "${describe(track)}": ${check.reason}.`)];
    try {
      deps.onPlay?.(track);
    } catch {
      // counting plays must never stop a song
    }
    // Two messages: the cover with the song's name on it, then the song. Without a cover, the name as text.
    const replies: Reply[] = [
      track.cover ? { kind: 'image', url: track.cover, caption: { title: track.title, artist: track.artist } } : say(`🎵 ${describe(track)}`),
      { kind: 'audio', url: track.url, title: describe(track) },
    ];
    let followed: string[] = [];
    try {
      followed = deps.follows?.afterPlay(track) ?? [];
    } catch {
      // following is a nicety; the song still goes
    }
    if (followed.length > 0) {
      const names = followed.join(' and ');
      replies.push(say(`🔔 You've had a few songs by ${names}, so I'll send you their new ones as soon as they're out. (Text "unfollow ${followed[0]!.toLowerCase()}" to stop.)`));
    }
    return replies;
  }

  /** "search …": the song the words name (sent at once), an artist's songs, or the songs that fit to choose from. */
  async function search(raw: string): Promise<Reply[]> {
    const tokens = parseQuery(raw);
    if (tokens.every((token) => token.length < 2)) {
      return [say(`Text "search" and ${deps.browse ? 'a song or an artist, like "search lipa vnusni"' : 'a song name, like "search blue horizon night owls"'}.`)];
    }
    const local = deps.catalog.search(raw, MAX_CHOICES);
    // Naming exactly one song the catalog has is answered at once, without asking anyone else.
    const named = local.filter((track) => namesSong(track, tokens));
    if (named.length === 1) return play(named[0]!);

    // Just an artist's name: their songs, newest first.
    const byArtist = artistList(tokens);
    if (byArtist) return byArtist;

    // Otherwise the catalog may hold only some of what fits (the songs synced or asked for before), so the other
    // source is asked too and its results come first.
    let found = local;
    if (deps.source) {
      try {
        found = merge(await deps.source.lookup(raw, MAX_CHOICES), local, MAX_CHOICES);
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        if (local.length === 0) return [say(`I couldn't search ${deps.source.name}: ${err.message}.`)];
      }
    }
    if (found.length === 0) {
      const also = deps.source ? ` (I looked on ${deps.source.name} too)` : '';
      return [say(`No match for "${raw}"${also}. Try the artist and title, or fewer words.`)];
    }
    if (found.length === 1) return play(found[0]!);

    const exact = found.filter((track) => namesSong(track, tokens));
    if (exact.length === 1) return play(exact[0]!);

    return listReplies(
      'Which one?',
      found.map((track) => ({ line: describe(track), postback: `play:${track.id}` })),
      'Tap 👍 on one to choose.',
      found.map((track, i) => ({ label: chipLabel(i + 1, track.title), postback: `play:${track.id}` })),
      CHOICE_VALID_MS,
    );
  }

  /** "jarvis …": the rest of the message, whole, goes to the assistant. Nothing is said when it's on its way. */
  async function ask(text: string, origin: string): Promise<Reply[]> {
    const { word, name } = deps.assistant!;
    if (!text) return [say(`Text "${word}" and your message, like "${word} what's on my calendar tomorrow?"`)];
    try {
      const note = await deps.assistant!.forward(text, origin);
      return note ? [say(note)] : [];
    } catch (err) {
      return [say(`I couldn't send that to ${name}: ${err instanceof Error ? err.message : String(err)}.`)];
    }
  }

  const helpText = (): string => {
    const help = deps.browse ? BROWSE_HELP_TEXT : HELP_TEXT;
    const word = deps.assistant?.word;
    return word ? `${help}\n"${word}" and a message to ask ${deps.assistant!.name}; the answer comes back here.` : help;
  };

  return {
    async handle(msg) {
      if (msg.postback !== undefined) {
        const all = /^all:(.+)$/s.exec(msg.postback)?.[1];
        if (all !== undefined) return playAll(all.split('|'));
        const album = /^post:(.+)$/.exec(msg.postback)?.[1];
        if (album !== undefined) {
          const tracks = deps.catalog.postTracks?.(album) ?? [];
          if (tracks.length === 0) return [say('That album is no longer in the catalog.')];
          if (tracks.length === 1) return play(tracks[0]!);
          const shown = tracks.slice(0, 30);
          const heading = shown[0]!.artist ? `${shown[0]!.artist} · ${tracks.length} songs` : `${tracks.length} songs`;
          return listReplies(
            heading,
            shown.map((track) => ({ line: track.title, postback: `play:${track.id}` })),
            'Tap 👍 on one to get it.',
            shown.map((track, i) => ({ label: chipLabel(i + 1, track.title), postback: `play:${track.id}` })),
            LIST_VALID_MS,
          );
        }
        const id = /^play:(\d+)$/.exec(msg.postback)?.[1];
        if (id === undefined) return [say(HELP_TEXT)];
        const track = deps.catalog.get(Number(id));
        return track ? play(track) : [say('That track is no longer in the catalog.')];
      }

      const whole = (msg.text ?? '').trim();
      // "jarvis …" goes on whole, however long; it's for the assistant, not a search.
      const forAssistant = deps.assistant ? afterWord(whole, deps.assistant.word) : undefined;
      if (forAssistant !== undefined) return ask(forAssistant, msg.messageId);
      const raw = whole.slice(0, MAX_QUERY_CHARS);
      const words = tokenize(raw);
      // Nothing to answer: no words, a greeting or "help", or only single characters (a stray "a", or a "2" with no list to pick from).
      if (words.every((word) => word.length < 2) || GREETINGS.has(words[0]!)) {
        return [say(helpText())];
      }
      const first = FIRST_WORD.exec(raw);
      if (first && isSearch(first[1]!)) return search(raw.slice(first[0].length).trim());
      // "all" with no list open (the runner answers it when one is).
      if (ALL_WORDS.has(words.join(' '))) {
        return [say(`Text ${deps.browse ? '"trending", "new" or ' : ''}"search" and a song first; then "all" sends every song on the list.`)];
      }
      const following = followFor(words);
      if (following) return following;
      const listed = await browseFor(words);
      if (listed) return listed;
      // Not a command: most likely a song's name without "search" in front.
      return [say(`To look for a song, start with "search":\nsearch ${raw}\n\nText "help" for the other commands.`)];
    },
  };
}
