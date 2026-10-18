import { listen, type Listening } from './servers.ts';

export interface MockArtist {
  id: string;
  name: string;
  female?: boolean;
  /** Written the way some of the real list's documents are: with `artistId` and `artistName` instead of `id` and `name`. */
  legacyKeys?: boolean;
  displayName?: string;
  /** The name in the other alphabet ("Lipa Schmeltzer" for "ליפא שמעלצער"). */
  altName?: string;
}

export interface MockZemerContent extends Listening {
  artists: MockArtist[];
  blocked: { global: string[]; female: string[] };
  /** The version gate. Bump it (or call `publish`) to say the list changed. */
  gate: number;
  /** Every request, as "/path". */
  requests: string[];
  /** Paths that answer HTTP 503. */
  failing: Set<string>;
  /** Paths that answer only after this many milliseconds. */
  delayMs: number;
  /** The list answers with no artists in it. */
  emptyList: boolean;
  /** Changes the list and bumps the version, like a curator adding an artist. */
  publish(change: (artists: MockArtist[], blocked: { global: string[]; female: string[] }) => void): void;
  reset(artists: MockArtist[]): void;
}

/**
 * A stand-in for content.zemer.io, shaped like what it answered in October 2026: `/whitelist/version` has a `gate` that
 * changes whenever the list does, `/whitelist` is an array of artist documents (with the female flag), and
 * `/blockedContentIds` is `{ global, female }`.
 */
export async function startMockZemerContent(initial: MockArtist[]): Promise<MockZemerContent> {
  const mock: MockZemerContent = {
    url: '',
    server: undefined as never,
    close: async () => {},
    artists: [...initial],
    blocked: { global: [], female: [] },
    gate: 1_791_727_258_813,
    requests: [],
    failing: new Set(),
    delayMs: 0,
    emptyList: false,
    publish(change) {
      change(mock.artists, mock.blocked);
      mock.gate += 60_000;
    },
    reset(artists) {
      mock.artists = [...artists];
      mock.blocked = { global: [], female: [] };
      mock.gate = 1_791_727_258_813;
      mock.requests = [];
      mock.failing = new Set();
      mock.delayMs = 0;
      mock.emptyList = false;
    },
  };

  const server = await listen(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    mock.requests.push(path);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (mock.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
    if (mock.failing.has(path)) return json(503, { error: 'unavailable' });

    if (path === '/whitelist/version') return json(200, { update: '9', updatedAt: new Date(mock.gate).toISOString(), updatedAtMs: mock.gate - 203_813, gate: mock.gate });
    if (path === '/blockedContentIds') return json(200, mock.blocked);
    if (path === '/whitelist') {
      if (mock.emptyList) return json(200, []);
      return json(
        200,
        mock.artists.map((artist) => ({
          docId: artist.id,
          isDJ: false,
          isKids: false,
          altName: artist.altName ?? artist.name,
          isGroup: false,
          isVerified: true,
          isFemale: artist.female === true,
          isFamous: false,
          isKidZone: false,
          thumbnail: 'https://yt3.googleusercontent.com/x',
          ...(artist.displayName ? { displayName: artist.displayName } : {}),
          ...(artist.legacyKeys ? { artistId: artist.id, artistName: artist.name } : { id: artist.id, name: artist.name }),
        })),
      );
    }
    return json(404, { error: 'not found' });
  });

  mock.url = server.url;
  mock.server = server.server;
  mock.close = server.close;
  return mock;
}
