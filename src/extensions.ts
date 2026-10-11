import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Assistant } from './bot.ts';
import type { Picture, PreparedPicture } from './library/images.ts';
import type { IncomingPicture } from './runner.ts';
import type { Reply } from './types.ts';

// Add-ons kept outside this repository. Each is a folder in extensions/ (which git ignores) whose index.ts
// default-exports a function that sets it up; `npm run stack -- sync-bot` copies them along with the bot. The bridge
// route (matrix-main.ts) loads them.

/** What an add-on can use from the bot when it's set up. */
export interface ExtensionContext {
  /** Small values kept across restarts (the catalog's state table). Use keys of your own. */
  state: { getState(key: string): string | undefined; setState(key: string, value: string): void };
  /** Says what's wrong on the Mac (a notification), and when it's fixed. */
  health: { problem(key: string, message: string): void; ok(key: string, fixed?: string): void };
  env: NodeJS.ProcessEnv;
  log(line: string): void;
  /** Downloads a file posted in the chat: a picture sent from the phone (its `url`). */
  download(url: string): Promise<Uint8Array>;
}

/** What an add-on can do in the chat once the bot is running. */
export interface ExtensionChat {
  /** Sends messages the way the bot's announcements go: in order, and never in the middle of an answer. */
  announce(replies: Reply[]): Promise<void>;
  /** Sends one text now and returns its id (to put a reaction on it later). Start it with RELAY_MARK so the bot ignores it. */
  post(text: string): Promise<string | undefined>;
  /** Puts a reaction on a chat message; returns the reaction's id, which `unreact` takes back. */
  react(messageId: string, key: string): Promise<string | undefined>;
  unreact(reactionId: string): Promise<void>;
}

export interface Extension {
  name: string;
  /** How it describes itself in the bot's startup line. */
  summary?: string;
  /** Messages that start with its word go to it instead of the music bot. */
  assistant?: Assistant;
  /** Gets each picture sent from the phone. */
  onPicture?(picture: IncomingPicture): void;
  /** Wraps how pictures are got ready to send, for pictures of its own. */
  pictures?(prepare: (picture: Picture) => Promise<PreparedPicture>): (picture: Picture) => Promise<PreparedPicture>;
  start?(chat: ExtensionChat): void;
  stop?(): Promise<void>;
}

/** An add-on's index.ts default-exports one of these. Returning nothing leaves it off (not set up in .env, say). */
export type ExtensionSetup = (context: ExtensionContext) => Extension | undefined | Promise<Extension | undefined>;

export const EXTENSIONS_DIR = resolve('extensions');

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Sets up every add-on in `dir`. One that fails is said on the Mac and left out; it never stops the bot. */
export async function loadExtensions(context: ExtensionContext, dir = EXTENSIONS_DIR): Promise<Extension[]> {
  if (!existsSync(dir)) return [];
  const loaded: Extension[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const index = join(dir, entry.name, 'index.ts');
    if (!entry.isDirectory() || !existsSync(index)) continue;
    try {
      const module = (await import(pathToFileURL(index).href)) as { default?: unknown };
      if (typeof module.default !== 'function') throw new Error('its index.ts has no default export');
      const extension = await (module.default as ExtensionSetup)(context);
      if (extension) loaded.push(extension);
    } catch (err) {
      context.health.problem(`extension:${entry.name}`, `The add-on "${entry.name}" didn't start: ${errorText(err)}`);
    }
  }
  return loaded;
}

/** Starts the add-ons once the bot is running. One that throws is said on the Mac; the others and the bot go on. */
export function startExtensions(extensions: Extension[], chat: ExtensionChat, health: ExtensionContext['health']): void {
  for (const extension of extensions) {
    try {
      extension.start?.(chat);
    } catch (err) {
      health.problem(`extension:${extension.name}`, `The add-on "${extension.name}" didn't start: ${errorText(err)}`);
    }
  }
}

/** Stops the add-ons when the bot stops; one that fails is logged and the rest still stop. */
export async function stopExtensions(extensions: Extension[], log: (line: string) => void): Promise<void> {
  for (const extension of extensions) {
    try {
      await extension.stop?.();
    } catch (err) {
      log(`the add-on "${extension.name}" didn't stop cleanly: ${errorText(err)}`);
    }
  }
}
