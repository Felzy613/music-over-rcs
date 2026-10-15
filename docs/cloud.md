# Running it in the cloud (Render and Cloudflare)

This moves everything that runs on the Mac (the Matrix homeserver, the Google Messages bridge and the bot) to a cloud host, so the bot keeps answering when your Mac loses its internet. It costs nothing beyond a Cloudflare Workers plan you may already have.

**Status:** the code is written and tested, and the container has been built and run on a Mac against a stand-in for R2 ([what that proved](#what-has-been-tried-and-what-hasnt)). Nothing has run on Render, on real R2, or against the real OneDrive and Google yet.

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
  R2 bucket "mors-state"   the database backups, the lease, and the alerts waiting to be mailed
  Worker "mors-edge"       every 5 min: asks the web door if it is up (which also keeps Render's
                           free service awake), and mails what the bot left in alerts/
```

Why these pieces:

- **Render's free plan** sleeps after 15 minutes without a request, may restart at any time, and wipes its disk when it does. The Worker's check every five minutes keeps it awake, and the databases (Synapse's, the bridge's, the bot's catalog) are backed up to R2 every minute and restored at each start, so a wiped disk loses at most about a minute of changes.
- **The lease** is what stops two copies running at once. Render starts a new copy before it stops the old one on a deploy; two bridges on one Google login would unpair the phone, and two writers on one backup would corrupt it. It is a file in the bucket, changed only with R2's conditional writes; the new copy waits until the old one lets go (it does when it is stopped) or its lease runs out (it crashed).
- **The host and the Worker never call each other's front door.** Cloudflare puts a bot challenge in front of every automated client on `workers.dev`, so a host calling the Worker would be turned away. They meet in the bucket instead: the host writes its alerts there, and the Worker reads them. (The Worker does call the host, and that direction is fine.)
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

**Memory** is the tight resource: 512 MB for the homeserver, bridge, bot and Litestream together. Measured idle it is about 200 MB. A song passing through takes two to three times its size in the bot, so `MAX_DOWNLOAD_MB` is 30 on this host, and a song's OneDrive copy waits a few seconds after the send and, if the container's memory is short, waits for room or is skipped (the song is still sent). If it is still too tight, the same image runs on a paid host (see [Moving to a paid host](#moving-to-a-paid-host)).

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

Deploy the Worker and give it your addresses:

```bash
npx wrangler deploy
npx wrangler secret put ALERT_FROM     # an address on your Email Service domain, e.g. alerts@yourdomain.com
npx wrangler secret put ALERT_TO       # your own verified address
```

Nothing personal goes in a file: the addresses are Worker secrets. Until you give the Worker Render's address (step 3) it checks nothing.

### 2. Render

Create a **workspace** for this (Render dashboard, workspace menu, *New workspace*), then a **Blueprint** in it (New, Blueprint), from this repository and the branch that holds `render.yaml`. It makes the web service and generates `SECRET_KEY`, `MATRIX_PASSWORD` and `ADMIN_TOKEN` for you. Fill in the ones marked as yours:

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

Your other chats are not copied: the bridge makes no rooms at login (`initial_chat_sync_count: 0`) and no backfill, only for chats that get a message while it runs.

### 5. Save songs to your OneDrive (optional)

Songs aren't kept on the host, so this is how you keep them. Each song the bot sends is also uploaded, in the background, to `Apps/<the app's name>/Artist/Album/01 Title.mp3` in your OneDrive, with its tags and cover written in. Sign-in is Microsoft's device-code flow: you type a code at microsoft.com yourself, and neither your password nor any cookie reaches the bot.

Register the app once (about two minutes, no cost) at [entra.microsoft.com](https://entra.microsoft.com) → App registrations → New registration:

1. **Name**: `Music over RCS` (this becomes the folder name under `Apps/`).
2. **Supported account types**: *Personal Microsoft accounts only* (or the option that includes them).
3. After creating it: **Authentication** → *Allow public client flows* → **Yes**, and save.
4. **API permissions** → Add → Microsoft Graph → Delegated → `Files.ReadWrite.AppFolder` and `offline_access`.
5. Copy the **Application (client) ID** from the Overview page into Render as `ONEDRIVE_CLIENT_ID` (the service restarts).

Then open the `/pair` page, press **Sign in to OneDrive** under step 3, open the address it shows, enter the code and approve. The page shows what has been saved this month. The OneDrive app on your Mac syncs the folder down; from there you can move songs onto the external drive as you did before.

Microsoft renews the sign-in each time the bot uses it. If it is revoked (a password change can do it), the bot emails you and you press the button again.

### 6. Carry over your plays and follows (optional)

On the Mac, make a copy of the catalog and upload it to the new host. It brings the songs, plays, follows and the daily message's state, but not the old chat's message links.

```bash
sqlite3 "$HOME/Library/Application Support/music-over-rcs/catalog.db" "VACUUM INTO '/tmp/catalog-export.db'"
read -rs ADMIN_TOKEN; echo     # paste Render's ADMIN_TOKEN
curl --fail -u ":$ADMIN_TOKEN" --data-binary @/tmp/catalog-export.db https://<service>.onrender.com/admin/import-catalog
rm /tmp/catalog-export.db
```

It works only before the bot starts (the catalog must be empty). Then remove `ALLOW_IMPORT` from Render's environment.

### 7. Switch over

Two bots on one chat both answer, so stop the Mac's first:

```bash
npm run stack -- disable-bot
```

Then set `BOT_ENABLED` to `on` in Render (changing the environment restarts the service). `npm run cloud:check` reaches "The bot is answering texts". Try `search`, a 👍 on a list line, and `all`; then restart the service from the Render dashboard and confirm a text sent during the restart is still answered afterwards.

**Rolling back:** suspend the Render service, then `npm run stack -- enable-bot` on the Mac. After a week of it working, unpair the Mac's old Google session (Google Messages, Device pairing) and leave the Mac stack stopped.

## Day to day

- **`/status`** (the same password) reports the phase, bridge login state, problems, memory, the lease, what the Worker last saw, and bytes sent this month. **`/pair`** is also where you re-link Google Messages if it ever unlinks.
- **Email**: the bot's problem reports (bridge unlinked, site not answering, OneDrive sign-in lost) reach you within five minutes, mailed by the Worker; the Worker adds "the host isn't answering" (three missed checks in a row) and "the bot isn't running" (up but not answering for 30 minutes). A problem is repeated at most every six hours.
- **Deploys** are manual (`autoDeploy: false`). A deploy briefly runs the new copy beside the old; the lease holds it until the old one has stopped.
- **Re-pairing** can change the chat's room. `/pair` lets you choose it again; no environment change is needed.
- **Logs** are in the Render dashboard; each line is prefixed with the process (`[bot]`, `[bridge]`, `[synapse]`, `[litestream]`).

## Settings

The ones that matter for the cloud host. The bot's own settings (`DIGEST_TIME`, `QUIET_HOURS`, …) are in [Configuration](configuration.md).

| Setting | Meaning |
|---|---|
| `SECRET_KEY` | Master secret the homeserver's and bridge's secrets are derived from (so they're the same at every start). Keep it; changing it logs the bot out of the homeserver |
| `MATRIX_USER`, `MATRIX_PASSWORD` | The bot's account (default user `me`); created on first start |
| `ADMIN_TOKEN` | Password for `/status`, `/pair` and the rest. Without it only `/healthz` answers |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | The bucket: backups, the lease, the alerts. Without them **nothing is backed up, there is no lease and no alert**, and the start says so |
| `R2_REGION` | `auto` (the default) for R2; another S3 server may want a named region |
| `ONEDRIVE_CLIENT_ID` | The Azure app's client id. Empty or `none`: nothing is saved to OneDrive |
| `ONEDRIVE_MAX_MB_PER_MONTH` | The most uploaded to OneDrive in a calendar month (default 1500, or `unlimited`) |
| `BOT_ENABLED` | `off` keeps the bot from answering (setup only) |
| `ALLOW_IMPORT` | `1` allows the one-time catalog upload |
| `PREFETCH_MB` | `0` on this host (nothing is kept on a wiped disk) |
| `MAX_DOWNLOAD_MB`, `DOWNLOADS_AHEAD` | Smaller than on the Mac (30 and 1): each file is held in memory whole |
| `BOT_HEAP_MB`, `BOT_MEMORY_MB` | The bot's heap cap (default 120), and its share of memory (default 220) used to hold back a big song's OneDrive copy where the container's own limit can't be read |
| `SERVER_NAME`, `SYNAPSE_PORT`, `BRIDGE_PORT`, `DATA_DIR` | Defaults `localhost`, 8008, 29336, `/data` (`deploy/cloud/litestream.yml` names the databases under `/data`, so change them together) |

## Moving to a paid host

The same image runs anywhere that runs a Docker container with the same environment.

- **Render Starter** ($7/mo): change `plan` to `starter`. It doesn't sleep, so the Worker's keep-awake isn't needed, and has a full CPU share, which makes restarts quick. With a persistent disk ($0.25/GB) the backups matter less but still work.
- **Cloudflare Containers** (about $7/mo more on the Workers plan you have): its disk is also wiped on restart, so the same R2 backups and lease apply. It has far more outbound traffic included than Render's free plan.

## What has been tried, and what hasn't

Tried, on a Mac, with the real container image (Synapse 1.143.0, the bridge at `186284e`, Litestream 0.5.17, Node 24) and an S3 server standing in for R2, limited to 512 MB and, for the timing, a tenth of a CPU (Render's free share):

- It builds, and starts: the lease, restoring (or finding no backup), the bridge's real generated config patched by `src/cloud/provision.ts`, the account created, the bot signed in.
- A stopped host leaves cleanly (processes stopped in order, lease released); a brand-new container with an empty disk restored all three databases and carried on (the account, the bot's saved state).
- A second host waits and starts nothing while the first runs, takes over within seconds of a clean stop, and after a kill -9 once the dead host's lease runs out (about 75 seconds).
- A cold start with a restore reached "ready" in 36 seconds at a tenth of a CPU. Idle memory about 200 MB of 512.
- Songs of 20 and 30 MB passing through, with their OneDrive copy, fit without the host being killed (the container's peak, including reclaimable file cache, was 400 to 450 MB). The request signing matches AWS's published test vectors and a real S3 server's checks.

**Not tried yet** (the first deploy will show):

1. **Real R2.** Its conditional writes are documented to work as the lease needs (and the stand-in S3 server behaved exactly so), and Litestream is documented to work against it, but this has not been run against R2 itself.
2. **Render itself**: the Blueprint (`autoDeploy: false` is still the right key), the amd64 build (it was built here for ARM), the real memory and CPU share, and its bandwidth figure.
3. **OneDrive** against the real service, only against a stand-in written from Microsoft's documentation. To check on the first real upload: that the app-folder permission (`Files.ReadWrite.AppFolder`) is accepted for upload sessions at `special/approot:/…` (if not, set `ONEDRIVE_SCOPE` to `Files.ReadWrite offline_access`, which gives the app your whole OneDrive), that missing folders are made, and that a Microsoft account sign-in lasts.
4. **Google** accepting a data-centre address for the bridge's session, and YouTube Music and music-table.com answering requests from one.
5. **Email** from the Worker (the domain set up for Email Service).

Not built: moving the songs from the synced OneDrive folder onto the external drive (do it by hand, or ask for a command that does it when the drive is connected), saving the songs the Mac's background jobs would have kept ready in advance (only songs actually sent are saved), and drawing the song cards and the daily collage on Linux (they fall back to a plain cover; the collage is skipped).
