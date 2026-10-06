# The simulator

Try the bot without a phone, a bridge or any account.

## In a browser

```bash
npm install
npm run simulate:web -- --open
```

A chat that looks like Google Messages, connected to the real bot: the same runner, catalog and music-table.com lookup the phone setup uses. Text it a song or an artist, `trending`, `new`, or a number from a list, and watch it "type" and answer with album art and the audio file. Tap a numbered option to send its number.

Beside the chat, **Behind the scenes** shows every step of each request: the catalog search, each call to the site (and whether it was answered from memory), the lookup's decisions such as spelling fixes, the file check, and how long each took.

- **Daily message** shows the new-music message as it would go out now. Unlike the real one it covers the last three days, so there's always something to see, and it marks nothing as sent.
- **Chat with myself** shows the bot's replies as messages you sent, which is how they look when you text your own number.
- **Clear** starts a fresh chat.
- The audio isn't downloaded until you press **Play**, which asks the site for a fresh link and streams the file in the browser.

Options:

| Option | Meaning |
| --- | --- |
| `--port 8788` | Where to listen |
| `--real-catalog` | Use your real catalog (`CATALOG_DB`). By default a fresh one in memory, so every search goes to the site. |
| `--full` | Really download each file before "sending" it, as the bot does for a phone |
| `--open` | Open the page in your browser |

It listens on `127.0.0.1` only, and answers only pages loaded from that address with its own header, so another website can't drive it. It uses the live site, so it needs the internet; with `MUSIC_TABLE=off` it uses only the catalog.

## In a terminal

```bash
npm run simulate -- --demo     # three made-up songs, no network
npm run simulate               # your catalog, and music-table.com when the catalog has no match
npm run simulate -- --offline  # your catalog only; no link checks
```

Type a request as you would in Google Messages, a number to pick an option, and `quit` to leave. It checks links but never downloads audio.
