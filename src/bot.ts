import { AsyncLocalStorage } from 'node:async_hooks';
import { artistKey } from './artists.ts';
import type { AudioCheck } from './audio-check.ts';
import type { ListedTrack } from './catalog.ts';
import type { Browse, ListPage } from './library/browse.ts';
import { categoryFor } from './library/category-list.ts';
import type { Follows } from './library/follows.ts';
import { seasonOn } from './library/seasons.ts';
import { albumLine, artistLine, closingLine, creditNeeded, FIRST_PAGE, helpText, NEXT_PAGE, orList, shortCredit, shownTitle, songLine } from './menu.ts';
import { parseQuery, tokenize } from './query.ts';
import { foldEditions, rankAlbums, rankArtists, rankSongs, songTier, withoutGuests } from './ranking.ts';
import { editDistance } from './sources/relevance.ts';
import { splitTitle } from './sources/titles.ts';
import { timed, type Trace } from './timeline.ts';
import type { Chip, Incoming, Reply, Track } from './types.ts';
import { CATEGORIES, inView, memoryViews, splitPostback, type Category, type ShownLine, type View, type ViewStore } from './views.ts';

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
export interface LookupOptions {
  /**
   * Keep only songs that fit the request's words (apostrophes and a typo or two forgiven), best first. For a source
   * that returns loosely related songs and is asked first, so that what it hands back really answers the request and
   * the next source is asked when nothing does.
   */
  relevant?: boolean;
}

export interface TrackSource {
  name: string;
  /** Said when a search on this source alone finds nothing: why that can be ("it only shows artists on Zemer's list"). */
  hint?: string;
  lookup(query: string, limit: number, options?: LookupOptions): Promise<Track[]>;
}

/** An album a source offers. `id` is whatever the source needs to open it again. */
export interface Album {
  id: string;
  title: string;
  artist: string;
  year?: number | undefined;
  /** When it came out (ISO), when the source says: it orders albums of the same year. */
  released?: string | undefined;
  cover?: string | undefined;
  /** How many songs it has, when the source says. */
  songs?: number;
  /** A single (one song, or a song and its versions) rather than an album or an EP. */
  single?: boolean;
  /** The artist's name in the other alphabet, for matching what was typed ("Netanel Zalevski" for "נתנאל זלבסקי"). */
  aka?: string;
}

/** A song a search found, not yet in the catalog: `keep` stores it there (once) and gives it back as a Track. */
export interface FoundSong {
  /** What tells it apart from the other songs found (its YouTube video id), the same every time it is found. */
  id: string;
  title: string;
  artist: string;
  /** How often it was played, when the source says: the most played copy of a song is the one listed. */
  plays?: number;
  /** A video on YouTube (a clip, or "official audio" with a picture) rather than a song: listed only when no song has it. */
  video?: boolean;
  /** The artist's name in the other alphabet, for matching what was typed. */
  aka?: string;
  /** The album it is on, when it is on one. */
  album?: { id: string; title: string };
  seconds?: number;
  keep(): Promise<Track>;
}

/** An artist a search found. `id` is what opens their page. */
export interface ArtistRef {
  id: string;
  name: string;
  aka?: string;
}

/** What one search finds: songs, albums (and EPs), singles and artists, each kind in the source's order. */
export interface Findings {
  songs: FoundSong[];
  albums: Album[];
  /** Releases of one song, apart from the albums: a menu lists one as a song when no song found has it already. */
  singles?: Album[];
  artists: ArtistRef[];
}

/** Everything by one artist: songs most played first, albums newest first, and how many singles there are. */
export interface ArtistPage {
  artist: ArtistRef;
  songs: FoundSong[];
  albums: Album[];
  singles: number;
}

/**
 * The first place a search looks (Zemer's catalog): one search finds songs, albums and artists together, and an artist
 * opens into all of their songs and albums. Rejects with a SourceError when it can't be asked.
 */
export interface Finder {
  name: string;
  /** Said when it finds nothing: why that can be ("it only has artists on Zemer's list"). */
  hint?: string;
  find(query: string): Promise<Findings>;
  /** Undefined when the artist isn't there (any more). */
  artist(id: string): Promise<ArtistPage | undefined>;
  /**
   * A song about to be sent, completed from its album's page where that's still missing (its number on the album, for
   * the file's tags, and its album's cover, for a song whose own picture was only the video's), or undefined when
   * there's nothing to add or it can't be had quickly. Never rejects.
   */
  fillIn?(track: Track): Promise<Track | undefined>;
}

/** Somewhere to find albums, and open one into its songs. Like a TrackSource, it stores its songs in the catalog. */
export interface AlbumSource {
  name: string;
  hint?: string;
  search(query: string, limit: number): Promise<Album[]>;
  /**
   * The album's songs that may be sent, in album order with their numbers (and lengths, when known), and how many were
   * left out. Rejects with a SourceError whose message says why when none of it may be sent.
   */
  open(id: string): Promise<{ album: Album; songs: Array<{ number: number; track: Track; seconds?: number }>; leftOut: number }>;
}

export interface BotDeps {
  catalog: {
    search(query: string, limit?: number): Track[];
    get(id: number): Track | undefined;
    /** The songs of one music-table.com post (an album's tracks), for picking an album from a list. */
    postTracks?(slug: string): Track[];
  };
  checkAudio(url: string): Promise<AudioCheck>;
  /**
   * Where a search looks first (Zemer): what it finds that fits the words is the answer, and only when nothing fits, or
   * it can't be reached, are the catalog and `source` (music-table.com) looked in. "zemer …" asks it alone.
   */
  finder?: Finder;
  /** Where a search looks when `finder` has nothing (music-table.com), alongside the catalog. */
  source?: TrackSource;
  /** Look in the catalog and `source` before `finder` instead of after (SONG_SOURCES=music-table,youtube-music). */
  musicTableFirst?: boolean;
  /** Opens an album (a 👍 on one) into its songs, sent as a ZIP; and finds albums by name when there is no `finder`. */
  albums?: AlbumSource;
  /** Hears about every song about to be sent, so the most played ones can be kept ready. */
  onPlay?: (track: Track) => void;
  /** Lists to browse: "trending", "new", an artist's songs, holidays, and "more". */
  browse?: Browse;
  /** Artists you follow ("follow …", "unfollow …", "following"), and following for you after several plays. */
  follows?: Follows;
  /** An assistant elsewhere (an add-on, see extensions.ts) that messages starting with its word go to. */
  assistant?: Assistant;
  /** Where the chat's menus, artists, albums and lists are kept, and which is current (see views.ts). In memory unless given. */
  views?: ViewStore;
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
  /** The answer to one message. `trace` hears how long the slow steps took (a search, opening an album), for the host's timeline. */
  handle(msg: Incoming, trace?: Trace): Promise<Reply[]>;
}

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
/** "zemer", or "youtube" (a letter off is fine) and its short forms, as it was called before: look on Zemer alone. */
const isZemerOnly = (word: string): boolean =>
  ['zemer', 'yt', 'ytm', 'ytmusic'].includes(word.toLowerCase()) || editDistance(word.toLowerCase(), 'youtube') <= 1;
