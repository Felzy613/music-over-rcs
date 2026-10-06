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
 * An image is a picture to show (album art); transports that can't show pictures leave it out. A text's chips make
 * its numbered options pickable by number, for `chipsValidMs` (30 minutes unless given). A text or picture with a
 * `postback` stands for one song: a 👍 on it gets that song.
 */
export type Reply =
  | { kind: 'text'; text: string; chips?: Chip[]; chipsValidMs?: number; postback?: string }
  | { kind: 'image'; url: string; postback?: string }
  | { kind: 'audio'; url: string; title?: string };

/** A message from the user, independent of the transport it arrived on. */
export interface Incoming {
  from: string;
  messageId: string;
  text?: string;
  postback?: string;
}
