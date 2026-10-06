# Configuration

Settings come from environment variables, or from a `.env` file in the project folder (copy `.env.example`). Real environment variables win over the file. On a Mac, after changing `.env`, run `npm run stack -- restart` so the background bot gets the new copy.

`.env` holds access tokens. It is in `.gitignore`, is created readable only by you, and should never be shared.

## The bridge route (Matrix)

| Variable | Needed | Meaning |
| --- | --- | --- |
| `MATRIX_HOMESERVER` | no (`http://127.0.0.1:8008`) | Your Matrix homeserver. `npm run matrix-login` saves it. |
| `MATRIX_ACCESS_TOKEN` | yes | Saved by `npm run matrix-login`. |
| `MATRIX_ROOM_ID` | yes | The room to watch: your chat with your own number. `npm run matrix-rooms -- --phone <number>` finds it. |
| `MATRIX_POLL_MS` | no (`1500`) | How often to check the room, in milliseconds, 500 to 30000. |
| `BRIDGE_URL` | no (`http://127.0.0.1:29336`) | Where the bridge listens, for the health check of your Google Messages login. |

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
| `CATALOG_DB` | `data/catalog.db` | The catalog file. `npm run mac:setup` points it at the services folder, where the background bot can read it. |
| `MAX_DOWNLOAD_MB` | `100` | Largest file to download and send, up to 500. (Google Messages and the bridge take about 100.) |
| `MUSIC_TABLE` | on | `off` stops all use of music-table.com: lookups, sync, daily message. |
| `MUSIC_TABLE_URL` | `https://www.music-table.com` | Where the site lookups go; only the tests change it. |
| `DIGEST_TIME` | `09:00` | When the daily new-music message goes out, 24-hour, in this Mac's time. `off` for none. |
| `PREFETCH_MB` | `unlimited` | Disk space for songs kept ready on this Mac, in MB. No limit by default: every song stays. A number sets a limit (the songs used least recently go first); `0` keeps none. |
| `SONGS_ARCHIVE_DIR` | none | A folder, on an external drive say, that kept songs move into whenever it's there (they always download to the Mac first). A full path; put it in quotes if it has spaces. The folder it goes in must exist. See [The library](library.md#moving-them-to-an-external-drive). |
| `QUIET_HOURS` | `22:00-07:00` | No new-song alerts in these hours, 24-hour, in this Mac's time (it may cross midnight). `off` sends them any time. The daily message keeps its own time. |

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

## Install-time settings

The scripts that install and control the Mac services read these from the environment (not from `.env`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MORS_HOME` | `~/Library/Application Support/music-over-rcs` | Where the services, their data and logs live. Must not be under `~/Documents`, `~/Desktop` or `~/Downloads`. |
| `MATRIX_LOCALPART` | `me` | Your Matrix username, which gets admin rights on the bridge. |
