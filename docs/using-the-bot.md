# Using the bot

Everything happens in your chat with your own number in Google Messages. Every text the bot writes starts with 🎵, and because it writes as you, its messages look like ones you sent yourself.

**Every message starts with a command**: `search`, `trending`, `new`, `more`, `all`, a holiday list, `follow`, `unfollow`, `following` or `help`. To pick a song from a list, tap 👍 on it: lists have no numbers. Anything else isn't searched for: the bot answers with the line to send instead (`search lipa vnusni`), so a song's name is never taken for a command, or the other way round.

## Asking for a song

Text `search`, then the artist and the song, the way you'd say it:

```text
search yoely weiss shabbos
```

You get two messages:

1. the song's **card**: its cover, with the title and artist drawn underneath
2. the MP3 itself, which plays in the chat

(The bridge can't put a caption on a picture, so the name is drawn on it. If a picture can't be made, you get the plain cover and the name as a line of text; a song without a cover comes with its name as text.)

- **Apostrophes are optional.** `search lipa vnusni` finds "V’Nusni", `search uvtuvcha` finds "U’v’tuvcha HaGadol", and `search v'nusni` works too.
- **Typos are fine.** `search yoely wiess shabos`, `search lipa shmeltzer vnusni` (the site writes "Schmeltzer"), `search avrohom fried` ("Avraham"), `search shlomo daskal` ("Shloime") and `search mordechai ben dovid` all work. The bot learns the site's spelling from the titles around your other words.
- **Extra words are fine.** `... by Yoely Weiss` is understood, and in a longer request one stray word (an `mp3` at the end, say) is forgiven.
- **A song it already knows by name comes back at once.** The song's whole name, alone or with some or all of the artist's (`search vnusni`, `search lipa vnusni`), is answered from the catalog without searching the site, and songs it keeps ready on disk go out without waiting for a download. A song that has to be downloaded starts downloading while its card is being made.
- **A letter off in `search` itself is fine** (`serach`, `seach`).

## Lists

When several songs fit, it asks which one. Each option is **its own message**, so you can tap 👍 on the one you want:

```text
🎵 Which one?
🎵 Mendy Roth — Chuppah Medley
🎵 Shulem Lemmer & Beri Weber — Chuppah Medley
🎵 Shloime Daskal & The Freilach Band — Chuppah Medley
🎵 Tap 👍 on one to choose.
```

Then any of:

| Reply | What happens |
| --- | --- |
| 👍 on an option | That song. The list stays open, so you can 👍 another next. |
| `all` (or `send all`, `everything`) | Every song on the list, with 5 seconds between files: files only, no cards, up to 20 |
| `more` | The next ten, when there are more |
| `search` and a new name | A new search; the old list closes |

A number picks nothing; with a list open it gets "To get a song from the list, tap 👍 on it." A "Which one?" list stays open (for `all`) for half an hour, the other lists for two hours, and the daily message's for the day; a 👍 on a song works for a month. (On Beeper and RCS for Business, where a 👍 can't reach the bot, a list comes as one numbered message instead, and you reply with a number.)

## Artists

Search for just an artist's name (`search shwekey`) to see their releases, newest first:

```text
🎵 🎤 Yaakov Shwekey · 37 releases, newest first
🎵 Elul · Aug 15
🎵 Happiness (EP) · album, 4 songs · May 24
🎵 From Galus To Geula · Sep 26, 2025
…
🎵 Tap 👍 on one to get it, or text "more" for the next ones.
```

- Whole names work with typos (`search avrohom fried`), and the name an artist goes by works on its own: a last name (`search shwekey`) or a first name (`search lipa` for Lipa Schmeltzer).
- Songs by several artists ("Mendy Weiss, Yoely Davidowitz & Yoely Samuel") count for each of them.
- An album is one entry ("album, 4 songs"). Picking it lists its songs; `all` on a list with an album sends the album's songs too.
- When a name fits several artists and none clearly has the most songs (`weiss`), it searches songs instead.

## Trending, new, more

| Text | List |
| --- | --- |
| `trending` (or `top`, `popular`, `hot`) | Releases from the last month with the most views for their age, so a new hit beats an older song with a few more views |
| `new` (or `latest`, `new music`) | The newest releases |
| `more` (or `next`) | The next ten of the last list |

```text
🎵 🔥 Trending on music-table.com
🎵 Yehuda Langer Ft. Shmaya Fischer & Hershy Weinberger — 2GETHER · album, 12 songs · Sep 29
🎵 TYH Nation — Little Bardichevers Upmix (Full Album) · album, 8 songs · Sep 30
🎵 Miami Boys Choir — Atoh Kail · Sep 22
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
🎵 Miami Boys Choir — Chanukah Nights! · Dec 7, 2025
🎵 Meilech Braunstein — Miracles · Dec 24, 2024
🎵 Mordechai Shapiro — Fire · Dec 14, 2025
…
```

The first time you ask for one it reads the whole category from the site (a few seconds); after that the list comes from your Mac, refreshed at most once a day.

**In season, the bot points you to them.** From 15 Kislev to 3 Tevet `trending`, `new` and the daily message carry a line like `🕎 Chanukah is here: text "chanukah" for Chanukah songs.`; the same for Purim (1 to 15 Adar). During Sefirah (16 Nisan to 5 Sivan) and the Three Weeks (17 Tamuz to 9 Av) the line points to `vocal`, and the daily message lists the new a cappella songs first, each marked "vocal". The dates come from the Jewish calendar built into your Mac.

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
🎵 Oizer Oberlander — Ana Elech · single
🎵 Yumi Lowy — Mi Adir · single
🎵 Hershey Eisenbach — Makdim Shalom · music video
🎵 Yoely Weiss — R' Chaim Zanvil Ben R' Moshe · single
🎵 Tap 👍 on a song to get it, or "search" for anything else.
```

- It sends names and pictures, **never the songs themselves**. Tap 👍 on a song's line to get it, or text `all` for every song (that works all day).
- The picture holds up to nine covers; every song gets its line either way.
- Posts that are only a video (no MP3) are listed at the end under "Also new, video only".
- A day with nothing new sends nothing.
- The first time it runs it waits for the next 09:00 rather than sending in the middle of the day. If your Mac was asleep at 09:00 it sends when it wakes, once.

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
  Tap 👍 on a song in a list to get it.
  ```

- A message that isn't a command gets the line to send instead:

  ```text
  🎵 To look for a song, start with "search":
  search lipa vnusni

  Text "help" for the other commands.
  ```

- The same request repeated word for word within 20 seconds is answered once. In a chat with yourself a phone can show a text twice, and this keeps the bot from answering both. (So `all` twice in a row sends the songs once.)
- As a safety net the bot stops after 30 messages in a minute.
- While it works it shows "typing…" in the chat. (The bridge passes it to Google Messages; whether a phone shows it in a chat with yourself depends on the phone.)
- A song that can't be sent (gone from the site, over the size limit) is named and explained, and the others still come.
- No buttons, cards or carousels: those are an RCS for Business feature, and the bridge carries only text, pictures and files. See [Other routes](other-routes.md#rcs-for-business-agent).
