# The library: catalog, sync, songs kept ready, daily message

Everything the bot knows lives in one SQLite file, the **catalog** (`CATALOG_DB`; on a Mac set up with `npm run mac:setup` that's `~/Library/Application Support/music-over-rcs/catalog.db`). While the bot runs, it keeps the catalog in step with music-table.com, keeps popular songs downloaded, sends the daily new-music message, and sends new songs by the artists you follow.

## What's in the catalog

| Kept | What for |
| --- | --- |
| **Songs**: title, artist credit, address, album art, the post it's from, release date | Answering requests without searching the site |
| **Artists**, split out of each credit ("Mendy Weiss, Yoely Davidowitz & Yoely Samuel" is three) | Artist lists |
| **Posts** from music-table.com: title, category, the site's category ids, publish date, views, picture, how many MP3s, whether it was announced | Trending, new, holiday lists, the daily message, alerts |
| **Plays**: each song sent to you, and when | Keeping your most played songs ready; following an artist after three of their songs |
| **Artists you follow**, whether you chose them or your plays did, and the ones you unfollowed | New-song alerts |
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
- **While you follow anyone, the feed every 15 minutes:** one small request for the RSS feed; when it shows a post the catalog doesn't have, a sync right away. That's what makes alerts quick. Following no one, this doesn't run.
- **A holiday list, the first time you ask:** the site lists posts by category id but names its categories only on their pages, so the bot reads the category's page once, looks at a few of its posts, and remembers the id they share (the rarest one, since almost everything is also "Singles"). Then it reads the whole category (up to 20 pages of 50; Weddings, the biggest, is about 340 posts) and, after that, the newest hundred at most once a day.

## Songs kept ready

Songs are kept on disk, in an `audio-cache` folder beside the catalog, so they're sent without downloading:

- **your most played songs** (from the plays above),
- **the five newest releases**, and
- **the month's most viewed songs** on the site, to fill the rest (25 songs at most).

They're downloaded after each sync, and once when the bot starts, one at a time with a pause between them. Every song you get is kept too, and a kept song is sent without asking the site anything.

**Nothing is ever removed: the folder has no size limit.** At the site's pace (about 50 new releases a month, 20 MB a song on average) it grows by roughly 1 to 1.5 GB a month, plus the songs you ask for. `npm run library -- status` shows its size. If you'd rather cap it, set `PREFETCH_MB` to a number of MB: then, when it's full, the songs used least recently go first, never the ones above. `PREFETCH_MB=0` keeps none.

## The daily new-music message

At `DIGEST_TIME` (09:00 by default, your Mac's time) the bot syncs, then sends what was published since the last message: a heading, one picture of the new covers in a numbered grid (drawn on your Mac), a line per song or album, the posts that are only videos, and a closing line. Replying with a number (all day), `all`, or a 👍 on a song's line gets it. See [Using the bot](using-the-bot.md#the-daily-new-music-message).

- Nothing new, no message; the day still counts as done.
- The first time the bot runs with it on, it waits for the next scheduled time instead of sending in the middle of the day.
- A Mac asleep at the scheduled time sends when it wakes, once. A message that can't be sent is tried again after 30 minutes.
- `DIGEST_TIME=off` turns it off.

## Alerts for artists you follow

Every minute the bot looks in the catalog for posts with music by an artist you follow that it hasn't announced yet. A post is announced when:

- it was published, and first seen by the bot, in the last two days, and after you started following the artist;
- you haven't had any of its songs already;
- it's not the quiet hours (`QUIET_HOURS`, 22:00 to 07:00 by default). Overnight posts go out when they end.

Each goes out as its card (the cover with the name drawn on) and a line, then one closing line; a number or 👍 gets the song, for a day. An album is announced once, and its number lists its songs. A post that couldn't be sent is tried again the next minute; one that was sent is marked so it's never announced twice. See [Using the bot](using-the-bot.md#following-artists).

## Health checks

The bot keeps an eye on the pieces it depends on and shows a **Mac notification** when one breaks, since it can't text you when the chat is what's broken:

| Check | How often | Notification |
| --- | --- | --- |
| The bridge's login to Google Messages (asked from the bridge on your Mac) | Every 5 minutes | Logged out (log in again); can't reach Google for 15 minutes or more (is the phone on?); RCS chats off on the phone; the bridge not answering |
| The Matrix homeserver | Every check of the chat | After 20 failed checks in a row (about five minutes, as the checks slow down while it fails) |
| music-table.com | Every sync | After two failed syncs in a row |

Each problem is shown when it starts, again every six hours while it lasts, and once more when it's fixed ("Fixed: …"). What's wrong right now also shows in `npm run library -- status` under `health:`. See [Troubleshooting](troubleshooting.md#mac-notifications).

## Commands

```bash
npm run library -- status            # songs, artists, posts, what's kept ready, last sync and message, who you follow, problems
npm run library -- sync              # read the newest posts now
npm run library -- scan              # read the whole site now
npm run library -- prefetch          # sync, then download the songs worth keeping ready
npm run library -- digest            # show the daily message as it would go out now (nothing is sent)
npm run library -- digest --days 3   # the same, covering the last three days
npm run library -- digest --send     # send it to your chat now (MATRIX_ROOM_ID), exactly as the bot would
```

The bot does all of this on its own while it runs; these commands are for looking and trying. They share the catalog with the running bot safely. A message sent with `digest --send` works like the bot's own: its numbers and 👍 are answered by the running bot.
