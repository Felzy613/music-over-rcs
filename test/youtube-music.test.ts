import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { checkAudio } from '../src/audio-check.ts';
import { AudioFetchError, fetchAudio } from '../src/audio-fetch.ts';
import { createBot, SourceError, type TrackSource } from '../src/bot.ts';
import { Catalog } from '../src/catalog.ts';
import { MatrixClient } from '../src/matrix/client.ts';
import { createRunner } from '../src/runner.ts';
import { MusicTable } from '../src/sources/music-table.ts';
import { combineSources, songSourceOrder, songSources } from '../src/sources/songs.ts';
import {
  createYouTubeMusicSource,
  gatedAudioCheck,
  parseSearch,
  resolvingYouTubeAudio,
  YouTubeMusic,
  TURNED_AWAY,
  YouTubeMusicError,
  youTubeGate,
  youTubeMusicFromEnv,
  type RelayedSong,
  type SongRelay,
} from '../src/sources/youtube-music.ts';
import { ZemerWhitelist, ZemerWhitelistError, zemerWhitelistFromEnv } from '../src/sources/zemer-whitelist.ts';
import type { Reply, Track } from '../src/types.ts';
import { startMockMatrix, type MockMatrix } from './helpers/mock-matrix.ts';
import { startMockZemerContent, type MockArtist, type MockZemerContent } from './helpers/mock-zemer-content.ts';
import { artistId, SONG_FILTER, startMockYouTubeMusic, type MockSong, type MockYouTubeMusic } from './helpers/mock-youtube-music.ts';

const SONGS: MockSong[] = [
  { videoId: 'TqV3lHjPLBA', title: 'הנחת תפילין', artists: ['Lipa Schmeltzer', 'Shmueli Ungar', 'Michoel Schnitzler', 'Levy Falkowitz'], album: 'רצועות', duration: '5:41' },
  { videoId: 'cn0QDLjEVDw', title: 'Baalei Teshuva', artists: ['Michoel Schnitzler'], album: 'Di Neshuma Flam', duration: '9:46' },
  { videoId: 'aaaaaaaaaa1', title: 'Blue Horizon', artists: ['The Night Owls'], duration: '3:05' },
  { videoId: 'aaaaaaaaaa2', title: 'Blue Horizon (Live)', artists: ['The Night Owls'], duration: '4:10' },
  { videoId: 'bbbbbbbbbb1', title: 'Quiet Song', artists: ['Mira Vale'], opusOnly: true },
  { videoId: 'cccccccccc1', title: 'Locked Song', artists: ['Mira Vale'], unplayable: 'This video is not available in your country' },
  { videoId: 'dddddddddd1', title: 'Elsewhere Song', artists: ['Mira Vale'], mediaUrl: 'https://evil.example/a.m4a' },
  { videoId: 'eeeeeeeeee1', title: 'Her Song', artists: ['Rina Cohen'], duration: '3:30' },
  { videoId: 'eeeeeeeeee2', title: 'Duet Song', artists: ['The Night Owls', 'Rina Cohen'], duration: '3:40' },
  { videoId: 'eeeeeeeeee3', title: 'Stranger Song', artists: ['Nobody Known'], duration: '2:50' },
  { videoId: 'eeeeeeeeee4', title: 'Hidden Song', artists: ['The Night Owls'], duration: '3:10' },
];

/** What Zemer's list holds in these tests: every artist above except the stranger, with one singer flagged female. */
const LISTED: MockArtist[] = [
  ...['Lipa Schmeltzer', 'Shmueli Ungar', 'Michoel Schnitzler', 'Levy Falkowitz', 'The Night Owls', 'Mira Vale'].map((name) => ({ id: artistId(name), name })),
  { id: artistId('Rina Cohen'), name: 'Rina Cohen', female: true },
];

/** A place to keep the list between runs, like the catalog's. */
const memory = () => {
  const kept = new Map<string, string>();
  return { kept, getState: (key: string) => kept.get(key), setState: (key: string, value: string) => void kept.set(key, value) };
};

type TextReply = Extract<Reply, { kind: 'text' }>;
function textOf(reply: Reply | undefined): TextReply {
  assert.ok(reply && reply.kind === 'text', 'expected a text reply');
  return reply;
}

