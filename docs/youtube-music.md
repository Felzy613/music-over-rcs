# YouTube Music

When your catalog has no match, the bot looks on YouTube Music first, then on [music-table.com](music-table.md). It uses YouTube Music's own app API (InnerTube), the way the [Zemer](https://github.com/ZemerTeam/zemer-app) Android app does, which is built on [Metrolist](https://github.com/MetrolistGroup/Metrolist), and it filters what it finds with Zemer's own artist list, with female singers excluded. The code is `src/sources/youtube-music.ts` and `src/sources/zemer-whitelist.ts`.

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

A song is stored in the catalog as `https://music.youtube.com/watch?v=<id>`, never as a stream link: those expire and belong to the connection that asked, so a fresh one is asked for when the song is checked or sent (and reused for 30 minutes, so checking and then sending asks once). If the media server turns a link down, one new link is asked for before giving up.

## What it doesn't use

Zemer has three more ways to play a song (`WEB_REMIX`, `WEB_CREATOR`, `TVHTML5_SIMPLY`). They need a JavaScript player to decipher the links and a BotGuard PoToken to get past the first megabyte, which means a headless browser. They aren't here. Neither is Zemer's own search service (the bot searches YouTube Music directly and filters the results), nor its other content settings (videos, podcasts, kids' content).

## What you get

The file is the AAC audio exactly as YouTube serves it: a fragmented MP4 (`audio/mp4`, saved as `.m4a`). It plays on a Mac, and Google Messages should play it, but that hasn't been tried on a phone. Two things follow from it being fragmented:

- Songs kept on this Mac are stored as they arrived, **without the artist and title tags** inside the file (the tag writer, `src/library/mp4.ts`, deliberately refuses fragmented files). The artist and album folders and the file name still sort them.
- It is whatever YouTube Music has: no ID3 tags, no cover inside the file (the cover is sent as the picture before the song).

## Turning it off, and the order

- `YOUTUBE_MUSIC=off` stops all use of it (and of Zemer's list). Songs already in the catalog from YouTube Music then can't be sent.
- `SONG_SOURCES=music-table,youtube-music` asks music-table.com first. The default is `youtube-music,music-table`. Whichever is asked first answers if it finds anything; the other is only asked when it finds nothing or can't be reached. A song your catalog already has is sent from the catalog without asking either.

## It can break

This is an app API, not an official one, and YouTube changes it. The client versions in `src/sources/youtube-music.ts` are Zemer's; YouTube retires them one at a time (visionOS `0.1` stopped working on 2026-10-07 while `1.02` carried on). When every one is refused the bot says "YouTube Music wouldn't give me that song (YouTube Music answered HTTP 400)", and the fix is to copy the current `VISIONOS` versions from Zemer's `innertube/src/main/kotlin/com/metrolist/innertube/models/YouTubeClient.kt`. Nothing in the catalog is lost.

## Rights

These are YouTube Music's streams, fetched the way its app fetches them, which YouTube's terms don't allow outside its own apps. Whether you may keep or share the songs is between you and the rights holders; this project only fetches what you ask for, into your own chat.
