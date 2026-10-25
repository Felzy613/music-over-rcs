export interface Track {
  id: number;
  title: string;
  artist: string;
  url: string;
  /** A picture to show with the song (album or single art), when there is one. */
  cover?: string;
}

/** One song of an album: its place on the album, its name, and where to get it (an address `fetchAudio` understands). */
export interface AlbumSong {
  number: number;
  title: string;
  url: string;
}

/** A tappable suggestion under a message. `label` is capped at 25 characters by RCS. */
export interface Chip {
  label: string;
  postback: string;
}

/** A number shown in a list where a 👍 picks the rest, and what texting it picks (an album's number opens its songs). */
export interface NumberedChoice {
  number: number;
  postback: string;
}

/**
 * Something the bot sends. Audio's `title` is a display name, used to name the file when a transport has to attach it.
 * An image is a picture to show (album art); transports that can't show pictures leave it out. A text or picture with
 * a `postback` stands for one song: a 👍 on it gets that song. An album is sent as one ZIP of its songs, in album
 * order (or, where a chat can't take a file like that, as the songs one by one); the runner downloads and packs them. A text's chips are the list it closes, for
 * `chipsValidMs` (30 minutes unless given): the songs "all" sends, and, in chats where a 👍 can't reach the bot,
 * what each number picks (the songs are numbered there; see joinLists). An image's caption is the song's name, drawn
 * under the cover where pictures can be drawn and sent as text otherwise. A collage is several covers in one picture,
 * each with its song's name, and its number where the list is numbered. Where a 👍 picks, a few lines of a list carry
 * a `number` (the albums in a list, the songs of an album), shown before the line, and the text that closes the list
 * says what each number picks (`numbers`): texting one picks it. Elsewhere every line is numbered from the chips instead,
 * and the closing text is `numbered` when it says something else there ("reply with a number to pick one"). A reply with
 * chips and no words only changes what a number or "all" picks (a 👍 that went back to an earlier menu).
 */
export type Reply =
  | { kind: 'text'; text: string; chips?: Chip[]; chipsValidMs?: number; postback?: string; number?: number; numbers?: NumberedChoice[]; numbered?: string }
  | { kind: 'album'; title: string; artist: string; songs: AlbumSong[] }
  | { kind: 'image'; url: string; caption?: { title: string; artist: string }; postback?: string }
  | { kind: 'collage'; images: Array<{ url: string; label: string; postback: string; number?: number }> }
  | { kind: 'audio'; url: string; title?: string };

/** A message from the user, independent of the transport it arrived on. */
export interface Incoming {
  from: string;
  messageId: string;
  text?: string;
  postback?: string;
}
