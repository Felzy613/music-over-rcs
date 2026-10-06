# The library: catalog, sync, songs kept ready, daily message

Everything the bot knows lives in one SQLite file, the **catalog** (`CATALOG_DB`; on a Mac set up with `npm run mac:setup` that's `~/Library/Application Support/music-over-rcs/catalog.db`). While the bot runs, it keeps the catalog in step with music-table.com, keeps popular songs downloaded, and sends the daily new-music message.

## What's in the catalog

| Kept | What for |
| --- | --- |
| **Songs**: title, artist credit, address, album art, the post it's from, release date | Answering requests without searching the site |
| **Artists**, split out of each credit ("Mendy Weiss, Yoely Davidowitz & Yoely Samuel" is three) | Artist lists |
| **Posts** from music-table.com: title, category, publish date, views, picture, how many MP3s | Trending, new, the daily message |
| **Plays**: each song sent to you, and when | Keeping your most played songs ready |
| **Songs kept ready**: which files are on disk, and when each was last used | Sending without downloading |
| **The current list and its numbers**, and which messages stand for which song | Numbers and 👍 working across restarts |

A site song is stored as a link to its post (`https://www.music-table.com/post/<name>#<n>`), never as the song's own download address: the site's download links expire, so a fresh one is asked for when the song is sent.

Your own songs can go in too: direct links to audio files you have the right to use, from a CSV (`title,artist,url`) or one by one:

```bash
npm run catalog -- import my-songs.csv
npm run catalog -- add "Song Name" "Artist Name" https://your-host.example/song.mp3
npm run catalog -- list | search <words> | remove <id> | check
```

Page links (a video site's watch page, say) are refused on purpose. `check` tests every URL (it skips music-table.com songs, which are checked when they're sent).

## Keeping up with the site

- **Sync, every three hours:** one request for the 50 newest posts (files, album art, view counts and dates included) and one for the RSS feed (category names). New MP3s become songs; view counts are refreshed, which is what keeps `trending` current. A failed sync is tried again an hour later.
- **The whole site, once:** on its first run the bot reads every post (about 3,600, in pages of 50), a few pages a minute in the background, and picks up where it left off after a restart. After that the sync keeps it current. `npm run library -- scan` reads it all at once, pausing a second between requests (about two minutes).

## Songs kept ready

Up to `PREFETCH_MB` (400 MB by default) of songs are kept on disk, in an `audio-cache` folder beside the catalog, so they're sent without downloading:

- **your most played songs** (from the plays above),
- **the five newest releases**, and
- **the month's most viewed songs** on the site, to fill the rest (25 songs at most).

They're downloaded after each sync, and once when the bot starts, one at a time with a pause between them. Every song you get is kept too. When the folder is full, the songs used least recently go first; the ones above are never removed to make room. A kept song is also sent without asking the site anything. `PREFETCH_MB=0` turns it off.

## The daily new-music message

At `DIGEST_TIME` (09:00 by default, your Mac's time) the bot syncs, then sends what was published since the last message: a heading, each new song or album with its picture and a number, the posts that are only videos, and a closing line. Replying with a number (all day) or a 👍 on a song gets that song. See [Using the bot](using-the-bot.md#the-daily-new-music-message).

- Nothing new, no message; the day still counts as done.
- The first time the bot runs with it on, it waits for the next scheduled time instead of sending in the middle of the day.
- A Mac asleep at the scheduled time sends when it wakes, once. A message that can't be sent is tried again after 30 minutes.
- `DIGEST_TIME=off` turns it off.

## Commands

```bash
npm run library -- status            # songs, artists, posts, what's kept ready, last sync and message
npm run library -- sync              # read the newest posts now
npm run library -- scan              # read the whole site now
npm run library -- prefetch          # sync, then download the songs worth keeping ready
npm run library -- digest            # show the daily message as it would go out now (nothing is sent)
npm run library -- digest --days 3   # the same, covering the last three days
npm run library -- digest --send     # send it to your chat now (MATRIX_ROOM_ID), exactly as the bot would
```

The bot does all of this on its own while it runs; these commands are for looking and trying. They share the catalog with the running bot safely. A message sent with `digest --send` works like the bot's own: its numbers and 👍 are answered by the running bot.
