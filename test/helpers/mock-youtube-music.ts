import { listen, readText, type Listening } from './servers.ts';

/** The songs filter Zemer sends with a search (SearchFilter.FILTER_SONG). */
export const SONG_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
/** And its albums filter (SearchFilter.FILTER_ALBUM). */
export const ALBUM_FILTER = 'EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D';

export interface MockAlbumTrack {
  /** Left out for a song that can't be played (greyed out on the real page): it has no video id. */
  videoId?: string;
  title: string;
  /** Left out for most songs: an album page usually doesn't name them, and they are the album's. */
  artists?: string[];
}

export interface MockAlbum {
  browseId: string;
  title: string;
  artists: string[];
  year?: number;
  tracks: MockAlbumTrack[];
  /** How many songs the page holds before the rest comes by continuation. All of them by default. */
  firstPage?: number;
}

export interface MockSong {
  videoId: string;
  title: string;
  /** Written between "," and "&" the way YouTube Music writes a credit: ["A", "B", "C"] is "A, B & C". */
  artists: string[];
  album?: string;
  /** "5:41" */
  duration?: string;
  /** The AAC bytes the media link serves. */
  bytes?: Buffer;
  /** The player answers, but with no AAC stream (only Opus). */
  opusOnly?: boolean;
  /** The player refuses to play it, with this reason. */
  unplayable?: string;
  /** Where the AAC link points. By default this server's own /media. */
  mediaUrl?: string;
}

export interface MockPlayerCall {
  client: string;
  version: string;
  visitor: string | undefined;
  contextVisitor: string | undefined;
}

export interface MockMediaCall {
  method: string;
  videoId: string;
  userAgent: string | undefined;
  range: string | undefined;
}

export interface MockYouTubeMusic extends Listening {
  /** Every search: the query, the filter and whether a visitor id came along. */
  searches: Array<{ query: string; params: string | undefined; visitor: string | undefined }>;
  playerCalls: MockPlayerCall[];
  mediaCalls: MockMediaCall[];
  /** Every browse request: the album's id, or "continuation". */
  browses: string[];
  /** How many visitor ids were handed out. They are "VISITOR1==", "VISITOR2==", and so on, sent URL-encoded. */
  visitorIds: number;
  /** Visitor ids numbered below this are refused with "confirm you're not a bot". */
  firstAcceptedVisitor: number;
  /** Client versions the player answers with HTTP 400 ("Precondition check failed"), like a retired build. */
  retiredVersions: Set<string>;
  /** The next media requests answered 403, however many are asked. */
  failMedia: number;
  failSearch: boolean;
  bytes(videoId: string): Buffer;
  reset(): void;
}

const SIZE = 4000;

function bytesFor(song: MockSong): Buffer {
  return song.bytes ?? Buffer.alloc(SIZE, song.videoId);
}

/** The channel id the mock gives an artist: what the search links to, and what Zemer's list is keyed by. */
export const artistId = (name: string): string => `UC_${name.replace(/\W+/g, '_')}`;

function joinCredit(artists: string[]): Array<{ text: string; navigationEndpoint?: unknown }> {
  const runs: Array<{ text: string; navigationEndpoint?: unknown }> = [];
  artists.forEach((name, i) => {
    if (i > 0) runs.push({ text: i === artists.length - 1 ? ' & ' : ', ' });
    runs.push({
      text: name,
      navigationEndpoint: { browseEndpoint: { browseId: artistId(name), browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ARTIST' } } } },
    });
  });
  return runs;
}

function row(song: MockSong): unknown {
  const second: Array<{ text: string; navigationEndpoint?: unknown }> = joinCredit(song.artists);
  if (song.album) {
    second.push({ text: ' • ' });
    second.push({
      text: song.album,
      navigationEndpoint: { browseEndpoint: { browseId: `MPRE${song.album}`, browseEndpointContextSupportedConfigs: { browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_ALBUM' } } } },
    });
  }
  if (song.duration) {
    second.push({ text: ' • ' });
    second.push({ text: song.duration });
  }
  return {
    musicResponsiveListItemRenderer: {
      playlistItemData: { videoId: song.videoId },
      thumbnail: {
        musicThumbnailRenderer: {
          thumbnail: {
            thumbnails: [
              { url: `https://yt3.googleusercontent.com/${song.videoId}=w60-h60-l90-rj`, width: 60, height: 60 },
              { url: `https://yt3.googleusercontent.com/${song.videoId}=w120-h120-l90-rj`, width: 120, height: 120 },
            ],
          },
        },
      },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: song.title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: second } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: '26K plays' }] } } },
      ],
    },
  };
}

const AT_A_TIME = 100;

