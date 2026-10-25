import { readFileSync } from 'node:fs';
import { createBot, type BotDeps, type TrackSource } from '../../src/bot.ts';
import { Catalog, viewsIn } from '../../src/catalog.ts';
import { createYouTubeAlbumSource, createYouTubeMusicSource, gatedAudioCheck, YouTubeMusic, youTubeGate } from '../../src/sources/youtube-music.ts';
import { createZemerFinder, ZemerSearch } from '../../src/sources/zemer.ts';
import { ZemerWhitelist } from '../../src/sources/zemer-whitelist.ts';
import type { Incoming, Reply } from '../../src/types.ts';
import type { MockArtist } from './mock-zemer-content.ts';
import type { MockZemerSearch } from './mock-zemer-search.ts';

// What search.zemer.io and content.zemer.io answered on 2026-10-20 for the plan's three walkthroughs ("search achas",
// "search lipa schmeltzer", "search forever"), Nachas's page and two albums' pages: the golden menus are made of these.

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/zemer/${name}.json`, import.meta.url), 'utf8'));

/** Zemer's artist list, as far as these answers need it: every artist in them (none flagged female), and nothing blocked. */
export const FIXTURE_WHITELIST = fixture('whitelist') as { artists: MockArtist[]; blocked: { global: string[]; female: string[] } };

/** Puts the saved answers in the mock search, as the real one gave them. */
export function serveFixtures(search: MockZemerSearch): void {
  search.raw.set('/search achas', fixture('search-achas'));
  search.raw.set('/search lipa schmeltzer', fixture('search-lipa-schmeltzer'));
  search.raw.set('/search forever', fixture('search-forever'));
  search.raw.set('/artist UCFaqeWT7ZBJsdeOvCWvYhfA', fixture('artist-nachas'));
  search.raw.set('/album MPREb_SSjgz2CDJBF', fixture('album-achas'));
  search.raw.set('/album MPREb_2QOBZ8qxJyk', fixture('album-forever'));
}

/** A bot over Zemer (the mocks), the catalog and a music-table.com that has whatever `site` says, with views kept in the catalog. */
export function fixtureBot(
  urls: { search: string; content: string; youtube: string },
  options: { catalog?: Catalog; site?: TrackSource; zemer?: boolean; deps?: Partial<BotDeps> } = {},
) {
  const catalog = options.catalog ?? new Catalog(':memory:');
  const youTube = new YouTubeMusic({ baseUrl: urls.youtube });
  const whitelist = new ZemerWhitelist({ baseUrl: urls.content, state: catalog, checkEveryMs: 0, retryAfterMs: 0 });
  const finder = createZemerFinder({
    zemer: options.zemer === false ? undefined : new ZemerSearch({ baseUrl: urls.search }),
    youTube,
    catalog,
    whitelist,
    fallback: { songs: createYouTubeMusicSource({ youTube, catalog, whitelist }), albums: createYouTubeAlbumSource({ youTube, catalog, whitelist }) },
  });
  const bot = createBot({
    catalog,
    checkAudio: gatedAudioCheck(youTubeGate({ youTube, whitelist, catalog }), async () => ({ ok: true, type: 'audio/mp4', bytes: 1000 })),
    finder,
    albums: finder.albums,
    ...(options.site ? { source: options.site } : {}),
    views: viewsIn(catalog),
    ...options.deps,
  });
  const base: Omit<Incoming, 'text' | 'postback'> = { from: 'me', messageId: 'm' };
  return {
    bot,
    catalog,
    whitelist,
    say: (text: string) => bot.handle({ ...base, text }),
    tap: (postback: string) => bot.handle({ ...base, postback }),
  };
}

type TextReply = Extract<Reply, { kind: 'text' }>;

/**
 * An answer as the chat shows it where a 👍 picks: each message's words, a 💿 line with its number after the mark (as the
 * runner puts it), and nothing for a reply that only carries its list's numbers.
 */
export function shown(replies: Reply[]): string[] {
  return replies.flatMap((reply) => {
    if (reply.kind !== 'text') return [`[${reply.kind}]`];
    if (!reply.text) return [];
    return [reply.number !== undefined && reply.text.startsWith('💿 ') ? `💿 ${reply.number}. ${reply.text.slice(3)}` : reply.number !== undefined ? `${reply.number}. ${reply.text}` : reply.text];
  });
}

/** The postback of the line that says `text` (the first that starts with it). */
export function postbackOf(replies: Reply[], text: string): string {
  const line = replies.find((reply): reply is TextReply => reply.kind === 'text' && reply.text.startsWith(text) && reply.postback !== undefined);
  if (!line) throw new Error(`no line starting "${text}" in ${JSON.stringify(shown(replies))}`);
  return line.postback!;
}

/** The answer's list: what a number or "all" picks from now. */
export function choicesIn(replies: Reply[]): TextReply | undefined {
  return replies.findLast((reply): reply is TextReply => reply.kind === 'text' && reply.chips !== undefined);
}
