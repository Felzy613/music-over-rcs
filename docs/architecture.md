# Architecture

TypeScript on Node 22.18+, run directly (no build step), with **no runtime dependencies**: `node:sqlite` for the catalog, `node:http` for servers, the built-in `fetch` for everything else.

## The path of a message

```text
phone ──RCS──> Google Messages ──> mautrix-gmessages ──> Synapse room ──> MatrixClient.listMessages()
                                                                               │
                                                               runner (one chat, polls every 1.5 s)
                                                                               │  text, a number, or a 👍
                                                                              bot
                                                    ┌──────────────────────────┼───────────────────────────┐
                                             catalog (SQLite)          music-table.com lookup           lists
                                             exact song, artist        search → pick → read posts       trending / new / artist
                                                    └──────────────────────────┼───────────────────────────┘
                                                                        replies: image, text, audio
                                                                               │
                                                     runner: image fetch, audio from disk or download, send
                                                                               │
                                                     MatrixClient.sendImage / sendText / sendAudio ──> bridge ──> phone
```

- **`bot`** decides what to answer. It knows nothing about chat platforms: it takes a message (text, or a postback like `play:42`, `post:<slug>` or `all:…`) and returns replies: `text` (optionally with numbered options, or standing for one song), `image` (a cover, with the song's name to draw on it), `collage` (numbered covers), `audio`. A list is a heading, one text per entry, and a closing text with the options.
- **`runner`** connects the bot to one chat on a platform: it polls for new messages, skips its own (🎵), handles numbers, `all` and 👍, shows "typing…", prepares pictures and files (songs download ahead, at most three at once) and sends replies in order. Where a 👍 can't reach the bot it folds a list back into one message. It also sends messages the bot starts itself (`announce`, used by the daily message), never in the middle of answering a request.
- **Transports** implement `ChatClient` (`listMessages`, `sendText`, `sendAudio`, optional `sendImage`, `setTyping`): `src/matrix/` (the bridge route), `src/beeper/`, and the simulator's `SimulatedChat`. The RCS for Business route (`src/rbm/`, `src/handler.ts`, `src/server.ts`) is a webhook server that uses the bot directly.

## Code layout

```text
src/bot.ts              what to answer: songs, lists, choices, albums, follow / unfollow
src/runner.ts           watches one chat and answers it; numbers, 👍, typing, announcements, safety limits
src/catalog.ts          the SQLite catalog: songs, artists, site posts, plays, kept songs, follows, state
src/health.ts           Mac notifications when something breaks; the bridge's login status
src/artists.ts          splits "A, B & C Ft. D" into artists
src/query.ts            words of a request ("play", "send me", "by" dropped)
src/audio-check.ts      checks a link: reachable, audio, within the size limit
src/audio-fetch.ts      downloads a direct audio link into memory
src/image-fetch.ts      downloads album art (with a small memory)
src/library/compose.ts  draws pictures with macOS's own graphics (AppKit through osascript): no dependencies
src/library/images.ts   a song's card (cover + name) and the daily collage (numbered covers)
src/sources/            music-table.com: the client, the lookup, relevance and spelling
src/library/            sync and full scan, songs kept ready, the daily message, lists, background jobs, and:
  categories.ts         holiday and other category lists (learning the site's category ids)
  category-list.ts      which categories, and the words that ask for them
  follows.ts            following artists, and following them for you after three of their songs
  seasons.ts            Chanukah, Purim, Sefirah and the Three Weeks, from the Jewish calendar
src/matrix/             Matrix client, and joining a pasted multi-line command for the console
src/beeper/             Beeper Desktop API client
src/rbm/                RCS for Business client, auth and webhook verification
src/simulator/          the browser simulator: server, page, simulated chat, step-by-step trace
src/matrix-main.ts      starts the bridge route   (npm run matrix)
src/beeper-main.ts      starts the Beeper route   (npm run beeper)
src/main.ts, server.ts  the RCS for Business webhook server (npm start)
src/simulate*.ts        the terminal and browser simulators
scripts/                command-line tools: catalog, library, music-table, matrix-*, beeper-*, send-test, invite-tester
deploy/mac/             setup.sh (the installer) and stack (service control)
test/                   unit and end-to-end tests, with mock servers in test/helpers/
```

## The catalog database

One SQLite file (WAL mode, shared safely by the bot and the command-line tools):

| Table | Holds |
| --- | --- |
| `tracks` (+ `tracks_fts`) | Songs: title, artist credit, URL (unique), album art, source post, release date. Full-text search over title and artist. |
| `artists`, `artist_tracks` | Artists split out of credits, and which songs each is on |
| `site_posts` | music-table.com posts: title, category, the site's category ids, publish date, views, picture, number of MP3s, when first seen, when in a daily message, when in an alert |
| `plays` | Every song sent, with its time |
| `follows` | Artists you follow (or unfollowed, so they're never followed for you again), whether by your choice or from your plays, and since when |
| `audio_cache` | Songs kept on disk: the file (a name in the folder on the Mac, or its full path once moved to `SONGS_ARCHIVE_DIR`), type, size, last used |
| `message_links` | Messages that stand for one song (for 👍), kept a month |
| `state` | Small facts: last sync, scan progress, the daily message's date, the current list and its numbers |

## Background jobs

`LibraryJobs` runs inside the bot, checking once a minute, one thing at a time: the sync every three hours, songs kept ready (after each sync and when the bot starts), a look at the RSS feed every 15 minutes while you follow anyone (a sync when it shows something new), the daily message when it's due, alerts for new songs by artists you follow (outside the quiet hours), and the one-time scan of the whole site, a few pages per round. Its state lives in the catalog, so a restart picks up where it was.

`Health` collects problems and shows them as Mac notifications (`osascript`), once when they start, every six hours while they last, and when they're fixed. It's told about them by the runner (the homeserver, or Beeper, not answering), the jobs (the site failing twice in a row) and `BridgeWatch`, which asks the bridge's provisioning API every five minutes how the Google Messages login is doing.

## Safety rails

- Every bot message starts with 🎵; messages it sent itself, and anything starting with 🎵, are never answered.
- At most 30 messages a minute; a word-for-word repeat within 20 seconds is answered once.
- Downloads are refused unless they're audio and within the size limit; links to web pages are rejected.
- The site client paces its requests and remembers answers; download hosts must be the site's own over HTTPS.
- Servers (simulator, webhook) listen on 127.0.0.1; the simulator refuses other hosts and requests without its header.

## Tests

```bash
npm test
npm run typecheck
```

`node:test`, no network: `test/helpers/` has mock servers for a Matrix homeserver (with reactions and uploads), music-table.com (search, post list by category, category pages, feed, files, download links), Beeper and Google's RBM API, and a music file host. The library tests run the schedule on a fake clock (the first day, a Mac asleep at 09:00, retries, quiet hours), and the seasons are checked against real dates.

## Extending

- **Another chat platform:** implement `ChatClient` beside `src/matrix/` and `src/beeper/`, then start a runner with it.
- **Another place to find music:** implement `TrackSource` (`name`, `lookup(query, limit)`) beside `src/sources/music-table.ts`. Its tracks go into the catalog like any others.