/** "artist", "album" or "song" (or the plural): a menu of that kind alone. */
const KIND_WORDS: Record<string, Category> = { artist: 'artists', artists: 'artists', album: 'albums', albums: 'albums', song: 'songs', songs: 'songs' };
/** Songs checked at once before an album goes out; each is a request to the source, so only a few. */
const ALBUM_CHECKS_AT_ONCE = 4;

async function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return out;
}

/** What follows a message's first word when that word is `word` ("Jarvis, look at this" → "look at this"), else undefined. */
export function afterWord(text: string, word: string): string | undefined {
  const first = FIRST_WORD.exec(text);
  return first && first[1]!.toLowerCase() === word ? text.slice(first[0].length).trim() : undefined;
}

/** The help where there are no lists or Zemer (the RCS for Business route, a bare catalog). */
export const HELP_TEXT = helpText({ browse: false, follows: false, finder: false });
/** The whole help, with Zemer, music-table.com's lists and following. */
export const BROWSE_HELP_TEXT = helpText({ browse: true, follows: true, finder: true });

const TRENDING = new Set(['trending', 'top', 'top songs', 'top 10', 'popular', 'hot', 'whats hot', 'what s hot', 'trending songs', 'charts']);
const NEWEST = new Set(['new', 'newest', 'latest', 'new music', 'new songs', 'new releases', 'whats new', 'what s new', 'latest music']);
const MORE = new Set(['more', 'next', 'show more', 'more please', 'next page']);
/** "zip", "send zip" or "whole album": the album on screen as one zip. */
const ZIP_WORDS = new Set(['zip', 'send zip', 'send the zip', 'the zip', 'whole album', 'the whole album', 'send whole album', 'send the whole album']);
/** "all" sends every song on the list on screen (the runner turns it into an `all:` postback); at most this many. */
export const ALL_WORDS = new Set(['all', 'all of them', 'send all', 'send them all', 'get all', 'everything', 'all please']);
const MAX_ALL = 20;
const LIST_SIZE = 10;
/** A menu or list stays pickable by number for a couple of hours (from when it was last used). */
const LIST_VALID_MS = 2 * 60 * 60_000;

export function describe(track: Track): string {
  return track.artist ? `${track.artist} — ${track.title}` : track.title;
}

const say = (text: string, chips?: Chip[]): Reply => (chips ? { kind: 'text', text, chips } : { kind: 'text', text });

function chipLabel(n: number, title: string): string {
  const chars = Array.from(`${n}. ${title}`);
  return chars.length <= MAX_CHIP_LABEL ? chars.join('') : `${chars.slice(0, MAX_CHIP_LABEL - 1).join('')}…`;
}

/** A song as two sources would both spell it (a single "Achas (feat. X)" is the song "Achas"), so the same song from each is told apart from different ones. */
const sameSong = (track: { title: string; artist: string }): string => `${tokenize(withoutGuests(track.title)).join(' ')}|${tokenize(track.artist).join(' ')}`;

/** Both lists, without repeats (the same song twice counts as one: the first list's copy stays), the first one's order first, at most `limit`. */
function merge(first: Track[], second: Track[], limit: number): Track[] {
  const seen = new Set<number>();
  const songs = new Set<string>();
  const out: Track[] = [];
  for (const track of [...first, ...second]) {
    if (out.length >= limit) break;
    if (seen.has(track.id) || songs.has(sameSong(track))) continue;
    seen.add(track.id);
    songs.add(sameSong(track));
    out.push(track);
  }
  return out;
}

export { shortCredit, songLine };

type TextReply = Extract<Reply, { kind: 'text' }>;

/**
 * For chats where a 👍 can't reach the bot (Beeper, RCS for Business, a terminal), where a number picks instead: each
 * line of a list (and each cover in a collage) gets its number from the list's chips, a list's lines are folded back into
 * one message under its heading, and its closing line says to reply with a number (`numbered`, where it has one). The
 * numbers a list has for a 👍 chat (an album's, which opens its songs there) are left out: here every line has one.
 * Everything else is left as it is.
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
    const { number: _number, numbers: _numbers, numbered, ...plain } = reply;
    if (plain.chips) {
      const text = numbered ?? plain.text;
      return { ...plain, text: text.replace(/^Tap 👍 on (?:one|a song|it) to\b/m, 'Reply with a number to') };
    }
    const n = plain.postback === undefined ? undefined : numbers.get(plain.postback);
    return n === undefined ? plain : { ...plain, text: `${n}. ${plain.text}` };
  });
  const out: Reply[] = [];
  const isLine = (reply: Reply | undefined): reply is TextReply => reply?.kind === 'text' && Boolean(reply.postback) && !reply.chips;
  // A heading is a plain text right before a line: a list's title, or the artist a group of lines is listed under.
  const isHeading = (at: number): boolean => {
    const reply = replies[at];
    return reply?.kind === 'text' && !reply.postback && !reply.chips && isLine(replies[at + 1]);
  };
  for (let i = 0; i < replies.length; i += 1) {
    const reply = replies[i]!;
    if (isLine(reply) || isHeading(i)) {
      const lines: string[] = [];
      let j = i;
      while (isLine(replies[j]) || isHeading(j)) lines.push((replies[j] as TextReply).text), (j += 1);
      const closing = replies[j];
      if (closing?.kind === 'text' && closing.chips) {
        out.push({
          kind: 'text',
          text: [...lines, ...(closing.text ? ['', closing.text] : [])].join('\n'),
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

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A place that couldn't be searched, and why. */
interface Failure {
  name: string;
  message: string;
}

