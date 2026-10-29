import { artistKey, splitArtists } from '../artists.ts';
import { SourceError } from '../bot.ts';
import type { Catalog, NewRelease } from '../catalog.ts';
import { clean } from './zemer.ts';
import type { ZemerWhitelist } from './zemer-whitelist.ts';

// Zemer's new releases: the feed behind the "Latest Releases" shelf on the Zemer app's home tab (github.com/ZemerTeam/
// zemer-app, docs/latest_releases). A server job of the Zemer team walks the discography of every artist on Zemer's list
// once an hour and writes the releases of the last two weeks, newest first, into one small JSON with an ETag, so asking
// again costs a 304. (YouTube's own "new releases" carry almost no music from the artists on Zemer's list, which is why
// Zemer builds this.) It is served from a personal server of the team's, not from search.zemer.io, so it can move or
// stop without warning: everything here treats it as optional, and the bot goes on with music-table.com alone.
//
// A release is an album id, the same id `/album` opens, and a single when it has one song. The feed is not trusted: every
// release is held to Zemer's artist list the way the app holds it (by the artist's channel id, no female singers, nothing
// blocked), when it is stored and again whenever it is listed, announced or alerted, and its songs are checked once more
// when they are sent, since opening a release goes through the album page like any album found on Zemer.

export const ZEMER_RELEASES_URL = 'https://flipphoneguy.duckdns.org/?page=zemer_releases';

const ID = /^[\w-]{4,64}$/;
const VIDEO_ID = /^[\w-]{11}$/;
const FEED_TIMEOUT_MS = 10_000;
/** No title or name of a real release is anywhere near this long. */
const MAX_TEXT_CHARS = 200;
/** Where YouTube Music's covers live; a feed that points anywhere else gets no picture rather than a request to a stranger. */
const COVER_HOSTS = /(^|\.)(googleusercontent\.com|ggpht\.com|ytimg\.com)$/;
/** The feed holds a couple of dozen; more than this is not a feed to believe. */
const MAX_RELEASES = 300;
const DAY_MS = 24 * 60 * 60_000;
/** How long a release is kept after it came out: the feed only reaches back two weeks, a month and a half is plenty. */
const KEEP_DAYS = 45;
/** How often the feed is asked again at the most, unless a caller wants it sooner or later. */
const DEFAULT_MAX_AGE_MS = 15 * 60_000;
/** After a failure the feed is not asked again for this long, so a feed that is down is not asked every minute. */
const RETRY_AFTER_MS = 10 * 60_000;

/** A problem whose message is fit to show to the user. */
export class ZemerReleasesError extends SourceError {
  constructor(message: string) {
    super(message);
    this.name = 'ZemerReleasesError';
  }
}

/** A release as the feed gives it. */
export type FeedRelease = Omit<NewRelease, 'firstSeenAt' | 'announcedAt' | 'alertedAt'>;

type Json = Record<string, unknown>;
const record = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined);
const text = (value: unknown): string => (typeof value === 'string' ? clean(value) : '');
const id = (value: unknown, pattern = ID): string | undefined => (typeof value === 'string' && pattern.test(value) ? value : undefined);
const cover = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && COVER_HOSTS.test(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
};

function parseRelease(row: Json): FeedRelease | undefined {
  const releaseId = id(row.browseId);
  const artistId = id(row.artistId);
  const title = text(row.title);
  const artist = text(row.artistName);
  const released = typeof row.uploadDate === 'string' ? Date.parse(row.uploadDate) : Number.NaN;
  // A release missing any of these can't be shown or opened: it is left out, and the rest of the feed still counts.
  if (!releaseId || !artistId || !title || !artist || Number.isNaN(released)) return undefined;
  if (title.length > MAX_TEXT_CHARS || artist.length > MAX_TEXT_CHARS) return undefined;
  const songs = typeof row.trackCount === 'number' && Number.isInteger(row.trackCount) && row.trackCount > 0 ? row.trackCount : 0;
  const videoId = id(row.sampleVideoId, VIDEO_ID);
  const picture = cover(row.thumbnail);
  return {
    id: releaseId,
    title,
    artist,
    artistId,
    ...(picture ? { cover: picture } : {}),
    releasedAt: new Date(released).toISOString(),
    songs,
    // Only a single's one song is told apart by it: an album's sample is just the track its date came from.
    ...(songs === 1 && videoId ? { videoId } : {}),
  };
}

