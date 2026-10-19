# Configuration

**The live bot's settings are Render's environment variables** ([How it runs](cloud.md#settings) lists the ones that matter there); changing one in Render restarts the service. The rest of this page lists every setting the code reads. A `.env` file in the project folder (copy `.env.example`) is only for running something on your own computer: the simulator, the tests, or the Beeper and RCS for Business routes. Real environment variables win over the file. `.env` holds access tokens, is in `.gitignore`, is created readable only by you, and should never be shared.

## The bridge route (Matrix)

| Variable | Needed | Meaning |
| --- | --- | --- |
| `MATRIX_HOMESERVER` | no (`http://127.0.0.1:8008`) | The Matrix homeserver. On Render the host sets it (Synapse inside the container). |
| `MATRIX_ACCESS_TOKEN` | yes | On Render the host signs the bot in itself and keeps the token in the catalog; set it only for a bot on your own computer. |
| `MATRIX_ROOM_ID` | yes | The room to watch: your chat with your own number. On Render you choose it on the `/pair` page (it finds the room by your phone number). |
| `MATRIX_POLL_MS` | no (`1500`) | How often to check the room, in milliseconds, 500 to 30000. |
| `BRIDGE_URL` | no (`http://127.0.0.1:29336`) | Where the bridge listens, for the health check of your Google Messages login. |
| `BRIDGE_AUTO_RESTART` | no (on) | Automatically restart the managed bridge after a network outage if it stays disconnected for two minutes, after a two-minute outage even if its status still says connected, or when it reports that a message couldn't be delivered (at most once per ten minutes; not when the phone is only slow to confirm one). Other connection failures restart after fifteen minutes. A bridge that stays down is restarted again five minutes after the first restart, then every ten minutes for as long as it lasts, since Google can turn it away for a while (a web filter's downtime, say) and the bridge doesn't retry by itself afterwards. One that is signed out of Google restarts after two minutes (unless Google says it unlinked the bridge, which a restart can't undo); one that doesn't answer, after two minutes too. Set to `off` to disable. |

## Beeper

| Variable | Needed | Meaning |
| --- | --- | --- |
| `BEEPER_ACCESS_TOKEN` | yes | A token from Beeper Desktop (Settings → Developers). |
| `BEEPER_CHAT_ID` | yes | The chat to watch; `npm run beeper-chats` lists them. |
| `BEEPER_API_URL` | no (`http://localhost:23373`) | Where Beeper Desktop's local API listens. |
| `BEEPER_POLL_MS` | no (`1500`) | How often to check the chat, 500 to 30000. |

## Music and the library (bridge and Beeper)

| Variable | Default | Meaning |
| --- | --- | --- |
| `CATALOG_DB` | `data/catalog.db` | The catalog file. On Render it is `/data/catalog.db`, backed up to R2 every minute. |
| `MAX_DOWNLOAD_MB` | `100` | Largest song to download and send, up to 500. (Google Messages and the bridge take about 100.) On Render it is 30, because a song is held in memory while it is fetched and tagged. |
| `MAX_ZIP_MB` | `100` | Largest an album's zip may be, from 1 to 100 (what the bridge and the homeserver take). An album is written to disk song by song and its zip streamed from there, so this doesn't depend on memory; a bigger album arrives as several zips, "(part 1 of 2)" and so on. |
| `YOUTUBE_MUSIC` | on | `off` stops all use of Zemer and YouTube Music (Zemer's songs are YouTube Music's). See [Zemer and YouTube Music](youtube-music.md). |
| `ZEMER_SEARCH` | on | `off` stops asking Zemer's catalog (`search.zemer.io`); searches then use YouTube Music's own search, with no artist pages. |
| `ZEMER_SEARCH_URL` | `https://search.zemer.io` | Where Zemer's catalog is asked; only the tests change it. |
| `YOUTUBE_MUSIC_URL` | `https://music.youtube.com` | Where the YouTube Music lookups go; only the tests change it. |
| `YOUTUBE_RELAY` | none (`r2` on the cloud host) | `r2` gets each YouTube song's audio by way of the Cloudflare Worker, through the R2 bucket (needs the `R2_*` settings), because YouTube turns the cloud host's address away. Search stays direct. See [How it runs](cloud.md). |
| `ZEMER_CONTENT_URL` | `https://content.zemer.io` | Where Zemer's artist list is read from; only the tests change it. |
| `SONG_SOURCES` | `youtube-music,music-table` | Which source a search asks first. `youtube-music` (or `zemer`) is Zemer's catalog; first (the default), it is asked before your catalog, and music-table.com (the catalog, then the site) is used when it finds nothing that fits; the first to find anything answers. `music-table,youtube-music` asks the site first; leaving one out turns it off for searches. |
| `MUSIC_TABLE` | on | `off` stops all use of music-table.com: lookups, sync, daily message. |
| `MUSIC_TABLE_URL` | `https://www.music-table.com` | Where the site lookups go; only the tests change it. |
| `DIGEST_TIME` | `09:00` | When the daily new-music message goes out, 24-hour, in the host's time zone (`TZ`; Render uses `America/New_York`). `off` for none. |
| `PREFETCH_MB` | `unlimited` | Disk space for songs kept ready on the computer the bot runs on, in MB. No limit by default: every song stays. On Render it is `0` (the host's disk is wiped at every restart). A number sets a limit (the songs used least recently go first); `0` keeps none. |
| `SONGS_ARCHIVE_DIR` | none | A folder, on an external drive say, that kept songs move into whenever it's there, sorted into artist and album folders (they always download to the computer first; a run with a disk only. On Render songs go to OneDrive instead, see [How it runs](cloud.md)). A full path; put it in quotes if it has spaces. The folder it goes in must exist. See [The library](library.md#moving-them-to-an-external-drive). |
| `QUIET_HOURS` | `22:00-07:00` | No new-song alerts in these hours, 24-hour, in the host's time zone (it may cross midnight). `off` sends them any time. The daily message keeps its own time. |
| `SONG_GAP_SECONDS` | `5` | The least time between audio files, in seconds (up to 300), so the phone has sent one before the next arrives: several 👍 at once, `all`, numbers picked quickly. Text lists are sent together. A song's card waits with its file. `0` or `off` sends files as fast as they're ready. |

## RCS for Business

| Variable | Needed | Meaning |
| --- | --- | --- |
| `RBM_AGENT_ID` | yes | The agent ID shown in the Developer Console. |
| `RBM_REGION` | no (`us`) | `us`, `europe` or `asia`: the region you chose when creating the agent. |
| `RBM_CLIENT_TOKEN` | for `npm start` | The client token you enter when registering the webhook. |
| `GOOGLE_APPLICATION_CREDENTIALS` | yes | Path to the service account key JSON (keep it in `keys/`, which git ignores). |
| `RBM_MESSAGE_TRAFFIC_TYPE` | multi-use agents | `AUTHENTICATION`, `TRANSACTION`, `PROMOTION`, `SERVICEREQUEST` or `ACKNOWLEDGEMENT`. |
| `ALLOWED_SENDERS` | no | Comma-separated E.164 numbers. Messages from anyone else are ignored. |
| `PORT` | no (`8787`) | Port for the webhook server. |