function albumRow(album: MockAlbum): unknown {
  const second: Array<{ text: string; navigationEndpoint?: unknown }> = [{ text: 'Album' }, { text: ' • ' }, ...joinCredit(album.artists)];
  if (album.year) second.push({ text: ' • ' }, { text: String(album.year) });
  return {
    musicResponsiveListItemRenderer: {
      navigationEndpoint: { browseEndpoint: { browseId: album.browseId } },
      thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: `https://lh3.googleusercontent.com/${album.browseId}=w60-h60-l90-rj` }, { url: `https://lh3.googleusercontent.com/${album.browseId}=w120-h120-l90-rj` }] } } },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: album.title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: second } } },
      ],
    },
  };
}

function trackRow(track: MockAlbumTrack, number: number): unknown {
  return {
    musicResponsiveListItemRenderer: {
      ...(track.videoId ? { playlistItemData: { videoId: track.videoId } } : {}),
      index: { runs: [{ text: String(number) }] },
      flexColumns: [
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: track.title }] } } },
        { musicResponsiveListItemFlexColumnRenderer: track.artists ? { text: { runs: joinCredit(track.artists) } } : {} },
        { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: '27K plays' }] } } },
      ],
      fixedColumns: [{ musicResponsiveListItemFixedColumnRenderer: { text: { runs: [{ text: '3:05' }] } } }],
    },
  };
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * A stand-in for music.youtube.com's InnerTube API and the media servers behind it, shaped like the real answers
 * (and as strict about them as the real thing was in October 2026): a player request without a good visitor id is
 * refused as a bot check, a retired client version is HTTP 400, and a media link answers 403 unless the request carries
 * the client's own User-Agent and a Range header.
 */
