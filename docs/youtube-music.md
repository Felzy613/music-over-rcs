# YouTube Music

A `search` asks YouTube Music first, and looks on [music-table.com](music-table.md) (your catalog, then the site) only when YouTube Music has nothing that fits. It uses YouTube Music's own app API (InnerTube), the way the [Zemer](https://github.com/ZemerTeam/zemer-app) Android app does, which is built on [Metrolist](https://github.com/MetrolistGroup/Metrolist), and it filters what it finds with Zemer's own artist list, with female singers excluded. The code is `src/sources/youtube-music.ts` and `src/sources/zemer-whitelist.ts`.

## Searching it alone, and albums

- **`youtube` (or `yt`) and a song** asks YouTube Music only. `search` also asks YouTube Music first, but takes only songs that have **every** word you typed (an apostrophe or a small typo forgiven), because YouTube Music will always hand back its twenty nearest songs, and a near miss ("higale na" is not "Hava Nagila") should not hide the right song on music-table.com. `youtube` takes YouTube Music's answer as it is, in its order, with nothing to fall back on.
- **A `search` (and a `youtube`) mentions albums.** It asks YouTube Music's albums at the same time as the songs, so it adds no waiting. An album counts when every word you typed is in its title or artist and at least one is in its title (typing only an artist's name is not about any one album). Under the song it found it adds a line, "💿 Also an album: …", whose 👍 sends the zip. When no song has the name you typed but an album does, the album is the answer; and when the words name an album outright (its whole title) and the songs found only resemble them, the album wins over those songs (live example: "yu di kenst" used to send an unrelated song). If the album lookup fails, the search carries on without it.
- **`album` and a name** searches YouTube Music's albums (`search` with Zemer's album filter), keeps the ones by artists on the list, and opens the one you pick: the album page gives its artists, cover and every song in order (a long album's later pages are followed). Each song must pass the list on its own, with the album's artists standing in for a song that names none, as in Zemer. The songs that pass are kept in the catalog with their artists' ids, so each is checked again against the current list just before the zip is made.
- **The zip** is made by the runner (`src/runner.ts`) from the album's songs, downloaded a few at a time, and `src/library/zip.ts` (a small writer: files stored as they are, since audio doesn't compress, UTF-8 names so Hebrew titles survive). It is sent as an attachment (`m.file`), named `Artist - Album.zip`, with the songs inside as `01 Title.m4a`. Over `MAX_DOWNLOAD_MB` it is split into parts at song boundaries.
- **Not checked:** an album that comes in several pages on YouTube Music's side (more songs than one response holds; the largest album I tried, 29 songs, came in one) is followed by its continuation links, which is covered by tests but I haven't seen one live. The zip as an attachment through the Google Messages bridge hasn't been tried on a phone either.

## Zemer's artist list

Nothing from YouTube Music reaches the chat unless it passes Zemer's artist whitelist, the list that makes Zemer a "kosher" client. The bot reads it the way the app does, from Zemer's public content mirror (`content.zemer.io`, no sign-in): `/whitelist` (the artists, each flagged female or not, keyed by YouTube channel id), `/whitelist/version` (a number that changes when the list does) and `/blockedContentIds` (single songs to hide even when their artist is listed). Today that's about 1,700 artists and 100 blocked songs.

**What passes:** a song is sent only if at least one of its credited artists is on the list, **none** of its credited artists is flagged female (a duet with a woman is out, even beside a listed man), and its id isn't on the blocked list. This is Zemer's own filter with "allow female singers" off, which is its default, plus the rule about duets. There is no setting to turn it off; `YOUTUBE_MUSIC=off` turns YouTube Music off altogether.

**It stays up to date, because the list changes through the day as music comes out:**
- Before every search the bot checks the list is no more than 5 minutes old; if it is, it asks the server (a request of about 100 bytes, waiting at most 2 seconds) and downloads the whole list only when the version number changed. The blocked songs are re-read at every check.
- While the bot runs it also checks every 10 minutes whether or not anyone searches. If the list can't be updated for a day, the Mac shows a notification, and the last good list stays in use meanwhile.
- A song is checked again against the current list **when it is sent**, not only when it was found. So a song found yesterday stops being sent the moment its singer is flagged or the song is blocked, and a stored song with no recorded artists isn't sent at all.
- The list is kept in the catalog, so after a restart with no internet the bot still filters. With no list at all (the first run, offline) YouTube Music gives no answer, as in Zemer, and the next source is asked.

