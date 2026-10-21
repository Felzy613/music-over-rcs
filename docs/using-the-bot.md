# Using the bot

Everything happens in your chat with your own number in Google Messages. Every text the bot writes starts with 🎵 (or 💿 for an album, 🎤 for an artist's name over a list), except the line that closes a list and says how to pick from it ('Text "more" for more of …'), which isn't a song and has no mark. Because it writes as you, its messages look like ones you sent yourself.

**Every message starts with a command**: `search`, `album`, `zemer`, `trending`, `new`, `more`, `all`, a holiday list, `follow`, `unfollow`, `following` or `help`. To pick a song from a list, tap 👍 on it; the albums in a list have numbers, and texting one lists that album's songs. Anything else isn't searched for: the bot answers with the line to send instead (`search lipa vnusni`), so a song's name is never taken for a command, or the other way round.

## Asking for a song

Text `search`, then the artist and the song, the way you'd say it:

```text
search yoely weiss shabbos
```

You get two messages:

1. the song's **card**: its cover (with the title and artist under it)
2. the audio file itself, which plays in the chat

(The bridge can't put a caption on a picture, so the name is drawn on it. If a picture can't be made, you get the plain cover and the name as a line of text; a song without a cover comes with its name as text.)

- **Apostrophes are optional.** `search lipa vnusni` finds "V’Nusni", `search uvtuvcha` finds "U’v’tuvcha HaGadol", and `search v'nusni` works too.
- **Typos are fine.** `search yoely wiess shabos`, `search lipa shmeltzer vnusni` (the site writes "Schmeltzer"), `search avrohom fried` ("Avraham"), `search shlomo daskal` ("Shloime") and `search mordechai ben dovid` all work. The bot learns the site's spelling from the titles around your other words.
- **Extra words are fine.** `... by Yoely Weiss` is understood, and in a longer request one stray word (an `mp3` at the end, say) is forgiven.
- **Hebrew and Yiddish titles** are found by how you'd write them in English: `search vnusni` finds "ונתנו", `search elazar lipa'le` the album "אלעזר ליפא׳לע", `search shabbos` also "שבת".
- **Where songs come from.** `search` asks **Zemer first**: its catalog has the albums and singles of every artist on Zemer's list. If it has something that fits every word you typed, that is the answer. If not, the bot looks on music-table.com: your catalog first, then the site ([Zemer and YouTube Music](youtube-music.md), `SONG_SOURCES`). A Zemer song arrives as an `.m4a`; a music-table.com one as an `.mp3`.
- **A song it already knows by name comes back at once** (when Zemer has nothing for it). The song's whole name, alone or with some or all of the artist's (`search vnusni`, `search lipa vnusni`), is answered from the catalog without searching the site, and songs it keeps ready on disk go out without waiting for a download. A song that has to be downloaded starts downloading while its card is being made.
- **A letter off in `search` itself is fine** (`serach`, `seach`).

## Lists

When several songs or albums fit, you get a list, one short message each, so you can tap 👍 on the one you want: a song is its title, an album starts with 💿, has a number, and gives its year and how many songs it has. When everything on the list is by one artist, their name comes first, once:

```text
🎤 Lipa Schmeltzer
💿 1. אלעזר ליפא׳לע · 2025 · 15 songs
💿 2. אלעזר ליפא׳לע (Yinglish Version) · 2025 · 15 songs
💿 3. אלעזר ליפא׳לע - גרסה עברית · 2025 · 15 songs
Text an album's number to choose from its songs.
```

Otherwise each line says whose it is:

```text
🎵 Shabbos — Shua Rose
🎵 Shabbos — Shlomo Katz
🎵 Shabbos — Suki & Ding
💿 1. Shabbos Tish — Belz · 2000 · 14 songs
💿 2. Shabbos Classics — Efraim Mendelson · 2018 · 13 songs
Text an album's number to choose from its songs.
```

A song that is on one of the albums listed (or, on an artist's page, on any of their albums) isn't listed on its own as if it were a single: it is under its album's number.

Then any of:

| Reply | What happens |
| --- | --- |
| 👍 on a song (🎵) | That song. The list stays open, so you can 👍 another next. |
| 👍 on an album (💿) | The whole album, as one zip (below) |
| An album's number (`2`) | Its songs, numbered as on the album, under the album's 💿 line: 👍 the songs you want (or text a song's number), or 👍 the 💿 line for all of it as a zip |
| `all` (or `send all`, `everything`) | Every song on the list, with 5 seconds between files: files only, no cards, up to 20 (not the albums) |
| `more` | The next ones, when there are more |
| `search` and a new name | A new search; the old list closes |

A number that isn't on the list gets the numbers that are ("Text a number from the list (1 to 5), or tap 👍 on a song."), and in a list with no numbers, "To get a song from the list, tap 👍 on it." Numbers on an artist's page go on across `more` (the second page's first album is 6), and the earlier ones still work. A search's list stays open (for `all`) for half an hour, the other lists for two hours, and the daily message's for the day; a 👍 on a song works for a month. (On Beeper and RCS for Business, where a 👍 can't reach the bot, a list comes as one numbered message instead, and you reply with a number.)

## Artists

Search for an artist's name, or part of it (`search lipa`, `search yoely weiss`), to get their page on Zemer: their five most played songs, then their five newest albums, and `more` for the next ones.

```text
🎤 Lipa Schmeltzer
24 albums · 25 singles · 412 songs
🎵 Mizrach
🎵 Hang Up The Phone
🎵 Abaye Ve'rava - אביי ורבא
🎵 Believe In A Miracle
🎵 Shualim - שועלים
💿 ליפא פאַר א גוּט יאָר - Lipa's Tekiyos · 2026 · 12 songs
💿 אלעזר ליפא׳לע · 2025 · 15 songs
💿 יום טוב ליפא · 2023 · 17 songs
💿 The Event 5769 (Live) · 2023 · 26 songs
💿 BavLipa - בבליפא · 2022 · 20 songs
🎵 Text "more" for more of Lipa Schmeltzer.
```

- Typos are fine (`search lipa shmeltzer`).
- An album shows once here, in its original edition; `album lipa` lists all of them, every edition, newest first, eight at a time.
- An artist Zemer doesn't have gets their releases from music-table.com instead, newest first, ten at a time (an album there is one entry; picking it lists its songs).

## Albums

To get a whole album, start with `album`:

```text
album a poshiter yid
```

An album the words name is sent at once; otherwise you get the albums that fit (`album lipa` lists all of an artist's), numbered: a 👍 on one sends it, its number lists its songs to choose from (`all` doesn't send every album). A `search` lists albums too, after the songs, and when a song comes whose album your words also name, a 💿 line for the album comes under it.

You get its cover and one line (`11 songs, coming as a zip.`), then **one zip file**, `Artist - Album.zip`, with every song, numbered in album order (`01 Chamisha Kolos.m4a`, `02 …`). A zip holds up to 100 MB (`MAX_ZIP_MB`, what the bridge and Google Messages take), which nearly every album fits; a bigger one arrives as several zips, "(part 1 of 2)" and so on. In a chat that can't take a file (Beeper) the songs come one by one instead.

Everything from Zemer is held to [Zemer's artist list](youtube-music.md#zemers-artist-list), no female singers: an album is offered only if its artist is on the list, and a song on it that has a woman credited, or is blocked, is left out of the zip ("1 left out").

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

A thumbs up (any skin tone) on a message that stands for one song gets you that song: any option in a list, any song's line in the daily message, and a new-song alert's card or line. Other reactions, and a 👍 on anything else (like a song you just received, or a heading), are just reactions; the bot ignores them.

👍 as many as you like at once. Text lists are sent together; the audio files come **5 seconds apart**, each card with its song, so the phone has sent one before the next arrives ("typing…" shows while the next one waits). `SONG_GAP_SECONDS` in [Configuration](configuration.md) changes the gap; it applies to `all` too.

## Small things worth knowing

- `help`, `hi`, `menu` or a single character gets the help text, the list of commands:

  ```text
  🎵 Start each message with a command:
  "search" and a song or an artist, like "search lipa vnusni".
  "trending", "new", "chanukah", "purim", "wedding" or "vocal" for lists, "more" for the next ones, and "all" for every song on a list.
  "follow" and an artist to get their new songs as soon as they're out ("unfollow", "following").
  Tap 👍 on a song (🎵) to get it, or on an album (💿) for all of it as a zip; text an album's number to choose from its songs.
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