export async function startMockYouTubeMusic(songs: MockSong[], albums: MockAlbum[] = []): Promise<MockYouTubeMusic> {
  const byId = new Map(songs.map((song) => [song.videoId, song]));
  let origin = '';

  const mock: MockYouTubeMusic = {
    url: '',
    server: undefined as never,
    close: async () => {},
    searches: [],
    playerCalls: [],
    mediaCalls: [],
    browses: [],
    visitorIds: 0,
    firstAcceptedVisitor: 1,
    retiredVersions: new Set(),
    failMedia: 0,
    failSearch: false,
    bytes: (videoId) => bytesFor(byId.get(videoId)!),
    reset() {
      mock.searches = [];
      mock.playerCalls = [];
      mock.mediaCalls = [];
      mock.browses = [];
      mock.visitorIds = 0;
      mock.firstAcceptedVisitor = 1;
      mock.retiredVersions = new Set();
      mock.failMedia = 0;
      mock.failSearch = false;
    },
  };

  const server = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const [, , videoId] = url.pathname.split('/');
      const song = byId.get(videoId ?? '');
      const ua = req.headers['user-agent'];
      const range = req.headers.range;
      mock.mediaCalls.push({ method: 'GET', videoId: videoId ?? '', userAgent: ua, range });
      if (!song || !/Macintosh/.test(ua ?? '') || !range) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return void res.end('403');
      }
      if (mock.failMedia > 0) {
        mock.failMedia -= 1;
        res.writeHead(403, { 'content-type': 'text/plain' });
        return void res.end('403');
      }
      const data = bytesFor(song);
      res.writeHead(206, { 'content-type': 'audio/mp4', 'content-length': data.length, 'content-range': `bytes 0-${data.length - 1}/${data.length}` });
      return void res.end(data);
    }

    if (req.method !== 'POST' || !url.pathname.startsWith('/youtubei/v1/')) return json(404, { error: 'not found' });
    const body = JSON.parse((await readText(req)) || '{}') as Record<string, any>;
    const endpoint = url.pathname.slice('/youtubei/v1/'.length);

    if (endpoint === 'visitor_id') {
      mock.visitorIds += 1;
      return json(200, { responseContext: { visitorData: encodeURIComponent(`VISITOR${mock.visitorIds}==`) } });
    }

    if (endpoint === 'search') {
      mock.searches.push({ query: body.query, params: body.params, visitor: req.headers['x-goog-visitor-id'] as string | undefined });
      if (mock.failSearch) return json(500, { error: 'boom' });
      const wanted = words(String(body.query ?? ''));
      if (body.params === ALBUM_FILTER) {
        const matching = albums.filter((album) => {
          const text = words(`${album.title} ${album.artists.join(' ')}`);
          return wanted.some((word) => text.some((have) => have.startsWith(word)));
        });
        return json(200, {
          responseContext: {},
          contents: { tabbedSearchResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: matching.map(albumRow) } }] } } } }] } },
        });
      }
      const found = songs.filter((song) => {
        const text = words(`${song.title} ${song.artists.join(' ')}`);
        return wanted.some((word) => text.some((have) => have.startsWith(word)));
      });
      return json(200, {
        responseContext: {},
        contents: {
          tabbedSearchResultsRenderer: {
            tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: found.map(row) } }] } } } }],
          },
        },
      });
    }

    if (endpoint === 'browse') {
      const continuation = typeof body.continuation === 'string' ? /^CONT:(.+):(\d+)$/.exec(body.continuation) : null;
      if (continuation) {
        mock.browses.push('continuation');
        const album = albums.find((candidate) => candidate.browseId === continuation[1]);
        const from = Number(continuation[2]);
        const rows = (album?.tracks ?? []).slice(from, from + AT_A_TIME).map((track, i) => trackRow(track, from + i + 1));
        const next = from + AT_A_TIME < (album?.tracks.length ?? 0) ? [{ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: `CONT:${album!.browseId}:${from + AT_A_TIME}` } } } }] : [];
        return json(200, { onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: [...rows, ...next] } }] });
      }
      mock.browses.push(String(body.browseId));
      const album = albums.find((candidate) => candidate.browseId === body.browseId);
      if (!album) return json(404, { error: { code: 404, message: 'not found' } });
      const first = album.firstPage ?? album.tracks.length;
      const rows = album.tracks.slice(0, first).map((track, i) => trackRow(track, i + 1));
      if (first < album.tracks.length) rows.push({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: `CONT:${album.browseId}:${first}` } } } });
      return json(200, {
        responseContext: {},
        microformat: { microformatDataRenderer: { urlCanonical: `https://music.youtube.com/playlist?list=OLAK5uy_${album.browseId}` } },
        contents: {
          twoColumnBrowseResultsRenderer: {
            tabs: [
              {
                tabRenderer: {
                  content: {
                    sectionListRenderer: {
                      contents: [
                        {
                          musicResponsiveHeaderRenderer: {
                            title: { runs: [{ text: album.title }] },
                            straplineTextOne: { runs: joinCredit(album.artists) },
                            subtitle: { runs: [{ text: 'Album' }, { text: ' • ' }, ...(album.year ? [{ text: String(album.year) }] : [])] },
                            thumbnail: { musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: `https://lh3.googleusercontent.com/${album.browseId}=w226-h226-l90-rj` }, { url: `https://lh3.googleusercontent.com/${album.browseId}=w544-h544-l90-rj` }] } } },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            ],
            secondaryContents: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: rows } }] } },
          },
        },
      });
    }

    if (endpoint === 'player') {
      const client = body.context?.client ?? {};
      const visitor = req.headers['x-goog-visitor-id'] as string | undefined;
      mock.playerCalls.push({ client: client.clientName, version: client.clientVersion, visitor, contextVisitor: client.visitorData });
      if (client.clientName !== 'VISIONOS' || mock.retiredVersions.has(client.clientVersion)) {
        return json(400, { error: { code: 400, message: 'Precondition check failed.', status: 'FAILED_PRECONDITION' } });
      }
      const issued = /^VISITOR(\d+)==$/.exec(visitor ?? '')?.[1];
      if (!issued || Number(issued) < mock.firstAcceptedVisitor || client.visitorData !== visitor) {
        return json(200, { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } });
      }
      const song = byId.get(body.videoId);
      if (!song) return json(200, { playabilityStatus: { status: 'ERROR', reason: 'This video is unavailable' } });
      if (song.unplayable) return json(200, { playabilityStatus: { status: 'UNPLAYABLE', reason: song.unplayable } });
      const size = bytesFor(song).length;
      const link = (itag: number) => song.mediaUrl ?? `${origin}/media/${song.videoId}/${itag}`;
      const aac = song.opusOnly
        ? []
        : [
            { itag: 139, mimeType: 'audio/mp4; codecs="mp4a.40.5"', bitrate: 50_415, contentLength: String(Math.floor(size / 3)), approxDurationMs: '340805', url: link(139) },
            { itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 132_099, contentLength: String(size), approxDurationMs: '340805', url: link(140) },
          ];
      return json(200, {
        playabilityStatus: { status: 'OK', playableInEmbed: true },
        streamingData: {
          expiresInSeconds: '21540',
          adaptiveFormats: [
            ...aac,
            // Opus has the highest bitrate of all, and must still lose to AAC.
            { itag: 251, mimeType: 'audio/webm; codecs="opus"', bitrate: 140_000, contentLength: String(size * 2), approxDurationMs: '340805', url: link(251) },
            { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4_000_000, width: 1920, height: 1080, contentLength: '99999999', url: link(137) },
          ],
        },
        videoDetails: { videoId: song.videoId, title: song.title },
      });
    }

    return json(404, { error: 'unknown endpoint' });
  });

  origin = server.url;
  mock.url = server.url;
  mock.server = server.server;
  mock.close = server.close;
  return mock;
}