describe('YouTube Music search', () => {
  let youtube: MockYouTubeMusic;
  before(async () => {
    youtube = await startMockYouTubeMusic(SONGS);
  });
  after(() => youtube.close());
  beforeEach(() => youtube.reset());

  const make = () => new YouTubeMusic({ baseUrl: youtube.url });

  test('asks for songs only, as Zemer does, and sends no visitor id with the search', async () => {
    await make().search('blue horizon');
    assert.deepEqual(youtube.searches, [{ query: 'blue horizon', params: SONG_FILTER, visitor: undefined }]);
  });

  test('reads the title, the credit, the album, the length and a larger cover from each row', async () => {
    const hits = await make().search('lipa');
    assert.deepEqual(hits, [
      {
        videoId: 'TqV3lHjPLBA',
        title: 'הנחת תפילין',
        artist: 'Lipa Schmeltzer, Shmueli Ungar, Michoel Schnitzler & Levy Falkowitz',
        artistIds: ['Lipa Schmeltzer', 'Shmueli Ungar', 'Michoel Schnitzler', 'Levy Falkowitz'].map(artistId),
        album: 'רצועות',
        durationSeconds: 341,
        cover: 'https://yt3.googleusercontent.com/TqV3lHjPLBA=w544-h544-l90-rj',
      },
    ]);
    const single = (await make().search('blue horizon owls')).find((hit) => hit.videoId === 'aaaaaaaaaa1');
    assert.equal(single?.artist, 'The Night Owls');
    assert.deepEqual(single?.artistIds, [artistId('The Night Owls')]);
    assert.equal(single?.album, undefined);
    assert.equal(single?.durationSeconds, 185);
  });

  test('skips rows that are not songs, repeats, and a response with nothing in it', () => {
    const row = (videoId: string | undefined) => ({
      musicResponsiveListItemRenderer: {
        ...(videoId ? { playlistItemData: { videoId } } : {}),
        flexColumns: [{ musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: 'A song' }] } } }],
      },
    });
    const response = {
      contents: {
        tabbedSearchResultsRenderer: {
          tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ musicShelfRenderer: { contents: [row('abcdefghijk'), row('abcdefghijk'), row(undefined), row('short'), { notASong: 1 }] } }] } } } }],
        },
      },
    };
    assert.deepEqual(parseSearch(response).map((hit) => hit.videoId), ['abcdefghijk']);
    assert.deepEqual(parseSearch({}), []);
    assert.deepEqual(parseSearch(null), []);
  });

  test('says plainly when YouTube Music cannot be reached or answers with an error', async () => {
    youtube.failSearch = true;
    await assert.rejects(make().search('anything'), (err) => err instanceof YouTubeMusicError && err instanceof SourceError && err.message === 'YouTube Music answered HTTP 500');
    const nobody = new YouTubeMusic({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    await assert.rejects(nobody.search('anything'), /didn't answer/);
  });

  test('trackUrl and parseTrackUrl round-trip, and recognize nothing else', () => {
    const youTube = make();
    const url = youTube.trackUrl('TqV3lHjPLBA');
    assert.equal(url, `${youtube.url}/watch?v=TqV3lHjPLBA`);
    assert.equal(youTube.parseTrackUrl(url), 'TqV3lHjPLBA');
    for (const other of ['https://www.music-table.com/post/a#0', `${youtube.url}/watch?v=short`, `${youtube.url}/playlist?v=TqV3lHjPLBA`, 'https://example.test/watch?v=TqV3lHjPLBA', 'nonsense']) {
      assert.equal(youTube.parseTrackUrl(other), undefined, other);
    }
  });
});

describe('YouTube Music streams', () => {
  let youtube: MockYouTubeMusic;
  before(async () => {
    youtube = await startMockYouTubeMusic(SONGS);
  });
  after(() => youtube.close());
  beforeEach(() => youtube.reset());

  const make = (options: { now?: () => number } = {}) => new YouTubeMusic({ baseUrl: youtube.url, ...options });

  test('starts a session first, sends its id plain, and picks the AAC audio even though Opus has a higher bitrate', async () => {
    const stream = await make().stream('aaaaaaaaaa1');
    assert.equal(youtube.visitorIds, 1);
    assert.deepEqual(youtube.playerCalls, [{ client: 'VISIONOS', version: '1.02', visitor: 'VISITOR1==', contextVisitor: 'VISITOR1==' }]);
    assert.equal(stream.url, `${youtube.url}/media/aaaaaaaaaa1/140`);
    assert.equal(stream.type, 'audio/mp4');
    assert.equal(stream.bytes, youtube.bytes('aaaaaaaaaa1').length);
    assert.equal(stream.durationMs, 340805);
    assert.match(stream.userAgent, /Macintosh/);
  });

  test('reuses the link for a while and the session for good, and asks again when the link is old', async () => {
    let clock = 1_000_000;
    const youTube = make({ now: () => clock });
    await youTube.stream('aaaaaaaaaa1');
    await youTube.stream('aaaaaaaaaa1');
    await youTube.inspect(youTube.trackUrl('aaaaaaaaaa1'));
    assert.equal(youtube.playerCalls.length, 1, 'checking and sending a song asks YouTube once');
    await youTube.stream('aaaaaaaaaa2');
    assert.equal(youtube.visitorIds, 1, 'one session serves every song');
    clock += 31 * 60_000;
    await youTube.stream('aaaaaaaaaa1');
    assert.equal(youtube.playerCalls.length, 3);
  });

  test('two asks for the same song at once make one request', async () => {
    const youTube = make();
    await Promise.all([youTube.stream('aaaaaaaaaa1'), youTube.stream('aaaaaaaaaa1')]);
    assert.equal(youtube.playerCalls.length, 1);
  });

  test('goes on to the next client version when one has been retired', async () => {
    youtube.retiredVersions = new Set(['1.02', '1.03']);
    const stream = await make().stream('aaaaaaaaaa1');
    assert.deepEqual(youtube.playerCalls.map((call) => call.version), ['1.02', '1.03', '1.01']);
    assert.equal(stream.bytes, youtube.bytes('aaaaaaaaaa1').length);
  });

  test('says so when every client version has been retired', async () => {
    youtube.retiredVersions = new Set(['1.02', '1.03', '1.01']);
    await assert.rejects(make().stream('aaaaaaaaaa1'), (err) => err instanceof YouTubeMusicError && /wouldn't give me that song \(YouTube Music answered HTTP 400\)/.test(err.message));
  });

  test('gets a new session once when the first is refused as a bot check', async () => {
    youtube.firstAcceptedVisitor = 2;
    const stream = await make().stream('aaaaaaaaaa1');
    assert.equal(youtube.visitorIds, 2);
    assert.equal(stream.bytes, youtube.bytes('aaaaaaaaaa1').length);

    youtube.reset();
    youtube.firstAcceptedVisitor = 99;
    await assert.rejects(make().stream('aaaaaaaaaa1'), (err) => err instanceof YouTubeMusicError && err.message === TURNED_AWAY);
    assert.equal(youtube.visitorIds, 2, 'it tries a fresh session once, not forever');
  });

  describe('when YouTube turns this host away with its bot check (as it does many datacenter addresses)', () => {
    test('YouTube songs are left aside for a while: no more asking, and it says why at once', async () => {
      youtube.firstAcceptedVisitor = 99;
      let clock = 1_000_000;
      const lines: string[] = [];
      const youTube = new YouTubeMusic({ baseUrl: youtube.url, now: () => clock, log: (line) => lines.push(line) });
      await assert.rejects(youTube.stream('aaaaaaaaaa1'), new RegExp(TURNED_AWAY.replace(/[()]/g, '\\$&')));
      assert.equal(youTube.turnsThisHostAway, true);
      assert.ok(lines.some((line) => /turns this host away/.test(line)), lines.join('\n'));
      const asked = youtube.playerCalls.length;
      await assert.rejects(youTube.stream('aaaaaaaaaa2'), (err) => err instanceof YouTubeMusicError && err.message === TURNED_AWAY);
      assert.equal(youtube.playerCalls.length, asked, 'not asked again while it turns this host away');

      // After the window it is asked again, and if YouTube has relented, songs come back.
      youtube.firstAcceptedVisitor = 1;
      clock += 16 * 60_000;
      assert.equal(youTube.turnsThisHostAway, false);
      assert.equal((await youTube.stream('aaaaaaaaaa1')).bytes, youtube.bytes('aaaaaaaaaa1').length);
    });

    test('one song YouTube won’t play (another reason) does not turn YouTube songs aside', async () => {
      const youTube = make();
      await assert.rejects(youTube.stream('cccccccccc1'), /not available in your country/);
      assert.equal(youTube.turnsThisHostAway, false);
    });

    test('the start-up check says in the log whether songs can be had from this host', async () => {
      const lines: string[] = [];
      const good = new YouTubeMusic({ baseUrl: youtube.url, log: (line) => lines.push(line) });
      // The probe asks for a video the mock doesn't know, so it is refused for that reason: not turned away.
      const first = await good.checkStreams();
      assert.equal(first.ok, false);
      assert.equal(good.turnsThisHostAway, false);
      youtube.firstAcceptedVisitor = 99;
      const turned = new YouTubeMusic({ baseUrl: youtube.url, log: (line) => lines.push(line) });
      assert.deepEqual(await turned.checkStreams(), { ok: false, problem: TURNED_AWAY });
      assert.equal(turned.turnsThisHostAway, true);
      assert.ok(lines.some((line) => /songs can't be had from this host right now/.test(line)), lines.join('\n'));
    });

    test('a failing search or album page is logged with the reason', async () => {
      youtube.failSearch = true;
      const lines: string[] = [];
      const youTube = new YouTubeMusic({ baseUrl: youtube.url, log: (line) => lines.push(line) });
      await assert.rejects(youTube.search('blue horizon'));
      await assert.rejects(youTube.album('MPREb_doesnotexist'));
      assert.ok(lines.some((line) => /searching "blue horizon" failed: YouTube Music answered HTTP 500/.test(line)), lines.join('\n'));
      assert.ok(lines.some((line) => /opening album MPREb_doesnotexist failed/.test(line)), lines.join('\n'));
    });
  });

  test('passes on why YouTube will not play a song, and says when there is no AAC audio', async () => {
    await assert.rejects(make().stream('cccccccccc1'), /This video is not available in your country/);
    await assert.rejects(make().stream('bbbbbbbbbb1'), /it has no AAC audio/);
    await assert.rejects(make().stream('zzzzzzzzzzz'), /This video is unavailable/);
  });

  test('refuses a media link that does not point at YouTube’s own servers', async () => {
    await assert.rejects(make().stream('dddddddddd1'), /it has no AAC audio/);
  });

  test('downloads with the client’s own User-Agent and a Range header, which the media server insists on', async () => {
    const youTube = make();
    const file = await youTube.download(youTube.trackUrl('aaaaaaaaaa1'), 'The Night Owls — Blue Horizon');
    assert.equal(file.mimeType, 'audio/mp4');
    assert.equal(file.fileName, 'The Night Owls — Blue Horizon.m4a');
    assert.equal(file.bytes, youtube.bytes('aaaaaaaaaa1').length);
    assert.deepEqual(Buffer.from(await file.data.arrayBuffer()), youtube.bytes('aaaaaaaaaa1'));
    const [call] = youtube.mediaCalls;
    assert.match(call?.userAgent ?? '', /Macintosh/);
    assert.equal(call?.range, 'bytes=0-');
  });

  test('replaces a link the media server turns down, once, and then gives up', async () => {
    const youTube = make();
    youtube.failMedia = 1;
    const file = await youTube.download(youTube.trackUrl('aaaaaaaaaa1'));
    assert.equal(file.bytes, youtube.bytes('aaaaaaaaaa1').length);
    assert.equal(youtube.playerCalls.length, 2, 'a new link was asked for');

    youtube.reset();
    youtube.failMedia = 5;
    await assert.rejects(youTube.download(youTube.trackUrl('aaaaaaaaaa2')), (err) => err instanceof AudioFetchError && /HTTP 403/.test(err.message));
    assert.equal(youtube.mediaCalls.length, 2);
  });

  describe('links the media server turns down past the first megabyte', () => {
    // The real ones are about one in seven. A song has to be bigger than the first megabyte to meet the wall.
    const BIG = 'bigsongggg1';
    let big: MockYouTubeMusic;
    before(async () => {
      big = await startMockYouTubeMusic([{ videoId: BIG, title: 'A Long Song', artists: ['The Night Owls'], bytes: Buffer.alloc(2.5 * 1024 * 1024, 7) }]);
    });
    after(() => big.close());
    beforeEach(() => big.reset());

    test('a good link is tried with the very request the download makes, then the whole song downloads', async () => {
      const youTube = new YouTubeMusic({ baseUrl: big.url });
      const file = await youTube.download(youTube.trackUrl(BIG), 'A Long Song');
      assert.equal(file.bytes, 2.5 * 1024 * 1024);
      assert.deepEqual(big.mediaCalls.map((call) => call.range), ['bytes=0-', 'bytes=0-']);
    });

    test('a walled link serves small ranges, so a small probe would not have caught it', async () => {
      big.wallNext = 1;
      const youTube = new YouTubeMusic({ baseUrl: big.url });
      const stream = await youTube.stream(BIG);
      assert.equal(big.playerCalls.length, 2, 'the first link was turned down and a second asked for');
      void stream;
    });

    test('a walled link is not used: the next one is asked for, and the song downloads', async () => {
      big.wallNext = 2;
      const youTube = new YouTubeMusic({ baseUrl: big.url });
      const file = await youTube.download(youTube.trackUrl(BIG), 'A Long Song');
      assert.equal(file.bytes, 2.5 * 1024 * 1024);
      assert.deepEqual(big.playerCalls.map((call) => call.version), ['1.02', '1.03', '1.01'], 'a new link each time, from the next client version');
      assert.equal(big.mediaCalls.length, 4, 'two walled links tried and turned down, then a good one tried and used');
    });

    test('after the client versions are used up it starts again with a fresh session', async () => {
      big.wallNext = 4;
      const youTube = new YouTubeMusic({ baseUrl: big.url });
      await youTube.download(youTube.trackUrl(BIG));
      assert.equal(big.visitorIds, 2, 'a second session was started');
      assert.equal(big.playerCalls.length, 5);
    });

    test('says so, instead of a bare 403, when every link is turned down', async () => {
      big.wallNext = 100;
      const youTube = new YouTubeMusic({ baseUrl: big.url });
      await assert.rejects(youTube.download(youTube.trackUrl(BIG)), (err) => err instanceof YouTubeMusicError && /wouldn't give me that song \(its link was refused\)/.test(err.message));
      assert.ok(big.playerCalls.length <= 9, 'it gives up after a handful of tries');
    });

    test('a song that fits in the first megabyte needs no check', async () => {
      const small = await startMockYouTubeMusic([{ videoId: 'smallsonggg', title: 'Short', artists: ['The Night Owls'] }]);
      try {
        small.wallNext = 5;
        const youTube = new YouTubeMusic({ baseUrl: small.url });
        await youTube.stream('smallsonggg');
        assert.deepEqual(small.mediaCalls, []);
        assert.equal(small.playerCalls.length, 1);
      } finally {
        await small.close();
      }
    });
  });

  test('keeps to the size limit, and only downloads its own songs', async () => {
    const youTube = make();
    await assert.rejects(youTube.download(youTube.trackUrl('aaaaaaaaaa1'), undefined, { maxBytes: 100 }), (err) => err instanceof AudioFetchError && /limit/.test(err.message));
    await assert.rejects(youTube.download('https://example.test/a.mp3'), YouTubeMusicError);
  });
});

describe('looking things up on YouTube Music from the bot', () => {
  let youtube: MockYouTubeMusic;
  let zemer: MockZemerContent;
  before(async () => {
    youtube = await startMockYouTubeMusic(SONGS);
    zemer = await startMockZemerContent(LISTED);
  });
  after(async () => {
    await youtube.close();
    await zemer.close();
  });
  beforeEach(() => {
    youtube.reset();
    zemer.reset(LISTED);
  });

  function setup(catalog = new Catalog(':memory:')) {
    const youTube = new YouTubeMusic({ baseUrl: youtube.url });
    const whitelist = new ZemerWhitelist({ baseUrl: zemer.url, state: catalog, checkEveryMs: 0, retryAfterMs: 0 });
    const notes: string[] = [];
    const source = createYouTubeMusicSource({ youTube, catalog, whitelist, onNote: (note) => notes.push(note) });
    const audio = resolvingYouTubeAudio(youTube, {
      checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }),
      fetchAudio: (url, title) => fetchAudio(url, title),
    });
    // The same wiring as the entry points: the list is checked again when a song is about to be sent.
    const checked = gatedAudioCheck(youTubeGate({ youTube, whitelist, catalog }), audio.checkAudio);
    const bot = createBot({ catalog, checkAudio: checked, source });
    return {
      catalog,
      youTube,
      whitelist,
      source,
      notes,
      audio,
      ask: (text: string) => bot.handle({ from: 'u', messageId: 'm1', text: `search ${text}` }),
      tap: (postback: string) => bot.handle({ from: 'u', messageId: 'm2', postback }),
      /** A search, then a 👍 on its menu's first song. */
      pick: async (text: string) => {
        const menu = await bot.handle({ from: 'u', messageId: 'm1', text: `search ${text}` });
        const line = menu.find((reply) => reply.kind === 'text' && reply.postback?.startsWith('play:'));
        assert.ok(line?.kind === 'text', `no song for "${text}": ${JSON.stringify(menu)}`);
        return bot.handle({ from: 'u', messageId: 'm2', postback: line.postback! });
      },
    };
  }

  test('lookup stores what it finds in the catalog under a stable address, with the cover, and honours the limit', async () => {
    const { source, catalog, notes } = setup();
    const found = await source.lookup('michoel schnitzler', 1);
    assert.equal(found.length, 1);
    assert.equal(catalog.count(), 1);
    assert.deepEqual(catalog.get(found[0]!.id), found[0]);
    assert.equal(found[0]!.url, `${youtube.url}/watch?v=TqV3lHjPLBA`);
    assert.equal(found[0]!.cover, 'https://yt3.googleusercontent.com/TqV3lHjPLBA=w544-h544-l90-rj');
    assert.deepEqual(notes, ["YouTube Music listed 2 songs; 2 by artists on Zemer's list, none female"]);
    assert.deepEqual(catalog.artistIdsOf(found[0]!.url), ['Lipa Schmeltzer', 'Shmueli Ungar', 'Michoel Schnitzler', 'Levy Falkowitz'].map(artistId), 'the credited artists are kept to check again later');
  });

  test('searches the words that matter, not "play" or "by", and ignores a request with none', async () => {
    const { source } = setup();
    assert.deepEqual(await source.lookup('   ', 5), []);
    await source.lookup('play blue horizon by the night owls', 5);
    assert.deepEqual(youtube.searches.map((search) => search.query), ['blue horizon the night owls']);
  });

  test('a request the catalog cannot answer is answered from YouTube Music: a menu, and its song is a caption, then the song’s address', async () => {
    const { pick } = setup();
    assert.deepEqual(await pick('blue horizon night owls'), [
      { kind: 'image', url: 'https://yt3.googleusercontent.com/aaaaaaaaaa1=w544-h544-l90-rj', caption: { title: 'Blue Horizon', artist: 'The Night Owls' } },
      { kind: 'audio', url: `${youtube.url}/watch?v=aaaaaaaaaa1`, title: 'The Night Owls — Blue Horizon' },
    ]);
  });

  test('the same request again lists the same song, kept in the catalog once', async () => {
    const { ask, catalog } = setup();
    const first = await ask('blue horizon night owls');
    const count = catalog.count();
    const again = await ask('blue horizon night owls');
    assert.deepEqual(
      again.map((reply) => (reply.kind === 'text' ? reply.text : reply.kind)),
      first.map((reply) => (reply.kind === 'text' ? reply.text : reply.kind)),
    );
    assert.equal(catalog.count(), count);
  });

  test('a request that names exactly one of the songs it finds puts that one first, and sends nothing on its own', async () => {
    const { ask } = setup();
    const replies = await ask('blue horizon');
    assert.equal(textOf(replies[0]).text, 'Blue Horizon — The Night Owls');
    assert.ok(!replies.some((reply) => reply.kind === 'audio'));
  });

  test('a vague request lists the songs to choose from, and a 👍 on one plays it', async () => {
    const { ask, tap } = setup();
    const replies = await ask('night owls');
    const choices = replies.filter((reply): reply is TextReply => reply.kind === 'text' && reply.postback?.startsWith('play:') === true);
    assert.deepEqual(choices.map((reply) => reply.text), ['Blue Horizon — The Night Owls', 'Blue Horizon (Live) — The Night Owls', 'Hidden Song — The Night Owls']);
    const played = await tap(choices[1]!.postback!);
    assert.deepEqual(played[1], { kind: 'audio', url: `${youtube.url}/watch?v=aaaaaaaaaa2`, title: 'The Night Owls — Blue Horizon (Live)' });
  });

  test('a song YouTube Music will not play is refused with its reason', async () => {
    const { pick } = setup();
    const replies = await pick('locked song');
    assert.equal(textOf(replies[0]).text, 'I can\'t send "Mira Vale — Locked Song": YouTube Music wouldn\'t give me that song (This video is not available in your country).');
  });

  test('when YouTube Music is down the bot says so instead of failing', async () => {
    youtube.failSearch = true;
    const { ask } = setup();
    assert.equal(textOf((await ask('blue horizon'))[0]).text, "I couldn't search YouTube Music right now: YouTube Music answered HTTP 500.");
  });

  test('only songs by artists on Zemer’s list are offered, and never one with a woman’s name among its credits', async () => {
    const { source, catalog } = setup();
    const found = await source.lookup('night owls rina nobody', 10);
    assert.deepEqual(found.map((track) => track.title).sort(), ['Blue Horizon', 'Blue Horizon (Live)', 'Hidden Song'].sort());
    // The woman’s own song, the duet she is on, and the stranger’s song are not even kept in the catalog.
    assert.deepEqual(catalog.search('rina', 5).map((track) => track.title), []);
    assert.deepEqual(catalog.search('stranger', 5).map((track) => track.title), []);
    assert.equal(catalog.search('duet', 5).length, 0);
  });

  test('a song Zemer’s blocked list names is held back even though its artist is on the list', async () => {
    zemer.blocked = { global: ['eeeeeeeeee4'], female: ['aaaaaaaaaa2'] };
    const { source } = setup();
    const found = await source.lookup('night owls', 10);
    assert.deepEqual(found.map((track) => track.title), ['Blue Horizon']);
  });

  test('when nothing YouTube Music finds is allowed, the next source is asked instead', async () => {
    const { source } = setup();
    assert.deepEqual(await source.lookup('rina cohen', 5), []);
    const asked: string[] = [];
    const fallback: TrackSource = {
      name: 'Fallback',
      async lookup(query) {
        asked.push(query);
        return [];
      },
    };
    await combineSources([source, fallback])!.lookup('rina cohen', 5);
    assert.deepEqual(asked, ['rina cohen']);
  });

  test('with no list to filter by there is no YouTube Music answer, rather than an unfiltered one', async () => {
    zemer.failing = new Set(['/whitelist/version']);
    const { source, ask } = setup();
    await assert.rejects(source.lookup('blue horizon', 5), (err) => err instanceof ZemerWhitelistError && err instanceof SourceError);
    assert.deepEqual(youtube.searches, [], 'YouTube Music was not even asked');
    assert.equal(textOf((await ask('blue horizon'))[0]).text, "I couldn't search YouTube Music right now: Zemer's artist list answered HTTP 503.");
  });

  test('a song stored earlier is checked against the list again when it is sent, so a change reaches it', async () => {
    const { pick, tap, catalog } = setup();
    assert.equal((await pick('blue horizon night owls'))[1]?.kind, 'audio');
    const track = catalog.search('blue horizon', 1)[0]!;

    // Later the curators flag the group's singer as female, and then block one song.
    zemer.publish((artists) => {
      artists.find((artist) => artist.name === 'The Night Owls')!.female = true;
    });
    const again = await tap(`play:${track.id}`);
    assert.equal(textOf(again[0]).text, 'I can\'t send "The Night Owls — Blue Horizon": it has a female singer, which I don\'t send.');
    assert.equal(again.length, 1);

    zemer.publish((artists, blocked) => {
      artists.find((artist) => artist.name === 'The Night Owls')!.female = false;
      blocked.global.push('aaaaaaaaaa1');
    });
    assert.equal(textOf((await tap(`play:${track.id}`))[0]).text, 'I can\'t send "The Night Owls — Blue Horizon": Zemer\'s list blocks that song.');

    zemer.publish((artists, blocked) => {
      blocked.global.length = 0;
      artists.splice(artists.findIndex((artist) => artist.name === 'The Night Owls'), 1);
    });
    assert.equal(textOf((await tap(`play:${track.id}`))[0]).text, 'I can\'t send "The Night Owls — Blue Horizon": its artist isn\'t on Zemer\'s artist list.');
  });

  test('a YouTube Music address stored without its artists, or checked with no list, is not sent', async () => {
    const { catalog, youTube, whitelist } = setup();
    const gate = youTubeGate({ youTube, whitelist, catalog });
    const stray = catalog.add({ title: 'Stray', artist: 'Someone', url: youTube.trackUrl('zzzzzzzzzzz') });
    assert.equal(await gate(stray.url), "it hasn't been checked against Zemer's artist list");
    assert.equal(await gate('https://www.music-table.com/post/a#0'), undefined, 'other songs are not this gate’s business');

    const lonely = new ZemerWhitelist({ baseUrl: 'http://127.0.0.1:1' });
    const refused = await youTubeGate({ youTube, whitelist: lonely, catalog })(stray.url);
    assert.match(refused ?? '', /couldn't reach Zemer's artist list.*so I can't check it/);
    assert.equal(await gatedAudioCheck(undefined, async () => ({ ok: true, type: 'audio/mpeg' }))(stray.url).then((r) => r.ok), true, 'with YouTube Music off there is no gate');
  });

  test('a song both sources know is listed once, with the first source’s copy', async () => {
    const catalog = new Catalog(':memory:');
    catalog.add({ title: 'Blue Horizon (Live)', artist: 'The Night Owls', url: 'https://www.music-table.com/post/night-owls-live#0' });
    catalog.add({ title: 'Blue Horizon Remix', artist: 'The Night Owls', url: 'https://www.music-table.com/post/night-owls-remix#0' });
    const { ask } = setup(catalog);
    const replies = await ask('night owls');
    const choices = replies.filter((reply): reply is TextReply => reply.kind === 'text' && reply.postback?.startsWith('play:') === true).map((reply) => reply.text);
    assert.deepEqual(choices, ['Blue Horizon — The Night Owls', 'Blue Horizon (Live) — The Night Owls', 'Hidden Song — The Night Owls', 'Blue Horizon Remix — The Night Owls']);
  });
});

describe('resolvingYouTubeAudio', () => {
  let youtube: MockYouTubeMusic;
  before(async () => {
    youtube = await startMockYouTubeMusic(SONGS);
  });
  after(() => youtube.close());
  beforeEach(() => youtube.reset());

  const make = (options: { maxBytes?: number } = {}) => {
    const calls: string[] = [];
    const io = {
      async checkAudio(url: string) {
        calls.push(`check ${url}`);
        return { ok: true as const, type: 'audio/mpeg' };
      },
      async fetchAudio(url: string, title?: string) {
        calls.push(`fetch ${url} as ${title}`);
        return { data: new Blob(['x']), fileName: 'x.mp3', mimeType: 'audio/mpeg', bytes: 1 };
      },
    };
    const youTube = new YouTubeMusic({ baseUrl: youtube.url });
    return { calls, io, youTube, wrapped: resolvingYouTubeAudio(youTube, io, options) };
  };

  test('checks a song from what the player says about it, without downloading, and leaves other URLs alone', async () => {
    const { calls, youTube, wrapped } = make();
    assert.deepEqual(await wrapped.checkAudio(youTube.trackUrl('aaaaaaaaaa1')), { ok: true, type: 'audio/mp4', bytes: youtube.bytes('aaaaaaaaaa1').length });
    assert.deepEqual(calls, []);
    assert.deepEqual(youtube.mediaCalls, [], 'no request is made to the media server just to check it');
    await wrapped.checkAudio('https://cdn.example.test/a.mp3');
    assert.deepEqual(calls, ['check https://cdn.example.test/a.mp3']);
    await wrapped.fetchAudio('https://cdn.example.test/a.mp3', 'A');
    assert.equal(calls[1], 'fetch https://cdn.example.test/a.mp3 as A');
  });

  test('downloads a song itself rather than through the plain downloader', async () => {
    const { calls, youTube, wrapped } = make();
    const file = await wrapped.fetchAudio(youTube.trackUrl('aaaaaaaaaa1'), 'Night Owls — Blue Horizon');
    assert.equal(file.fileName, 'Night Owls — Blue Horizon.m4a');
    assert.deepEqual(calls, []);
  });

  test('refuses a song over the size limit, going by what the player says', async () => {
    const { youTube, wrapped } = make({ maxBytes: 10 });
    const result = await wrapped.checkAudio(youTube.trackUrl('aaaaaaaaaa1'));
    assert.ok(!result.ok && /limit/.test(result.reason), JSON.stringify(result));
    assert.deepEqual(youtube.mediaCalls, []);
  });

  test('turns a YouTube Music problem into a refusal the user can read, and lets other errors through', async () => {
    const { youTube, wrapped, io } = make();
    const locked = youTube.trackUrl('cccccccccc1');
    assert.deepEqual(await wrapped.checkAudio(locked), { ok: false, reason: "YouTube Music wouldn't give me that song (This video is not available in your country)" });
    await assert.rejects(wrapped.fetchAudio(locked), (err) => err instanceof AudioFetchError && /not available in your country/.test(err.message));

    const broken = resolvingYouTubeAudio(youTube, {
      ...io,
      checkAudio: async () => {
        throw new Error('boom');
      },
    });
    await assert.rejects(broken.checkAudio('https://cdn.example.test/a.mp3'), /boom/);
  });

  test('is a no-op when the source is off', () => {
    const { io } = make();
    assert.equal(resolvingYouTubeAudio(undefined, io), io);
  });
});

describe('songs through a relay (for a host YouTube turns away at its player)', () => {
  let youtube: MockYouTubeMusic;
  before(async () => {
    youtube = await startMockYouTubeMusic(SONGS);
  });
  after(() => youtube.close());
  beforeEach(() => {
    youtube.reset();
    // Asked from here, the player always meets the bot check, as it does on the cloud host.
    youtube.firstAcceptedVisitor = 99;
  });

  /**
   * A relay that answers with the mock's own audio for each song, or as `answer` says, and keeps what it was asked. The
   * relay's later checks wait in `timers` until a test runs them.
   */
  const make = (answer?: (videoId: string) => Promise<RelayedSong>, options: { now?: () => number } = {}) => {
    const asks: Array<{ videoId: string; maxBytes?: number }> = [];
    const lines: string[] = [];
    const timers: Array<{ run: () => void; ms: number }> = [];
    const relay: SongRelay = async (videoId, opts = {}) => {
      asks.push({ videoId, ...opts });
      if (answer) return answer(videoId);
      const data = new Uint8Array(youtube.bytes(videoId));
      return { data, type: 'audio/mp4', bytes: data.byteLength };
    };
    const youTube = new YouTubeMusic({ baseUrl: youtube.url, relay, log: (line) => lines.push(line), setTimer: (run, ms) => void timers.push({ run, ms }), ...options });
    return { asks, lines, timers, youTube };
  };

  /** Lets a check that a timer started run to its end (the relay here answers at once). */
  const waitFor = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(done(), 'the check did not finish');
  };

  test('a song comes through the relay, and neither the player nor the media server is asked from here', async () => {
    const { asks, lines, youTube } = make();
    assert.equal(youTube.relayed, true);
    const file = await youTube.download(youTube.trackUrl('aaaaaaaaaa1'), 'The Night Owls — Blue Horizon', { maxBytes: 5_000_000 });
    assert.deepEqual(asks, [{ videoId: 'aaaaaaaaaa1', maxBytes: 5_000_000 }]);
    assert.equal(file.fileName, 'The Night Owls — Blue Horizon.m4a');
    assert.equal(file.mimeType, 'audio/mp4');
    assert.equal(file.bytes, youtube.bytes('aaaaaaaaaa1').length);
    assert.equal(file.data.type, 'audio/mp4');
    assert.deepEqual(new Uint8Array(await file.data.arrayBuffer()), new Uint8Array(youtube.bytes('aaaaaaaaaa1')));
    assert.deepEqual(youtube.playerCalls, []);
    assert.deepEqual(youtube.mediaCalls, []);
    assert.equal(youtube.visitorIds, 0);
    assert.ok(lines.some((line) => /aaaaaaaaaa1 came through the relay \(\d+\.\d MB in [\d.]+ s\)/.test(line)), lines.join('\n'));
  });

  test('searches are still asked from here, since YouTube answers those', async () => {
    const { asks, youTube } = make();
    assert.ok((await youTube.search('blue horizon')).length > 0);
    assert.equal(youtube.searches.length, 1);
    assert.deepEqual(asks, []);
  });

  test('a relay that answers with a Blob is taken as it is, with the type cleaned up', async () => {
    const audio = new Uint8Array(youtube.bytes('aaaaaaaaaa2'));
    const { youTube } = make(async () => ({ data: new Blob([audio]), type: 'audio/mp4; codecs="mp4a.40.2"', bytes: audio.byteLength }));
    const file = await youTube.download(youTube.trackUrl('aaaaaaaaaa2'), 'Live');
    assert.equal(file.mimeType, 'audio/mp4');
    assert.equal(file.data.type, 'audio/mp4');
    assert.equal(file.fileName, 'Live.m4a');
    assert.deepEqual(new Uint8Array(await file.data.arrayBuffer()), audio);
  });

  test('the check gives the type without asking anyone, so the size is known only when the song arrives', async () => {
    const { asks, youTube } = make();
    const io = {
      checkAudio: async () => assert.fail('not a YouTube address'),
      fetchAudio: async () => assert.fail('not a YouTube address'),
    };
    const wrapped = resolvingYouTubeAudio(youTube, io, { maxBytes: 10 });
    assert.deepEqual(await wrapped.checkAudio(youTube.trackUrl('aaaaaaaaaa1')), { ok: true, type: 'audio/mp4' });
    assert.deepEqual(asks, []);
    assert.deepEqual(youtube.playerCalls, []);
    // The limit is held when the song comes instead.
    await assert.rejects(wrapped.fetchAudio(youTube.trackUrl('aaaaaaaaaa1')), (err) => err instanceof AudioFetchError && /limit/.test(err.message));
    assert.deepEqual(asks, [{ videoId: 'aaaaaaaaaa1', maxBytes: 10 }], 'the relay is told the limit too');
  });

  test('what the relay sends is held to the same rules as a download: audio, and not empty', async () => {
    const page = make(async () => ({ data: new TextEncoder().encode('<html>'), type: 'text/html', bytes: 6 }));
    await assert.rejects(page.youTube.download(page.youTube.trackUrl('aaaaaaaaaa1')), (err) => err instanceof YouTubeMusicError && /isn't audio/.test(err.message));
    assert.ok(page.lines.some((line) => /refused what the relay sent for aaaaaaaaaa1/.test(line)), page.lines.join('\n'));
    const empty = make(async () => ({ data: new Uint8Array(), type: 'audio/mp4', bytes: 0 }));
    await assert.rejects(empty.youTube.download(empty.youTube.trackUrl('aaaaaaaaaa1')), /the file is empty/);
  });

  test('the relay’s reason reaches the chat, and is logged', async () => {
    const { lines, youTube } = make(async () => {
      throw new Error('the relay gave no answer within 90 seconds');
    });
    const wrapped = resolvingYouTubeAudio(youTube, { checkAudio: async () => assert.fail(), fetchAudio: async () => assert.fail() });
    await assert.rejects(wrapped.fetchAudio(youTube.trackUrl('aaaaaaaaaa1')), (err) => err instanceof AudioFetchError && err.message === 'the relay gave no answer within 90 seconds');
    assert.equal(youTube.turnsThisHostAway, false, 'one failure is not YouTube turning songs aside');
    assert.ok(lines.some((line) => line === "YouTube Music: the relay couldn't get aaaaaaaaaa1: the relay gave no answer within 90 seconds"), lines.join('\n'));
  });

  test('a bug or a bare network failure in the relay is logged, and the chat hears it plainly', async () => {
    const { lines, youTube } = make(async () => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(youTube.download(youTube.trackUrl('aaaaaaaaaa1')), (err) => err instanceof YouTubeMusicError && err.message === "the relay couldn't get that song");
    assert.ok(lines.includes("YouTube Music: the relay couldn't get aaaaaaaaaa1: fetch failed"), lines.join('\n'));
    // At start it is only logged: the check never stops the bot.
    assert.deepEqual(await youTube.checkStreams(), { ok: false, problem: "the relay couldn't get that song" });
  });

  test('when YouTube turns the relay away too, YouTube songs are left aside for a minute, and the relay is checked then', async () => {
    let clock = 1_000_000;
    let turnedAway = true;
    const { asks, lines, timers, youTube } = make(
      async (videoId) => {
        if (turnedAway) throw Object.assign(new Error("Sign in to confirm you're not a bot"), { turnedAway: true });
        // The check's short video isn't one of the mock's songs.
        const data = videoId === 'jNQXAC9IVRw' ? new Uint8Array([1, 2, 3]) : new Uint8Array(youtube.bytes(videoId));
        return { data, type: 'audio/mp4', bytes: data.byteLength };
      },
      { now: () => clock },
    );
    await assert.rejects(youTube.download(youTube.trackUrl('aaaaaaaaaa1')), (err) => err instanceof YouTubeMusicError && err.message === TURNED_AWAY);
    assert.equal(youTube.turnsThisHostAway, true);
    await assert.rejects(youTube.download(youTube.trackUrl('aaaaaaaaaa2')), (err) => err instanceof YouTubeMusicError && err.message === TURNED_AWAY);
    await assert.rejects(youTube.inspect(youTube.trackUrl('aaaaaaaaaa2')), (err) => err instanceof YouTubeMusicError && err.message === TURNED_AWAY);
    assert.equal(asks.length, 1, 'the relay is not asked again meanwhile');
    assert.deepEqual(timers.map((timer) => timer.ms), [60_000], 'one check, a minute on');
    assert.ok(lines.includes('YouTube Music turns the relay away too; YouTube songs are left aside for 1 minute, then the relay is checked again'), lines.join('\n'));

    // The check still meets the bot check: twice as long this time, and another check at its end.
    clock += 60_000;
    timers.shift()!.run();
    await waitFor(() => timers.length === 1);
    assert.deepEqual(asks.at(-1), { videoId: 'jNQXAC9IVRw' });
    assert.equal(timers[0]!.ms, 120_000);
    assert.equal(youTube.turnsThisHostAway, true);

    // Then it comes through: YouTube songs are back at once, before the two minutes are up.
    turnedAway = false;
    clock += 60_000;
    timers.shift()!.run();
    await waitFor(() => !youTube.turnsThisHostAway);
    assert.ok(lines.includes('YouTube Music lets the relay through again; YouTube songs are back'), lines.join('\n'));
    assert.equal((await youTube.download(youTube.trackUrl('aaaaaaaaaa1'))).bytes, youtube.bytes('aaaaaaaaaa1').length);
    assert.equal(timers.length, 0, 'no check is left waiting');

    // The next time starts again at a minute.
    turnedAway = true;
    await assert.rejects(youTube.download(youTube.trackUrl('aaaaaaaaaa2')), (err) => err instanceof YouTubeMusicError && err.message === TURNED_AWAY);
    assert.deepEqual(timers.map((timer) => timer.ms), [60_000]);
  });

  test('each time in a row the relay is left aside twice as long, never longer than turnedAwayMs; songs failing together count once', async () => {
    let clock = 1_000_000;
    const { timers, youTube } = make(
      async () => {
        throw Object.assign(new Error("Sign in to confirm you're not a bot"), { turnedAway: true });
      },
      { now: () => clock },
    );
    // An album's songs, asked for together, meet the same check.
    await Promise.all(['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3'].map((id) => assert.rejects(youTube.download(youTube.trackUrl(id)))));
    const waits = [timers[0]!.ms];
    assert.equal(timers.length, 1);
    for (let i = 0; i < 5; i += 1) {
      clock += timers[0]!.ms;
      timers.shift()!.run();
      await waitFor(() => timers.length === 1);
      waits.push(timers[0]!.ms);
    }
    assert.deepEqual(waits.map((ms) => ms / 60_000), [1, 2, 4, 8, 15, 15]);
  });

  test('a start-up check that meets the bot check leaves YouTube songs aside for a minute, not a quarter of an hour', async () => {
    let clock = 1_000_000;
    const { timers, youTube } = make(
      async () => {
        throw Object.assign(new Error("Sign in to confirm you're not a bot"), { turnedAway: true });
      },
      { now: () => clock },
    );
    assert.deepEqual(await youTube.checkStreams(), { ok: false, problem: TURNED_AWAY });
    assert.equal(youTube.turnsThisHostAway, true);
    assert.deepEqual(timers.map((timer) => timer.ms), [60_000]);
    clock += 60_000;
    assert.equal(youTube.turnsThisHostAway, false);
  });

  test('the start-up check asks the relay for its short video, and says in the log how it went', async () => {
    const good = make(async () => ({ data: new Uint8Array([1, 2, 3]), type: 'audio/mp4', bytes: 3 }));
    assert.deepEqual(await good.youTube.checkStreams(), { ok: true });
    assert.deepEqual(good.asks, [{ videoId: 'jNQXAC9IVRw' }]);
    assert.deepEqual(youtube.playerCalls, []);
    assert.ok(good.lines.includes('YouTube Music: songs can be had through the relay'), good.lines.join('\n'));

    const bad = make(async () => {
      throw new Error('the relay gave no answer within 90 seconds');
    });
    assert.deepEqual(await bad.youTube.checkStreams(), { ok: false, problem: 'the relay gave no answer within 90 seconds' });
    assert.ok(bad.lines.includes("YouTube Music: songs can't be had through the relay right now: the relay gave no answer within 90 seconds"), bad.lines.join('\n'));
  });
});

describe('youTubeMusicFromEnv', () => {
  test('is on unless YOUTUBE_MUSIC says off, and can be pointed elsewhere', () => {
    for (const off of ['off', 'OFF', 'false', 'no', '0']) assert.equal(youTubeMusicFromEnv({ YOUTUBE_MUSIC: off }), undefined, off);
    assert.ok(youTubeMusicFromEnv({}) instanceof YouTubeMusic);
    assert.equal(youTubeMusicFromEnv({}) ?.baseUrl, 'https://music.youtube.com');
    assert.equal(youTubeMusicFromEnv({ YOUTUBE_MUSIC: 'on', YOUTUBE_MUSIC_URL: 'http://localhost:9/' })?.baseUrl, 'http://localhost:9');
    assert.equal(youTubeMusicFromEnv({})?.relayed, false);
    const relay: SongRelay = async () => ({ data: new Uint8Array([1]), type: 'audio/mp4', bytes: 1 });
    assert.equal(youTubeMusicFromEnv({}, { relay })?.relayed, true);
  });
});

describe('asking several sources', () => {
  const track = (id: number, title: string): Track => ({ id, title, artist: 'A', url: `https://x.test/${id}` });
  const source = (name: string, run: () => Promise<Track[]>): TrackSource & { asked: number } => {
    const made = {
      name,
      asked: 0,
      async lookup() {
        made.asked += 1;
        return run();
      },
    };
    return made;
  };

  test('SONG_SOURCES sets the order, defaulting to Zemer (and YouTube Music) first, and refuses names it does not know', () => {
    assert.deepEqual(songSourceOrder({}), ['youtube-music', 'music-table']);
    assert.deepEqual(songSourceOrder({ SONG_SOURCES: 'music-table, zemer' }), ['music-table', 'youtube-music'], '"zemer" is another name for it');
    assert.deepEqual(songSourceOrder({ SONG_SOURCES: ' Music-Table , youtube-music ' }), ['music-table', 'youtube-music']);
    assert.deepEqual(songSourceOrder({ SONG_SOURCES: 'music-table' }), ['music-table']);
    assert.throws(() => songSourceOrder({ SONG_SOURCES: 'youtube-music,spotify' }), /spotify/);
  });

  test('the first source to find anything answers, and the next is not bothered', async () => {
    const first = source('First', async () => [track(1, 'One')]);
    const second = source('Second', async () => [track(2, 'Two')]);
    const both = combineSources([first, second])!;
    assert.equal(both.name, 'First and Second');
    assert.deepEqual((await both.lookup('q', 5)).map((t) => t.title), ['One']);
    assert.equal(second.asked, 0);
  });

  test('a source that finds nothing, or cannot be reached, hands over to the next', async () => {
    const empty = source('Empty', async () => []);
    const down = source('Down', async () => {
      throw new SourceError('no answer');
    });
    const last = source('Last', async () => [track(3, 'Three')]);
    assert.deepEqual((await combineSources([empty, down, last])!.lookup('q', 5)).map((t) => t.title), ['Three']);
  });

  test('nothing found is an empty answer, but nobody answering is a problem that names each source', async () => {
    const empty = source('Empty', async () => []);
    const down = source('Down', async () => {
      throw new SourceError('no answer');
    });
    const worse = source('Worse', async () => {
      throw new SourceError('HTTP 500');
    });
    assert.deepEqual(await combineSources([empty, down])!.lookup('q', 5), []);
    await assert.rejects(combineSources([down, worse])!.lookup('q', 5), (err) => err instanceof SourceError && err.message === 'Down: no answer; Worse: HTTP 500');
  });

  test('a bug is not hidden as a missing source, and one source is used as it is', async () => {
    const bug = source('Bug', async () => {
      throw new TypeError('oops');
    });
    await assert.rejects(combineSources([bug, source('Other', async () => [])])!.lookup('q', 5), TypeError);
    const only = source('Only', async () => []);
    assert.equal(combineSources([only]), only);
    assert.equal(combineSources([]), undefined);
  });

  test('songSources puts Zemer first unless SONG_SOURCES puts music-table.com first, and leaves out the ones that are off', () => {
    const nowhere = 'http://127.0.0.1:9';
    const parts = { catalog: new Catalog(':memory:'), youTube: new YouTubeMusic({ baseUrl: nowhere }), whitelist: new ZemerWhitelist({ baseUrl: nowhere }), musicTable: new MusicTable({ baseUrl: nowhere }) };
    const both = songSources({ ...parts, order: ['youtube-music', 'music-table'] });
    assert.deepEqual([both.finder?.name, both.albums?.name, both.source?.name, both.musicTableFirst], ['Zemer', 'Zemer', 'music-table.com', undefined]);
    assert.equal(songSources({ ...parts, order: ['music-table', 'youtube-music'] }).musicTableFirst, true);
    assert.deepEqual(Object.keys(songSources({ ...parts, order: ['music-table'] })), ['source']);
    assert.deepEqual(Object.keys(songSources({ ...parts, order: ['youtube-music'] })).sort(), ['albums', 'finder']);
    assert.deepEqual(Object.keys(songSources({ ...parts, youTube: undefined })), ['source'], 'no Zemer without YouTube Music to get its songs from');
  });
});

describe('YouTube Music over Matrix, end to end', () => {
  let matrix: MockMatrix;
  let youtube: MockYouTubeMusic;
  let zemer: MockZemerContent;
  before(async () => {
    matrix = await startMockMatrix();
    youtube = await startMockYouTubeMusic(SONGS);
    zemer = await startMockZemerContent(LISTED);
  });
  after(async () => {
    await matrix.close();
    await youtube.close();
    await zemer.close();
  });
  beforeEach(() => {
    matrix.reset();
    youtube.reset();
    zemer.reset(LISTED);
  });

  test('a song typed on the phone is found on YouTube Music and arrives as an AAC file', async () => {
    const catalog = new Catalog(':memory:');
    const youTube = new YouTubeMusic({ baseUrl: youtube.url });
    const audio = resolvingYouTubeAudio(youTube, {
      checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }),
      fetchAudio: (url, title) => fetchAudio(url, title),
    });
    const whitelist = new ZemerWhitelist({ baseUrl: zemer.url, state: catalog });
    const bot = createBot({
      catalog,
      checkAudio: gatedAudioCheck(youTubeGate({ youTube, whitelist, catalog }), audio.checkAudio),
      source: createYouTubeMusicSource({ youTube, catalog, whitelist }),
    });
    const chat = new MatrixClient({ token: matrix.token, homeserver: matrix.url });
    const runner = createRunner({ chat, bot, chatID: matrix.roomId, fetchAudio: audio.fetchAudio, pollMs: 20, log: () => {} });
    await runner.prime();
    matrix.addMessage(matrix.ghost, { msgtype: 'm.text', body: 'search blue horizon night owls' });
    await runner.tick();
    // The menu, then a 👍 on its song.
    assert.equal(matrix.sent[0]?.content.body, '🎵 Blue Horizon — The Night Owls');
    const menu = matrix.sent.length;
    matrix.addReaction(matrix.ghost, matrix.sent[0]!.eventId, '👍');
    await runner.tick();
    matrix.sent.splice(0, menu);

    assert.equal(matrix.sent.length, 2);
    assert.deepEqual(matrix.sent[0]?.content, { msgtype: 'm.text', body: '🎵 The Night Owls — Blue Horizon' });
    const sent = matrix.sent[1]?.content;
    assert.equal(sent?.msgtype, 'm.audio');
    assert.equal(sent?.filename, 'The Night Owls — Blue Horizon.m4a');
    assert.equal(sent?.info.mimetype, 'audio/mp4');
    assert.deepEqual(matrix.uploads[0]?.bytes, youtube.bytes('aaaaaaaaaa1'));
  });
  test('on a host YouTube turns away at its player, the song comes through the relay and arrives the same', async () => {
    youtube.firstAcceptedVisitor = 99;
    const catalog = new Catalog(':memory:');
    const relay: SongRelay = async (videoId) => {
      const data = new Uint8Array(youtube.bytes(videoId));
      return { data, type: 'audio/mp4', bytes: data.byteLength };
    };
    const youTube = new YouTubeMusic({ baseUrl: youtube.url, relay });
    const audio = resolvingYouTubeAudio(youTube, {
      checkAudio: (url) => checkAudio(url, { allowPrivateHosts: true, allowAnyAudio: true }),
      fetchAudio: (url, title) => fetchAudio(url, title),
    });
    const whitelist = new ZemerWhitelist({ baseUrl: zemer.url, state: catalog });
    const bot = createBot({
      catalog,
      checkAudio: gatedAudioCheck(youTubeGate({ youTube, whitelist, catalog }), audio.checkAudio),
      source: createYouTubeMusicSource({ youTube, catalog, whitelist }),
    });
    const chat = new MatrixClient({ token: matrix.token, homeserver: matrix.url });
    const runner = createRunner({ chat, bot, chatID: matrix.roomId, fetchAudio: audio.fetchAudio, pollMs: 20, log: () => {} });
    await runner.prime();
    matrix.addMessage(matrix.ghost, { msgtype: 'm.text', body: 'search blue horizon night owls' });
    await runner.tick();
    const menu = matrix.sent.length;
    matrix.addReaction(matrix.ghost, matrix.sent[0]!.eventId, '👍');
    await runner.tick();
    matrix.sent.splice(0, menu);

    assert.equal(matrix.sent.length, 2);
    assert.equal(matrix.sent[1]?.content.msgtype, 'm.audio');
    assert.equal(matrix.sent[1]?.content.filename, 'The Night Owls — Blue Horizon.m4a');
    assert.deepEqual(matrix.uploads[0]?.bytes, youtube.bytes('aaaaaaaaaa1'));
    assert.deepEqual(youtube.playerCalls, [], 'the player was never asked from this host');
  });
});

describe('Zemer’s artist list', () => {
  let zemer: MockZemerContent;
  before(async () => {
    zemer = await startMockZemerContent(LISTED);
  });
  after(() => zemer.close());
  beforeEach(() => zemer.reset(LISTED));

  const make = (options: ConstructorParameters<typeof ZemerWhitelist>[0] = {}) => new ZemerWhitelist({ baseUrl: zemer.url, ...options });
  const night = artistId('The Night Owls');
  const rina = artistId('Rina Cohen');

  test('lets a song through when one artist is on the list and none is a woman, and says why when it does not', async () => {
    const list = make();
    await list.ready();
    assert.deepEqual(list.size, { artists: 7, blocked: 0 });
    assert.deepEqual(list.verdict('x', [night]), { ok: true });
    assert.deepEqual(list.verdict('x', [artistId('Stranger'), night]), { ok: true }, 'an unknown co-artist doesn’t matter if another is listed');
    assert.deepEqual(list.verdict('x', [rina]), { ok: false, why: 'female' });
    assert.deepEqual(list.verdict('x', [night, rina]), { ok: false, why: 'female' }, 'one woman among the credits is enough');
    assert.deepEqual(list.verdict('x', [artistId('Stranger')]), { ok: false, why: 'not on the list' });
    assert.deepEqual(list.verdict('x', []), { ok: false, why: 'not on the list' });
  });

  test('a song on either blocked list is held back whoever sings it', async () => {
    zemer.blocked = { global: ['g1'], female: ['f1'] };
    const list = make();
    await list.ready();
    assert.deepEqual(list.size.blocked, 2);
    for (const id of ['g1', 'f1']) assert.deepEqual(list.verdict(id, [night]), { ok: false, why: 'blocked' });
    assert.equal(list.allows('other', [night]), true);
  });

  test('reads the list as the server writes it: either spelling of the keys, the curated name, and nothing without an id or a name', async () => {
    zemer.artists = [
      { id: 'UC_a', name: 'A', legacyKeys: true },
      { id: 'UC_b', name: 'old B', displayName: 'B' },
      { id: '', name: 'No Id' },
      { id: 'UC_d', name: '' },
    ];
    const list = make();
    await list.ready();
    assert.deepEqual(list.size.artists, 2);
    assert.equal(list.allows('x', ['UC_a']), true);
    assert.equal(list.allows('x', ['UC_b']), true);
  });

  test('stays current: a check at most five minutes old, the 100-byte version first and the whole list only when it changed', async () => {
    let clock = 1_000_000;
    const list = make({ now: () => clock });
    await list.ready();
    assert.deepEqual(zemer.requests.sort(), ['/blockedContentIds', '/whitelist', '/whitelist/version']);

    zemer.requests = [];
    clock += 4 * 60_000;
    await list.ready();
    assert.deepEqual(zemer.requests, [], 'asked a few minutes ago, so not again');

    clock += 2 * 60_000;
    await list.ready();
    assert.deepEqual(zemer.requests.sort(), ['/blockedContentIds', '/whitelist/version'], 'unchanged: the version and the blocked songs only');

    // New music comes out: a new artist is added, and another is flagged.
    zemer.publish((artists, blocked) => {
      artists.push({ id: artistId('New Artist'), name: 'New Artist' });
      artists.find((artist) => artist.name === 'Mira Vale')!.female = true;
      blocked.global.push('new-blocked');
    });
    zemer.requests = [];
    clock += 6 * 60_000;
    await list.ready();
    assert.deepEqual(zemer.requests.sort(), ['/blockedContentIds', '/whitelist', '/whitelist/version']);
    assert.equal(list.allows('x', [artistId('New Artist')]), true);
    assert.equal(list.allows('x', [artistId('Mira Vale')]), false);
    assert.equal(list.allows('new-blocked', [night]), false);
    assert.equal(list.ageMs, 0);
  });

  test('keeps the last good list when the server fails, and tries again soon, not on every search', async () => {
    let clock = 1_000_000;
    const list = make({ now: () => clock });
    await list.ready();
    zemer.failing = new Set(['/whitelist/version']);
    zemer.requests = [];
    clock += 6 * 60_000;
    await list.ready(); // does not throw
    assert.equal(list.allows('x', [night]), true);
    assert.equal(list.ageMs, 6 * 60_000, 'it is not pretending to be fresher than it is');
    await list.ready();
    await list.ready();
    assert.equal(zemer.requests.length, 1, 'a failed check is not repeated for a minute');
    clock += 61_000;
    zemer.failing = new Set();
    await list.ready();
    assert.equal(list.ageMs, 0);
  });

  test('never replaces a good list with an empty one, and keeps the old blocked songs when only they fail to load', async () => {
    zemer.blocked = { global: ['g1'], female: [] };
    let clock = 1_000_000;
    const list = make({ now: () => clock });
    await list.ready();
    zemer.publish(() => {});
    zemer.emptyList = true;
    clock += 6 * 60_000;
    await list.ready();
    assert.equal(list.size.artists, 7);

    zemer.emptyList = false;
    zemer.failing = new Set(['/blockedContentIds']);
    clock += 61_000;
    await list.ready();
    assert.equal(list.verdict('g1', [night]).ok, false, 'the old blocked list still applies');
  });

  test('has no answer rather than an unfiltered one when there is no list and none can be had', async () => {
    zemer.failing = new Set(['/whitelist']);
    await assert.rejects(make().ready(), (err) => err instanceof ZemerWhitelistError && err.message === "Zemer's artist list answered HTTP 503");
    zemer.failing = new Set(['/blockedContentIds']);
    await assert.rejects(make().ready(), /HTTP 503/, 'on a first load the blocked songs are needed too');
    zemer.failing = new Set();
    zemer.emptyList = true;
    await assert.rejects(make().ready(), /came back empty/);
    await assert.rejects(new ZemerWhitelist({ baseUrl: 'http://127.0.0.1:1' }).ready(), /couldn't reach Zemer's artist list/);
    assert.equal(make().loaded, false);
    assert.equal(make().ageMs, Infinity);
  });

  test('keeps the list between runs, so a restart with no internet still filters', async () => {
    const state = memory();
    const first = make({ state });
    await first.ready();
    assert.ok(state.kept.has('zemer.whitelist'));

    const offline = new ZemerWhitelist({ baseUrl: 'http://127.0.0.1:1', state, patienceMs: 50 });
    assert.equal(offline.loaded, true);
    assert.deepEqual(offline.size, first.size);
    assert.equal(offline.allows('x', [rina]), false);
    await offline.ready(); // an old list is asked about, fails, and is kept
    assert.equal(offline.allows('x', [night]), true);

    state.kept.set('zemer.whitelist', 'not json');
    assert.equal(new ZemerWhitelist({ state }).loaded, false, 'a damaged copy is ignored');
  });

  test('a search does not wait long for a slow server', async () => {
    let clock = 1_000_000;
    const list = make({ now: () => clock, patienceMs: 40 });
    await list.ready();
    zemer.delayMs = 1_500;
    clock += 6 * 60_000;
    const started = performance.now();
    await list.ready();
    assert.ok(performance.now() - started < 1_000, 'it went on with the list it had');
    assert.equal(list.allows('x', [night]), true);
  });

  test('watching checks on its own, and reports each outcome', async () => {
    const list = make();
    await list.ready();
    const outcomes: Array<string | undefined> = [];
    const until = async (done: () => boolean): Promise<void> => {
      for (let waited = 0; !done() && waited < 5_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    };
    const stop = list.watch((error) => outcomes.push(error), 20);
    await until(() => outcomes.includes(undefined));
    assert.ok(outcomes.includes(undefined), 'it succeeded while the server was fine');
    zemer.failing = new Set(['/whitelist/version']);
    await until(() => outcomes.includes("Zemer's artist list answered HTTP 503"));
    assert.ok(outcomes.includes("Zemer's artist list answered HTTP 503"), 'and said so when it failed');
    stop();
    await new Promise((resolve) => setTimeout(resolve, 60)); // a check already under way may still report
    const seen = outcomes.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(outcomes.length, seen, 'stopped');
  });

  test('zemerWhitelistFromEnv can be pointed elsewhere', () => {
    assert.equal(zemerWhitelistFromEnv({}).baseUrl, 'https://content.zemer.io');
    assert.equal(zemerWhitelistFromEnv({ ZEMER_CONTENT_URL: 'http://localhost:9/' }).baseUrl, 'http://localhost:9');
  });
});
