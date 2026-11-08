import { format } from 'node:util';
import { parsePeoplePasswords } from '../people.ts';

// A small, bounded memory of what the bot has logged lately, for the admin console: Render's own logs are not reachable from
// the app, and the host's disk is wiped, so the last few hundred lines are kept in memory and nowhere else. Nothing here is
// written to a database or a file. Secrets are masked before a line is kept: the values of the settings that are secrets
// (named like TOKEN, SECRET, KEY or PASSWORD) wherever they appear, and the usual shapes of a credential in a line.

export interface LogLine {
  /** Unix ms. */
  at: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

const MAX_LINE_CHARS = 2000;
const MASK = '‹hidden›';
/** Settings whose value must never be shown. A short value (a flag, a port) is not a secret and is left alone. */
const SECRET_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|(?:^|_)KEY(?:_|$)|ACCESS_KEY|_URL$)/i;
const MIN_SECRET_CHARS = 6;

/** The values worth masking in `env`: every setting named like a secret, plus the URLs that carry a token or a key. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    const text = value?.trim();
    if (!text || text.length < MIN_SECRET_CHARS || !SECRET_NAME.test(name)) continue;
    // A URL setting is only secret when it carries something: a user, a password, a key or a token in it.
    if (/_URL$/i.test(name) && !/[@?]|token|key|secret/i.test(text)) continue;
    values.add(text);
    // PEOPLE_PASSWORDS is `name:password` pairs: a line that has only one person's password in it is masked as well.
    if (name === 'PEOPLE_PASSWORDS') for (const password of parsePeoplePasswords(text).values()) values.add(password);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Masks credentials in a line: known secret values first, then the shapes a credential has (bearer tokens, `key=value` pairs, a password in a URL). */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
  for (const secret of secrets) if (secret && out.includes(secret)) out = out.split(secret).join(MASK);
  return out
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`)
    .replace(/\b(access_token|refresh_token|id_token|token|password|passwd|secret|api[_-]?key|authorization)=([^\s&"']{4,})/gi, `$1=${MASK}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(/\b(syt_[A-Za-z0-9_-]{10,}|ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, MASK);
}

export interface LogRingOptions {
  /** How many lines are kept (default 500). */
  size?: number;
  /** Secrets to mask: a function, so a setting changed later is still covered. */
  secrets?: () => readonly string[];
  now?: () => number;
}

/** The last lines the bot logged, oldest first, masked. */
export class LogRing {
  #lines: LogLine[] = [];
  #size: number;
  #secrets: () => readonly string[];
  #now: () => number;
  /** How many lines have ever been added, so a page can tell whether anything is new. */
  total = 0;

  constructor(options: LogRingOptions = {}) {
    this.#size = Math.max(10, options.size ?? 500);
    this.#secrets = options.secrets ?? (() => []);
    this.#now = options.now ?? Date.now;
  }

  add(text: string, level: LogLine['level'] = 'info'): void {
    // A line can be many (a stack trace); each is kept on its own so the console can show them in order.
    for (const part of String(text).split(/\r?\n/)) {
      if (!part.trim()) continue;
      this.#lines.push({ at: this.#now(), level, text: redact(part, this.#secrets()) });
      this.total += 1;
    }
    if (this.#lines.length > this.#size) this.#lines.splice(0, this.#lines.length - this.#size);
  }

  /** The newest `limit` lines, oldest first; `level` keeps only warnings and errors, `search` only lines containing a word. */
  lines(options: { limit?: number; level?: 'all' | 'problems'; search?: string } = {}): LogLine[] {
    const wanted = options.search?.trim().toLowerCase();
    const kept = this.#lines.filter((line) => (options.level !== 'problems' || line.level !== 'info') && (!wanted || line.text.toLowerCase().includes(wanted)));
    return kept.slice(-Math.max(1, Math.min(this.#size, options.limit ?? 200)));
  }

  get size(): number {
    return this.#lines.length;
  }

  clear(): void {
    this.#lines = [];
  }
}

/** Works out `read` at most once in `ttlMs`: every line of the log is masked, and the settings do not change that often. */
function remembered<T>(read: () => T, ttlMs: number): () => T {
  let at = 0;
  let value: T | undefined;
  return () => {
    const now = Date.now();
    if (value === undefined || now - at > ttlMs) {
      value = read();
      at = now;
    }
    return value;
  };
}

/** The ring the running bot uses. */
export const logRing = new LogRing({ secrets: remembered(() => secretValues(process.env), 30_000) });

let tapped = false;

/**
 * Keeps a copy of everything the process writes with console.log, console.info, console.warn and console.error in `ring`,
 * and still writes it as before. Safe to call twice (it taps once).
 */
export function tapConsole(ring: LogRing = logRing, target: Pick<Console, 'log' | 'info' | 'warn' | 'error'> = console): void {
  if (tapped && ring === logRing) return;
  if (ring === logRing) tapped = true;
  const wrap = (name: 'log' | 'info' | 'warn' | 'error', level: LogLine['level']): void => {
    const original = target[name].bind(target) as (...args: unknown[]) => void;
    target[name] = (...args: unknown[]): void => {
      try {
        ring.add(format(...args), level);
      } catch {
        // keeping a copy must never stop a line from being written
      }
      original(...args);
    };
  };
  wrap('log', 'info');
  wrap('info', 'info');
  wrap('warn', 'warn');
  wrap('error', 'error');
}
