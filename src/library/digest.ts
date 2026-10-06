import { describe } from '../bot.ts';
import { splitTitle } from '../sources/titles.ts';
import type { SitePost } from '../catalog.ts';
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
  /** How long the numbers stay pickable. */
  chipsValidMs?: number;
  /** A line under the heading for the time of year (Chanukah, Sefirah…). */
  seasonHint?: string | undefined;
  /** In Sefirah and the Three Weeks: which songs are vocal, to put them first and say so. */
  vocal?: ((item: DigestItem) => boolean) | undefined;
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
 * The daily new-music message: a heading, one picture of the new songs' covers (numbered), one line per song, then
 * the posts that are only videos, and a closing line. Replying with a number, or a 👍 on a song's line, sends that
 * song; the message itself sends none. Returns nothing when there is nothing new.
 */
export function buildDigest(items: DigestItem[], options: DigestOptions): Reply[] {
  const vocal = options.vocal;
  // Vocal songs first when that's what the season calls for; otherwise the order they came in.
  const ordered = vocal ? [...items.filter((item) => vocal(item)), ...items.filter((item) => !vocal(item))] : items;
  const songs = ordered.filter((item): item is DigestItem & { song: Track } => item.song !== undefined);
  const videos = ordered.filter((item) => item.song === undefined);
  if (songs.length === 0 && videos.length === 0) return [];

  const day = options.date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const count = songs.length === 1 ? '1 new song' : `${songs.length} new songs`;
  const heading = [`New music · ${day}`, ...(songs.length > 0 ? [`${count} on music-table.com`] : []), ...(options.seasonHint ? [options.seasonHint] : [])];
  const replies: Reply[] = [{ kind: 'text', text: heading.join('\n') }];

  const maxPictures = options.maxPictures ?? 9;
  const isAlbum = (item: DigestItem): boolean => item.post.audioFiles > 1;
  const line = (n: number, item: DigestItem & { song: Track }): string => {
    if (isAlbum(item)) {
      const parts = splitTitle(item.post.title);
      const name = parts.artist ? `${parts.artist} — ${parts.title}` : item.post.title;
      return `${n}. ${name} · album, ${item.post.audioFiles} songs`;
    }
    const kind = vocal?.(item) ? ' · vocal' : item.post.category ? ` · ${categoryLabel(item.post.category)}` : '';
    return `${n}. ${describe(item.song)}${kind}`;
  };
  // Picking an album lists its songs; picking a song sends it.
  const pick = (item: DigestItem & { song: Track }): string => (isAlbum(item) ? `post:${item.post.slug}` : `play:${item.song.id}`);
  // One picture of all the covers, numbered, then one line per song: a 👍 on a line gets that song.
  const collage = songs
    .slice(0, maxPictures)
    .map((item, i) => ({ url: (item.song.cover ?? item.post.cover)!, label: describe(item.song), number: i + 1, has: Boolean(item.song.cover ?? item.post.cover) }))
    .filter((tile) => tile.has)
    .map(({ url, label, number }) => ({ url, label, number }));
  if (collage.length > 0) replies.push({ kind: 'collage', images: collage });
  songs.forEach((item, i) => replies.push({ kind: 'text', text: line(i + 1, item), postback: pick(item) }));

  const closing: string[] = [];
  if (videos.length > 0) closing.push(`Also new, video only:\n${videos.map((item) => `• ${item.post.title}`).join('\n')}`);
  if (songs.length > 0) closing.push('Reply with a number or 👍 a song to get it, or text me any name.');
  replies.push({
    kind: 'text',
    text: closing.join('\n\n'),
    ...(songs.length > 0
      ? {
          chips: songs.map((item, i) => ({ label: chip(i + 1, isAlbum(item) ? splitTitle(item.post.title).title : item.song.title), postback: pick(item) })),
          chipsValidMs: options.chipsValidMs ?? DAY_MS,
        }
      : {}),
  });
  return replies;
}
