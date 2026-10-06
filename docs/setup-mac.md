# Mac setup with the bridge

The bridge ([mautrix/gmessages](https://github.com/mautrix/gmessages)) connects your Google Messages account to a Matrix homeserver ([Synapse](https://github.com/element-hq/synapse)); each conversation becomes a Matrix room. The bot is a Matrix client that watches one of those rooms, your chat with your own number, and answers in it. All three run on your Mac, in the background, and listen on `127.0.0.1` only.

## What you need

- An Apple-silicon Mac with Python 3.10+, Node 22.18+, `cmake` and the Xcode command-line tools.
- An Android phone with **Google Messages** as its texting app and **RCS chats on** (Messages → Settings → RCS chats). The phone has to stay online: the bridge works through it.
- A chat with your own number in Google Messages. Text yourself once (Start chat → your number); that chat is where you'll talk to the bot.

## 1. Install

```bash
npm install
npm run mac:setup
```

It's safe to run again: every step checks what's already there, and it prints no secrets. It puts everything in `~/Library/Application Support/music-over-rcs`, **not** in this folder. macOS stops background jobs from reading `~/Documents`, `~/Desktop` and `~/Downloads`, and a service started from there hangs on its first file access. (`MORS_HOME` picks another place outside those folders.) It:

- installs Synapse 1.143.0 from prebuilt packages, with `prometheus-client` held below 0.24 because this Synapse can't load the newer one. Later Synapse releases publish no macOS packages and would need a Rust compiler.
- downloads the Apple-silicon bridge (v0.2609.0) and checks it against the SHA-256 published on its releases page.
- builds libolm 3.2.16 from source. The bridge's release binary links it, and Homebrew no longer ships it.
- writes both configs: everything listens on 127.0.0.1 only, federation is off, uploads up to 100 MB are allowed, uploaded media is deleted after 7 days, encryption is off, and your Matrix account `@me:localhost` is the bridge's admin. For another username: `MATRIX_LOCALPART=yourname npm run mac:setup`.
- starts the homeserver and the bridge as launchd agents (they start at login and restart if they crash), and checks that they're talking to each other.
- puts `CATALOG_DB` in `.env`, so `npm run catalog`, `npm run library` and the bot share one catalog.

Idle, the homeserver and bridge use about 150 MB of memory and well under one percent of a CPU core; the bot adds a small Node process. The catalog of the whole site is about 4 MB, and the songs kept ready grow by roughly 1 to 1.5 GB a month, with no limit unless you set `PREFETCH_MB` (or move them to an external drive with `SONGS_ARCHIVE_DIR`).

### Controlling the services

`npm run stack -- <command>`:

| Command | What it does |
| --- | --- |
| `status` | What's running, with memory and CPU use, and whether the homeserver answers |
| `stop` / `start` | Stop everything now and keep it from starting at login / bring it back |
| `restart` | Restart everything; also copies your latest code and `.env` to the bot |
| `sync-bot` | Copy the latest code and `.env` to the bot without restarting it |
| `logs bot` | Follow a log (`synapse`, `bridge` or `bot`); Ctrl+C to stop following |
| `create-user` | Create your Matrix account (step 2) |
| `enable-bot` / `disable-bot` | Install the bot as a background service that starts at login / remove it |
| `run synapse` / `run bridge` | Run one in the foreground for debugging (`stop` first) |
| `uninstall` | Remove the background services; your data stays |

The bot can't read this project folder either (same macOS rule), so it runs from a copy in the services folder. After changing code or `.env`, `npm run stack -- restart` refreshes the copy.

## 2. Create your Matrix account

It asks you to choose a password, twice, hidden. The username is `me` unless you pass another (`create-user yourname`):

```bash
npm run stack -- create-user
```

## 3. Sign the bot in

It asks for the homeserver, username and password (hidden), saves an access token to `.env` (readable only by you), and never stores the password:

```bash
npm run matrix-login
```

## 4. Connect Google Messages

Open a chat window to the bridge bot:

```bash
npm run matrix-console
```

Type `login google` and follow what the bridge says. You open Google Messages for web in a private browser window, copy the request it asks for from the browser's developer tools ("Copy as cURL"), paste it into the console (a multi-line paste is sent as one message), then tap the emoji it shows in Google Messages on your phone. Type `help` for the bridge's other commands.

**That pasted request contains your Google session cookies, which are as sensitive as your Google password.** Paste it only into the console, never into a chat or an issue. It passes through your own homeserver and is stored in `~/Library/Application Support/music-over-rcs/gmessages/`. When you're done, close the private browser window. If you ever pasted it somewhere else, sign that session out in your Google account (Security → Your devices) and log in again.

## 5. Find your chat and start the bot

The bridge makes a room for each conversation and invites your account to it:

```bash
npm run matrix-rooms
```

Rooms show up as invites, mostly without names, so ask for your own number's chat directly:

```bash
npm run matrix-rooms -- --phone 5551234567
```

It reads the bridge's own record of which room is which number (changing nothing) and prints the room's ID. If it finds none, text yourself once on the phone, wait a few seconds, and try again. Put the ID in `.env`:

```bash
MATRIX_ROOM_ID=!abcdefghijklmnop:localhost
```

The bot joins the room itself (accepting the invite). Check the path first. This should appear on your phone, in that chat:

```bash
npm run matrix-send -- "hello"
```

Then start the bot as a background service that also starts at login:

```bash
npm run stack -- enable-bot
```

Text `search` and a song name in that chat (`search yoely weiss shabbos`). For a trial in the foreground use `npm run matrix` instead, after `npm run stack -- disable-bot`: two bots would both answer every message.

On its first run the bot reads the whole site into the catalog in the background (about 20 minutes, a few pages a minute). `npm run library -- scan` does it in about two minutes instead.

## Things to know

- **Your phone has to stay online,** and the Mac awake, for the bot to answer.
- **The bot writes as you.** The bridge relays its messages to Google Messages as messages from you, so in your chat with yourself they look like your own. Every one starts with 🎵, which is how the bot never answers itself.
- **Messages you type on the phone** appear in the room from a user the bridge made up for you; the bot answers plain text that doesn't start with 🎵, and ignores bridge notices, edits and media.
- **A message to yourself shows once** in Google Messages (marked "Received"); the bot also ignores a word-for-word repeat within 20 seconds in case a phone shows it twice.
- **Album art and audio arrive as RCS media.** The bridge accepts images and audio up to 100 MB. It doesn't support captions on pictures, so the art and the song's name are two messages.
- **"Background items added" notifications** for Python, node and mautrix-gmessages may appear. Keep them allowed (System Settings → General → Login Items & Extensions), or the services won't start at login.
- **The bridge is unofficial.** It reverse-engineers Google Messages for web, so a Google change can break it until the bridge is updated. It supports one Google session at a time, and not Google Fi accounts.
