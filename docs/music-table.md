# music-table.com

[music-table.com](https://www.music-table.com) is a Jewish music blog. Each release post can carry a "Download MP3" file that the site hosts itself, next to an embedded video. The bot uses those MP3s, and only those.

## What it uses, and what it doesn't

- **Only the MP3 files a post offers for download**, the same ones its Download button gives you. The YouTube videos in the posts are ignored, and the site's artist pages (galleries of YouTube videos) aren't used. Nothing here downloads from YouTube or any streaming site.
- **A song is stored as a link to its post**, not the audio and not the download address. The site's download links expire, so a fresh one is asked for when the song is sent.
- **Rights.** These are files the site offers for download. Whether you may keep or share them is between you and the rights holders; this project only fetches what you ask for, into your own chat.

## How it talks to the site

The site is a Wix blog. The bot uses the same public endpoints the site's own pages use, with a visitor session like any browser's, identifying itself as this project in its User-Agent:

| For | Request |
| --- | --- |
| A visitor session | `GET /_api/v1/access-tokens` (reused for 20 minutes) |
| Searching | The quick search behind the site's search box (a small JSON request, about 0.1 s). The full search page (about 2.4 s, 1.8 MB) is used only when the quick search knows none of your words. |
| Reading posts | `GET /_api/communities-blog-node-api/_api/posts/<post>` for one post, or the post list for 50 at a time (files, album art, views and dates included) |
| Category names | The RSS feed, `/blog-feed.xml` |
| A song's file | `POST .../v2/files/download-url` for a time-limited link, then the file from the site's file host |
| Album art | The post's picture from the site's image host, resized to 640×360 (about 40 KB) |

**How it behaves toward the site:** about ten requests a second at most, in short bursts; searches remembered for 10 minutes, posts for 5, download links for a minute; the background sync is two requests every three hours; the one-time full scan pauses between pages; songs kept ready are downloaded one at a time with a pause between them. A typical request costs one search and a few post reads, or nothing at all when the catalog already has the song.

**It can break.** These are the site's own page APIs, not an official interface. If the site changes, lookups fail with a message saying so ("the site may have changed"), and everything already in the catalog keeps working. `npm run music-table -- search <words>` shows what the site returns right now.

## How a request is matched

1. **Your catalog first.** A request that names exactly one song it has (its whole title, alone or with some or all of the artist's name before or after it) is answered from the catalog at once. A request that's just an artist's name lists their releases. When no song in the catalog has every word as typed, the catalog looks again more loosely: apostrophes and hyphens left out or put in (`vnusni` for "V’Nusni", `yomtov` for "Yom Tov"), a letter or two off in a longer word (`shmeltzer` for "Schmeltzer"), and one word missing from a request of three or more. This matters because the site's own search can't find such songs at all: it finds nothing for `vnusni`, or even `nusni`.
2. **Then the site, merged with the catalog.** Anything broader is also searched on the site, and the results are merged, so songs the catalog doesn't have yet are offered too.
3. **Only posts that fit the whole request.** The site's search lists anything matching one word, so the bot keeps the posts whose titles have all your words (typos allowed), exact titles first. A request of three or more words may miss one word.
4. **Spelling.** The quick search is strict about spelling, so when no title has all your words the bot:
   - tries the request with each word left out (three or more words), which survives a typo or a stray word;
   - fixes a word from the titles it has already seen (`dovid` next to "Mordechai Ben David");
   - looks the other words up alone and takes the site's spelling from the titles around them: `avrohom fried` becomes "avraham fried" (two letters off, but "fried" brings up "Avraham Fried"), `shlomo daskal` becomes "shloime daskal";
   - looks up the beginning of a word, for a typo near its end (`shabos`);
   - only when it knows none of your words, asks the slow search page, which forgives typos.

   A correction is used only when the corrected search really matches, and only when one spelling clearly wins.

5. **Up to five posts are read**, at the same time, for the songs in them.

Everything found is added to the catalog, so asking again is answered locally.

## Trying it by hand

```bash
npm run music-table -- search yoely weiss                           # what the bot would find, with each post's files
npm run music-table -- check https://www.music-table.com/post/<name>   # resolve one download link; checks type and size
```

Neither downloads any audio. `MUSIC_TABLE=off` in `.env` turns the site off entirely.
