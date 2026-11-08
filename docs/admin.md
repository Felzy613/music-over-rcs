# The management console

A web page on the live bot, for seeing what the backend knows and does, changing the few settings that can change while it runs, starting refreshes, and deciding **which artists and which individual songs may be sent**. It replaces texting `pending`, `allow` and `block`, and most visits to Render's dashboard, but it does not replace Render: nothing here can change Render's environment, and there is no Render key anywhere in the bot.

**Open it:** `https://<your service>.onrender.com/admin/`. You land on a sign-in page ([below](#signing-in)). The Setup page (`/pair`) and `/status` are behind the same sign-in; `/` still opens Setup.

**Try it with no accounts:** `npm run simulate:admin -- --open` starts the real console and web door on made-up data (a Zemer list that has turned the bot away, a YouTube Music, a releases feed and a music-table.com, all mock servers from `test/helpers/`), on `127.0.0.1:8789`. Sign in with any user name and the password `demo-password` (`--auto` skips the page, on that machine only). Nothing in it reaches anything real, and nothing is saved.

It works on a phone (checked at 375 px wide) and in light and dark mode; there are no fonts or files from anywhere else.

## Signing in

A real sign-in page at `/login`: a user name and a password, and a **Sign out** button in the console's header.

- **Your own user name and password**, which you make on the console's **Account** page and which are kept **in the database** (the catalog's state), not in Render. Only a salted scrypt hash is kept, never the password, and a change signs every browser out. The first time, the page asks for the host's `ADMIN_TOKEN` as the "current password"; after that, for your own. A password must be at least 12 characters (a few words in a row make a good one), at most 200, and not the same as the user name or the token.
- **`ADMIN_TOKEN`** (in Render) keeps working: any user name with it as the password signs in on the page. It is the way in before you have made your own, the way back in if you forget your password, and what the Worker (`RENDER_ADMIN_TOKEN`, for `/status`) and `npm run cloud:check` send as a `Bearer` header. Removing your account (Account page) puts you back on the token alone; it is refused when the host has no token, since nothing could sign in then.
- **A session** is a random token in a cookie (`HttpOnly`, `SameSite=Lax`, `Secure` over https), good for two weeks, of which only the SHA-256 is kept in the database, so sessions survive a restart and one can be ended (a session is also tied to the `ADMIN_TOKEN` the host had when it was opened, so changing the token in Render, after a leak say, signs every browser out at the next start): **Sign out** ends this browser's, **Sign out everywhere** all of them. At most ten at once.
- **Wrong guesses** are slowed (300 ms) and limited to eight a minute for the whole host, because checking a password is a deliberately slow hash; while that limit holds even a right password has to wait, but a script with the token is not held up. The same limit covers guessing the "current password" on the Account page.
- A browser that is not signed in and asks for a page is sent to `/login`, which brings it back. Anything else gets `401` (`WWW-Authenticate: Bearer`, no password box).

## The pages

| Page | What it shows and does |
| --- | --- |
| **Overview** | Everything `/status` reports (phase, the Google Messages login, the problems with since-times, memory, the lease and the Worker's last check, OneDrive, the last requests' timelines), plus how long the bot has been up, the commit it runs (Render tells it: `RENDER_GIT_COMMIT`), this month's traffic against the 4,000 MB alert and Render's 5,000 MB, Zemer's list, the new releases, and the background jobs. All the actions below, each with its last result. |
| **Artists** | Zemer's artist list: live or frozen, since when, its last error and version, how old it is, when it will be asked again, how many artists and blocked songs the saved copy has. The artists **waiting for your word** (with when they were first seen), the ones you **allowed** and **blocked** (with when you decided), a box to allow or block by channel id, and the **saved list** itself, searchable by name, other-alphabet name or channel id, 50 at a time, with each artist's female flag. |
| **YouTube** | Search YouTube Music the way the bot does (its artists search and its songs search). Each artist found comes with their picture, channel id, sample songs and where they stand today; **Allow…**, **Block** or **Unblock** them by channel id. Each song found says what the bot would do with it and why, and can be **allowed by itself**. |
| **Songs** | The songs allowed one by one, the songs you unblocked, and Zemer's blocked songs (searchable by id or, for songs the bot has seen, title), with **Unblock…**. A box to allow a song by video id. |
| **Library** | What the catalog holds (rows per table), a search of its songs (with whether each may be sent, and an **Allow this song…** for one that is held back), the songs added last, **Zemer's new releases** (what is stored and in `new`, and what the last read **held back and why**), the chat's menus and pages (views), the background jobs' state (last site sync, next due, daily message, quiet hours, scan progress, whether alerts or the feed are failing, songs kept ready), and the OneDrive allowance. |
| **Account** | Your own user name and password (below), the browsers that are signed in, **Sign out everywhere**, and removing your account. |
| **Settings** | Every setting the code reads, with its value, where it comes from (the console, Render's environment, or the default) and whether it can change without a restart. |
| **Follows** | The artists you follow; follow or unfollow one. |
| **Activity** | The bot's last 500 log lines (below), filterable. |
| **Changes** | The record of every change made from the console. |

## The actions

Each shows its result right where you pressed it, **cannot run twice at once** (a second press says it is running), and has a cooldown, so a double tap or a stuck key cannot hammer a server. The result of the last run of each is kept in memory (not in a database).

| Action | What it does | Cooldown |
| --- | --- | --- |
| Refresh Zemer's artist list | Asks Zemer's server whether its list changed (about 100 bytes), **unless the server turned the bot away less than three hours ago**, in which case it says so and does not ask | 10 s |
| **Forced try** | Asks now, ignoring the three hours. Zemer answers only its own app, so this will most likely be refused again and the three hours start over. It is one request. It is written to the Changes record | 5 min |
| Refresh Zemer's new releases | Reads the releases feed again (not just when 30 minutes are up) and holds every release to the artist list | 30 s |
| Sync music-table.com | Reads the site's newest posts into the catalog | 60 s |
| Get songs ready | Downloads the songs worth keeping on disk. On Render it does nothing and says why: the disk is wiped at every restart (`PREFETCH_MB` is 0) | 60 s |
| Preview the daily message | Does a site sync and a releases read, then shows what the message would say. **Sends nothing and marks nothing** | 30 s |
| Send the daily message now | Texts it to your chat, after a confirmation. If nothing is new it sends nothing, and today's scheduled message counts as done. Written to the Changes record | 60 s |
| Check alerts for artists you follow | Sends the "new from an artist you follow" alerts that are due; not in the quiet hours | 30 s |

A manual job and the once-a-minute round never overlap: a manual one waits for the round that is running, and the round waits for it (`LibraryJobs.exclusive`).

## Who may be sent: the artist rules

The console edits the owner's layer of Zemer's artist list (`src/sources/zemer-whitelist.ts`, [Zemer's artist list](youtube-music.md#zemers-artist-list)), and the rules stay the strict ones:

- **Unknown means hidden.** An artist or song nobody has vouched for is not sent.
- **A block always wins**, over Zemer's list and over your own allows, whether you blocked an artist who is on Zemer's list or one nobody has ever mentioned.
- **An allow never lifts Zemer's female flag.** An artist the saved list flags as a woman cannot be allowed (the page offers no button, and the server refuses a request that tries).
- **Every allow needs your word that no women are credited.** The confirmation box starts unticked and its button is disabled until it is ticked; the server refuses an allow without `noWomenConfirmed: true` (nothing else counts: not `"true"`, not `1`) and nothing is changed. The bot cannot tell who is a woman, so this is your word, and the console never assumes it.
- **Block** needs no confirmation, and **Unblock** only lifts your block: an artist on Zemer's list is as the list has them, anyone else goes back to being unknown (hidden until you allow them). **Remove** (an allow) does the same.

**Allowing artists on YouTube.** With `ZEMER_SEARCH=off` a search is YouTube Music's own, and an artist's songs are sent only if the artist is on the list. Find them on the YouTube page and allow them by **channel id** (`UC…`): that is the id YouTube credits on their songs, which is what the list is keyed by. A channel that is not an artist's own is not an artist: check the name and a sample song. Someone allowed here shows under "Allowed by you" on Artists, with the time.

**Allowing some songs.** An individual song can be allowed by its YouTube **video id**, so one song can go without allowing its artist:

- It is **still refused** when a credited artist is blocked by you, or flagged female by Zemer's list. "Credited" means the artists on the song as it is found, **and** the artists credited when you allowed it (kept with it), so a stored song whose credits are not known any more is still held to them. The page refuses to save a song that is already held back for either reason.
- A song on **Zemer's blocked list** stays blocked, even once allowed, until you **unblock that very song** (a separate list, with the same confirmation). Unblocking lifts only Zemer's block on it: its artists must still pass (be on the list, or the song allowed by itself).
- It is kept in the catalog's state (`zemer.whitelist.owner`, with your artist decisions), is listed and removable on the Songs page, applies in every search, album page and release, and applies **again when the song is sent** (`youTubeGate`): a stored song with no recorded credits goes through only if you allowed that song, and then only if nobody it was credited to has since been blocked.
- At most 1,000 songs and 2,000 artists each way, so the value stays small.

## The settings

The Settings page lists everything the code reads (83 variables) with the value, where it comes from, and what it does. `test/admin.test.ts` fails if the code reads one that is not listed.

- **Secrets** (`ADMIN_TOKEN`, `SECRET_KEY`, `MATRIX_PASSWORD`, the R2 keys and endpoint, `ONEDRIVE_CLIENT_ID`, the tokens, `ALLOWED_SENDERS`) show only **set** or **not set**, never the value, and cannot be changed here. The server does not even send the value to the page.
- **Everything that is not marked live** is read when the bot starts: it says "change it in Render (Environment); that restarts the bot, about a minute". The console cannot change Render.
- **Six settings are live**: the bot reads them again each time it uses them, so a change applies at once. They are stored in the catalog's state (`admin.settings`) and sit **over** Render's environment: **Use Render's value** removes the override. If Render says one thing and the console another, both are shown, and the console's wins.

| Live setting | Used by | Limits |
| --- | --- | --- |
| `DIGEST_TIME` | the daily message | `09:30` (24-hour, the host's time zone) or `off`. If the new time has already passed today and today's message has not gone out, it goes within a minute |
| `QUIET_HOURS` | the follow alerts, and the "artists waiting" notice | `22:00-07:00` or `off` |
| `SONG_GAP_SECONDS` | the runner, before each audio file | 0 to 300 |
| `ALBUM_DOWNLOADS` | an album's songs downloading at once (read for each album) | 1 to 5 |
| `DOWNLOADS_AHEAD` | songs downloading ahead of their turn | 1 to 10 |
| `ONEDRIVE_MAX_MB_PER_MONTH` | the OneDrive archive's monthly allowance, which shares Render's 5 GB with the songs sent | 0 to 4,000 MB; `unlimited` can only be set in Render |

Not live, and why: `PREFETCH_MB` (on Render there is no cache to switch on: the disk is wiped), `MAX_DOWNLOAD_MB` and `MAX_ZIP_MB` (the memory limits that keep the host alive), and every source switch (`YOUTUBE_MUSIC`, `ZEMER_SEARCH`, `ZEMER_RELEASES`, `MUSIC_TABLE`, `SONG_SOURCES`), which decide what is assembled when the bot starts.

## The log and the record of changes

- **Activity** shows the last 500 lines the bot logged: a bounded ring in memory (`src/admin/log-ring.ts`), filled by tapping `console.log`, `console.info`, `console.warn` and `console.error` as the process starts. Nothing is written to disk or a database for it, and a restart empties it. Render's own logs are not reachable from the app, and they have the rest. Secrets are masked before a line is kept: the value of every setting named like a token, secret, password or key, wherever it appears, plus the usual shapes (`Bearer …`, `token=…`, a password in an address).
- **Changes** is every change made from the console, newest first: what, about what, from what to what, when. It is kept in the catalog's state (`admin.audit`), at most 200 entries with each field cut at 240 characters, and written only when you change something. (Artists you allow or block by texting the bot are not listed here, though they show on the Artists page with the time.)

## What it costs

Nothing beyond the host: the page is three small files (56 KB in all before compression, revalidated rather than downloaded again), there is no polling (a page loads when you open or refresh it), and an idle console does nothing at all. The one-minute tick is untouched. It writes to the catalog only when you change something (`zemer.whitelist.owner`, `admin.settings`, `admin.audit`: a few KB each, which Litestream uploads like any change), never from the bot's own work. The only outbound requests it makes are the ones you press a button for, and a YouTube search is two small requests to YouTube Music at most every two seconds.

## Security

Everything sits behind the sign-in above (a live session, or the token as a header, compared in constant time). On top of that:

- **Every change is a `POST` with a JSON body**, with the header `X-Admin-Console: 1` (signing in and out too). A browser sends its cookie with some requests to the site, so a page on another site could try to act for you (`SameSite=Lax` already keeps the cookie off a cross-site `POST`); it cannot add that header without a preflight, which this door never answers, and a form cannot send JSON at all. The request is also refused when the browser says it came from another site: `Origin` must be this site's own address (the host's front door passes the visitor's address along as `X-Forwarded-Host`, replacing any the visitor sent), and `Sec-Fetch-Site`, when sent, must be `same-origin`.
- **The older routes that change something** (`/pair/send`, `/setup/room`, `/onedrive/start`, `/admin/test-alert`, the catalog import) refuse a request that relies on the session cookie (no `Authorization` header) unless it is from this site, by the same `Origin`/`Sec-Fetch-Site` check; a script sending `ADMIN_TOKEN` as a header is not affected, since a header is not sent by the browser on its own.
- **Limits:** bodies of at most 64 KB, 60 changes a minute, and each action's cooldown.
- **The page is built with `textContent` only** (a test fails if the script contains `innerHTML`, `eval` or the like), because artist and song names come from outside feeds, under a content security policy that allows no inline script or style, no framing, and pictures only from Google's picture hosts (`img-src`). A picture address from a feed is also dropped by the server unless it is one of those hosts. Only this site's own addresses are made into links.
- **Reading is `GET`**, changing is `POST`; nothing is a `GET` that changes anything.
- The password is only ever in memory while it is being checked, and it is never logged, never in the record of changes, and never sent back: the page and the API show a user name, not a hash.
- No Render key, no way to edit Render, no shell, and no file access: the console can only call what `src/admin/console.ts` lists.

## The routes

All under `/admin/`, behind the password. `GET` reads; `POST` changes (with the header above).

| Route | |
| --- | --- |
| `GET /login`, `/login.js`, `/login.css` | the sign-in page (open) |
| `POST /login`, `/logout` | `{user, password, next}` / `{}`; sets or clears the session cookie (open, but with the same header and same-site checks) |
| `GET /admin/`, `/admin/app.js`, `/admin/app.css` | the page |
| `GET /admin/api/overview` | status, uptime, commit, traffic, the list, the releases, the jobs, the actions' last results |
| `GET /admin/api/artists?q=&offset=&limit=` | the list's report, the owner's artists, a page of the saved list |
| `GET /admin/api/songs` | the songs allowed, unblocked and blocked |
| `GET /admin/api/library?q=` | table counts, a song search, recent songs, views, jobs, OneDrive, releases (stored and held back) |
| `GET /admin/api/settings` | every setting |
| `GET /admin/api/account` | whether you have made your own sign-in, since when, the signed-in browsers (never the hash) |
| `GET /admin/api/follows`, `/log?limit=&level=&search=`, `/audit` | follows, the log, the changes |
| `POST /admin/api/actions/<name>` | `refresh-list`, `refresh-list-force`, `refresh-releases`, `sync-site`, `prefetch`, `digest-preview`, `digest-send` (needs `{"confirm": true}`), `alerts-check` |
| `POST /admin/api/artists/allow` | `{id, name, noWomenConfirmed: true}` |
| `POST /admin/api/artists/block`, `unblock`, `unallow` | `{id, name}` / `{id}` |
| `POST /admin/api/songs/allow` | `{videoId, title, artist, artistIds, noWomenConfirmed: true}` |
| `POST /admin/api/songs/unallow`, `reblock` | `{videoId}` |
| `POST /admin/api/songs/unblock` | `{videoId, title, noWomenConfirmed: true}` |
| `POST /admin/api/settings/set`, `clear` | `{key, value}` / `{key}` (live settings only) |
| `POST /admin/api/follows/add`, `remove` | `{name}` |
| `POST /admin/api/account/set` | `{user, password, current}`: `current` is your current password, or `ADMIN_TOKEN` the first time |
| `POST /admin/api/account/clear` | `{current}` (refused when the host has no `ADMIN_TOKEN`) |
| `POST /admin/api/account/signout-all` | `{}` |
| `POST /admin/api/youtube/search` | `{query}` (a `POST` to keep the words out of the address; it changes nothing) |

Until the bot has loaded (the web door opens first, in about a second), the host's part works (Overview's status, the log, Changes) and anything that needs the bot answers 503 "still starting".

## In the code

`src/admin/console.ts` is the router and the views; `account.ts` the user name, password hash and sessions; `sign-in.ts` the sign-in page's routes, cookie and limit; `settings.ts` the list of settings and the live layer; `actions.ts` the single-flight guard; `audit.ts` the record; `log-ring.ts` the log; `site/` the page. The web door (`src/cloud/web.ts`) exists before the bot is loaded, so `src/cloud-main.ts` registers the host's part with the shared `adminConsole` and `src/matrix-main.ts` the bot's (the list, YouTube Music, the releases, the jobs, the follows) once they exist. Tests: `test/sign-in.test.ts` (the account, the sessions, the sign-in page and cookie, the limit, the Account page's changes), `test/admin.test.ts` (the door, who may reach it, every view and action, the settings, the log) and `test/song-allow.test.ts` (the per-song rule and the owner's decisions).
