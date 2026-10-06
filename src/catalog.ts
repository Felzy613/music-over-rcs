import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { artistKey, splitArtists } from './artists.ts';
import { parseQuery } from './query.ts';
import { allowedEdits, editDistance } from './sources/relevance.ts';
import type { ChoiceStore, MessageLinks, PendingChoices } from './runner.ts';
import type { Track } from './types.ts';

export interface NewTrack {
  title: string;
  artist?: string;
  url: string;
  /** A picture for the song (album art). Left as it was when not given. */
  cover?: string | undefined;
  /** The music-table.com post it comes from, and when that was published (ISO). */
  post?: string | undefined;
  releasedAt?: string | undefined;
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
}

/** A song file kept on disk so it can be sent without downloading it first. */
export interface CachedAudio {
  url: string;
  /** The file's name inside the cache folder. */
  file: string;
  fileName: string;
  mimeType: string;
  bytes: number;
  fetchedAt: string;
  usedAt: string;
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
  CREATE TABLE IF NOT EXISTS message_links (
    message_id TEXT PRIMARY KEY,
    postback   TEXT NOT NULL,
    at         TEXT NOT NULL
  );
`;

const TRACK_COLUMNS = 'id, title, artist, url, cover';

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
});

const toCachedAudio = (row: Record<string, unknown>): CachedAudio => ({
  url: String(row.url),
  file: String(row.file),
  fileName: String(row.file_name),
  mimeType: String(row.mime_type),
  bytes: Number(row.bytes) || 0,
  fetchedAt: String(row.fetched_at),
  usedAt: String(row.used_at),
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
    this.#db.exec('CREATE INDEX IF NOT EXISTS tracks_by_post ON tracks (post)');
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
        `INSERT INTO tracks (title, artist, url, cover, post, released_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET title = excluded.title, artist = excluded.artist, cover = coalesce(excluded.cover, cover),
           post = coalesce(excluded.post, post), released_at = coalesce(excluded.released_at, released_at)
         RETURNING ${TRACK_COLUMNS}`,
      )
      .get(title, artist, url, cover, input.post ?? null, input.releasedAt ?? null);
    const track = toTrack(row!);
    this.#linkArtists(track.id, artist);
    return track;
  }

  get(id: number): Track | undefined {
    const row = this.#db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`).get(id);
    return row ? toTrack(row) : undefined;
  }

  byUrl(url: string): Track | undefined {
    const row = this.#db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE url = ?`).get(url);
    return row ? toTrack(row) : undefined;
  }

  /** Full-text search: every word must match the start of a word in the title or artist. */
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
    return rows.map(toTrack);
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
  savePost(post: Omit<SitePost, 'firstSeenAt' | 'announcedAt'>, now: Date = new Date()): { isNew: boolean } {
    const known = this.#db.prepare('SELECT 1 FROM site_posts WHERE slug = ?').get(post.slug) !== undefined;
    this.#db
      .prepare(
        `INSERT INTO site_posts (slug, title, category, published_at, views, cover, audio_files, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (slug) DO UPDATE SET
           title = excluded.title,
           category = CASE WHEN excluded.category = '' THEN category ELSE excluded.category END,
           published_at = excluded.published_at,
           views = max(views, excluded.views),
           cover = coalesce(excluded.cover, cover),
           audio_files = excluded.audio_files`,
      )
      .run(post.slug, post.title, post.category, post.publishedAt, post.views, post.cover ?? null, post.audioFiles, now.toISOString());
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
    return exact;
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
        `INSERT INTO audio_cache (url, file, file_name, mime_type, bytes, fetched_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET file = excluded.file, file_name = excluded.file_name, mime_type = excluded.mime_type,
           bytes = excluded.bytes, fetched_at = excluded.fetched_at, used_at = excluded.used_at`,
      )
      .run(entry.url, entry.file, entry.fileName, entry.mimeType, entry.bytes, entry.fetchedAt, entry.usedAt);
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
          ? { chips: value.chips, at: value.at, validMs: value.validMs }
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

/** Which sent messages stand for which song, kept in the catalog's database so a 👍 works across processes and restarts. */
export function linksIn(catalog: Pick<Catalog, 'linkMessage' | 'linkedPostback'>): MessageLinks {
  return {
    link: (messageId, postback) => catalog.linkMessage(messageId, postback),
    lookup: (messageId) => catalog.linkedPostback(messageId),
  };
}
