# The Worker beside the cloud bot

`index.ts` is a Cloudflare Worker (`mors-edge`). It does three things for the bot's cloud host (see [docs/cloud.md](../docs/cloud.md)):

- **Keeps it awake and watched.** A Cron Trigger every five minutes asks the host's `/healthz` (Render's free plan sleeps after 15 minutes without a request) and, with `RENDER_ADMIN_TOKEN`, its `/status`. Three missed checks in a row, or a host that is up but whose bot isn't running for 30 minutes, are emailed (`watchdog.ts`).
- **Holds the lease** (`lease.ts`): `POST /lease/acquire`, `/renew` and `/release`, one R2 object changed with compare-and-swap, so only one copy of the host runs at a time.
- **Emails the bot's problem reports**: `POST /alert` with `{title, message}`. Through the `EMAIL` binding to your own verified address, or, with no binding, to an ntfy.sh topic (`NTFY_TOPIC`).

All of it needs the shared `EDGE_TOKEN` (`Authorization: Bearer …`) except `/healthz`.

It is plain TypeScript written against the few Workers APIs it uses, so it is typechecked and tested with the rest of the project (`npm test`, `test/cloudflare.test.ts`) and needs nothing installed until it is deployed:

```bash
npx wrangler deploy
npx wrangler secret put EDGE_TOKEN
```

`wrangler.jsonc` holds placeholders (`REPLACE-ME`); fill in your own and keep real values out of git. The secrets are `EDGE_TOKEN`, `RENDER_ADMIN_TOKEN` and, only if you use it, `NTFY_TOPIC`.
