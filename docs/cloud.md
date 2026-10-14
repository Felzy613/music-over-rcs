# Running it in the cloud (Render and Cloudflare)

This moves everything that runs on the Mac (the Matrix homeserver, the Google Messages bridge and the bot) to a cloud host, so the bot keeps answering when your Mac loses its internet. It costs nothing beyond a Cloudflare Workers plan you may already have.

**Status: written and tested here, not yet deployed.** The code and the tests run; the `Dockerfile` has never been built and nothing has run on Render. [What isn't verified](#what-isnt-verified-yet) lists what the first deploy has to prove.

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
  Worker "mors-edge"   every 5 min: asks the web door if it is up (which also keeps Render's
                       free service awake), emails you if it isn't; hands out the lease;
                       emails the bot's problem reports
  R2 bucket "mors-state"   the database backups and the lease
```

Why these pieces:

- **Render's free plan** sleeps after 15 minutes without a request, may restart at any time, and wipes its disk when it does. The Worker's check every five minutes keeps it awake, and the databases (Synapse's, the bridge's, the bot's catalog) are backed up to R2 every minute and restored at each start, so a wiped disk loses at most about a minute of changes.
- **The lease** is what stops two copies running at once. Render starts a new copy before it stops the old one on a deploy; two bridges on one Google login would unpair the phone, and two writers on one backup would corrupt it. The new copy waits until the old one lets go.
- **Songs** are not kept on the host (its disk is wiped); each one is fetched when asked for. With OneDrive set up (step 5), every song sent is also saved to your OneDrive, tagged and sorted as `Artist/Album/01 Title.mp3`, in the app's own folder.
- **A restart** takes a minute or a few (the homeserver is slow on the free plan's small share of a CPU). Texts sent meanwhile are answered when the bot is back: it remembers how far it got (`src/runner.ts`, "resume").

## What it costs and the limits

| | |
|---|---|
| Render free web service | $0. It uses about 744 of the 750 free instance hours in a 31-day month, so **don't run any other free Render service in this workspace** |
| Cloudflare Workers Paid ($5) | Already yours. The cron, the Worker's requests and R2 are well inside what it includes |
| R2 | 10 GB free; the backups are tens of MB. The 60 s sync interval keeps writes near 130,000 a month against 1 million free |
| Email | Free to an address you've verified in Cloudflare |
| OneDrive | Your own plan (1 TB). The app can only see its own folder, `Apps/<the app's name>` |
| **Render outbound bandwidth** | The Hobby workspace includes **5 GB a month**. Songs sent to Google are the bulk, and each song saved to OneDrive is uploaded from Render too, so it counts again (`ONEDRIVE_MAX_MB_PER_MONTH`, 1500 by default, stops the saving, never the sending). Over it, Render charges $0.15/GB, or suspends the service if you have no card on file. `/status` shows `sentThisMonthMb` (what the bot uploaded); check the figure in the Render dashboard too, since Render's pages disagree on it |

The free plan has 512 MB of memory for the homeserver, bridge, bot and Litestream together. If it runs out, the same image runs on a paid host (see [Moving to a paid host](#moving-to-a-paid-host)).

## Setting it up

You need a Cloudflare account (Workers Paid), a Render account, this repository on GitHub, and, for email alerts, a domain on Cloudflare DNS. Without a domain, use ntfy.sh instead (step 1).

### 1. Cloudflare

```bash
cd cloudflare
npx wrangler login
npx wrangler r2 bucket create mors-state
```

Create an R2 API token with **Object Read & Write** on that bucket only (Cloudflare dashboard, R2, Manage API tokens). It gives you an access key id, a secret, and the bucket's S3 address, `https://<account id>.r2.cloudflarestorage.com`. You'll give these to Render in step 2.

Edit `cloudflare/wrangler.jsonc`: `ALERT_FROM` is an address on your domain, `ALERT_TO` is your own address. Onboard the domain for Email Service and verify `ALERT_TO` as a destination address (dashboard, Email Service). Without a domain, delete the `send_email` block and set `NTFY_TOPIC` as a secret instead (install the ntfy app and subscribe to a topic nobody could guess).

Make a long random token, deploy, and store the token:

```bash
openssl rand -hex 32          # the shared token; keep it for step 2
npx wrangler deploy
npx wrangler secret put EDGE_TOKEN
```

Deploying prints the Worker's address, `https://mors-edge.<your-subdomain>.workers.dev`. It is deployed first because Render needs it, and it needs Render's address in turn; until you give it that (step 3) it checks nothing and emails nothing. Check it:

```bash
EDGE_TOKEN=<the shared token> npm run cloud:check -- --worker https://mors-edge.<your-subdomain>.workers.dev --alert
```

`--alert` also sends one test email (or ntfy message), so you know alerts reach you.

### 2. Render

Create a **Blueprint** from this repository (Render dashboard, New, Blueprint). It reads `render.yaml`, makes the web service, and generates `SECRET_KEY`, `MATRIX_PASSWORD` and `ADMIN_TOKEN` for you. Fill in the ones marked as yours:

| Setting | Value |
|---|---|
| `EDGE_URL` | the Worker's address from step 1 |
| `EDGE_TOKEN` | the shared token from step 1 |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | from the R2 token (bucket `mors-state`) |

Let it deploy and watch the logs. A first build takes several minutes (it compiles the bridge). A healthy start prints `took the lease`, `no backup yet for …` (the first time), `started synapse`, `started bridge`, `started bot`, then `no chat chosen yet`.

### 3. Tell the Worker where Render is

Set `RENDER_URL` in `wrangler.jsonc` to the service's address (`https://….onrender.com`), then:

```bash
cd cloudflare
npx wrangler secret put RENDER_ADMIN_TOKEN     # Render's ADMIN_TOKEN, from its environment page
npx wrangler deploy
```

The five-minute check starts. Look at both ends at once:

```bash
EDGE_TOKEN=… ADMIN_TOKEN=… npm run cloud:check -- --worker https://mors-edge.<your-subdomain>.workers.dev --render https://<service>.onrender.com
```

It says, in plain lines, what is working and what to do about what isn't (Google Messages not linked yet, the bot not running yet, memory, the month's traffic). Run it again after each of the next steps.

### 4. Link Google Messages and choose your chat

Open `https://<service>.onrender.com/pair` (any user name; the password is `ADMIN_TOKEN`). Press **Start login**, follow the bridge's instructions in a private browser window, paste the request it asks for, and tap the emoji on your phone. The pasted request holds your Google cookies; you paste it only into this page, and it is deleted from the chat a minute later. Then text yourself once from your phone, enter your number under step 2 on the page, press **Find**, and choose the room.

Your own other chats are not copied: the bridge makes no rooms at login (`initial_chat_sync_count: 0`) and no backfill, only for chats that get a message while it runs.

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

Then set `BOT_ENABLED` to `on` in Render (changing the environment restarts the service). `/status` reaches `"phase": "running"`. Try `search`, a 👍 on a list line, and `all`; then restart the service from the Render dashboard and confirm a text sent during the restart is still answered afterwards.

**Rolling back:** suspend the Render service, then `npm run stack -- enable-bot` on the Mac. After a week of it working, unpair the Mac's old Google session (Google Messages, Device pairing) and leave the Mac stack stopped.

## Day to day

- **`/status`** (the same password) reports the phase, bridge login state, problems, memory, and bytes sent this month. **`/pair`** is also where you re-link Google Messages if it ever unlinks.
- **Email**: the bot sends the problems it used to show as Mac notifications (bridge unlinked, site not answering); the Worker adds "the host isn't answering" (three missed checks in a row) and "the bot isn't running" (up but not answering for 30 minutes). A problem is repeated at most every six hours.
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
| `EDGE_URL`, `EDGE_TOKEN` | The Worker: lease and alerts. Without them there is no lease (run only one copy) and no email |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | The backup. Without them **nothing is backed up** and the start says so |
| `ONEDRIVE_CLIENT_ID` | The Azure app's client id. Without it nothing is saved to OneDrive |
| `ONEDRIVE_MAX_MB_PER_MONTH` | The most uploaded to OneDrive in a calendar month (default 1500, or `unlimited`) |
| `BOT_ENABLED` | `off` keeps the bot from answering (setup only) |
| `ALLOW_IMPORT` | `1` allows the one-time catalog upload |
| `PREFETCH_MB` | `0` on this host (nothing is kept on a wiped disk) |
| `MAX_DOWNLOAD_MB`, `DOWNLOADS_AHEAD` | Smaller than on the Mac (40 and 1): each file is held in memory whole |
| `BOT_HEAP_MB` | The bot's memory cap (default 120) |
| `SERVER_NAME`, `SYNAPSE_PORT`, `BRIDGE_PORT`, `DATA_DIR` | Defaults `localhost`, 8008, 29336, `/data` (`deploy/cloud/litestream.yml` names the databases under `/data`, so change them together) |

## Moving to a paid host

The same image runs anywhere that runs a Docker container with the same environment.

- **Render Starter** ($7/mo): change `plan` to `starter`. It doesn't sleep, so the Worker's keep-awake isn't needed, and has 512 MB with a full CPU share, which makes restarts quick. With a persistent disk ($0.25/GB) the backups matter less but still work.
- **Cloudflare Containers** (about $7/mo more on the Workers plan you have): its disk is also wiped on restart, so the same R2 backups and lease apply. It has far more outbound traffic included than Render's free plan.

## What isn't verified yet

These are the first things to check on the first deploy:

1. **The `Dockerfile` has never been built.** Pins to check: Go builds the bridge at `186284e`, Synapse `1.143.0` installs, `litestream/litestream:0.5.17` exists as an image tag.
2. **Litestream's flags and config**: `restore -config … -if-replica-exists <db>` and the YAML in `deploy/cloud/litestream.yml`. A restore that fails stops the start on purpose.
3. **The bridge's generated example config** still has the keys `src/cloud/provision.ts` sets; a changed layout stops the start with the missing key named.
4. **R2's "only if absent" write** (`etagDoesNotMatch: '*'`) in the lease. Start two copies and confirm the second waits.
5. **Memory** on the free plan (the plan's gate: peak under about 450 MB) and the cold-start time.
6. **Google accepting a data-centre address** for the bridge's session, and YouTube Music and music-table.com answering requests from one.
7. **OneDrive** has only been tried against a stand-in written from Microsoft's documentation. To check on the first real upload: that the app-folder permission (`Files.ReadWrite.AppFolder`) is accepted for upload sessions at `special/approot:/…` (if not, set `ONEDRIVE_SCOPE` to `Files.ReadWrite offline_access`, which gives the app your whole OneDrive), that missing folders are made, and that a Microsoft account sign-in lasts.
8. **Render's `autoDeploy: false`** is still the right key in `render.yaml`, and the bandwidth figure on your plan.

Not built: moving the songs from the synced OneDrive folder onto the external drive (do it by hand, or ask for a command that does it when the drive is connected), saving the songs the Mac's background jobs would have kept ready in advance (only songs actually sent are saved), and drawing the song cards and the daily collage on Linux (they fall back to a plain cover; the collage is skipped).
