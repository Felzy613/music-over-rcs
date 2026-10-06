/** A picture downloaded into memory, ready to attach to a message. */
export interface DownloadedImage {
  data: Blob;
  fileName: string;
  mimeType: string;
  bytes: number;
  /** Where it came from, for transports that can show a picture by its address instead of uploading it. */
  sourceUrl: string;
}

export interface FetchImageOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Largest picture accepted, in bytes. Album art is small; anything big is not what was asked for. */
  maxBytes?: number;
  /** How many recent pictures to keep in memory, so the same cover is downloaded once. */
  remember?: number;
}

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/**
 * Makes a picture downloader with a small memory: covers repeat (the same song asked for twice, or a cover in the
 * daily message and again when the song is sent), so each is downloaded once. A call resolves to the picture, or
 * rejects with the reason it couldn't be used.
 */
export function createImageFetcher(options: FetchImageOptions = {}): (url: string) => Promise<DownloadedImage> {
  const doFetch = options.fetch ?? fetch;
  const maxBytes = options.maxBytes ?? 3 * 1024 * 1024;
  const remember = options.remember ?? 64;
  const recent = new Map<string, Promise<DownloadedImage>>();

  async function download(url: string): Promise<DownloadedImage> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("the picture's address isn't a valid URL");
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('the picture must be on http(s)');
    const res = await doFetch(parsed, { redirect: 'follow', signal: AbortSignal.timeout(options.timeoutMs ?? 20_000) });
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!res.ok || !IMAGE_TYPES[type]) {
      await res.body?.cancel().catch(() => {});
      throw new Error(res.ok ? `that isn't a picture (${type || 'no type'})` : `the picture server answered HTTP ${res.status}`);
    }
    const data = await res.arrayBuffer();
    if (data.byteLength === 0) throw new Error('the picture is empty');
    if (data.byteLength > maxBytes) throw new Error('the picture is too big');
    return {
      data: new Blob([data], { type }),
      fileName: `cover.${IMAGE_TYPES[type]}`,
      mimeType: type,
      bytes: data.byteLength,
      sourceUrl: url,
    };
  }

  return (url: string) => {
    const known = recent.get(url);
    if (known) {
      // Most recently used goes to the back, so the oldest is the one dropped.
      recent.delete(url);
      recent.set(url, known);
      return known;
    }
    const pending = download(url);
    recent.set(url, pending);
    pending.catch(() => recent.delete(url)); // a failure is not remembered
    while (recent.size > remember) recent.delete(recent.keys().next().value!);
    return pending;
  };
}
