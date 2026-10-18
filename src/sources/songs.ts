import { SourceError, type AlbumSource, type Finder, type LookupOptions, type TrackSource } from '../bot.ts';
import type { NewTrack } from '../catalog.ts';
import type { Track } from '../types.ts';
import { createMusicTableSource, type MusicTable } from './music-table.ts';
import { createYouTubeAlbumSource, createYouTubeMusicSource, type YouTubeMusic } from './youtube-music.ts';
import { createZemerFinder, type ZemerSearch } from './zemer.ts';
import type { ZemerWhitelist } from './zemer-whitelist.ts';

/**
 * The places a song can be looked up, by the names SONG_SOURCES uses: "youtube-music" is Zemer's catalog (songs whose
 * audio comes from YouTube Music; "zemer" means the same), "music-table" is the catalog and music-table.com.
 */
export const SONG_SOURCES = ['youtube-music', 'music-table'] as const;
export type SongSourceName = (typeof SONG_SOURCES)[number];

/** Which sources a search asks, in order: SONG_SOURCES="music-table,youtube-music", or both with Zemer first. */
export function songSourceOrder(env: NodeJS.ProcessEnv = process.env): SongSourceName[] {
  const raw = env.SONG_SOURCES?.trim();
  if (!raw) return [...SONG_SOURCES];
  const names = raw
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((name) => name.toLowerCase())
    .map((name) => (name === 'zemer' ? 'youtube-music' : name));
  const unknown = names.filter((name) => !(SONG_SOURCES as readonly string[]).includes(name));
  if (unknown.length > 0) throw new Error(`SONG_SOURCES names ${unknown.join(', ')}, which I don't know; use ${SONG_SOURCES.join(' and ')}.`);
  return [...new Set(names)] as SongSourceName[];
}

/**
 * One source made of several: they are asked in order and the first to find anything answers, so the next is only
 * asked when the one before found nothing or couldn't be reached. Undefined when there are none.
 */
export function combineSources(sources: TrackSource[]): TrackSource | undefined {
  if (sources.length === 0) return undefined;
  if (sources.length === 1) return sources[0];
  return {
    name: sources.map((source) => source.name).join(' and '),
    async lookup(query, limit, options?: LookupOptions) {
      const failures: string[] = [];
      for (const source of sources) {
        try {
          const found = await source.lookup(query, limit, options);
          if (found.length > 0) return found;
        } catch (err) {
          if (!(err instanceof SourceError)) throw err;
          failures.push(`${source.name}: ${err.message}`);
        }
      }
      // Nothing found anywhere is an empty answer, but nothing found because nobody could be asked is a problem.
      if (failures.length === sources.length) throw new SourceError(failures.join('; '));
      return [];
    },
  };
}

export interface SongSourceParts {
  catalog: { add(track: NewTrack): Track };
  musicTable?: MusicTable | undefined;
  /** Where the audio of Zemer's songs comes from; without it (YOUTUBE_MUSIC=off) there is no Zemer either. */
  youTube?: YouTubeMusic | undefined;
  /** Zemer's artist list. Needed whenever `youTube` is: nothing from Zemer or YouTube Music goes unchecked. */
  whitelist?: ZemerWhitelist | undefined;
  /** Zemer's catalog; without it (ZEMER_SEARCH=off) searches use YouTube Music's own search, held to the same list. */
  zemer?: ZemerSearch | undefined;
  order?: SongSourceName[];
  /** Hears what each lookup decided, in plain words (the simulators show these). */
  onNote?: (note: string) => void;
}

/**
 * The sources the bot is given, put together the same way by every entry point: Zemer first (`finder`, with YouTube
 * Music's own search behind it for when Zemer can't be reached), the catalog and music-table.com after it (`source`),
 * and albums opened from Zemer (or YouTube Music). SONG_SOURCES can turn either off, or put music-table.com first.
 */
export function songSources(parts: SongSourceParts): { finder?: Finder; albums?: AlbumSource; source?: TrackSource; musicTableFirst?: boolean } {
  const order = parts.order ?? songSourceOrder();
  const { catalog, youTube, whitelist, onNote } = parts;
  const notes = onNote ? { onNote } : {};
  const zemer =
    order.includes('youtube-music') && youTube && whitelist
      ? createZemerFinder({
          zemer: parts.zemer,
          youTube,
          catalog,
          whitelist,
          fallback: {
            songs: createYouTubeMusicSource({ youTube, catalog, whitelist, ...notes }),
            albums: createYouTubeAlbumSource({ youTube, catalog, whitelist, ...notes }),
          },
          ...notes,
        })
      : undefined;
  const source = order.includes('music-table') && parts.musicTable ? createMusicTableSource({ musicTable: parts.musicTable, catalog, ...notes }) : undefined;
  return {
    ...(zemer ? { finder: zemer, albums: zemer.albums } : {}),
    ...(source ? { source } : {}),
    ...(zemer && source && order.indexOf('music-table') < order.indexOf('youtube-music') ? { musicTableFirst: true } : {}),
  };
}
