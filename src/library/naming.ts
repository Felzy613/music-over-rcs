import { posix } from 'node:path';
import type { DownloadedAudio } from '../audio-fetch.ts';
import { splitTitle } from '../sources/titles.ts';
import type { SongTags } from './id3.ts';

/** What the catalog knows about a song, for naming its file. */
export interface SongFacts {
  /** The credit and title as the catalog has them: "Ishay Ribo ft. Zusha", "Derech". */
  artist: string;
  title: string;
  url: string;
  /** The music-table.com post it comes from: its title ("Artist - Album"), how many songs it has, its category. */
  post?: { slug: string; title: string; songs: number; category: string } | undefined;
  /** When it came out (ISO), and its cover's address. */
  releasedAt?: string | undefined;
  cover?: string | undefined;
}

/** How a song's file is named and where it's sorted: Artist / Album / "01 Title". */
export interface SongName {
  /** The artist's folder: the main artist, without the guests ("Ishay Ribo"). */
  artist: string;
  /** Whether `artist` is a real name rather than a stand-in ("Unknown Artist", "Weddings & Events"). */
  credited: boolean;
  /** The album's folder; "Singles" for a song on its own. */
  album: string;
  /** Its number on the album; none for a single. */
  number?: number | undefined;
  /** How many digits the numbers on its album take (2, or 3 for an album of 100 songs or more). */
  digits: number;
  /** The song's own name, guests included for a single: "Derech (feat. Zusha)". */
  title: string;
  /** How many songs its album has; 1 for a single. */
  songs: number;
}

export const SINGLES = 'Singles';
const UNKNOWN_ARTIST = 'Unknown Artist';
const VARIOUS_ARTISTS = 'Various Artists';
const WEDDINGS = 'Weddings & Events';
/** The longest a file or folder name gets, in characters. */
const MAX_NAME = 120;

