# Using the bot

Everything happens in your chat with your own number in Google Messages. Every text the bot writes starts with 🎵, and because it writes as you, its messages look like ones you sent yourself.

## Asking for a song

Text the artist and the song, the way you'd say it:

```text
yoely weiss shabbos
```

You get two messages:

1. the song's **card**: its cover, with the title and artist drawn underneath
2. the MP3 itself, which plays in the chat

(The bridge can't put a caption on a picture, so the name is drawn on it. If a picture can't be made, you get the plain cover and the name as a line of text; a song without a cover comes with its name as text.)

- **Typos are fine.** `yoely wiess shabos`, `avrohom fried` (the site writes "Avraham"), `shlomo daskal` ("Shloime") and `mordechai ben dovid` all work. The bot learns the site's spelling from the titles around your other words.
- **Extra words are fine.** `play ...`, `send me ...` and `... by Yoely Weiss` are understood, and in a longer request one stray word (an `mp3` at the end, say) is forgiven.
- **A song it already knows by name comes back at once.** Naming one song exactly (artist and title) is answered from the catalog without searching the site, and songs it keeps ready on disk go out without waiting for a download. A song that has to be downloaded starts downloading while its card is being made.

## Lists

When several songs fit, it asks which one. Each option is **its own message**, so you can tap 👍 on the one you want:

```text
🎵 Which one?
🎵 1. Mendy Roth — Chuppah Medley
🎵 2. Shulem Lemmer & Beri Weber — Chuppah Medley
🎵 3. Shloime Daskal & The Freilach Band — Chuppah Medley
🎵 Reply with a number or 👍 one to choose.
```

Then any of:

| Reply | What happens |
| --- | --- |
| `2` | That song. The list stays open, so you can reply `3` next. |
| 👍 on an option | That song |
| `all` (or `send all`, `everything`) | Every song on the list, one after another: files only, no cards, up to 20 |
| `more` | The next ten, when there are more |
| A new song name | A new search; the old list closes |

