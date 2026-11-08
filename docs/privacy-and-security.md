# Privacy and security

The bot runs on Render, with a Cloudflare Worker and an R2 bucket beside it ([How it runs](cloud.md)). Nothing runs on your own computer any more, so what you keep private is what those services hold.

## Where things live

| Where | What | Sensitivity |
| --- | --- | --- |
| The Render container (`/data`, wiped at every restart and restored from R2) | The bridge's database: your **Google Messages session** and every bridged conversation's metadata. Synapse's database: **copies of the messages of the chats the bridge relays** (see below), your account and signing key. The bot's catalog: songs, artists, site posts, your plays and follows, the bot's small state, and OneDrive's refresh token if you set that up. Logs (room ids, and the text of your requests) | **High**: the session is as good as a login (and, with `PEOPLE`, so is each person's: [below](#other-people-on-the-host)) |
| The R2 bucket `mors-state` (private) | The same three databases, continuously backed up by Litestream; **Synapse's signing key** (`keys/synapse-signing.key`, kept so a start doesn't have to make one); the lease file; alerts waiting to be mailed; a YouTube song for a few seconds while it passes through (`yt/`) | **High**, for the same reasons |
| Render's environment | `SECRET_KEY`, `MATRIX_PASSWORD`, `ADMIN_TOKEN`, the R2 keys, `ONEDRIVE_CLIENT_ID` | **High** |
| The Cloudflare Worker `mors-edge` | Secrets only: Render's address and `ADMIN_TOKEN`, the alert sender and recipient addresses. It stores no messages | Medium |
| Your OneDrive (set up on the live bot since 2026-10-18) | Copies of the songs you asked for, in the app's own folder | Low |
| `.env` in this repository | Nothing the cloud needs; only for a local run (`npm run simulate:web`, tests) | Keep it private anyway |

## What the bridge copies

Pairing gives the bridge your whole Google Messages account, and the bridge acts as you:

- **Only your "message yourself" chat is copied** (since 2026-10-30, `deploy/cloud/patches/gmessages-only-self-chat.patch`): a conversation that isn't a one-to-one chat with one of the phone's own numbers is dropped as it arrives, so other chats get no room, no messages and no media on the host. A phone that doesn't tell the bridge any of its numbers keeps every chat, and so does `GMESSAGES_ALL_CHATS=1`.
- **Before that**, the bridge made a Matrix room for each of your 25 most recent conversations (a name, a phone number and a picture) and relayed every message in *any* chat into Synapse; those rooms and messages are still in the homeserver's database (and its R2 backup) from then, though nothing is added to them.
- **The bridge still sees every chat.** Google Messages hands a linked session every new message; the patch only keeps the bridge from storing them or asking the phone about them.
- **Nothing expires today.** Uploaded media is deleted a day after it arrives, but messages stay until you delete the rooms or the databases. If that is more than you want, the fix is a retention policy in `synapseConfig` (`src/cloud/provision.ts`), for example purging messages after a week.

## What leaves

- **To Google, through the bridge:** your Google Messages session, and the bot's replies, which go out over RCS as messages from you to yourself.
- **To music-table.com:** your search words, the posts and category pages it reads, the RSS feed, and download requests, from Render's address with a User-Agent naming this project. Who you follow stays in your catalog.
- **To YouTube Music (`music.youtube.com`) and YouTube's media servers (`*.googlevideo.com`):** your search words only when Zemer's catalog can't be reached (from Render's address), and the id of each song you ask for and the download of its audio (from Cloudflare's network: the Worker fetches it, since YouTube turns Render's address away), with a session id YouTube hands out and the User-Agent of the app client it imitates (not one naming this project). No Google account or cookie is used. A song passes through the R2 bucket (`yt/`) for a few seconds and is deleted once sent; anything left behind is swept within an hour.
- **To Zemer's catalog (`search.zemer.io`):** your search words, the artists and albums you open, and the album of a song about to be sent when it needs its cover, from Render's address with a User-Agent naming this project. Each request also says to leave out female singers. Nothing else about you.
- **To Zemer's content server (`content.zemer.io`): nothing, since 2026-11-08.** It used to be a read-only request for the artist list (about 100 bytes every few minutes, the whole list of about 200 KB only when it changed), with a User-Agent naming this project, and sent nothing about you or your searches. That server has turned the bot away since November 2026 (Cloudflare 403), so the bot keeps the last copy it saved and no longer asks; the filtering happens on the host. Setting `ZEMER_CONTENT_URL=https://content.zemer.io` brings the request back, with a 3-hour wait after each refusal.
- **To the Zemer team's new-releases feed (`flipphoneguy.duckdns.org`):** a read-only request for the list of recent releases (about 20 KB when it changed, a few hundred bytes when it hasn't) every 30 minutes, from Render's address with a User-Agent naming this project. It sends nothing about you; that server is a personal one, so what it answers is checked (artist list, picture hosts, lengths) before anything is shown. `ZEMER_RELEASES=off` stops it.
- **To Cloudflare:** the database backups, and the alerts the bot leaves for the Worker, which mails them from the sender address you set to the recipient you set through Cloudflare Email Service. An alert says what is wrong, for example "the bridge is logged out", never the text of your messages.
- **To Microsoft (only if you set up OneDrive):** the songs, uploaded to the app's own folder.
- **Nothing else.** No analytics. The health check of your Google Messages login asks the bridge inside the container (`127.0.0.1`) with the bot's Matrix token; about once a minute it also sends one empty request to Google's connectivity check (`www.google.com/generate_204`) to tell whether the host is online.

