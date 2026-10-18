import { artistKey, splitArtists } from './artists.ts';
import type { AudioCheck } from './audio-check.ts';
import type { ListedTrack } from './catalog.ts';
import type { Browse, ListPage } from './library/browse.ts';
import { categoryFor } from './library/category-list.ts';
import type { Follows } from './library/follows.ts';
import { seasonOn } from './library/seasons.ts';
import { parseQuery, tokenize } from './query.ts';
import { editDistance, fitsAll, namesSong, rankSongs, touchesTitle, wordMatches } from './sources/relevance.ts';
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
  title: string;
  artist: string;
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

/** What one search finds: songs, albums and artists, each kind best first. */
export interface Findings {
  songs: FoundSong[];
  albums: Album[];
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
   * The album's songs that may be sent, in album order with their numbers, and how many were left out. Rejects with a
   * SourceError whose message says why when none of it may be sent.
   */
  open(id: string): Promise<{ album: Album; songs: Array<{ number: number; track: Track }>; leftOut: number }>;
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
/** Albums listed with a search's songs, at most. */
const MAX_ALBUMS_LISTED = 3;
/** An artist's page shows this many of their songs and albums at a time; "more" shows the next ones. */
const ARTIST_SONGS = 5;
const ARTIST_ALBUMS = 5;
/** "album" and an artist lists this many of their albums at a time. */
const ALBUMS_PAGE = 8;
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
/** "album" or "albums". */
const isAlbum = (word: string): boolean => ['album', 'albums'].includes(word.toLowerCase());
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

export const HELP_TEXT =
  'Text "search" and a song name (artist and title work best), and I\'ll send you the audio file.\nExample: search blue horizon night owls';

/** The help when the lists are there too: every command, since a message has to start with one. */
export const BROWSE_HELP_TEXT = [
  'Start each message with a command:',
  '"search" and a song, an album or an artist, like "search lipa vnusni" or "search lipa".',
  '"album" and a name sends the whole album as a zip; "album" and an artist lists their albums.',
  '"zemer" and a song looks only on Zemer (music-table.com is where the rest comes from).',
  '"trending", "new", "chanukah", "purim", "wedding" or "vocal" for music-table.com\'s lists, "more" for the next ones, and "all" for every song on a list.',
  '"follow" and an artist to get their new songs as soon as they\'re out ("unfollow", "following").',
  'Tap 👍 on a song (🎵) or an album (💿) to get it.',
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

/** A song as two sources would both spell it, so the same song from each is told apart from different ones. */
const sameSong = (track: Track): string => `${tokenize(track.title).join(' ')}|${tokenize(track.artist).join(' ')}`;

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

/** "A", "A & B", "A, B & C". */
const joinNames = (names: string[]): string => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} & ${names.at(-1)}`);

/** A credit short enough for one line: "A", "A & B", or "A & 7 more" for a long one. */
export function shortCredit(credit: string): string {
  const names = splitArtists(credit);
  if (names.length <= 2) return names.length > 0 ? joinNames(names) : credit.trim();
  return `${names[0]} & ${names.length - 1} more`;
}

/** A title as it is shown: without the track number some of music-table.com's songs start with ("01 Kumzitz"). */
const shownTitle = (title: string): string => title.replace(/^\d{1,3}[.)]?\s+(?=\p{L})/u, '').trim() || title;

/** The first artist credited, by which a list is told to be one artist's. */
const mainArtist = (credit: string): string => splitArtists(credit)[0] ?? credit.trim();

/** A song in a list: "Title", or "Title — Artist" when the list isn't all theirs. */
export const songLine = (song: { title: string; artist: string }, credit: boolean): string =>
  credit && song.artist ? `${shownTitle(song.title)} — ${shortCredit(song.artist)}` : shownTitle(song.title);

/** An album in a list: "💿 Title · 2008 · 14 songs", with " — Artist" after the title when the list isn't all theirs. */
function albumLine(album: Album, credit = false): string {
  const size = album.single || album.songs === 1 ? 'single' : album.songs ? `${album.songs} songs` : undefined;
  const details = [album.year, size].filter((detail) => detail !== undefined);
  return `💿 ${album.title}${credit && album.artist ? ` — ${shortCredit(album.artist)}` : ''}${details.map((detail) => ` · ${detail}`).join('')}`;
}

/**
 * Songs and albums to pick from, one message each so that a 👍 on one gets it: the songs ("Title — Artist"), then the
 * albums ("💿 Title — Artist · 2008 · 14 songs"). When they are all one artist's, the artist's name comes first, once
 * ("🎤 Lipa Schmeltzer"), and the lines leave it out. A closing line, when given, says what else can be done ("more").
 * The list's chips (what "all" sends, and the numbers where a 👍 can't reach the bot) ride on the last message, which
 * the runner doesn't send when it has no words.
 */
function pickList(songs: Track[], albums: Album[], options: { heading?: string; closing?: string; validMs?: number } = {}): Reply[] {
  const artists = new Set([...songs, ...albums].map((item) => artistKey(mainArtist(item.artist))));
  const first = songs[0] ?? albums[0];
  const oneArtist = artists.size === 1 && first !== undefined && artistKey(first.artist) !== '';
  const heading = options.heading ?? (oneArtist ? `🎤 ${mainArtist(first.artist)}` : undefined);
  // Under an artist's name, a song that is someone else's too still says so.
  const credit = (artist: string): boolean => !oneArtist || artistKey(artist) !== artistKey(mainArtist(artist));
  const entries = [
    ...songs.map((song) => ({ text: songLine(song, credit(song.artist)), postback: `play:${song.id}`, label: shownTitle(song.title) })),
    ...albums.map((album) => ({ text: albumLine(album, !oneArtist), postback: `album:${album.id}`, label: album.title })),
  ];
  const chips = entries.map((entry, i) => ({ label: chipLabel(i + 1, entry.label), postback: entry.postback }));
  return [
    ...(heading ? [say(heading)] : []),
    ...entries.map((entry): Reply => ({ kind: 'text', text: entry.text, postback: entry.postback })),
    { kind: 'text', text: options.closing ?? '', chips, chipsValidMs: options.validMs ?? CHOICE_VALID_MS },
  ];
}

/** What a song or an album is matched by: its title, and its artist's name in both alphabets. */
const matchable = (item: { title: string; artist: string; aka?: string | undefined }): { title: string; artist: string } => ({
  title: item.title,
  artist: item.aka ? `${item.artist} ${item.aka}` : item.artist,
});

/**
 * The songs (or albums) that have every one of the words, best first: the ones the words name, then the closest. A
 * song that misses a word is a different song ("higale na" is not "Hava Nagila"), so the next place gets to answer.
 */
function fitting<T extends { title: string; artist: string; aka?: string | undefined }>(items: T[], tokens: string[]): T[] {
  return rankSongs(
    items.map((item) => ({ ...matchable(item), item })).filter((entry) => fitsAll(entry, tokens)),
    tokens,
    items.length,
  ).map((entry) => entry.item);
}

/** True when the words name this song or album (its whole title, maybe with its artist's name). */
const named = (item: { title: string; artist: string; aka?: string | undefined }, tokens: string[]): boolean => namesSong(matchable(item), tokens);

/**
 * The artist the words name, if any: every word is in the artist's name (either alphabet, a typo forgiven) and they
 * cover at least half of it ("lipa" for Lipa Schmeltzer, not "shabbos" for The Early Shabbos Band). `full` when they
 * cover all of it ("lipa schmeltzer", "mizrach" for Mizrach).
 */
function namedArtist(artists: ArtistRef[], tokens: string[]): { artist: ArtistRef; full: boolean } | undefined {
  const words = tokens.filter((token) => token.length >= 2);
  if (words.length === 0 || words.length < tokens.length) return undefined;
  let partly: ArtistRef | undefined;
  for (const artist of artists) {
    for (const name of [artist.name, artist.aka]) {
      const parts = tokenize(name ?? '');
      if (parts.length === 0 || !words.every((word) => parts.some((part) => wordMatches(word, part)))) continue;
      const covered = parts.filter((part) => words.some((word) => wordMatches(word, part))).length;
      if (covered === parts.length) return { artist, full: true };
      if (covered * 2 >= parts.length) partly ??= artist;
    }
  }
  return partly ? { artist: partly, full: false } : undefined;
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

/** An album's title without what tells its editions apart: "X (Yinglish Version)" and "X - גרסה עברית" are both "X". */
const baseTitle = (title: string): string => artistKey(title.replace(/\s*[([][^)\]]*[)\]]\s*$/, '').replace(/\s+[-–—]\s+.*$/, '')) || artistKey(title);

/** The albums with each one's editions folded into one: the edition that is just the album's name, or else the first. */
function editions(albums: Album[]): Album[] {
  const kept = new Map<string, Album>();
  for (const album of albums) {
    const base = baseTitle(album.title);
    const had = kept.get(base);
    if (!had || (artistKey(album.title) === base && artistKey(had.title) !== base)) kept.set(base, album);
  }
  return albums.filter((album) => kept.get(baseTitle(album.title)) === album);
}

export function createBot(deps: BotDeps): Bot {
  const now = deps.now ?? (() => new Date());
  /**
   * What "more" shows next after one of Zemer's lists (an artist's page, their albums). Lists from music-table.com keep
   * their place in `browse` instead; whichever list was shown last is the one "more" goes on with.
   */
  let more: (() => Promise<Reply[]>) | undefined;
  const offerMore = (next: (() => Promise<Reply[]>) | undefined): void => {
    more = next;
    if (next) deps.browse?.setPage(undefined);
  };
  /** What "more" says once a list has been shown to its end: that it has, once. */
  const allShown =
    (what: string) =>
    async (): Promise<Reply[]> => {
      more = undefined;
      return [say(`That's all of ${what}.`)];
    };

  /** One page of a list: the heading, ten songs, and how to go on. Where numbers pick, they run on across pages. */
  async function showList(page: ListPage, heading: string, empty: string): Promise<Reply[]> {
    const browse = deps.browse!;
    more = undefined;
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
    const hasMore = got.length > LIST_SIZE;
    const next: ListPage = { ...page, shown: page.shown + songs.length, title: heading };
    browse.setPage(hasMore ? next : undefined);
    const today = now();
    const line = (track: ListedTrack): string => {
      const when = shortDate(track.releasedAt, today);
      const date = when ? ` · ${when}` : '';
      if (track.album) {
        const parts = splitTitle(track.album.title);
        const title = parts.title || track.album.title;
        return `💿 ${title}${page.kind === 'artist' || !parts.artist ? '' : ` — ${shortCredit(parts.artist)}`} · ${plural(track.album.songs, 'song')}${date}`;
      }
      return `${songLine(track, page.kind !== 'artist')}${date}`;
    };
    const shownSoFar = [...(page.shown > 0 ? await fetch(page.shown, 0) : []), ...songs];
    // Picking an album lists its songs; picking a song sends it.
    const pick = (track: ListedTrack): string => (track.album && track.post ? `post:${track.post}` : `play:${track.id}`);
    return listReplies(
      page.shown === 0 ? heading : `${heading} (continued)`,
      songs.map((track) => ({ line: line(track), postback: pick(track) })),
      `Tap 👍 on one to get it${hasMore ? ', or text "more" for the next ones' : ''}.`,
      shownSoFar.map((track, i) => ({ label: chipLabel(i + 1, track.album ? splitTitle(track.album.title).title || track.title : shownTitle(track.title)), postback: pick(track) })),
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
    const phrase = tokens.join(' ');
    if (MORE.has(phrase)) {
      if (more) return more();
      const page = deps.browse?.page();
      if (!page) return [say(`Text ${deps.browse ? '"trending", "new" or ' : ''}"search" and an artist first; then "more" shows the next ones.`)];
      return showList(page, page.title ?? 'More', "That's all of them.");
    }
    const browse = deps.browse;
    if (!browse) return undefined;
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

  /** An artist's songs on music-table.com, when the words are just an artist's name there. */
  function artistList(tokens: string[]): Promise<Reply[]> | undefined {
    const artist = deps.browse?.artist(tokens);
    if (!artist) return undefined;
    const releases = deps.browse!.artistReleases(artist.id);
    return showList({ kind: 'artist', artistId: artist.id, shown: 0 }, `🎤 ${artist.name} · ${plural(releases, 'release')} on music-table.com, newest first`, `I have no songs by ${artist.name}.`);
  }

  async function play(found: Track): Promise<Reply[]> {
    const [check, filled] = await Promise.all([deps.checkAudio(found.url), deps.finder?.fillIn?.(found).catch(() => undefined)]);
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

  /** An album as one line with its 👍, under a song that was sent, when the words name the album too. */
  const albumNote = (album: Album): Reply => ({ kind: 'text', text: albumLine(album), postback: `album:${album.id}` });

  /**
   * An artist's page on Zemer: their most played songs and their newest albums, a few of each, and "more" for the next
   * few. Undefined when the artist can't be opened (then the search's own results are shown instead).
   */
  async function artistView(artistId: string): Promise<Reply[] | undefined> {
    let page: ArtistPage | undefined;
    try {
      page = await deps.finder?.artist(artistId);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      return undefined;
    }
    if (!page || page.songs.length + page.albums.length === 0) return undefined;
    const { artist, songs, singles } = page;
    // One edition of each album here ("album" and the artist lists them all): the original, or else the newest.
    const albums = editions(page.albums);
    const sizes = [page.albums.length > 0 && plural(page.albums.length, 'album'), singles > 0 && plural(singles, 'single'), plural(songs.length, 'song')].filter(Boolean).join(' · ');
    const show = async (shownSongs: number, shownAlbums: number): Promise<Reply[]> => {
      const nextSongs = songs.slice(shownSongs, shownSongs + ARTIST_SONGS);
      const nextAlbums = albums.slice(shownAlbums, shownAlbums + ARTIST_ALBUMS);
      const songsSoFar = shownSongs + nextSongs.length;
      const albumsSoFar = shownAlbums + nextAlbums.length;
      const left = songsSoFar < songs.length || albumsSoFar < albums.length;
      offerMore(left ? () => show(songsSoFar, albumsSoFar) : allShown(artist.name));
      return pickList(
        await Promise.all(nextSongs.map((song) => song.keep())),
        nextAlbums,
        {
          heading: shownSongs + shownAlbums === 0 ? `🎤 ${artist.name}\n${sizes}` : `🎤 ${artist.name}, continued`,
          ...(left ? { closing: `Text "more" for more of ${artist.name}.` } : {}),
          validMs: LIST_VALID_MS,
        },
      );
    };
    return show(0, 0);
  }

  /** An artist's albums, newest first, a page at a time ("album lipa"). */
  async function artistAlbums(artistId: string): Promise<Reply[] | undefined> {
    let page: ArtistPage | undefined;
    try {
      page = await deps.finder?.artist(artistId);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      return undefined;
    }
    if (!page || page.albums.length === 0) return undefined;
    const { artist, albums } = page;
    const show = (shown: number): Reply[] => {
      const next = albums.slice(shown, shown + ALBUMS_PAGE);
      const soFar = shown + next.length;
      const left = soFar < albums.length;
      offerMore(left ? async () => show(soFar) : allShown(`${artist.name}'s albums`));
      return pickList([], next, {
        heading: shown === 0 ? `🎤 ${artist.name} · ${plural(albums.length, 'album')}, newest first` : `🎤 ${artist.name}'s albums, continued`,
        ...(left ? { closing: `Text "more" for more of ${artist.name}'s albums.` } : {}),
        validMs: LIST_VALID_MS,
      });
    };
    return show(0);
  }

  /**
   * What Zemer has for the words, or undefined when nothing it found fits them (or it couldn't be asked: then why is in
   * `failures`). The artist the words name gets their page; the one song they name is sent; otherwise the songs and
   * albums that fit are listed.
   */
  async function fromFinder(raw: string, tokens: string[], failures: Failure[]): Promise<Reply[] | undefined> {
    const finder = deps.finder;
    if (!finder) return undefined;
    let found: Findings;
    try {
      found = await finder.find(raw);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      failures.push({ name: finder.name, message: err.message });
      return undefined;
    }
    const artist = namedArtist(found.artists, tokens);
    const songs = fitting(found.songs, tokens);
    const albums = fitting(
      found.albums.filter((album) => !album.single),
      tokens,
    );
    const namedSongs = songs.filter((song) => named(song, tokens));
    // An artist's whole name ("lipa schmeltzer") is about the artist, even when a song has that name too.
    if (artist?.full) {
      const view = await artistView(artist.artist.id);
      if (view) return view;
    }
    // The one song the words name, or the only one that fits them (a word a letter off).
    const one = namedSongs.length === 1 ? namedSongs[0] : songs.length === 1 && albums.length === 0 && !artist ? songs[0] : undefined;
    if (one) {
      const song = one;
      // The album the words name too, if they do: its own album first.
      const note = [...albums.filter((album) => album.id === song.album?.id), ...albums].find((album) => named(album, tokens) || (album.id === song.album?.id && touchesTitle(album, tokens)));
      return [...(await play(await song.keep())), ...(note ? [albumNote(note)] : [])];
    }
    if (artist) {
      const view = await artistView(artist.artist.id);
      if (view) return view;
    }
    if (songs.length + albums.length === 0) return undefined;
    // The albums the words name come first; with none, the songs are what was asked for and the albums follow them.
    const namedAlbums = albums.filter((album) => named(album, tokens));
    if (namedAlbums.length > 0 && namedSongs.length === 0) return pickList([], albums.slice(0, MAX_CHOICES));
    return pickList(await Promise.all(songs.slice(0, MAX_CHOICES).map((song) => song.keep())), albums.slice(0, MAX_ALBUMS_LISTED));
  }

  /**
   * What the catalog and music-table.com have for the words: the one song they name (sent at once), an artist's songs,
   * or the songs that fit. Undefined when there are none (and why, if music-table.com couldn't be asked, in `failures`).
   */
  async function fromMusicTable(raw: string, tokens: string[], failures: Failure[]): Promise<Reply[] | undefined> {
    const local = deps.catalog.search(raw, MAX_CHOICES);
    // Naming exactly one song the catalog has is answered at once, without asking anyone else.
    const namedHere = local.filter((track) => namesSong(track, tokens));
    if (namedHere.length === 1) return play(namedHere[0]!);
    // Just an artist's name: their songs, newest first.
    const byArtist = artistList(tokens);
    if (byArtist) return byArtist;
    // Otherwise the catalog may hold only some of what fits (the songs synced or asked for before), so the site is
    // asked too and its results come first.
    let found = local;
    if (deps.source) {
      try {
        found = merge(await deps.source.lookup(raw, MAX_CHOICES), local, MAX_CHOICES);
      } catch (err) {
        if (!(err instanceof SourceError)) throw err;
        failures.push({ name: deps.source.name, message: err.message });
      }
    }
    if (found.length === 0) return undefined;
    const exact = found.filter((track) => namesSong(track, tokens));
    const one = found.length === 1 ? found[0] : exact.length === 1 ? exact[0] : undefined;
    if (one) return play(one);
    return pickList(found, []);
  }

  /** "search …": Zemer first, then the catalog and music-table.com, the first with something that fits answering. */
  async function search(raw: string): Promise<Reply[]> {
    const tokens = parseQuery(raw);
    if (tokens.every((token) => token.length < 2)) {
      return [say(`Text "search" and ${deps.browse ? 'a song or an artist, like "search lipa vnusni"' : 'a song name, like "search blue horizon night owls"'}.`)];
    }
    const failures: Failure[] = [];
    const steps = [() => fromFinder(raw, tokens, failures), () => fromMusicTable(raw, tokens, failures)];
    for (const step of deps.musicTableFirst ? steps.reverse() : steps) {
      const answer = await step();
      if (answer) return answer;
    }
    const asked = [deps.finder?.name, deps.source?.name].filter((name): name is string => name !== undefined);
    // Nothing found because nobody could be asked is not the same as nothing found.
    if (asked.length > 0 && failures.length === asked.length) return [say(couldNot(failures))];
    return [say(`No match for "${raw}"${asked.length > 0 ? ` on ${asked.join(' or ')}` : ''}. Try the artist and title, or fewer words.`)];
  }

  /** "zemer …" (or "youtube …"): the same as "search", but only Zemer is asked. */
  async function searchZemer(raw: string): Promise<Reply[]> {
    const finder = deps.finder;
    if (!finder) return [say('Zemer is turned off (YOUTUBE_MUSIC=off), so there is nothing to search there.')];
    // "youtube music …" is fine too.
    const query = raw.replace(/^music\b[\s:,-]*/i, '').trim();
    const tokens = parseQuery(query);
    if (tokens.every((token) => token.length < 2)) return [say('Text "zemer" and a song or an artist, like "zemer lipa vnusni".')];
    const failures: Failure[] = [];
    const answer = await fromFinder(query, tokens, failures);
    if (answer) return answer;
    if (failures.length > 0) return [say(couldNot(failures))];
    return [say(`No match for "${query}" on ${finder.name}${finder.hint ? ` (${finder.hint})` : ''}. Try the artist and title, or fewer words.`)];
  }

  /** "album …": the album the words name (sent at once), an artist's albums, or the albums that fit to choose from. */
  async function albumSearch(raw: string): Promise<Reply[]> {
    if (!deps.finder && !deps.albums) return [say('Albums come from Zemer, which is turned off (YOUTUBE_MUSIC=off).')];
    const tokens = parseQuery(raw);
    if (tokens.every((token) => token.length < 2)) return [say('Text "album" and an album or an artist, like "album a poshiter yid" or "album lipa".')];
    const where = deps.finder?.name ?? deps.albums!.name;
    const hint = deps.finder?.hint ?? deps.albums?.hint;
    let albums: Album[];
    let artist: { artist: ArtistRef; full: boolean } | undefined;
    try {
      if (deps.finder) {
        const found = await deps.finder.find(raw);
        albums = found.albums;
        artist = namedArtist(found.artists, tokens);
      } else {
        albums = await deps.albums!.search(raw, MAX_CHOICES);
      }
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      return [say(`I couldn't search albums on ${where}: ${err.message}.`)];
    }
    // Albums and EPs before singles: "album" is asked for a whole album.
    const fit = fitting(albums, tokens).sort((a, b) => Number(Boolean(a.single)) - Number(Boolean(b.single)));
    const namedAlbums = fit.filter((album) => named(album, tokens));
    // One album the words name outright (its title, with or without the artist) goes at once.
    if (namedAlbums.length === 1) return sendAlbum(namedAlbums[0]!.id);
    if (artist && (artist.full || namedAlbums.length === 0)) {
      const listed = await artistAlbums(artist.artist.id);
      if (listed) return listed;
    }
    if (fit.length === 0) return [say(`No album for "${raw}" on ${where}${hint ? ` (${hint})` : ''}. Try the artist and the album's name, or fewer words.`)];
    if (fit.length === 1) return sendAlbum(fit[0]!.id);
    return pickList([], fit.slice(0, MAX_CHOICES));
  }

  /** An album as one reply for the runner to zip: its cover first, and a word on any songs that had to stay out. */
  async function sendAlbum(id: string): Promise<Reply[]> {
    const albums = deps.albums;
    if (!albums) return [say('Albums come from Zemer, which is turned off (YOUTUBE_MUSIC=off).')];
    let opened: Awaited<ReturnType<AlbumSource['open']>>;
    try {
      opened = await albums.open(id);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      return [say(`I can't send that album: ${err.message}.`)];
    }
    const { album, songs, leftOut } = opened;
    const name = `${album.artist ? `${album.artist} — ` : ''}${album.title}${album.year ? ` (${album.year})` : ''}`;
    // Every song is checked the way a single song is (the list it must be on, its size), so nothing goes that couldn't alone.
    const checks = await inBatches(songs, ALBUM_CHECKS_AT_ONCE, (song) => deps.checkAudio(song.track.url));
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
          return check.ok ? [{ number: song.number, title: song.track.title, url: song.track.url, ...(check.bytes ? { bytes: check.bytes } : {}) }] : [];
        }),
      },
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

  const helpText = (): string => {
    const help = deps.browse ? BROWSE_HELP_TEXT : HELP_TEXT;
    const word = deps.assistant?.word;
    return word ? `${help}\n"${word}" and a message to ask ${deps.assistant!.name}; the answer comes back here.` : help;
  };

  return {
    async handle(msg) {
      if (msg.postback !== undefined) {
        const all = /^all:(.+)$/s.exec(msg.postback)?.[1];
        // "all" on a list of albums: one album is a whole zip, so they are not all sent at once.
        if (all !== undefined && all.split('|').every((item) => item.startsWith('album:'))) return [say('That list is albums; tap 👍 on the one you want and I\'ll send all of it as a zip.')];
        if (all !== undefined) return playAll(all.split('|'));
        const albumId = /^album:(.+)$/.exec(msg.postback)?.[1];
        if (albumId !== undefined) return sendAlbum(albumId);
        const album = /^post:(.+)$/.exec(msg.postback)?.[1];
        if (album !== undefined) {
          const tracks = deps.catalog.postTracks?.(album) ?? [];
          if (tracks.length === 0) return [say('That album is no longer in the catalog.')];
          if (tracks.length === 1) return play(tracks[0]!);
          const shown = tracks.slice(0, 30);
          // In album order, with the album's own numbers ("01 Intro").
          const heading = shown[0]!.artist ? `${shortCredit(shown[0]!.artist)} · ${plural(tracks.length, 'song')}` : plural(tracks.length, 'song');
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
      // A new request ends the list "more" was going on with; "more" itself goes on with it.
      if (!MORE.has(words.join(' '))) more = undefined;
      const first = FIRST_WORD.exec(raw);
      if (first && isSearch(first[1]!)) return search(raw.slice(first[0].length).trim());
      if (first && isZemerOnly(first[1]!)) return searchZemer(raw.slice(first[0].length).trim());
      if (first && isAlbum(first[1]!)) return albumSearch(raw.slice(first[0].length).trim());
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
