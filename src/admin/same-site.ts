import type { IncomingMessage } from 'node:http';

/** Whether the browser says this request came from this site (or from no site at all, as a script's does). */
export function isSameSite(headers: IncomingMessage['headers']): boolean {
  const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
  const site = first(headers['sec-fetch-site']);
  if (site !== undefined && site !== 'same-origin') return false;
  const origin = first(headers.origin);
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  try {
    // Behind the host's front door the Host header is the bot's own; the visitor's is passed along as X-Forwarded-Host.
    const expected = (first(headers['x-forwarded-host']) ?? first(headers.host) ?? '').toLowerCase();
    return expected !== '' && new URL(origin).host.toLowerCase() === expected;
  } catch {
    return false;
  }
}
