# Troubleshooting

Start with `npm run stack -- status` (what's running) and the bot's log: `npm run stack -- logs bot` follows it, or open `~/Library/Application Support/music-over-rcs/logs/bot.log`. The log has a `<-` line for every request the bot picks up and an `->` line for every song or announcement it sends.

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
- **A number gets "Text me a song name…":** no list is open. Lists last half an hour ("Which one?"), two hours (`trending`, `new`, artists) or a day (the daily message), and a new song name ends them.
- **A 👍 does nothing:** it works on the songs in the daily message (their picture or numbered line). On anything else a 👍 is just a reaction.
- **A one-letter message or a stray number** gets the help text, not a search.
- **"has no MP3 to download":** that post only has a video.

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
