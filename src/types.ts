export interface Track {
  id: number;
  title: string;
  artist: string;
  url: string;
  /** A picture to show with the song (album or single art), when there is one. */
  cover?: string;
}

/** A tappable suggestion under a message. `label` is capped at 25 characters by RCS. */
export interface Chip {
  label: string;
  postback: string;
}

/**
 * Something the bot sends. Audio's `title` is a display name, used to name the file when a transport has to attach it.
 * An image is a picture to show (album art); transports that can't show pictures leave it out. A text or picture with
 * a `postback` stands for one song: a 👍 on it gets that song. A text's chips are the list it closes, for
 * `chipsValidMs` (30 minutes unless given): the songs "all" sends, and, in chats where a 👍 can't reach the bot,
 * what each number picks (the songs are numbered there; see joinLists). An image's caption is the song's name, drawn
 * under the cover where pictures can be drawn and sent as text otherwise. A collage is several covers in one picture,
 * each with its song's name, and its number where the list is numbered.
 */
export type Reply =
  | { kind: 'text'; text: string; chips?: Chip[]; chipsValidMs?: number; postback?: string }
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
