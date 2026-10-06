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
  /** How many songs get their picture. More than this are listed in text, so the message stays short. */
  maxPictures?: number;
  /** How long the numbers stay pickable. */
  chipsValidMs?: number;
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
 * The daily new-music message: a heading, then each new song with its picture and number, then the posts that are
 * only videos, and a closing line. Replying with a number sends that song. No songs are sent by the message itself.
 * Returns nothing when there is nothing new.
 */
export function buildDigest(items: DigestItem[], options: DigestOptions): Reply[] {
  const songs = items.filter((item): item is DigestItem & { song: Track } => item.song !== undefined);
  const videos = items.filter((item) => item.song === undefined);
  if (songs.length === 0 && videos.length === 0) return [];

  const day = options.date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const count = songs.length === 1 ? '1 new song' : `${songs.length} new songs`;
  const replies: Reply[] = [{ kind: 'text', text: `New music · ${day}${songs.length > 0 ? `\n${count} on music-table.com` : ''}` }];

  const maxPictures = options.maxPictures ?? 6;
  const isAlbum = (item: DigestItem): boolean => item.post.audioFiles > 1;
  const line = (n: number, item: DigestItem & { song: Track }): string => {
    if (isAlbum(item)) {
      const parts = splitTitle(item.post.title);
      const name = parts.artist ? `${parts.artist} — ${parts.title}` : item.post.title;
      return `${n}. ${name} · album, ${item.post.audioFiles} songs`;
    }
    const kind = item.post.category ? ` · ${categoryLabel(item.post.category)}` : '';
    return `${n}. ${describe(item.song)}${kind}`;
  };
  // Picking an album lists its songs; picking a song sends it.
  const pick = (item: DigestItem & { song: Track }): string => (isAlbum(item) ? `post:${item.post.slug}` : `play:${item.song.id}`);
  const rest: string[] = [];
  songs.forEach((item, i) => {
    if (i < maxPictures) {
      // A 👍 on the picture or the line gets the song.
      const postback = pick(item);
      if (item.song.cover ?? item.post.cover) replies.push({ kind: 'image', url: (item.song.cover ?? item.post.cover)!, postback });
      replies.push({ kind: 'text', text: line(i + 1, item), postback });
    } else {
      rest.push(line(i + 1, item));
    }
  });

  const closing: string[] = [];
  if (rest.length > 0) closing.push(rest.join('\n'));
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
