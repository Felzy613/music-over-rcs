# Other routes: Beeper, and an RCS for Business agent

The [Mac setup with the bridge](setup-mac.md) is the recommended route. Two others share the same bot.

## Beeper

[Beeper Desktop](https://www.beeper.com/) bundles a Google Messages bridge and has a local API, so there's no homeserver or bridge to install. Album art, lists, the daily message and songs kept ready all work as on the bridge route.

1. Install Beeper Desktop, sign in, and add your Google Messages account ([guide](https://help.beeper.com/google-messages-getting-started-guide)). Your phone has to stay online.
2. In Beeper Desktop, open Settings → Developers, turn on the Beeper Desktop API, and create an access token under Approved connections (+).
3. On your phone, send yourself one message in Google Messages so the chat exists.
4. `cp .env.example .env` and set `BEEPER_ACCESS_TOKEN`.
5. `npm run beeper-chats -- google`, then put the ID of your "message yourself" chat in `.env` as `BEEPER_CHAT_ID`.
6. Check the path: `npm run beeper-send -- "hello"`, then `npm run beeper-send -- --audio https://host/file.mp3`.
7. `npm run beeper`, and text a song name in that chat.

Beeper asks for personal use and warns that sending too many messages can get an account suspended. It treats message text as Markdown, so a title with characters like `*` or `_` may be formatted instead of shown literally. Reactions (👍) aren't read on this route.

## RCS for Business agent

This is Google's official way for businesses to message phones over RCS. It's a separate chat with an agent, not your own number.

**Why consider it:** it's the only way to get real **buttons, rich cards and carousels** in Google Messages. Those are an RCS for Business feature: a message from your own number (the bridge route) can only carry text, pictures and files. This route already sends options as tappable chips; cards and carousels would be the next step.

**Prerequisite: partner access.** Agents are created by registered partners; individuals can't sign up directly ([register as a partner](https://developers.google.com/business-communications/rcs-business-messaging/guides/get-started/register-partner)). Google's interest form asks for a corporate email address (not Gmail), and Google decides who is approved. Messaging providers such as Twilio, Sinch, Vonage or Bird are partners themselves and can host an agent for you, but they set their own prices, verify your brand, and use their own APIs; this route calls Google's API directly.

**Tester mode is free.** An unlaunched agent can only message test devices you register (20 invites a day, 200 in total), and [Google doesn't charge for messages to testers](https://developers.google.com/business-communications/rcs-business-messaging/guides/build/test).

1. Turn on RCS chats on your phone: Messages → Settings → RCS chats.
2. In the Developer Console (partner account), click **+ Create agent** and choose brand, name, region, billing category and use case.
3. Under **Devices**, add your phone number and accept the invitation on the phone (or `npm run invite-tester -- +15551234567`).
4. Create a service account key for your partner account and save it as `keys/rbm-service-account.json` (git ignores `keys/`).
5. `cp .env.example .env`, then fill in `RBM_AGENT_ID`, `RBM_REGION`, a `RBM_CLIENT_TOKEN` you make up, and the key path.
6. Check your credentials: `npm run send-test -- +15551234567 "hello"`; check a catalog file against Google itself: `npm run send-test -- +15551234567 --audio https://host/file.mp3`.
7. `npm start`, then make it reachable over HTTPS, for example `cloudflared tunnel --url http://localhost:8787`. That URL changes on every run; a named tunnel or a host gives you a stable one.
8. In the console, open your agent → **Integrations** → **Webhook** → **Configure**. Enter `https://<your-host>/rbm/webhook` and the same client token as `RBM_CLIENT_TOKEN`. Google sends a verification request, which the server answers automatically.
9. Text the agent.

On this route the server never downloads, stores or relays audio: it hands Google the URL, and Google fetches, caches (60 days) and delivers the file. So catalog entries must be MP3, AAC or OGG (MP4 audio and 3GPP also work), up to 100 MiB, with an `audio/*` content type, on a publicly reachable host. Options are tappable chips. Each song is a caption message followed by the audio, because audio can't go inside a rich card. music-table.com isn't wired into this route: its download links expire, and Google fetches files later.