const GUESTS = /\s*\(\s*(?:ft|feat|featuring)\.?\s+([^)]*)\)?\s*$|\s+(?:ft|feat|featuring)\.?\s+(.*)$/i;
const HAS_GUESTS = /(?:^|[\s(])(?:ft|feat|featuring)\.?\s/i;
/** "Mar. 15 '26", "July 25 '26": the site's name for a wedding's recording. */
const DATED = /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\s*['’]\d{2}\b/i;
/** A track number in front of a title: "01 Title", "01. Title", "01 - Title", "01_Title", or just "01". */
const NUMBERED = /^(\d{1,3})(?:\s*[.)_]\s*|\s+-\s+|\s+|$)(.*)$/s;
const FULL_ALBUM = /\s*(?:[([]\s*(?:full\s+|free\s+)?album\s*[)\]]|\s-\s+full\s+album)\s*$/i;
/** Words that describe the upload rather than the song: "(Official Music Video)", " - 44.1kHz - 24Bit". */
const UPLOAD_NOTES = /\s*[([]\s*(?:official\s+)?(?:music\s+video|audio|video|lyric\s+video|lyrics)\s*[)\]]|\s*-?\s*\b\d{2}(?:\.\d)?\s*khz\b(?:\s*-?\s*\d{2}\s*-?\s*bit\b)?/gi;

/**
 * Makes text safe and tidy as one file or folder name, on a Mac disk and on drives formatted for Windows: no slashes,
 * colons or other reserved characters (a slash or colon between words becomes " - "), no dot in front (that would hide
 * it), at most 120 characters.
 */
export function cleanName(text: string, max = MAX_NAME): string {
  const cleaned = text
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+[/\\|:]\s+|\s*:\s+/g, ' - ')
    .replace(/[/\\|:]/g, '-')
    .replace(/"/g, "'")
    .replace(/[<>]/g, '')
    .replace(/[?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned.replace(/^[.\s]+/, ''))
    .slice(0, max)
    .join('')
    .replace(/[.\s]+$/, '');
}

/** "Ishay Ribo ft. Zusha" → "Ishay Ribo" and "Zusha". A duet ("A & B", "A x B") stays whole: it's the artist. */
export function splitGuests(credit: string): { main: string; guests: string | undefined } {
  const match = GUESTS.exec(credit);
  if (!match || match.index === 0) return { main: credit.trim(), guests: undefined };
  const guests = (match[1] ?? match[2] ?? '').trim();
  return { main: credit.slice(0, match.index).trim(), guests: guests || undefined };
}

/** "Artist - Title", forgiving a dash with a space on one side only ("Artist- Title"). */
function looseSplit(text: string): { artist: string; title: string } | undefined {
  const match = /^(.+?)(?:\s+[-–—]\s*|\s*[-–—]\s+)(.+)$/.exec(text.trim());
  return match ? { artist: match[1]!.trim(), title: match[2]!.trim() } : undefined;
}

/** The album's name from its post's title: what comes after "Artist - ", without "(Full Album)". */
function albumName(postTitle: string): string {
  const split = splitTitle(postTitle);
  const name = split.artist ? split.title : DATED.test(postTitle) ? postTitle : (looseSplit(postTitle)?.title ?? postTitle);
  return name.replace(FULL_ALBUM, '').trim() || postTitle.trim();
}

/** The song's place among its post's files, counting from 1, from its catalog address ("…#3" is the 4th). */
function position(url: string): number | undefined {
  const match = /#(\d+)$/.exec(url);
  return match ? Number(match[1]) + 1 : undefined;
}

/**
 * How a song is named and sorted, like a music library: by the main artist (guests go in the song's name), then the
 * album, then the song, numbered as on the album. A song on its own goes in the artist's "Singles" folder.
 */
export function nameSong(facts: SongFacts): SongName {
  const post = facts.post;
  const onAlbum = !!post && post.songs > 1;
  let credit = facts.artist.trim();
  let title = facts.title.trim();
  let album = SINGLES;

  if (onAlbum) {
    const fromPost = credit ? undefined : looseSplit(post.title);
    if (fromPost && !DATED.test(post.title)) credit = fromPost.artist;
    album = post.title ? albumName(post.title) : post.slug.replace(/-+/g, ' ');
  } else if (!credit) {
    // No artist known: the title may still say it ("Artist- Title").
    const parts = looseSplit(title);
    if (parts && !DATED.test(title)) ({ artist: credit, title } = parts);
  }

  const { main, guests } = splitGuests(credit);
  // "First_Dance_2" is "First Dance 2"; the upload's notes aren't part of the name.
  title = title.replace(/_+/g, ' ').replace(UPLOAD_NOTES, '').trim();
  let number: number | undefined;
  if (onAlbum) {
    const numbered = NUMBERED.exec(title);
    if (numbered) {
      number = Number(numbered[1]);
      title = numbered[2]!.trim();
    } else {
      number = position(facts.url);
    }
    // A file named only by its number takes the album's name.
    if (!title) title = album;
  } else if (guests && !HAS_GUESTS.test(title) && Array.from(`${title} (feat. ${guests})`).length <= MAX_NAME) {
    title = `${title} (feat. ${guests})`;
  }

  const standIn = !main ? (post && (DATED.test(post.title) || /wedding/i.test(post.category)) ? WEDDINGS : onAlbum ? VARIOUS_ARTISTS : UNKNOWN_ARTIST) : '';
  return {
    artist: cleanName(main || standIn) || UNKNOWN_ARTIST,
    credited: !!main,
    album: cleanName(album) || SINGLES,
    number,
    digits: post && post.songs >= 100 ? 3 : 2,
    songs: onAlbum ? post.songs : 1,
    title: cleanName(title) || cleanName(album) || 'Untitled',
  };
}

/**
 * The tags inside the file, matching its folders, the way music apps expect them: the main artist as artist and album
 * artist, the album with the song's number on it ("3/12"), and a single as its own album, "Derech (feat. Zusha) - Single".
 */
export function songTags(name: SongName, facts?: Pick<SongFacts, 'releasedAt' | 'cover'>): SongTags {
  const year = /^(\d{4})-/.exec(facts?.releasedAt ?? '')?.[1];
  return {
    title: name.title,
    artist: name.artist,
    albumArtist: name.artist,
    album: name.number !== undefined ? name.album : `${name.title} - Single`,
    track: name.number !== undefined ? `${name.number}/${Math.max(name.songs, name.number)}` : '1/1',
    ...(year ? { year } : {}),
    ...(facts?.cover ? { cover: facts.cover } : {}),
  };
}

/** The file's own name: "01 Title.mp3" on an album, "Title.mp3" for a single. */
export function songFileStem(name: SongName): string {
  const stem = name.number !== undefined ? `${String(name.number).padStart(name.digits, '0')} ${name.title}` : name.title;
  return cleanName(stem);
}

/** Where the song goes in a music folder: "Ishay Ribo/Singles/Derech (feat. Zusha).mp3", "Yumi Gelb/Elul Collection (Live)/01 …". */
export function songPath(name: SongName, extension: string): string {
  return posix.join(name.artist, name.album, `${songFileStem(name)}${dotted(extension)}`);
}

/**
 * The name of the file that's sent: "Ishay Ribo - Derech (feat. Zusha).mp3", "Yumi Gelb - 01 Elul Live Kumzitz (…).mp3".
 * With no artist, an album's song is led by the album instead ("May 31 '26 - 04 Chuppa 1.mp3").
 */
export function sentFileName(name: SongName, extension: string): string {
  const lead = name.credited ? name.artist : name.number !== undefined ? name.album : '';
  const stem = songFileStem(name);
  const full = lead && lead !== stem ? `${lead} - ${stem}` : stem;
  return `${cleanName(full, 200)}${dotted(extension)}`;
}

const dotted = (extension: string): string => {
  const bare = extension.replace(/^\.+/, '').toLowerCase();
  return bare ? `.${bare}` : '';
};

const EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/3gpp': '3gp',
};

/** A song file's extension, with its dot: from its name, or else from its type. */
export function extensionOf(audio: { fileName: string; mimeType: string }): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(audio.fileName)?.[1];
  return `.${(fromName ?? EXTENSIONS[audio.mimeType] ?? 'audio').toLowerCase()}`;
}

