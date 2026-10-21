# Music over RCS

Text "search" and a song name in Google Messages and get the audio file back, with its album art.

A personal bot that lives in your own "message yourself" chat. You text it a song, an album or an artist; it looks first in [Zemer](https://github.com/ZemerTeam/zemer-app)'s catalog (the albums and singles of the artists on Zemer's list, with no female singers; the audio comes from YouTube Music), and only when Zemer doesn't have it on [music-table.com](https://www.music-table.com) (a Jewish music blog that offers MP3 downloads of new singles on its release posts), and sends the file back over RCS. Every morning it can also send you what's new.

```text
you:  search yoely weiss shabbos
bot:  [the cover, with "Shabbos · Yoely Weiss" drawn under it]
      [Yoely Weiss — Shabbos.mp3, 4.4 MB]
```

## What you can text it

Every message starts with a command, so a song's name is never taken for one.

| Text | What you get |
| --- | --- |
| `search` and a song, like `search yoely weiss shabbos` | The song: its cover, then the audio file. Typos and missing apostrophes are fine (`search yoely wiess shabos`), and Hebrew and Yiddish titles are found by how you'd spell them in English (`search vnusni` for "ונתנו", `search elazar lipa'le` for "אלעזר ליפא׳לע"). |
| `search` and an artist, like `search lipa` or `search yoely weiss` | Their page: their five most played singles and their five newest albums, numbered, `more` for the next ones. A song on one of their albums is under that album, not listed on its own. |
| `search` and anything else, like `search shabbos` | The songs (🎵) and albums (💿) that have all your words, one message each to 👍, the albums numbered |
| `album` and a name, like `album a poshiter yid` | That album, **all of it as one zip** (`Artist - Album.zip`, with `01 Title.m4a`, `02 …` inside; up to 100 MB, which is nearly every album), with the cover first. Several that fit are listed to pick from. |
| `album` and an artist, like `album lipa` | All their albums, newest first, eight at a time |
| `zemer` and a song, like `zemer lipa vnusni` | The same as `search`, on Zemer alone: no falling back to music-table.com (`youtube` and `yt` still work too) |
| `trending` | What's popular on music-table.com right now |
| `new` | The newest releases |
| `chanukah`, `purim`, `wedding` or `vocal` | That list, most popular first |
| `more` | The next ten of the last list |
| 👍 on a song (🎵) or an album (💿) in a list or the daily message | That song, or that album as one zip. 👍 several and their audio files come 5 seconds apart, so the phone keeps up. |
| An album's number, like `2` | That album's songs, numbered as on the album: 👍 the ones you want (or text a song's number), or 👍 the album line at the top for all of it as a zip |
| `all` | Every song on the last list (up to 20), with 5 seconds between audio files |
| `follow shwekey` | New songs by that artist as soon as they're out (`following` lists them, `unfollow shwekey` stops) |
| `help` | A reminder of all this |

Each morning (09:00 unless you change it) it sends a **daily new-music message**: one picture of the new releases' covers, then a line for each. It sends names and pictures, not songs; 👍 the ones you want, or text `all`.

**Artists you follow** don't wait for the morning: a new song by one of them comes on its own within about 15 minutes of going up (between 22:00 and 07:00 it waits for the morning). After you've had three songs by an artist, the bot follows them for you and says so.

**It knows the calendar.** Around Chanukah and Purim the lists point you to `chanukah` and `purim`; during Sefirah and the Three Weeks they point you to `vocal`, and the daily message puts the a cappella songs first.

## What it does behind the scenes

- **Zemer first, music-table.com behind it.** Zemer's catalog has whole albums as well as singles, so a search asks it first and takes what it finds there whenever it has the song; music-table.com, which mostly has new singles, answers only what Zemer doesn't have. Everything from Zemer is checked against Zemer's artist list again, on the bot's side, when it is found and again when it is sent.
- **Knows the whole site.** On its first run it reads all of music-table.com (about 3,600 posts: 5,000+ songs by 1,000+ artists) into a local catalog, in the background, and then keeps it current every three hours, for its lists and the daily message.
- **Answers while it sends.** A request made while a song or album is on its way is answered at once if the answer is text (a list, an album's songs); any songs you ask for meanwhile come after the ones already on their way, in the order you asked.
- **Saves what it sends.** Once a OneDrive app is set up ([How it runs](docs/cloud.md), step 5; it is on the live bot), every song it sends is also uploaded in the background to your OneDrive, sorted like a music library, `Artist/Album/01 Title.mp3` (a single goes in `Artist/Singles/`), with tags to match (artist, album, track number, title, cover); the file you get is named `Artist - Title.mp3`. The host has no disk to keep songs on, so without OneDrive nothing is saved. (A copy run on a computer with a disk can instead keep popular songs ready ahead of time and move them to an external drive: see [The library](docs/library.md).)
- **Forgiving search.** Apostrophes are optional ("vnusni" finds "V’Nusni"), a longer word may be a letter or two off, part of the artist's name is enough, and a word typed in English letters matches a Hebrew or Yiddish title it can be read as. When a request doesn't match exactly on music-table.com, it tries the request with each word left out and learns how the site spells your words from the titles around them.
- **Polite to the site.** It identifies itself, paces its requests, and remembers what it learned so it doesn't ask twice.
- **Tells you when something breaks.** The chat can't carry news of its own breakdown, so an email says when Google Messages is logged out of the bridge, your phone can't be reached, RCS is off, or the bridge, the homeserver or the site stops answering, or the host itself stops, or your chat was deleted on the phone and the bot has no room to answer in (it waits for you to choose the chat again instead of crashing), and again when it's fixed.

## How it reaches your phone

```text
your phone ── Google Messages (RCS) ── mautrix-gmessages bridge ── Matrix (Synapse) ── this bot ── Zemer (audio from YouTube Music) / catalog / music-table.com
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
| [Zemer and YouTube Music](docs/youtube-music.md) | Zemer's catalog and how a search reads it, Zemer's artist list and how it stays current, where the audio comes from, the order of the sources, and what breaks it |
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
- **Four unofficial pieces.** The bridge reverse-engineers Google Messages for web, the site lookups use music-table.com's own page API, the searches use the service the Zemer app searches with (search.zemer.io), and the audio comes from YouTube Music's app API. A change on any side can break things; the rest keeps working.
- **Your phone must be on and online.** The bridge works through your phone's Google Messages. The bot itself runs on Render and doesn't need your computer; on the free plan a restart or a deploy takes it away for about a minute (texts sent meanwhile are answered when it is back).

## License

[MIT](LICENSE).

## Development

```bash
npm test             # 900+ tests, no network: mocks of a Matrix homeserver, music-table.com, Beeper and Google's API
npm run typecheck
```

Node 22.18 or newer (developed on 24). There are no runtime dependencies: it uses `node:sqlite`, `node:http` and the built-in `fetch`, and runs TypeScript directly. See [Architecture](docs/architecture.md).
