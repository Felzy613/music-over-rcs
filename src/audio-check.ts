/** RCS for Business accepts up to 100 MiB per file (and per message). */
export const MAX_BYTES = 100 * 1024 * 1024;

/** Audio types Google documents as supported for RCS for Business file messages. */
const SUPPORTED_TYPES = new Set([
  'audio/aac',
  'audio/mp3',
  'audio/mpeg',
  'audio/mpg',
  'audio/mp4',
  'audio/mp4a-latm',
  'audio/3gpp',
  'audio/ogg',
  'application/ogg',
]);

/** Audio formats that are definitely not on that list. */
const UNSUPPORTED_AUDIO = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/flac', 'audio/x-flac', 'audio/webm']);

const AUDIO_EXTENSIONS = /\.(mp3|aac|m4a|mp4|3gp|ogg|oga|ogx)$/i;
const ANY_AUDIO_EXTENSIONS = /\.(mp3|aac|m4a|mp4|3gp|ogg|oga|ogx|opus|wav|flac|weba)$/i;

export type AudioCheck = { ok: true; type: string; bytes?: number } | { ok: false; reason: string };
export type AudioKind = { ok: true; type: string } | { ok: false; reason: string };

export interface CheckOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Only for tests: allow localhost / private addresses. Also right when this machine, not Google, fetches the file. */
  allowPrivateHosts?: boolean;
  /** Accept any audio format (WAV, FLAC, ...), not just the ones RCS for Business takes. */
  allowAnyAudio?: boolean;
  /** Largest file accepted, in bytes. Defaults to the RCS for Business limit. */
  maxBytes?: number;
}

const fail = (reason: string): AudioCheck => ({ ok: false, reason });

export const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

export function tooBig(bytes: number, maxBytes: number): string {
  const limit = maxBytes === MAX_BYTES ? 'RCS allows up to 100 MiB' : `the limit is ${megabytes(maxBytes)} MB`;
  return `it's a ${megabytes(bytes)} MB file and ${limit}`;
}

/** Decides from the Content-Type header (and the URL's extension, for generic types) whether a response is audio. */
export function classifyAudio(contentType: string | null, url: URL, allowAnyAudio = false): AudioKind {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!allowAnyAudio && UNSUPPORTED_AUDIO.has(type)) {
    return { ok: false, reason: "RCS doesn't accept WAV, FLAC or WebM audio; convert it to MP3 or AAC" };
  }
  const extensions = allowAnyAudio ? ANY_AUDIO_EXTENSIONS : AUDIO_EXTENSIONS;
  const generic = type === '' || type === 'application/octet-stream';
  if (SUPPORTED_TYPES.has(type) || type.startsWith('audio/') || (generic && extensions.test(url.pathname))) {
    return { ok: true, type };
  }
  return { ok: false, reason: `it isn't an audio file (the server says "${type || 'no content type'}")` };
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (host.includes(':')) {
    return host === '::' || host === '::1' || host.startsWith('::ffff:') || /^f[cd]/.test(host) || host.startsWith('fe80');
  }
  return false;
}

async function probe(
  doFetch: typeof fetch,
  url: URL,
  method: 'HEAD' | 'GET',
  timeoutMs: number,
): Promise<Response | undefined> {
  try {
    const res = await doFetch(url, {
      method,
      headers: method === 'GET' ? { range: 'bytes=0-0' } : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => {});
    return res;
  } catch {
    return undefined;
  }
}

function totalBytes(res: Response): number | undefined {
  const range = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
  const raw = range?.[1] ?? res.headers.get('content-length');
  const bytes = raw === null || raw === undefined ? NaN : Number(raw);
  return Number.isFinite(bytes) ? bytes : undefined;
}

/**
 * Checks a catalog URL the way Google will see it: reachable, an audio content type, within the size limit.
 * Uses HEAD, then a one-byte ranged GET for servers that refuse HEAD. It never downloads the file.
 */
export async function checkAudio(rawUrl: string, options: CheckOptions = {}): Promise<AudioCheck> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return fail("the link isn't a valid URL");
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return fail('the link must start with http:// or https://');
  if (!options.allowPrivateHosts && isPrivateHost(url.hostname)) {
    return fail("the host isn't publicly reachable, so Google can't fetch the file");
  }

  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 8000;
  const maxBytes = options.maxBytes ?? MAX_BYTES;

  let res = await probe(doFetch, url, 'HEAD', timeoutMs);
  if (!res || [400, 401, 403, 405, 501].includes(res.status)) {
    res = (await probe(doFetch, url, 'GET', timeoutMs)) ?? res;
  }
  if (!res) return fail("the file server didn't answer (network error or timeout)");
  if (res.status < 200 || res.status >= 300) return fail(`the file server answered HTTP ${res.status}`);

  const kind = classifyAudio(res.headers.get('content-type'), url, options.allowAnyAudio);
  if (!kind.ok) return fail(kind.reason);

  const bytes = totalBytes(res);
  if (bytes !== undefined && bytes > maxBytes) return fail(tooBig(bytes, maxBytes));
  return bytes === undefined ? { ok: true, type: kind.type } : { ok: true, type: kind.type, bytes };
}