type AudioName = { fileName: string; mimeType: string };

/**
 * Names songs from what the catalog knows about them: where each goes in a music folder (`placeOf`), what the file
 * that's sent is called (`fileNameOf`), and the tags inside it (`tagsOf`). A song the catalog doesn't know is named from its file ("Artist — Title.mp3").
 */
export function catalogNaming(catalog: { songFacts(url: string): SongFacts | undefined }): {
  placeOf(url: string, audio: AudioName): string;
  fileNameOf(url: string, audio: AudioName): string;
  tagsOf(url: string, audio: AudioName): SongTags;
} {
  const factsOf = (url: string, audio: AudioName): SongFacts => {
    const facts = catalog.songFacts(url);
    if (facts) return facts;
    const { artist, title } = splitTitle(audio.fileName.replace(/\.[a-z0-9]{2,5}$/i, ''));
    return { artist, title, url };
  };
  return {
    placeOf: (url, audio) => songPath(nameSong(factsOf(url, audio)), extensionOf(audio)),
    fileNameOf: (url, audio) => sentFileName(nameSong(factsOf(url, audio)), extensionOf(audio)),
    tagsOf: (url, audio) => {
      const facts = factsOf(url, audio);
      return songTags(nameSong(facts), facts);
    },
  };
}

/** A downloader whose songs are sent under their proper names ("Artist - Title.mp3"), downloaded or kept. */
export function namedFetch(
  fetchAudio: (url: string, title?: string) => Promise<DownloadedAudio>,
  fileNameOf: (url: string, audio: AudioName) => string,
): (url: string, title?: string) => Promise<DownloadedAudio> {
  return async (url, title) => {
    const audio = await fetchAudio(url, title);
    return { ...audio, fileName: fileNameOf(url, audio) };
  };
}