/** The releases in a feed's answer, newest first as the feed has them. Throws when the answer is not a feed. */
export function parseFeed(response: unknown): FeedRelease[] {
  const releases = record(response)?.releases;
  if (!Array.isArray(releases)) throw new ZemerReleasesError("Zemer's new-releases feed answered with something I can't read");
  return releases.slice(0, MAX_RELEASES).flatMap((row) => {
    const fields = record(row);
    const parsed = fields && parseRelease(fields);
    return parsed ? [parsed] : [];
  });
}

export interface ZemerReleasesOptions {
  url?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The client for the feed. */
export class ZemerReleases {
  readonly url: string;
  #fetch: typeof fetch;
  #timeout: number;
  #etag: string | undefined;
  #kept: FeedRelease[] | undefined;

  constructor(options: ZemerReleasesOptions = {}) {
    this.url = options.url ?? ZEMER_RELEASES_URL;
    this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.timeoutMs ?? FEED_TIMEOUT_MS;
  }

  /** The feed's releases, newest first. Asks with the last answer's ETag, so a feed that hasn't changed costs nothing. */
  async latest(): Promise<FeedRelease[]> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'music-over-rcs/0.1 (personal, single-user project)' };
    if (this.#etag && this.#kept) headers['If-None-Match'] = this.#etag;
    let res: Response;
    try {
      res = await this.#fetch(this.url, { headers, signal: AbortSignal.timeout(this.#timeout) });
    } catch {
      throw new ZemerReleasesError("Zemer's new-releases feed didn't answer (network error or timeout)");
    }
    if (res.status === 304 && this.#kept) {
      await res.body?.cancel().catch(() => {});
      return this.#kept;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ZemerReleasesError(`Zemer's new-releases feed answered HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new ZemerReleasesError("Zemer's new-releases feed answered with something unreadable");
    }
    const releases = parseFeed(body);
    this.#kept = releases;
    this.#etag = res.headers.get('etag') ?? undefined;
    return releases;
  }
}

/** ZEMER_RELEASES=off turns it off; ZEMER_RELEASES_URL points it elsewhere (tests). */
export function zemerReleasesFromEnv(env: NodeJS.ProcessEnv = process.env, options: ZemerReleasesOptions = {}): ZemerReleases | undefined {
  if (/^(off|false|no|0)$/i.test(env.ZEMER_RELEASES?.trim() ?? '')) return undefined;
  const url = env.ZEMER_RELEASES_URL?.trim();
  return new ZemerReleases(url ? { ...options, url } : options);
}

/** How a sync went. A failure says since when the feed has been failing, so a lasting one can be told from a blip. */
export type ReleasesSync = { ok: true; seen: number; fresh: NewRelease[] } | { ok: false; problem: string; since: Date };

/** Zemer's new releases as the rest of the bot uses them: kept in the catalog, held to Zemer's artist list. */
export interface NewReleases {
  /**
   * Brings the catalog up to date with the feed, unless that was done less than `maxAgeMs` ago (and went well, or the last
   * try failed less than ten minutes ago). Never rejects: a feed that can't be had is a failure in the answer.
   */
  sync(maxAgeMs?: number): Promise<ReleasesSync>;
  /** Every release the artist list lets through now, newest first. */
  list(): NewRelease[];
  /** The releases that came out after `since` and have not been in a daily message, newest first. */
  toAnnounce(since: Date): NewRelease[];
  markAnnounced(ids: string[], at: Date): void;
  /** The releases first seen since `since` by an artist you follow, none of whose songs you've had, and not alerted yet. */
  toAlert(since: Date): Array<NewRelease & { artists: string[] }>;
  markAlerted(ids: string[], at: Date): void;
}

export interface NewReleasesDeps {
  feed: ZemerReleases;
  /** Zemer's artist list. Required: no release goes unchecked. */
  whitelist: ZemerWhitelist;
  catalog: Pick<
    Catalog,
    'saveRelease' | 'releases' | 'pruneReleases' | 'markReleasesAnnounced' | 'markReleasesAlerted' | 'unalertedReleases' | 'followedSince' | 'releaseHad'
  >;
  log?: (line: string) => void;
  now?: () => Date;
}

