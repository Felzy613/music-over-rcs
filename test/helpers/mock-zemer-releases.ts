import { listen, type Listening } from './servers.ts';

/** A release as the feed gives it (flipphoneguy.duckdns.org/?page=zemer_releases, as it answered on 2026-10-29). */
export interface MockFeedRelease {
  artistId: string;
  artistName: string;
  title: string;
  /** The album's id (`MPRE…`). */
  browseId: string;
  playlistId?: string;
  thumbnail?: string;
  year?: number;
  /** ISO, with the offset the server writes (-07:00). */
  uploadDate: string;
  /** 1 is a single. */
  trackCount?: number;
  sampleVideoId?: string;
}

export interface MockZemerReleases extends Listening {
  /** The feed's `releases`, newest first. */
  releases: MockFeedRelease[];
  /** Every request: what it asked with (`If-None-Match`, or nothing). */
  requests: Array<{ etag: string }>;
  /** Answer every request with HTTP 500. */
  failing: boolean;
  /** Answer 200 with this instead of a feed. */
  body: string | undefined;
  /** Answers only after this many milliseconds. */
  delayMs: number;
  /** Says the feed was rebuilt: a new ETag, so a client that has the old one gets the whole feed again. */
  publish(change?: (releases: MockFeedRelease[]) => void): void;
  /** The feed as it is served. */
  feed(): unknown;
  reset(releases: MockFeedRelease[]): void;
}

/**
 * A stand-in for the Zemer team's new-releases feed, shaped like what it answered: `{ generatedAt, whitelistVersion,
 * windowDays, count, releases }` with an ETag, and a 304 for a client that has it already.
 */
export async function startMockZemerReleases(initial: MockFeedRelease[] = []): Promise<MockZemerReleases> {
  let version = 1;
  const mock: MockZemerReleases = {
    url: '',
    server: undefined as never,
    close: async () => {},
    releases: [...initial],
    requests: [],
    failing: false,
    body: undefined,
    delayMs: 0,
    publish(change) {
      change?.(mock.releases);
      version += 1;
    },
    feed: () => ({ generatedAt: '2026-10-29T02:41:15.746Z', whitelistVersion: '1793230845577', windowDays: 14, count: mock.releases.length, releases: mock.releases }),
    reset(releases) {
      mock.releases = [...releases];
      mock.requests = [];
      mock.failing = false;
      mock.body = undefined;
      mock.delayMs = 0;
      version += 1;
    },
  };

  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const etag = `"mock-feed-${version}"`;
    const asked = String(req.headers['if-none-match'] ?? '');
    mock.requests.push({ etag: asked });
    if (mock.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
    if (url.pathname !== '/' || url.searchParams.get('page') !== 'zemer_releases') {
      res.writeHead(404);
      return void res.end();
    }
    if (mock.failing) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return void res.end('{"error":"internal"}');
    }
    if (mock.body !== undefined) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(mock.body);
    }
    if (asked === etag) {
      res.writeHead(304, { etag });
      return void res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json', etag, 'cache-control': 'public, max-age=900' });
    res.end(JSON.stringify(mock.feed()));
  });

  mock.url = server.url;
  mock.server = server.server;
  mock.close = server.close;
  return mock;
}