/** "I couldn't search music-table.com right now: the site is down." */
const couldNot = (failures: Failure[]): string =>
  failures.length === 1
    ? `I couldn't search ${failures[0]!.name} right now: ${failures[0]!.message}.`
    : `I couldn't search ${failures.map((failure) => `${failure.name} (${failure.message})`).join(' or ')} right now.`;

/** A line a menu can show: its words, and what a 👍 on it does (a song's is known once it is stored, when it is shown). */
interface Entry {
  kind: ShownLine['kind'];
  id: string;
  text: string;
  label: string;
  postback: string | (() => Promise<string>);
}

/** What a view lists, in full and in order: paging shows what of it has not been shown yet. */
interface Contents {
  /** What the view is called: "Back to "achas"", "That's all the songs for "achas"". */
  title: string;
  lists: Record<Category, Entry[]>;
}

/** The trace of the message being answered (`Bot.handle`), for the steps it takes, wherever they are. */
const tracing = new AsyncLocalStorage<Trace>();
/** One slow step of an answer, timed for its trace when it has one. */
const step = <T>(name: string, work: Promise<T>): Promise<T> => timed(tracing.getStore(), name, work);

export function createBot(deps: BotDeps): Bot {
  const now = deps.now ?? (() => new Date());
  const views = deps.views ?? memoryViews();
  const help = (): string => {
    const text = helpText({ browse: Boolean(deps.browse), follows: Boolean(deps.follows), finder: Boolean(deps.finder || deps.albums) });
    const word = deps.assistant?.word;
    return word ? `${text}\n${word} <message> — ask ${deps.assistant!.name}; the answer comes back here` : text;
  };

  const viewTitle = (view: View): string => {
    const key = view.key;
    if (key.kind === 'search') return key.query;
    if (key.kind === 'artist') return key.name ?? 'the artist';
    if (key.kind === 'album') return key.title ?? 'the album';
    return key.page.title?.split('\n')[0]?.replace(/^\S+\s+/u, '') ?? 'the list';
  };

  /** What a number or "all" picks in a view: its lines so far, and the numbers of its albums (or an album's songs). */
  function choicesOf(view: View): Pick<TextReply, 'chips' | 'chipsValidMs' | 'numbers'> {
    const numbered = view.shown.filter((line) => line.number !== undefined && (view.key.kind === 'album' ? line.kind === 'song' : line.kind === 'album'));
    return {
      chips: view.shown.map((line, i) => ({ label: chipLabel(i + 1, line.label), postback: inView(line.postback, view.id) })),
      chipsValidMs: LIST_VALID_MS,
      ...(numbered.length > 0 ? { numbers: numbered.map((line) => ({ number: line.number!, postback: inView(line.postback, view.id) })) } : {}),
    };
  }

  /** A reply that only changes what a number or "all" picks: the view's, now that it is the current one again. */
  const choicesReply = (view: View): Reply => ({ kind: 'text', text: '', ...choicesOf(view) });

  const shownKey = (line: { kind: string; id: string }): string => `${line.kind}:${line.id}`;

  /** What is left of a list in a view (not shown yet). */
  function left(view: View, entries: Entry[]): Entry[] {
    const shown = new Set(view.shown.map(shownKey));
    return entries.filter((entry) => !shown.has(shownKey(entry)));
  }

  /** The kinds a view's menu is about: the ones it has shown, or the one it was asked for. */
  function kindsOf(view: View): Category[] {
    const shown = new Set(view.shown.map((line) => `${line.kind}s` as Category));
    if (view.key.kind === 'search' && view.key.only) shown.add(view.key.only);
    return CATEGORIES.filter((kind) => shown.has(kind));
  }

  /**
   * The next lines of a view: up to `counts` of each kind not shown yet, artists, then albums (numbered on from the ones
   * shown before), then songs, each a message of its own, and the closing line (a 👍 on it comes back here).
   */
  async function page(view: View, contents: Contents, counts: Partial<Record<Category, number>>, before: Reply[] = []): Promise<Reply[]> {
    const lines: Reply[] = [];
    let albums = view.shown.filter((line) => line.kind === 'album').length;
    for (const kind of CATEGORIES) {
      const wanted = counts[kind] ?? 0;
      if (wanted === 0) continue;
      const next = left(view, contents.lists[kind]).slice(0, wanted);
      const postbacks = await Promise.all(next.map((entry) => (typeof entry.postback === 'string' ? entry.postback : entry.postback())));
      next.forEach((entry, i) => {
        const number = entry.kind === 'album' ? ++albums : undefined;
        view.shown.push({ kind: entry.kind, id: entry.id, postback: postbacks[i]!, label: entry.label, ...(number !== undefined ? { number } : {}) });
        lines.push({ kind: 'text', text: entry.text, postback: inView(postbacks[i]!, view.id), ...(number !== undefined ? { number } : {}) });
      });
    }
    views.save(view);
    return [...before, ...lines, closingOf(view, contents)];
  }

  /** A view's last line: what more it has, an album's number, and a 👍 on it to come back. */
  function closingOf(view: View, contents: Contents): Reply {
    const more = kindsOf(view).filter((kind) => left(view, contents.lists[kind]).length > 0);
    const has = (kind: ShownLine['kind']): boolean => view.shown.some((line) => line.kind === kind);
    const { text, numbered } = closingLine(more, has('album'), has('song'));
    return { kind: 'text', text, numbered, postback: `view:${view.id}`, ...choicesOf(view) };
  }

  /** Makes a view the current one; true when that changed it. */
  function makeCurrent(view: View): boolean {
    const was = views.current()?.id;
    views.setCurrent(view.id);
    return was !== view.id;
  }

  // --- what each view lists ---

  /** A Zemer song as a menu line: "Title — Artist" (the artist left out where the menu is one artist's). */
  const songEntry = (song: FoundSong, credit: boolean): Entry => ({
    kind: 'song',
    id: song.id,
    text: songLine(song, credit),
    label: shownTitle(song.title),
    postback: async () => `play:${(await song.keep()).id}`,
  });
  /** A single that no song found has: a 👍 opens it and sends its song. */
  const singleEntry = (single: Album, credit: boolean): Entry => ({
    kind: 'song',
    id: `single:${single.id}`,
    text: songLine(single, credit),
    label: shownTitle(single.title),
    postback: `single:${single.id}`,
  });
  const albumEntry = (album: Album, credit: boolean): Entry => ({ kind: 'album', id: album.id, text: albumLine(album, credit), label: album.title, postback: `album:${album.id}` });
  const artistEntry = (artist: ArtistRef): Entry => ({ kind: 'artist', id: artist.id, text: artistLine(artist.name), label: artist.name, postback: `artist:${artist.id}` });
  const trackEntry = (track: Track, credit: boolean): Entry => ({ kind: 'song', id: `t${track.id}`, text: songLine(track, credit), label: shownTitle(track.title), postback: `play:${track.id}` });

  /**
   * A search's menu from what Zemer found: the artists the words name, the albums and songs that have every word, each
   * kind in its order (ranking.ts). Singles are songs here, unless a song found has them already, and a video is one only
   * when no song does. Undefined when nothing fits (and why, when Zemer couldn't be asked, in `failures`).
   */
  async function zemerContents(query: string, tokens: string[], failures: Failure[]): Promise<Contents | undefined> {
    const finder = deps.finder;
    let found: Findings;
    try {
      if (finder) found = await step('zemer', finder.find(query));
      else if (deps.albums) found = { songs: [], albums: await step('albums', deps.albums.search(query, 20)), artists: [] };
      else return undefined;
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      failures.push({ name: finder?.name ?? deps.albums!.name, message: err.message });
      return undefined;
    }
    const artists = rankArtists(found.artists, tokens);
    const songs = rankSongs(found.songs, tokens);
    const sung = new Set(songs.map(sameSong));
    const singles = (found.singles ?? []).filter((single) => !sung.has(sameSong(single)) && songTier(single, tokens) > 0);
    const albums = rankAlbums(
      found.albums.filter((album) => !album.single),
      tokens,
    );
    if (artists.length + songs.length + singles.length + albums.length === 0) return undefined;
    const only = artists.length === 1 ? artists[0] : undefined;
    // Singles go in among the songs, by how well the words fit them (they have no play count: after the songs of their tier).
    const tierOf = new Map<string, number>([...songs.map((song): [string, number] => [song.id, songTier(song, tokens)]), ...singles.map((single): [string, number] => [`single:${single.id}`, songTier(single, tokens)])]);
    const songEntries = [...songs.map((song) => songEntry(song, creditNeeded(song.artist, only))), ...singles.map((single) => singleEntry(single, creditNeeded(single.artist, only)))];
    const order = new Map(songEntries.map((entry, i) => [entry.id, i]));
    songEntries.sort((a, b) => (tierOf.get(b.id) ?? 0) - (tierOf.get(a.id) ?? 0) || order.get(a.id)! - order.get(b.id)!);
    return {
      title: query,
      lists: {
        artists: artists.map(artistEntry),
        albums: albums.map((album) => albumEntry(album, creditNeeded(album.artist, only))),
        songs: songEntries,
      },
    };
  }

  /**
   * A search's menu from the catalog and music-table.com: an artist the site has (a 👍 lists their releases) and the
   * songs that fit, the site's first. `want` is how many songs are needed. Undefined when there are none.
   */
  async function musicTableContents(query: string, tokens: string[], want: number, failures: Failure[]): Promise<Contents | undefined> {
    const local = deps.catalog.search(query, want);
    let found = local;
    if (deps.source) {
      try {
        found = merge(await step('music-table', deps.source.lookup(query, want)), local, want);
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        failures.push({ name: deps.source.name, message: err.message });
      }
    }
    const artist = deps.browse?.artist(tokens);
    if (found.length === 0 && !artist) return undefined;
    // The songs the words name first (a stable sort: otherwise in the site's order).
    const tiers = new Map(found.map((track) => [track.id, songTier(track, tokens)]));
    const songs = [...found].sort((a, b) => tiers.get(b.id)! - tiers.get(a.id)!);
    return {
      title: query,
      lists: {
        artists: artist ? [{ kind: 'artist', id: `mt${artist.id}`, text: artistLine(artist.name), label: artist.name, postback: `mtartist:${artist.id}` }] : [],
        albums: [],
        songs: songs.map((track) => trackEntry(track, creditNeeded(track.artist, artist))),
      },
    };
  }

  /** An artist's page on Zemer: their albums, newest first (an album's editions as one), and their songs, most played first. */
  async function artistContents(artistId: string): Promise<{ contents: Contents; page: ArtistPage } | undefined> {
    if (!deps.finder) return undefined;
    const page = await step('artist', deps.finder.artist(artistId));
    if (!page || page.songs.length + page.albums.length === 0) return undefined;
    const theirs = { name: page.artist.name, ...(page.artist.aka ? { aka: page.artist.aka } : {}) };
    return {
      page,
      contents: {
        title: page.artist.name,
        lists: {
          artists: [],
          albums: foldEditions(page.albums).map((album) => albumEntry(album, creditNeeded(album.artist, theirs))),
          // A song is listed even when its album is listed too (the owner asked, 2026-10-20).
          songs: page.songs.map((song) => songEntry(song, creditNeeded(song.artist, theirs))),
        },
      },
    };
  }

  /** What a view lists now (asked again: the sources keep their answers a few minutes). Undefined when it can't be had. */
  async function contentsOf(view: View, want: number): Promise<Contents | undefined> {
    const key = view.key;
    try {
      if (key.kind === 'search') {
        const tokens = parseQuery(key.query);
        return key.from === 'music-table' ? musicTableContents(key.query, tokens, want, []) : zemerContents(key.query, tokens, []);
      }
      if (key.kind === 'artist') return (await artistContents(key.artistId))?.contents;
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
    }
    return undefined;
  }

  // --- searching ---

  /**
   * A menu for the words: Zemer first, then the catalog and music-table.com (the other way round with musicTableFirst),
   * the first with something that fits answering. `only` one kind ("album …"), or Zemer alone ("zemer …"). Nothing is
   * picked for the owner: even one song the words name exactly is a menu of one.
   */
  async function search(raw: string, options: { only?: Category; zemerOnly?: boolean } = {}): Promise<Reply[]> {
    const tokens = parseQuery(raw);
    if (tokens.every((token) => token.length < 2)) {
      if (options.zemerOnly) return [say('Text "zemer" and a song or an artist, like "zemer lipa vnusni".')];
      if (options.only === 'albums') return [say('Text "album" and an album or an artist, like "album a poshiter yid" or "album lipa".')];
      if (options.only === 'artists') return [say('Text "artist" and a name, like "artist lipa".')];
      if (options.only === 'songs') return [say('Text "song" and a song, like "song vnusni".')];
      return [say(`Text "search" and ${deps.browse || deps.finder ? 'a song or an artist, like "search lipa vnusni"' : 'a song name, like "search blue horizon night owls"'}.`)];
    }
    const failures: Failure[] = [];
    const kinds = (contents: Contents): number => (options.only ? contents.lists[options.only].length : CATEGORIES.reduce((sum, kind) => sum + contents.lists[kind].length, 0));
    const fromZemer = async (): Promise<{ contents: Contents; from?: 'music-table' } | undefined> => {
      const contents = await zemerContents(raw, tokens, failures);
      return contents && kinds(contents) > 0 ? { contents } : undefined;
    };
    const fromMusicTable = async (): Promise<{ contents: Contents; from?: 'music-table' } | undefined> => {
      if (options.zemerOnly || options.only === 'albums') return undefined;
      const contents = await musicTableContents(raw, tokens, FIRST_PAGE, failures);
      return contents && kinds(contents) > 0 ? { contents, from: 'music-table' } : undefined;
    };
    const steps = deps.musicTableFirst ? [fromMusicTable, fromZemer] : [fromZemer, fromMusicTable];
    for (const next of steps) {
      const found = await next();
      if (!found) continue;
      // A search starts afresh: it is under no other view, so "… more" never goes on with an older one from it.
      const view = views.open({ kind: 'search', query: raw, ...(options.only ? { only: options.only } : {}), ...(options.zemerOnly ? { zemerOnly: true } : {}), ...(found.from ? { from: found.from } : {}) });
      makeCurrent(view);
      const counts: Partial<Record<Category, number>> = options.only ? { [options.only]: FIRST_PAGE } : { artists: FIRST_PAGE, albums: FIRST_PAGE, songs: FIRST_PAGE };
      return page(view, found.contents, counts);
    }
    const zemer = deps.finder?.name ?? deps.albums?.name;
    if (options.zemerOnly && !deps.finder) return [say('Zemer is turned off (YOUTUBE_MUSIC=off), so there is nothing to search there.')];
    if (options.only === 'albums' && !zemer) return [say('Albums come from Zemer, which is turned off (YOUTUBE_MUSIC=off).')];
    const asked = [zemer, options.zemerOnly || options.only === 'albums' ? undefined : deps.source?.name].filter((name): name is string => name !== undefined);
    // Nothing found because nobody could be asked is not the same as nothing found.
    if (asked.length > 0 && failures.length >= asked.length) return [say(couldNot(failures))];
    const hint = (options.zemerOnly || options.only === 'albums') && (deps.finder?.hint ?? deps.albums?.hint) ? ` (${deps.finder?.hint ?? deps.albums?.hint})` : '';
    const on = asked.length > 0 ? ` on ${asked.join(' or ')}` : '';
    if (options.only === 'albums') return [say(`No album for "${raw}"${on}${hint}. Try the artist and the album's name, or fewer words.`)];
    if (options.only === 'artists') return [say(`No artist for "${raw}"${on}. Try their full name, or fewer words.`)];
    return [say(`No match for "${raw}"${on}${hint}. Try the artist and title, or fewer words.`)];
  }

  // --- views opened from a menu ---

  /** An artist's view: their name (a 👍 on it comes back here), their newest albums and most played songs, 5 of each. */
  async function openArtist(artistId: string, parent: number | undefined): Promise<Reply[]> {
    let found: Awaited<ReturnType<typeof artistContents>>;
    try {
      found = await artistContents(artistId);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      return [say(`I can't open that artist right now: ${err.message}.`)];
    }
    if (!found) return [say("I can't open that artist: Zemer doesn't have them (any more).")];
    const { page: artistPage, contents } = found;
    const view = views.open({ kind: 'artist', artistId, name: artistPage.artist.name }, parent);
    makeCurrent(view);
    const albums = contents.lists.albums.length;
    const sizes = [albums > 0 && plural(albums, 'album'), artistPage.songs.length > 0 && plural(artistPage.songs.length, 'song')].filter(Boolean).join(' · ');
    const header: Reply = { kind: 'text', text: `${artistLine(artistPage.artist.name)}${sizes ? ` · ${sizes}` : ''}`, postback: `view:${view.id}` };
    return page(view, contents, { albums: FIRST_PAGE, songs: FIRST_PAGE }, [header]);
  }

  /**
   * An album's view: the album (a 👍 on it comes back here), each song with its number on the album (a 👍, or its
   * number, gets it), and its zip (📦: a 👍 on it, or "zip", gets all of it). Nothing is downloaded until something is picked.
   */
  async function openAlbum(albumId: string, parent: number | undefined): Promise<Reply[]> {
    const albums = deps.albums;
    if (!albums) return [say('Albums come from Zemer, which is turned off (YOUTUBE_MUSIC=off).')];
    let opened: Awaited<ReturnType<AlbumSource['open']>>;
    try {
      opened = await step('album', albums.open(albumId));
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      return [say(`I can't open that album: ${err.message}.`)];
    }
    const { album, songs, leftOut } = opened;
    const view = views.open({ kind: 'album', albumId: album.id, title: album.title }, parent);
    makeCurrent(view);
    // A song that is someone else's too (a duet, a guest) still says so.
    const credit = (artist: string): boolean => artistKey(artist) !== artistKey(album.artist);
    view.shown = songs.map(({ number, track }) => ({ kind: 'song', id: `t${track.id}`, postback: `play:${track.id}`, label: shownTitle(track.title), number }));
    views.save(view);
    const seconds = songs.reduce((sum, song) => sum + (song.seconds ?? 0), 0);
    const length = songs.every((song) => song.seconds) && seconds > 0 ? ` · ${Math.max(1, Math.round(seconds / 60))} min` : '';
    const out = leftOut > 0 ? ` (${plural(leftOut, 'song')} left out: not on Zemer's list.)` : '';
    return [
      { kind: 'text', text: albumLine(album, true), postback: `view:${view.id}` },
      ...songs.map(({ number, track }): Reply => ({ kind: 'text', text: songLine(track, credit(track.artist)), postback: inView(`play:${track.id}`, view.id), number })),
      { kind: 'text', text: `📦 All ${plural(songs.length, 'song')} as one zip${length}`, postback: inView(`zip:${album.id}`, view.id) },
      {
        kind: 'text',
        text: `Tap 👍 on the songs you want, or text their numbers; 👍 📦 or text "zip" for all of it.${out}`,
        numbered: `Reply with the number of a song to get it, or "zip" for all of it.${out}`,
        postback: `view:${view.id}`,
        ...choicesOf(view),
      },
    ];
  }

  /** "songs more" (or artists, albums): the next 8 of that kind in the current view, or the nearest view above it that has them. */
  async function showMore(kind: Category): Promise<Reply[]> {
    const current = views.current();
    if (!current) return [say(`Text "search" and a song or an artist first; then "${kind} more" shows ${NEXT_PAGE} more.`)];
    for (let view: View | undefined = current; view; view = view.parent !== undefined ? views.get(view.parent) : undefined) {
      if (view.key.kind !== 'search' && view.key.kind !== 'artist') continue;
      const contents = await contentsOf(view, view.shown.length + NEXT_PAGE + 1);
      if (!contents || contents.lists[kind].length === 0) continue;
      const moved = makeCurrent(view);
      view.lastMore = kind;
      if (left(view, contents.lists[kind]).length === 0) {
        views.save(view);
        return [say(`That's all the ${kind} for "${contents.title}".`), ...(moved ? [choicesReply(view)] : [])];
      }
      return page(view, contents, { [kind]: NEXT_PAGE });
    }
    return [say(`There are no ${kind} in this list.`)];
  }

  /** "more": the next page of a music-table.com list, or the last "… more" again, or what more there is to ask for. */
  async function more(): Promise<Reply[]> {
    let view = views.current();
    while (view && view.key.kind === 'album' && view.parent !== undefined) view = views.get(view.parent);
    if (!view || view.key.kind === 'album') return [say(`Text ${deps.browse ? '"trending", "new" or ' : ''}"search" and a song first; then "more" shows the next ones.`)];
    if (view.key.kind === 'list') {
      makeCurrent(view);
      return showList(view, view.key.page.title ?? 'More', "That's all of them.");
    }
    if (view.lastMore) return showMore(view.lastMore);
    const contents = await contentsOf(view, view.shown.length + NEXT_PAGE + 1);
    const kinds = contents ? kindsOf(view).filter((kind) => left(view, contents.lists[kind]).length > 0) : [];
    if (kinds.length === 0) return [say(`That's all for "${viewTitle(view)}".`)];
    return [say(`Text ${orList(kinds.map((kind) => `"${kind} more"`))}.`)];
  }

  /** A 👍 on a view's own line (its closing line, or an artist's or album's name): back to that view, nothing sent. */
  function goBack(id: number): Reply[] {
    const view = views.get(id);
    if (!view) return [say('That list is gone; text "search" and a song to start again.')];
    makeCurrent(view);
    return [say(`Back to "${viewTitle(view)}".`), choicesReply(view)];
  }

  // --- music-table.com's lists ---

  /** One page of a list: the heading, ten songs, and how to go on. Where numbers pick, they run on across pages. */
  async function showList(view: View, heading: string, empty: string): Promise<Reply[]> {
    const browse = deps.browse!;
    if (view.key.kind !== 'list') return [];
    const listPage = view.key.page;
    const fetch = async (limit: number, offset: number): Promise<ListedTrack[]> =>
      listPage.kind === 'trending'
        ? browse.trending(limit, offset)
        : listPage.kind === 'new'
          ? browse.newest(limit, offset)
          : listPage.kind === 'category'
            ? ((await browse.category?.(listPage.category ?? '', limit, offset)) ?? [])
            : browse.artistSongs(listPage.artistId ?? -1, limit, offset);
    let got: ListedTrack[];
    try {
      got = await step('list', fetch(LIST_SIZE + 1, listPage.shown));
    } catch (err) {
      if (err instanceof SourceError) return [say(`I couldn't get that list from music-table.com: ${err.message}.`)];
      throw err;
    }
    if (got.length === 0) return [say(listPage.shown === 0 ? empty : "That's all of them.")];
    const songs = got.slice(0, LIST_SIZE);
    const hasMore = got.length > LIST_SIZE;
    view.key = { kind: 'list', page: { ...listPage, shown: listPage.shown + songs.length, title: heading } };
    const today = now();
    const line = (track: ListedTrack): string => {
      const when = shortDate(track.releasedAt, today);
      const date = when ? ` · ${when}` : '';
      if (track.album) {
        const parts = splitTitle(track.album.title);
        const title = parts.title || track.album.title;
        return `💿 ${title}${listPage.kind === 'artist' || !parts.artist ? '' : ` — ${shortCredit(parts.artist)}`} · ${plural(track.album.songs, 'song')}${date}`;
      }
      return `${songLine(track, listPage.kind !== 'artist')}${date}`;
    };
    // Picking an album lists its songs; picking a song sends it.
    const pick = (track: ListedTrack): string => (track.album && track.post ? `post:${track.post}` : `play:${track.id}`);
    for (const track of songs) {
      view.shown.push({ kind: track.album ? 'album' : 'song', id: pick(track), postback: pick(track), label: track.album ? splitTitle(track.album.title).title || track.title : shownTitle(track.title) });
    }
    views.save(view);
    return [
      { kind: 'text', text: listPage.shown === 0 ? heading : `${heading} (continued)` },
      ...songs.map((track): Reply => ({ kind: 'text', text: line(track), postback: inView(pick(track), view.id) })),
      { kind: 'text', text: `Tap 👍 on one to get it${hasMore ? ', or text "more" for the next ones' : ''}.`, postback: `view:${view.id}`, ...choicesOf(view) },
    ];
  }

  /** A new list view (trending, new, a holiday, an artist's releases) and its first page. */
  function openList(listPage: ListPage, heading: string, empty: string, parent = views.current()?.id): Promise<Reply[]> {
    const view = views.open({ kind: 'list', page: listPage }, parent);
    makeCurrent(view);
    return showList(view, heading, empty);
  }

  /** "trending", "new" or a holiday, when the lists are there. */
  function browseFor(tokens: string[]): Promise<Reply[]> | undefined {
    const phrase = tokens.join(' ');
    const browse = deps.browse;
    if (!browse) return undefined;
    // In a season with its own music, the general lists point to it.
    const season = seasonOn(now());
    const withSeason = (heading: string) => (season ? `${heading}\n${season.hint}` : heading);
    if (TRENDING.has(phrase)) return openList({ kind: 'trending', shown: 0 }, withSeason('🔥 Trending on music-table.com'), 'Nothing is trending yet: the catalog is still being filled. Try again in a few minutes.');
    if (NEWEST.has(phrase)) return openList({ kind: 'new', shown: 0 }, withSeason('🆕 New on music-table.com'), 'No new songs yet: the catalog is still being filled. Try again in a few minutes.');
    const category = browse.category ? categoryFor(phrase) : undefined;
    if (category) {
      return openList(
        { kind: 'category', category: category.slug, shown: 0 },
        `${category.emoji} ${category.name} · most popular first`,
        `I couldn't find ${category.name} songs on music-table.com right now.`,
      );
    }
    return undefined;
  }

  /** An artist's songs on music-table.com (a 👍 on their 🎤 line), newest first. */
  function musicTableArtist(artistId: number, parent: number | undefined): Promise<Reply[]> {
    const name = deps.browse?.artistName(artistId);
    if (!deps.browse || !name) return Promise.resolve([say("I don't know that artist any more.")]);
    const releases = deps.browse.artistReleases(artistId);
    return openList({ kind: 'artist', artistId, shown: 0 }, `🎤 ${name} · ${plural(releases, 'release')} on music-table.com, newest first`, `I have no songs by ${name}.`, parent);
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

  // --- sending ---

  async function play(found: Track): Promise<Reply[]> {
    const [check, filled] = await Promise.all([step('check', deps.checkAudio(found.url)), deps.finder?.fillIn ? step('fill-in', deps.finder.fillIn(found).catch(() => undefined)) : undefined]);
    if (!check.ok) return [say(`I can't send "${describe(found)}": ${check.reason}.`)];
    const track = filled ?? found;
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

  /**
   * A single (a 👍 on one in a menu): its song is sent like any other. A "single" of several songs (Zemer calls some EPs
   * that: "FOREVER VOL 1", four songs) opens like an album instead, to pick from.
   */
  async function playSingle(id: string, parent: number | undefined): Promise<Reply[]> {
    if (!deps.albums) return [say('Singles come from Zemer, which is turned off (YOUTUBE_MUSIC=off).')];
    try {
      const opened = await step('album', deps.albums.open(id));
      if (opened.songs.length > 1) return openAlbum(id, parent);
      const song = opened.songs[0];
      return song ? play(song.track) : [say("I can't send that song: it has nothing I can get.")];
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      return [say(`I can't send that song: ${err.message}.`)];
    }
  }

  /** An album as one reply for the runner to zip: its cover first, and a word on any songs that had to stay out. */
  async function sendAlbum(id: string): Promise<Reply[]> {
    const albums = deps.albums;
    if (!albums) return [say('Albums come from Zemer, which is turned off (YOUTUBE_MUSIC=off).')];
    let opened: Awaited<ReturnType<AlbumSource['open']>>;
    try {
      opened = await step('album', albums.open(id));
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      return [say(`I can't send that album: ${err.message}.`)];
    }
    const { album, songs, leftOut } = opened;
    const name = `${album.artist ? `${album.artist} — ` : ''}${album.title}${album.year ? ` (${album.year})` : ''}`;
    // Every song is checked the way a single song is (the list it must be on, its size), so nothing goes that couldn't alone.
    const checks = await step('check', inBatches(songs, ALBUM_CHECKS_AT_ONCE, (song) => deps.checkAudio(song.track.url)));
    const sendable = songs.filter((_, i) => checks[i]!.ok);
    const refused = checks.flatMap((check) => (check.ok ? [] : [check.reason]));
    if (sendable.length === 0) {
      return [say(`I can't send "${name}": ${refused[0] ?? 'none of its songs may be sent'}.`)];
    }
    const out = leftOut + refused.length;
    return [
      album.cover ? { kind: 'image', url: album.cover, caption: { title: album.title, artist: album.artist } } : say(albumLine(album, true)),
      say(`${plural(sendable.length, 'song')}, coming as a zip${out > 0 ? ` (${out} left out)` : ''}.`),
      {
        kind: 'album',
        title: album.title,
        artist: album.artist,
        songs: songs.flatMap((song, i) => {
          const check = checks[i]!;
          return check.ok ? [{ number: song.number, title: song.track.title, url: song.track.url }] : [];
        }),
      },
    ];
  }

  /** Every song on a list ("all"): songs as they are, albums of music-table.com as all their songs, files only (no cards), up to MAX_ALL. */
  async function playAll(postbacks: string[]): Promise<Reply[]> {
    const tracks: Track[] = [];
    const seen = new Set<number>();
    for (const postback of postbacks.map((one) => splitPostback(one).action)) {
      const id = /^play:(\d+)$/.exec(postback)?.[1];
      const slug = /^post:(.+)$/.exec(postback)?.[1];
      const single = /^single:(.+)$/.exec(postback)?.[1];
      let found: Array<Track | undefined> = [];
      if (id !== undefined) found = [deps.catalog.get(Number(id))];
      else if (slug !== undefined) found = deps.catalog.postTracks?.(slug) ?? [];
      else if (single !== undefined && deps.albums) found = [(await step('album', deps.albums.open(single)).catch(() => undefined))?.songs[0]?.track];
      for (const track of found) {
        if (track && !seen.has(track.id)) {
          seen.add(track.id);
          tracks.push(track);
        }
      }
    }
    if (tracks.length === 0) {
      // "all" on a list of albums or artists: one album is a whole zip, so they are not all sent at once.
      const kinds = postbacks.map((one) => splitPostback(one).action);
      if (kinds.length > 0 && kinds.every((one) => /^(album|artist|mtartist|tracks):/.test(one))) {
        return [say("That list has no songs; tap 👍 on an album (💿) for its songs, or on an artist (🎤).")];
      }
      return [say('Those songs are no longer in the catalog.')];
    }
    const chosen = tracks.slice(0, MAX_ALL);
    const checks = await step('check', Promise.all(chosen.map((track) => deps.checkAudio(track.url))));
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
    return [say(`🎵 Here come all ${count}${capped}:`), ...files, ...(refused.length > 0 ? [say(`I couldn't send ${refused.join(', ')}.`)] : [])];
  }

  /** A music-table.com album (a 👍 on one in a list): its songs, in album order, to pick from. */
  function postSongs(slug: string): Reply[] | Promise<Reply[]> {
    const tracks = deps.catalog.postTracks?.(slug) ?? [];
    if (tracks.length === 0) return [say('That album is no longer in the catalog.')];
    if (tracks.length === 1) return play(tracks[0]!);
    const shown = tracks.slice(0, 30);
    // In album order, with the album's own numbers ("01 Intro").
    const heading = shown[0]!.artist ? `${shortCredit(shown[0]!.artist)} · ${plural(tracks.length, 'song')}` : plural(tracks.length, 'song');
    return [
      { kind: 'text', text: heading },
      ...shown.map((track): Reply => ({ kind: 'text', text: track.title, postback: `play:${track.id}` })),
      { kind: 'text', text: 'Tap 👍 on one to get it.', chips: shown.map((track, i) => ({ label: chipLabel(i + 1, track.title), postback: `play:${track.id}` })), chipsValidMs: LIST_VALID_MS },
    ];
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

  /**
   * A 👍 (or a number, or "all"). One with a view (`play:42@41`) makes that view the current one first: a 👍 on any line
   * of an earlier menu goes back to it. An artist's or album's line opens it as a view of its own, under that one.
   */
  async function onPostback(postback: string): Promise<Reply[]> {
    const all = /^all:(.+)$/s.exec(postback)?.[1];
    if (all !== undefined) return playAll(all.split('|'));
    const { action, view: from } = splitPostback(postback);
    const there = from !== undefined ? views.get(from) : undefined;
    if (there) makeCurrent(there);
    const [, verb = '', arg = ''] = /^([a-z]+):(.*)$/s.exec(action) ?? [];
    switch (verb) {
      case 'view':
        return goBack(Number(arg));
      case 'artist':
        return openArtist(arg, there?.id ?? views.current()?.id);
      case 'album':
      case 'tracks':
        // An album opens into its songs (the owner chose this on 2026-10-20; its zip is a 📦 line there), old lines too.
        return openAlbum(arg, there?.id ?? views.current()?.id);
      case 'zip':
        return sendAlbum(arg);
      case 'single':
        return playSingle(arg, there?.id ?? views.current()?.id);
      case 'mtartist':
        return musicTableArtist(Number(arg), there?.id ?? views.current()?.id);
      case 'post':
        return postSongs(arg);
      case 'play': {
        const track = /^\d+$/.test(arg) ? deps.catalog.get(Number(arg)) : undefined;
        return track ? play(track) : [say('That track is no longer in the catalog.')];
      }
      default:
        return [say(help())];
    }
  }

  async function onText(msg: Incoming): Promise<Reply[]> {
    const whole = (msg.text ?? '').trim();
    // "jarvis …" goes on whole, however long; it's for the assistant, not a search.
    const forAssistant = deps.assistant ? afterWord(whole, deps.assistant.word) : undefined;
    if (forAssistant !== undefined) return ask(forAssistant, msg.messageId);
    const raw = whole.slice(0, MAX_QUERY_CHARS);
    const words = tokenize(raw);
    // Nothing to answer: no words, a greeting or "help", or only single characters (a stray "a", or a "2" with no list to pick from).
    if (words.every((word) => word.length < 2) || GREETINGS.has(words[0]!)) return [say(help())];
    const phrase = words.join(' ');
    // "songs more" before "songs …": paging, not a search for "more" (an album called "More" needs "search more").
    const kind = KIND_WORDS[words[0]!];
    if (kind && words.length === 2 && MORE.has(words[1]!)) return showMore(kind);
    if (MORE.has(phrase)) return more();
    const first = FIRST_WORD.exec(raw);
    const rest = first ? raw.slice(first[0].length).trim() : '';
    if (first && isSearch(first[1]!)) return search(rest);
    if (first && isZemerOnly(first[1]!)) return search(rest.replace(/^music\b[\s:,-]*/i, '').trim(), { zemerOnly: true });
    if (first && kind) return search(rest, { only: kind });
    if (ZIP_WORDS.has(phrase)) {
      const view = views.current();
      return view?.key.kind === 'album' ? sendAlbum(view.key.albumId) : [say('Open an album first: tap 👍 on a 💿 line.')];
    }
    // "all" with no list open (the runner answers it when one is).
    if (ALL_WORDS.has(phrase)) return [say(`Text ${deps.browse ? '"trending", "new" or ' : ''}"search" and a song first; then "all" sends every song on the list.`)];
    const following = followFor(words);
    if (following) return following;
    const listed = browseFor(words);
    if (listed) return listed;
    // Not a command: most likely a song's name without "search" in front.
    return [say(`To look for a song, start with "search":\nsearch ${raw}\n\nText "help" for the other commands.`)];
  }

  /**
   * The answer to a message. When it moves to another view without showing a list of its own (a song sent from an
   * earlier menu, "Back to …"), it carries that view's numbers, so a number texted next picks from the menu now current.
   */
  async function answer(msg: Incoming): Promise<Reply[]> {
    const before = views.current()?.id;
    const replies = msg.postback !== undefined ? await onPostback(msg.postback) : await onText(msg);
    const after = views.current();
    if (after && after.id !== before && !replies.some((reply) => reply.kind === 'text' && reply.chips)) replies.push(choicesReply(after));
    return replies;
  }

  return {
    handle(msg, trace) {
      return trace ? tracing.run(trace, () => answer(msg)) : answer(msg);
    },
  };
}
