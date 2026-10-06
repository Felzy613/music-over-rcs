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

A thumbs up (any skin tone) on a message that stands for one song gets you that song: any option in a list, and any song's line in the daily message. Other reactions, and a 👍 on anything else (like a song you just received, or a heading), are just reactions; the bot ignores them.

## Small things worth knowing

- `help`, `hi` or a single character gets the help text.
- The same request repeated word for word within 20 seconds is answered once. In a chat with yourself a phone can show a text twice, and this keeps the bot from answering both. (So `all` twice in a row sends the songs once.)
- As a safety net the bot stops after 30 messages in a minute.
- While it works it shows "typing…" in the chat. (The bridge passes it to Google Messages; whether a phone shows it in a chat with yourself depends on the phone.)
- A song that can't be sent (gone from the site, over the size limit) is named and explained, and the others still come.
- No buttons, cards or carousels: those are an RCS for Business feature, and the bridge carries only text, pictures and files. See [Other routes](other-routes.md#rcs-for-business-agent).
