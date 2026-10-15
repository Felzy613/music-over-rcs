# Privacy and security

## What stays on your Mac

Everything runs locally and listens on `127.0.0.1` only: the homeserver, the bridge, the bot and the simulator. Nothing is published to the internet, and Synapse federation is off.

| Where | What | Sensitivity |
| --- | --- | --- |
| `~/Library/Application Support/music-over-rcs/gmessages/` | The bridge's config, its database and your **Google Messages session**, and every bridged conversation's metadata | **High**: the session is as good as a login |
| `.../synapse/` | The homeserver's database: **copies of the messages in every bridged chat**, your account, signing key | **High** |
| `.../catalog.db` | Songs, artists, site posts, your plays, the artists you follow, the bot's state | Low (your listening history) |
| `.../audio-cache/` | Downloaded songs, in artist and album folders (until they move to `SONGS_ARCHIVE_DIR`, if set) | Low |
| `.../logs/` | Service logs | Medium (room ids, and the text of your requests) |
| `.env` (project folder) | Your Matrix access token, room id, settings | **High**; readable only by you |

Keep the services folder private, and don't expose the homeserver's port to the network. Uploaded media is deleted from the homeserver after 7 days.

## What leaves your Mac

- **To Google, through the bridge:** your Google Messages session, and the bot's replies, which go out over RCS as messages from you to yourself.
- **To music-table.com:** your search words, the posts and category pages it reads, the RSS feed, and download requests, from your IP address with a User-Agent naming this project. It never sends anything about you beyond that, and who you follow stays on your Mac.
- **To YouTube Music (`music.youtube.com`) and YouTube's media servers (`*.googlevideo.com`):** your search words, a session id YouTube hands out, the id of each song you ask for, and the download of its audio, from your IP address, with the User-Agent of the app client it imitates (not one naming this project). No Google account or cookie is used.
- **To Zemer's content server (`content.zemer.io`):** a read-only request for its artist list (about 100 bytes every few minutes, the whole list of about 200 KB only when it changes), with a User-Agent naming this project. It sends nothing about you or your searches; the filtering happens on your Mac.
- **Nothing else.** No analytics, no third-party services. The health check of your Google Messages login asks the bridge on your Mac (`127.0.0.1`) with your Matrix token; about once a minute it also sends one empty request to Google's connectivity check (`www.google.com/generate_204`) to tell whether this Mac is online, so it knows when to restart a bridge left stale by an outage. The notifications are shown by macOS on your Mac.

## Secrets and this repository

- `.env`, `data/`, `keys/`, `*.db`, `audio-cache/` and logs are in `.gitignore`.
- `.env.example` has no real values.
- The tests use only made-up tokens, cookies and numbers.
- `npm run matrix-login` asks for your password hidden, keeps only the access token, and never stores the password.
- Setup and the scripts print no secrets.

**Never paste your Google cookies (the "Copy as cURL" request) anywhere except `npm run matrix-console`.** If you did, open your Google account → Security → Your devices, sign that browser session out, and log the bridge in again.

## The bridge and the bot act as you

The bot sends as your Matrix account, and the bridge relays that as you on Google Messages. It only ever writes in the one room you configured (`MATRIX_ROOM_ID`), your chat with your own number, and the bridge's other rooms are never joined or read. Before setting the room, check that it's yours: `npm run matrix-rooms -- --phone <your number>`.

## If you run it in the cloud

[Running it in the cloud](cloud.md) moves the homeserver, the bridge and the bot onto Render, which changes what is stored where:

- **Your Google Messages session** (the bridge's database) lives on the Render host and, because that database is backed up, in the R2 bucket. So do the homeserver's database (the messages of any chat that gets one, and the bot's own chat) and the bot's catalog. The bucket is private; keep its API token out of git and out of anything you share. The bridge makes no rooms for your other chats at login and does no backfill, so only chats that get a message while it runs are copied.
- **OneDrive** (if you set it up): copies of the songs you request are saved to your OneDrive, in the app's own folder. The app's permission, `Files.ReadWrite.AppFolder`, lets it see only that folder, not the rest of your OneDrive. Its sign-in token (Microsoft's refresh token) is kept in the catalog, so it is on the host and, through the backup, in the private R2 bucket; revoke it any time at account.microsoft.com → Privacy → Apps and services.
- **The pasted Google request** goes through the `/pair` page into the homeserver's chat with the bridge bot, and is deleted a minute later (the homeserver forgets the deleted text after an hour).
- **Who can reach the host**: `/healthz` is open and says nothing. Everything else (`/status`, `/pair`, choosing the chat, the catalog upload) needs `ADMIN_TOKEN`, a long random value Render generates. The homeserver and bridge listen on 127.0.0.1 inside the container and are not reachable from outside.
- **Secrets**: `SECRET_KEY`, `ADMIN_TOKEN` and the R2 keys are Render secrets, and the Worker's addresses are Cloudflare secrets, not files. Each process in the container gets only the ones it needs: the homeserver and bridge get none, and the bot gets the R2 keys (its alerts go through the bucket) but not `SECRET_KEY`.
- **Removing it**: delete the Render service, the Worker and the R2 bucket, and sign the bridge's session out in your Google account and in Google Messages on your phone.

## Removing everything

```bash
npm run stack -- uninstall                                    # stops and removes the background services
rm -rf ~/Library/Application\ Support/music-over-rcs          # the services, their data, the catalog, the songs
```

Then sign out the bridge's session in your Google account (Security → Your devices) and in Google Messages on your phone (Device pairing).
