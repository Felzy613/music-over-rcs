# How it runs: Render and Cloudflare

Since 2026-10-16 the bot runs here, not on a Mac: the Matrix homeserver, the Google Messages bridge and the bot are one Docker container on Render's free plan, with a Cloudflare Worker and an R2 bucket beside it. A Mac that loses its internet no longer matters. It costs nothing beyond a Cloudflare Workers plan you may already have. This page is the runbook: how it fits together, what it costs, how it was set up (and how to set it up again), what to do day to day, and what has been proven.

**Status:** live. Render service `music-over-rcs` (Ohio, free plan; deploy branch `main`, deployed by hand), Worker `mors-edge`, bucket `mors-state`. The image is Synapse 1.143.0, the Google Messages bridge built from upstream `186284e` plus this repository's streaming patch, Litestream 0.5.17, Node 24 and Python 3.12 (the `ARG`s at the top of the `Dockerfile` are the single place these are written down). Songs are saved to OneDrive (step 5 is done): the first save in the logs is 2026-10-18 03:45 UTC. What is deployed is whatever commit of `main` was last deployed by hand: the service's Events page in Render, or `git log origin/main`, tells which, and a change is not live until it is.

## How it fits together

```
Phone <-> Google <-> [ one Docker container on Render's free plan ]
                       supervisor (deploy/cloud/entrypoint.ts)
                        |- takes the lease, restores the databases from R2
                        |- Litestream   backs the databases up to R2
                        |- Synapse      127.0.0.1 only
                        |- the bridge   127.0.0.1 only
                        '- the bot      + a web door on $PORT (src/cloud-main.ts)
Cloudflare
  R2 bucket "mors-state"   the database backups, the lease, the alerts waiting to be mailed,
                           and YouTube songs on their way (yt/)
  Worker "mors-edge"       every 5 min: asks the web door if it is up (which also keeps Render's
                           free service awake), and mails what the bot left in alerts/;
                           at once, through the "mors-yt" queue: fetches the YouTube songs the bot asks for
```

Why these pieces:

