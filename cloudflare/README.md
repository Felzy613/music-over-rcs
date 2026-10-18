# The Worker beside the cloud bot

`index.ts` is a Cloudflare Worker (`mors-edge`). It does two things every five minutes for the bot's cloud host, and a third whenever it is asked (see [docs/cloud.md](../docs/cloud.md)):

- **Checks the host and keeps it awake.** It asks the host's `/healthz` (Render's free plan sleeps after 15 minutes without a request) and, with `RENDER_ADMIN_TOKEN`, its `/status`. Three missed checks in a row, or a host that is up but whose bot isn't running for 30 minutes, are emailed (`watchdog.ts`). What it saw is kept in the bucket as `watchdog.json`.
- **Mails the bot's alerts.** The bot leaves each problem report in the R2 bucket's `alerts/` folder; the Worker sends each as an email to your own verified address (through the `EMAIL` binding), or to an ntfy.sh topic (`NTFY_TOPIC`) if you have no email domain, and deletes it once sent.

- **Fetches YouTube songs for the host** (`youtube.ts`). YouTube turns the host's datacenter address away with a bot check but answers Cloudflare's network. The host leaves a request in the bucket's `yt/req/`; R2 tells this Worker through the `mors-yt` queue; it asks YouTube Music's player for the song, downloads the audio into `yt/audio/`, and leaves the outcome in `yt/res/`. The five-minute job sweeps anything there over an hour old. Set up once with `npx wrangler queues create mors-yt` and `npx wrangler r2 bucket notification create mors-state --event-type object-create --prefix yt/req/ --queue mors-yt`.

It serves nothing and takes no requests on purpose. Cloudflare puts a bot challenge in front of every automated client on `workers.dev`, so the host could not call it anyway; the Worker and the host meet in the bucket instead. (The host's lease, which keeps two copies from running at once, is also a file in that bucket, written by the host itself: see `src/cloud/lease.ts`.)

It is plain TypeScript written against the few Workers APIs it uses, so it is typechecked and tested with the rest of the project (`npm test`, `test/cloudflare.test.ts`) and needs nothing installed until it is deployed:

```bash
npx wrangler deploy
```

`wrangler.jsonc` holds no personal values; everything specific to you is a secret, so nothing needs editing and nothing reaches git: `RENDER_URL`, `RENDER_ADMIN_TOKEN`, `ALERT_FROM`, `ALERT_TO` and, only if you use ntfy.sh instead of email, `NTFY_TOPIC`. Set each with `npx wrangler secret put <NAME>`. Until `RENDER_URL` is set the Worker checks nothing.
