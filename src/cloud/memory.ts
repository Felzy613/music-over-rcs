import { readFileSync } from 'node:fs';

/** How much memory there is and how much of it is in use. */
export interface MemoryUse {
  limit: number;
  used: number;
}

/**
 * The container's memory limit and what is really using it (anonymous memory: the processes' own, not the file cache, which the
 * system takes back when it needs it). That is what decides whether a big song can be handled without the host being killed,
 * whichever process holds the memory. Nothing when there is no limit or this is not a container (the Mac).
 */
export function containerMemory(read: (path: string) => string = (path) => readFileSync(path, 'utf8')): MemoryUse | undefined {
  try {
    const max = read('/sys/fs/cgroup/memory.max').trim();
    if (max === 'max') return undefined;
    const limit = Number(max);
    const anon = Number(/^anon (\d+)$/m.exec(read('/sys/fs/cgroup/memory.stat'))?.[1]);
    const shmem = Number(/^shmem (\d+)$/m.exec(read('/sys/fs/cgroup/memory.stat'))?.[1] ?? 0);
    return Number.isFinite(limit) && limit > 0 && Number.isFinite(anon) ? { limit, used: anon + (Number.isFinite(shmem) ? shmem : 0) } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The memory check for the bot: the container's, when there is one; otherwise this process against a share it was told it has
 * (BOT_MEMORY_MB); otherwise none, and no limit applies.
 */
export function memoryCheck(env: NodeJS.ProcessEnv = process.env, deps: { container?: () => MemoryUse | undefined; rss?: () => number } = {}): (() => MemoryUse | undefined) | undefined {
  const share = Number(env.BOT_MEMORY_MB);
  const container = deps.container ?? containerMemory;
  const rss = deps.rss ?? (() => process.memoryUsage.rss());
  if (container() === undefined && !(share > 0)) return undefined;
  return () => container() ?? (share > 0 ? { limit: share * 1048576, used: rss() } : undefined);
}
