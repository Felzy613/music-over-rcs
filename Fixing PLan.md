# Plan: a streaming-app search menu, and a fast bot (Music over RCS)

## Context

The owner texts the bot in their Google Messages self-chat. There are two complaints: it is very slow (a search takes long to show up, and an album takes about 3 minutes to arrive as a zip), and `search` guesses (`search achas` opens the artist "Nachas" and sends their whole page). The owner wants it to work like a streaming app: a menu for each query (artists, albums, songs, 5 of each), nothing auto-picked, `X more` to page, 👍 to open things, and 👍 on an older menu line to go back. They asked for measurement, not guesses, and set one hard rule on 2026-10-20: **no more money**. Everything below stays on Render's free plan plus the Cloudflare Workers plan they already pay for.

Nothing here is deployed until the owner says so: push to `main`, then a manual Render deploy (the Worker separately with `wrangler`). Deploys are one at a time, about a minute of downtime each, never stacked.

---

## 1. Findings

### Re-verified, with new detail (Render logs, 2026-10-20 UTC)

**F1. Bridge stall: confirmed, and the cause is known and fixed upstream.**
- 13 `deduplicate dm` stalls back to back from 04:29:22 to 04:30:27, each 5.00–5.15 s, all on the self-chat portal `1.166`, each followed by `DELETE FROM gmessages_direct_conversation … result_error="database is locked"`. The backlog grew: the stall at 04:30:27 was for a conversation event stamped 04:30:17.7.
- **Root cause, in upstream `pkg/connector/chatsync.go` at our pin `186284e`:** in `deduplicateDM`, `insertNewConv` runs `DoTxn(ctx, …)`, but the `extraTasks` closures call `DirectConversation.Delete(ctx, byPhone)` with the **outer** `ctx`, not the transaction's. With `_txlock=immediate` the transaction already holds the write lock, so the Delete runs on a second connection, waits out the 5 s busy timeout and fails. The transaction rolls back, and `insertNewConv` then **swallows the error** (`if err != nil { return nil }`), so the in-memory DM cache is never updated and the same branch (`byID == nil`, newer timestamp) runs again on **every** conversation event, forever. This matches the 660 stalls seen on the Mac.
- **Upstream fixed exactly this on 2026-10-17:** commit `dbbd04de`, "chatsync: run DM dedup row delete inside its transaction (#103)". It passes the transaction ctx into `extraTasks` and returns the error. It is not in release v0.2610.0 (2026-10-16); it is on `main`. It touches only `chatsync.go`, and our streaming patch touches other files. Every context line of its hunks is present in `186284e`.
- **Second effect, bigger than the brief assumed:** while that transaction holds the write lock about 5 s out of every 5, **every other bridge write waits too** (`statestore SetMembership … 5.01 s`, `Failed to send message part to Matrix … database is locked`, `Failed to save message … after receiving remote echo`, `backfillqueue EnsureExists … locked`). Outgoing messages need DB writes, so they reach Google **one per stall slot**:

  | The bot's 10-line reply to "Search forever" | Time (UTC) |
  |---|---|
  | Bot sends line 1 / line 10 | 04:29:30.2 / 04:29:32.7 |
  | Google's timestamps on the conversation (`last_message_ts`) | 30.6, 32.0, 42.6, 47.5, 55.9, 57.9, 04:30:00.6, 02.7, 12.6, **17.7** |

  So the last line reached Google about **47.5 s** after the bot sent it, and about 56 s after the owner texted. The text-in lag in the same sample was 7.6 s (phone 04:29:21.6 → bot 04:29:29.2): a 5 s stall, then up to 1.5 s waiting for the next poll.

### Measured here for the first time
- **F2. The host CPU is not the limit during requests.** Peak CPU in each 30 s window, 04:27–04:36 (which covers the search and the album): highest 0.092 of the 0.15 limit, at 04:32:30. Memory went from 342 to 391 MB during the album (+49 MB) and settled at 375 MB.
- **F3. The zip's 22 s hand-off had no stalls in it.** Between the bot's `-> zip` (04:31:59.5) and Google's timestamp (04:32:21.8) the bridge logged nothing at info level. That time is the bridge reading 44 MB from Synapse, encrypting it and uploading it, so roughly 2 MB/s. The split is unknown, and Phase 0 adds a log line for it.
- **F4. Zemer's `k`.** `k` caps every kind at `k` (songs, albums, singles, videos); a kind with fewer matches returns all of them. Response time was the same at k=20/30/50/100 (0.16–0.28 s). **k=20 missed the most-played "Achas"** (Mordechai Shapiro, 1,500,000 plays; k=50 returns it), because Zemer's order is not by plays. Plan: k=50, which covers 5 + 8 + 8 + 8 of each kind after whitelist losses.
- **F5. Folding duplicates keeps the wrong copy.** `once()` in `src/sources/zemer.ts` keeps the *first* of two same-title, same-artist songs. For "achas" that is Mordechai Shapiro's copy with no play count, not the 1.5M one.
- **F6. Relay facts from the code (not timed yet).** The queue consumer is already `max_batch_size: 1, max_batch_timeout: 0`, so the config adds no batching delay. Each song makes the Worker do a `visitor_id` call (one extra YouTube round trip every time), a GET and a DELETE of the request object, the player call, the download, and 2 PUTs. The host polls at 0.75, 1.9, 3.6, 6.1, 9.1 s, so a song ready at 3.7 s is seen at 6.1 s (2.4 s late); the average delay is about 1.5 s per song. The host then **awaits** three DELETEs before returning the audio. The pre-album audio check is free (`inspect` returns at once when the relay is on).
- **F7. Prices (from Render's and Cloudflare's own pages today).** Render: Free (0.1 CPU, 512 MB) $0; `0.5c-512mb` (formerly Starter) **$7, still 512 MB**; `1c-2g` $25; Hobby workspace includes 5 GB outbound, then $0.15/GB. Free web services can't *receive* private-network traffic, and the 750 free hours are per workspace. Cloudflare Workers Paid ($5, already paid): 10M requests, 30M CPU-ms, Queues 1M operations included, R2 free tier of 10M Class B reads; Containers include only 25 GiB-hours of memory a month. `docs/cloud.md` is wrong to call Starter "a full CPU share".

