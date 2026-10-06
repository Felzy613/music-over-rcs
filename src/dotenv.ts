/** Returns the .env text with KEY set to value: replaces an existing KEY= line, or appends one. */
export function upsertEnvLine(text: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const existing = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=.*$`, 'm');
  if (existing.test(text)) return text.replace(existing, () => line);
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  return `${text}${separator}${line}\n`;
}
