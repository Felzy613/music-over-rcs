import { listen, type Listening } from './servers.ts';

export interface MockZemerSong {
  videoId: string;
  title: string;
  artist: string;
  /** The credited artist's channel id; the real search sends it, an album's page doesn't. */
  artistId?: string;
  album?: { id: string; name: string };
  durationSec?: number;
  playCount?: number;
  thumbnail?: string;
  /** A video on YouTube rather than a song (it comes in the search's "videos"). */
  video?: boolean;
  /** Other words it is found by, the way the real search reads Latin spellings of Hebrew titles ("vnusni" for "ונתנו"). */
  keywords?: string[];
}

export interface MockZemerRelease {
  id: string;
  title: string;
  artist: string;
  artistId: string;
  year?: number;
  releaseDate?: string;
  type?: 'album' | 'single';
  thumbnail?: string;
  /** Its songs in order, as its page lists them: no artist id, and the artist only as a name. */
  tracks: Array<{ videoId: string; title: string; artist?: string; durationSec?: number }>;
  /** Other words it is found by (see MockZemerSong.keywords). */
  keywords?: string[];
}

export interface MockZemerArtist {
  id: string;
  name: string;
}

export interface MockZemerSearch extends Listening {
  artists: MockZemerArtist[];
  songs: MockZemerSong[];
  releases: MockZemerRelease[];
  /** Every request, as "/path?query". */
  requests: string[];
  /** Answer every request with HTTP 500. */
  failing: boolean;
  reset(): void;
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * A stand-in for search.zemer.io, shaped like what it answered in October 2026: `/search` sorts what fits into
 * categories (artists, songs, videos, albums, singles), `/artist` is an artist's whole catalog, `/album` an album's
 * songs; an id it doesn't have is a 404. Like the real one it answers anything that shares a word with what is
 * searched for, so the bot has to judge what really fits. Invisible direction marks are left in titles on purpose.
 */
export async function startMockZemerSearch(initial: { artists: MockZemerArtist[]; songs: MockZemerSong[]; releases: MockZemerRelease[] }): Promise<MockZemerSearch> {
  const mock: MockZemerSearch = {
    url: '',
    server: undefined as never,
    close: async () => {},
    artists: [],
    songs: [],
    releases: [],
    requests: [],
    failing: false,
    reset() {
      mock.artists = [...initial.artists];
      mock.songs = [...initial.songs];
      mock.releases = [...initial.releases];
      mock.requests = [];
      mock.failing = false;
    },
  };
  mock.reset();

  const release = (row: MockZemerRelease) => ({
    id: row.id,
    playlistId: `OLAK5uy_${row.id}`,
    title: row.title,
    artist: row.artist,
    artistId: row.artistId,
    type: row.type ?? 'album',
    ...(row.year ? { year: row.year } : {}),
    ...(row.releaseDate ? { releaseDate: row.releaseDate } : {}),
    ...(row.thumbnail ? { thumbnail: row.thumbnail } : {}),
    trackCount: row.tracks.length,
  });
  const song = (row: MockZemerSong) => {
    const { video: _video, keywords: _keywords, ...rest } = row;
    return { explicit: false, ...rest };
  };

  const server = await listen((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    mock.requests.push(`${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (mock.failing) return json(500, { error: 'internal' });
    const id = url.searchParams.get('id') ?? '';

    if (url.pathname === '/search') {
      const q = url.searchParams.get('q') ?? '';
      const k = Number(url.searchParams.get('k') ?? 20);
      const wanted = words(q).filter((word) => word.length >= 2);
      const fits = (...texts: string[]): boolean => {
        const have = texts.flatMap(words);
        return wanted.some((word) => have.some((one) => one.startsWith(word)));
      };
      const songs = mock.songs.filter((row) => fits(row.title, row.artist, row.album?.name ?? '', ...(row.keywords ?? [])));
      const releases = mock.releases.filter((row) => fits(row.title, row.artist, ...(row.keywords ?? [])));
      const categories = {
        artists: mock.artists.filter((row) => fits(row.name)).slice(0, k).map((row) => ({ ...row, thumbnail: `https://yt3.example.test/${row.id}` })),
        songs: songs.filter((row) => !row.video).slice(0, k).map(song),
        videos: songs.filter((row) => row.video).slice(0, k).map(song),
        albums: releases.filter((row) => (row.type ?? 'album') === 'album').slice(0, k).map(release),
        singles: releases.filter((row) => row.type === 'single').slice(0, k).map(release),
        playlists: [],
        community: [],
        podcasts: [],
        episodes: [],
      };
      return json(200, { q, count: Object.values(categories).reduce((total, list) => total + list.length, 0), categories });
    }
    if (url.pathname === '/artist') {
      const artist = mock.artists.find((row) => row.id === id);
      if (!artist) return json(404, { error: 'not found' });
      const theirs = mock.releases.filter((row) => row.artistId === id);
      return json(200, {
        artist: { ...artist, thumbnail: `https://yt3.example.test/${id}` },
        // An artist's songs come without their credit.
        songs: mock.songs.filter((row) => row.artistId === id && !row.video).map(({ artist: _artist, artistId: _id, ...row }) => song(row as MockZemerSong)),
        videos: [],
        albums: theirs.filter((row) => (row.type ?? 'album') === 'album').map(release),
        singles: theirs.filter((row) => row.type === 'single').map(release),
        playlists: [],
      });
    }
    if (url.pathname === '/album') {
      const found = mock.releases.find((row) => row.id === id);
      if (!found) return json(404, { error: 'not found' });
      return json(200, {
        album: release(found),
        tracks: found.tracks.map((track, i) => ({ videoId: track.videoId, title: track.title, artist: track.artist ?? found.artist, explicit: false, trackNumber: i + 1, ...(track.durationSec ? { durationSec: track.durationSec } : {}) })),
      });
    }
    return json(404, { error: 'not found' });
  });

  mock.url = server.url;
  mock.server = server.server;
  mock.close = server.close;
  return mock;
}
