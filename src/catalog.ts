import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { artistKey, splitArtists } from './artists.ts';
import { parseQuery } from './query.ts';
import { allowedEdits, correctableEdits, editDistance, rankSongs } from './sources/relevance.ts';
import type { SongFacts } from './library/naming.ts';
import type { ChoiceStore, MessageLinks, PendingChoices, ResumePoint, ResumeStore } from './runner.ts';
import type { Track } from './types.ts';
import type { View, ViewKey, ViewStore } from './views.ts';

export interface NewTrack {
  title: string;
  artist?: string;
  url: string;
  /** A picture for the song (album art). Left as it was when not given. */
  cover?: string | undefined;
  /** The music-table.com post it comes from, and when that was published (ISO). */
  post?: string | undefined;
  releasedAt?: string | undefined;
  /** The channel ids of the artists credited on it, for songs found on YouTube Music (checked against Zemer's list when sent). */
  artistIds?: string[] | undefined;
  /** The album it is on, for a song found on Zemer (a music-table.com song's album is its post). Kept when not given. */
  album?: TrackAlbum | undefined;
}

/** A song's album, as far as it is known: its title, and once its page has been read, the song's place on it. */
export interface TrackAlbum {
  /** What opens it again (Zemer's album id). */
  id?: string | undefined;
  title: string;
  /** Whose album it is (its album artist). */
  artist?: string | undefined;
  /** The song's number on it. */
  number?: number | undefined;
  /** How many songs it has: 1 for a single. */
  songs?: number | undefined;
  year?: number | undefined;
}

/** An artist found in the songs' credits, with how many songs they're on. */
export interface Artist {
  id: number;
  name: string;
  songs: number;
}

/**
 * One entry of a list: a song, or (for a post with several songs) an album, shown by the post's title and stood for by
 * its first song. Picking an album lists its songs.
 */
export type ListedTrack = Track & {
  releasedAt?: string | undefined;
  views?: number | undefined;
  post?: string | undefined;
  album?: { title: string; songs: number } | undefined;
};

/**
 * A release from Zemer's new releases in a list: a single (one song) or an album, which a 👍 opens through Zemer. It has
 * no song in the catalog: its songs are stored when it is opened, as for any other album found on Zemer.
 */
export interface ListedRelease {
  /** Zemer's album id, which opens it. */
  releaseId: string;
  title: string;
  artist: string;
  /** How many songs it has: 1 for a single, 0 when the feed doesn't say. */
  songs: number;
  releasedAt: string;
  cover?: string | undefined;
}

/** What a list holds: a song or music-table.com album from the catalog, or a release from Zemer. */
export type ListedEntry = ListedTrack | ListedRelease;

/** A release from Zemer's new-releases feed, as the catalog remembers it. */
export interface NewRelease {
  /** Zemer's album id (YouTube Music's browse id for it), which opens it. */
  id: string;
  title: string;
  /** Whose release it is, as the feed names them. */
  artist: string;
  /** The artist's channel id, which Zemer's artist list is checked by. */
  artistId: string;
  cover?: string | undefined;
  /** ISO time it went up on YouTube Music. */
  releasedAt: string;
  /** How many songs it has: 1 for a single, 0 when the feed doesn't say. */
  songs: number;
  /** A single's one song: what the blocked-songs list is checked by. */
  videoId?: string | undefined;
  /** ISO time this machine first saw it. */
  firstSeenAt: string;
  /** ISO time it went out in a daily message, if it did. */
  announcedAt?: string | undefined;
  /** ISO time a "new from an artist you follow" alert went out for it, if one did. */
  alertedAt?: string | undefined;
}

/** A post on music-table.com as the catalog remembers it: enough to rank it and announce it. */
export interface SitePost {
  slug: string;
  title: string;
  /** The site's category: "Singles", "Videos", "Weddings & Events"… Empty when not known. */
  category: string;
  /** ISO time it was first published. */
  publishedAt: string;
  views: number;
  cover?: string | undefined;
  /** How many MP3s it offers. 0 means a video or news post. */
  audioFiles: number;
  /** ISO time this machine first saw it. */
  firstSeenAt: string;
  /** ISO time it went out in a daily message, if it did. */
  announcedAt?: string | undefined;
  /** The site's categories it's in (ids). */
  categoryIds?: string[] | undefined;
  /** ISO time a "new from an artist you follow" alert went out for it, if one did. */
  alertedAt?: string | undefined;
}

