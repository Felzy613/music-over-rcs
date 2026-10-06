# Music over RCS

Text a song name in Google Messages and get the audio file back, with its album art.

A personal bot that lives in your own "message yourself" chat. You text it a song or an artist; it finds the music in its catalog or on [music-table.com](https://www.music-table.com) (a Jewish music blog that offers MP3 downloads on its release posts) and sends the file back over RCS. Every morning it can also send you what's new.

```text
you:  yoely weiss shabbos
bot:  [the cover, with "Shabbos · Yoely Weiss" drawn under it]
      [Yoely Weiss — Shabbos.mp3, 4.4 MB]
```

## What you can text it

| Text | What you get |
| --- | --- |
| A song, like `yoely weiss shabbos` | The song: its cover with its name drawn on, then the audio file. Typos are fine (`yoely wiess shabos`, `avrohom fried`). |
| An artist, like `shwekey` or `avraham fried` | Their releases, newest first, ten at a time (an album is one entry) |
| `trending` | What's popular on music-table.com right now |
| `new` | The newest releases |
| `chanukah`, `purim`, `wedding` or `vocal` | That list, most popular first |
| `more` | The next ten of the last list |
| A number, like `3` | That song from the last list (or from the daily message) |
| 👍 on a song in a list | That song |
| `all` | Every song on the last list (up to 20) |
| `follow shwekey` | New songs by that artist as soon as they're out (`following` lists them, `unfollow shwekey` stops) |
| `help` | A reminder of all this |

Each morning (09:00 unless you change it) it sends a **daily new-music message**: one picture of the new releases' covers, numbered, then a line for each. It sends names and pictures, not songs; reply with a number, `all`, or 👍 the ones you want.

**Artists you follow** don't wait for the morning: a new song by one of them comes on its own within about 15 minutes of going up (between 22:00 and 07:00 it waits for the morning). After you've had three songs by an artist, the bot follows them for you and says so.

**It knows the calendar.** Around Chanukah and Purim the lists point you to `chanukah` and `purim`; during Sefirah and the Three Weeks they point you to `vocal`, and the daily message puts the a cappella songs first.

## What it does behind the scenes

- **Knows the whole site.** On its first run it reads all of music-table.com (about 3,600 posts: 5,000+ songs by 1,000+ artists) into a local catalog, in the background, and then keeps it current every three hours. Most requests are answered from your Mac without searching the site.
- **Keeps popular songs ready.** Your most played songs, the newest releases and the month's most viewed songs are downloaded ahead of time, so they're sent without waiting for a download. Every song you get is kept too, with no size limit unless you set one. Songs always download to the Mac first; with `SONGS_ARCHIVE_DIR` set (a folder on an external drive, say), they move there whenever the drive is connected. Every song is sorted like a music library, `Artist/Album/01 Title.mp3` (a single goes in `Artist/Singles/`), with tags to match (artist, album, track number, title, cover), and the file you get is named `Artist - Title.mp3`.
- **Forgiving search.** When a request doesn't match exactly, it tries the request with each word left out and learns how the site spells your words from the titles around them.
- **Polite to the site.** It identifies itself, paces its requests, and remembers what it learned so it doesn't ask twice.
- **Tells you on the Mac when something breaks.** The chat can't carry news of its own breakdown, so a Mac notification says when Google Messages is logged out of the bridge, your phone can't be reached, RCS is off, or the homeserver, the bridge or the site stops answering, and again when it's fixed.

## How it reaches your phone

```text
your phone ── Google Messages (RCS) ── mautrix-gmessages bridge ── Matrix (Synapse) ── this bot ── catalog / music-table.com
                                         └──────────────── all on your Mac, listening on 127.0.0.1 only ────────────────┘
```

The bridge connects your Google Messages account to a Matrix homeserver running on your Mac; each conversation becomes a Matrix room. The bot is a Matrix client that watches one room, your chat with your own number, and answers in it as you, so its replies show up as messages you sent yourself.

There are three ways to run it:

| | `mautrix/gmessages` bridge (recommended) | Beeper | RCS for Business agent |
| --- | --- | --- | --- |
| Cost | Free, self-hosted | Free | Tester mode is free, but creating an agent needs Google partner access |
| Setup | One installer on a Mac, then a Google login | Beeper Desktop and a token | Partner account, agent, webhook, public HTTPS |
| Where you chat | Your own "message yourself" chat | Same | A separate chat with the agent |
| Album art, daily message, lists | Yes | Yes | Not wired in |
| Official? | No: the bridge reverse-engineers Google Messages for web | No: the same kind of bridge | Yes |

## Get started

- **Try it in your browser first**, no accounts needed: `npm install`, then `npm run simulate:web -- --open`. A Google-Messages-style chat runs the real bot against the real site and shows every step it takes. See [the simulator](docs/simulator.md).
- **Set it up for your phone** (Apple-silicon Mac, Android phone with Google Messages and RCS on): [Mac setup with the bridge](docs/setup-mac.md). In short:

```bash
npm install
npm run mac:setup                 # installs the homeserver and the bridge, in the background
npm run stack -- create-user      # your Matrix account
npm run matrix-login              # signs the bot in
npm run matrix-console            # type: login google  (follow the bridge's steps)
npm run matrix-rooms              # find your self-chat, put it in .env as MATRIX_ROOM_ID
npm run stack -- enable-bot       # always on, starts at login
```

## Documentation

| Guide | What's in it |
| --- | --- |
| [Using the bot](docs/using-the-bot.md) | Everything you can text, what the answers look like, the daily message, 👍, following artists, holiday lists |
| [Mac setup with the bridge](docs/setup-mac.md) | Installing, logging in to Google Messages, finding your chat, running it in the background |
| [The library](docs/library.md) | The catalog, the site sync and full scan, songs kept ready, the daily message, alerts, `npm run library` |
| [music-table.com](docs/music-table.md) | How the site is used, how matching and spelling fixes work, how it behaves toward the site |
| [The simulator](docs/simulator.md) | Trying the bot in a browser or a terminal |
| [Configuration](docs/configuration.md) | Every setting in `.env` |
| [Other routes](docs/other-routes.md) | Beeper, and an RCS for Business agent |
| [Architecture](docs/architecture.md) | How the code fits together, the database, the background jobs, the tests |
| [Privacy and security](docs/privacy-and-security.md) | What's stored where, what leaves your Mac, keeping secrets out of git |
| [Troubleshooting](docs/troubleshooting.md) | When something doesn't work, and what the Mac notifications mean |

## Good to know

- **It's for personal use.** The songs are the files music-table.com offers for download. Whether you may keep or share them is between you and the rights holders; this project only fetches what you ask for, into your own chat. It never downloads from YouTube or other streaming sites, and the YouTube videos in the posts are ignored.
- **Two unofficial pieces.** The bridge reverse-engineers Google Messages for web, and the site lookups use music-table.com's own page API. A change on either side can break things; the rest keeps working.
- **Your phone and your Mac must be on.** The bridge works through your phone's Google Messages, and the bot runs on the Mac.

## License

[MIT](LICENSE).

## Development

```bash
npm test             # 350+ tests, no network: mocks of a Matrix homeserver, music-table.com, Beeper and Google's API
npm run typecheck
```

Node 22.18 or newer (developed on 24). There are no runtime dependencies: it uses `node:sqlite`, `node:http` and the built-in `fetch`, and runs TypeScript directly. See [Architecture](docs/architecture.md).
