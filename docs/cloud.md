# How it runs: Render and Cloudflare

Since 2026-10-16 the bot runs here, not on a Mac: the Matrix homeserver, the Google Messages bridge and the bot are one Docker container on Render's free plan, with a Cloudflare Worker and an R2 bucket beside it. A Mac that loses its internet no longer matters. It costs nothing beyond a Cloudflare Workers plan you may already have. This page is the runbook: how it fits together, what it costs, how it was set up (and how to set it up again), what to do day to day, and what has been proven.

**Status:** live. Render service `music-over-rcs` (Ohio, free plan; deploy branch `main`), Worker `mors-edge`, bucket `mors-state`. Songs are **not saved anywhere yet**: that needs the OneDrive app in step 5, which is not set up.

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
- **A restart** takes under a minute (36 seconds measured, restore included). Texts sent meanwhile are answered when the bot is back: it remembers how far it got (`src/runner.ts`, "resume").

## What it costs and the limits

| | |
|---|---|
| Render free web service | $0. About 744 of the 750 free instance hours in a 31-day month, and **the hours are shared by everything in a Render workspace**: create this service in a workspace with no other always-on free service |
| Cloudflare Workers Paid ($5) | Already yours. The cron and R2 are well inside what it includes |
| R2 | 10 GB free; the backups are tens of MB. The 60 s sync interval keeps writes near 130,000 a month against 1 million free |
| Email | Free to an address you've verified in Cloudflare |
| OneDrive | Your own plan. The app can only see its own folder, `Apps/<the app's name>` |
| **Render outbound bandwidth** | A Hobby workspace includes **5 GB a month**. Songs sent to Google are the bulk, and each song saved to OneDrive is uploaded from Render too, so it counts again (`ONEDRIVE_MAX_MB_PER_MONTH`, 1500 by default, stops the saving, never the sending). Over it, Render charges $0.15/GB, or suspends the service if you have no card on file. `/status` shows `sentThisMonthMb`; check the figure in the Render dashboard too, since Render's pages disagree on it |

