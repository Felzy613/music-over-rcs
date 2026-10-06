/** "Artist - Title" is how the site names its posts. Splits on the first spaced dash; no dash means no artist. */
export function splitTitle(raw: string): { artist: string; title: string } {
  const clean = raw.replace(/\s+/g, ' ').trim();
  const match = /^(.+?)\s+[-–—]\s+(.+)$/.exec(clean);
  return match ? { artist: match[1]!.trim(), title: match[2]!.trim() } : { artist: '', title: clean };
}
