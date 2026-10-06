import { EventEmitter } from 'node:events';
import type { DownloadedAudio } from '../audio-fetch.ts';
import type { DownloadedImage } from '../image-fetch.ts';
import type { ChatClient, ChatMessage } from '../runner.ts';

export interface SimMessage {
  id: number;
  from: 'me' | 'bot';
  /** Epoch milliseconds. */
  at: number;
  text?: string;
  audio?: { name: string; mime: string; bytes: number; linkId: string | undefined };
  /** A picture (album art), shown from where it lives. */
  image?: { url: string };
}

/**
 * A stand-in for a chat on a phone: what you "type" is handed to the real runner the way the Matrix and Beeper
 * chats hand it messages, and what the runner sends is kept as a transcript for the page to show.
 * Events: 'message' (a SimMessage), 'typing' (a boolean) and 'picked' (the runner took a request).
 */
export class SimulatedChat implements ChatClient {
  readonly messages: SimMessage[] = [];
  readonly events = new EventEmitter();
  typing = false;
  /** Shown as the phone shows it: lists one entry per message. */
  readonly reactions = true;
  /** The play link to attach to the next audio message; set by whoever prepared the file. */
  nextAudioLink: string | undefined;
  #inbox: ChatMessage[] = [];
  #seq = 0;
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** The user types a message. */
  say(text: string): SimMessage {
    this.#seq += 1;
    const message: SimMessage = { id: this.#seq, from: 'me', at: this.#now(), text };
    this.messages.push(message);
    this.#inbox.push({ id: `sim-${this.#seq}`, timestamp: new Date(message.at).toISOString(), text, hasAttachments: false, isDeleted: false });
    this.events.emit('message', message);
    return message;
  }

  async listMessages(): Promise<ChatMessage[]> {
    const fresh = this.#inbox;
    this.#inbox = [];
    return fresh;
  }

  async sendText(_chatID: string, text: string): Promise<void> {
    this.#push({ from: 'bot', text });
  }

  async sendAudio(_chatID: string, audio: DownloadedAudio): Promise<void> {
    const link = this.nextAudioLink;
    this.nextAudioLink = undefined;
    this.#push({ from: 'bot', audio: { name: audio.fileName, mime: audio.mimeType, bytes: audio.bytes, linkId: link } });
  }

  async sendImage(_chatID: string, image: DownloadedImage): Promise<void> {
    this.#push({ from: 'bot', image: { url: image.sourceUrl } });
  }

  async setTyping(_chatID: string, typing: boolean): Promise<void> {
    if (this.typing === typing) return;
    this.typing = typing;
    this.events.emit('typing', typing);
  }

  #push(parts: Pick<SimMessage, 'from' | 'text' | 'audio' | 'image'>): void {
    this.#seq += 1;
    const message: SimMessage = { id: this.#seq, at: this.#now(), ...parts };
    this.messages.push(message);
    this.events.emit('message', message);
  }
}