/** A song file kept on disk so it can be sent without downloading it first. */
export interface CachedAudio {
  url: string;
  /** Where the file is: a path inside the folder on this Mac ("Artist/Album/01 Title.mp3"), or a full path on the drive. */
  file: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  fetchedAt: string;
  usedAt: string;
  /** Where on the drive an earlier copy of this song is (one downloaded again while the drive was away). */
  replaces?: string | undefined;
  /** The tags written into the file, as written (so they're written again only when they change). */
  tags?: string | undefined;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tracks (
    id       INTEGER PRIMARY KEY,
    title    TEXT NOT NULL,
    artist   TEXT NOT NULL DEFAULT '',
    url      TEXT NOT NULL UNIQUE,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
    title, artist,
    content = 'tracks', content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS tracks_ai AFTER INSERT ON tracks BEGIN
    INSERT INTO tracks_fts (rowid, title, artist) VALUES (new.id, new.title, new.artist);
  END;
  CREATE TRIGGER IF NOT EXISTS tracks_ad AFTER DELETE ON tracks BEGIN
    INSERT INTO tracks_fts (tracks_fts, rowid, title, artist) VALUES ('delete', old.id, old.title, old.artist);
  END;
  CREATE TRIGGER IF NOT EXISTS tracks_au AFTER UPDATE ON tracks BEGIN
    INSERT INTO tracks_fts (tracks_fts, rowid, title, artist) VALUES ('delete', old.id, old.title, old.artist);
    INSERT INTO tracks_fts (rowid, title, artist) VALUES (new.id, new.title, new.artist);
  END;
  CREATE TABLE IF NOT EXISTS plays (
    track_id INTEGER NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
    at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS plays_by_track ON plays (track_id);
  CREATE TABLE IF NOT EXISTS site_posts (
    slug          TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    category      TEXT NOT NULL DEFAULT '',
    published_at  TEXT NOT NULL,
    views         INTEGER NOT NULL DEFAULT 0,
    cover         TEXT,
    audio_files   INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    announced_at  TEXT
  );
  CREATE INDEX IF NOT EXISTS site_posts_by_date ON site_posts (published_at);
  CREATE TABLE IF NOT EXISTS zemer_releases (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    artist        TEXT NOT NULL,
    artist_id     TEXT NOT NULL,
    cover         TEXT,
    released_at   TEXT NOT NULL,
    songs         INTEGER NOT NULL DEFAULT 0,
    video_id      TEXT,
    first_seen_at TEXT NOT NULL,
    announced_at  TEXT,
    alerted_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS zemer_releases_by_date ON zemer_releases (released_at);
  CREATE TABLE IF NOT EXISTS audio_cache (
    url        TEXT PRIMARY KEY,
    file       TEXT NOT NULL,
    file_name  TEXT NOT NULL,
    mime_type  TEXT NOT NULL,
    bytes      INTEGER NOT NULL,
    fetched_at TEXT NOT NULL,
    used_at    TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS artists (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    key  TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS artist_tracks (
    artist_id INTEGER NOT NULL REFERENCES artists (id) ON DELETE CASCADE,
    track_id  INTEGER NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
    PRIMARY KEY (artist_id, track_id)
  );
  CREATE INDEX IF NOT EXISTS artist_tracks_by_track ON artist_tracks (track_id);
  CREATE TABLE IF NOT EXISTS follows (
    artist_id INTEGER PRIMARY KEY REFERENCES artists (id) ON DELETE CASCADE,
    following INTEGER NOT NULL,
    auto      INTEGER NOT NULL DEFAULT 0,
    since     TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS message_links (
    message_id TEXT PRIMARY KEY,
    postback   TEXT NOT NULL,
    at         TEXT NOT NULL
  );
  -- AUTOINCREMENT: a view's id is never used again, so an old message's "@id" can't come to mean another view.
  CREATE TABLE IF NOT EXISTS views (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    parent    INTEGER,
    kind      TEXT NOT NULL,
    key       TEXT NOT NULL,
    shown     TEXT NOT NULL DEFAULT '[]',
    last_more TEXT,
    at        TEXT NOT NULL,
    used_at   TEXT NOT NULL
  );
`;

/** Views are kept a month from when they were last used, and only the newest of them. */
const VIEW_DAYS = 31;
const VIEWS_KEPT = 300;

const TRACK_COLUMNS = 'id, title, artist, url, cover';

/** A stored album (JSON), or undefined when there is none or it can't be read. */
function parseAlbum(raw: unknown): TrackAlbum | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return undefined;
    const album = value as Record<string, unknown>;
    if (typeof album.title !== 'string' || !album.title) return undefined;
    const count = (n: unknown): number | undefined => (typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : undefined);
    const words = (s: unknown): string | undefined => (typeof s === 'string' && s ? s : undefined);
    const fields = { id: words(album.id), artist: words(album.artist), number: count(album.number), songs: count(album.songs), year: count(album.year) };
    return { title: album.title, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
  } catch {
    return undefined;
  }
}

/** node:sqlite returns rows with a null prototype; hand out plain Track objects instead. */
const toTrack = (row: Record<string, unknown>): Track => ({
  id: Number(row.id),
  title: String(row.title),
  artist: String(row.artist),
  url: String(row.url),
  ...(typeof row.cover === 'string' && row.cover ? { cover: row.cover } : {}),
});

const toSitePost = (row: Record<string, unknown>): SitePost => ({
  slug: String(row.slug),
  title: String(row.title),
  category: String(row.category ?? ''),
  publishedAt: String(row.published_at),
  views: Number(row.views) || 0,
  ...(typeof row.cover === 'string' && row.cover ? { cover: row.cover } : {}),
  audioFiles: Number(row.audio_files) || 0,
  firstSeenAt: String(row.first_seen_at),
  ...(typeof row.announced_at === 'string' ? { announcedAt: row.announced_at } : {}),
  ...(typeof row.category_ids === 'string' && row.category_ids ? { categoryIds: row.category_ids.split(',') } : {}),
  ...(typeof row.alerted_at === 'string' ? { alertedAt: row.alerted_at } : {}),
});

const toRelease = (row: Record<string, unknown>): NewRelease => ({
  id: String(row.id),
  title: String(row.title),
  artist: String(row.artist),
  artistId: String(row.artist_id),
  ...(typeof row.cover === 'string' && row.cover ? { cover: row.cover } : {}),
  releasedAt: String(row.released_at),
  songs: Number(row.songs) || 0,
  ...(typeof row.video_id === 'string' && row.video_id ? { videoId: row.video_id } : {}),
  firstSeenAt: String(row.first_seen_at),
  ...(typeof row.announced_at === 'string' ? { announcedAt: row.announced_at } : {}),
  ...(typeof row.alerted_at === 'string' ? { alertedAt: row.alerted_at } : {}),
});

const toCachedAudio = (row: Record<string, unknown>): CachedAudio => ({
  url: String(row.url),
  file: String(row.file),
  fileName: String(row.file_name),
  mimeType: String(row.mime_type),
  bytes: Number(row.bytes) || 0,
  fetchedAt: String(row.fetched_at),
  usedAt: String(row.used_at),
  ...(typeof row.replaces === 'string' && row.replaces ? { replaces: row.replaces } : {}),
  ...(typeof row.tags === 'string' && row.tags ? { tags: row.tags } : {}),
});

/** The song database: one row per audio URL, searchable by title and artist. */
export class Catalog {
  #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    // The bot and the command-line tools share this file; wait a moment for the other's write instead of failing.
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
    // Catalogs made before songs had pictures, posts and dates get the columns now.
    const columns = this.#db.prepare('PRAGMA table_info(tracks)').all().map((column) => String(column.name));
    if (!columns.includes('cover')) this.#db.exec('ALTER TABLE tracks ADD COLUMN cover TEXT');
    if (!columns.includes('post')) this.#db.exec('ALTER TABLE tracks ADD COLUMN post TEXT');
    if (!columns.includes('released_at')) this.#db.exec('ALTER TABLE tracks ADD COLUMN released_at TEXT');
    if (!columns.includes('artist_ids')) this.#db.exec('ALTER TABLE tracks ADD COLUMN artist_ids TEXT');
    if (!columns.includes('album')) this.#db.exec('ALTER TABLE tracks ADD COLUMN album TEXT');
    this.#db.exec('CREATE INDEX IF NOT EXISTS tracks_by_post ON tracks (post)');
    const postColumns = this.#db.prepare('PRAGMA table_info(site_posts)').all().map((column) => String(column.name));
    if (!postColumns.includes('category_ids')) this.#db.exec('ALTER TABLE site_posts ADD COLUMN category_ids TEXT');
    if (!postColumns.includes('alerted_at')) this.#db.exec('ALTER TABLE site_posts ADD COLUMN alerted_at TEXT');
    const cacheColumns = this.#db.prepare('PRAGMA table_info(audio_cache)').all().map((column) => String(column.name));
    if (!cacheColumns.includes('replaces')) this.#db.exec('ALTER TABLE audio_cache ADD COLUMN replaces TEXT');
    if (!cacheColumns.includes('tags')) this.#db.exec('ALTER TABLE audio_cache ADD COLUMN tags TEXT');
    // Songs that came before artists were kept get theirs now.
    const linked = Number(this.#db.prepare('SELECT count(*) AS n FROM artist_tracks').get()?.n);
    if (linked === 0) {
      for (const row of this.#db.prepare("SELECT id, artist FROM tracks WHERE artist != ''").all()) this.#linkArtists(Number(row.id), String(row.artist));
    }
  }

  /** Records which artists a song is by, from its credit. */
  #linkArtists(trackId: number, credit: string): void {
    this.#db.prepare('DELETE FROM artist_tracks WHERE track_id = ?').run(trackId);
    for (const name of splitArtists(credit)) {
      const row = this.#db
        .prepare('INSERT INTO artists (name, key) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET name = name RETURNING id')
        .get(name, artistKey(name));
      this.#db.prepare('INSERT OR IGNORE INTO artist_tracks (artist_id, track_id) VALUES (?, ?)').run(Number(row!.id), trackId);
    }
  }

  /** Adds a track, or updates the title/artist if the URL is already in the catalog. */
  add(input: NewTrack): Track {
    const title = input.title.trim();
    const artist = (input.artist ?? '').trim();
    const url = input.url.trim();
    if (!title) throw new Error('title is required');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`URL must start with http:// or https://: ${url}`);
    }
    const cover = input.cover?.trim() || null;
    const row = this.#db
      .prepare(
        `INSERT INTO tracks (title, artist, url, cover, post, released_at, artist_ids, album) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET title = excluded.title, artist = excluded.artist, cover = coalesce(excluded.cover, cover),
           post = coalesce(excluded.post, post), released_at = coalesce(excluded.released_at, released_at),
           artist_ids = coalesce(excluded.artist_ids, artist_ids),
           -- A song's place on its album, once known, isn't forgotten when a search finds it again without it.
           album = CASE WHEN excluded.album IS NULL THEN album
             WHEN album IS NOT NULL AND json_extract(excluded.album, '$.number') IS NULL AND json_extract(album, '$.number') IS NOT NULL THEN album
             ELSE excluded.album END
         RETURNING ${TRACK_COLUMNS}`,
      )
      .get(
        title,
        artist,
        url,
        cover,
        input.post ?? null,
        input.releasedAt ?? null,
        input.artistIds ? JSON.stringify(input.artistIds) : null,
        input.album?.title.trim() ? JSON.stringify(input.album) : null,
      );
    const track = toTrack(row!);
    this.#linkArtists(track.id, artist);
    return track;
  }

  get(id: number): Track | undefined {
    const row = this.#db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`).get(id);
    return row ? toTrack(row) : undefined;
  }

  /** The channel ids of the artists credited on a song found on YouTube Music; undefined for any other song. */
  artistIdsOf(url: string): string[] | undefined {
    const raw = this.#db.prepare('SELECT artist_ids FROM tracks WHERE url = ?').get(url)?.artist_ids;
    if (typeof raw !== 'string') return undefined;
    try {
      const ids: unknown = JSON.parse(raw);
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : undefined;
    } catch {
      return undefined;
    }
  }

  byUrl(url: string): Track | undefined {
    const row = this.#db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE url = ?`).get(url);
    return row ? toTrack(row) : undefined;
  }

  /**
   * Full-text search: every word must match the start of a word in the title or artist. When no song has them all,
   * a looser look through every song: apostrophes left out ("vnusni" for "V’Nusni"), typos, a missing word.
   */
  search(raw: string, limit = 6): Track[] {
    const tokens = parseQuery(raw);
    if (tokens.length === 0) return [];
    const match = tokens.map((token) => `"${token}"*`).join(' ');
    const rows = this.#db
      .prepare(
        `SELECT t.id, t.title, t.artist, t.url, t.cover
         FROM tracks_fts JOIN tracks AS t ON t.id = tracks_fts.rowid
         WHERE tracks_fts MATCH ?
         ORDER BY bm25(tracks_fts, 3.0, 1.0), t.id
         LIMIT ?`,
      )
      .all(match, limit);
    if (rows.length > 0) return rows.map(toTrack);
    return rankSongs(this.#db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks ORDER BY id`).all().map(toTrack), tokens, limit);
  }

  list(limit = 50, offset = 0): Track[] {
    const rows = this.#db
      .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(limit, offset);
    return rows.map(toTrack);
  }

  all(): Track[] {
    return this.#db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks ORDER BY id`).all().map(toTrack);
  }

  count(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS n FROM tracks').get();
    return Number(row?.n);
  }

  remove(id: number): boolean {
    return Number(this.#db.prepare('DELETE FROM tracks WHERE id = ?').run(id).changes) > 0;
  }

  // --- plays: what you ask for, so the most played songs can be kept ready ---

  recordPlay(trackId: number, at: Date = new Date()): void {
    this.#db.prepare('INSERT INTO plays (track_id, at) VALUES (?, ?)').run(trackId, at.toISOString());
  }

  /** The songs you asked for most, most first (ties: the one asked for most recently). */
  mostPlayed(limit: number): Array<Track & { plays: number }> {
    return this.#db
      .prepare(
        `SELECT t.id, t.title, t.artist, t.url, t.cover, count(*) AS plays, max(p.at) AS last
           FROM plays p JOIN tracks t ON t.id = p.track_id
          GROUP BY t.id ORDER BY plays DESC, last DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({ ...toTrack(row), plays: Number(row.plays) }));
  }

  // --- site posts: what music-table.com has published, kept up to date by the sync ---

  /** Records a post, or refreshes what may change (title, views, picture, files). Says whether it was new here. */
  savePost(post: Omit<SitePost, 'firstSeenAt' | 'announcedAt' | 'alertedAt'>, now: Date = new Date()): { isNew: boolean } {
    const known = this.#db.prepare('SELECT 1 FROM site_posts WHERE slug = ?').get(post.slug) !== undefined;
    this.#db
      .prepare(
        `INSERT INTO site_posts (slug, title, category, published_at, views, cover, audio_files, first_seen_at, category_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET
           title = excluded.title,
           category = CASE WHEN excluded.category = '' THEN category ELSE excluded.category END,
           published_at = excluded.published_at,
           views = max(views, excluded.views),
           cover = coalesce(excluded.cover, cover),
           audio_files = excluded.audio_files,
           category_ids = coalesce(excluded.category_ids, category_ids)`,
      )
      .run(
        post.slug,
        post.title,
        post.category,
        post.publishedAt,
        post.views,
        post.cover ?? null,
        post.audioFiles,
        now.toISOString(),
        post.categoryIds?.length ? post.categoryIds.join(',') : null,
      );
    return { isNew: !known };
  }

  sitePost(slug: string): SitePost | undefined {
    const row = this.#db.prepare('SELECT * FROM site_posts WHERE slug = ?').get(slug);
    return row ? toSitePost(row) : undefined;
  }

  /** Posts published after `since` that have not gone out in a daily message yet, newest first. */
  postsToAnnounce(since: Date, limit = 30): SitePost[] {
    return this.#db
      .prepare('SELECT * FROM site_posts WHERE published_at > ? AND announced_at IS NULL ORDER BY published_at DESC LIMIT ?')
      .all(since.toISOString(), limit)
      .map(toSitePost);
  }

  markAnnounced(slugs: string[], at: Date = new Date()): void {
    const mark = this.#db.prepare('UPDATE site_posts SET announced_at = ? WHERE slug = ?');
    for (const slug of slugs) mark.run(at.toISOString(), slug);
  }

  /** Posts with music, published since `since`, most viewed first. */
  popularPosts(since: Date, limit: number): SitePost[] {
    return this.#db
      .prepare('SELECT * FROM site_posts WHERE audio_files > 0 AND published_at >= ? ORDER BY views DESC, published_at DESC LIMIT ?')
      .all(since.toISOString(), limit)
      .map(toSitePost);
  }

  /** The most recent posts with music, newest first. */
  newestPosts(limit: number): SitePost[] {
    return this.#db
      .prepare('SELECT * FROM site_posts WHERE audio_files > 0 ORDER BY published_at DESC LIMIT ?')
      .all(limit)
      .map(toSitePost);
  }

  postCount(): number {
    return Number(this.#db.prepare('SELECT count(*) AS n FROM site_posts').get()?.n);
  }

  // --- browsing: artists, what's trending, what's new ---

  /**
   * The artist a request names, if it names one: all its words (typos allowed) are the artist's whole name, or a
   * single word is an artist's last name ("shwekey"). When several fit, the one on the most songs, if clearly so.
   */
  findArtist(tokens: string[]): Artist | undefined {
    if (tokens.length === 0) return undefined;
    const exactRow = this.#db
      .prepare('SELECT a.id, a.name, count(at.track_id) AS songs FROM artists a JOIN artist_tracks at ON at.artist_id = a.id WHERE a.key = ? GROUP BY a.id')
      .get(tokens.join(' '));
    const exact = exactRow ? { id: Number(exactRow.id), name: String(exactRow.name), songs: Number(exactRow.songs) } : undefined;
    const close = (token: string, word: string): boolean => {
      const edits = allowedEdits(token.length);
      return token === word || (edits > 0 && Math.abs(token.length - word.length) <= edits && editDistance(token, word) <= edits);
    };
    const candidates: Artist[] = [];
    const rows = this.#db
      .prepare('SELECT a.id, a.name, a.key, count(at.track_id) AS songs FROM artists a JOIN artist_tracks at ON at.artist_id = a.id GROUP BY a.id')
      .all();
    for (const row of rows) {
      const words = String(row.key).split(' ');
      const whole = words.length === tokens.length && tokens.every((token, i) => close(token, words[i]!));
      // One word can be the name an artist goes by: "shwekey" for Yaakov Shwekey, "lipa" for Lipa Schmeltzer.
      const known = tokens.length === 1 && words.length >= 2 && (tokens[0] === words.at(-1) || tokens[0] === words[0]) && Number(row.songs) >= 3;
      if (whole || known) candidates.push({ id: Number(row.id), name: String(row.name), songs: Number(row.songs) });
    }
    candidates.sort((a, b) => b.songs - a.songs);
    const [first, second] = candidates;
    // An artist on clearly more songs than any other match wins (a one-song credit "Shwekey" loses to Yaakov
    // Shwekey); otherwise the exact name, if there is one; otherwise it's too ambiguous to guess.
    if (first && (!second || first.songs >= second.songs * 2) && (!exact || first.songs >= exact.songs * 2)) return first;
    if (exact || tokens.length < 2) return exact;

    // A whole name spelled the way it's said rather than the way the site writes it ("avrohom fried" for Avraham
    // Fried): each word a couple of letters off at most (never a word inside another), when one artist clearly fits.
    const near = (token: string, word: string): boolean =>
      token === word || (!word.includes(token) && !token.includes(word) && editDistance(token, word) <= correctableEdits(token.length));
    const loose: Artist[] = [];
    for (const row of rows) {
      const words = String(row.key).split(' ');
      if (words.length === tokens.length && tokens.every((token, i) => near(token, words[i]!))) {
        loose.push({ id: Number(row.id), name: String(row.name), songs: Number(row.songs) });
      }
    }
    loose.sort((a, b) => b.songs - a.songs);
    const [best, next] = loose;
    return best && (!next || best.songs >= next.songs * 2) ? best : undefined;
  }

  /** An artist's releases, newest first: each single song, and each album as one entry. */
  artistSongs(artistId: number, limit: number, offset = 0): ListedTrack[] {
    return this.#db
      .prepare(
        `SELECT t.id, t.title, t.artist, t.url, t.cover, e.released, t.post, p.title AS post_title, p.audio_files
           FROM (SELECT coalesce(t.post, 'track:' || t.id) AS entry, min(t.id) AS first_id, max(t.released_at) AS released
                   FROM artist_tracks at JOIN tracks t ON t.id = at.track_id
                  WHERE at.artist_id = ? GROUP BY entry) e
           JOIN tracks t ON t.id = e.first_id
           LEFT JOIN site_posts p ON p.slug = t.post
          ORDER BY e.released IS NULL, e.released DESC, e.first_id DESC LIMIT ? OFFSET ?`,
      )
      .all(artistId, limit, offset)
      .map((row) => this.#listed(row, row.released));
  }

  /** How many releases (singles, and albums counted once) an artist has. */
  artistReleases(artistId: number): number {
    return Number(
      this.#db
        .prepare('SELECT count(DISTINCT coalesce(t.post, \'track:\' || t.id)) AS n FROM artist_tracks at JOIN tracks t ON t.id = at.track_id WHERE at.artist_id = ?')
        .get(artistId)?.n,
    );
  }

  /** The album a song found on Zemer is on, as far as it is known. */
  albumOf(url: string): TrackAlbum | undefined {
    return parseAlbum(this.#db.prepare('SELECT album FROM tracks WHERE url = ?').get(url)?.album);
  }

  /** What names a song's file: its credit and title, and the post (an album, when it has several songs) it's from. */
  songFacts(url: string): SongFacts | undefined {
    const row = this.#db
      .prepare(
        `SELECT t.title, t.artist, t.url, t.post, t.cover, t.released_at, t.album, p.title AS post_title, p.category, p.cover AS post_cover, p.published_at,
           max(coalesce(p.audio_files, 0), (SELECT count(*) FROM tracks other WHERE other.post = t.post)) AS songs
         FROM tracks t LEFT JOIN site_posts p ON p.slug = t.post WHERE t.url = ?`,
      )
      .get(url);
    if (!row) return undefined;
    const slug = typeof row.post === 'string' && row.post ? row.post : undefined;
    const text = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string' && value !== '');
    const releasedAt = text(row.released_at, row.published_at);
    const cover = text(row.cover, row.post_cover);
    const album = slug ? undefined : parseAlbum(row.album);
    return {
      title: String(row.title),
      artist: String(row.artist),
      url: String(row.url),
      ...(releasedAt ? { releasedAt } : {}),
      ...(cover ? { cover } : {}),
      ...(album ? { album } : {}),
      ...(slug ? { post: { slug, title: String(row.post_title ?? ''), songs: Number(row.songs) || 1, category: String(row.category ?? '') } } : {}),
    };
  }

  /** The songs of one post, in the post's order. */
  postTracks(slug: string): Track[] {
    return this.#db
      .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE post = ? ORDER BY CAST(substr(url, instr(url, '#') + 1) AS INTEGER), id`)
      .all(slug)
      .map(toTrack);
  }

  #listed(row: Record<string, unknown>, released: unknown): ListedTrack {
    const files = Number(row.audio_files) || 0;
    return {
      ...toTrack(row),
      ...(released ? { releasedAt: String(released) } : {}),
      ...(row.views !== undefined && row.views !== null ? { views: Number(row.views) || 0 } : {}),
      ...(row.post ? { post: String(row.post) } : {}),
      ...(row.post && files > 1 && row.post_title ? { album: { title: String(row.post_title), songs: files } } : {}),
    };
  }

  /**
   * What's trending on the site: songs from the last `days` with the most views for their age (a new song with many
   * views beats an older one with a few more). One song per post.
   */
  trendingSongs(now: Date, limit: number, offset = 0, days = 30): ListedTrack[] {
    return this.#postSongs(
      `p.published_at >= ? ORDER BY (p.views * 1.0) / ((julianday(?) - julianday(p.published_at)) + 2) DESC`,
      [new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString(), now.toISOString()],
      limit,
      offset,
    );
  }

  /** The newest songs on the site, one per post. */
  newestSongs(limit: number, offset = 0): ListedTrack[] {
    return this.#postSongs('1 = 1 ORDER BY p.published_at DESC', [], limit, offset);
  }

  #postSongs(where: string, params: string[], limit: number, offset: number): ListedTrack[] {
    return this.#db
      .prepare(
        `SELECT t.id, t.title, t.artist, t.url, t.cover, t.post, p.published_at, p.views, p.title AS post_title, p.audio_files
           FROM site_posts p JOIN tracks t ON t.id = (SELECT min(id) FROM tracks WHERE post = p.slug)
          WHERE p.audio_files > 0 AND ${where} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset)
      .map((row) => this.#listed(row, row.published_at));
  }

  /** A category's releases (one per post, albums as one entry), the most viewed first. */
  categorySongs(categoryId: string, limit: number, offset = 0): ListedTrack[] {
    return this.#postSongs(`(',' || coalesce(p.category_ids, '') || ',') LIKE ? ORDER BY p.views DESC, p.published_at DESC`, [`%,${categoryId},%`], limit, offset);
  }

  /** How many posts are known to be in a category, with MP3s or not. */
  categoryPosts(categoryId: string): number {
    return Number(this.#db.prepare("SELECT count(*) AS n FROM site_posts WHERE (',' || coalesce(category_ids, '') || ',') LIKE ?").get(`%,${categoryId},%`)?.n);
  }

  // --- artists you follow: new songs by them are sent as soon as they're out ---

  /** Follows an artist. A follow you set yourself replaces one made from your plays, and undoes an unfollow. */
  follow(artistId: number, auto = false, now: Date = new Date()): void {
    this.#db
      .prepare(
        `INSERT INTO follows (artist_id, following, auto, since) VALUES (?, 1, ?, ?)
         ON CONFLICT (artist_id) DO UPDATE SET following = 1, auto = excluded.auto, since = excluded.since`,
      )
      .run(artistId, auto ? 1 : 0, now.toISOString());
  }

  /** Stops following, and remembers it, so your plays won't follow the artist again. */
  unfollow(artistId: number, now: Date = new Date()): void {
    this.#db
      .prepare('INSERT INTO follows (artist_id, following, auto, since) VALUES (?, 0, 0, ?) ON CONFLICT (artist_id) DO UPDATE SET following = 0, auto = 0, since = excluded.since')
      .run(artistId, now.toISOString());
  }

  /** 'on', 'off' (you unfollowed), or nothing yet. */
  followState(artistId: number): 'on' | 'off' | undefined {
    const row = this.#db.prepare('SELECT following FROM follows WHERE artist_id = ?').get(artistId);
    return row ? (Number(row.following) ? 'on' : 'off') : undefined;
  }

  /** The artists you follow, and which of them came from your plays. */
  followed(): Array<Artist & { auto: boolean }> {
    return this.#db
      .prepare(
        `SELECT a.id, a.name, f.auto, (SELECT count(*) FROM artist_tracks at WHERE at.artist_id = a.id) AS songs
           FROM follows f JOIN artists a ON a.id = f.artist_id WHERE f.following = 1 ORDER BY a.name`,
      )
      .all()
      .map((row) => ({ id: Number(row.id), name: String(row.name), songs: Number(row.songs), auto: Boolean(Number(row.auto)) }));
  }

  /** How many different songs by an artist you've had. */
  playedSongsBy(artistId: number): number {
    return Number(
      this.#db.prepare('SELECT count(DISTINCT p.track_id) AS n FROM plays p JOIN artist_tracks at ON at.track_id = p.track_id WHERE at.artist_id = ?').get(artistId)?.n,
    );
  }

  /** The artists credited on a song. */
  trackArtists(trackId: number): Artist[] {
    return this.#db
      .prepare(
        `SELECT a.id, a.name, (SELECT count(*) FROM artist_tracks x WHERE x.artist_id = a.id) AS songs
           FROM artist_tracks at JOIN artists a ON a.id = at.artist_id WHERE at.track_id = ?`,
      )
      .all(trackId)
      .map((row) => ({ id: Number(row.id), name: String(row.name), songs: Number(row.songs) }));
  }

  /**
   * Posts with music, published and first seen since `since`, not alerted yet, by an artist you follow and seen after
   * you started following them, none of whose songs you've had already; newest first.
   */
  postsToAlert(since: Date): Array<SitePost & { artists: string[] }> {
    return this.#db
      .prepare(
        `SELECT p.*, json_group_array(DISTINCT a.name) AS artist_names
           FROM site_posts p
           JOIN tracks t ON t.post = p.slug
           JOIN artist_tracks at ON at.track_id = t.id
           JOIN follows f ON f.artist_id = at.artist_id AND f.following = 1 AND p.first_seen_at >= f.since
           JOIN artists a ON a.id = at.artist_id
          WHERE p.audio_files > 0 AND p.alerted_at IS NULL AND p.first_seen_at >= ? AND p.published_at >= ?
            AND NOT EXISTS (SELECT 1 FROM plays pl JOIN tracks played ON played.id = pl.track_id WHERE played.post = p.slug)
          GROUP BY p.slug ORDER BY p.published_at DESC`,
      )
      .all(since.toISOString(), since.toISOString())
      .map((row) => ({ ...toSitePost(row), artists: (JSON.parse(String(row.artist_names ?? '[]')) as unknown[]).map(String) }));
  }

  markAlerted(slugs: string[], at: Date = new Date()): void {
    const mark = this.#db.prepare('UPDATE site_posts SET alerted_at = ? WHERE slug = ?');
    for (const slug of slugs) mark.run(at.toISOString(), slug);
  }

  // --- Zemer's new releases: the feed of its latest releases, kept up to date by the sync ---

  /** Records a release, or refreshes what may change in it (title, picture, date, size). Says whether it was new here. */
  saveRelease(release: Omit<NewRelease, 'firstSeenAt' | 'announcedAt' | 'alertedAt'>, now: Date = new Date()): { isNew: boolean } {
    const known = this.#db.prepare('SELECT 1 FROM zemer_releases WHERE id = ?').get(release.id) !== undefined;
    this.#db
      .prepare(
        `INSERT INTO zemer_releases (id, title, artist, artist_id, cover, released_at, songs, video_id, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           title = excluded.title,
           artist = excluded.artist,
           artist_id = excluded.artist_id,
           cover = coalesce(excluded.cover, cover),
           released_at = excluded.released_at,
           songs = excluded.songs,
           video_id = coalesce(excluded.video_id, video_id)`,
      )
      .run(release.id, release.title, release.artist, release.artistId, release.cover ?? null, release.releasedAt, release.songs, release.videoId ?? null, now.toISOString());
    return { isNew: !known };
  }

  /** Every release kept, newest first. */
  releases(): NewRelease[] {
    return this.#db.prepare('SELECT * FROM zemer_releases ORDER BY released_at DESC, id').all().map(toRelease);
  }

  /** Forgets the releases that came out before `before` (the feed holds only a couple of weeks). Says how many. */
  pruneReleases(before: Date): number {
    return Number(this.#db.prepare('DELETE FROM zemer_releases WHERE released_at < ?').run(before.toISOString()).changes);
  }

  markReleasesAnnounced(ids: string[], at: Date = new Date()): void {
    const mark = this.#db.prepare('UPDATE zemer_releases SET announced_at = ? WHERE id = ?');
    for (const id of ids) mark.run(at.toISOString(), id);
  }

  markReleasesAlerted(ids: string[], at: Date = new Date()): void {
    const mark = this.#db.prepare('UPDATE zemer_releases SET alerted_at = ? WHERE id = ?');
    for (const id of ids) mark.run(at.toISOString(), id);
  }

  /** Releases that came out and were first seen since `since` and have not been alerted yet, newest first. */
  unalertedReleases(since: Date): NewRelease[] {
    return this.#db
      .prepare('SELECT * FROM zemer_releases WHERE alerted_at IS NULL AND first_seen_at >= ? AND released_at >= ? ORDER BY released_at DESC, id')
      .all(since.toISOString(), since.toISOString())
      .map(toRelease);
  }

  /** The artists you follow, as they are compared (their key), with when each follow began. */
  followedSince(): Array<{ key: string; name: string; since: string }> {
    return this.#db
      .prepare('SELECT a.key, a.name, f.since FROM follows f JOIN artists a ON a.id = f.artist_id WHERE f.following = 1')
      .all()
      .map((row) => ({ key: String(row.key), name: String(row.name), since: String(row.since) }));
  }

  /** Whether you've had a song of this release already (a song is on a release once Zemer has opened it). */
  releaseHad(id: string): boolean {
    return this.#db.prepare("SELECT 1 FROM plays p JOIN tracks t ON t.id = p.track_id WHERE json_extract(t.album, '$.id') = ? LIMIT 1").get(id) !== undefined;
  }

  artistName(artistId: number): string | undefined {
    const row = this.#db.prepare('SELECT name FROM artists WHERE id = ?').get(artistId);
    return row ? String(row.name) : undefined;
  }

  artistCount(): number {
    return Number(this.#db.prepare('SELECT count(*) AS n FROM artists').get()?.n);
  }

  // --- messages that stand for one song (a 👍 on one sends it) ---

  linkMessage(messageId: string, postback: string, at: Date = new Date()): void {
    this.#db
      .prepare('INSERT INTO message_links (message_id, postback, at) VALUES (?, ?, ?) ON CONFLICT (message_id) DO UPDATE SET postback = excluded.postback, at = excluded.at')
      .run(messageId, postback, at.toISOString());
    // A month of them is plenty.
    this.#db.prepare('DELETE FROM message_links WHERE at < ?').run(new Date(at.getTime() - 31 * 24 * 60 * 60_000).toISOString());
  }

  linkedPostback(messageId: string): string | undefined {
    const row = this.#db.prepare('SELECT postback FROM message_links WHERE message_id = ?').get(messageId);
    return row ? String(row.postback) : undefined;
  }

  // --- the chat's menus and pages (see views.ts) ---

  /** A new view; old ones (unused for a month, or past the newest 300) are cleared out first. */
  openView(key: ViewKey, parent: number | undefined, at: Date = new Date()): View {
    this.#db.prepare('DELETE FROM views WHERE used_at < ?').run(new Date(at.getTime() - VIEW_DAYS * 24 * 60 * 60_000).toISOString());
    this.#db.prepare('DELETE FROM views WHERE id NOT IN (SELECT id FROM views ORDER BY id DESC LIMIT ?)').run(VIEWS_KEPT - 1);
    const result = this.#db
      .prepare('INSERT INTO views (parent, kind, key, shown, at, used_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(parent ?? null, key.kind, JSON.stringify(key), '[]', at.toISOString(), at.toISOString());
    return { id: Number(result.lastInsertRowid), ...(parent !== undefined ? { parent } : {}), key, shown: [] };
  }

  view(id: number): View | undefined {
    const row = this.#db.prepare('SELECT * FROM views WHERE id = ?').get(id);
    if (!row) return undefined;
    try {
      const key = JSON.parse(String(row.key)) as ViewKey;
      const shown = JSON.parse(String(row.shown)) as View['shown'];
      if (!key || typeof key !== 'object' || !Array.isArray(shown)) return undefined;
      return {
        id: Number(row.id),
        ...(row.parent !== null && row.parent !== undefined ? { parent: Number(row.parent) } : {}),
        key,
        shown,
        ...(typeof row.last_more === 'string' && row.last_more ? { lastMore: row.last_more as View['lastMore'] } : {}),
      };
    } catch {
      return undefined;
    }
  }

  saveView(view: View, at: Date = new Date()): void {
    this.#db
      .prepare('UPDATE views SET key = ?, shown = ?, last_more = ?, used_at = ? WHERE id = ?')
      .run(JSON.stringify(view.key), JSON.stringify(view.shown), view.lastMore ?? null, at.toISOString(), view.id);
  }

  touchView(id: number, at: Date = new Date()): void {
    this.#db.prepare('UPDATE views SET used_at = ? WHERE id = ?').run(at.toISOString(), id);
  }

  // --- small facts the bot keeps between runs (when the daily message last went out, …) ---

  getState(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM state WHERE key = ?').get(key);
    return row ? String(row.value) : undefined;
  }

  setState(key: string, value: string): void {
    this.#db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // --- the index of song files kept on disk (see library/audio-cache.ts) ---

  cachedAudio(url: string): CachedAudio | undefined {
    const row = this.#db.prepare('SELECT * FROM audio_cache WHERE url = ?').get(url);
    return row ? toCachedAudio(row) : undefined;
  }

  saveCachedAudio(entry: CachedAudio): void {
    this.#db
      .prepare(
        `INSERT INTO audio_cache (url, file, file_name, mime_type, bytes, fetched_at, used_at, replaces, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET file = excluded.file, file_name = excluded.file_name, mime_type = excluded.mime_type,
           bytes = excluded.bytes, fetched_at = excluded.fetched_at, used_at = excluded.used_at, replaces = excluded.replaces,
           tags = excluded.tags`,
      )
      .run(entry.url, entry.file, entry.fileName, entry.mimeType, entry.bytes, entry.fetchedAt, entry.usedAt, entry.replaces ?? null, entry.tags ?? null);
  }

  touchCachedAudio(url: string, at: Date = new Date()): void {
    this.#db.prepare('UPDATE audio_cache SET used_at = ? WHERE url = ?').run(at.toISOString(), url);
  }

  /** Every file kept on disk, least recently used first. */
  listCachedAudio(): CachedAudio[] {
    return this.#db.prepare('SELECT * FROM audio_cache ORDER BY used_at ASC, fetched_at ASC').all().map(toCachedAudio);
  }

  forgetCachedAudio(url: string): void {
    this.#db.prepare('DELETE FROM audio_cache WHERE url = ?').run(url);
  }

  /** Whether this catalog holds nothing a person or the bot has put there: no songs, plays or follows. */
  isEmpty(): boolean {
    return ['tracks', 'plays', 'follows'].every((table) => Number(this.#db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n) === 0);
  }

  /**
   * Copies another catalog file's records into this one, which must be empty: songs, artists, plays, follows, site posts and
   * the bot's small facts (when the daily message last went out, …), keeping their ids so plays and follows still point at
   * the right songs and artists. Left behind: the kept-songs index (those files are on another machine), which messages stand
   * for which songs (they belong to the old chat), and what's wrong or on offer right now (`chat.*`, `health.*`, `matrix.*`).
   * It all happens in one transaction, so a failure leaves this catalog as it was.
   */
  importFrom(path: string): Record<'tracks' | 'artists' | 'plays' | 'follows' | 'posts' | 'state', number> {
    if (!this.isEmpty()) throw new Error('A catalog can only be imported into an empty one');
    // Opening the other file with this class first brings an older one up to the current layout.
    new Catalog(path).close();
    this.#db.prepare('ATTACH DATABASE ? AS imported').run(path);
    try {
      const columnsOf = (schema: string, table: string): string[] =>
        this.#db.prepare(`PRAGMA ${schema}.table_info(${table})`).all().map((column) => String(column.name));
      const copy = (table: string, where = '', verb = 'INSERT'): number => {
        const there = new Set(columnsOf('imported', table));
        const columns = columnsOf('main', table).filter((column) => there.has(column));
        const list = columns.map((column) => `"${column}"`).join(', ');
        return Number(this.#db.prepare(`${verb} INTO main.${table} (${list}) SELECT ${list} FROM imported.${table} ${where}`).run().changes);
      };
      const counts = { tracks: 0, artists: 0, plays: 0, follows: 0, posts: 0, state: 0 };
      this.#db.exec('BEGIN');
      try {
        // Songs before the plays and links that point at them; the full-text index follows by trigger.
        counts.tracks = copy('tracks');
        counts.artists = copy('artists');
        // Any artist links the migration made for the (empty) tracks are replaced by the imported ones.
        this.#db.exec('DELETE FROM artist_tracks');
        copy('artist_tracks');
        counts.plays = copy('plays');
        counts.follows = copy('follows');
        counts.posts = copy('site_posts');
        counts.state = copy('state', "WHERE key NOT LIKE 'chat.%' AND key NOT LIKE 'health.%' AND key NOT LIKE 'matrix.%' AND key NOT LIKE 'instinct.%'", 'INSERT OR REPLACE');
        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
      return counts;
    } finally {
      this.#db.exec('DETACH DATABASE imported');
    }
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * The numbered options on offer, kept in the catalog's database: the bot and the command-line tools share them, and
 * they survive a restart, so "2" means the same thing whoever sent the list.
 */
export function choicesIn(catalog: Pick<Catalog, 'getState' | 'setState'>, key = 'chat.choices'): ChoiceStore {
  return {
    load() {
      const raw = catalog.getState(key);
      if (!raw) return undefined;
      try {
        const value = JSON.parse(raw) as Partial<PendingChoices>;
        return Array.isArray(value.chips) && typeof value.at === 'number' && typeof value.validMs === 'number'
          ? { chips: value.chips, ...(Array.isArray(value.numbers) ? { numbers: value.numbers } : {}), at: value.at, validMs: value.validMs }
          : undefined;
      } catch {
        return undefined;
      }
    },
    save(choices) {
      catalog.setState(key, choices ? JSON.stringify(choices) : '');
    },
  };
}

/**
 * How far the runner got in the chat, kept in the catalog's database so a restart answers what arrived while the bot was
 * down. It lives in the same file as everything else the bot restores after a restart, so the two never disagree.
 */
export function resumeIn(catalog: Pick<Catalog, 'getState' | 'setState'>, key = 'chat.resume'): ResumeStore {
  return {
    load() {
      const raw = catalog.getState(key);
      if (!raw) return undefined;
      try {
        const value = JSON.parse(raw) as Partial<ResumePoint>;
        return typeof value.at === 'number' && Array.isArray(value.ids) ? { at: value.at, ids: value.ids.filter((id): id is string => typeof id === 'string') } : undefined;
      } catch {
        return undefined;
      }
    },
    save(point) {
      catalog.setState(key, JSON.stringify(point));
    },
  };
}

/**
 * The chat's views (menus, artists, albums, lists) and which one is current (state `chat.view`), kept in the catalog's
 * database, so "songs more" and a 👍 on an older menu still work after a restart.
 */
export function viewsIn(catalog: Pick<Catalog, 'openView' | 'view' | 'saveView' | 'touchView' | 'getState' | 'setState'>, key = 'chat.view'): ViewStore {
  return {
    open: (viewKey, parent) => catalog.openView(viewKey, parent),
    get: (id) => catalog.view(id),
    save: (view) => catalog.saveView(view),
    current() {
      const id = Number(catalog.getState(key) || NaN);
      return Number.isInteger(id) ? catalog.view(id) : undefined;
    },
    setCurrent(id) {
      catalog.setState(key, id === undefined ? '' : String(id));
      if (id !== undefined) catalog.touchView(id);
    },
  };
}

/** Which sent messages stand for which song, kept in the catalog's database so a 👍 works across processes and restarts. */
export function linksIn(catalog: Pick<Catalog, 'linkMessage' | 'linkedPostback'>): MessageLinks {
  return {
    link: (messageId, postback) => catalog.linkMessage(messageId, postback),
    lookup: (messageId) => catalog.linkedPostback(messageId),
  };
}