### Could not measure from here (closed in Phase 0)
- **The Worker's side** of each relay: queue and notification delay vs. YouTube vs. R2. The Cloudflare observability tool needs the owner to authorize it (`/mcp`). Phase 0 makes the Worker report its own timings into the result file instead, so no dashboard access is needed.
- **Phone-side timings.** The owner chose "derive them": we use Google's timestamps (bridge `last_message_ts`, and the bridge's message-status events from Phase 0) plus the bot's own timeline. That misses only the phone's own download time.
- **How the bridge's 22 s upload splits** (Synapse read vs. encryption vs. Google): Phase 0 adds a log line inside our own bridge patch.

---

## 2. Owner decisions

| | Decision |
|---|---|
| A | 👍 on an album opens its numbered song list. The zip is a separate action: **a `📦` line under the song list (👍 it) and the text `zip`** (answered 2026-10-20). |
| B | No back command. 👍 on any line of an earlier menu or view goes back to it and makes it the context for `X more`. |
| C | Never auto-pick: always a menu, even for an exact unique song or an artist's full name. |
| D | (default, unchanged) Albums = albums and EPs. Singles and loose tracks count as songs. A video counts as a song only when it is the only copy. |
| E | As fast as possible. **No more money** (2026-10-20): recommend $0 changes only. |
| F | Phone timings are derived, not stopwatched. |
| New | **Top songs are listed even when their album is listed too** (drops the 2026-10-18 "not listed alone" rule for menus and artist views). |
| New | **`album <q>`, `artist <q>`, `song <q>`** each give a one-category menu (5, then `X more` for 8). Plurals work too. Nothing is sent at once. |
| New | **`help`** is one text listing every command. |

Requirements that do not change (CLAUDE.md): Zemer first and music-table.com as the fallback; Zemer's whitelist re-check with female singers excluded; `allowFemale=0&blockVideos=0&kidZone=0`; the per-song gate at send time (`youTubeGate`); the YouTube Music fallback when Zemer is down; the loop-guard marks.

---

## 3. Phases (riskiest unknowns first)

Order: **0 measure → 1 bridge fix → 2 search model → 3 speed → 4 docs**. Phase 1 can ship together with Phase 0's bridge parts (same image build). Each phase is one or two deploys and can be handed to its own session.

### Phase 0: Measure (no behaviour change)

**Goal.** Every request leaves one timeline line, the relay splits into its parts, and baseline numbers are recorded.

