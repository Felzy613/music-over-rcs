# Troubleshooting

Start with `npm run stack -- status` (what's running) and the bot's log: `npm run stack -- logs bot` follows it, or open `~/Library/Application Support/music-over-rcs/logs/bot.log`. The log has a `<-` line for every request the bot picks up and an `->` line for every song or announcement it sends. `npm run library -- status` lists anything the bot currently thinks is wrong, under `health:`.

## Mac notifications

The bot shows a notification titled **Music over RCS** when something it depends on breaks, and again when it's fixed. What each one means:

| Notification | What to do |
| --- | --- |
| Google Messages is logged out of the bridge | `npm run matrix-console`, then `login google`, and follow the bridge's steps (the same as the first time) |
| This Mac has no internet | The Mac can't reach the internet, even if Wi-Fi shows connected: usually the router's or the provider's connection is down, so restarting the modem and router is the fix. Texts you send meanwhile aren't lost: the bridge picks them up within a minute of the internet coming back, and the bot answers them. (Said after ten minutes, and only once.) |
| The bridge can't reach Google Messages | The internet works but the bridge can't get through to Google. With "phone" in the reason, open Google Messages on the phone; otherwise `npm run stack -- restart` if it lasts. (Short drops are normal and aren't reported; this one has lasted 15 minutes.) |
| RCS chats are off on your phone | Google Messages → Settings → RCS chats → on. Without RCS, files this size can't be sent. |
| The Google Messages bridge isn't answering | `npm run stack -- start` (or `npm run stack -- status` to see what stopped) |
| The bot can't reach the Matrix homeserver | `npm run stack -- start` |
| The drive for … has been away for a day; N songs wait on this Mac | Connect the drive (or check `SONGS_ARCHIVE_DIR`); the songs move within a minute. Nothing is lost meanwhile. |
| macOS won't let the bot use … | System Settings → Privacy & Security → Files and Folders: allow `node` to use removable volumes (or the drive's folder). |
| music-table.com isn't answering the bot | Usually the site is down or slow; songs already on your Mac still work. If it lasts, the reason in the notification helps, and `npm run music-table -- search <words>` shows what the site answers now. |

A problem that lasts is repeated every six hours. **No notifications at all?** macOS shows them from Script Editor (the bot uses `osascript`): System Settings → Notifications → Script Editor → Allow notifications.

## The bridge route

- **"Can't reach the Matrix homeserver":** Synapse isn't running: `npm run stack -- start`. Right after `stack restart` the bot may start a moment before Synapse; it restarts itself 15 seconds later.
- **A service sits at "loaded, not running", or starts and never logs anything:** it can't read its files. This happens when the services folder is under `~/Documents`, `~/Desktop` or `~/Downloads`, which macOS blocks for background jobs. Keep `MORS_HOME` elsewhere.
- **"The homeserver rejected the access token":** `npm run matrix-login` again.
- **The bot ignores code or `.env` changes:** it runs from a copy. `npm run stack -- restart`.
- **Can't find your chat:** `npm run matrix-rooms -- --phone <your number>`. If it finds none, text yourself once on the phone, wait a few seconds, try again. `npm run matrix-console` then `help` lists the bridge's commands.
- **Replies show up in Matrix but not on the phone:** the bridge only relays messages from users listed in `bridge.permissions` in `gmessages/config.yaml`; your Matrix ID must be there. Also check that the phone is online.
- **The bridge was logged out** (the bridge bot says so in `npm run matrix-console`): `login google` again.
- **Two answers to every message:** two bots are running. `npm run stack -- disable-bot` and stop any `npm run matrix` in a terminal, then enable one.
- **The audio doesn't arrive:** check the file is under `MAX_DOWNLOAD_MB` (and the homeserver's 100 MB upload limit), and that RCS chats are on: SMS/MMS can't carry files this size.

## Songs and lists

- **"I couldn't search music-table.com: …":** the message says why. If it says the site may have changed, `npm run music-table -- search <words>` shows what the site returns now.
- **A song you know is there isn't found:** try the artist and title as the site writes them, or fewer words. `npm run simulate:web` and **Behind the scenes** show what was searched and what the site listed.
- **An artist's name gives songs instead of their list:** the name fits several artists and none clearly has the most songs (like `weiss`). Use the full name.
- **`trending` or `new` say the catalog is still being filled:** the first run reads the whole site in the background (about 20 minutes). `npm run library -- status` shows how far it got; `npm run library -- scan` finishes it in about two minutes.
- **A number gets "tap 👍 on it":** lists have no numbers; tap 👍 on the song's own message. (With no list open, a number gets the help text.) Lists last, for `all`, half an hour ("Which one?"), two hours (`trending`, `new`, artists) or a day (the daily message), and a new search ends them.
- **A song name gets "To look for a song, start with "search"":** every message starts with a command now; send the line it suggests (`search` and the name).
- **A 👍 does nothing:** it works on messages that stand for one song: a list's options, the songs in the daily message (the picture or a song's line), and a new-song alert. On anything else a 👍 is just a reaction.
- **`chanukah`, `purim`, `wedding` or `vocal` is slow the first time:** it reads the whole category from the site once (a few seconds); after that it's instant.
- **`follow <name>` says it doesn't know the artist:** it only knows artists with songs in the catalog. Text the name alone first to see whether it's found, or try the name as the site writes it.
- **A one-letter message or a stray number** gets the help text, not a search.
- **"has no MP3 to download":** that post only has a video.

## Alerts for artists you follow

- **A new song didn't come:** alerts wait out the quiet hours (`QUIET_HOURS`, 22:00 to 07:00 by default), skip songs you already got and anything out before you followed the artist, and only cover posts from the last two days. `npm run library -- status` lists who you follow. New posts are noticed within about 15 minutes.
- **Too many:** `unfollow <name>`. Artists the bot followed for you are marked "(from your plays)" in `following`; after an unfollow it won't follow them again.

## The daily message

- **It didn't come:** `npm run library -- status` shows when it last went out and whether today counts as done. Nothing new means no message. The first day the bot runs, it waits for the next scheduled time. A sleeping Mac sends it when it wakes.
- **See it now:** `npm run library -- digest` (shows it) or `npm run library -- digest --send` (sends it).
- **Change the time or turn it off:** `DIGEST_TIME` in `.env`, then `npm run stack -- restart`.

## Beeper

- **"Can't reach Beeper Desktop":** the app isn't running, or its API is off (Settings → Developers).
- **"Beeper rejected the access token":** create a new one under Approved connections.
- **Your self-chat isn't listed:** connect the Google Messages account in Beeper, send yourself a message, then `npm run beeper-chats` without a filter.

## RCS for Business

- **`403 PERMISSION_DENIED` when sending:** the phone isn't a tester yet, hasn't accepted the invite, or has RCS chats off.
- **`400` mentioning `messageTrafficType`:** your agent is multi-use; set `RBM_MESSAGE_TRAFFIC_TYPE`.
- **The caption arrives but the audio doesn't:** `npm run catalog -- check`, then `npm run send-test -- <phone> --audio <url>`. Usual causes: not an `audio/*` content type, not MP3/AAC/OGG, over 100 MiB, or a host that blocks Google's fetcher. Google caches by URL, so a changed file needs a new URL.
- **Webhook verification fails:** `RBM_CLIENT_TOKEN` must match the console exactly; restart after editing `.env`.
