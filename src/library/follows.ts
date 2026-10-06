import type { Artist, Catalog } from '../catalog.ts';
import type { Track } from '../types.ts';

/** How many different songs by an artist you get before the bot follows them for you. */
export const AUTO_FOLLOW_AFTER = 3;

/** Artists you follow: new songs by them are sent as soon as the bot sees them. */
export interface Follows {
  /** Follows the artist the words name; nothing when no artist fits. */
  follow(tokens: string[]): Artist | undefined;
  /** Stops following; says which artist that was, and whether they were followed at all. */
  unfollow(tokens: string[]): { artist: Artist; was: boolean } | undefined;
  list(): Array<{ name: string; auto: boolean }>;
  /** After a song is sent: the artists now followed for you, because you've had several of their songs. */
  afterPlay(track: Track): string[];
}

export function catalogFollows(catalog: Catalog, now: () => Date = () => new Date()): Follows {
  return {
    follow(tokens) {
      const artist = catalog.findArtist(tokens);
      if (artist) catalog.follow(artist.id, false, now());
      return artist;
    },
    unfollow(tokens) {
      const artist = catalog.findArtist(tokens);
      if (!artist) return undefined;
      const was = catalog.followState(artist.id) === 'on';
      catalog.unfollow(artist.id, now());
      return { artist, was };
    },
    list: () => catalog.followed().map((artist) => ({ name: artist.name, auto: artist.auto })),
    afterPlay(track) {
      const added: string[] = [];
      for (const artist of catalog.trackArtists(track.id)) {
        // Never after an unfollow, and never twice.
        if (catalog.followState(artist.id) !== undefined) continue;
        if (catalog.playedSongsBy(artist.id) < AUTO_FOLLOW_AFTER) continue;
        catalog.follow(artist.id, true, now());
        added.push(artist.name);
      }
      return added;
    },
  };
}
