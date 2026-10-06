import { classifyAudio, MAX_BYTES, megabytes, tooBig } from './audio-check.ts';

export interface DownloadedAudio {
  data: Blob;
  fileName: string;
  mimeType: string;
  bytes: number;
}

export interface FetchAudioOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Largest file accepted, in bytes. Defaults to 100 MiB. */
  maxBytes?: number;
}

/** A download problem whose message is fit to show to the user. */
export class AudioFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioFetchError';
  }
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  '3gp': 'audio/3gpp',
};

const EXTENSION_BY_TYPE: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/3gpp': '3gp',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
};

/** Makes a string safe as a file name: no path separators or reserved characters, at most 120 characters. */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return Array.from(cleaned).slice(0, 120).join('');
}

function lastSegment(url: URL): string {
  const segment = url.pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function fileNameFor(title: string | undefined, url: URL, mimeType: string): string {
  const urlName = lastSegment(url);
  const urlExtension = /\.([a-z0-9]{2,5})$/i.exec(urlName)?.[1]?.toLowerCase();
  const extension =
    EXTENSION_BY_TYPE[mimeType] ?? urlExtension ?? (mimeType.split('/')[1] ?? '').replace(/[^a-z0-9]/gi, '') ?? '';
  const base = sanitizeFileName(title ?? urlName.replace(/\.[a-z0-9]{2,5}$/i, '')) || 'track';
  return `${base}.${extension || 'audio'}`;
}

/**
 * Downloads a direct audio-file URL into memory. It refuses web pages (anything that isn't audio) and
 * anything over the size limit; it does not extract or convert anything.
 */
export async function fetchAudio(rawUrl: string, title?: string, options: FetchAudioOptions = {}): Promise<DownloadedAudio> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AudioFetchError("the link isn't a valid URL");
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AudioFetchError('the link must start with http:// or https://');
  }
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const doFetch = options.fetch ?? fetch;

  let res: Response;
  try {
    res = await doFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(options.timeoutMs ?? 120_000) });
  } catch {
    throw new AudioFetchError("the file server didn't answer (network error or timeout)");
  }
  const refuse = async (reason: string): Promise<never> => {
    await res.body?.cancel().catch(() => {});
    throw new AudioFetchError(reason);
  };

  if (!res.ok) return refuse(`the file server answered HTTP ${res.status}`);
  const kind = classifyAudio(res.headers.get('content-type'), url, true);
  if (!kind.ok) return refuse(kind.reason);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return refuse(tooBig(declared, maxBytes));
  if (!res.body) return refuse('the file is empty');

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new AudioFetchError(`the file is bigger than the ${megabytes(maxBytes)} MB limit`);
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof AudioFetchError) throw err;
    throw new AudioFetchError('the download was interrupted');
  }
  if (total === 0) throw new AudioFetchError('the file is empty');

  const generic = kind.type === '' || kind.type === 'application/octet-stream';
  const urlExtension = /\.([a-z0-9]{2,5})$/i.exec(lastSegment(url))?.[1]?.toLowerCase() ?? '';
  const mimeType = generic ? (TYPE_BY_EXTENSION[urlExtension] ?? 'application/octet-stream') : kind.type;
  const data = new Blob(chunks as unknown as ConstructorParameters<typeof Blob>[0], { type: mimeType });
  return { data, fileName: fileNameFor(title, url, mimeType), mimeType, bytes: total };
}
