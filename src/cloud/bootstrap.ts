import { MatrixClient, MatrixError } from '../matrix/client.ts';
import { parsePeoplePasswords, peopleFromEnv, scoped, type Person } from '../people.ts';

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

/** The catalog state key the owner's token is kept under (a person's is `matrix.token:<id>`, see `personAccount`). */
const OWNER_TOKEN_KEY = 'matrix.token';

/** One person's Matrix account, as the bot signs in to it (nothing here is read from the environment). */
export interface MatrixAccount {
  /** The account's name on the homeserver: `alice` for `@alice:localhost`. */
  user: string;
  password: string;
  /** The whole id the token must turn out to belong to. Nothing is used or kept for any other account. */
  userId: string;
  /** Where the token is kept in the catalog between starts. */
  stateKey: string;
}

/** The account of a person who is not the owner. `serverName` is the part of a Matrix id after the colon. */
export function personAccount(person: Person, password: string, serverName: string): MatrixAccount {
  if (person.owner) throw new Error("the owner's Matrix account comes from MATRIX_USER and MATRIX_PASSWORD, not from a person's");
  return { user: person.id, password, userId: `@${person.id}:${serverName}`, stateKey: scoped(OWNER_TOKEN_KEY, person) };
}

/**
 * The people besides the owner, each with the account the host made for them, from the environment the host hands the bot: `PEOPLE`
 * (the names) and `PEOPLE_PASSWORDS` (their passwords, see `formatPeoplePasswords`). A person the host handed no password for is left out
 * and said in `problems`, since the bot cannot sign in as them; it never stops the owner's start. `serverName` is the part of a Matrix id
 * after the colon.
 */
export function peopleAccounts(env: NodeJS.ProcessEnv, serverName: string): { accounts: Array<{ person: Person; account: MatrixAccount }>; problems: string[] } {
  const { people, problems } = peopleFromEnv(env);
  const passwords = parsePeoplePasswords(env.PEOPLE_PASSWORDS);
  const accounts: Array<{ person: Person; account: MatrixAccount }> = [];
  for (const person of people) {
    const password = passwords.get(person.id);
    if (password) accounts.push({ person, account: personAccount(person, password, serverName) });
    else problems.push(`PEOPLE: the host handed over no password for "${person.id}"; left out`);
  }
  return { accounts, problems };
}

/**
 * An access token for a Matrix account. For the bot's own account (no `account`): the one in MATRIX_ACCESS_TOKEN if set, else one
 * kept from an earlier start (checked, since a restored homeserver may not know it), else a new one from signing in with MATRIX_USER and
 * MATRIX_PASSWORD. A token made here is kept in the catalog so a restart signs in only once.
 *
 * For a person's account (`account`): the environment is ignored entirely, MATRIX_ACCESS_TOKEN above all, because on the cloud host it is
 * the OWNER'S token (src/cloud-main.ts sets it for the owner's chat): the token comes from the person's own state key or from signing in
 * as them, and it is used and kept only after the homeserver says it is theirs (`whoami`, for a kept token and for a new one alike), so a
 * mix-up can never put one person's bot in another's account.
 */
export async function ensureToken(options: {
  env: NodeJS.ProcessEnv;
  state: StateStore;
  homeserver: string;
  account?: MatrixAccount;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}): Promise<{ token: string; userId: string }> {
  const { env, state, homeserver, account } = options;
  const check = async (token: string): Promise<string | undefined> => {
    try {
      return (await new MatrixClient({ token, homeserver, ...(options.fetch ? { fetch: options.fetch } : {}) }).whoami()).userId;
    } catch (err) {
      if (err instanceof MatrixError && (err.status === 401 || err.status === 403)) return undefined;
      throw err;
    }
  };

  if (account) {
    // The owner's token lives under its own key; a person's must never be kept there.
    if (account.stateKey === OWNER_TOKEN_KEY) throw new Error(`${account.user}'s Matrix token cannot be kept where the owner's is (${OWNER_TOKEN_KEY})`);
    const kept = state.getState(account.stateKey);
    if (kept) {
      const userId = await check(kept);
      if (userId === account.userId) return { token: kept, userId };
      options.log?.(
        userId
          ? `the Matrix token kept for ${account.user} belongs to another account; signing in again`
          : `the Matrix token kept for ${account.user} is no longer accepted; signing in again`,
      );
    }
    if (!account.password) throw new Error(`No Matrix sign-in for ${account.user}: the host did not hand over a password`);
    const { accessToken, userId } = await MatrixClient.login(homeserver, account.user, account.password, options.fetch);
    if (userId !== account.userId || (await check(accessToken)) !== account.userId) {
      throw new Error(`signing in as ${account.user} gave a token for an account other than ${account.userId}; it is not used or kept`);
    }
    state.setState(account.stateKey, accessToken);
    options.log?.(`signed in to the homeserver as ${userId}`);
    return { token: accessToken, userId };
  }

  const fromEnv = env.MATRIX_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    const userId = await check(fromEnv);
    if (userId) return { token: fromEnv, userId };
    throw new Error('MATRIX_ACCESS_TOKEN is not accepted by the homeserver');
  }
  const kept = state.getState(OWNER_TOKEN_KEY);
  if (kept) {
    const userId = await check(kept);
    if (userId) return { token: kept, userId };
    options.log?.('the Matrix token kept from an earlier start is no longer accepted; signing in again');
  }
  const user = env.MATRIX_USER?.trim() || 'me';
  const password = env.MATRIX_PASSWORD;
  if (!password) throw new Error('No Matrix sign-in: set MATRIX_PASSWORD (and MATRIX_USER, default "me") for the account the first start created');
  const { accessToken, userId } = await MatrixClient.login(homeserver, user, password, options.fetch);
  state.setState(OWNER_TOKEN_KEY, accessToken);
  options.log?.(`signed in to the homeserver as ${userId}`);
  return { token: accessToken, userId };
}

/**
 * ensureToken, but patient about the one thing that is expected on a first start: the account does not exist yet, because the host
 * makes it as soon as the homeserver answers and the bot may ask first. Signing in is refused (403) until then, so it is tried again
 * every few seconds, for about two minutes. A wrong password is refused the same way for ever, and so ends in the same error.
 */
export async function ensureTokenPatiently(
  options: Parameters<typeof ensureToken>[0],
  wait: { attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; stopped?: () => boolean } = {},
): ReturnType<typeof ensureToken> {
  const attempts = wait.attempts ?? 40;
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await ensureToken(options);
    } catch (err) {
      const refused = err instanceof MatrixError && err.status === 403 && err.errcode === 'M_FORBIDDEN';
      if (!refused || attempt >= attempts || wait.stopped?.()) throw err;
      if (attempt === 1) options.log?.('the Matrix account does not exist yet (the host makes it as soon as the homeserver is up); trying again shortly');
      await sleep(wait.intervalMs ?? 3000);
    }
  }
}