**Memory** is the tight resource: 512 MB for the homeserver, bridge, bot, Litestream and the supervisor together. Right after a start it is about 250 MB, and over a day it creeps up to 315 to 335 MB (Render's graph; steps up after album-length sends that never come back down), which leaves 180 to 200 MB for a song. A song passing through takes about three times its size in the bot while it is fetched and tagged (measured: 81 MB of buffers for a 27 MB MP3), and the bridge and the homeserver hold it again while they hand it to Google, so `MAX_DOWNLOAD_MB` is 30 on this host. Its OneDrive copy is uploaded straight from the song that was sent, a 10 MiB piece at a time (about 24 MB held instead of 81), and waits 5 s plus half a second per MB after the send so the bridge has finished with it; if the container's memory is still short it waits for room or is skipped (the song is still sent). **Who holds the memory** is in the host's log: while the container is past 85% of its limit a line starting `memory:` names the processes and their megabytes every 15 s (and says when it is back down), and a routine `memory (routine check):` line is written 90 s after each start and every six hours; `/status` has the same breakdown under `memory`, with the highest the container reached since the start and who held it then (`npm run cloud:check` judges that, not the bot's size alone). If it is still too tight, the same image runs on a paid host (see [Moving to a paid host](#moving-to-a-paid-host)). **At rest** (the first `memory (routine check)` line, 90 s after a start on 2026-10-19): 231 of 512 MB in anonymous memory, held by Synapse 99 MB, the supervisor (`entrypoint.ts`, the web front door included) 53 MB, the bot 51 MB, the bridge 15 MB, Litestream 14 MB and Render's own port detector 9 MB; the later routine lines (every six hours) show which of them is what creeps up over a day. **The first kill** (2026-10-18 21:58 UTC, Render's Events: `oomKilled`, limit 512Mi) came 5 s after a 27 MB MP3 was sent, when the OneDrive copy began on a host already at 334 MB; the retry at 22:07 saved it with the container at 458 MB for a half-minute.

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

### 4. Link Google Messages and choose your chat

Open `https://<service>.onrender.com/pair` (any user name; the password is `ADMIN_TOKEN`). Press **Start login**, follow the bridge's instructions in a private browser window, paste the request it asks for, and tap the emoji on your phone. The pasted request holds your Google cookies; you paste it only into this page, and it is deleted from the chat a minute later. Then text yourself once from your phone, enter your number under step 2 on the page, press **Find**, and choose the room.

The free plan gets about a tenth of a CPU, so after you link, the bridge needs several minutes to make its rooms. Wait for the logs to go quiet (or about ten minutes) before pressing **Find**; a chat whose room is not made yet is not found.

What the bridge copies is more than your one chat: right after linking it makes a room for each of your 25 most recent conversations (a name and a number, no old messages), and from then on it relays every message in any chat into Synapse while it runs. The bot reads only the room you choose. See [Privacy and security](privacy-and-security.md#what-the-bridge-copies).

### 5. Save songs to your OneDrive (not done yet)

Songs aren't kept on the host, so until this is set up **nothing is saved**: each song is fetched, sent, and gone. This is how you keep them. Each song the bot sends is also uploaded, in the background, to `Apps/<the app's name>/Artist/Album/01 Title.mp3` in your OneDrive, with its tags and cover written in. Sign-in is Microsoft's device-code flow: you type a code at microsoft.com yourself, and neither your password nor any cookie reaches the bot.

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
- **Email**: the bot's problem reports (bridge unlinked, site not answering, OneDrive sign-in lost) reach you within five minutes, mailed by the Worker; the Worker adds "the host isn't answering" (three missed checks in a row) and "the bot isn't running" (up but not answering for 30 minutes). A problem is repeated at most every six hours.
- **Deploying a change**: push to `main`, then Render dashboard → the service → *Manual Deploy* → *Deploy latest commit*. The bot is away for a minute or so while the new copy restores and starts; texts sent meanwhile are answered afterwards, and the web address shows a "Starting up" page that reloads itself rather than "Bad Gateway" (see the next point). Wait for it; clicking deploy again only starts the whole sequence over. Only one deploy runs at a time, and each queues behind the last, so do not stack them. A deploy that never finishes (it waits on the lease, see below) is failed by Render after about 15 minutes; *Cancel deploy* in the Events list starts the next one at once.
- **Deploys** are manual (`autoDeploy: false`). A deploy briefly runs the new copy beside the old; the lease holds it until the old one has stopped. Render sends traffic to the new copy, and stops the old one, as soon as the new copy's port accepts a connection, so the host opens that port first thing and keeps it open (`src/cloud/front-door.ts`, run by `deploy/cloud/entrypoint.ts`): `/healthz` is answered by the front door itself, and everything else is passed to the bot's own web door on `BOT_WEB_PORT` (8081, this machine only), or answered 503 with a self-reloading "Starting up" page that says what the start is doing while the bot isn't there yet (waiting for the previous copy, restoring the databases, starting the services). Without an open port a deploy would wait on itself forever, and with the port closed in the middle of a start (as the first version did once the lease was taken) visitors got Render's "Bad Gateway" and Render, finding the port refusing connections, restarted the instance it had just started.
- **Uptime monitor (Better Stack and the like)**: watch `https://<service>.onrender.com/ping` and treat **HTTP 500** as up. `/ping` answers 500 on purpose, and neither Render's "starting up" page nor its gateway errors (502/503) nor the waiting door above ever say 500, so only the running web door passes; a sleeping service just keeps failing the check until it has woken. `/healthz` (200) stays what the Worker uses.
- **Re-pairing** can change the chat's room. `/pair` lets you choose it again; no environment change is needed.
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
| `BOT_ENABLED` | `off` keeps the bot from answering (setup only) |
| `ALLOW_IMPORT` | `1` allows the one-time catalog upload |
| `PREFETCH_MB` | `0` on this host (nothing is kept on a wiped disk) |
| `MAX_DOWNLOAD_MB`, `DOWNLOADS_AHEAD` | Smaller than the defaults (100 and 3), because each file is held in memory whole: 30 and 1 here |
| `BOT_HEAP_MB`, `BOT_MEMORY_MB` | The bot's heap cap (default 120), and its share of memory (default 220) used to hold back a big song's OneDrive copy where the container's own limit can't be read |
| `BOT_WEB_PORT` | The bot's own web door, on this machine only (default 8081). The front door holds `PORT` (Render sets it) and passes requests here; the two must differ |
| `SERVER_NAME`, `SYNAPSE_PORT`, `BRIDGE_PORT`, `DATA_DIR` | Defaults `localhost`, 8008, 29336, `/data` (`deploy/cloud/litestream.yml` names the databases under `/data`, so change them together) |

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
- **Memory** stays near 260 MB of 512 while the bridge makes its rooms; idle it was about 200 MB at first and is about 250 MB after a start now (see Memory above).
- **Google** accepted the bridge's session from Render's address, and the pasted-request link worked. **Render's amd64 build** works.
- **The catalog import**, **Litestream's backup and restore** on real R2, the **hello message** and **answers to texts** all work.
- **Email**: the Worker's mail was accepted by Cloudflare's `send_email`; whether the first one reached an inbox (or the spam folder) is for you to confirm.

**Learned on 2026-10-18, with songs coming through the Worker:**

- **YouTube's bot check meets Cloudflare too, now and then, and goes again within a minute or two.** The start-up check met it at 02:37 (and so did a second ask straight after); of asks every 15 to 30 seconds from 02:41, 14 came through, then most of those from 02:47:12 to 02:48:27 were turned away (some with HTTP 403, after about 8 seconds, instead of the bot check), and from 02:48:39 they came through again; at one ask a minute after that, 7 of 10 came through, and a spell from 03:00 lasted over two minutes. About one ask in four was turned away, always in spells. Until then the bot asked once more at once and then left YouTube aside for 15 minutes, a quarter of an hour without Zemer for a minute or two of trouble; now it asks again after a wait and checks back after a minute (above). The Worker kept no logs, so how often this happened before can't be counted; it now keeps them.
- **Deploys with the front door and the kept signing key, measured on 2026-10-18/19 (UTC):** the port never refused a connection, and Render logged no `server_failed` (each of the two deploys before the front door ended in one, followed by a restart Render forced). Visitors saw the front door's own "Starting up" answers (waiting for the previous copy, restoring the databases, starting the services) and then the bot's door; at the moment Render moved traffic over, one deploy showed a 502 for 0.4 to 0.65 s (that is Render's routing switching copies, not the host: it happened with and without a front door on the copy being stopped) and one showed none. **The bot was away** (from the old copy's SIGTERM to `signed in as`): 124 and 132 s without the front door; **70 s** with it; **65 s** on the first deploy that kept Synapse's key (it still had to make the key, 12 s of Python, and keep it); **55 s** on the next one, which took the key from the bucket while it was still waiting for the old copy to stop. Where the 55 s went: the lease changed hands in 2.5 s (11 to 12 s before); the three restores took 14 s (10 to 18 s in the runs so far, at once or not, which points at the CPU and not at R2); Synapse then took about 30 s to answer, and the bridge and the bot's sign-in about 9 s more. What remains is nearly all CPU on the free plan's tenth of a CPU.

**Not tried yet:**

1. **OneDrive** against the real service, only against a stand-in written from Microsoft's documentation. To check on the first real upload: that the app-folder permission (`Files.ReadWrite.AppFolder`) is accepted for upload sessions at `special/approot:/…` (if not, set `ONEDRIVE_SCOPE` to `Files.ReadWrite offline_access`, which gives the app your whole OneDrive), that missing folders are made, and that a Microsoft account sign-in lasts.
2. **Bandwidth**: the monthly 5 GB on a Hobby workspace; watch `/status` (`sentThisMonthMb`) and Render's own figure for the first month.
3. **A long unattended stretch**: the free plan may restart the service at any time; the first week will show how often and whether the Worker's alerts are enough.

Not built: moving saved songs from the synced OneDrive folder onto an external drive (do it by hand), saving the songs the Mac's background jobs used to keep ready in advance (only songs actually sent are saved), and drawing the song cards and the daily collage on Linux (they fall back to a plain cover; the collage is skipped).
