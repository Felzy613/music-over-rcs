import { SourceError, type TrackSource } from '../bot.ts';

/** The places a song can be looked up, by the names SONG_SOURCES uses. */
export const SONG_SOURCES = ['youtube-music', 'music-table'] as const;
export type SongSourceName = (typeof SONG_SOURCES)[number];

/** Which sources a search asks, in order: SONG_SOURCES="music-table,youtube-music", or both with YouTube Music first. */
export function songSourceOrder(env: NodeJS.ProcessEnv = process.env): SongSourceName[] {
  const raw = env.SONG_SOURCES?.trim();
  if (!raw) return [...SONG_SOURCES];
  const names = raw.split(/[\s,]+/).filter(Boolean).map((name) => name.toLowerCase());
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
    async lookup(query, limit) {
      const failures: string[] = [];
      for (const source of sources) {
        try {
          const found = await source.lookup(query, limit);
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

/** The sources that are on, in the order SONG_SOURCES gives. */
export function sourcesInOrder(order: SongSourceName[], available: Partial<Record<SongSourceName, TrackSource | undefined>>): TrackSource | undefined {
  return combineSources(order.flatMap((name) => available[name] ?? []));
}
