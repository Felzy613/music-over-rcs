/** A bucket held in memory with R2's rules for ETags and conditional writes, seen from either side: the host's S3 client or the Worker's binding. */
export class FakeBucket {
  objects = new Map<string, { body: string; etag: string }>();
  #n = 0;

  #put(key: string, body: string, condition: { ifMatch?: string; ifNoneMatch?: string } = {}): { ok: true; etag: string } | { ok: false } {
    const current = this.objects.get(key);
    if (condition.ifNoneMatch === '*' && current) return { ok: false };
    if (condition.ifMatch !== undefined && current?.etag !== condition.ifMatch) return { ok: false };
    const etag = `"e${++this.#n}"`;
    this.objects.set(key, { body, etag });
    return { ok: true, etag };
  }

  /** The host's client (src/cloud/s3.ts). */
  s3 = {
    get: async (key: string) => {
      const o = this.objects.get(key);
      return o ? { text: o.body, etag: o.etag } : undefined;
    },
    put: async (key: string, body: string | Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' } = {}) => this.#put(key, String(body), condition),
    list: async (prefix: string) => [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort(),
    delete: async (key: string) => void this.objects.delete(key),
  };

  /** The Worker's R2 binding. */
  binding = {
    get: async (key: string) => {
      const o = this.objects.get(key);
      return o ? { etag: o.etag, text: async () => o.body } : null;
    },
    put: async (key: string, value: string) => this.#put(key, value),
    list: async (options: { prefix: string; limit?: number }) => ({ objects: [...this.objects.keys()].filter((k) => k.startsWith(options.prefix)).sort().slice(0, options.limit ?? 1000).map((key) => ({ key })) }),
    delete: async (key: string) => void this.objects.delete(key),
  };
}
