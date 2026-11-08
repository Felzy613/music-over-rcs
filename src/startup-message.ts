import { OWNER, scoped, type Person } from './people.ts';
import type { Reply } from './types.ts';

/** off: never; once: the first time this catalog starts a bot, and never again; always: at every start. */
export type StartupMode = 'off' | 'once' | 'always';

export const STARTUP_SENT_KEY = 'hello.sent';

export const STARTUP_TEXT = `I'm running in the cloud now, so I keep working when your Mac's internet drops. Text "search" and a song name and I'll send it.`;

/** What anyone besides the owner is told the first time their chat is up: the owner's words are about the owner's Mac, so these are plain. */
export const PERSON_STARTUP_TEXT = `Hi, I'm Music over RCS. Text "search" and a song name and I'll send it. Text "help" for the other commands.`;

/** The state key that remembers a person was told: the owner's is the one it has always been, anyone else's has their id in it. */
export const startupKey = (person: Person = OWNER): string => scoped(STARTUP_SENT_KEY, person);

/** The hello for a person: the owner's own words, plain ones for anyone else. */
export const startupText = (person: Person = OWNER): string => (person.owner ? STARTUP_TEXT : PERSON_STARTUP_TEXT);

/** STARTUP_MESSAGE=off|once|always. Without it: off (the cloud host sets it to once). */
export function startupModeFrom(env: NodeJS.ProcessEnv = process.env): StartupMode {
  const raw = env.STARTUP_MESSAGE?.trim().toLowerCase();
  if (!raw) return 'off';
  if (raw === 'off' || raw === 'once' || raw === 'always') return raw;
  throw new Error(`STARTUP_MESSAGE must be off, once or always (got "${env.STARTUP_MESSAGE}")`);
}

export interface StartupMessageOptions {
  mode: StartupMode;
  state: { getState(key: string): string | undefined; setState(key: string, value: string): void };
  /** Whether a message sent now would reach Google Messages: the chat accepts one even when the bridge can't pass it on, and it would be lost. */
  ready: () => Promise<boolean>;
  send: (replies: Reply[]) => Promise<void>;
  text?: string;
  /** The state key that remembers the hello was sent (`hello.sent`, the owner's; a person's has their id in it, see `startupKey`). */
  key?: string;
  /** Tries before giving up (the next start tries again for `once`), and the wait between them. */
  attempts?: number;
  everyMs?: number;
  sleep?: (ms: number) => Promise<void>;
  stopped?: () => boolean;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Says hello in the chat when the bot is up and the bridge can deliver. True when it was sent. */
export async function sendStartupMessage(options: StartupMessageOptions): Promise<boolean> {
  const { mode, state, ready, send, log } = options;
  if (mode === 'off') return false;
  const key = options.key ?? STARTUP_SENT_KEY;
  if (mode === 'once' && state.getState(key)) return false;
  const attempts = options.attempts ?? 20;
  const everyMs = options.everyMs ?? 30_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref()));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.stopped?.()) return false;
    try {
      if (await ready()) {
        await send([{ kind: 'text', text: options.text ?? STARTUP_TEXT }]);
        state.setState(key, (options.now?.() ?? new Date()).toISOString());
        log?.('sent the startup message');
        return true;
      }
    } catch (err) {
      log?.(`startup message: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (attempt < attempts) await sleep(everyMs);
  }
  log?.(`startup message: not sent after ${attempts} tries (the bridge never became ready)`);
  return false;
}