export function createNewReleases(deps: NewReleasesDeps): NewReleases {
  const { feed, whitelist, catalog } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  let attemptedAt: number | undefined;
  let last: ReleasesSync | undefined;
  let flight: Promise<ReleasesSync> | undefined;
  let told = false;

  /** Whether the artist list lets a release through: its artist is on it, not a woman, and neither the album nor its single song is blocked. */
  const allows = (release: FeedRelease): boolean => whitelist.allows(release.id, [release.artistId]) && (!release.videoId || whitelist.allows(release.videoId, [release.artistId]));

  async function run(): Promise<ReleasesSync> {
    try {
      await whitelist.ready();
      const latest = await feed.latest();
      const at = now();
      const fresh: NewRelease[] = [];
      let seen = 0;
      for (const release of latest) {
        if (!allows(release)) continue;
        seen += 1;
        if (catalog.saveRelease(release, at).isNew) fresh.push({ ...release, firstSeenAt: at.toISOString() });
      }
      catalog.pruneReleases(new Date(at.getTime() - KEEP_DAYS * DAY_MS));
      if (fresh.length > 0 || !told) log(`read Zemer's new releases: ${latest.length} in the feed, ${seen} pass Zemer's list, ${fresh.length} new here`);
      told = true;
      return { ok: true, seen, fresh };
    } catch (err) {
      const problem = err instanceof SourceError ? err.message : `something went wrong reading Zemer's new releases (${err instanceof Error ? err.message : String(err)})`;
      if (!(err instanceof SourceError)) log(problem);
      return { ok: false, problem, since: last && !last.ok ? last.since : now() };
    }
  }

  const sync: NewReleases['sync'] = (maxAgeMs = DEFAULT_MAX_AGE_MS) => {
    if (flight) return flight;
    const age = attemptedAt === undefined ? Infinity : now().getTime() - attemptedAt;
    if (last && age < (last.ok ? maxAgeMs : Math.min(maxAgeMs, RETRY_AFTER_MS))) return Promise.resolve(last.ok ? { ...last, fresh: [] } : last);
    const started = run().then((outcome) => {
      attemptedAt = now().getTime();
      last = outcome;
      return outcome;
    });
    flight = started.finally(() => {
      flight = undefined;
    });
    return flight;
  };

  const list = (): NewRelease[] => catalog.releases().filter(allows);

  return {
    sync,
    list,
    toAnnounce: (since) => list().filter((release) => release.announcedAt === undefined && Date.parse(release.releasedAt) > since.getTime()),
    markAnnounced: (ids, at) => catalog.markReleasesAnnounced(ids, at),
    toAlert(since) {
      const followed = catalog.followedSince();
      if (followed.length === 0) return [];
      const alerts: Array<NewRelease & { artists: string[] }> = [];
      for (const release of catalog.unalertedReleases(since)) {
        if (!allows(release) || catalog.releaseHad(release.id)) continue;
        // The feed names the artist in one alphabet; the list may know them in the other, and a follow was made from either.
        const listed = whitelist.artist(release.artistId);
        const keys = new Set([release.artist, listed?.name, listed?.altName].flatMap((name) => (name ? splitArtists(name).map(artistKey) : [])));
        const hits = followed.filter((artist) => keys.has(artist.key) && release.firstSeenAt >= artist.since);
        if (hits.length > 0) alerts.push({ ...release, artists: [...new Set(hits.map((artist) => artist.name))] });
      }
      return alerts;
    },
    markAlerted: (ids, at) => catalog.markReleasesAlerted(ids, at),
  };
}

/**
 * Zemer's new releases for an entry point: from the feed (ZEMER_RELEASES=off turns it off), held to the artist list.
 * Undefined without the list, since nothing from Zemer goes unchecked.
 */
export function newReleasesFromEnv(
  deps: Omit<NewReleasesDeps, 'feed' | 'whitelist'> & { whitelist: ZemerWhitelist | undefined },
  env: NodeJS.ProcessEnv = process.env,
  options: ZemerReleasesOptions = {},
): NewReleases | undefined {
  const feed = deps.whitelist && zemerReleasesFromEnv(env, options);
  return feed && deps.whitelist ? createNewReleases({ ...deps, feed, whitelist: deps.whitelist }) : undefined;
}
