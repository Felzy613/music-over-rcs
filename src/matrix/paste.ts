export interface PastedMessage {
  text: string;
  /** How many lines of input went into it. */
  lines: number;
}

/** Tracks how deeply nested the JSON read so far is, so braces inside strings don't count. */
class JsonDepth {
  depth = 0;
  #inString = false;
  #escaped = false;

  add(line: string): void {
    for (const ch of line) {
      if (this.#inString) {
        if (this.#escaped) this.#escaped = false;
        else if (ch === '\\') this.#escaped = true;
        else if (ch === '"') this.#inString = false;
      } else if (ch === '"') {
        this.#inString = true;
      } else if (ch === '{' || ch === '[') {
        this.depth += 1;
      } else if (ch === '}' || ch === ']') {
        this.depth -= 1;
      }
    }
  }
}

/**
 * Groups lines typed or pasted into a terminal into the messages they mean. A command copied from browser devtools
 * spans many lines (each ending in a backslash) and a pasted JSON object may too; sent line by line, the bridge
 * would see fragments. A shell command is joined into one line, a JSON object keeps its line breaks, and a blank
 * line ends a group that never finished.
 */
export async function* groupPastedLines(input: AsyncIterable<string>): AsyncGenerator<PastedMessage> {
  let parts: string[] = [];
  let json: JsonDepth | undefined;

  const flush = (): PastedMessage | undefined => {
    const text = (json ? parts.join('\n') : parts.map((part) => part.trim()).join(' ')).trim();
    const message = text ? { text, lines: parts.length } : undefined;
    parts = [];
    json = undefined;
    return message;
  };

  for await (const raw of input) {
    const line = raw.replace(/\r$/, '');
    if (parts.length === 0) {
      if (!line.trim()) continue;
      if (line.trimStart().startsWith('{')) json = new JsonDepth();
    } else if (!line.trim()) {
      const unfinished = flush();
      if (unfinished) yield unfinished;
      continue;
    }

    if (json) {
      json.add(line);
      parts.push(line);
      if (json.depth > 0) continue;
    } else if (/\\\s*$/.test(line)) {
      parts.push(line.replace(/\\\s*$/, ''));
      continue;
    } else {
      parts.push(line);
    }
    const message = flush();
    if (message) yield message;
  }

  const rest = flush();
  if (rest) yield rest;
}
