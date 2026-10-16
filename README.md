# Music over RCS

Text "search" and a song name in Google Messages and get the audio file back, with its album art.

A personal bot that lives in your own "message yourself" chat. You text it a song or an artist; it finds the music in its catalog, on YouTube Music (through the same app API as the [Zemer](https://github.com/ZemerTeam/zemer-app) app, and only artists on Zemer's list, with no female singers) or on [music-table.com](https://www.music-table.com) (a Jewish music blog that offers MP3 downloads on its release posts) and sends the file back over RCS. Every morning it can also send you what's new.

```text
you:  search yoely weiss shabbos
bot:  [the cover, with "Shabbos · Yoely Weiss" drawn under it]
      [Yoely Weiss — Shabbos.mp3, 4.4 MB]
```

## What you can text it

Every message starts with a command, so a song's name is never taken for one.

| Text | What you get |
| --- | --- |
| `search` and a song, like `search yoely weiss shabbos` | The song: its cover with its name drawn on, then the audio file. Typos and missing apostrophes are fine (`search yoely wiess shabos`, `search lipa vnusni` for "V’Nusni"). |
| `search` and an artist, like `search shwekey` or `search avraham fried` | Their releases, newest first, ten at a time (an album is one entry) |
| `youtube` and a song, like `youtube lipa vnusni` (also `yt`) | The same, but on YouTube Music alone: no falling back to music-table.com, and YouTube Music's own ranking (`search` only takes songs that have all your words) |
| `album` and a name, like `album yu di kenst` or `album michoel schnitzler` (a plain `search` also says when your words match an album) | The album: one match is sent at once, several are listed to pick from with 👍. You get **all of it as one zip** (`01 Title.m4a`, `02 …`), with the cover first. |
| `trending` | What's popular on music-table.com right now |
| `new` | The newest releases |
| `chanukah`, `purim`, `wedding` or `vocal` | That list, most popular first |
| `more` | The next ten of the last list |
| 👍 on a song in a list or the daily message | That song. Lists have no numbers; 👍 several and their audio files come 5 seconds apart, so the phone keeps up. |
| `all` | Every song on the last list (up to 20), with 5 seconds between audio files |
| `follow shwekey` | New songs by that artist as soon as they're out (`following` lists them, `unfollow shwekey` stops) |
| `help` | A reminder of all this |

Each morning (09:00 unless you change it) it sends a **daily new-music message**: one picture of the new releases' covers, then a line for each. It sends names and pictures, not songs; 👍 the ones you want, or text `all`.

**Artists you follow** don't wait for the morning: a new song by one of them comes on its own within about 15 minutes of going up (between 22:00 and 07:00 it waits for the morning). After you've had three songs by an artist, the bot follows them for you and says so.

**It knows the calendar.** Around Chanukah and Purim the lists point you to `chanukah` and `purim`; during Sefirah and the Three Weeks they point you to `vocal`, and the daily message puts the a cappella songs first.

## What it does behind the scenes

- **Knows the whole site.** On its first run it reads all of music-table.com (about 3,600 posts: 5,000+ songs by 1,000+ artists) into a local catalog, in the background, and then keeps it current every three hours. Most requests are answered from the catalog without searching the site.
- **Saves what it sends.** With a OneDrive app set up ([How it runs](docs/cloud.md), step 5), every song it sends is also uploaded in the background to your OneDrive, sorted like a music library, `Artist/Album/01 Title.mp3` (a single goes in `Artist/Singles/`), with tags to match (artist, album, track number, title, cover); the file you get is named `Artist - Title.mp3`. The host has no disk to keep songs on, so without OneDrive nothing is saved. (A copy run on a computer with a disk can instead keep popular songs ready ahead of time and move them to an external drive: see [The library](docs/library.md).)
- **Forgiving search.** Apostrophes are optional ("vnusni" finds "V’Nusni"), a longer word may be a letter or two off, and part of the artist's name is enough. When a request doesn't match exactly, it tries the request with each word left out and learns how the site spells your words from the titles around them.
- **Polite to the site.** It identifies itself, paces its requests, and remembers what it learned so it doesn't ask twice.
- **Tells you when something breaks.** The chat can't carry news of its own breakdown, so an email says when Google Messages is logged out of the bridge, your phone can't be reached, RCS is off, or the bridge, the homeserver or the site stops answering, or the host itself stops, and again when it's fixed.

## How it reaches your phone

```text
your phone ── Google Messages (RCS) ── mautrix-gmessages bridge ── Matrix (Synapse) ── this bot ── catalog / YouTube Music / music-table.com
                                         └─────── one Docker container on Render's free plan, backed up to Cloudflare R2 ───────┘
                                           a Cloudflare Worker keeps it awake, watches it and emails problems
```

The bridge connects your Google Messages account to a Matrix homeserver in the same container; each conversation becomes a Matrix room. The bot is a Matrix client that watches one room, your chat with your own number, and answers in it as you, so its replies show up as messages you sent yourself. [How it runs](docs/cloud.md) has the details.

There are three ways to run it:

| | `mautrix/gmessages` bridge on Render (how it runs) | Beeper | RCS for Business agent |
| --- | --- | --- | --- |
| Cost | Free: Render's free plan, and the Cloudflare Workers plan you may already have | Free | Tester mode is free, but creating an agent needs Google partner access |
| Setup | A Render service, a Cloudflare bucket and Worker, then a Google login on a web page | Beeper Desktop and a token | Partner account, agent, webhook, public HTTPS |
| Where you chat | Your own "message yourself" chat | Same | A separate chat with the agent |
| Album art, daily message, lists | Yes | Yes | Not wired in |
| Official? | No: the bridge reverse-engineers Google Messages for web | No: the same kind of bridge | Yes |

## Get started

- **Try it in your browser first**, no accounts needed: `npm install`, then `npm run simulate:web -- --open`. A Google-Messages-style chat runs the real bot against the real site and shows every step it takes. See [the simulator](docs/simulator.md).
- **Set it up for your phone** (a Render account, a Cloudflare account, and an Android phone with Google Messages and RCS on): [How it runs](docs/cloud.md), steps 1 to 7. Most of the time is waiting for the first build and for the bridge to make its rooms.

## Documentation

| Guide | What's in it |
| --- | --- |
| [Using the bot](docs/using-the-bot.md) | Everything you can text, what the answers look like, the daily message, 👍, following artists, holiday lists |
| [The library](docs/library.md) | The catalog, the site sync and full scan, songs kept ready, the daily message, alerts, `npm run library` |
| [YouTube Music](docs/youtube-music.md) | What it asks YouTube Music for, Zemer's artist list and how it stays current, what you get, the order of the sources, and what breaks it |
| [music-table.com](docs/music-table.md) | How the site is used, how matching and spelling fixes work, how it behaves toward the site |
| [The simulator](docs/simulator.md) | Trying the bot in a browser or a terminal |
| [Configuration](docs/configuration.md) | Every setting in `.env` |
| [How it runs](docs/cloud.md) | The Render service and the Cloudflare Worker and bucket: how it fits together, setting it up, linking Google Messages, saving songs to OneDrive, deploying, day to day, what has been proven |
| [Other routes](docs/other-routes.md) | Beeper, and an RCS for Business agent |
| [Architecture](docs/architecture.md) | How the code fits together, the database, the background jobs, the tests |
| [Privacy and security](docs/privacy-and-security.md) | What's stored where, what the bridge copies, what leaves the host, keeping secrets out of git |
| [Troubleshooting](docs/troubleshooting.md) | When something doesn't work, and what the alert emails mean |

## Good to know

- **It's for personal use.** The songs are the files music-table.com offers for download and the audio YouTube Music streams to its app. Whether you may keep or share them is between you and the rights holders; this project only fetches what you ask for, into your own chat. YouTube's terms don't allow fetching its streams outside its own apps. The YouTube videos in music-table.com's posts are still ignored; YouTube Music is a separate source.
- **Three unofficial pieces.** The bridge reverse-engineers Google Messages for web, the site lookups use music-table.com's own page API, and the YouTube Music lookups use its app API. A change on any side can break things; the rest keeps working.
- **Your phone must be on and online.** The bridge works through your phone's Google Messages. The bot itself runs on Render and doesn't need your computer; on the free plan it can be slow after a restart (about a minute and a half).

## License

[MIT](LICENSE).

## Development

```bash
npm test             # 770+ tests, no network: mocks of a Matrix homeserver, music-table.com, Beeper and Google's API
npm run typecheck
```

Node 22.18 or newer (developed on 24). There are no runtime dependencies: it uses `node:sqlite`, `node:http` and the built-in `fetch`, and runs TypeScript directly. See [Architecture](docs/architecture.md).
