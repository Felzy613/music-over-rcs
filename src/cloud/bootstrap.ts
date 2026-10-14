import { MatrixClient, MatrixError } from '../matrix/client.ts';

interface StateStore {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}

/** Waits until the homeserver answers (Synapse takes a while to start on a small host), however long that is. */
export async function waitForHomeserver(
  homeserver: string,
  options: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; stopped?: () => boolean; intervalMs?: number } = {},
): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = options.intervalMs ?? 3000;
  let waited = 0;
  while (!options.stopped?.()) {
    try {
      const res = await doFetch(`${homeserver.replace(/\/+$/, '')}/_matrix/client/versions`, { signal: AbortSignal.timeout(5000) });
      await res.body?.cancel().catch(() => {});
      if (res.ok) return;
    } catch {
      // not up yet
    }
    waited += interval;
    if (waited % 30_000 < interval) options.log?.(`waiting for the Matrix homeserver (${Math.round(waited / 1000)} s so far)`);
    await sleep(interval);
  }
}

/**
 * An access token for the bot's Matrix account: the one in MATRIX_ACCESS_TOKEN if set, else one kept from an earlier start
 * (checked, since a restored homeserver may not know it), else a new one from signing in with MATRIX_USER and
 * MATRIX_PASSWORD. A token made here is kept in the catalog so a restart signs in only once.
 */
export async function ensureToken(options: {
  env: NodeJS.ProcessEnv;
  state: StateStore;
  homeserver: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}): Promise<{ token: string; userId: string }> {
  const { env, state, homeserver } = options;
  const check = async (token: string): Promise<string | undefined> => {
    try {
      return (await new MatrixClient({ token, homeserver, ...(options.fetch ? { fetch: options.fetch } : {}) }).whoami()).userId;
    } catch (err) {
      if (err instanceof MatrixError && (err.status === 401 || err.status === 403)) return undefined;
      throw err;
    }
  };

  const fromEnv = env.MATRIX_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    const userId = await check(fromEnv);
    if (userId) return { token: fromEnv, userId };
    throw new Error('MATRIX_ACCESS_TOKEN is not accepted by the homeserver');
  }
  const kept = state.getState('matrix.token');
  if (kept) {
    const userId = await check(kept);
    if (userId) return { token: kept, userId };
    options.log?.('the Matrix token kept from an earlier start is no longer accepted; signing in again');
  }
  const user = env.MATRIX_USER?.trim() || 'me';
  const password = env.MATRIX_PASSWORD;
  if (!password) throw new Error('No Matrix sign-in: set MATRIX_PASSWORD (and MATRIX_USER, default "me") for the account the first start created');
  const { accessToken, userId } = await MatrixClient.login(homeserver, user, password, options.fetch);
  state.setState('matrix.token', accessToken);
  options.log?.(`signed in to the homeserver as ${userId}`);
  return { token: accessToken, userId };
}
