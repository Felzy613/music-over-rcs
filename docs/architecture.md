# Architecture

TypeScript on Node 22.18+, run directly (no build step), with **no runtime dependencies**: `node:sqlite` for the catalog, `node:http` for servers, the built-in `fetch` for everything else.

## The path of a message

In production the homeserver, the bridge and the bot run together in one container on Render ([How it runs](cloud.md)); the path below is the same wherever they run.

```text
phone ──RCS──> Google Messages ──> mautrix-gmessages ──> Synapse room ──> MatrixClient.listMessages()
                                                                               │
                                                  runner (one chat; a long poll: the homeserver answers when a text comes)
                                                                               │  a command, or a 👍
                                                                              bot
                                                    ┌──────────────────────────┼───────────────────────────┐
                                           Zemer (search.zemer.io)     catalog + music-table.com         lists
                                           menu: artists, albums, songs  when Zemer has nothing          trending / new / artist
                                                    └──────────────────────────┼───────────────────────────┘
                                                     views (catalog): the menu on screen, and the ones before it
                                                                        replies: image, text, audio, album
                                                                               │
                                                     runner: image fetch, audio from disk or download, send
                                                                               │
                                                     MatrixClient.sendImage / sendText / sendAudio ──> bridge ──> phone
```

- **`bot`** decides what to answer. It knows nothing about chat platforms: it takes a message (text, or a postback: `play:42`, `artist:<id>`, `album:<id>`, `tracks:<id>`, `single:<id>`, `zip:<id>`, `view:<id>`, `mtartist:<id>`, `post:<slug>` or `all:…`, any of them with `@<view>` after it) and returns replies: `text` (a menu line standing for a song, album or artist, or a menu's closing line carrying the menu as its options), `image` (a cover, with the song's name to draw on it, maybe a `better` one on its way), `collage`, `audio` (maybe with an `after` to wait for before tagging), `album` (songs to send as one zip). **A search is a menu** (the owner's design, 2026-10-20): up to 5 artists, 5 albums (numbered) and 5 songs, ranked by `src/ranking.ts`, written by `src/menu.ts`, one message per line, nothing picked or sent on its own. Each menu, artist page, album and list is a **view** (`src/views.ts`, the `views` table): what it is of, and every line it has shown. `songs more` (and `albums more`, `artists more`) asks the source again (its answers are kept 10 minutes), leaves out what the view has shown and shows the next 8; a view without that kind passes it to the one it was opened from. A line's postback names its view (`play:42@41`), so a 👍 on a line of an older menu makes that menu current again. An answer that changes the current view without showing a list carries that view's options (a text with chips and no words), so a number picks from the menu now on screen.
- **`runner`** connects the bot to one chat on a platform: it reads new messages (a long poll where the chat can: `MATRIX_SYNC_WAIT_MS`, which an announcement or stop ends), skips its own (🎵, 💿, 🎤, 📦, or the invisible mark a menu's closing line starts with), handles 👍, `all` and numbers (an album's, or a song's in an album, where a 👍 picks; every line's where a 👍 can't reach the bot), shows "typing…", prepares pictures and files (songs download ahead; an album's three at a time, each to disk as it comes, fewer when memory is short or after YouTube turned the relay away) and sends replies in order. A menu's options apply when the answer is decided, not when it has been sent, and only an answer with options of its own replaces them. Each request leaves a `timeline:` line (`src/timeline.ts`), each song a `song:` line and each album an `album:` line; with the bridge's status events on (the cloud host), a request's line waits for Google's word that its messages arrived. A text answer goes out at once; an answer with a song, picture or album waits in a queue of such answers (one at a time, in the order asked) that the poll doesn't wait for, so a request made while a song or album is on its way is answered then and not after it. Where a 👍 can't reach the bot it numbers a list and folds it back into one message. It also sends messages the bot starts itself (`announce`, used by the daily message), never in the middle of answering a request.
- **Transports** implement `ChatClient` (`listMessages`, `sendText`, `sendAudio`, optional `sendImage`, `sendFile` (the album zip), `setTyping`): `src/matrix/` (the bridge route), `src/beeper/`, and the simulator's `SimulatedChat`. The RCS for Business route (`src/rbm/`, `src/handler.ts`, `src/server.ts`) is a webhook server that uses the bot directly.

## Code layout

```text
src/bot.ts              what to answer: commands, postbacks, menus (Zemer first, then music-table.com), artists' pages, albums, paging, going back, lists, follow / unfollow
src/ranking.ts          a menu's order: artists (exact, then started, then a typo away), songs (named, then every word in the title, then only with the artist; most played first), albums (named, then newest; editions folded)
src/menu.ts             a menu's lines (🎤, 💿 numbered, "Title — Artist"), its closing line, and the help
src/views.ts            the chat's views (menus, artists, albums, lists), which one is current, and postbacks with a view in them
src/timeline.ts         where a request's time goes, one line for the log and /status
src/runner.ts           watches one chat and answers it; 👍, numbers (albums', or every line's where 👍 can't reach), album zips from disk, songs spaced out, typing, announcements, safety limits
src/catalog.ts          the SQLite catalog: songs, artists, site posts, plays, kept songs, follows, state
src/health.ts           problem reports when something breaks (mailed by the cloud host; a notification on a Mac); the bridge's login status, and when to restart it
src/bridge-restart.ts   restarts the bridge when its Google Messages session goes stale (a signal to the host's supervisor; launchd on a Mac)
src/extensions.ts       add-ons kept outside this repository (extensions/): loading, starting and stopping them
src/artists.ts          splits "A, B & C Ft. D" into artists
src/query.ts            words of a request ("play", "send me", "by" dropped)
src/audio-check.ts      checks a link: reachable, audio, within the size limit
src/audio-fetch.ts      downloads a direct audio link as one Blob, gathered in pieces of about 4 MB (a Blob of Blobs shares their data), within the size limit
src/image-fetch.ts      downloads album art (with a small memory)
src/library/compose.ts  draws pictures with macOS's own graphics (AppKit through osascript): no dependencies; on the Linux host a card falls back to the plain cover and the daily collage is skipped
src/library/zip.ts      writes a ZIP (files stored as they are, UTF-8 names) for albums: no dependencies; each song is written to disk with its checksum as it arrives and the zip is made of the files on disk
src/library/images.ts   a song's card (cover + name) and the daily collage (the new covers in a grid)
src/sources/            zemer.ts: Zemer's catalog (search.zemer.io: search, artists' pages, albums) and the bot's first place to look; music-table.com: the client, the lookup; relevance.ts: what fits a request, spelling, and English spellings read against Hebrew letters; youtube-music.ts: YouTube Music's app API (stream links, download, and its own search for when Zemer can't be reached); zemer-whitelist.ts: Zemer's artist list, kept current; songs.ts: puts the sources together the same way for every entry point
src/library/            sync and full scan, songs kept ready, the daily message, lists, background jobs, and:
  categories.ts         holiday and other category lists (by the site's own category names)
  category-list.ts      which categories, and the words that ask for them
  follows.ts            following artists, and following them for you after three of their songs
  naming.ts             each song's name and place: Artist/Album/01 Title.mp3, and "Artist - Title.mp3" when sent
  id3.ts                the tags inside an MP3 (ID3v2.3): written to match, the audio untouched, no dependencies; `writeTagsToBlob` puts the new tag in front of the original audio as a slice of the same Blob, so a song is never read or copied to be tagged
  mp4.ts                the tags inside an M4A (iTunes-style ilst), moving the index's pointers into the audio; a fragmented M4A (YouTube's) put back together first
  seasons.ts            Chanukah, Purim, Sefirah and the Three Weeks, from the Jewish calendar
src/matrix/             Matrix client, and joining a pasted multi-line command for the console
src/beeper/             Beeper Desktop API client
src/rbm/                RCS for Business client, auth and webhook verification
src/simulator/          the browser simulator: server, page, simulated chat, step-by-step trace
src/matrix-main.ts      starts the bot on the bridge route: assembles everything (npm run matrix; the cloud host loads it from cloud-main.ts)
src/beeper-main.ts      starts the Beeper route   (npm run beeper)
src/main.ts, server.ts  the RCS for Business webhook server (npm start)
src/simulate*.ts        the terminal and browser simulators
scripts/                command-line tools: catalog, library, music-table, cloud-check, beeper-*, send-test, invite-tester
src/cloud-main.ts      the cloud host's entry: the web door (/healthz, /ping, /status, /pair, /admin/*), signing in, then matrix-main.ts
src/cloud/              the host's parts: boot (the start-up sequence), supervise (keeps the processes running; the lease client), lease and s3 (the lease in R2), provision (Synapse's and the bridge's settings), front-door (the web port, open from the first moment), web, pairing, room (what to do when the chat's room is gone), memory (who holds the container's memory), youtube-relay (YouTube songs by way of the Worker, through the bucket), check
src/alert.ts            problems left as files in the bucket's alerts/ folder, for the Worker to mail
src/archive/            saving each sent song to OneDrive (onedrive.ts: Microsoft's device-code sign-in and upload sessions; archiver.ts: the queue, the memory guard, the monthly allowance)
src/startup-message.ts  the one hello in the chat when the cloud bot first comes up
deploy/cloud/           entrypoint.ts (the container's PID 1) and litestream.yml (the database backups)
cloudflare/             the Worker: every five minutes it checks the host, keeps it awake and mails the alerts
Dockerfile, render.yaml the image (Synapse, the bridge, Litestream, Node) and the Render service
test/                   unit and end-to-end tests, with mock servers in test/helpers/
```

## The catalog database

One SQLite file (WAL mode, shared safely by the bot and the command-line tools):

| Table | Holds |
| --- | --- |
| `tracks` (+ `tracks_fts`) | Songs: title, artist credit, URL (unique), album art, source post, release date. Full-text search over title and artist; when that finds nothing, a looser pass over every song (apostrophes, typos: `rankSongs` in `src/sources/relevance.ts`). |
| `artists`, `artist_tracks` | Artists split out of credits, and which songs each is on |
| `site_posts` | music-table.com releases: title, kind, the site's categories, publish date, views, picture, number of MP3s, when first seen, when in a daily message, when in an alert |
| `plays` | Every song sent, with its time |
| `follows` | Artists you follow (or unfollowed, so they're never followed for you again), whether by your choice or from your plays, and since when |
| `audio_cache` | Songs kept on disk, for a bot on a computer with a disk (the cloud host keeps none): the file (a name in the cache folder, or its full path once moved to `SONGS_ARCHIVE_DIR`), type, size, last used |
| `message_links` | Messages that stand for something (a song, album, artist, menu: their postback, with its view), for 👍, kept a month |
| `views` | Every menu, artist page, album and list shown: what it is of, the view it was opened from, every line it showed (with its postback and number), the last "… more"; ids never reused, a month unused or past the newest 300 cleared out |
| `state` | Small facts: last sync, scan progress, the daily message's date, the current view (`chat.view`), the options on offer (`chat.choices`) |

## Background jobs

`LibraryJobs` runs inside the bot, checking once a minute, one thing at a time: the sync every three hours, songs kept ready (after each sync and when the bot starts), a look at the RSS feed every 15 minutes while you follow anyone (a sync when it shows something new), the daily message when it's due, alerts for new songs by artists you follow (outside the quiet hours), and the one-time scan of the whole site, a few pages per round. Its state lives in the catalog, so a restart picks up where it was.

`Health` collects problems and reports them, once when they start, every six hours while they last, and when they're fixed: on the cloud host as a file in the bucket's `alerts/` folder that the Worker mails (`src/alert.ts`), on a Mac as a notification (`osascript`). It's told about them by the runner (the homeserver, or Beeper, not answering), the jobs (the site failing twice in a row), `BridgeWatch`, which asks the bridge's provisioning API every five minutes how the Google Messages login is doing, `RoomWatch` (`src/cloud/room.ts`), which treats a chat room the homeserver has forgotten as "waiting for a chat to be chosen" instead of a failed start, and the OneDrive archive (a sign-in lost). `watchJoinedRoom` (in `src/matrix-main.ts`) has the running bot check its room every five minutes and exit when it is gone, so the host's next start lands in that waiting state. `MemoryWatch` (`src/cloud/memory.ts`, started by `cloud-main.ts`) only logs and reports in `/status`; it raises no alert.

## Safety rails

- Every bot message starts with 🎵, or 💿 (an album line), 🎤 (an artist) or 📦 (an album's zip); the one exception is a menu's closing line ('Text "songs more" for 8 more songs…'), which starts with an invisible left-to-right mark (`HINT_MARK`) because it isn't a song. Add-on relays start with 🤖. The runner never answers a message that starts with any of these, or one it sent itself.
- At most 30 answers a minute (a loop shows as answer after answer; a long list, like an album's 50 songs, is one answer and goes out whole, up to 200 messages); a word-for-word repeat within 20 seconds is answered once. The homeserver's own message limit is lifted (`rc_message` in `src/cloud/provision.ts`): its default, a message every 5 s after a burst of 10, made a long list arrive over minutes.
- Downloads are refused unless they're audio and within the size limit; links to web pages are rejected.
- The site client paces its requests and remembers answers; download hosts must be the site's own over HTTPS.
- The simulator listens on 127.0.0.1 and refuses other hosts and requests without its header. The cloud host's web door listens on every interface because Render must reach it: `/healthz` and `/ping` are open, everything else needs `ADMIN_TOKEN`; Synapse and the bridge listen on 127.0.0.1 inside the container.

## Tests

```bash
npm test
npm run typecheck
```

About 950 tests (949 on 2026-10-21), `node:test`, no network. The menus are checked against what Zemer really answered for "achas", "lipa schmeltzer" and "forever" (`test/fixtures/zemer`, served as they are by the Zemer mock's raw mode, with Zemer's real artist list for those artists): `test/helpers/` has mock servers for a Matrix homeserver (with reactions and uploads), music-table.com (search box and search page, release pages, lists by page, category and sort, feed, releases for sale, download links that redirect to storage), YouTube Music (search, session ids, the player with retired client versions, media links that want the client's User-Agent and a Range header), Zemer's catalog (search sorted into kinds, artists' pages, albums, with the marks Hebrew titles carry), Zemer's content server (the artist list and its version, blocked songs), Beeper and Google's RBM API, and a music file host. The library tests run the schedule on a fake clock (the first day, a host that was down at 09:00, retries, quiet hours), and the seasons are checked against real dates.

## Extending

- **Another chat platform:** implement `ChatClient` beside `src/matrix/` and `src/beeper/`, then start a runner with it.
- **An add-on kept elsewhere:** a folder in `extensions/` (git ignores it, so it can be a repository of its own) whose `index.ts` default-exports an `ExtensionSetup` (see `src/extensions.ts`). It can take messages that start with its own word, get the pictures sent from the phone, send into the chat and put reactions on messages. The bridge route loads it at start (the cloud image does not include `extensions/`, so it runs only where the bot runs from a checkout), and `npm test` and `npm run typecheck` include it.
- **Another place to find music:** implement `TrackSource` (`name`, `lookup(query, limit)`) beside `src/sources/music-table.ts`, or `Finder` (songs, albums and artists at once, like `src/sources/zemer.ts`), and put it together in `songSources` (`src/sources/songs.ts`). Its tracks go into the catalog like any others; if their addresses need turning into a download link, wrap the audio check and download the way `resolvingYouTubeAudio` does.