**Changes**
- `src/timeline.ts` (new): `Timeline` with `mark(step)`, `span(step, ms)` and `line()`. One instance per request in `src/runner.ts`, `handleMessage` / `handleReactions`, with `phoneAt = Date.parse(message.timestamp)` (Synapse's `origin_server_ts`, which the bridge sets to Google's timestamp) and `seenAt = now()`.
- `src/bot.ts`: `handle(msg, trace?)` takes an optional `trace(step, ms)`. Time `finder.find`, `finder.artist`, `albums.open` and `fillIn`.
- `src/runner.ts`: time each `chat.sendText` / `sendAudio` / `sendFile` (first send, last send, average per line), each song (fetch, tag, upload), and in `sendAlbum` the per-song disk+CRC time, building the zip, and the upload. Log one line per request, for example `timeline: "search achas" phone→seen 7.6s · bot 1.0s (zemer 0.21s) · 12 msgs first +1.0s last +4.3s (0.30s each) · at Google +5.1s`.
- `src/cloud/youtube-relay.ts`: return `timing` with `put`, `wait`, `get`, and the `worker` timings read from the result JSON. The runner logs `song: <title> fetch 5.0s (put 0.12, queue 1.4, worker 3.1 [session 0.3, player 0.6, download 1.9, r2 0.3], seen +0.6, get 0.4) tag 0.3 upload 0.6`.
- `cloudflare/youtube.ts`, `handleRelayRequest`: put `timing` in the result JSON and the log line. `queuedMs = start − object.uploaded` (R2's own upload time of the request) is the notification + queue delay; plus `sessionMs`, `playerMs`, `downloadMs`, `putMs`. A Worker deploy (wrangler).
- **Google's ack, in band:** turn on the bridge's message-status events (`matrix.message_status_events: true` in `patchBridgeConfig`, `src/cloud/provision.ts`; first check that the key is in `mautrix-gmessages -e` output, since `patchBridgeConfig` throws on a missing key and would fail the boot). `src/matrix/client.ts` keeps `com.beeper.message_send_status` events in the sync filter, and the runner stamps "at Google +X s" for its own sent events (logged once the last status arrives, or after 120 s).
- `deploy/cloud/patches/gmessages-stream-media.patch`: one info line in the streamed path, `media to Google: 43.9 MB, homeserver 1.2s, encrypt+upload 19.8s`. Regenerate the patch; its Go tests still run in the Dockerfile.
- `/status` gets `timings`: the last 20 timeline lines (in memory), so a check doesn't need a log search.

**Tests.** Timeline formatting (`test/timeline.test.ts`). The relay timing parse (`test/youtube-relay.test.ts`). The Worker's timing fields (`test/cloudflare.test.ts`). The runner logs one timeline per request with a fake clock (`test/matrix-runner.test.ts`, using `test/helpers/mock-matrix.ts` extended to emit message-status events). The provision fixture has the new bridge key (`test/provision.test.ts`).

**Success.** After the deploy, the owner's next 3 searches, 3 song 👍s and 1 album 👍 each leave a full timeline; the Worker split adds up to within 0.5 s of the host's relay time. Log analysis uses Render's plain-substring search (`timeline:`, `song:`, `media to Google`); results over ~25 KB are saved to a file and parsed with a short script.

**Risk.** Low. The bridge key could be missing, which fails boot loudly: test with a local `docker build` first. The status events add a little sync traffic.
**Rollback.** Redeploy the previous commit; the Worker with `wrangler rollback`.

### Phase 1: Kill the bridge stall (gates the menu)

**Goal.** No `deduplicate dm` waits; a reply's lines reach Google as fast as they are sent.

**Changes**
1. **Before building**, restore the live bridge DB read-only to the scratchpad (`litestream restore` from R2 with the host's settings) and look at `gmessages_direct_conversation` and `portal`. Find which row is `byPhone` for the self-chat number, and check that `ReIDPortal` (called on every event today, before the failing insert) is a no-op, meaning the source portal is gone. That confirms the fix only lets an already-intended delete and insert succeed, and that it won't touch the bot's room `!hcrtlLjpWXyehvjeXX`.
2. `deploy/cloud/patches/gmessages-dedup-dm-txn.patch` (new): upstream `dbbd04de` cherry-picked onto `186284e` (check it with `git apply --check`), plus a small Go regression test in the patch. The test opens a temp SQLite DB with the bridge's URI options (`_txlock=immediate`, 5 connections, 5 s busy timeout), runs `DirectConversation.Delete` + `Insert` inside `DoTxn` the way `deduplicateDM` does, and asserts it ends in under 1 s (it takes 5 s and fails without the fix).
3. `Dockerfile`: apply every patch (`for p in /patches/*.patch; do git apply "$p"; done`) and run the new test with the existing `go test`.
4. **Why a cherry-pick and not a newer pin.** `main` after `186284e` also bumps `go.mod` (mautrix-go), changes pairing (`pair_google.go`, "re-pair with the previously paired phone") and portal metadata. A mautrix-go bump can carry a database migration, which would make rolling back to the old binary fail. The cherry-pick has no migration and no pairing change, so rollback is just a redeploy. Moving to a newer pin is a later, separate change (when v26.11 ships, after checking its migrations).
5. No `_busy_timeout` change: once the cause is gone the timeout doesn't matter, and lowering it could make other writes fail.

**Testing.** The Go test in the Docker build. A local container run (`docs/cloud.md`'s Mac recipe: the image, an S3 stand-in, 0.1 CPU) proves it boots, migrates nothing and the streaming tests pass. Pairing a second bridge to the owner's Google account is **not** done (it risks unpairing the phone), so the dedup path itself is proven only on the live host.

**Proof on the live host.** Render log search for `deduplicate dm` and for `database is locked` after the deploy returns nothing. A 10+ line reply arrives with "at Google" within about 0.5 s per line: baseline 47.5 s for 10 lines, target ≤ 6 s. Text-in lag (phone→seen) baseline 7.6 s, target ≤ 2.5 s.

**Fallback if it can't be fixed (unlikely, given the upstream fix).** The menu ships in a compact mode: one message per category (3 messages, no 👍 per line, picks by text such as `a1`/`b2`/`s3`, built from `joinLists`), with chips kept for numbers. It also stays an option behind `MENU_STYLE=compact` if Phase 0 shows per-message cost is still high.

**Risk.** Medium (bridge build), mitigated by the minimal patch. A bad bridge could unlink Google Messages, and re-linking needs the owner's phone on `/pair`.
**Rollback.** Redeploy the previous commit. No DB migration, so the old binary reads the same DB.

### Phase 2: Search model and navigation state

**Goal.** Menus per the spec, persistent views, paging, going back by 👍, and old lines still working.

#### 2a. Fetching
- `src/sources/zemer.ts`: `PER_KIND` 20 → **50**. `ZemerSearch.search` gets a 10-minute, 30-entry cache keyed by query (like `#kept`), so paging costs nothing within 10 minutes and one 0.2 s request after a restart.
- `createZemerFinder.find` keeps every filter as it is (whitelist by channel id, `allowFemale=0&blockVideos=0&kidZone=0`, the YouTube Music fallback). It now also returns per song `plays`, `video`, `artistIds` and a stable `id` (the videoId), and singles separately (`Findings.singles`).
- `once()` folds duplicates keeping the copy with **more plays** (then more songs for albums), not the first (fixes F5).
- **Singles (D):** never in albums. A single whose song is already in songs (same title and artist) is dropped; one that isn't becomes a song entry with postback `single:<releaseId>` (opened on 👍 from the album page, cached, then sent like any song).
- **Videos:** folded into songs only when no audio copy exists, ranked below an audio song with the same score.
- The music-table.com fallback (only when nothing from Zemer fits, as now) renders as the same menu shape: a 🎤 line for a music-table artist match (`mtartist:<id>` opens today's releases list) plus songs. It never auto-sends any more (C).

#### 2b. Ranking (new `src/ranking.ts`; matching primitives stay in `src/sources/relevance.ts`)
Every category keeps today's relevance gate first (`fitsAll`; for artists, today's `namedArtist` coverage test: every word in the name and at least half the name covered). Then:
- **Artists:** tier = exact (every name word typed exactly) > prefix > typo; then coverage (share of name words matched); then Zemer's order. A typo match is shown but never outranks an exact one, and **no code path treats an artist match as authority any more**: `namedArtist(...).full` and its callers in `fromFinder` and `albumSearch` are removed.
- **Songs:** tier 3 = the words name the title (`namesSong`, with `(feat. …)`/`(Live)` stripped; it also handles Hebrew↔Latin through `soundsLike` and bilingual "X - פוראבר" titles); tier 2 = every word is in the title; tier 1 = it fits only with the artist's name. Within a tier: plays (missing counts as 0), then an audio song before a video, then Zemer's order. Duplicates are already folded.
- **Albums:** an exact title first, then newest (year, then release date), then more songs. Editions of one artist's album are folded the way `editions()` does on the artist page ("אלעזר ליפא׳לע" and its Yinglish and Hebrew editions are one line).
- **Credits:** " — Artist" is left off a line when the menu's artists section holds exactly one artist and the line is theirs; otherwise it is shown.
- **Fewer than 5:** show what survives. An empty category is omitted, and the hint names only categories with more left. All empty → music-table.com → "No match".

#### 2c. Conversation state (replaces the `more` closure, `browse.setPage` and "any text clears the list")
- **Store:** a new catalog table `views (id INTEGER PRIMARY KEY, parent INTEGER, kind TEXT, key TEXT, shown TEXT, last_more TEXT, at TEXT, used_at TEXT)` in `src/catalog.ts`, with `viewsIn(catalog)` like `choicesIn`, and state key `chat.view` for the current view. Pruned on insert: `used_at` older than 31 days (same as `message_links`), newest 300 kept. Litestream backs it up like the rest, so it survives restarts. Rows are small (about 1 KB).
- **A view** is `search` (key: `{query, only?: 'artists'|'albums'|'songs', zemerOnly?}`), `artist` (`{artistId}`), `album` (`{albumId}`) or `list` (music-table's trending/new/category/artist `ListPage`). `shown` holds the ids already shown per category, in order. Album numbers are positions in `shown.albums`, so they run on across pages.
- **Lists are recomputed, not stored.** Paging re-runs the (cached) search or artist page, ranks it, and skips ids in `shown`. Shifts in Zemer's order can't repeat or skip a line, state stays tiny, and nothing Zemer-specific is serialized into the bot.
- **Postbacks:** today's `play:`, `album:`, `tracks:`, `post:` and `all:` stay. New ones are `artist:<id>`, `single:<id>`, `zip:<albumId>`, `view:<viewId>`, plus an optional suffix **`@<viewId>`** on any line's postback naming the view it belongs to. It is stored in `message_links` as part of the postback, so no schema change is needed there (it also works for `text:` copy-matching).
- **What a 👍 does to the current view:** a postback with `@v` makes `v` current first (if it still exists), then acts. Artist and album lines push a child view (`parent = v`), which becomes current. A song is sent and the current view stays `v`. A `view:<id>` line (every view's closing hint, and the header of artist and album views) makes that view current and answers one line, `🎵 Back to "achas".`, with nothing sent. Old lines without `@v` act and leave the current view alone, except `album:`/`tracks:`, whose new album view becomes current.
- **Numbers and `all`** stay in the runner's chips mechanism (it works for Beeper and RBM too). Two runner changes: chips are applied **when the answer is decided** (in `send`, before queueing), so a number texted while songs are on their way picks from the right list; and an unrelated text **no longer clears** the list (a list is replaced only by a reply carrying new chips). Every reply that changes the current view carries that view's chips, using an empty-text chips reply when it shows no list itself. TTL is 2 h from last use.

#### 2d. Commands (routing in `handle()`, checked in this order)
| Text | Meaning |
|---|---|
| `artist(s)\|album(s)\|song(s) more` (rest is in `MORE`) | Next 8 of that category in the current view. If the view has no such category, walk up to the nearest ancestor that has it (an album view opened from the menu → the menu's songs), which then becomes current. |
| `more` (bare) | Repeats the view's last `X more`. With none yet, one line naming the categories with more left (`Text "albums more" or "songs more".`). In a `list` view (trending etc.), the next 10 as today. |
| `search <q>` | Full menu (Zemer first, then music-table.com). |
| `artist <q>` / `album <q>` / `song <q>` (and plurals) | A one-category menu: same search, only that section. A later `songs more` in it shows that query's first 8 songs. |
| `zemer <q>` (`youtube`, `yt`) | Full menu from Zemer only. |
| a number | The numbered line in the current view (an album in a menu or artist view → its songs; a song in an album view → sent). |
| `zip` (`send zip`, `whole album`) | In an album view: the zip. Elsewhere: `Open an album first: tap 👍 on a 💿 line.` |
| `all` | Every song shown so far in the current view (album view: the album's songs), files only, up to 20, as today. |
| `help`, `hi`, `menu` | One text with every command (below). |
| trending/new/holidays/follow/unfollow/following | Unchanged. |

The collision is resolved by order: `albums more` is paging, `albums <name>` an album search. An album actually called "More" needs `search more`. The help text says so implicitly by listing `albums more`.

**Help (one message):**
```
🎵 Start each message with a command:
search <words> — artists, albums and songs
artist / album / song <words> — just that kind
artists more · albums more · songs more — 8 more ("more" repeats the last)
👍 a 🎤 artist — newest albums and top songs
👍 a 💿 album, or text its number — its songs; 👍 a song or text its number to get it
👍 📦 or text "zip" — the whole album as one zip
👍 any line of an earlier list — back to that list
all — every song on the list (up to 20)
zemer <words> — Zemer only
trending · new · chanukah · purim · wedding · vocal — music-table.com lists
follow / unfollow <artist> · following
```

#### 2e. Rendering, and the three walkthroughs (real Zemer data, k=50, ranking above)
One message per line so each can be 👍'd. **No section headings**: the marks already separate them (🎤 artists, 💿 albums numbered, 🎵 songs), and a heading costs a message (about 0.3 s plus bridge time) and can't be 👍'd. A full menu is at most 5+5+5+1 = **16 messages**; the three cases below are 12, 12 and 11. A new line kind, `📦`, is added to `KIND_MARKS` in `src/runner.ts` so the loop guard never answers it. The closing hint keeps `HINT_MARK`.

**"search achas"** (12 messages; view v41)
```
🎤 Nachas                                         artist:UCFaqe…@v41   (typo match: shown, not trusted)
🎤 Yiddish Nachas
🎤 Shlepping Nachas
💿 1. Achas — Mordechai Shapiro · 2022 · 12 songs           album:MPREb_SSjgz2CDJBF@v41
💿 2. Achas - A Freilach Medley — Zanvil Weinberger · 2024 · 8 songs
💿 3. One Heart (Aguda Achas) — Beri Weber · 2016 · 11 songs
🎵 Achas — Mordechai Shapiro      (1,500,000 plays)          play:<id>@v41
🎵 Achas — Yingerlich             (98,000)
🎵 Achas — Yaakov Rosenblum       (43,000)
🎵 Achas — Yerachmiel Begun & The Miami Boys Choir (24,000)
🎵 Achas — Freilach Band          (22,000; ties Simcha Leiner, Zemer's order breaks it)
‎Text "songs more" for 8 more songs, or an album's number for its songs.     view:41
```
- `songs more` → 9 messages: Simcha Leiner, Shmueli Ungar, Shalsheles, Moshe Tischler, Shlomo Katz, Shlomo Simcha, Shloime Dachs, Shir V'shevach Boys Choir, then the hint. Again → Naftali Blumenthal, Dovid Stein, "Achas אחת" — Mendy Hershkowitz Band (named through `soundsLike`), … The "Achas Shoalti" songs (tier 2) come only after all 30-odd exact "Achas" songs.
- 👍 Nachas → v42 (artist, parent v41): `🎤 Nachas · N albums · M songs` (view:42), their newest 5 💿, top 5 🎵 by plays, hint. `albums more` → the next 8 of Nachas's albums.
- **Back after an artist:** 👍 "Achas — Yaakov Rosenblum" in the v41 menu → v41 becomes current, the song is sent; `songs more` continues v41 (lines 6–13).
- **Back after an album:** 👍 line 4 → v43 album view (15 messages: header (view:43), 12 numbered songs, `📦 All 12 songs as one zip · 41 min` (zip:MPREb_SSjgz2CDJBF@v43), hint). Then `songs more` → v43 has no paging, so it walks up to v41's next songs, and v41 becomes current.
- **Back after a played track:** 👍 a 🎵 line → song; then `albums more` → `That's all the albums for "achas".`
- **Back without opening anything:** 👍 the hint line → `🎵 Back to "achas".`

**"search lipa schmeltzer"** (12 messages): `🎤 Lipa Schmeltzer`; 💿 1. ליפא פאַר א גוּט יאָר - Lipa's Tekiyos · 2026 · 12 songs; 2. אלעזר ליפא׳לע · 2025 · 15 songs (editions folded); 3. Lipa Schmeltzer Concert — Camp Coolam · 2025 · 7 songs (the only credited line); 4. The Event 5769 (Live) · 2023 · 26 songs; 5. יום טוב ליפא · 2023 · 17 songs; 🎵 פועל (182k), Kovati (AKA Lipa's Superbowl Takeover) (89k), Lipa's Shul (65k), Yener (57k), שלום (42k); hint `Text "albums more" or "songs more" for 8 more, or an album's number for its songs.` Today this text opened his page (songs first); now it is a menu (C), and 👍 on the 🎤 line gives the artist view (albums first).

**"search forever" → album → zip** (no artist passes the gate: Rabbi Yoel Ferber and DJ Farbreng are dropped). 11 messages: 💿 1. FOREVER — Itzik Dadya · 2025 · 13 songs; 2. Forever — Shimon Kugel · 2009 · 11 songs; 3. Miami Forever! — Yerachmiel Begun & The Miami Boys Choir · 2019 · 13 songs; 4. Forever More (Me'atah V'ad Olam) — Shimon Craimer · 2018 · 10 songs; 5. Forever One — Avraham Fried · 2010 · 10 songs; 🎵 Forever — Zusha (58k); Forever - פוראבר — Itzik Dadya (55k, a bilingual exact title); Forever — Chayala Neuhaus & Yehuda Kirschner (20k; both artists are on Zemer's list as not female); Forever — Yosef Gestetner; Forever — Shloime Dachs; hint. Then `1` (or 👍 line 1) → album view, 16 messages (header, 13 numbered songs, 📦 line, hint). 👍 📦 → cover + `🎵 13 songs, coming as a zip.` → the zip. Today's comparison on 2026-10-20: 110 s from 👍 to zip at Google; target after Phases 1 and 3: ≤ 40 s.
- **Restart in the middle:** views, `chat.view` and `message_links` are in the catalog, so after a deploy `songs more` re-runs the search (one 0.2 s request, cache empty) and continues where it was.
- **Old lines:** a 💿 line sent before the change (`album:<id>`, no `@v`) opens the album view (the new decision A; it no longer sends a zip); an old 🎵 line still sends its song; an old album header line (also `album:<id>`) opens the song list again; `post:` and `all:` are unchanged.

#### 2f. Files and tests
- **Code:** `src/bot.ts` (routing, postbacks; the `more` closure, `offerMore`, `artistView`/`artistAlbums`/`fromFinder`/`pickList` replaced), new `src/menu.ts` (rendering), `src/ranking.ts`, `src/views.ts`, `src/catalog.ts` (`views` table, `viewsIn`), `src/runner.ts` (when chips apply, no clear on unrelated text, 📦 mark), `src/sources/zemer.ts` (k, cache, plays, `once`, singles), `src/types.ts` (Reply `view` id), `src/matrix-main.ts`, `src/beeper-main.ts`, `src/simulate*.ts` and `src/handler.ts` (pass the view store), and the help text.
- **New tests**, with a golden fixture `test/fixtures/zemer-search-achas.json` (the saved real k=50 response, served by `test/helpers/mock-zemer-search.ts` in a new "raw response" mode, with `mock-zemer-content.ts` whitelisting its channel ids):
  - achas: songs under songs, Nachas under artists, nothing sent, exactly the 12 lines above;
  - lipa schmeltzer: editions folded, credits only on the Camp Coolam line;
  - an exact unique song gives a menu, not a song;
  - paging 5 → 8 → 8 with numbers running on; the same inside an artist view; `X more` walking up from an album view;
  - back to the menu after an artist, an album and a played track; a 👍 on a hint line;
  - restart mid-session (new catalog instance on the same file → `songs more` continues);
  - old postbacks (`album:`, `tracks:`, `play:`, `post:`, `all:` without `@v`);
  - Hebrew↔Latin (`vnusni` → ונתנו in tier 3; `elazar lipa'le` album exact);
  - fewer than 5 after the whitelist (a female-flagged or blocked song is never shown or sent; the gate still refuses it at send time);
  - Zemer down → YouTube Music fallback menu; Zemer empty → music-table.com menu;
  - `artist`/`album`/`song` one-category menus; `albums more` vs `albums <name>`; `zip` in and out of an album view; `help` is one message; the 📦 line is never answered by the runner.
- **Tests to rewrite, and why:**
  - `test/bot.test.ts`: auto-send of a named song, the artist page on a full name, `more` closure semantics.
  - `test/albums.test.ts`: 👍 album → zip, `album X` sending at once, header 👍 → zip.
  - `test/search-order.test.ts`: answers were auto-picked.
  - `test/zemer.test.ts`: `k=20` in requests, `once` keeping the first copy.
  - `test/relevance.test.ts`: only where `namedArtist`'s full-name authority was relied on.
  - `test/simulator.test.ts` and `test/e2e.test.ts`: old list format and flows.
  - `test/matrix-runner.test.ts`: "a new search ends the list" and the chips timing.
  - `test/beeper-runner.test.ts`: numbered lists built from menus.
  - `test/music-table.test.ts` and `test/library.test.ts`: only where `more` and the list state are touched.

**Success.** `npm test` and `npm run typecheck` pass. `npm run simulate:web -- --open` shows the three walkthroughs as above (the owner judges the chat by how it reads). Live: `search achas` lists the Achas songs, with the Nachas artists only offered.
**Risk.** Medium-high (a big UX change, and many tests). It ships only after Phase 1 is proven live.
**Rollback.** Redeploy the previous commit. The new `views` table and `@v` postbacks are ignored by old code (an old bot treats `play:42@v41` as unknown, so lines sent during the new version stop answering a 👍 after a rollback: an accepted cost, noted in the deploy message).

### Phase 3: Album and song speed (after Phase 1 and the Phase 0 numbers)

Baseline for a 13-song, 44 MB album (2026-10-20): 👍 ingress ~5–8 s (stall) + prep ~2.7 s + **fetch 67 s** + zip 5 s + **hand-off 22 s**, about 110 s. Savings below are estimates from that baseline; Phase 0 confirms each before it is built.

| # | Change (files) | Expected saving | Cost (effort) | Risk | Do |
|---|---|---|---|---|---|
| 1 | Bridge fix (Phase 1) | Album ingress −5–8 s; **a 10-line reply −40 s** | done in Phase 1 | — | yes |
| 2 | **Album songs fetched 3 at a time** (`src/runner.ts` `sendAlbum`: its own concurrency, separate from `DOWNLOADS_AHEAD`, which stays 1 for single songs). A memory guard starts the next fetch only while the container is under 380 MB (`MemoryWatch` reading, `src/cloud/memory.ts`) and the result's `bytes` fits a 40 MB in-flight budget. Adaptive: after one "turned away", the rest of the album goes one at a time | fetch 67 → ~25 s (**−40 s**) | M | YouTube's bot check (13 asks in ~25 s instead of 67 s; spells were seen at ~30 asks in 7 min); memory (+10–25 MB typical, guarded). Gate: Phase 0 must show the queue runs 3 Workers at once | yes |
| 3 | Relay trims: poll every 400 ms flat; delete in the background (`youtube-relay.ts`); the Worker caches `visitorData` for 30 min in the isolate and reads the videoId from the key name (skipping a GET and a DELETE) (`cloudflare/youtube.ts`) | −1.5–2.5 s per song (sequential −20–30 s per album, with #2 −8–12 s); **single song −2 s** | S | Low; R2 reads +~10 per song, far inside the free 10M | yes |
| 4 | OneDrive copies wait while a delivery is in flight (`src/archive/archiver.ts` pauses on a runner "busy" signal) | 0–5 s on albums (measure) | S | Low | yes |
| 5 | `fillIn` runs alongside the download instead of before the reply (`play()` returns at once; `taggedFetch` awaits `fillIn` in parallel with the relay) | −0.2–2.5 s per single song | S | Low | yes |
| 6 | Long-poll Matrix sync (`timeout=25000`, with an abort for stop and announce) in `src/matrix/client.ts` + runner loop | −0.75 s average per request; Synapse handles ~2 syncs/min instead of 40 | M | Announce and stop paths need the abort | next |
| 7 | Worker-side album batch (one request lists the album; the Worker fetches with concurrency 3 on one session and writes each as ready) | queue delay × 13 / 3 | M–L (protocol + 2 deploys) | Medium | only if Phase 0 shows queue delay > 1 s/song or no queue concurrency |
| 8 | Direct HTTPS call to the Worker on a route of the owner's Cloudflare domain, streaming the audio (no R2, queue or polling) | queue + R2 overhead (Phase 0) | M | Bot challenge on the zone; uses the owner's domain | only if overhead > 1.5 s/song after #3, and with the owner's OK |
| — | Concurrent menu sends | ~3 s on 16 lines | — | **Order could break** | rejected |
| — | Prefetch album pages during the menu | ~0.2 s | — | Zemer stalls under bursts | rejected |
| — | `SONG_GAP_SECONDS` 5 → 2 | only 👍 bursts | — | Phone ordering | experiment after Phase 1, not planned work |

**Recommended set:** #1–#5 now (one host deploy plus one Worker deploy), #6 next, #7/#8 only on Phase 0 evidence. Expected album time: ~110 s → **30–40 s** before the phone's own download. Single song: about −2–4 s. Search menu: dominated by Phase 1, ~5–6 s for 16 lines.

#### Infrastructure assessment (the rule: no more money)
| Slowdown | Fixed by software? | What paying would add | Price |
|---|---|---|---|
| Bridge lock (5 s per write) | **Yes**: upstream fix | Nothing: it is a lock wait, not CPU | — |
| Album songs one at a time | **Yes**: #2 | `1c-2g` (2 GB) would make the memory guard unnecessary, not the waiting shorter | $25/mo |
| Relay round trip | **Yes**: #3, #7, #8, within the $5 plan | Nothing | — |
| Zip hand-off (22 s) | Unknown until Phase 0 | `0.5c-512mb` helps only if encryption is CPU-bound at 0.1 CPU | $7/mo |
| ~0.3 s per message | Probably Synapse on 0.1 CPU (Phase 0 confirms) | `0.5c-512mb` might halve it | $7/mo |
| Restarts ~55 s | Little left in software | `0.5c-512mb` maybe 20–30 s | $7/mo |
| Splitting bridge+Synapse into a second service | Not possible free: the 750 free hours are per workspace (two always-on services need 1,488), free web services can't receive private traffic, private services aren't free. It also wouldn't fix either main problem, and would move the homeserver off 127.0.0.1 | | ≥ $7/mo |
| Cloudflare Containers | Included allowance ≈ 50 h/month of a 512 MB container, not always-on | | extra |

**Recommendation: spend $0.** The two slowdowns that matter are software, and the plan fixes both. The rest is small or only affects restarts. **One money risk to guard:** Render's 5 GB/month outbound (songs plus OneDrive copies) is charged at $0.15/GB past it, or the service is suspended if no card is on file. Today only `cloud:check` warns, at 3.5 GB. Add a `Health` alert at 4,000 MB of sent+archived, and let `ONEDRIVE_MAX_MB_PER_MONTH` stop OneDrive first (Phase 4, small).

### Phase 4: Docs and rollout
- **Docs:**
  - `CLAUDE.md`: menu model, views, commands, the new bridge patch, the no-money rule.
  - `README.md` and `docs/using-the-bot.md`: the menu, `X more`, 👍 to go back, 📦/`zip`, `artist`/`album`/`song`, help.
  - `docs/architecture.md`: views table, `ranking.ts`/`menu.ts`, the timeline.
  - `docs/cloud.md`:
    - the bridge's stall cause and fix;
    - the CPU explanation corrected: requests peaked at 0.09 of 0.15, so the tenth of a CPU explains restarts, not request latency;
    - Starter is 0.5 CPU and 512 MB;
    - the timeline and how to read it;
    - "What has been proven" updated.
  - `docs/youtube-music.md`: relay timings and concurrency.
- **Memory** (when executing; not writable in plan mode): the owner's no-more-money rule; the bridge root cause and fix; the menu decisions of 2026-10-20.

---

## 4. Rollout (each step is: owner's go-ahead → push to `main` → one manual Render deploy, never stacked)

| # | Deploy | Contents | Check after | Rollback |
|---|---|---|---|---|
| W1 | Worker (`npx wrangler deploy` in `cloudflare/`) | Phase 0 timing fields (backward compatible: old hosts ignore them) | `wrangler tail`: one line per song with `queuedMs` | `wrangler rollback` |
| R1 | Render | Phase 0 host instrumentation + Phase 1 bridge patch + `message_status_events` | Boot reaches `signed in as`; `/pair` shows linked; log search `deduplicate dm` and `database is locked` → none; owner does 1 search, 1 song 👍, 1 album 👍; timelines present | Redeploy the previous commit |
| R2 | Render | Phase 2 menu | `search achas` reads as walkthrough 1; `songs more`; 👍 back; restart test (the deploy itself); an old 💿 line opens songs | Redeploy previous (lines sent under R2 lose their 👍) |
| W2 | Worker | Phase 3 #3 (visitor cache, key-name videoId; host stays compatible with both formats) | `wrangler tail` timings drop | `wrangler rollback` |
| R3 | Render | Phase 3 #2–#5 (+ the bandwidth alert) | Album timeline ≤ 40 s; memory peak in `/status` under 440 MB; turned-away rate in Worker logs not up | Redeploy previous, or set album concurrency to 1 by env without a deploy (it is read at start, so an env change restarts) |
| R4 | Render | #6 long-poll (separately, since it touches the core loop) | phone→seen ≤ 1 s | Redeploy previous |

Only `main` is used (no long-lived branches). Short work branches are merged and deleted.

---

## 5. Measurement plan: before and after

| Metric (source) | Before (2026-10-20) | After P1 | After P2 | After P3 |
|---|---|---|---|---|
| Text in: phone → bot (timeline `phone→seen`) | 7.6 s (1 sample) | ≤ 2.5 s | same | ≤ 1 s with #6 |
| Reply lines: first/last reach Google (status events; before: bridge `last_message_ts`) | 10 lines, last at +47.5 s | ≤ 0.6 s/line | 16-line menu ≤ 8 s | same |
| Bot think time for a search (`bot …`) | ~1.0 s | same | ≤ 1.2 s (k=50, ranking) | same |
| Single song: 👍 → audio at Google | ~6 s bot-side (1 sample); Google time unknown | collect | collect | −2–4 s |
| Album 13 songs / 44 MB: 👍 → zip at Google | 110 s | ~100 s | same | ≤ 40 s |
| Relay per song (host / Worker split) | median 5.0 s; split unknown | split known | — | −1.5–2.5 s |
| Peak memory during an album (`/status`, Render) | 391 MB | same | same | ≤ 440 MB |
| `deduplicate dm` / `database is locked` lines per hour | dozens per conversation burst | 0 | 0 | 0 |

At least 3 samples per metric after each deploy, from normal use plus the owner's 3-action check (a search, a song 👍, an album 👍 → 📦). Peak CPU per 30 s from Render metrics for each window.

---

## 6. Open questions (the plan uses the default until answered)
1. **Cloudflare access for Phase 0:** authorize the Cloudflare observability tool (`/mcp`), or allow `npx wrangler tail mors-edge` from this Mac during tests. Default: the Worker's own timing fields (W1), which need neither.
2. **#8 (direct Worker route on your Cloudflare domain):** asked only if Phase 0 shows the queue and R2 overhead is large.

## 7. Risk register
| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| A bridge deploy unlinks Google Messages | Low / high (re-link needs the phone) | Minimal cherry-pick, no pairing code; restored-DB check first; deploy when the owner is reachable; rollback = redeploy |
| `ReIDPortal` or the delete touches the bot's room | Low / high | Inspect the restored DB first; `RoomWatch` already turns a lost room into a waiting state + alert |
| `message_status_events` key missing → boot fails | Low / high | Check `-e` output; local `docker build` + boot before R1 |
| 16-message menus still slow if the bridge isn't fixed | Low after the upstream fix / high | Phase 1 gates Phase 2; `MENU_STYLE=compact` fallback |
| A fuzzy artist match treated as authority somewhere | Removed / medium | `full` and its callers deleted; tests assert nothing is auto-sent |
| 30+ songs share a title, many with no play count | Certain / low | Tie order: plays → audio before video → Zemer's order; exact tier always first |
| Whitelist leaves <5 in a category | Common / low | Show what survives; omit empty sections; the hint names only real `X more`s |
| Parallel relays meet YouTube's bot check more | Medium / medium | Concurrency 3, adaptive drop to 1, existing retries; watch the Worker's turned-away rate |
| Memory spike from 3 songs in flight | Medium / high (OOM kill) | 380 MB container gate + 40 MB in-flight budget; `/status` peak checked after R3 |
| View state grows or breaks the loop guard | Low / medium | ~1 KB rows, 31 days / 300 rows; every new line kind (📦) gets a mark; runner test that marked lines are never answered |
| Old lines after the change, or a rollback | Certain / low | Old postbacks still parsed; a rollback loses 👍 only on lines sent by the new version |
| Many tests pin today's behaviour | Certain / medium effort | Listed in 2f; rewritten in the same change, with golden fixtures |
| Render log search: substrings only, big results go to a file | Certain / low | Distinct prefixes (`timeline:`, `song:`, `media to Google`); parse saved files with a script |
| Outbound traffic past 5 GB costs money | Low / money | 4,000 MB alert; OneDrive cap stops first |

## 8. Verification (per phase)
- Every phase: `npm run typecheck`, `npm test` (no network; mocks extended, not real services).
- Phase 0/1: `docker build` (runs the bridge patches' Go tests), local boot per `docs/cloud.md`. After R1: Render log searches above, plus `ADMIN_TOKEN=… npm run cloud:check -- --render https://music-over-rcs.onrender.com`.
- Phase 2: `npm run simulate:web -- --open` for the three walkthroughs and back-navigation; the golden achas test; live `search achas` after R2.
- Phase 3: an album timeline ≤ 40 s live; `/status` memory peak; Worker turned-away rate in `wrangler tail` or observability.
