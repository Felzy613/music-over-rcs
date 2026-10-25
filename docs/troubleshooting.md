# Troubleshooting

Start with the logs and the health check. The logs are in the Render dashboard (the service, then Logs); each line is prefixed with the process (`[host]`, `[bot]`, `[bridge]`, `[synapse]`, `[litestream]`), and the bot logs a `<-` line for every request it picks up and an `->` line for every song or announcement it sends. The health check says in plain lines what is working and what to do about what isn't:

```bash
ADMIN_TOKEN=… npm run cloud:check -- --render https://<service>.onrender.com
```

(`ADMIN_TOKEN` is the value in Render's Environment page.) The service's own address, `/status`, shows the same facts as JSON.

## Alerts

When something the bot depends on breaks, an email arrives within about five minutes (the bot leaves it in the bucket and the Cloudflare Worker mails it), and another when it's fixed. What each one means:

| Alert | What to do |
| --- | --- |
| Google Messages is logged out of the bridge | The bridge has no Google login at all (the phone unlinked it, or its data was lost), so nothing can reconnect by itself: open the service's `/pair` page, press **Start login**, and follow the steps (the same as the first time). Said two minutes after the bridge starts without one. |
| Google Messages unlinked the bridge | Google (or the phone) ended the link: "Unpaired from Google Messages, please re-link". Restarting can't undo that, so the bot doesn't try. Link it again on the `/pair` page (a copied request from Google Messages for web, then the emoji on the phone; there is no QR code), then text yourself once: the bot finds the chat by itself. Said at once, and again every six hours while it lasts. |
| The bridge is signed out of Google Messages | Usually Google turned the bridge away for a while (a web filter or network block on `instantmessaging-pa.clients6.google.com` does this). The bot restarts the bridge every few minutes and it reconnects on its own once Google lets it through; there is nothing to do unless it lasts for hours, and then link it again on `/pair`. (Said after fifteen minutes.) |
| The bot's host has no internet | The host can't reach the internet, which on Render means Render has a problem (check its status page). Texts you send meanwhile aren't lost: the bridge picks them up within a minute of the internet coming back, and the bot answers them. (Said after ten minutes, and only once.) |
| The bridge can't reach Google Messages | The internet works but the bridge can't get through to Google. The bot restarts the bridge every few minutes (after the first, five minutes later, then every ten) for as long as it lasts, so it comes back by itself within about ten minutes of whatever was in the way going away. With "phone" in the reason (Google answers but the phone doesn't), a restart can't help, so the bridge is restarted only every two hours meanwhile and reconnects by itself once the phone answers: open Google Messages on the phone. (Short drops are normal and aren't reported; this one has lasted 15 minutes.) |
| RCS chats are off on your phone | Google Messages → Settings → RCS chats → on. Without RCS, files this size can't be sent. |
| The Google Messages bridge isn't answering | The host restarts the bridge after two minutes, and again every few minutes. If it still says so, restart the service in Render. |
| The bot can't reach the Matrix homeserver | The homeserver inside the container isn't answering. The host restarts it by itself; if this lasts, restart the service in Render. |
| music-table.com isn't answering the bot | Usually the site is down or slow; songs already in the catalog still work. If it lasts, the reason in the alert helps. |
| The host isn't answering (from the Worker) | Three checks in a row (15 minutes) got no answer from the service. The free plan restarts it at times and a restart takes a minute or so; if this lasts, look at Render's Events and Logs. |
| The bot isn't running (from the Worker) | The host answers but the bot hasn't for 30 minutes. `cloud:check` says why: the bridge is unlinked, no chat is chosen or its room is gone (`room-missing` in `/status`), `BOT_ENABLED` is off, or the bot is crashing (see the logs). |
| The bot's chat room is gone | Your "message yourself" chat was deleted on the phone and the bridge deleted its room (it makes a new one, under another id, when you text yourself again). The bot is **waiting, not crashing**: text yourself once from your phone, and within a minute it finds the chat's new room (the chat with your own number) and starts answering, with no restart; a "Fixed" alert follows. If it doesn't, open `/pair`, enter your number, press **Find** and choose the chat. Said at once, and again every six hours while it lasts. |
| Songs are not being saved to OneDrive | The reason is in the alert. If it says to sign in again, Microsoft revoked the sign-in (a password change can): open `/pair` and press **Sign in to OneDrive**. Songs are still sent meanwhile. |

A problem that lasts is repeated every six hours. **No emails at all?** `cloud:check` with `--alert` leaves a test alert in the bucket; if it isn't mailed within about ten minutes, check the spam folder, then that the Worker has `ALERT_FROM` and `ALERT_TO` (`npx wrangler secret list` in `cloudflare/`) and that the sender address is on a domain set up for Email Service.

## The host and the bridge

- **A page shows "Starting up" (503), or Render's own "starting up" screen or a 502:** the service is waking or restarting (a minute or so). The host's own page says what it is doing and reloads itself; a 502 from Render's gateway means no copy of the host was listening at all, which the front door is there to prevent, so if you still see one note the time and look in Render's Events for `server_failed`. `/healthz` answers 200 as soon as the host is up; an uptime monitor can watch `/ping`, which answers 500 on purpose. Do not press deploy again while it restarts: each deploy starts the whole sequence over.
- **A deploy sits at "In progress":** the new copy is waiting for the old one's lease and the old one has not been told to stop (Render stops it only once the new one has opened its port, which the front door does; see [How it runs](cloud.md)). Render fails it after about 15 minutes; *Cancel deploy* in the Events list starts the next one at once.
- **"Can't reach the Matrix homeserver":** Synapse isn't up yet (the first minute of a start) or has stopped; the host restarts it. Right after a restart the bot may start a moment before it and restarts itself 15 seconds later.
- **"The homeserver rejected the access token":** the host signs in again at every start, so restart the service. If it keeps happening, `MATRIX_PASSWORD` or `SECRET_KEY` was changed.
- **The bot ignores a change:** it runs the last commit that was deployed (or the environment as it was at the last restart). Push to `main` and deploy, or change the variable in Render.
- **The bot doesn't find your chat by itself, or `/pair` can't find it:** text yourself once on the phone, then wait: the free plan's slow CPU means the bridge takes several minutes to make its rooms after linking. The bot looks for the chat with the number Google Messages gives for your SIM; some carriers don't give it, and then the bot has nothing to go on until the chat has been chosen once on `/pair` (it remembers that chat's number from then on). On the page, enter your number with or without the country code (a leading 0 is fine); it matches the end of the number.
- **"Your message may not have been bridged":** the bot restarts the bridge after this terminal delivery error. Retry the request; the failed reply itself isn't replayed.
- **Replies show up in Matrix but not on the phone:** check the phone is online and `cloud:check` says the bridge is connected. The host configures the bridge so that only the bot's account may use it.
- **The bridge was logged out:** link it again on `/pair`.
- **The bot stopped answering after you deleted or cleared the "message yourself" chat on the phone:** the bridge deleted that chat's room, and a new one is made when you text yourself again. Text yourself once: the bot finds the new room by itself within a minute. Before 2026-10-20 the bot instead crashed and restarted in a loop with nobody told (it was silent for most of 2026-10-19 that way); until 2026-10-25 it waited for the chat to be chosen on `/pair`, and when nobody did (2026-10-22) it stayed silent, then failed every start with "Too Many Requests" from its own homeserver. If `MATRIX_ROOM_ID` is set in Render, a stale value is passed over.
- **The service restarted by itself and Render's Events say `oomKilled`:** the container went past its 512 MB (seen once, 2026-10-18, after a 27 MB song). The host's log keeps what held the memory: `memory:` lines while it is above 85%, `memory (raised):` and `memory (settled):` when it goes well above its resting level, and `/status` shows `memory` with the highest reading. See "Memory" in [How it runs](cloud.md). A lower `MAX_DOWNLOAD_MB` in Render is the quick relief.
- **Two answers to every message:** two bots are running: the cloud host and something else (a bot started with `npm run matrix` on a computer, or an old install). Stop the other one.
- **The audio doesn't arrive:** check the file is under `MAX_DOWNLOAD_MB` (30 on Render; an album's zip under `MAX_ZIP_MB`, 100, the homeserver's and the bridge's limit), and that RCS chats are on: SMS/MMS can't carry files this size.
- **An album says "coming as a zip" and the zip doesn't arrive:** look in the log for `YouTube Music turned Cloudflare away …` and `could not get <song> ready`: YouTube turned the Cloudflare relay away three times in a row, so the songs couldn't be fetched, and YouTube songs are left aside for a minute. Ask for the album again a minute or two later. (Seen 2026-10-19 04:11 UTC, when no zip followed in the log; what the chat itself showed is not known.)

## Songs and lists

- **"…the file server answered HTTP 403" on a YouTube Music song** (fixed 2026-10-14): YouTube hands out the odd link that refuses whole-song downloads, and the bot used to give up on it. It now checks each link first and takes another when one is dead, see [YouTube Music](youtube-music.md). If it still says "its link was refused", every try in a row was a dead link; try the request again.
- **"I couldn't search YouTube Music: …" or "YouTube Music wouldn't give me that song (…)":** the message says why. If it says `HTTP 400` or `HTTP 404`, YouTube has probably retired the client versions the bot imitates; see [YouTube Music](youtube-music.md#it-can-break). "not a bot" means YouTube wants a new session; the bot asks for one by itself, and if that keeps failing, try again later. Everything else keeps working, and `SONG_SOURCES=music-table` keeps the bot off YouTube meanwhile. On the cloud host songs come through the Cloudflare Worker ([the relay](youtube-music.md#getting-the-songs)), so a message about the relay, or "YouTube Music is turning this server away for now", points there: the host's log has a `YouTube Music: …relay…` line with the reason, and the start-up check logs whether songs could be had through it. YouTube turns Cloudflare away now and then for a minute or two; the bot checks again by itself after a minute, longer if it lasts, and logs "YouTube Music lets the relay through again" when songs are back. The Worker's own log (Cloudflare dashboard → Workers & Pages → `mors-edge` → Observability) has a line for every song request.
- **A notification that Zemer's artist list hasn't updated for a day:** the bot keeps filtering with the last list it got, but new artists and newly blocked songs aren't in it. Usually `content.zemer.io` is down; it resolves itself. "I couldn't reach Zemer's artist list" in a reply means there is no list at all (a first run with no internet): YouTube Music is skipped until there is one.
- **"Zemer's search didn't answer" or "Zemer's search answered HTTP …" in the host's log:** the bot couldn't reach `search.zemer.io`, and searches used YouTube Music's own search (no artist pages) and then music-table.com meanwhile. The start-up line "Zemer's search answers" (or "doesn't answer right now: …") says whether the host can reach it at all. If Zemer's server turns the host away for good, `ZEMER_SEARCH=off` stops asking it.
- **A YouTube Music song says "its artist isn't on Zemer's artist list", "it has a female singer" or "Zemer's list blocks that song":** that's the filter working on a song found earlier; the list changed since. See [Zemer's artist list](youtube-music.md#zemers-artist-list).
- **"I couldn't search music-table.com: …":** the message says why. If it says the site may have changed, `npm run music-table -- search <words>` shows what the site returns now.
- **A song you know is there isn't found:** try the artist and title as the site writes them, or fewer words. `npm run simulate:web` and **Behind the scenes** show what was searched and what the site listed.
- **An artist's name gives songs instead of their list:** the name fits several artists and none clearly has the most songs (like `weiss`). Use the full name.
- **`trending` or `new` say the catalog is still being filled:** the first run reads the whole site in the background (about 20 minutes on a fast computer, longer on the free plan's slow CPU). A catalog carried over from an earlier install already has it (see [How it runs](cloud.md), step 6).
- **A number gets "tap 👍 on it":** only albums have numbers (and the songs of an album you opened by its number); tap 👍 on a song's own message. A number that isn't on the list gets the ones that are. (With no list open, a number gets the help text.) Lists last, for `all`, half an hour ("Which one?"), two hours (`trending`, `new`, artists) or a day (the daily message), and a new search ends them.
- **A song name gets "To look for a song, start with "search"":** every message starts with a command now; send the line it suggests (`search` and the name).
- **A 👍 does nothing:** it works on messages that stand for one song: a list's options, the songs in the daily message (the picture or a song's line), and a new-song alert. On anything else a 👍 is just a reaction.
- **`chanukah`, `purim`, `wedding` or `vocal` is slow the first time:** it reads the whole category from the site once (a few seconds); after that it's instant.
- **`follow <name>` says it doesn't know the artist:** it only knows artists with songs in the catalog. Text the name alone first to see whether it's found, or try the name as the site writes it.
- **A one-letter message or a stray number** gets the help text, not a search.
- **"has no MP3 to download":** that post only has a video, or its MP3 is in a Google Drive folder (an album), which the bot can't open.
- **New releases stopped appearing in the catalog** (the log says `synced … 0 new` for days, and new posts have no songs): the site probably changed how it offers its MP3s. In October 2026 it moved from attached files to download buttons, and posts looked like videos until the bot learned to read them. `npm run music-table -- search <a new song>` shows what the bot sees in a post's files. After a fix, the next sync (every three hours; restarting the bot doesn't force one) fills the gap for the last 50 posts.

## Alerts for artists you follow

- **A new song didn't come:** alerts wait out the quiet hours (`QUIET_HOURS`, 22:00 to 07:00 by default), skip songs you already got and anything out before you followed the artist, and only cover posts from the last two days. `following` in the chat lists who you follow. New posts are noticed within about 15 minutes.
- **Too many:** `unfollow <name>`. Artists the bot followed for you are marked "(from your plays)" in `following`; after an unfollow it won't follow them again.

## The daily message

- **It didn't come:** look for `-> announcement` around the time in the logs. Nothing new means no message. The first day the bot runs, it waits for the next scheduled time. A host that was down at the scheduled time sends it when it's back, once.
- **See it now:** `npm run library -- digest` shows it as it would go out, from a catalog on your own computer (not the live one).
- **Change the time or turn it off:** `DIGEST_TIME` in Render's environment (it restarts the service).

## Beeper

- **"Can't reach Beeper Desktop":** the app isn't running, or its API is off (Settings → Developers).
- **"Beeper rejected the access token":** create a new one under Approved connections.
- **Your self-chat isn't listed:** connect the Google Messages account in Beeper, send yourself a message, then `npm run beeper-chats` without a filter.

## RCS for Business

- **`403 PERMISSION_DENIED` when sending:** the phone isn't a tester yet, hasn't accepted the invite, or has RCS chats off.
- **`400` mentioning `messageTrafficType`:** your agent is multi-use; set `RBM_MESSAGE_TRAFFIC_TYPE`.
- **The caption arrives but the audio doesn't:** `npm run catalog -- check`, then `npm run send-test -- <phone> --audio <url>`. Usual causes: not an `audio/*` content type, not MP3/AAC/OGG, over 100 MiB, or a host that blocks Google's fetcher. Google caches by URL, so a changed file needs a new URL.
- **Webhook verification fails:** `RBM_CLIENT_TOKEN` must match the console exactly; restart after editing `.env`.
