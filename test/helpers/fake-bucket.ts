/** A bucket held in memory with R2's rules for ETags and conditional writes, seen from either side: the host's S3 client or the Worker's binding. */
export class FakeBucket {
  objects = new Map<string, { body: string; etag: string; bytes?: Uint8Array; uploaded?: Date }>();
  #n = 0;
  /** The time new objects are stamped with (the Worker's sweep reads it). */
  now: () => Date = () => new Date();

  #put(key: string, body: string | Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: string } = {}): { ok: true; etag: string } | { ok: false } {
    const current = this.objects.get(key);
    if (condition.ifNoneMatch === '*' && current) return { ok: false };
    if (condition.ifMatch !== undefined && current?.etag !== condition.ifMatch) return { ok: false };
    const etag = `"e${++this.#n}"`;
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    this.objects.set(key, { body: typeof body === 'string' ? body : new TextDecoder().decode(body), etag, bytes, uploaded: this.now() });
    return { ok: true, etag };
  }

  /** The host's client (src/cloud/s3.ts). */
  s3 = {
    get: async (key: string) => {
      const o = this.objects.get(key);
      return o ? { text: o.body, etag: o.etag } : undefined;
    },
    getBytes: async (key: string) => {
      const o = this.objects.get(key);
      return o ? { data: o.bytes ?? new TextEncoder().encode(o.body), etag: o.etag } : undefined;
    },
    put: async (key: string, body: string | Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' } = {}) => this.#put(key, body, condition),
    list: async (prefix: string) => [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    delete: async (key: string) => void this.objects.delete(key),
  };

  /** The Worker's R2 binding. */
  binding = {
    get: async (key: string) => {
      const o = this.objects.get(key);
      return o ? { etag: o.etag, text: async () => o.body } : null;
    },
    put: async (key: string, value: string | Uint8Array | ArrayBuffer | ReadableStream) => {
      if (typeof value === 'string' || value instanceof Uint8Array) return this.#put(key, value);
      if (value instanceof ArrayBuffer) return this.#put(key, new Uint8Array(value));
      return this.#put(key, new Uint8Array(await new Response(value).arrayBuffer()));
    },
    list: async (options: { prefix: string; limit?: number }) => ({
      objects: [...this.objects.entries()]
        .filter(([k]) => k.startsWith(options.prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, options.limit ?? 1000)
        .map(([key, o]) => ({ key, uploaded: o.uploaded ?? new Date(0) })),
    }),
    delete: async (key: string) => void this.objects.delete(key),
  };
}
