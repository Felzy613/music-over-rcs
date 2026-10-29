import { describe, shortCredit, songLine } from '../bot.ts';
import { splitTitle } from '../sources/titles.ts';
import type { NewRelease, SitePost } from '../catalog.ts';
import type { Chip, Reply, Track } from '../types.ts';

/** A new post for the daily message, with its first song when it has one (posts without MP3s are videos or news). */
export interface DigestItem {
  post: SitePost;
  song?: Track | undefined;
}

export interface DigestOptions {
  date: Date;
  /** How many covers go in the picture at the top (the rest are listed only). */
  maxPictures?: number;
  /** How long the songs stay pickable. */
  chipsValidMs?: number;
  /** A line under the heading for the time of year (Chanukah, Sefirah…). */
  seasonHint?: string | undefined;
  /** In Sefirah and the Three Weeks: which songs are vocal, to put them first and say so. */
  vocal?: ((item: DigestItem) => boolean) | undefined;
  /** Zemer's new releases, which go in among music-table.com's, the newest first. */
  releases?: NewRelease[] | undefined;
}

/** A line of the message from either place: what it says, what a 👍 on it does, and how it is pictured and numbered. */
interface Entry {
  /** When it came out. */
  at: number;
  line: string;
  postback: string;
  cover?: string | undefined;
  /** What the picture is called in the collage. */
  label: string;
  /** What its number is called where numbers pick. */
  title: string;
  vocal: boolean;
}

const DAY_MS = 24 * 60 * 60_000;
const MAX_CHIP_LABEL = 25;

/** "Singles" reads better as "single" after a song's name. */
const CATEGORY_LABEL: Record<string, string> = { singles: 'single', albums: 'album', videos: 'music video' };
export const categoryLabel = (category: string): string => CATEGORY_LABEL[category.trim().toLowerCase()] ?? category.trim();

function chip(n: number, title: string): Chip['label'] {
  const chars = Array.from(`${n}. ${title}`);
  return chars.length <= MAX_CHIP_LABEL ? chars.join('') : `${chars.slice(0, MAX_CHIP_LABEL - 1).join('')}…`;
}

/**
 * The daily new-music message: a heading, one picture of the new songs' covers, one line per song, then the posts that
 * are only videos, and a closing line. A 👍 on a song's line (or, where a 👍 can't reach the bot, its number) sends
 * that song; the message itself sends none. Zemer's new releases (`options.releases`) are among the songs: a single
 * is a song's line, an album its own. Returns nothing when there is nothing new.
 */
export function buildDigest(items: DigestItem[], options: DigestOptions): Reply[] {
  const vocal = options.vocal;
  // Vocal songs first when that's what the season calls for; otherwise the order they came in.
  const ordered = vocal ? [...items.filter((item) => vocal(item)), ...items.filter((item) => !vocal(item))] : items;
  const songs = ordered.filter((item): item is DigestItem & { song: Track } => item.song !== undefined);
  const videos = ordered.filter((item) => item.song === undefined);
  const releases = options.releases ?? [];
  if (songs.length === 0 && videos.length === 0 && releases.length === 0) return [];

  const day = options.date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const total = songs.length + releases.length;
  const count = total === 1 ? '1 new song' : `${total} new songs`;
  const places = [releases.length > 0 ? 'Zemer' : '', songs.length > 0 ? 'music-table.com' : ''].filter(Boolean).join(' and ');
  const heading = [`New music · ${day}`, ...(total > 0 ? [`${count} on ${places}`] : []), ...(options.seasonHint ? [options.seasonHint] : [])];
  const replies: Reply[] = [{ kind: 'text', text: heading.join('\n') }];

  const maxPictures = options.maxPictures ?? 9;
  const isAlbum = (item: DigestItem): boolean => item.post.audioFiles > 1;
  // The same lines as a search's list: "Title — Artist · single", "💿 Album — Artist · 12 songs".
  const line = (item: DigestItem & { song: Track }): string => {
    if (isAlbum(item)) {
      const parts = splitTitle(item.post.title);
      const name = parts.artist ? `${parts.title} — ${shortCredit(parts.artist)}` : item.post.title;
      return `💿 ${name} · ${item.post.audioFiles} songs`;
    }
    const kind = vocal?.(item) ? ' · vocal' : item.post.category ? ` · ${categoryLabel(item.post.category)}` : '';
    return `${songLine(item.song, true)}${kind}`;
  };
  // Picking an album lists its songs; picking a song sends it.
  const pick = (item: DigestItem & { song: Track }): string => (isAlbum(item) ? `post:${item.post.slug}` : `play:${item.song.id}`);
  const fromSite = (item: DigestItem & { song: Track }): Entry => ({
    at: Date.parse(item.post.publishedAt) || 0,
    line: line(item),
    postback: pick(item),
    cover: item.song.cover ?? item.post.cover,
    label: describe(item.song),
    title: isAlbum(item) ? splitTitle(item.post.title).title : item.song.title,
    vocal: vocal?.(item) ?? false,
  });
  // A single of Zemer's opens into its one song and sends it; an album opens into its songs.
  const fromZemer = (release: NewRelease): Entry => {
    const single = release.songs === 1;
    return {
      at: Date.parse(release.releasedAt) || 0,
      line: single
        ? `${songLine(release, true)} · single`
        : `💿 ${release.title}${release.artist ? ` — ${shortCredit(release.artist)}` : ''}${release.songs > 0 ? ` · ${release.songs} songs` : ''}`,
      postback: `${single ? 'single' : 'album'}:${release.id}`,
      cover: release.cover,
      label: `${release.artist} — ${release.title}`,
      title: release.title,
      vocal: false,
    };
  };
  const entries = [...songs.map(fromSite), ...releases.map(fromZemer)];
  // With Zemer's among them the newest come first (vocal songs still lead in Sefirah); alone, music-table.com's keep the order they came in.
  if (releases.length > 0) entries.sort((a, b) => Number(b.vocal) - Number(a.vocal) || b.at - a.at);
  // One picture of all the covers, then one line per song: a 👍 on a line gets that song.
  const collage = entries
    .slice(0, maxPictures)
    .filter((entry) => entry.cover)
    .map((entry) => ({ url: entry.cover!, label: entry.label, postback: entry.postback }));
  if (collage.length > 0) replies.push({ kind: 'collage', images: collage });
  entries.forEach((entry) => replies.push({ kind: 'text', text: entry.line, postback: entry.postback }));

  const closing: string[] = [];
  if (videos.length > 0) closing.push(`Also new, video only:\n${videos.map((item) => `• ${item.post.title}`).join('\n')}`);
  if (entries.length > 0) closing.push('Tap 👍 on a song to get it, or "search" for anything else.');
  replies.push({
    kind: 'text',
    text: closing.join('\n\n'),
    ...(entries.length > 0
      ? {
          chips: entries.map((entry, i) => ({ label: chip(i + 1, entry.title), postback: entry.postback })),
          chipsValidMs: options.chipsValidMs ?? DAY_MS,
        }
      : {}),
  });
  return replies;
}
