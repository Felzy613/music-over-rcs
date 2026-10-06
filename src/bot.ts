import type { AudioCheck } from './audio-check.ts';
import type { ListedTrack } from './catalog.ts';
import type { Browse, ListPage } from './library/browse.ts';
import { parseQuery, tokenize } from './query.ts';
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
  /** Lists to browse: "trending", "new", an artist's songs, and "more". */
  browse?: Browse;
  now?: () => Date;
}

export interface Bot {
  handle(msg: Incoming): Promise<Reply[]>;
}

const MAX_CHOICES = 5;
const MAX_QUERY_CHARS = 200;
const MAX_CHIP_LABEL = 25;
const GREETINGS = new Set(['help', 'hi', 'hello', 'hey', 'start', 'menu']);

export const HELP_TEXT =
  "Text me a song name (artist and title work best) and I'll send you the audio file.\nExample: blue horizon night owls";

/** The help when the lists are there too. */
export const BROWSE_HELP_TEXT = [
  "Text me a song or an artist and I'll send you the music.",
  'Also: "trending" or "new" for lists, and "more" for the next ones.',
  'Reply with a number to pick one, or 👍 a song in the daily message.',
].join('\n');

const TRENDING = new Set(['trending', 'top', 'top songs', 'top 10', 'popular', 'hot', 'whats hot', 'what s hot', 'trending songs', 'charts']);
const NEWEST = new Set(['new', 'newest', 'latest', 'new music', 'new songs', 'new releases', 'whats new', 'what s new', 'latest music']);
const MORE = new Set(['more', 'next', 'show more', 'more please', 'next page']);
const LIST_SIZE = 10;
/** A list of songs stays pickable by number for a couple of hours. */
const LIST_VALID_MS = 2 * 60 * 60_000;

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

