# Using the bot

Everything happens in your chat with your own number in Google Messages. Every text the bot writes starts with a mark: 🎵 (a song, or anything else it says), 💿 an album, 🎤 an artist, 📦 an album's zip. The line that closes a menu and says what more you can do ('Text "songs more" for 8 more songs…') isn't a song and has no visible mark. Because the bot writes as you, its messages look like ones you sent yourself.

**Every message starts with a command**: `search`, `artist`, `album`, `song`, `zemer`, `songs more` (`albums more`, `artists more`), `more`, `zip`, `all`, `trending`, `new`, a holiday list, `follow`, `unfollow`, `following` or `help`. Anything else isn't searched for: the bot answers with the line to send instead (`search lipa vnusni`), so a song's name is never taken for a command, or the other way round.

It works like a streaming app (the owner's design, 2026-10-20): a search gives a **menu**, nothing is sent or opened on its own, and a 👍 opens or sends what you choose.

## A search's menu

Text `search` and what you're looking for: a song, an album, an artist, or some of each.

```text
search achas
```

You get a menu, one message per line so each can be 👍'd: up to 5 artists (🎤), 5 albums (💿, numbered) and 5 songs, best first, then a line saying what else you can do.

```text
🎤 Nachas
🎤 Yiddish Nachas
🎤 Shlepping Nachas
💿 1. Achas — Mordechai Shapiro · 2022 · 12 songs
💿 2. Achas - A Freilach Medley — Zanvil Weinberger · 2024 · 8 songs
💿 3. One Heart (Aguda Achas) — Beri Weber · 2016 · 11 songs
🎵 Achas — Mordechai Shapiro
🎵 Achas — Yingerlich
🎵 Achas — Yaakov Rosenblum
🎵 Achas — Yerachmiel Begun & The Miami Boys Choir
🎵 Achas — Freilach Band
Text "songs more" for 8 more songs, or an album's number for its songs.
```

- **Nothing is picked for you.** Even one song the words name exactly comes as a menu of one, and an artist's full name (`search lipa schmeltzer`) is a menu with them on the 🎤 line; 👍 it for their page.
- **The order.** Artists the words spell exactly come first, then ones they start, then ones a typo away (`achas` offers "Nachas", below any real match, and never opens it). Songs: the ones the words name (give or take "(feat. …)", "(Live)" and the alphabet), then the ones with every word in the title, then the ones that fit only with the artist's name; within each, the most played first. Albums: the ones the words name, then the newest, then the bigger. An album's editions ("(Yinglish Version)", "- גרסה עברית") are one line.
- **Whose it is.** " — Artist" is left off a line when the menu's only artist is that line's (`search lipa schmeltzer`: his songs and albums plain, "Lipa Schmeltzer Concert — Camp Coolam" credited).
- **Apostrophes are optional.** `search lipa vnusni` finds "V’Nusni", `search uvtuvcha` finds "U’v’tuvcha HaGadol", and `search v'nusni` works too.
- **Typos are fine.** `search yoely wiess shabos`, `search lipa shmeltzer vnusni` (the site writes "Schmeltzer"), `search avrohom fried` ("Avraham") all work.
- **Hebrew and Yiddish titles** are found by how you'd write them in English: `search vnusni` finds "ונתנו", `search elazar lipa'le` the album "אלעזר ליפא׳לע", `search shabbos` also "שבת".
- **Where it comes from.** `search` asks **Zemer first**: its catalog has the albums and singles of every artist on Zemer's list. Only when nothing there fits every word does the bot look on music-table.com: your catalog first, then the site ([Zemer and YouTube Music](youtube-music.md), `SONG_SOURCES`). A menu from music-table.com looks the same (an artist the site has on a 🎤 line, then songs). A Zemer song arrives as an `.m4a`; a music-table.com one as an `.mp3`.
- **A letter off in `search` itself is fine** (`serach`, `seach`).

### Just one kind

`artist`, `album` or `song` (or the plural) and the words give a menu of that kind only: `album lipa schmeltzer` is five of his albums, `artists achas` the three Nachas artists. `albums <name>` searches; `albums more` pages (an album actually called "More" needs `search more`).

### Doing something with a menu

| Reply | What happens |
| --- | --- |
| 👍 on a song (🎵) | That song: its card (the cover, with the title and artist drawn under it), then the audio file. The menu stays open. |
| 👍 on an album (💿), or its number (`2`) | The album's songs (below) |
| 👍 on an artist (🎤) | Their page: their newest albums and most played songs (below) |
| `songs more` (or `albums more`, `artists more`) | The next 8 of that kind; album numbers go on from the ones shown (6, 7, …) |
| `more` | The last "… more" again; before any, it says which there are |
| `all` (or `send all`, `everything`) | Every song shown so far, files only, up to 20, 5 seconds apart |
| 👍 on any line of an earlier menu | Back to that menu: it is the one `songs more`, numbers and `all` go on with |

A 👍 on a menu's last line goes back to it without sending anything (`🎵 Back to "achas".`). An unrelated text in between (`help`, a question) leaves the menu as it is; only a new menu replaces it. A number not in the menu gets the numbers that are; a number works for two hours after the menu was last used, a 👍 on a line for a month. The menus are kept in the catalog, so a restart (or a deploy) loses nothing: `songs more` goes on where it was.

## An artist's page

👍 an artist's 🎤 line:

```text
🎤 Lipa Schmeltzer · 21 albums · 412 songs
💿 1. ליפא פאַר א גוּט יאָר - Lipa's Tekiyos · 2026 · 12 songs
💿 2. אלעזר ליפא׳לע · 2025 · 15 songs
…
🎵 פועל
🎵 Kovati (AKA Lipa's Superbowl Takeover)
…
Text "albums more" or "songs more" for 8 more, or an album's number for its songs.
```

Their newest five albums (an album's editions as one) and their five most played songs, a song listed even when its album is too; `albums more` and `songs more` for the rest. An artist music-table.com has (a 🎤 line in a menu from there) gets their releases there instead, newest first, ten at a time with `more`.

## An album

👍 an album's 💿 line, or text its number:

```text
💿 FOREVER — Itzik Dadya · 2025 · 13 songs
🎵 1. Bayit Shel Shalom - בית של שלום
🎵 2. Forever - פוראבר
…
🎵 13. RokedLi (Funk Version)
📦 All 13 songs as one zip · 44 min
Tap 👍 on the songs you want, or text their numbers; 👍 📦 or text "zip" for all of it.
```

- 👍 a song, or text its number, for that song; `all` sends its songs one by one (up to 20).
- **👍 the 📦 line, or text `zip`**, for all of it: its cover, one line (`13 songs, coming as a zip.`), then **one zip file**, `Artist - Album.zip`, every song numbered in album order (`01 Bayit Shel Shalom.m4a`, …). A zip holds up to 100 MB (`MAX_ZIP_MB`, what the bridge and Google Messages take), which nearly every album fits; a bigger one arrives as several zips, "(part 1 of 2)" and so on. In a chat that can't take a file (Beeper) the songs come one by one instead.
- `songs more` in an album goes on with the menu it was opened from. A 💿 line from before menus (an old message) opens its album the same way.
- Everything from Zemer is held to [Zemer's artist list](youtube-music.md#zemers-artist-list), no female singers: an album is offered only if its artist is on the list, and a song on it that has a woman credited, or is blocked, is left out ("1 left out").

## Zemer alone

`search` asks Zemer first and music-table.com second. To look on Zemer **only**, with no falling back, start with `zemer` (`youtube` and `yt` work too):

```text
zemer lipa vnusni
```

## Trending, new, more

| Text | List |
| --- | --- |
| `trending` (or `top`, `popular`, `hot`) | Releases from the last month with the most views for their age, so a new hit beats an older song with a few more views |
| `new` (or `latest`, `new music`) | The newest releases |
| `more` (or `next`) | The next ten of the last list |

```text
🎵 🔥 Trending on music-table.com
💿 2GETHER — Yehuda Langer & 2 more · 12 songs · Sep 29
💿 Little Bardichevers Upmix (Full Album) — TYH Nation · 8 songs · Sep 30
🎵 Atoh Kail — Miami Boys Choir · Sep 22
…
```

`more` shows the next ten, and every song shown so far can still be 👍'd.

## Holiday and other lists

| Text | List |
| --- | --- |
| `chanukah` (or `hanukkah`, `chanuka`) | 🕎 Chanukah songs |
| `purim` | 🎭 Purim songs |
| `wedding` (or `weddings`, `chasuna`, `simcha`, `dance`) | 💍 Weddings & events: live wedding sets and dance music |
| `vocal` (or `a cappella`, `acapella`, `sefirah`, `three weeks`) | 🎤 Vocal (a cappella) songs |

They're music-table.com's own categories, most popular first (by views), with the same 👍, `more` and `all` as any list:

```text
🎵 🕎 Chanukah · most popular first
🎵 Chanukah Nights! — Miami Boys Choir · Dec 7, 2025
🎵 Miracles — Meilech Braunstein · Dec 24, 2024
🎵 Fire — Mordechai Shapiro · Dec 14, 2025
…
```

The first time you ask for one it reads the whole category from the site (a few seconds); after that the list comes from the catalog, refreshed at most once a day.

**In season, the bot points you to them.** From 15 Kislev to 3 Tevet `trending`, `new` and the daily message carry a line like `🕎 Chanukah is here: text "chanukah" for Chanukah songs.`; the same for Purim (1 to 15 Adar). During Sefirah (16 Nisan to 5 Sivan) and the Three Weeks (17 Tamuz to 9 Av) the line points to `vocal`, and the daily message lists the new a cappella songs first, each marked "vocal". The dates come from the Jewish calendar built into Node (`Intl`), in the host's time zone (`TZ`).

## Following artists

| Text | What happens |
| --- | --- |
| `follow shwekey` (any way you'd text the name: `follow avrohom fried` works) | 🔔 Following Yaakov Shwekey. Their new songs come to you as soon as they're out. |
| `following` (or `who do i follow`, `my artists`) | The artists you follow |
| `unfollow shwekey` (or `stop following shwekey`) | Stops |

When a new post by an artist you follow goes up on music-table.com, the bot sends it on its own, usually within 15 minutes: its card, then a line, then how to get it.

```text
[the cover, with "Brand New · Yoely Weiss" drawn under it]
🎵 🔔 New from Yoely Weiss: Yoely Weiss — Brand New
🎵 Tap 👍 on it to get it.
```

Like the daily message, it's the name and the picture, not the song: tap 👍 on the card or the line. Several at once each get their own card and line.

- **Quiet hours.** Nothing comes between 22:00 and 07:00 (see `QUIET_HOURS` in [Configuration](configuration.md)); what came out overnight is sent at 07:00, if it's under two days old.
- **Only what you don't have.** A song you already got (you texted for it first, or picked it from a list) isn't announced, and neither is anything that was out before you followed the artist.
- **The bot follows for you.** After you've had three different songs by an artist, it follows them and says so once, under the song: `🔔 You've had a few songs by Yoely Weiss, so I'll send you their new ones as soon as they're out. (Text "unfollow yoely weiss" to stop.)` After an unfollow it never does that for the same artist again. `following` marks these "(from your plays)".
- While you follow anyone, the bot looks at the site's RSS feed every 15 minutes (one small request) instead of only syncing every three hours. Following no one, it doesn't.

## The daily new-music message

At 09:00 each day (see `DIGEST_TIME` in [Configuration](configuration.md)) the bot sends what came out on music-table.com since the last one:

```text
🎵 New music · Monday, Oct 5
4 new songs on music-table.com
[one picture: the four covers in a grid, each with its name]
🎵 Ana Elech — Oizer Oberlander · single
🎵 Mi Adir — Yumi Lowy · single
🎵 Makdim Shalom — Hershey Eisenbach · music video
🎵 R' Chaim Zanvil Ben R' Moshe — Yoely Weiss · single
🎵 Tap 👍 on a song to get it, or "search" for anything else.
```

- It sends names and pictures, **never the songs themselves**. Tap 👍 on a song's line to get it, or text `all` for every song (that works all day).
- The picture holds up to nine covers; every song gets its line either way.
- Posts that are only a video (no MP3) are listed at the end under "Also new, video only".
- A day with nothing new sends nothing.
- The first time it runs it waits for the next 09:00 rather than sending in the middle of the day. If the host was down at 09:00 it sends when it's back, once.

To see today's message now: `npm run library -- digest` (shows it, sends nothing), or `npm run library -- digest --send` (sends it to your chat).

## 👍 to get a song

A thumbs up (any skin tone) on a line does what the line is: a song's line gets the song, an album's opens it, an artist's opens their page, a 📦 sends the zip, a menu's last line goes back to it. That holds for a menu, an album, an artist's page, the daily message and a new-song alert. Other reactions, and a 👍 on anything else (like a song you just received), are just reactions; the bot ignores them.

👍 as many as you like at once. Text lists are sent together; the audio files come **5 seconds apart**, each card with its song, so the phone has sent one before the next arrives ("typing…" shows while the next one waits). `SONG_GAP_SECONDS` in [Configuration](configuration.md) changes the gap; it applies to `all` too.

## Small things worth knowing

- `help`, `hi`, `menu` or a single character gets the help, every command in one message:

  ```text
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

- A message that isn't a command gets the line to send instead:

  ```text
  🎵 To look for a song, start with "search":
  search lipa vnusni

  Text "help" for the other commands.
  ```

- **You can keep texting while songs are on their way.** A request made while a song or an album is being sent is read at once: if the answer is text (a list, an album's songs, `help`) it comes straight away, and "typing…" stays up until everything asked for has arrived. Songs, pictures and albums asked for meanwhile wait their turn and come after the ones already on their way, in the order you asked.
- The same request repeated word for word within 20 seconds is answered once. In a chat with yourself a phone can show a text twice, and this keeps the bot from answering both. (So `all` twice in a row sends the songs once.)
- As a safety net the bot answers at most 30 requests in a minute. A long list (an album's songs) is one answer and arrives whole, a line for each song, as fast as the phone takes them.
- While it works it shows "typing…" in the chat. (The bridge passes it to Google Messages; whether a phone shows it in a chat with yourself depends on the phone.)
- A song that can't be sent (gone from the site, over the size limit) is named and explained, and the others still come.
- No buttons, cards or carousels: those are an RCS for Business feature, and the bridge carries only text, pictures and files. See [Other routes](other-routes.md#rcs-for-business-agent).
