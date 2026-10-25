/**
 * The check that runs every five minutes from a Cron Trigger. It does two jobs: its request keeps Render's free service from
 * spinning down (it sleeps after 15 minutes without inbound traffic), and its failures are how you hear that the host itself
 * is down, which the bot can't tell you.
 */
export interface WatchdogState {
  /** Checks that failed one after another. */
  failures: number;
  /** When the last check succeeded (Unix ms), if one ever did. */
  lastOkAt?: number;
  /** When the current outage was last reported (Unix ms). */
  reportedAt?: number;
  /** Since when the host has answered but the bot has not been running (Unix ms), and when that was last reported. */
  notRunningSince?: number;
  notRunningReportedAt?: number;
  /** What the last check saw, for the Worker's own /status. */
  lastCheck?: { at: number; ok: boolean; detail: string; phase?: string };
}

export interface WatchdogDeps {
  /** The Render service's address, with no trailing slash. */
  renderUrl: string;
  /** The Render service's ADMIN_TOKEN, for its /status. Without it only /healthz is checked. */
  adminToken?: string | undefined;
  fetch: typeof fetch;
  now: number;
  load(): Promise<WatchdogState | undefined>;
  save(state: WatchdogState): Promise<void>;
  alert(title: string, message: string): Promise<void>;
}

/** Failed checks before the host is reported down (three, so a restart of a few minutes isn't a report). */
export const FAILURES_BEFORE_REPORT = 3;
/** How long before a continuing outage is reported again. */
export const REPORT_AGAIN_MS = 6 * 60 * 60_000;
/** How long the bot may sit short of "running" (waiting for a chat, or off) before it is reported. */
export const NOT_RUNNING_REPORT_MS = 30 * 60_000;

async function ask(deps: WatchdogDeps, path: string, headers: Record<string, string> = {}): Promise<Response> {
  // Called on its own, never as `deps.fetch(…)`: the Workers runtime refuses a fetch called with another object as `this`
  // ("Illegal invocation"). Every check failed that way from the Worker's first day to 2026-10-25, so none kept Render awake.
  const fetchOnly = deps.fetch;
  return fetchOnly(`${deps.renderUrl}${path}`, { headers, signal: AbortSignal.timeout(45_000) });
}

export async function runWatchdog(deps: WatchdogDeps): Promise<WatchdogState> {
  const state: WatchdogState = (await deps.load()) ?? { failures: 0 };
  let ok = false;
  let detail = '';
  let phase: string | undefined;
  try {
    const res = await ask(deps, '/healthz');
    await res.body?.cancel().catch(() => {});
    ok = res.ok;
    detail = ok ? 'up' : `HTTP ${res.status}`;
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }

  if (ok && deps.adminToken) {
    try {
      const res = await ask(deps, '/status', { authorization: `Bearer ${deps.adminToken}` });
      if (res.ok) phase = ((await res.json()) as { phase?: string }).phase;
      else await res.body?.cancel().catch(() => {});
    } catch {
      // /status is a bonus; /healthz answering is what counts
    }
  }

  state.lastCheck = { at: deps.now, ok, detail, ...(phase ? { phase } : {}) };
  if (ok && phase !== undefined) {
    if (phase === 'running') {
      delete state.notRunningSince;
      delete state.notRunningReportedAt;
    } else {
      state.notRunningSince ??= deps.now;
      const waited = deps.now - state.notRunningSince;
      const due = state.notRunningReportedAt === undefined || deps.now - state.notRunningReportedAt >= REPORT_AGAIN_MS;
      if (waited >= NOT_RUNNING_REPORT_MS && due) {
        state.notRunningReportedAt = deps.now;
        await deps.alert('Music over RCS is not answering texts', `The cloud host is up, but the bot has been "${phase}" for ${Math.round(waited / 60_000)} minutes. Open the setup page: it may need Google Messages linked again or a chat chosen.`);
      }
    }
  }
  if (ok) {
    const wasDown = state.reportedAt !== undefined;
    state.failures = 0;
    state.lastOkAt = deps.now;
    delete state.reportedAt;
    if (wasDown) await deps.alert('Music over RCS is back', `The cloud host is answering again (${detail}).`);
  } else {
    state.failures += 1;
    const due = state.reportedAt === undefined || deps.now - state.reportedAt >= REPORT_AGAIN_MS;
    if (state.failures >= FAILURES_BEFORE_REPORT && due) {
      state.reportedAt = deps.now;
      const since = state.lastOkAt ? ` It last answered at ${new Date(state.lastOkAt).toISOString()}.` : '';
      await deps.alert('Music over RCS is down', `The cloud host has not answered for ${state.failures} checks in a row (${detail}).${since} Texts sent meanwhile are answered when it is back.`);
    }
  }
  await deps.save(state);
  return state;
}