A number that isn't on the list gets "Pick a number from 1 to 3". A "Which one?" list stays open for half an hour, the other lists for two hours, and the daily message's for the day. (On Beeper and RCS for Business, where a 👍 can't reach the bot, a list comes as one message instead.)

## Artists

Text just an artist's name to see their releases, newest first:

```text
🎵 🎤 Yaakov Shwekey · 37 releases, newest first
🎵 1. Elul · Aug 15
🎵 2. Happiness (EP) · album, 4 songs · May 24
🎵 3. From Galus To Geula · Sep 26, 2025
…
🎵 Reply with a number or 👍 one to get it, or "more" for the next ones.
```

- Whole names work with typos (`avrohom fried`), and the name an artist goes by works on its own: a last name (`shwekey`) or a first name (`lipa` for Lipa Schmeltzer).
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
🎵 1. Yehuda Langer Ft. Shmaya Fischer & Hershy Weinberger — 2GETHER · album, 12 songs · Sep 29
🎵 2. TYH Nation — Little Bardichevers Upmix (Full Album) · album, 8 songs · Sep 30
🎵 3. Miami Boys Choir — Atoh Kail · Sep 22
…
```

Numbers keep counting across pages (`more` shows 11 to 20, and 3 still means the third song).

## Holiday and other lists

| Text | List |
| --- | --- |
| `chanukah` (or `hanukkah`, `chanuka`) | 🕎 Chanukah songs |
| `purim` | 🎭 Purim songs |
| `wedding` (or `weddings`, `chasuna`, `simcha`, `dance`) | 💍 Weddings & events: live wedding sets and dance music |
| `vocal` (or `a cappella`, `acapella`, `sefirah`, `three weeks`) | 🎤 Vocal (a cappella) songs |

They're music-table.com's own categories, most popular first (by views), with the same numbers, 👍, `more` and `all` as any list:

```text
🎵 🕎 Chanukah · most popular first
🎵 1. Miami Boys Choir — Chanukah Nights! · Dec 7, 2025
🎵 2. Meilech Braunstein — Miracles · Dec 24, 2024
🎵 3. Mordechai Shapiro — Fire · Dec 14, 2025
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
🎵 Reply 1 or 👍 it to get it.
```

Like the daily message, it's the name and the picture, not the song: reply with the number (good for a day) or 👍 the card or the line. Several at once are numbered.

- **Quiet hours.** Nothing comes between 22:00 and 07:00 (see `QUIET_HOURS` in [Configuration](configuration.md)); what came out overnight is sent at 07:00, if it's under two days old.
- **Only what you don't have.** A song you already got (you texted for it first, or picked it from a list) isn't announced, and neither is anything that was out before you followed the artist.
- **The bot follows for you.** After you've had three different songs by an artist, it follows them and says so once, under the song: `🔔 You've had a few songs by Yoely Weiss, so I'll send you their new ones as soon as they're out. (Text "unfollow yoely weiss" to stop.)` After an unfollow it never does that for the same artist again. `following` marks these "(from your plays)".
- While you follow anyone, the bot looks at the site's RSS feed every 15 minutes (one small request) instead of only syncing every three hours. Following no one, it doesn't.

## The daily new-music message

At 09:00 each day (see `DIGEST_TIME` in [Configuration](configuration.md)) the bot sends what came out on music-table.com since the last one:

```text
🎵 New music · Monday, Oct 5
4 new songs on music-table.com
[one picture: the four covers in a grid, numbered 1 to 4, each with its name]
🎵 1. Oizer Oberlander — Ana Elech · single
🎵 2. Yumi Lowy — Mi Adir · single
🎵 3. Hershey Eisenbach — Makdim Shalom · music video
🎵 4. Yoely Weiss — R' Chaim Zanvil Ben R' Moshe · single
🎵 Reply with a number or 👍 a song to get it, or text me any name.
```

- It sends names and pictures, **never the songs themselves**. Reply with a number, `all`, or tap 👍 on a song's line to get it. The numbers work all day.
- The picture holds up to nine covers; every song gets its line either way.
- Posts that are only a video (no MP3) are listed at the end under "Also new, video only".
- A day with nothing new sends nothing.
- The first time it runs it waits for the next 09:00 rather than sending in the middle of the day. If your Mac was asleep at 09:00 it sends when it wakes, once.

To see today's message now: `npm run library -- digest` (shows it, sends nothing), or `npm run library -- digest --send` (sends it to your chat).

## 👍 to get a song

A thumbs up (any skin tone) on a message that stands for one song gets you that song: any option in a list, any song's line in the daily message, and a new-song alert's card or line. Other reactions, and a 👍 on anything else (like a song you just received, or a heading), are just reactions; the bot ignores them.

## Small things worth knowing

- `help`, `hi` or a single character gets the help text:

  ```text
  🎵 Text me a song or an artist and I'll send you the music.
  Also: "trending", "new", "chanukah", "purim", "wedding" or "vocal" for lists, "more" for the next ones, and "all" for every song on a list.
  "follow <artist>" sends their new songs as soon as they're out.
  Reply with a number or 👍 a song to pick it.
  ```

- The same request repeated word for word within 20 seconds is answered once. In a chat with yourself a phone can show a text twice, and this keeps the bot from answering both. (So `all` twice in a row sends the songs once.)
- As a safety net the bot stops after 30 messages in a minute.
- While it works it shows "typing…" in the chat. (The bridge passes it to Google Messages; whether a phone shows it in a chat with yourself depends on the phone.)
- A song that can't be sent (gone from the site, over the size limit) is named and explained, and the others still come.
- No buttons, cards or carousels: those are an RCS for Business feature, and the bridge carries only text, pictures and files. See [Other routes](other-routes.md#rcs-for-business-agent).