/** True when the query is exactly the title, "artist title" or "title artist". */
function isExact(track: Track, tokens: string[]): boolean {
  const query = tokens.join(' ');
  const title = tokenize(track.title).join(' ');
  const artist = tokenize(track.artist).join(' ');
  return query === title || query === `${artist} ${title}`.trim() || query === `${title} ${artist}`.trim();
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

  /** One page of a list: the heading, ten numbered songs, and how to go on. Numbers run on across pages. */
  function showList(page: ListPage, heading: string, empty: string): Reply[] {
    const browse = deps.browse!;
    const fetch = (limit: number, offset: number): ListedTrack[] =>
      page.kind === 'trending'
        ? browse.trending(limit, offset)
        : page.kind === 'new'
          ? browse.newest(limit, offset)
          : browse.artistSongs(page.artistId ?? -1, limit, offset);
    const got = fetch(LIST_SIZE + 1, page.shown);
    if (got.length === 0) {
      browse.setPage(undefined);
      return [say(page.shown === 0 ? empty : "That's all of them.")];
    }
    const songs = got.slice(0, LIST_SIZE);
    const more = got.length > LIST_SIZE;
    const next: ListPage = { ...page, shown: page.shown + songs.length, title: heading };
    browse.setPage(more ? next : undefined);
    const today = now();
    const line = (track: ListedTrack, n: number): string => {
      const when = shortDate(track.releasedAt, today);
      let name: string;
      if (track.album) {
        const parts = splitTitle(track.album.title);
        const title = parts.title || track.album.title;
        name = `${page.kind === 'artist' || !parts.artist ? title : `${parts.artist} — ${title}`} · album, ${track.album.songs} songs`;
      } else {
        name = page.kind === 'artist' ? track.title : describe(track);
      }
      return `${n}. ${name}${when ? ` · ${when}` : ''}`;
    };
    const shownSoFar = [...fetch(page.shown, 0), ...songs];
    // Picking an album lists its songs; picking a song sends it.
    const pick = (track: ListedTrack): string => (track.album && track.post ? `post:${track.post}` : `play:${track.id}`);
    return [
      {
        kind: 'text',
        text: [
          page.shown === 0 ? heading : `${heading} (continued)`,
          ...songs.map((track, i) => line(track, page.shown + i + 1)),
          '',
          `Reply with a number to get it${more ? ', or "more" for the next ones' : ''}.`,
        ].join('\n'),
        chips: shownSoFar.map((track, i) => ({ label: chipLabel(i + 1, track.album ? splitTitle(track.album.title).title || track.title : track.title), postback: pick(track) })),
        chipsValidMs: LIST_VALID_MS,
      },
    ];
  }

  /** "trending", "new", "more" or an artist's name, when the lists are there. */
  function browseFor(tokens: string[]): Reply[] | undefined {
    const browse = deps.browse;
    if (!browse) return undefined;
    const phrase = tokens.join(' ');
    if (TRENDING.has(phrase)) return showList({ kind: 'trending', shown: 0 }, '🔥 Trending on music-table.com', 'Nothing is trending yet: the catalog is still being filled. Try again in a few minutes.');
    if (NEWEST.has(phrase)) return showList({ kind: 'new', shown: 0 }, '🆕 New on music-table.com', 'No new songs yet: the catalog is still being filled. Try again in a few minutes.');
    if (MORE.has(phrase)) {
      const page = browse.page();
      if (!page) return [say('Text me "trending", "new" or an artist first; then "more" shows the next ones.')];
      return showList(page, page.title ?? 'More', "That's all of them.");
    }
    return undefined;
  }

  /** An artist's songs, when the words are just an artist's name. */
  function artistList(tokens: string[]): Reply[] | undefined {
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
    // The picture first, then the name under it, then the song: how a release looks in the chat.
    return [
      ...(track.cover ? [{ kind: 'image' as const, url: track.cover }] : []),
      say(`🎵 ${describe(track)}`),
      { kind: 'audio', url: track.url, title: describe(track) },
    ];
  }

  return {
    async handle(msg) {
      if (msg.postback !== undefined) {
        const album = /^post:(.+)$/.exec(msg.postback)?.[1];
        if (album !== undefined) {
          const tracks = deps.catalog.postTracks?.(album) ?? [];
          if (tracks.length === 0) return [say('That album is no longer in the catalog.')];
          if (tracks.length === 1) return play(tracks[0]!);
          const shown = tracks.slice(0, 30);
          const list = shown.map((track, i) => `${i + 1}. ${track.title}`).join('\n');
          const heading = shown[0]!.artist ? `${shown[0]!.artist} · ${tracks.length} songs` : `${tracks.length} songs`;
          const chips = shown.map((track, i) => ({ label: chipLabel(i + 1, track.title), postback: `play:${track.id}` }));
          return [{ kind: 'text', text: `${heading}\n${list}`, chips, chipsValidMs: LIST_VALID_MS }];
        }
        const id = /^play:(\d+)$/.exec(msg.postback)?.[1];
        if (id === undefined) return [say(HELP_TEXT)];
        const track = deps.catalog.get(Number(id));
        return track ? play(track) : [say('That track is no longer in the catalog.')];
      }

      const raw = (msg.text ?? '').trim().slice(0, MAX_QUERY_CHARS);
      const tokens = parseQuery(raw);
      // Nothing to search for: no words, a greeting, or only single characters (a stray "a", or a "2" with no list to pick from).
      if (tokens.every((token) => token.length < 2) || (tokens.length === 1 && GREETINGS.has(tokens[0]!))) {
        return [say(deps.browse ? BROWSE_HELP_TEXT : HELP_TEXT)];
      }
      const listed = browseFor(tokens);
      if (listed) return listed;

      const local = deps.catalog.search(raw, MAX_CHOICES);
      // Naming exactly one song the catalog has is answered at once, without asking anyone else.
      const exactLocal = local.filter((track) => isExact(track, tokens));
      if (exactLocal.length === 1) return play(exactLocal[0]!);

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

      const exact = found.filter((track) => isExact(track, tokens));
      if (exact.length === 1) return play(exact[0]!);

      const list = found.map((track, i) => `${i + 1}. ${describe(track)}`).join('\n');
      const chips = found.map((track, i) => ({ label: chipLabel(i + 1, track.title), postback: `play:${track.id}` }));
      return [say(`Which one?\n${list}`, chips)];
    },
  };
}
