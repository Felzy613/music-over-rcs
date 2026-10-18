# Privacy and security

The bot runs on Render, with a Cloudflare Worker and an R2 bucket beside it ([How it runs](cloud.md)). Nothing runs on your own computer any more, so what you keep private is what those services hold.

## Where things live

| Where | What | Sensitivity |
| --- | --- | --- |
| The Render container (`/data`, wiped at every restart and restored from R2) | The bridge's database: your **Google Messages session** and every bridged conversation's metadata. Synapse's database: **copies of the messages of the chats the bridge relays** (see below), your account and signing key. The bot's catalog: songs, artists, site posts, your plays and follows, the bot's small state, and OneDrive's refresh token if you set that up. Logs (room ids, and the text of your requests) | **High**: the session is as good as a login |
| The R2 bucket `mors-state` (private) | The same three databases, continuously backed up by Litestream; the lease file; alerts waiting to be mailed | **High**, for the same reason |
| Render's environment | `SECRET_KEY`, `MATRIX_PASSWORD`, `ADMIN_TOKEN`, the R2 keys, `ONEDRIVE_CLIENT_ID` | **High** |
| The Cloudflare Worker `mors-edge` | Secrets only: Render's address and `ADMIN_TOKEN`, the alert sender and recipient addresses. It stores no messages | Medium |
| Your OneDrive (if set up) | Copies of the songs you asked for, in the app's own folder | Low |
| `.env` in this repository | Nothing the cloud needs; only for a local run (`npm run simulate:web`, tests) | Keep it private anyway |

## What the bridge copies

Pairing gives the bridge your whole Google Messages account, and the bridge acts as you:

- **Right after you link it**, it makes a Matrix room for each of your 25 most recent conversations: a name, a phone number and a picture, but no old messages (backfill is off).
- **From then on, while it runs**, every message sent or received in *any* chat is relayed into that chat's room. The bot only ever reads and writes the one room you chose, but Synapse stores all of them, and the R2 backup holds them too.
- **Nothing expires today.** Uploaded media is deleted a day after it arrives, but messages stay until you delete the rooms or the databases. If that is more than you want, the fix is a retention policy in `synapseConfig` (`src/cloud/provision.ts`), for example purging messages after a week.

## What leaves

- **To Google, through the bridge:** your Google Messages session, and the bot's replies, which go out over RCS as messages from you to yourself.
- **To music-table.com:** your search words, the posts and category pages it reads, the RSS feed, and download requests, from Render's address with a User-Agent naming this project. Who you follow stays in your catalog.
- **To YouTube Music (`music.youtube.com`) and YouTube's media servers (`*.googlevideo.com`):** your search words only when Zemer's catalog can't be reached (from Render's address), and the id of each song you ask for and the download of its audio (from Cloudflare's network: the Worker fetches it, since YouTube turns Render's address away), with a session id YouTube hands out and the User-Agent of the app client it imitates (not one naming this project). No Google account or cookie is used. A song passes through the R2 bucket (`yt/`) for a few seconds and is deleted once sent; anything left behind is swept within an hour.
- **To Zemer's catalog (`search.zemer.io`):** your search words, the artists and albums you open, and the album of a song about to be sent when it needs its cover, from Render's address with a User-Agent naming this project. Each request also says to leave out female singers. Nothing else about you.
- **To Zemer's content server (`content.zemer.io`):** a read-only request for its artist list (about 100 bytes every few minutes, the whole list of about 200 KB only when it changes), with a User-Agent naming this project. It sends nothing about you or your searches; the filtering happens on the host.
- **To Cloudflare:** the database backups, and the alerts the bot leaves for the Worker, which mails them from the sender address you set to the recipient you set through Cloudflare Email Service. An alert says what is wrong, for example "the bridge is logged out", never the text of your messages.
- **To Microsoft (only if you set up OneDrive):** the songs, uploaded to the app's own folder.
- **Nothing else.** No analytics. The health check of your Google Messages login asks the bridge inside the container (`127.0.0.1`) with the bot's Matrix token; about once a minute it also sends one empty request to Google's connectivity check (`www.google.com/generate_204`) to tell whether the host is online.

## Who can reach the host

- `/healthz` and `/ping` are open and say nothing about you or the bot. Everything else (`/status`, `/pair`, choosing the chat, the catalog upload) needs `ADMIN_TOKEN`, a long random value; wrong guesses are slowed down.
- The homeserver and the bridge listen on `127.0.0.1` inside the container and are not reachable from outside. Synapse federation is off, and nobody can register an account.
- Each process in the container gets only the secrets it needs: the homeserver and the bridge get none, and the bot gets the R2 keys (its alerts go through the bucket) but not `SECRET_KEY`.
- The Worker can ask the host whether it is alive and, with `ADMIN_TOKEN`, read `/status`; it cannot read your data.

## Secrets and this repository

- `.env`, `data/`, `keys/`, `*.db` and logs are in `.gitignore`. `.env.example` has no real values. The tests use only made-up tokens, cookies and numbers.
- `SECRET_KEY`, `ADMIN_TOKEN` and the R2 keys are Render secrets, and the Worker's addresses are Cloudflare secrets; none is in a file in this repository. The homeserver's and the bridge's own secrets are derived from `SECRET_KEY` at each start, so nothing is stored beside them.
- Rotate the R2 keys, or `ADMIN_TOKEN`, by changing them in Render (and, for `ADMIN_TOKEN`, in the Worker's `RENDER_ADMIN_TOKEN` secret). Changing `SECRET_KEY` signs the bot out of its homeserver account and invalidates the bridge's registration, so only do it when starting over.

**Never paste your Google cookies (the "Copy as cURL" request) anywhere except the `/pair` page.** It goes into the homeserver's chat with the bridge bot and is deleted from the chat a minute later (the homeserver forgets the deleted text after an hour). If you pasted it anywhere else, open your Google account → Security → Your devices, sign that browser session out, and link the bridge again.

## The bridge and the bot act as you

The bot sends as its Matrix account, and the bridge relays that as you on Google Messages. The bot only ever writes in the one room you chose on the `/pair` page, your chat with your own number; the bridge's other rooms are never joined or read by it. Check the choice is yours: the page finds the room by your phone number.

## Removing everything

1. Delete the Render service, the Cloudflare Worker (`mors-edge`) and the R2 bucket (`mors-state`).
2. Sign the bridge's session out: Google Messages on your phone → Device pairing, and your Google account → Security → Your devices.
3. If you set up OneDrive, revoke the app at account.microsoft.com → Privacy → Apps and services, and delete its folder under `Apps/`.
4. Remove any monitor (for example Better Stack) pointed at `/ping`.
