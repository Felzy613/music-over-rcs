# music-table.com

[music-table.com](https://www.music-table.com) is a site of Jewish music releases. Each release page can offer its MP3s for download (a single, or every track of an album), next to an embedded video. The bot uses those MP3s, and only those. In October 2026 the site was rebuilt (it had been a Wix blog); the addresses of the releases stayed the same, so the songs already in the catalog still work.

## What it uses, and what it doesn't

- **Only the MP3 files a release offers for free download**, the same ones its Download button gives you. Releases the site sells are left alone: they aren't offered as songs, and their files are never asked for. The YouTube videos on the pages are ignored. Nothing in this source downloads from YouTube; [YouTube Music](youtube-music.md) is a separate source.
- **A song is stored as a link to its release** (`…/post/<name>#<n>`, the nth file), not the audio and not the download address. The site's download links expire within minutes, so a fresh one is asked for when the song is sent.
- **Rights.** These are files the site offers for download. Whether you may keep or share them is between you and the rights holders; this project only fetches what you ask for, into your own chat.

## How it talks to the site

The bot uses the same public addresses the site's own pages use, identifying itself as this project in its User-Agent. No account or session is needed.

| For | Request |
| --- | --- |
| Searching | `GET /api/suggest?q=…`, the answer behind the site's search box (a small JSON request; it also corrects spelling). The search page, `/search?q=…`, is used only when that fails or knows none of your words. |
| Reading a release | `GET /post/<name>`: the page carries its files (name, size), picture, date, views and whether it's for sale, as data for its scripts |
| Lists and the sync | `GET /new-music?all=1&page=N` (48 releases a page, newest first, each with its categories, views, date and picture), with `&category=chanukah` or `&sort=views` for the holiday and popular lists |
| Checking for new releases | The RSS feed, `/feed.xml`, while you follow anyone |
| A song's file | `POST /api/downloads` with the release and the file's place, as the Download button does; the answer is a link on the site that redirects to the file in the site's storage for a few minutes |
| Album art | The release's picture, from the site |

**How it behaves toward the site:** about ten requests a second at most, in short bursts; searches remembered for 10 minutes, releases for 5, download links for a minute; the background sync is one list page every three hours, plus one page for each release it hasn't seen yet; the one-time full scan pauses between pages; songs kept ready are downloaded one at a time with a pause between them. A typical request costs one search and a few release reads, or nothing at all when the catalog already has the song.

**It can break, and it has.** These are the site's own page addresses, not an official interface; the October 2026 rebuild replaced every one the bot used. If the site changes again, lookups fail with a message saying so ("the site may have changed"), the sync logs it and an alert says music-table.com isn't answering, and everything already in the catalog keeps working until it's fixed. `npm run music-table -- search <words>` shows what the site returns right now.

## How a request is matched

(This is the order for music-table.com on its own. With YouTube Music on, which is first by default, a `search` asks YouTube Music before any of this, and gets here when YouTube Music has nothing that fits.)

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
