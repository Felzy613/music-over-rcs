# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal bot: you text `search <song>` in your own Google Messages "message yourself" chat and it sends back the audio file with album art. It reaches the phone through a self-hosted mautrix-gmessages bridge and a Matrix (Synapse) homeserver, both running on the user's Mac. Songs come from a local SQLite catalog fed by music-table.com (direct MP3 downloads on its release posts) and, for what the catalog doesn't have, from YouTube Music through the same InnerTube API the Zemer app uses. `README.md` covers the user-facing behavior; `docs/architecture.md` is the fuller code tour.

## Commands

TypeScript runs directly on Node ≥ 22.18 (no build step), and there are **no runtime dependencies** (`node:sqlite`, `node:http`, built-in `fetch`). `npm install` only brings in `typescript` and `@types/node`.

```bash
npm test                          # whole suite, no network (mock servers in test/helpers/)
npm run typecheck                 # tsc, noEmit; covers src, scripts, test and extensions
npm run simulate:web -- --open    # real bot + real site in a browser chat; needs no accounts
npm run matrix                    # run the bridge-route bot in the foreground (needs .env)
npm run library -- <cmd>          # status | sync | scan | prefetch | digest [--days N] [--send]
npm run stack -- status|restart|logs bot|sync-bot|enable-bot   # the launchd services
```

Run one test file, or one test by name (invoke `node` directly; `npm test` takes a fixed glob):

```bash
node --disable-warning=ExperimentalWarning --test test/naming.test.ts
node --disable-warning=ExperimentalWarning --test --test-name-pattern="restart" test/bridge-restart.test.ts
```

There is no linter or formatter configured.

## The running bot is a copy, not this folder

macOS stops launchd jobs from reading `~/Documents`, so the always-on bot does **not** run from this checkout. `deploy/mac/stack` rsyncs `src/`, `extensions/`, `package.json` and `.env` into `~/Library/Application Support/music-over-rcs/bot/`, and the catalog and logs live there too (not in `data/`). Editing code here changes nothing in the live bot until `npm run stack -- restart` (it re-syncs the copy when the bot is loaded) or `sync-bot`. The same goes for `.env` edits. `data/catalog.db` is only what a local `npm run …` uses.

## Architecture

Three layers, in the order a message travels:

1. **Transport** (`ChatClient`: `listMessages`, `sendText`, `sendAudio`, optional `sendImage`, `setTyping`). Implementations: `src/matrix/` (the main route), `src/beeper/`, and the simulator's `SimulatedChat`. The RCS for Business route (`src/rbm/`, `src/handler.ts`, `src/server.ts`, entry `npm start`) is a separate webhook server that calls the bot directly and doesn't get the library features.
2. **`src/runner.ts`** binds the bot to one chat: polls, ignores its own messages, handles 👍 reactions, `all`, typing indicators, downloading ahead (max 3 at once), spacing audio files by `SONG_GAP_SECONDS`, and sends bot-initiated messages through `announce` (never in the middle of answering a request).
3. **`src/bot.ts`** decides what to answer and knows nothing about platforms. It takes text or a postback (`play:42`, `post:<slug>`, `all:…`) and returns `Reply[]` (`text`, `image`, `collage`, `audio`; see `src/types.ts`). A reply's `postback` is what makes a 👍 on that message mean "that song"; lists deliberately have no numbers.

Entry points wire these together: `src/matrix-main.ts` is the best single file to read for how everything is assembled (catalog, music-table source, library jobs, health, bridge watch, extensions, runner).

Behind the bot:

- **`src/catalog.ts`**: one SQLite file (WAL, shared with the CLI tools): tracks + FTS, artists, site posts, plays, follows, audio cache, `message_links`, and a `state` key/value table. The background jobs persist their progress there, so restarts resume.
- **`src/library/jobs.ts`** (`LibraryJobs`): ticks once a minute, doing one thing at a time (site sync every 3 h, prefetch, RSS check every 15 min while following anyone, daily message, follow alerts outside quiet hours, one-time full-site scan). The library tests drive it on a fake clock.
- **`src/sources/music-table.ts`** (+ `relevance.ts`, `titles.ts`): implements `TrackSource`. Site songs are stored as `…/post/<slug>#<n>` links, never download URLs, because the site's links expire; `resolvingAudio` fetches a fresh one at send time.
- **`src/sources/youtube-music.ts`**: the other `TrackSource`, ported from Zemer (`ZemerTeam/zemer-app`): `search` as WEB_REMIX with the songs filter, `player` as the VISIONOS client (ready-to-use links, no cipher or PoToken) for an AAC stream. Songs are stored as `https://music.youtube.com/watch?v=<id>`; `resolvingYouTubeAudio` wraps `resolvingAudio` the same way. The media server 403s without the client's User-Agent and a `Range` header, so downloads go through `YouTubeMusic.download`, not the plain `fetchAudio`. Zemer's other stream paths are not ported (`docs/youtube-music.md`). **Every YouTube Music result goes through Zemer's artist whitelist (`src/sources/zemer-whitelist.ts`, read from `content.zemer.io`) with female singers excluded, and a stored YouTube song is checked against the current list again when it is sent (`youTubeGate`, wrapped round `checkAudio` in every entry point). The owner requires both; `createYouTubeMusicSource` takes the whitelist as a required argument so a new entry point can't skip it. Keep that if you touch these.** `src/sources/songs.ts` orders the sources (`SONG_SOURCES`) and falls through from one to the next; every entry point builds its source and audio stack the same way (see `matrix-main.ts`).
- **`src/health.ts`**: `Health` raises macOS notifications (via `osascript`) because the chat can't report its own outage; `BridgeWatch` polls the bridge's login status and triggers `src/bridge-restart.ts` (launchd restart of the bridge).
- **`src/library/`** also owns file naming (`naming.ts`: `Artist/Album/01 Title.mp3`), tag writing (`id3.ts`, `mp4.ts`, hand-rolled, untouched audio), and picture composition (`compose.ts` drives AppKit through `osascript`, so image features are macOS-only).
- **The cloud host** (`docs/cloud.md`): everything above can run in one Docker container on Render's free plan with a Cloudflare Worker beside it, so it doesn't depend on the Mac's internet. `deploy/cloud/entrypoint.ts` (PID 1) calls `src/cloud/boot.ts`: take the lease (the Worker's, `cloudflare/lease.ts`; at most one host at a time), restore the three SQLite databases from R2 with Litestream, write Synapse's and the bridge's settings (`src/cloud/provision.ts`; secrets derived from `SECRET_KEY`, so nothing is stored), and keep the processes running (`src/cloud/supervise.ts`). `src/cloud-main.ts` is the bot's entry there: it opens the web door (`/healthz`, `/status`, `/pair` to link Google Messages and choose the chat), signs in, then imports `matrix-main.ts`. The runner saves how far it got (`ResumeStore`, catalog state `chat.resume`) so a restart answers texts sent while it was down. Problems go to the Worker's `/alert` (`src/alert.ts`) as email. With `ONEDRIVE_CLIENT_ID` set, every song the library fetches to send is also offered to `SongArchive` (`src/archive/archiver.ts`), which tags it (`tagSong` in `library/audio-cache.ts`) and uploads it to the owner's OneDrive app folder in the background through `src/archive/onedrive.ts` (device-code sign-in done from the `/pair` page, refresh token in catalog state `onedrive.refresh`, a monthly upload allowance because Render's free plan caps outbound traffic). Not run in production yet; `docs/cloud.md` lists what the first deploy must prove.
- **`extensions/`** is gitignored (each add-on can be its own repo) but is still typechecked and tested. An add-on's `index.ts` default-exports an `ExtensionSetup` (`src/extensions.ts`); only the bridge route loads them, and a failing one is reported and skipped rather than stopping the bot.

## Conventions and constraints

- `tsconfig` uses `erasableSyntaxOnly`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess` and `allowImportingTsExtensions`: no enums, namespaces or parameter properties; use `import type`; import local files with their `.ts` extension.
- Entry points `import './load-env.ts'` first (loads `.env`; real environment variables win).
- Every message the bot sends starts with `BOT_MARK` (🎵), and add-on relays start with `RELAY_MARK` (🤖); the runner never answers a message starting with either. The self-chat is shared by the bot and the user, so this is the loop guard; keep it when adding message types. The runner also treats a word-for-word repeat within 20 seconds as an echo of the first (a phone can show one text twice) and caps messages per minute.
- Downloads must be audio, within `MAX_DOWNLOAD_MB`, and from a source's own HTTPS hosts (music-table.com's file hosts, YouTube's `googlevideo.com`); page links are rejected. music-table.com's source only ever uses the files its posts offer: the YouTube embeds in those posts are ignored. YouTube Music is a separate, deliberate source (added 2026-10-11 at the owner's request, overriding the earlier rule against it).
- The simulator binds 127.0.0.1 only. The cloud host's web door (`src/cloud/web.ts`) binds 0.0.0.0 because Render needs a public port: only `/healthz` is open, everything else needs `ADMIN_TOKEN`, and the homeserver and bridge stay on 127.0.0.1. (The RBM webhook, `src/server.ts`, also binds all interfaces.)
- Tests are `node:test` with mock servers for Matrix, music-table.com, Beeper, Google's RBM API and an audio host (`test/helpers/`); new behavior against those services should extend the mocks, not hit the network.
- `.env`, `data/`, `*.db`, `keys/`, `extensions/` and `.claude/` are gitignored. `deploy/dell/` is an abandoned Windows/WSL setup (also ignored); don't revive it.