**What it doesn't cover:** only YouTube Music songs are filtered. Songs from music-table.com have no artist ids to check, so they come as they always did. The list is matched by channel id, as Zemer does; when a listed artist has a second YouTube channel that isn't on the list, a few of their songs are held back (about one listed artist in twenty, in a sample). A song lists the artists YouTube credits, so a woman who isn't credited can't be caught; Zemer's blocked list is what covers those.

## What it uses

| For | What it does |
| --- | --- |
| Searching | `POST /youtubei/v1/search` as the `WEB_REMIX` client with Zemer's songs filter, so only songs come back: title, artists, album, length and a cover. No session id is sent with a search (Zemer found a stale one makes YouTube answer with nothing). |
| A session | `POST /youtubei/v1/visitor_id`, once. The player refuses to answer ("confirm you're not a bot") without one; a refused one is replaced once. |
| Playing a song | `POST /youtubei/v1/player` as the `VISIONOS` client, version 1.02, then 1.03 and 1.01 if that one has been retired. This is the first fallback Zemer tries: its audio links come ready to use, with no signature to solve and no PoToken to mint. The best AAC stream is taken (itag 140, 128 kbps), never an Opus one, because Google Messages plays AAC. |
| The file | A plain download from YouTube's media servers (`*.googlevideo.com`, https only), sent with the client's own User-Agent and `Range: bytes=0-`, which those servers insist on. |

**Dead links, and the 403.** The media server serves the first megabyte of any link, but about one link in fifteen (measured October 2026) is "walled": it answers 403 to any request that reaches further, which is every whole-song download. Those links want a token this client can't make. So before a link is used, `YouTubeMusic` makes the very request the download will make (`Range: bytes=0-`), reads only its status and drops the body; a 403 means that link is discarded and a new one is asked for, from the next client version, then from a fresh session, up to nine tries. Songs of a megabyte or less are inside the free part and are not checked. Zemer does the same (it validates each stream and falls through to the next client). Only when every try is refused does the chat hear "YouTube Music wouldn't give me that song (its link was refused)".

A song is stored in the catalog as `https://music.youtube.com/watch?v=<id>`, never as a stream link: those expire and belong to the connection that asked, so a fresh one is asked for when the song is checked or sent (and reused for 30 minutes, so checking and then sending asks once). If the media server turns a link down, one new link is asked for before giving up.

## What it doesn't use

Zemer has three more ways to play a song (`WEB_REMIX`, `WEB_CREATOR`, `TVHTML5_SIMPLY`). They need a JavaScript player to decipher the links and a BotGuard PoToken to get past the first megabyte, which means a headless browser. They aren't here. Neither is Zemer's own search service (the bot searches YouTube Music directly and filters the results), nor its other content settings (videos, podcasts, kids' content).

## What you get

The file is the AAC audio exactly as YouTube serves it: a fragmented MP4 (`audio/mp4`, saved as `.m4a`). It plays on a Mac, and Google Messages should play it, but that hasn't been tried on a phone. Two things follow from it being fragmented:

- Songs kept on this Mac are stored as they arrived, **without the artist and title tags** inside the file (the tag writer, `src/library/mp4.ts`, deliberately refuses fragmented files). The artist and album folders and the file name still sort them.
- It is whatever YouTube Music has: no ID3 tags, no cover inside the file (the cover is sent as the picture before the song).

## Turning it off, and the order

- `YOUTUBE_MUSIC=off` stops all use of it (and of Zemer's list). Songs already in the catalog from YouTube Music then can't be sent.
- `SONG_SOURCES=music-table,youtube-music` asks music-table.com first. The default is `youtube-music,music-table`. YouTube Music, when it is first, is asked before the catalog. Whichever is asked first answers if it finds anything that fits; the other (and, after YouTube Music, your catalog) is only used when it finds nothing, or can't be reached. With music-table.com first, your catalog is looked in before YouTube Music is asked.

## It can break

This is an app API, not an official one, and YouTube changes it. The client versions in `src/sources/youtube-music.ts` are Zemer's; YouTube retires them one at a time (visionOS `0.1` stopped working on 2026-10-07 while `1.02` carried on). When every one is refused the bot says "YouTube Music wouldn't give me that song (YouTube Music answered HTTP 400)", and the fix is to copy the current `VISIONOS` versions from Zemer's `innertube/src/main/kotlin/com/metrolist/innertube/models/YouTubeClient.kt`. Nothing in the catalog is lost.

## Rights

These are YouTube Music's streams, fetched the way its app fetches them, which YouTube's terms don't allow outside its own apps. Whether you may keep or share the songs is between you and the rights holders; this project only fetches what you ask for, into your own chat.
