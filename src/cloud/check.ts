// What `npm run cloud:check` looks at: the Cloudflare Worker and the Render host, from the outside, one plain line each,
// with what to do about anything that is wrong. It changes nothing except taking and giving back the lease for a moment
// (and sending one test email when asked).

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** What to do, when it isn't ok. */
  fix?: string;
}

export interface CheckOptions {
  /** The Worker's address, https://mors-edge.<you>.workers.dev. */
  worker?: string | undefined;
  /** The Render service's address, https://<name>.onrender.com. */
  render?: string | undefined;
  /** The shared token (the Worker's EDGE_TOKEN secret and the host's EDGE_TOKEN). */
  edgeToken?: string | undefined;
  /** The host's ADMIN_TOKEN. */
  adminToken?: string | undefined;
  /** Also send one test email through the Worker. */
  sendTestAlert?: boolean;
  fetch?: typeof fetch;
  /** The name the lease check uses for itself. */
  holder?: string;
}

const clean = (url: string): string => url.replace(/\/+$/, '');

export async function checkCloud(options: CheckOptions): Promise<CheckResult[]> {
  const doFetch = options.fetch ?? fetch;
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
  const bearer = (token: string | undefined): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

  if (options.worker) {
    const base = clean(options.worker);
    const health = await ask(`${base}/healthz`);
    if ('error' in health || health.status !== 200) {
      add('The Worker answers', false, 'error' in health ? health.error : `HTTP ${health.status}`, 'Deploy it: cd cloudflare && npx wrangler deploy. Check the address is the one wrangler printed.');
    } else {
      add('The Worker answers', true, base);
      if (!options.edgeToken) {
        add('The Worker accepts the shared token', false, 'EDGE_TOKEN is not set in this shell', 'Run it as: EDGE_TOKEN=… npm run cloud:check -- --worker …');
      } else {
        const wrong = await ask(`${base}/status`, { headers: bearer('definitely-not-the-token') });
        const right = await ask(`${base}/status`, { headers: bearer(options.edgeToken) });
        if ('error' in right) add('The Worker accepts the shared token', false, right.error);
        else if (right.status === 401) add('The Worker accepts the shared token', false, 'it answered 401', 'The Worker\'s EDGE_TOKEN secret differs from the one you gave: run npx wrangler secret put EDGE_TOKEN again with the same value.');
        else {
          add('The Worker accepts the shared token', right.status === 200, `HTTP ${right.status}`);
          add('The Worker refuses a wrong token', !('error' in wrong) && wrong.status === 401, 'error' in wrong ? wrong.error : `HTTP ${wrong.status}`, 'Something is wrong with the Worker: its EDGE_TOKEN secret may be empty.');
          const holder = options.holder ?? `check-${Math.random().toString(16).slice(2, 8)}`;
          const lease = await ask(`${base}/lease/acquire`, { method: 'POST', headers: { ...bearer(options.edgeToken), 'content-type': 'application/json' }, body: JSON.stringify({ holder, ttlSeconds: 15 }) });
          if ('error' in lease || lease.status !== 200) {
            add('The lease works', false, 'error' in lease ? lease.error : `HTTP ${lease.status}: ${lease.text.slice(0, 120)}`, 'The R2 bucket may not be bound: check the r2_buckets entry in cloudflare/wrangler.jsonc and that bucket mors-state exists.');
          } else if (lease.json?.ok) {
            await ask(`${base}/lease/release`, { method: 'POST', headers: { ...bearer(options.edgeToken), 'content-type': 'application/json' }, body: JSON.stringify({ holder }) });
            add('The lease works', true, 'taken and given back');
          } else {
            add('The lease works', true, `held right now by ${lease.json?.heldBy} (normal while the cloud host is running)`);
          }
          if (options.sendTestAlert) {
            const alert = await ask(`${base}/alert`, { method: 'POST', headers: { ...bearer(options.edgeToken), 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Test alert', message: 'This is a test from npm run cloud:check. If you can read it, alerts work.' }) });
            if ('error' in alert || alert.status !== 200) {
              add('A test alert is sent', false, 'error' in alert ? alert.error : String(alert.json?.error ?? `HTTP ${alert.status}`), 'Email needs ALERT_FROM and ALERT_TO in cloudflare/wrangler.jsonc (a domain with Email Service set up, and ALERT_TO verified), or set the NTFY_TOPIC secret instead.');
            } else add('A test alert is sent', true, 'check your inbox (or the ntfy app) now');
          }
          const watch = await ask(`${base}/status`, { headers: bearer(options.edgeToken) });
          const last = !('error' in watch) ? watch.json?.lastCheck : undefined;
          if (!last) add('The Worker is watching the host', false, 'it has not made a check yet', 'Set RENDER_URL in cloudflare/wrangler.jsonc to the Render address and deploy again; the first check comes within five minutes.');
          else add('The Worker is watching the host', last.ok === true, `last check ${last.ok ? 'found it up' : `failed (${last.detail})`}${last.phase ? `; bot phase "${last.phase}"` : ''}`, 'See the Render checks below.');
        }
      }
    }
  }

  if (options.render) {
    const base = clean(options.render);
    const health = await ask(`${base}/healthz`, {}, 90_000);
    if ('error' in health || health.status !== 200) {
      add('The Render host answers', false, 'error' in health ? health.error : `HTTP ${health.status}`, 'Open the service in the Render dashboard and read its Logs. A cold start takes a minute or two on the free plan; try again after that.');
    } else {
      add('The Render host answers', true, base);
      if (!options.adminToken) {
        add('The host accepts the admin password', false, 'ADMIN_TOKEN is not set in this shell', 'Copy the service\'s ADMIN_TOKEN from the Render dashboard (Environment) and run: ADMIN_TOKEN=… npm run cloud:check -- --render …');
      } else {
        const status = await ask(`${base}/status`, { headers: bearer(options.adminToken) });
        if ('error' in status) add('The host accepts the admin password', false, status.error);
        else if (status.status === 401) add('The host accepts the admin password', false, 'it answered 401', 'That is not the service\'s ADMIN_TOKEN: copy it again from the Render dashboard.');
        else if (status.status !== 200 || !status.json) add('The host accepts the admin password', false, `HTTP ${status.status}`);
        else {
          const s = status.json;
          add('The host accepts the admin password', true, `up ${Math.round(s.uptimeSeconds / 60)} min, ${s.memoryMb} MB of memory`);
          add('Memory is within the free plan', s.memoryMb < 450, `${s.memoryMb} MB (the free plan has 512 MB; under about 450 is comfortable)`, 'Memory is tight: see "Moving to a paid host" in docs/cloud.md.');
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
        }
      }
    }
  }
  if (results.length === 0) add('Something to check', false, 'neither --worker nor --render was given', 'npm run cloud:check -- --worker https://… --render https://…');
  return results;
}
