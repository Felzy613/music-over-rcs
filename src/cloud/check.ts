// What `npm run cloud:check` looks at: the Render host, from the outside, one plain line each, with what to do about anything
// that is wrong. The host reports what it can see of the rest (the lease, the Cloudflare Worker's last check, alerts waiting
// in the bucket), so this needs nothing but the host's address and its admin password. It changes nothing, except leaving
// one test alert for the Worker to mail when asked.

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do, when it isn't ok. */
  fix?: string;
}

export interface CheckOptions {
  /** The Render service's address, https://<name>.onrender.com. */
  render?: string | undefined;
  /** The host's ADMIN_TOKEN. */
  adminToken?: string | undefined;
  /** Also leave one test alert, which the Worker mails within five minutes. */
  sendTestAlert?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

const clean = (url: string): string => url.replace(/\/+$/, '');

export async function checkCloud(options: CheckOptions): Promise<CheckResult[]> {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const results: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string): void => void results.push({ name, ok, detail, ...(fix && !ok ? { fix } : {}) });
  const ask = async (url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<{ status: number; text: string; json?: any } | { error: string }> => {
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        // not JSON
      }
      return { status: res.status, text, json };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  if (!options.render) {
    add('Something to check', false, '--render was not given', 'npm run cloud:check -- --render https://<name>.onrender.com');
    return results;
  }
  const base = clean(options.render);
  const auth = options.adminToken ? { authorization: `Bearer ${options.adminToken}` } : {};
  const health = await ask(`${base}/healthz`, {}, 90_000);
  if ('error' in health || health.status !== 200) {
    add('The Render host answers', false, 'error' in health ? health.error : `HTTP ${health.status}`, 'Open the service in the Render dashboard and read its Logs. A cold start takes a minute or two on the free plan; try again after that.');
    return results;
  }
  add('The Render host answers', true, base);
  if (!options.adminToken) {
    add('The host accepts the admin password', false, 'ADMIN_TOKEN is not set in this shell', 'Copy the service\'s ADMIN_TOKEN from the Render dashboard (Environment) and run: ADMIN_TOKEN=… npm run cloud:check -- --render …');
    return results;
  }
  const status = await ask(`${base}/status`, { headers: auth });
  if ('error' in status) {
    add('The host accepts the admin password', false, status.error);
    return results;
  }
  if (status.status === 401) {
    add('The host accepts the admin password', false, 'it answered 401', 'That is not the service\'s ADMIN_TOKEN: copy it again from the Render dashboard.');
    return results;
  }
  if (status.status !== 200 || !status.json) {
    add('The host accepts the admin password', false, `HTTP ${status.status}`);
    return results;
  }
  const s = status.json;
  add('The host accepts the admin password', true, `up ${Math.round(s.uptimeSeconds / 60)} min, ${s.memoryMb} MB of memory`);
  add('Memory is within the free plan', s.memoryMb < 450, `${s.memoryMb} MB (the free plan has 512 MB; under about 450 is comfortable)`, 'Memory is tight: see "Moving to a paid host" in docs/cloud.md.');

  const edge = s.edge;
  if (!edge) {
    add('Backups, the lease and alerts (R2)', false, 'the host has no R2 settings', 'Set R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in Render (step 2).');
  } else if (edge.error) {
    add('Backups, the lease and alerts (R2)', false, edge.error, 'Check the R2 token: Object Read & Write on the mors-state bucket, and R2_ENDPOINT ending in .r2.cloudflarestorage.com.');
  } else {
    add('Backups, the lease and alerts (R2)', true, 'the bucket answers');
    const lease = edge.lease;
    add('This host holds the lease', Boolean(lease && lease.expiresAt > now()), lease ? `held by ${lease.holder}${lease.expiresAt > now() ? '' : ' (lapsed)'}` : 'nobody', 'The host takes it when it starts and renews it every 30 seconds; if this stays red, read the host\'s logs.');
    const watch = edge.watchdog;
    const fresh = Boolean(watch && now() - watch.at < 15 * 60_000);
    add('The Worker is watching the host', Boolean(watch?.ok && fresh), watch ? `last check ${Math.round((now() - watch.at) / 60_000)} min ago, ${watch.ok ? 'found it up' : `failed (${watch.detail})`}` : 'it has not checked yet', 'Give the Worker the host\'s address: npx wrangler secret put RENDER_URL (and RENDER_ADMIN_TOKEN) in the cloudflare folder; its first check comes within five minutes.');
    add('No alerts stuck waiting', edge.alertsWaiting === 0, edge.alertsWaiting === 0 ? 'none' : `${edge.alertsWaiting} waiting for the Worker to mail them`, 'The Worker mails them every five minutes. If they stay, it cannot send: check the ALERT_FROM and ALERT_TO secrets and that the domain is set up for Email Service (or set NTFY_TOPIC).');
  }

  const bridge = s.bridge ?? {};
  add('Google Messages is linked', bridge.state === 'CONNECTED', bridge.state ? String(bridge.state) : String(bridge.error ?? 'not linked yet'), `Open ${base}/pair and press Start login (step 4 in docs/cloud.md).`);
  const running = s.phase === 'running';
  const phaseFix =
    s.phase === 'starting' ? 'It is still starting (the homeserver is slow on the free plan); try again in a minute.'
    : s.phase === 'setup' && s.botEnabled === false ? 'The bot is switched off (BOT_ENABLED=off). Set it to on in Render when you are ready to switch over (step 7).'
    : s.phase === 'setup' ? `No chat is chosen yet: open ${base}/pair and choose your "message yourself" chat (step 4).`
    : 'It is starting; try again in a few seconds.';
  add('The bot is answering texts', running, `phase "${s.phase}"${s.room ? `, chat ${s.room}` : ''}`, phaseFix);
  if (Array.isArray(s.problems) && s.problems.length > 0) add('No problems reported', false, s.problems.map((p: { message: string }) => p.message).join(' | '), 'These are the same problems the bot emails you about.');
  else add('No problems reported', true, 'none');
  if (s.oneDrive) add('Songs are saved to OneDrive', s.oneDrive.connected === true, s.oneDrive.connected ? `${s.oneDrive.savedThisMonthMb} MB saved this month${s.oneDrive.monthlyLimitMb ? ` of ${s.oneDrive.monthlyLimitMb} MB allowed` : ''}` : 'not signed in', `Open ${base}/pair and press Sign in to OneDrive (step 5).`);
  add('Outbound traffic this month', (s.sentThisMonthMb ?? 0) < 3500, `${s.sentThisMonthMb ?? 0} MB of songs sent (Render's free plan includes about 5,000 MB in total)`, 'Close to the monthly limit: lower ONEDRIVE_MAX_MB_PER_MONTH, or move to a paid plan.');

  if (options.sendTestAlert) {
    const alert = await ask(`${base}/admin/test-alert`, { method: 'POST', headers: auth });
    if ('error' in alert || alert.status !== 200) add('A test alert is left for the Worker', false, 'error' in alert ? alert.error : String(alert.json?.error ?? `HTTP ${alert.status}`), 'Alerts need the R2 settings on the host.');
    else add('A test alert is left for the Worker', true, 'the Worker mails it within five minutes: check your inbox (or the ntfy app)');
  }
  return results;
}
