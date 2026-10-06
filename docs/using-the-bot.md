# Using the bot

Everything happens in your chat with your own number in Google Messages. Every message the bot writes starts with 🎵, and because it writes as you, its messages look like ones you sent yourself.

## Asking for a song

Text the artist and the song, the way you'd say it:

```text
yoely weiss shabbos
```

You get three messages:

1. the album art
2. `🎵 Yoely Weiss — Shabbos`
3. the MP3 itself, which plays in the chat

(The bridge can't put a caption on a picture, so the art and the name are separate messages.)

- **Typos are fine.** `yoely wiess shabos`, `avrohom fried` (the site writes "Avraham"), `shlomo daskal` ("Shloime") and `mordechai ben dovid` all work. The bot learns the site's spelling from the titles around your other words.
- **Extra words are fine.** `play ...`, `send me ...` and `... by Yoely Weiss` are understood, and in a longer request one stray word (an `mp3` at the end, say) is forgiven.
- **A song it already knows by name comes back at once.** Naming one song exactly (artist and title) is answered from the catalog without searching the site, and songs it keeps ready on disk go out without waiting for a download.

When several songs fit, it asks which one:

```text
🎵 Which one?
1. Mendy Roth — Chuppah Medley
2. Shulem Lemmer & Beri Weber — Chuppah Medley
3. Shloime Daskal & The Freilach Band — Chuppah Medley

Reply with a number to choose.
```

Reply with `2`. The list stays good for half an hour, so you can then reply `3` too. A new song name ends it. A number that isn't on the list gets "Pick a number from 1 to 3".

## Artists

Text just an artist's name to see their releases, newest first:

```text
shwekey
```

```text
🎵 🎤 Yaakov Shwekey · 37 releases, newest first
1. Elul · Aug 15
2. Happiness (EP) · album, 4 songs · May 24
3. From Galus To Geula · Sep 26, 2025
…

Reply with a number to get it, or "more" for the next ones.
```

- Whole names work with typos (`avrohom fried`), and the name an artist goes by works on its own: a last name (`shwekey`) or a first name (`lipa` for Lipa Schmeltzer).
- Songs by several artists ("Mendy Weiss, Yoely Davidowitz & Yoely Samuel") count for each of them.
- An album is one entry ("album, 4 songs"). Picking it lists its songs, and you pick one of those.
- When a name fits several artists and none clearly has the most songs (`weiss`), it searches songs instead.

## Lists: trending, new, more

| Text | List |
| --- | --- |
| `trending` (or `top`, `popular`, `hot`) | Releases from the last month with the most views for their age, so a new hit beats an older song with a few more views |
| `new` (or `latest`, `new music`) | The newest releases |
| `more` (or `next`) | The next ten of the last list |

```text
🎵 🔥 Trending on music-table.com
1. Yehuda Langer Ft. Shmaya Fischer & Hershy Weinberger — 2GETHER · album, 12 songs · Sep 29
2. TYH Nation — Little Bardichevers Upmix (Full Album) · album, 8 songs · Sep 30
3. Miami Boys Choir — Atoh Kail · Sep 22
…
```

Numbers keep counting across pages (`more` shows 11 to 20, and 3 still means the third song), and a list stays pickable for two hours.

## The daily new-music message

At 09:00 each day (see `DIGEST_TIME` in [Configuration](configuration.md)) the bot sends what came out on music-table.com since the last one:

```text
🎵 New music · Monday, Oct 5
3 new songs on music-table.com
[album art]
🎵 1. Oizer Oberlander — Ana Elech · single
[album art]
🎵 2. Yumi Lowy — Mi Adir · single
[album art]
🎵 3. Hershey Eisenbach — Makdim Shalom · music video
🎵 Reply with a number or 👍 a song to get it, or text me any name.
```

- It sends names and pictures, **never the songs themselves**. Reply with a number, or tap 👍 on a song's picture or line, to get that one. The numbers work all day.
- Posts that are only a video (no MP3) are listed at the end under "Also new, video only".
- A day with nothing new sends nothing.
- The first time it runs it waits for the next 09:00 rather than sending in the middle of the day. If your Mac was asleep at 09:00 it sends when it wakes, once.

To see today's message now: `npm run library -- digest` (shows it, sends nothing), or `npm run library -- digest --send` (sends it to your chat).

## 👍 to get a song

A thumbs up (any skin tone) on a message that stands for one song gets you that song. Today that's each song in the daily message: its picture or its numbered line. Other reactions, and a 👍 on anything else (like a song you just received), are just reactions; the bot ignores them.

## Small things worth knowing

- `help`, `hi` or a single character gets the help text.
- The same request repeated word for word within 20 seconds is answered once. In a chat with yourself a phone can show a text twice, and this keeps the bot from answering both.
- As a safety net the bot stops after 30 messages in a minute.
- While it works it shows "typing…" in the chat. (The bridge passes it to Google Messages; whether a phone shows it in a chat with yourself depends on the phone.)
- A song that can't be sent (gone from the site, over the size limit) is explained instead of sent.
