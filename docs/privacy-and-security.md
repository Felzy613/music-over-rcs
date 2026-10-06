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
- **Nothing else.** No analytics, no third-party services. The health check of your Google Messages login asks the bridge on your Mac (`127.0.0.1`) with your Matrix token, and the notifications are shown by macOS on your Mac.

## Secrets and this repository

- `.env`, `data/`, `keys/`, `*.db`, `audio-cache/` and logs are in `.gitignore`.
- `.env.example` has no real values.
- The tests use only made-up tokens, cookies and numbers.
- `npm run matrix-login` asks for your password hidden, keeps only the access token, and never stores the password.
- Setup and the scripts print no secrets.

**Never paste your Google cookies (the "Copy as cURL" request) anywhere except `npm run matrix-console`.** If you did, open your Google account → Security → Your devices, sign that browser session out, and log the bridge in again.

## The bridge and the bot act as you

The bot sends as your Matrix account, and the bridge relays that as you on Google Messages. It only ever writes in the one room you configured (`MATRIX_ROOM_ID`), your chat with your own number, and the bridge's other rooms are never joined or read. Before setting the room, check that it's yours: `npm run matrix-rooms -- --phone <your number>`.

## Removing everything

```bash
npm run stack -- uninstall                                    # stops and removes the background services
rm -rf ~/Library/Application\ Support/music-over-rcs          # the services, their data, the catalog, the songs
```

Then sign out the bridge's session in your Google account (Security → Your devices) and in Google Messages on your phone (Device pairing).
