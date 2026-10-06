const VERB_PREFIX = /^\s*(?:please\s+)?(?:play|send(?:\s+me)?|get|find|search(?:\s+for)?)\b[\s:,-]*/i;

/** Lowercased word tokens: letters, digits and combining marks. */
export function tokenize(text: string): string[] {
  return text.normalize('NFC').toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];
}

/** Search tokens for a chat message: drops a leading "play" / "send me" and any "by". */
export function parseQuery(raw: string): string[] {
  const tokens = tokenize(raw.replace(VERB_PREFIX, ''));
  const rest = tokens.filter((token) => token !== 'by');
  return rest.length > 0 ? rest : tokens;
}