- **Render's free plan** sleeps after 15 minutes without a request, may restart at any time, and wipes its disk when it does. The Worker's check every five minutes keeps it awake, and the databases (Synapse's, the bridge's, the bot's catalog) are backed up to R2 every minute and restored at each start, so a wiped disk loses at most about a minute of changes.
- **The lease** is what stops two copies running at once. Render starts a new copy before it stops the old one on a deploy; two bridges on one Google login would unpair the phone, and two writers on one backup would corrupt it. It is a file in the bucket, changed only with R2's conditional writes; the new copy waits until the old one lets go (it does when it is stopped) or its lease runs out (it crashed).
- **The host and the Worker never call each other's front door.** Cloudflare puts a bot challenge in front of every automated client on `workers.dev`, so a host calling the Worker would be turned away. They meet in the bucket instead: the host writes its alerts there, and the Worker reads them. (The Worker does call the host, and that direction is fine.)
- **YouTube Music songs come by way of Cloudflare.** YouTube asks Render's datacenter address to "confirm you're not a bot" before it gives out a song's audio (search still works), but answers Cloudflare's network. So the bot leaves a request in the bucket (`yt/req/`); R2 tells the Worker through the `mors-yt` queue; the Worker fetches the song from YouTube Music and puts it in the bucket; the bot takes it and sends it, and removes all three files. A song takes a few seconds longer than a direct download (6 to 9 seconds measured). YouTube turns Cloudflare away too now and then, for a minute or two (its bot check, or HTTP 403). The bot then asks again 5 seconds later and 15 seconds after that; if all three are turned away, it leaves YouTube songs aside for a minute and searches music-table.com meanwhile, then checks the relay with a short video: YouTube songs are back as soon as that comes through, and each check that is turned away doubles the wait (2, 4, 8, then 15 minutes at a time). The Worker logs one line per song request, kept three days (Cloudflare dashboard → Workers & Pages → `mors-edge` → Observability). Details in [YouTube Music](youtube-music.md#getting-the-songs). `src/cloud/youtube-relay.ts`, `cloudflare/youtube.ts`; on with `YOUTUBE_RELAY=r2`, the cloud host's default.
- **Songs** are not kept on the host (its disk is wiped); each one is fetched when asked for. With OneDrive set up (step 5), every song sent is also saved to your OneDrive, tagged and sorted as `Artist/Album/01 Title.mp3`, in the app's own folder.
- **A restart** takes about a minute on Render (53 to 60 seconds from Render marking a deploy live to the bot signing in, measured 2026-10-20; 36 seconds on a Mac with the image, a stand-in for R2 and a tenth of a CPU). Texts sent meanwhile are answered when the bot is back: it remembers how far it got (`src/runner.ts`, "resume").

## What it costs and the limits

| | |
|---|---|
| Render free web service | $0. About 744 of the 750 free instance hours in a 31-day month, and **the hours are shared by everything in a Render workspace**: create this service in a workspace with no other always-on free service |
| Cloudflare Workers Paid ($5) | Already yours. The cron and R2 are well inside what it includes |
| R2 | 10 GB free; the backups are tens of MB. The 60 s sync interval keeps writes near 130,000 a month against 1 million free |
| Email | Free to an address you've verified in Cloudflare |
| OneDrive | Your own plan. The app can only see its own folder, `Apps/<the app's name>` |
| **Render outbound bandwidth** | A Hobby workspace includes **5 GB a month**. Songs sent to Google are the bulk, and each song saved to OneDrive is uploaded from Render too, so it counts again (`ONEDRIVE_MAX_MB_PER_MONTH`, 1500 by default, stops the saving, never the sending). Over it, Render charges $0.15/GB, or suspends the service if you have no card on file. `/status` shows `sentThisMonthMb`; check the figure in the Render dashboard too, since Render's pages disagree on it |

**Memory** is the tight resource: 512 MB for the homeserver, bridge, bot, Litestream and the supervisor together. Right after a start it is 220 to 230 MB (about 250 MB before the send path was slimmed down, below), and over a day it creeps up (294 MB six hours into the run of 2026-10-19; 315 to 335 MB on Render's graph earlier; it steps up after album-length sends and does not always come back down), which leaves roughly 180 to 290 MB for a song. A song used to cost the bot about eight times its size at its peak (the download, a copy to tag it, the tagged copy, a new Blob made of that, and the upload: 216 MB of live buffers for a 27 MB MP3 in a local probe, and 212 MB more than at rest on Render on 2026-10-19). It is now gathered into Blobs of about 4 MB that are joined into one (`src/audio-fetch.ts`), tagged by putting the new tag in front of the original audio (`writeTagsToBlob` in `src/library/id3.ts`: a Blob can be made of another Blob's slice, so the audio is not read or copied; the file is byte for byte what `writeTags` gives), and uploaded from the Blob as it is, and the runner frees what is left after each send: 76 MB of live buffers, about 2.8 times the song, in the same probe. The bridge used to hold the song again, about four times its size, while it handed it to Google; it now streams it (**Albums and the bridge**, below), and `MAX_DOWNLOAD_MB` is still 30 on this host for the bot's part. Its OneDrive copy is uploaded straight from the song that was sent, a 10 MiB piece at a time (about 24 MB held instead of 81), and waits 5 s plus half a second per MB after the send so the bridge has finished with it; if the container's memory is still short it waits for room or is skipped (the song is still sent). **Who holds the memory** is in the host's log: while the container is past 85% of its limit a line starting `memory:` names the processes and their megabytes every 15 s (and says when it is back down), a routine `memory (routine check):` line is written 90 s after each start and every six hours; and when the container goes 60 MB or more above its resting level (the lowest of the last 15 minutes) and stays there 45 s, which is how a big song leaves it, one `memory (raised):` line names who holds it, each process with how much more it holds than when memory last rested (`bot 140 MB (+90), synapse 150 MB (+50)`, a process not there at rest marked `new`), and a `memory (settled):` line says when it is back and who has not yet given theirs back (nothing is said in the first 90 s after a start; `/status` shows the resting breakdown as `restProcesses`); `/status` has the same breakdown under `memory`, with the highest the container reached since the start and who held it then (`npm run cloud:check` judges that, not the bot's size alone). If it is still too tight, the same image runs on a paid host (see [Moving to a paid host](#moving-to-a-paid-host)). **At rest** (the first `memory (routine check)` line, 90 s after a start on 2026-10-19): 231 of 512 MB in anonymous memory, held by Synapse 99 MB, the supervisor (`entrypoint.ts`, the web front door included) 53 MB, the bot 51 MB, the bridge 15 MB, Litestream 14 MB and Render's own port detector 9 MB; the later routine lines (every six hours) show which of them is what creeps up over a day. **The first kill** (2026-10-18 21:58 UTC, Render's Events: `oomKilled`, limit 512Mi) came 5 s after a 27 MB MP3 was sent, on a host already at 334 MB; the retry at 22:07 went through with the container at 458 MB for a half-minute. It was first put down to the OneDrive copy that follows a send, and that copy was wasteful (it made two more copies of a song that was already finished; it now uploads from the sent song a 10 MiB piece at a time), but **the send alone is enough**: on 2026-10-19 the same song, from a 267 MB start and with the OneDrive step skipped (it had been saved already), took the bot from 51 MB to 263 MB while it was fetched, tagged and sent, the container to 449 MB (88%) in the new `memory:` line and 469 MB on Render's graph, and it stayed at about 469 MB for two minutes before falling back (373 MB at 00:22:24). From the 334 MB of the kill that is past 512 MB without any OneDrive copy. At that time a song cost the bot about 8 times its size at its peak (download, a copy to tag it, the tagged copy, a new Blob, the upload), more than this host could carry once it had been up for a day. **After the send path was slimmed down** (the Blob gathering, the tag put in front of the audio, the streamed upload, above), the same 27 MB song took the container from 257 to about 370 MB on 2026-10-19 (it stayed near there for a few minutes; the cost of the send alone was 55 MB at the bot in a local probe, against 125 MB before), and Render's Events show no `oomKilled` since the one of 2026-10-18 21:58 UTC. **Over a day**: routine lines read 221 MB at the start of 2026-10-19 02:15 UTC, 209 MB at 03:24 and 294 MB six hours later (bot 83 MB, Synapse 118 MB), and 228 and 221 MB at the starts of 2026-10-20 02:11 and 02:13 UTC (bot 54 and 44 MB). So a 30 MB song still has room on a host that has been up a day, but not much more; if the host is killed again, the ways out are a lower `MAX_DOWNLOAD_MB` or more memory.

**Albums and the bridge.** An album goes as one zip of up to 100 MB (`MAX_ZIP_MB`; the owner asked for one zip, not 30 MB parts, on 2026-10-18), and no step holds it in memory. The runner writes each song to a folder in the system's temporary directory as it arrives (computing the zip's checksum on the way) and makes the zip of the files on disk (`writeWithCrc32` and `zipBlob` in `src/library/zip.ts`, `sendAlbum` in `src/runner.ts`); the folder is removed once the zip is sent. The Matrix client uploads every file with `node:http`, streamed from its Blob (`#upload` in `src/matrix/client.ts`): Node's `fetch` reads a whole body into memory before sending it (measured: 130 MB more for a 100 MB body, against 5 to 25 MB streamed), which also cost every song its size again. The homeserver writes an upload to disk. The bridge is built with `deploy/cloud/patches/gmessages-stream-media.patch` (applied, and its tests run, in the Dockerfile): it fetches a file from the homeserver into a temporary file (`DownloadMediaToFile`) and encrypts it a 32 KB chunk at a time as it sends it to Google, with the upload's length worked out in advance, so the request is the same as before. Without the patch the bridge read the file into memory and made an encrypted copy of it, and its heap reached about 4 times the file (392 MB for 100 MB in a local measurement; 4 MB with the patch); every song went that way too. Voice messages keep the old way (they may be converted with ffmpeg). Disk: an album is on disk up to three times while it goes (the runner's folder, the homeserver's media store for a day, the bridge's temporary file). Deployed 2026-10-19 03:22 UTC; no multi-song album has gone out through it yet (see **What has been proven**, below).

## Setting it up

You need a Cloudflare account (Workers Paid), a Render account, and this repository on GitHub. For email alerts you also need a domain on Cloudflare DNS; without one, use ntfy.sh instead (step 1).

### 1. Cloudflare

The R2 bucket is named `mors-state`. Create it (Cloudflare dashboard, R2, Create bucket) or run:

```bash
cd cloudflare
npx wrangler login
npx wrangler r2 bucket create mors-state
```

Create an R2 API token: R2, *Manage API tokens*, *Create API token*, permission **Object Read & Write**, limited to the bucket `mors-state`. Keep the page open and copy three things: the Access Key ID, the Secret Access Key, and the S3 address, `https://<account id>.r2.cloudflarestorage.com`. You'll give these to Render in step 2.

For email, onboard a domain for Email Service (Compute, Email Service, Email Sending, *Onboard Domain*) and add your own address as a verified destination (Email Routing, Destination addresses). Without a domain, delete the `send_email` block in `cloudflare/wrangler.jsonc` and set an `NTFY_TOPIC` secret instead (install the ntfy app and subscribe to a topic nobody could guess).

Make the queue YouTube songs are asked for through, and have the bucket tell it about each request (once):

```bash
npx wrangler queues create mors-yt
npx wrangler r2 bucket notification create mors-state --event-type object-create --prefix yt/req/ --queue mors-yt
```

Deploy the Worker (it is the queue's consumer) and give it your addresses:

```bash
npx wrangler deploy
npx wrangler secret put ALERT_FROM     # an address on your Email Service domain, e.g. alerts@yourdomain.com
npx wrangler secret put ALERT_TO       # your own verified address
```

Nothing personal goes in a file: the addresses are Worker secrets. Until you give the Worker Render's address (step 3) it checks nothing.

### 2. Render

Create a **workspace** for this (Render dashboard, workspace menu, *New workspace*): the free hours and the bandwidth are per workspace. In it create a **Web Service** from this repository (runtime Docker, the `Dockerfile` in the root, free plan, branch `main`, no health check path, **auto-deploy off**), or a **Blueprint** from `render.yaml`, which also generates `SECRET_KEY`, `MATRIX_PASSWORD` and `ADMIN_TOKEN` for you (otherwise make three long random values yourself, for example `openssl rand -hex 24`, and enter them). The first service was made on the branch `cloud-hosting`, which points at the same commit as `main`; if the dashboard still says `cloud-hosting`, switch it to `main` (Settings → Build & Deploy → Branch). Fill in the ones marked as yours:

| Setting | Value |
|---|---|
| `R2_ENDPOINT` | the S3 address from step 1 |
| `R2_BUCKET` | `mors-state` |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | from step 1 |
| `ONEDRIVE_CLIENT_ID` | leave empty or type `none` for now (step 5) |

A first build takes several minutes (it compiles the bridge). A healthy start prints `took the lease`, `no backup yet for …` (the first time), `started synapse`, `started bridge`, `started bot`, then `no chat chosen yet`. Note the service address (`https://….onrender.com`) and copy `ADMIN_TOKEN` from the Environment page.

### 3. Tell the Worker where Render is

```bash
cd cloudflare
npx wrangler secret put RENDER_URL             # the service's address, https://<name>.onrender.com
npx wrangler secret put RENDER_ADMIN_TOKEN     # Render's ADMIN_TOKEN, from its environment page
```

The five-minute check starts. Look at everything at once:

```bash
ADMIN_TOKEN=… npm run cloud:check -- --render https://<service>.onrender.com --alert
```

It says, in plain lines, what is working and what to do about what isn't: the host, its memory, the bucket, the lease, whether the Worker has made a check, alerts stuck in the bucket, Google Messages, the bot, OneDrive and the month's traffic. `--alert` also leaves one test alert, which the Worker mails within five minutes. Run it again after each of the next steps.

### 4. Link Google Messages, then text yourself

Open `https://<service>.onrender.com/pair` (any user name; the password is `ADMIN_TOKEN`). Press **Start login**, follow the bridge's instructions in a private browser window, paste the request it asks for, and tap the emoji on your phone. The pasted request holds your Google cookies; you paste it only into this page, and it is deleted from the chat a minute later. Then text yourself once from your phone: the bot finds that chat by itself (below) and says hello in it. Only if it doesn't, enter your number under step 2 on the page, press **Find**, and choose the room.

The free plan gets about a tenth of a CPU, so after you link, the bridge needs several minutes to make its rooms. Wait for the logs to go quiet (or about ten minutes) before pressing **Find**; a chat whose room is not made yet is not found.

What the bridge copies is more than your one chat: right after linking it makes a room for each of your 25 most recent conversations (a name and a number, no old messages), and from then on it relays every message in any chat into Synapse while it runs. The bot reads only the room you choose. See [Privacy and security](privacy-and-security.md#what-the-bridge-copies).

### 5. Save songs to your OneDrive

Songs aren't kept on the host, so until this is set up **nothing is saved**: each song is fetched, sent, and gone. This is how you keep them. (It is set up on the live bot: songs have been saved since 2026-10-18 03:45 UTC, and the start-up line says `songs sent are saved to OneDrive`; it says `OneDrive is set up but not signed in` when the sign-in below is missing.) Each song the bot sends is also uploaded, in the background, to `Apps/<the app's name>/Artist/Album/01 Title.mp3` in your OneDrive, with its tags and cover written in. Sign-in is Microsoft's device-code flow: you type a code at microsoft.com yourself, and neither your password nor any cookie reaches the bot.

Register the app once (about two minutes, no cost) at [entra.microsoft.com](https://entra.microsoft.com) → App registrations → New registration:

1. **Name**: `Music over RCS` (this becomes the folder name under `Apps/`).
2. **Supported account types**: *Personal Microsoft accounts only* (or the option that includes them).
3. After creating it: **Authentication** → *Allow public client flows* → **Yes**, and save.
4. **API permissions** → Add → Microsoft Graph → Delegated → `Files.ReadWrite.AppFolder` and `offline_access`.
5. Copy the **Application (client) ID** from the Overview page into Render as `ONEDRIVE_CLIENT_ID` (the service restarts).

Then open the `/pair` page, press **Sign in to OneDrive** under step 3, open the address it shows, enter the code and approve. The page shows what has been saved this month. The OneDrive app on your Mac syncs the folder down; from there you can move songs onto the external drive as you did before.

Microsoft renews the sign-in each time the bot uses it. If it is revoked (a password change can do it), the bot emails you and you press the button again.

### 6. Carry over a catalog (only when starting over)

If you have an earlier catalog file (the songs, plays, follows and the daily message's state; not the old chat's message links), upload it before the bot starts. The catalog must still be empty, and `ALLOW_IMPORT` must be `1` in Render (it restarts the service).

```bash
sqlite3 old-catalog.db "VACUUM INTO '/tmp/catalog-export.db'"      # a consistent copy
curl --fail -X POST -H "Authorization: Bearer $(pbpaste)" \
  --data-binary @/tmp/catalog-export.db https://<service>.onrender.com/admin/import-catalog
rm /tmp/catalog-export.db
```

(`pbpaste` is `ADMIN_TOKEN` copied from Render's Environment page.) It answers with how many songs, artists, plays and follows it took. Then set `ALLOW_IMPORT` back to `0`. The first set-up did exactly this on 2026-10-16, from the Mac's catalog (5,195 songs, 1,092 artists, 71 plays, 7 follows).

### 7. Turn the bot on

Set `BOT_ENABLED` to `on` in Render (changing the environment restarts the service). The bot joins the chat you chose, says one hello (see `STARTUP_MESSAGE`) once the bridge can deliver it, and answers. `npm run cloud:check` reaches "The bot is answering texts". Try `search`, a 👍 on a list line and `all`.

The Mac install this replaced (`deploy/mac`, `docs/setup-mac.md`, launchd jobs) was removed on 2026-10-16. It is still in git history, for example `git show 1dc96c2:deploy/mac/setup.sh`. Do not run it next to the cloud host: two bots in one chat both answer. If a Google Messages session from the Mac is still listed (Google Messages → Device pairing), unlink it.

## Day to day

- **`/status`** (the same password) reports the phase, bridge login state, problems, memory, the lease, what the Worker last saw, and bytes sent this month. **`/pair`** is also where you re-link Google Messages if it ever unlinks.
- **Email**: the bot's problem reports (bridge unlinked, site not answering, OneDrive sign-in lost, the chat's room gone) reach you within five minutes, mailed by the Worker; the Worker adds "the host isn't answering" (three missed checks in a row) and "the bot isn't running" (up but not answering for 30 minutes). A problem is repeated at most every six hours.
- **Deploying a change**: push to `main`, then Render dashboard → the service → *Manual Deploy* → *Deploy latest commit*. The bot is away for a minute or so while the new copy restores and starts; texts sent meanwhile are answered afterwards, and the web address shows a "Starting up" page that reloads itself rather than "Bad Gateway" (see the next point). Wait for it; clicking deploy again only starts the whole sequence over. Only one deploy runs at a time, and each queues behind the last, so do not stack them. A deploy that never finishes (it waits on the lease, see below) is failed by Render after about 15 minutes; *Cancel deploy* in the Events list starts the next one at once.
- **Deploys** are manual (`autoDeploy: false`). A deploy briefly runs the new copy beside the old; the lease holds it until the old one has stopped. Render sends traffic to the new copy, and stops the old one, as soon as the new copy's port accepts a connection, so the host opens that port first thing and keeps it open (`src/cloud/front-door.ts`, run by `deploy/cloud/entrypoint.ts`): `/healthz` is answered by the front door itself, and everything else is passed to the bot's own web door on `BOT_WEB_PORT` (8081, this machine only), or answered 503 with a self-reloading "Starting up" page that says what the start is doing while the bot isn't there yet (waiting for the previous copy, restoring the databases, starting the services). Without an open port a deploy would wait on itself forever, and with the port closed in the middle of a start (as the first version did once the lease was taken) visitors got Render's "Bad Gateway" and Render, finding the port refusing connections, restarted the instance it had just started.
- **Uptime monitor (Better Stack and the like)**: watch `https://<service>.onrender.com/ping` and treat **HTTP 500** as up. `/ping` answers 500 on purpose, and neither Render's "starting up" page nor its gateway errors (502/503) nor the waiting door above ever say 500, so only the running web door passes; a sleeping service just keeps failing the check until it has woken. `/healthz` (200) stays what the Worker uses.
- **Re-pairing** can change the chat's room. The bot finds the new one by itself (below); `/pair` can still choose it. No environment change is needed.
- **The bot finds your chat by itself.** Your "message yourself" chat is the bridge's one-to-one chat with your own number, and the bridge knows that number: Google Messages tells it each SIM's number, kept in the bridge's login. So when the bot has no room it can join (a new pairing, or the chat was deleted), it reads the bridge's database (read-only, `ownChatRooms` in `src/cloud/pairing.ts`), takes the room of the chat with your number (newest first), keeps it as the chat chosen (catalog state `matrix.room`), and keeps that chat's number (`matrix.phone`) too, for a phone whose SIM doesn't say its number. Only a chat with yourself has your own number at the other end, so it never picks someone else's chat; with no number to go on it picks nothing and waits. The log says `found your chat by itself: !…`.
- **A chat deleted on the phone** takes its room with it (the bridge deletes the room when Google Messages moves the conversation to the trash, and makes a new one, under another id, when you text yourself again; 2026-10-19, and again 2026-10-22). The bot then cannot join the room it was given. It does not crash and restart: the start waits (`src/cloud/room.ts`) with the web door up, `/status` says `room-missing` and `roomGone`, the `/pair` page says the chat is gone, and one alert is mailed (`The bot's chat room is gone…`, again every six hours while it lasts). Text yourself once from your phone: within a minute the bot finds the chat's new room (above), starts answering in it with no restart, and a "Fixed" alert follows. Choosing it under step 2 (your number, **Find**, **Use**) still works if it doesn't. While the bot runs it looks at its room every five minutes and, if the homeserver has forgotten it, stops so the host starts it into that waiting state. `MATRIX_ROOM_ID`, if set in Render, is tried first, then the room chosen on `/pair` (or found), then the chat found by your number, so a stale environment value blocks nothing.
- **"Too Many Requests" (HTTP 429) while joining the chat** is waited out a minute at a time, not a crash. Synapse counts a join to a room it no longer has as a join over federation (one per 100 s after a burst of 10), so the bot's once-a-minute look at two deleted rooms used that up and every start failed (2026-10-25); `provision.ts` now lets the bot join once a second after a burst of 20 (`rc_joins`).
- **Logs** are in the Render dashboard; each line is prefixed with the process (`[bot]`, `[bridge]`, `[synapse]`, `[litestream]`).

## Settings

The ones that matter for the cloud host. The bot's own settings (`DIGEST_TIME`, `QUIET_HOURS`, …) are in [Configuration](configuration.md).

| Setting | Meaning |
|---|---|
| `SECRET_KEY` | Master secret the homeserver's and bridge's secrets are derived from (so they're the same at every start). Keep it; changing it logs the bot out of the homeserver |
| `MATRIX_USER`, `MATRIX_PASSWORD` | The bot's account (default user `me`); created on first start |
| `ADMIN_TOKEN` | Password for `/status`, `/pair` and the rest. Without it only `/healthz` and `/ping` answer |
| `YOUTUBE_RELAY` | `r2` (the cloud host's default): YouTube Music songs come by way of the Worker, through the bucket. Empty or `off`: the host asks YouTube itself, which it turns away |
| `STARTUP_MESSAGE` | `once` (the cloud host's default), `always` or `off`. A word in the chat when the bot is up and the bridge can deliver it, once per catalog (`hello.sent` in the catalog) or at every start. Off everywhere else |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | The bucket: backups, the lease, the alerts. Without them **nothing is backed up, there is no lease and no alert**, and the start says so |
| `R2_REGION` | `auto` (the default) for R2; another S3 server may want a named region |
| `ONEDRIVE_CLIENT_ID` | The Azure app's client id. Empty or `none`: nothing is saved to OneDrive |
| `ONEDRIVE_MAX_MB_PER_MONTH` | The most uploaded to OneDrive in a calendar month (default 1500, or `unlimited`) |
| `ONEDRIVE_SCOPE` | What the sign-in asks for. Empty: `Files.ReadWrite.AppFolder offline_access`, the app's own folder only. `ONEDRIVE_LOGIN_URL` and `ONEDRIVE_GRAPH_URL` point the sign-in and the uploads somewhere else; only the tests change them |
| `BOT_ENABLED` | `off` keeps the bot from answering (setup only) |
| `ALLOW_IMPORT` | `1` allows the one-time catalog upload |
| `PREFETCH_MB` | `0` on this host (nothing is kept on a wiped disk) |
| `MAX_DOWNLOAD_MB`, `DOWNLOADS_AHEAD` | Smaller than the defaults (100 and 3), because each song is held in memory while it is fetched and tagged: 30 and 1 here. `MAX_ZIP_MB` keeps its default of 100: an album's zip is on disk, not in memory |
| `BOT_HEAP_MB`, `BOT_MEMORY_MB` | The bot's heap cap (default 120), and its share of memory (default 220) used to hold back a big song's OneDrive copy where the container's own limit can't be read |
| `BOT_WEB_PORT` | The bot's own web door, on this machine only (default 8081). The front door holds `PORT` (Render sets it) and passes requests here; the two must differ |
| `SERVER_NAME`, `SYNAPSE_PORT`, `BRIDGE_PORT`, `DATA_DIR` | Defaults `localhost`, 8008, 29336, `/data` (`deploy/cloud/litestream.yml` names the databases under `/data`, so change them together) |
| `MATRIX_ROOM_ID` | Optional, and best left unset: the bot finds your chat by itself. The room to watch, tried before the one chosen on `/pair` (or found). If it cannot be joined (the chat was deleted and the bridge made a new room) the page's choice is tried next, then the chat found by your number, and if there is none the bot waits for you to text yourself (see "A chat deleted on the phone", above). Since 2026-10-20 it holds the room made after the chat was deleted on 2026-10-19, which was itself deleted on 2026-10-22 |
| `APP_DIR`, `RUN_DIR`, `BRIDGE_BIN`, `SYNAPSE_PYTHON`, `REGISTER_BIN`, `LITESTREAM_BIN`, `NODE_BIN`, `INSTANCE_ID` | Where the image keeps its programs (`/app`, `/run/mors`, `/usr/local/bin/mautrix-gmessages`, the Python virtualenv under `/opt/venv`, `/usr/local/bin/litestream`) and the name this copy takes the lease under (Render's own instance id by default). The defaults in `src/cloud/boot.ts` already match the image; leave them alone |

## Moving to a paid host

The same image runs anywhere that runs a Docker container with the same environment.

- **Render Starter** ($7/mo): change `plan` to `starter`. It doesn't sleep, so the Worker's keep-awake isn't needed, and has a full CPU share, which makes restarts quick. With a persistent disk ($0.25/GB) the backups matter less but still work.
- **Cloudflare Containers** (about $7/mo more on the Workers plan you have): its disk is also wiped on restart, so the same R2 backups and lease apply. It has far more outbound traffic included than Render's free plan.

## What has been proven, and what hasn't

**Built and tested before the first deploy**, on a Mac with the real container image (Synapse 1.143.0, the bridge at `186284e`, Litestream 0.5.17, Node 24), an S3 server standing in for R2, 512 MB, and a tenth of a CPU for the timing: the lease, restoring, clean stops, a fresh-disk restore, a second host waiting and taking over, a cold start in 36 seconds, songs of 20 and 30 MB passing through.

**Learned on the first real runs (2026-10-15 and 16):**

- **R2's conditional writes** work as the lease needs, with two adjustments the stand-in did not need. Node's fetch asks for gzip, which can turn an ETag weak (`W/"…"`) and a weak ETag never matches `If-Match`, so `src/cloud/s3.ts` asks for `accept-encoding: identity` and strips the `W/`. Until then the lease could be taken (`If-None-Match`) but never renewed or retaken. A write R2 refuses is now logged with its reason.
- **Render starts the new copy of a deploy beside the old one and stops the old one only once the new one has opened its port.** The old copy's stopping is what lets go of the lease, so a new copy that waited for the lease with no port open waited forever. A first fix answered on the port only while it waited for the lease, and closed that door the moment the lease was taken; the roughly 50 seconds after that (restoring, starting) had nothing listening, visitors saw "Bad Gateway", and 38 seconds in Render marked the instance failed (`connection refused` on the port, in the service's Events) and restarted it, which doubled the time the bot was away (seen on the deploys of 2026-10-18 at 02:39 and 03:07 UTC). `src/cloud/front-door.ts` now keeps the port open from the first moment to the last. The settings (Synapse's, the bridge's) are made while the host waits for the lease, the three databases are restored at once, and the lease is looked at every second or two instead of every 15 seconds. Synapse's signing key is kept in the bucket (`keys/synapse-signing.key`, written by the first start from what Synapse itself made): a start that finds it puts it in place, and only a start that doesn't (the first, or a bucket that can't be read) has Python make one, which on a tenth of a CPU is 15 to 20 seconds.
- **The free plan's tenth of a CPU** makes everything that is not a plain restart slow: after linking Google Messages, the bridge needed several minutes to make rooms for 25 chats. A restart itself, restore included, takes about a minute.
- **Memory** stays near 260 MB of 512 while the bridge makes its rooms; idle it was about 200 MB at first and is 220 to 230 MB after a start now (see Memory above).
- **Google** accepted the bridge's session from Render's address, and the pasted-request link worked. **Render's amd64 build** works.
- **The catalog import**, **Litestream's backup and restore** on real R2, the **hello message** and **answers to texts** all work.
- **Email**: the Worker's mail was accepted by Cloudflare's `send_email`; whether the first one reached an inbox (or the spam folder) is for you to confirm.

**Learned on 2026-10-18, with songs coming through the Worker:**

- **YouTube's bot check meets Cloudflare too, now and then, and goes again within a minute or two.** The start-up check met it at 02:37 (and so did a second ask straight after); of asks every 15 to 30 seconds from 02:41, 14 came through, then most of those from 02:47:12 to 02:48:27 were turned away (some with HTTP 403, after about 8 seconds, instead of the bot check), and from 02:48:39 they came through again; at one ask a minute after that, 7 of 10 came through, and a spell from 03:00 lasted over two minutes. About one ask in four was turned away, always in spells. Until then the bot asked once more at once and then left YouTube aside for 15 minutes, a quarter of an hour without Zemer for a minute or two of trouble; now it asks again after a wait and checks back after a minute (above). The Worker kept no logs, so how often this happened before can't be counted; it now keeps them.
- **Deploys with the front door and the kept signing key, measured on 2026-10-18/19 (UTC):** the port never refused a connection, and Render logged no `server_failed` (each of the two deploys before the front door ended in one, followed by a restart Render forced). Visitors saw the front door's own "Starting up" answers (waiting for the previous copy, restoring the databases, starting the services) and then the bot's door; at the moment Render moved traffic over, one deploy showed a 502 for 0.4 to 0.65 s (that is Render's routing switching copies, not the host: it happened with and without a front door on the copy being stopped) and one showed none. **The bot was away** (from the old copy's SIGTERM to `signed in as`): 124 and 132 s without the front door; **70 s** with it; **65 s** on the first deploy that kept Synapse's key (it still had to make the key, 12 s of Python, and keep it); **55 s** on the next one, which took the key from the bucket while it was still waiting for the old copy to stop. Where the 55 s went: the lease changed hands in 2.5 s (11 to 12 s before); the three restores took 14 s (10 to 18 s in the runs so far, at once or not, which points at the CPU and not at R2); Synapse then took about 30 s to answer, and the bridge and the bot's sign-in about 9 s more. What remains is nearly all CPU on the free plan's tenth of a CPU.

**Learned on 2026-10-18 to 20 (UTC), with OneDrive, bigger songs and a deleted chat:**

- **OneDrive works against the real service.** Songs have been saved since 2026-10-18 03:45 UTC, M4A and MP3, 2.7 to 11.3 MB in the lines seen, into `Artist/Album/NN Title.ext` and `Artist/Singles/Title.ext` (missing folders are made, Hebrew names survive). The memory guard has been seen to skip a save, as designed: `not saving … to OneDrive: 3 songs are already waiting`; the song is still sent.
- **The memory fixes held.** After the kill of 2026-10-18 21:58 UTC the send path was slimmed (tag in front of the audio, Blobs of about 4 MB, a streamed upload to the homeserver, a streaming patch in the bridge, the OneDrive copy taken from the sent song a piece at a time); 27 MB MP3s have since gone through with the container peaking near 370 MB, and Render's Events show no further `oomKilled`. The numbers are under **Memory**, above.
- **Requests are answered while a song is on its way** (deployed 2026-10-20 01:31 UTC) and **a long list arrives whole** (the homeserver's per-user message limit lifted, deployed 01:34 UTC): a 12-line list took 6.4 s with no 5-second gap.
- **A chat deleted on the phone** (2026-10-19): the self-chat was moved to the trash at about 04:20 UTC, the bridge deleted its room, and nothing told the bot, which went on running and hearing nothing. The first message the room refused crashed it (14:30 UTC), and every start after that died joining the old room, restarting every few seconds, while the page that could have taken the new chat was up for about five seconds a minute. The owner's next text to themself made a new room; since 2026-10-20 02:09 UTC `MATRIX_ROOM_ID` names it, and the fix below (deployed 02:11 UTC) makes the next time a waiting state with a mailed alert, not a crash loop. A `Denying new event … 403: You are not invited to this room` warning from Synapse for one bridge contact at the start of 2026-10-20 02:12 UTC is probably a remnant of the same event; it has not been looked into.
- **Deploys now take about a minute**: 53 and 60 seconds from Render marking the deploy live to the bot signing in (2026-10-20 02:09 and 02:11 UTC).

**Not tried yet, or not proven:**

1. **An album as one zip, delivered live.** The build that makes it (disk spool, streamed upload, patched bridge) was deployed 2026-10-19 03:22 UTC, and a numbered album list and a 23-song list from an album's number worked, and a 27 MB song went through the patched bridge twice without errors. But no multi-song album has been delivered by it: the one request (a 12-song album, 04:11 UTC) met YouTube's bot check three times in a row from Cloudflare, so none of its songs could be fetched and YouTube songs were left aside for a minute. Before that build, albums arrived as 30 MB parts. The first one that goes out will show whether the bridge's patch and Google Messages take a zip of tens of MB.
2. **OneDrive over time.** That a Microsoft sign-in lasts weeks, and which scope is in force (`ONEDRIVE_SCOPE` in Render's Environment; empty is the narrow app-folder one; if uploads to `special/approot:/…` were refused, set it to `Files.ReadWrite offline_access`, which gives the app your whole OneDrive).
3. **Bandwidth**: the monthly 5 GB on a Hobby workspace; watch `/status` (`sentThisMonthMb`) and Render's own figure for the first month.
4. **A long unattended stretch**: the free plan may restart the service at any time. Render's Events from 2026-10-18 to 2026-10-20 show only our own deploys, the restarts Render forced before the front door existed, and the one `oomKilled`; the bot process itself crashed once (the deleted chat, fixed). Whether the Worker's alerts are enough is still to be seen.
5. **The Cloudflare Worker's deployed version.** Its source last changed in `0a069eb` (2026-10-18, deployed by hand with `npx wrangler deploy`); the relay has been working since, but nothing in this repository says which version is live. `npx wrangler deployments list` in `cloudflare/` does.

Not built: moving saved songs from the synced OneDrive folder onto an external drive (do it by hand), saving the songs the Mac's background jobs used to keep ready in advance (only songs actually sent are saved), and drawing the song cards and the daily collage on Linux (they fall back to a plain cover; the collage is skipped).