## Who can reach the host

- `/healthz` and `/ping` are open and say nothing about you or the bot. Everything else (`/status`, `/pair`, choosing the chat, the catalog upload, the console) needs a sign-in: your own user name and password (made on the console's Account page, kept in the database as a salted hash only), or `ADMIN_TOKEN`, a long random value, as the password on the sign-in page or as a Bearer token for a script. Sessions are random tokens in a cookie (only their hash is kept); wrong guesses are slowed down and limited to eight a minute for the whole host.
- The homeserver and the bridge listen on `127.0.0.1` inside the container and are not reachable from outside. Synapse federation is off, and nobody can register an account.
- Each process in the container gets only the secrets it needs: the homeserver and the bridge get none, and the bot gets the R2 keys (its alerts go through the bucket) but not `SECRET_KEY`. With `PEOPLE` the bot also gets each person's Matrix password (`PEOPLE_PASSWORDS`, derived from `SECRET_KEY` by the host); the homeserver, the bridge and Litestream never get it.
- The management console (`/admin/`, [docs/admin.md](admin.md)) is behind the same password, takes changes only as same-site `POST`s with its own header, shows secrets only as "set" or "not set", keeps its log of the last 500 lines in memory only with secrets masked, and has no way to edit Render.
- The Worker can ask the host whether it is alive and, with `ADMIN_TOKEN`, read `/status`; it cannot read your data.

## Secrets and this repository

- `.env`, `data/`, `keys/`, `*.db` and logs are in `.gitignore`. `.env.example` has no real values. The tests use only made-up tokens, cookies and numbers.
- `SECRET_KEY`, `ADMIN_TOKEN` and the R2 keys are Render secrets, and the Worker's addresses are Cloudflare secrets; none is in a file in this repository. The homeserver's and the bridge's own secrets are derived from `SECRET_KEY` at each start, so nothing is stored beside them.
- Rotate the R2 keys, or `ADMIN_TOKEN`, by changing them in Render (and, for `ADMIN_TOKEN`, in the Worker's `RENDER_ADMIN_TOKEN` secret). Changing `SECRET_KEY` signs the bot out of its homeserver account and invalidates the bridge's registration, so only do it when starting over.

**Never paste your Google cookies (the "Copy as cURL" request) anywhere except the console's Connect tab (the old `/pair` address leads there).** It goes into the homeserver's chat with the bridge bot and is deleted from the chat a minute later (the homeserver forgets the deleted text after an hour); the paste is remembered while it waits, so a restart inside that minute deletes it when the host is back (catalog state `pair.redactions`, only the room and event ids, never the text). The backups keep what was in the database for 72 hours. If you pasted it anywhere else, open your Google account → Security → Your devices, sign that browser session out, and link the bridge again.

## Other people on the host

If someone else has been added (on the console's People tab, or in `PEOPLE`; [How it runs](cloud.md#other-people-people); deployed with nobody added), the host holds their **Google Messages session** (the cookies they pasted, as the bridge's login) in the bridge's database and its R2 backups, as it holds yours, and it acts as them. What that means for them, and what to tell them before you link them:

**What is stored, and where**

- **The bridge's database** (`/data/gmessages`, and its R2 copy): their Google Messages login, good as their login until it is unlinked.
- **Synapse's database** (`/data/synapse`, and its R2 copy): their Matrix account and their messages with the bot, theirs and the bot's. Nothing expires: no message retention is set, so messages stay until deleted. Uploaded media (songs, covers) is deleted a day after it arrives; the text of a redacted message is kept for an hour (`redaction_retention_period`). Whether Synapse's database is encrypted at rest has not been checked; treat what is in it as readable.
- **The catalog** (and its R2 copy): their plays, follows, menus, the marks of what they were sent in the daily message and alerts, their Matrix token and room (state keys ending `:<id>`), and what they were sent each month. The song catalog itself is shared.
- **Their Matrix password** is derived from `SECRET_KEY` at each start, handed to the bot in its environment as `PEOPLE_PASSWORDS` and stored nowhere; the console shows it as "set" only and the log masks it. They never see it and are given no other credential.
- **R2 keeps copies for at least 72 hours** after anything is deleted or changed (Litestream's daily snapshots are kept for 72 hours, `deploy/cloud/litestream.yml`). Unlinking them removes the login from the bridge's database at once and from the backups after that.

**What you can see of them.** You are the operator, so in principle everything on the host. In practice: what they text and the first part of the bot's answers, in Render's logs and the console's Activity page (500 lines, only credentials masked), each tagged with their name; the last timelines in `/status`, which carry the request's words; and, if you go to the databases, their messages with the bot. The console's Library and Follows pages show only your own, and the alert emails never carry a message's text: they say which person and what is wrong, and go only to you. They share the song catalog and the lists built from it (`new`, trending), so what is in the catalog says nothing about whose search put it there.

**The cookie hand-over.** The request they copy holds their Google session cookies. It is pasted by you, with them next to you, into your signed-in console: it passes through your browser, the console's route (a same-site POST that is not kept, logged, put in the record of changes or sent back; only how many characters it had is recorded) and the host's memory, and then sits in their chat with the bridge bot. It must never be sent to you in a message. **The in-process redaction:** the host deletes that message from their chat a minute after it is sent, with a timer inside the bot, and since that timer dies with the process, it also remembers the room and event ids (never the text) in catalog state `pair.redactions`, so a restart inside the minute deletes it at the next start. This limits the exposure; it does not erase it: Synapse keeps a redacted message's text for an hour, and the backups keep what was in the databases for 72 hours. If a paste went anywhere else, they sign that session out in their Google account (Security, Your devices) and link again.

**Only their own chat is kept.** The same patch as for you drops every other conversation as it arrives, but it fails open for a login whose phone gives the bridge no number (it would keep all of their chats and spend the host's traffic), so a person is not counted as set up until their phone's number is there and their own chat has arrived (the onboarding gate). The bridge still sees all of their chats as they arrive; it only does not keep them.

**They cannot see or change anything of yours.** Separate Matrix account and room, separate searches, menus, follows and daily message; no console, no logs, no `/status`, no artist commands (`allow`, `block` and `pending` do nothing for them). They are held to your artist rules, for what they search and what they are sent. Their songs are not copied to your OneDrive.

**Tell them beforehand** that you can read their requests; that the link to Google is unofficial and can drop; that the service is on free plans and can be down or suspended; that the artist rules are yours and not theirs to change; and that a monthly limit applies.

**Taking them off:** unlink them from their own window first, then remove them on the People tab (or take a name set in `PEOPLE` out of Render); their Google session leaves the bridge with the unlink and stays in the backups for at least 72 hours. Their messages stay in the homeserver's database until you delete them.

## The bridge and the bot act as you

The bot sends as its Matrix account, and the bridge relays that as you on Google Messages. The bot only ever writes in one room, your chat with your own number: the one it finds by itself (the bridge's chat with the number Google Messages gives for your SIM, read from the bridge's database without changing it) or the one you chose on the `/pair` page. The bridge's other rooms are never joined or read by it; with no number to go on it picks no chat at all.

## Removing everything

1. Delete the Render service, the Cloudflare Worker (`mors-edge`) and the R2 bucket (`mors-state`).
2. Sign the bridge's session out: Google Messages on your phone → Device pairing, and your Google account → Security → Your devices.
3. If you set up OneDrive, revoke the app at account.microsoft.com → Privacy → Apps and services, and delete its folder under `Apps/`.
4. Remove any monitor (for example Better Stack) pointed at `/ping`.
