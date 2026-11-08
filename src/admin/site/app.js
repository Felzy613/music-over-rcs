'use strict';
// The owner's console (docs/admin.md). Everything on the page is built with DOM calls and textContent, never as markup:
// artist and song names come from outside feeds, and nothing in them may become HTML. Every change is a POST with a JSON
// body and the X-Admin-Console header; the server refuses a change without it.
(() => {
  const view = document.getElementById('view');
  const tabsBar = document.getElementById('tabs');

  // ---------- small helpers ----------

  /** Builds an element. `attrs` may hold class, on<event> handlers, and plain attributes; children are text or elements. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'href') {
        // Only this site's own addresses.
        if (typeof value === 'string' && (value.startsWith('/') || value.startsWith('#'))) el.setAttribute('href', value);
      } else if (key === 'src') {
        if (typeof value === 'string' && value.startsWith('https://')) {
          el.setAttribute('src', value);
          el.setAttribute('referrerpolicy', 'no-referrer');
          el.setAttribute('loading', 'lazy');
        }
      } else if (value === true) el.setAttribute(key, '');
      else el.setAttribute(key, String(value));
    }
    // A picture that does not load is left as an empty circle or square, not a broken-image icon.
    if (tag === 'img') el.addEventListener('error', () => el.classList.add('broken'));
    for (const kid of kids.flat(Infinity)) {
      if (kid === undefined || kid === null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });
  function ago(ms, now = Date.now()) {
    if (!ms) return '—';
    const s = Math.round((now - ms) / 1000);
    if (s < 0) return 'in ' + span(-s);
    return span(s) + ' ago';
  }
  function span(s) {
    if (s < 90) return `${s} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    if (s < 129600) return `${Math.round(s / 3600)} h`;
    return `${Math.round(s / 86400)} days`;
  }
  const iso = (text) => (text ? Date.parse(text) : 0);
  const num = (n) => (typeof n === 'number' ? n.toLocaleString() : '—');

  function badge(text, kind) {
    return h('span', { class: `badge ${kind || ''}` }, text);
  }

  function dl(pairs) {
    const el = h('dl', { class: 'kv' });
    for (const [key, value] of pairs) {
      if (value === undefined) continue;
      el.append(h('dt', {}, key), h('dd', {}, value === null || value === '' ? '—' : value));
    }
    return el;
  }

  const card = (title, ...kids) => h('section', { class: 'card' }, title ? h('h2', {}, title) : null, ...kids);

  function toast(message, bad) {
    const box = document.getElementById('toasts');
    const el = h('div', { class: `toast ${bad ? 'bad' : ''}` }, message);
    box.append(el);
    setTimeout(() => el.remove(), bad ? 9000 : 5000);
  }

  async function api(path, body) {
    const init = { credentials: 'same-origin', cache: 'no-store' };
    if (body !== undefined) {
      init.method = 'POST';
      init.headers = { 'content-type': 'application/json', 'x-admin-console': '1' };
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(`/admin/api/${path}`, init);
    } catch {
      throw new Error('The host did not answer. If it is restarting, try again in a minute.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      // The session ended (or the host was reset): back to the sign-in page, which brings us back here.
      location.assign(`/login?next=${encodeURIComponent(location.pathname)}`);
      throw new Error('Signed out. Taking you to the sign-in page…');
    }
    if (!res.ok) throw new Error(data.error || `The host answered ${res.status}.`);
    return data;
  }

  /** A button that does `work` when pressed: disabled meanwhile, and any failure is shown rather than lost. */
  function action(label, work, options = {}) {
    const button = h('button', { class: `${options.kind || ''} ${options.small ? 'small' : ''}`, type: 'button' }, label);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await work();
      } catch (err) {
        toast(err.message, true);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  /**
   * Asks for the owner's word that no women are credited. The box starts unticked and nothing is sent without it; the server
   * refuses an allow that does not carry the confirmation.
   */
  function confirmNoWomen(title, what, yes = 'Allow') {
    return new Promise((resolve) => {
      const box = h('input', { type: 'checkbox', id: 'nw' });
      const go = h('button', { type: 'button', disabled: true }, yes);
      const cancel = h('button', { type: 'button', class: 'quiet' }, 'Cancel');
      const dialog = h(
        'dialog',
        {},
        h('h2', {}, title),
        h('p', {}, what),
        h('label', { class: 'check', for: 'nw' }, box, h('span', {}, 'No women are credited. I have checked.')),
        h('div', { class: 'row' }, go, cancel),
      );
      box.addEventListener('change', () => (go.disabled = !box.checked));
      const done = (answer) => {
        dialog.close();
        dialog.remove();
        resolve(answer);
      };
      go.addEventListener('click', () => done(box.checked));
      cancel.addEventListener('click', () => done(false));
      dialog.addEventListener('cancel', () => done(false));
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  function confirmPlain(title, what, yes) {
    return new Promise((resolve) => {
      const go = h('button', { type: 'button' }, yes);
      const cancel = h('button', { type: 'button', class: 'quiet' }, 'Cancel');
      const dialog = h('dialog', {}, h('h2', {}, title), h('p', {}, what), h('div', { class: 'row' }, go, cancel));
      const done = (answer) => {
        dialog.close();
        dialog.remove();
        resolve(answer);
      };
      go.addEventListener('click', () => done(true));
      cancel.addEventListener('click', () => done(false));
      dialog.addEventListener('cancel', () => done(false));
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  /** Asks for a password in a dialog (not shown as it is typed). Resolves to the text, or undefined when cancelled. */
  function askPassword(title, what, yes) {
    return new Promise((resolve) => {
      const box = h('input', { type: 'password', id: 'ap', autocomplete: 'current-password' });
      const go = h('button', { type: 'submit' }, yes);
      const cancel = h('button', { type: 'button', class: 'quiet' }, 'Cancel');
      const form = h('form', {}, h('h2', {}, title), h('p', {}, what), h('label', { for: 'ap' }, 'Current password'), box, h('div', { class: 'row gap' }, go, cancel));
      const dialog = h('dialog', {}, form);
      const done = (answer) => {
        dialog.close();
        dialog.remove();
        resolve(answer);
      };
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        done(box.value);
      });
      cancel.addEventListener('click', () => done(undefined));
      dialog.addEventListener('cancel', () => done(undefined));
      document.body.append(dialog);
      dialog.showModal();
      box.focus();
    });
  }

  const STANDING = { blocked: ['blocked by you', 'bad'], female: ["on Zemer's list, flagged as a woman", 'bad'], listed: ["on Zemer's list", 'ok'], allowed: ['allowed by you', 'ok'], waiting: ['waiting for your word', 'warn'], unknown: ['not on the list', ''] };
  const standingBadge = (state) => badge(STANDING[state]?.[0] ?? state, STANDING[state]?.[1]);

  // ---------- the actions (Overview and elsewhere) ----------

  const ACTIONS = [
    ['refresh-list', "Refresh Zemer's artist list", "Asks Zemer's server whether its list changed. Skipped while Zemer's server has turned the bot away less than three hours ago."],
    ['refresh-list-force', 'Forced try', "Asks Zemer's server now, ignoring that wait. Zemer answers only its own app, so it will most likely refuse again and the three hours start over. Once in five minutes at most.", { kind: 'danger' }],
    ['refresh-releases', "Refresh Zemer's new releases", 'Reads the releases feed again now and holds each release to the artist list.'],
    ['sync-site', 'Sync music-table.com', "Reads the site's newest posts into the catalog."],
    ['prefetch', 'Get songs ready', 'Downloads the songs worth keeping on disk (nothing on this host: its disk is wiped at every restart).'],
    ['digest-preview', 'Preview the daily message', 'Shows what the daily message would say now. Sends nothing.'],
    ['digest-send', 'Send the daily message now', 'Texts the daily message to your chat now, if there is anything new.', { confirm: true }],
    ['alerts-check', 'Check alerts for artists you follow', 'Sends the "new from an artist you follow" alerts that are due (not in the quiet hours).'],
  ];

  function resultBox(result) {
    if (!result) return null;
    return h(
      'div',
      { class: `result ${result.ok ? 'ok' : 'bad'}` },
      h('div', {}, `${result.ok ? '✓' : '✗'} ${result.summary}`, h('span', { class: 'muted' }, `  ${ago(result.finishedAt)}`)),
      result.lines && result.lines.length > 0 ? h('pre', {}, result.lines.join('\n')) : null,
    );
  }

  function actionRow(entry, state, only) {
    const [name, label, note, options = {}] = entry;
    if (only && !only.includes(name)) return null;
    const holder = h('div', {}, resultBox(state?.[name]?.last));
    const run = action(label, async () => {
      if (options.confirm && !(await confirmPlain(label + '?', note, 'Send it'))) return;
      holder.replaceChildren(h('div', { class: 'result muted' }, 'Running…'));
      try {
        const data = await api(`actions/${name}`, options.confirm ? { confirm: true } : {});
        holder.replaceChildren(resultBox(data.result));
      } catch (err) {
        holder.replaceChildren(h('div', { class: 'result bad' }, err.message));
      }
    }, { kind: options.kind || 'quiet' });
    return h('li', {}, h('div', { class: 'grow' }, h('b', {}, label), h('div', { class: 'muted' }, note), holder), h('div', { class: 'actions' }, run));
  }

  function actionsCard(state, only, title = 'Actions') {
    return card(title, h('ul', { class: 'list' }, ACTIONS.map((entry) => actionRow(entry, state, only))));
  }

  // ---------- pages ----------

  const pages = {};

  pages.overview = async () => {
    const d = await api('overview');
    const s = d.status || {};
    const kinds = { running: 'ok', 'bot-starting': 'warn', setup: 'warn', starting: 'warn', 'room-missing': 'bad' };
    const bridge = s.bridge || {};
    const mem = s.memory;
    const problems = Array.isArray(s.problems) ? s.problems : [];
    const t = d.traffic;
    const list = d.list;
    const rel = d.releases;
    const jobs = d.jobs;
    const edge = s.edge;
    const out = [];

    if (problems.length > 0) {
      out.push(h('div', { class: 'notice bad' }, h('b', {}, `${problems.length} problem${problems.length === 1 ? '' : 's'}: `), problems.map((p) => h('div', {}, `${p.message} (since ${when(iso(p.since))})`))));
    }

    const cards = [
      card(
        'The bot',
        dl([
          ['Phase', badge(s.phase ?? 'unknown', kinds[s.phase] || '')],
          ['Answering', s.botEnabled === false ? badge('off (BOT_ENABLED)', 'warn') : 'yes'],
          ['Up for', s.uptimeSeconds !== undefined ? span(s.uptimeSeconds) : '—'],
          ['Running', d.commit ? `commit ${d.commit.sha} (${d.commit.source})` : 'commit unknown (only Render says)'],
          ['Node', d.node],
          ['Memory', mem ? `${mem.usedMb} of ${mem.limitMb} MB (${mem.percent}%)${mem.peak ? `, peak ${mem.peak.usedMb} MB` : ''}` : s.memoryMb !== undefined ? `${s.memoryMb} MB (no container limit read)` : '—'],
          ['Chat room', s.room],
          ['Tracks in catalog', num(s.tracks)],
        ]),
      ),
      card(
        'Google Messages bridge',
        dl([
          ['Login', badge(bridge.state ?? 'no login', bridge.state === 'CONNECTED' ? 'ok' : 'bad')],
          ['Error', bridge.error],
          ['Says', bridge.message],
          ['RCS', bridge.rcsEnabled === undefined ? undefined : bridge.rcsEnabled ? 'on' : 'off'],
        ]),
        bridge.state && bridge.state !== 'CONNECTED' ? h('p', { class: 'muted' }, 'If Google unpaired the bridge, only linking again on the Setup page fixes it; restarting does not.') : null,
      ),
      card(
        'Traffic this month',
        h('meter', { min: 0, max: t.planMb, high: t.alertMb, low: t.alertMb * 0.6, optimum: 0, value: t.totalMb }),
        h('p', {}, `${num(t.totalMb)} MB sent (${num(t.sentMb)} MB of songs and pictures, ${num(t.savedMb)} MB saved to OneDrive).`),
        h('p', { class: 'muted' }, `The bot raises an alert at ${num(t.alertMb)} MB. Render's free plan includes about ${num(t.planMb)} MB a month for everything the container sends, backups included.`),
      ),
    ];

    cards.push(
      card(
        "Zemer's artist list",
        list
          ? [
              dl([
                ['State', list.frozen ? badge('frozen: Zemer turned the bot away', 'warn') : list.loaded ? badge('live', 'ok') : badge('no list yet', 'bad')],
                ['Last confirmed', list.checkedAt ? `${when(list.checkedAt)} (${ago(list.checkedAt)})` : '—'],
                ['Version', list.gate],
                ['Artists', `${num(list.size.artists)} on the saved copy, ${num(list.size.blocked)} blocked songs`],
                ['You', `${list.owner.allowed} allowed, ${list.owner.blocked} blocked, ${list.owner.waiting} waiting, ${list.owner.allowedSongs} songs allowed, ${list.owner.unblockedSongs} songs unblocked`],
                ['Last error', list.lastError],
                ['Asked again', list.nextAttemptAt ? `not before ${when(list.nextAttemptAt)}` : 'when due'],
              ]),
              list.owner.waiting > 0 ? h('p', {}, h('a', { href: '#artists' }, `${list.owner.waiting} artist${list.owner.waiting === 1 ? ' is' : 's are'} waiting for your word`)) : null,
            ]
          : h('p', { class: 'muted' }, 'The bot is not up yet, or YouTube Music is off.'),
      ),
      card(
        "Zemer's new releases",
        rel
          ? dl([
              ['Last read', rel.lastAttemptAt ? `${when(iso(rel.lastAttemptAt))} (${rel.lastOk ? 'ok' : 'failed'})` : 'not yet this run'],
              ['Problem', rel.problem],
              ['Last feed', rel.lastOk ? `${rel.inFeed} releases, ${rel.passed} pass the list, ${rel.fresh} new, ${rel.held.length} held back` : undefined],
            ])
          : h('p', { class: 'muted' }, 'Off (ZEMER_RELEASES=off), or the bot is not up yet.'),
      ),
      card(
        'Background jobs',
        jobs
          ? dl([
              ['Last site sync', jobs.lastSync ? `${when(iso(jobs.lastSync))} (${ago(iso(jobs.lastSync))})` : '—'],
              ['Next due', jobs.nextSyncDue ? when(iso(jobs.nextSyncDue)) : '—'],
              ['Daily message', jobs.digest.at ? `at ${jobs.digest.at}; last for ${jobs.digest.lastDate ?? '—'}, sent ${jobs.digest.lastSentAt ? ago(iso(jobs.digest.lastSentAt)) : 'never'}` : 'off'],
              ['Quiet hours', jobs.quiet ? `${jobs.quiet}${jobs.inQuietHours ? ' (now)' : ''}` : 'off'],
              ['Whole-site scan', jobs.scan.done ? `done ${when(iso(jobs.scan.done))}` : `${num(jobs.scan.offset)} posts read so far`],
              ['Following', jobs.following],
              ['Last round', jobs.lastRoundAt ? `${ago(iso(jobs.lastRoundAt))}${jobs.lastRoundError ? ` — failed: ${jobs.lastRoundError}` : ''}` : 'not yet'],
            ])
          : h('p', { class: 'muted' }, 'Not running: music-table.com is off, or the bot is not up yet.'),
      ),
    );
    if (edge) {
      cards.push(
        card(
          'Cloudflare and the bucket',
          dl([
            ['Lease held by', edge.lease ? `${edge.lease.holder} until ${when(edge.lease.expiresAt)}` : '—'],
            ['Worker last checked', edge.watchdog ? ago(typeof edge.watchdog === 'number' ? edge.watchdog : Date.parse(edge.watchdog)) : '—'],
            ['Alerts waiting to be mailed', edge.alertsWaiting],
            ['Error', edge.error],
          ]),
        ),
      );
    }
    if (s.oneDrive) {
      cards.push(
        card(
          'OneDrive',
          dl([
            ['Signed in', s.oneDrive.connected ? badge('yes', 'ok') : badge('no', 'warn')],
            ['Saved this month', `${num(s.oneDrive.savedThisMonthMb)} MB of ${s.oneDrive.monthlyLimitMb === null ? 'no limit' : num(s.oneDrive.monthlyLimitMb) + ' MB'}`],
            ['Error', s.oneDrive.error],
          ]),
        ),
      );
    }

    const timings = Array.isArray(s.timings) ? s.timings : [];
    out.push(h('div', { class: 'grid' }, cards));
    out.push(actionsCard(d.actions));
    out.push(card('Recent requests', timings.length === 0 ? h('p', { class: 'muted' }, 'None yet since the last start.') : h('div', { class: 'log' }, timings.slice().reverse().map((line) => h('div', {}, String(line))))));
    return out;
  };

  // --- Artists ---

  /** Allow an artist after the "no women" confirmation. */
  async function allowArtist(artist, refresh) {
    if (!(await confirmNoWomen(`Allow ${artist.name}?`, `Their songs will be sent to your chat. The bot cannot tell who is a woman, so this is your word. (${artist.id})`))) return;
    const done = await api('artists/allow', { id: artist.id, name: artist.name, noWomenConfirmed: true });
    toast(done.message);
    refresh();
  }
  async function blockArtist(artist, refresh) {
    const done = await api('artists/block', { id: artist.id, name: artist.name });
    toast(done.message);
    refresh();
  }

  function artistRow(artist, buttons, extra) {
    return h(
      'li',
      {},
      h('div', { class: 'grow' }, h('b', {}, artist.name), extra ? h('div', { class: 'muted' }, extra) : null, h('div', { class: 'mono muted' }, artist.id)),
      h('div', { class: 'actions' }, buttons),
    );
  }

  pages.artists = async (state) => {
    const q = state.q || '';
    const offset = state.offset || 0;
    const d = await api(`artists?q=${encodeURIComponent(q)}&offset=${offset}&limit=50`);
    const refresh = () => render();
    const r = d.report;
    const out = [];

    out.push(
      card(
        "Zemer's artist list",
        r.frozen ? h('div', { class: 'notice' }, "Zemer's server answers only its own app, so this is the last copy the bot saved. New artists wait for your word below.") : null,
        dl([
          ['State', r.frozen ? badge('frozen', 'warn') : r.loaded ? badge('live', 'ok') : badge('no list', 'bad')],
          ['Last confirmed', r.checkedAt ? `${when(r.checkedAt)} (${ago(r.checkedAt)})` : '—'],
          ['Version', r.gate],
          ['Frozen since', r.refusedSince ? when(r.refusedSince) : undefined],
          ['Last error', r.lastError],
          ['Next ask', r.nextAttemptAt ? when(r.nextAttemptAt) : 'when due'],
          ['Saved copy', `${num(r.size.artists)} artists, ${num(r.size.blocked)} blocked songs`],
        ]),
        h('ul', { class: 'list' }, ACTIONS.filter((a) => a[0].startsWith('refresh-list')).map((entry) => actionRow(entry, {}, null))),
      ),
    );

    out.push(
      card(
        `Waiting for your word (${d.owner.waiting.length})`,
        d.owner.waiting.length === 0
          ? h('p', { class: 'muted' }, 'No one. An artist shows here when Zemer’s releases feed shows them but the saved list does not know them.')
          : h('ul', { class: 'list' }, d.owner.waiting.map((a) => artistRow(a, [action('Allow…', () => allowArtist(a, refresh), { small: true }), action('Block', () => blockArtist(a, refresh), { small: true, kind: 'danger' })], `first seen ${when(a.since)}`))),
      ),
      card(
        `Allowed by you (${d.owner.allowed.length})`,
        d.owner.allowed.length === 0
          ? h('p', { class: 'muted' }, 'No one yet.')
          : h('ul', { class: 'list' }, d.owner.allowed.map((a) => artistRow(a, [action('Remove', async () => { toast((await api('artists/unallow', { id: a.id })).message); refresh(); }, { small: true, kind: 'quiet' }), action('Block', () => blockArtist(a, refresh), { small: true, kind: 'danger' })], a.at ? `allowed ${when(a.at)}` : 'allowed (time not recorded)'))),
      ),
      card(
        `Blocked by you (${d.owner.blocked.length})`,
        d.owner.blocked.length === 0
          ? h('p', { class: 'muted' }, 'No one.')
          : h('ul', { class: 'list' }, d.owner.blocked.map((a) => artistRow(a, [action('Unblock', async () => { toast((await api('artists/unblock', { id: a.id })).message); refresh(); }, { small: true, kind: 'quiet' })], `${a.at ? `blocked ${when(a.at)}` : 'blocked'}${a.listed ? (a.female ? "; Zemer's list flags them as a woman" : "; on Zemer's list otherwise") : ''}`))),
      ),
    );

    // By channel id.
    const idBox = h('input', { type: 'text', class: 'inline', placeholder: 'Channel id (UC…)', autocomplete: 'off', spellcheck: 'false' });
    const nameBox = h('input', { type: 'text', class: 'inline', placeholder: 'Name', autocomplete: 'off' });
    out.push(
      card(
        'Allow or block by channel id',
        h('p', { class: 'muted' }, 'To find an artist and their channel id, use the YouTube tab. The id is the UC… address of their YouTube Music channel.'),
        h('div', { class: 'row' }, idBox, nameBox),
        h('div', { class: 'row' }, action('Allow…', () => allowArtist({ id: idBox.value.trim(), name: nameBox.value.trim() }, refresh)), action('Block', () => blockArtist({ id: idBox.value.trim(), name: nameBox.value.trim() }, refresh), { kind: 'danger' })),
      ),
    );

    // The saved list.
    const search = h('input', { type: 'search', placeholder: 'Search the saved list by name or channel id', value: q, autocomplete: 'off' });
    const go = () => {
      state.q = search.value.trim();
      state.offset = 0;
      render();
    };
    search.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    const l = d.list;
    out.push(
      card(
        `The saved list (${num(l.total)}${q ? ' matching' : ''})`,
        h('div', { class: 'row' }, search, action('Search', go, { kind: 'quiet' })),
        h(
          'ul',
          { class: 'list' },
          l.matches.map((a) =>
            h(
              'li',
              {},
              h('div', { class: 'grow' }, h('b', {}, a.name), a.altName ? h('div', {}, a.altName) : null, h('div', { class: 'mono muted' }, a.id)),
              a.female ? badge('female', 'bad') : null,
              a.owner === 'blocked' ? badge('blocked by you', 'bad') : null,
              a.owner === 'blocked' ? null : h('div', { class: 'actions' }, action('Block', () => blockArtist(a, refresh), { small: true, kind: 'danger' })),
            ),
          ),
        ),
        h(
          'div',
          { class: 'row spread' },
          action('Previous', () => { state.offset = Math.max(0, offset - l.limit); render(); }, { kind: 'quiet', small: true }),
          h('span', { class: 'muted' }, l.total === 0 ? 'nothing' : `${offset + 1}–${Math.min(l.total, offset + l.matches.length)} of ${num(l.total)}`),
          action('Next', () => { if (offset + l.limit < l.total) { state.offset = offset + l.limit; render(); } }, { kind: 'quiet', small: true }),
        ),
      ),
    );
    return out;
  };

  // --- YouTube: find artists and songs to allow ---

  pages.youtube = async (state) => {
    const input = h('input', { type: 'search', placeholder: 'An artist or a song', value: state.yq || '', autocomplete: 'off' });
    const results = h('div', {});
    const run = async () => {
      const query = input.value.trim();
      state.yq = query;
      if (query.length < 2) return toast('Type at least two letters.', true);
      results.replaceChildren(h('p', { class: 'muted' }, 'Searching YouTube Music…'));
      try {
        const d = await api('youtube/search', { query });
        state.yresult = d;
        showResults(results, d, run);
      } catch (err) {
        results.replaceChildren(h('div', { class: 'notice bad' }, err.message));
      }
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && run());
    if (state.yresult) showResults(results, state.yresult, run);
    return [
      card(
        'Find on YouTube Music',
        h('p', { class: 'muted' }, "Search the way the bot does. An artist you allow here is allowed by their channel id; a song you allow is allowed by itself, with its artist still off the list. The bot cannot tell who is a woman: every allow asks for your word."),
        h('div', { class: 'row' }, input, action('Search', run)),
      ),
      results,
    ];
  };

  function showResults(box, d, again) {
    const refresh = async () => {
      // A fresh answer, so the standing badges are right after an allow or a block.
      const fresh = await api('youtube/search', { query: d.query }).catch(() => undefined);
      if (fresh) {
        Object.assign(d, fresh);
        showResults(box, d, again);
      }
    };
    const out = [h('p', { class: 'muted' }, d.summary), d.turnedAway ? h('div', { class: 'notice' }, 'YouTube is turning this host away for the moment, so songs cannot be sent until it stops, but you can still decide who is allowed.') : null];
    out.push(
      card(
        `Artists (${d.artists.length})`,
        d.artists.length === 0
          ? h('p', { class: 'muted' }, 'No artists found.')
          : h(
              'ul',
              { class: 'list' },
              d.artists.map((a) =>
                h(
                  'li',
                  {},
                  a.picture ? h('img', { class: 'avatar', src: a.picture, alt: '' }) : h('div', { class: 'avatar' }),
                  h(
                    'div',
                    { class: 'grow' },
                    h('b', {}, a.name),
                    a.detail ? h('div', { class: 'muted' }, a.detail) : null,
                    h('div', { class: 'mono muted' }, a.id),
                    a.samples.length > 0 ? h('div', { class: 'muted' }, 'e.g. ', a.samples.map((s) => s.title).join(' · ')) : null,
                    h('div', {}, standingBadge(a.standing)),
                  ),
                  h(
                    'div',
                    { class: 'actions' },
                    a.standing === 'blocked' ? action('Unblock', async () => { toast((await api('artists/unblock', { id: a.id })).message); refresh(); }, { small: true, kind: 'quiet' }) : null,
                    ['allowed', 'listed', 'female'].includes(a.standing) ? null : action('Allow…', () => allowArtist(a, refresh), { small: true }),
                    a.standing === 'allowed' ? action('Remove', async () => { toast((await api('artists/unallow', { id: a.id })).message); refresh(); }, { small: true, kind: 'quiet' }) : null,
                    a.standing === 'blocked' ? null : action('Block', () => blockArtist(a, refresh), { small: true, kind: 'danger' }),
                  ),
                ),
              ),
            ),
      ),
      card(
        `Songs (${d.songs.length})`,
        d.songs.length === 0 ? h('p', { class: 'muted' }, 'No songs found.') : h('ul', { class: 'list' }, d.songs.map((s) => songRow(s, refresh))),
      ),
    );
    box.replaceChildren(...out.filter(Boolean));
  }

  /** A song found on YouTube, with what the bot would do with it and the buttons to allow it by itself. */
  function songRow(s, refresh) {
    const buttons = [];
    if (s.allowedByYou) buttons.push(action('Remove', async () => { toast((await api('songs/unallow', { videoId: s.videoId })).message); refresh(); }, { small: true, kind: 'quiet' }));
    else if (!s.allowed && s.canAllow) {
      buttons.push(
        action('Allow this song…', async () => {
          if (!(await confirmNoWomen(`Allow “${s.title}”?`, `Only this song, by ${s.artist || 'its artist'}; the artist stays off the list. Today it is held back because ${s.verdict}.`))) return;
          const done = await api('songs/allow', { videoId: s.videoId, title: s.title, artist: s.artist, artistIds: s.artistIds, noWomenConfirmed: true });
          toast(done.message);
          refresh();
        }, { small: true }),
      );
    }
    return h(
      'li',
      {},
      s.cover ? h('img', { class: 'cover', src: s.cover, alt: '' }) : h('div', { class: 'cover' }),
      h(
        'div',
        { class: 'grow' },
        h('b', {}, s.title),
        h('div', { class: 'muted' }, [s.artist, s.album].filter(Boolean).join(' · ')),
        h('div', { class: 'mono muted' }, s.videoId),
        h('div', {}, s.allowed ? badge(s.allowedByYou ? 'allowed by you' : 'may be sent', 'ok') : badge(`held back: ${s.verdict}`, 'warn'), ' ', (s.artists || []).map((a) => h('span', { class: 'muted' }, `${a.name} `, standingBadge(a.standing), ' '))),
      ),
      h('div', { class: 'actions' }, buttons),
    );
  }

  // --- Songs ---

  pages.songs = async (state) => {
    const d = await api('songs');
    const refresh = () => render();
    const filter = (state.sq || '').toLowerCase();
    const out = [];
    out.push(
      card(
        `Allowed one by one (${d.allowed.length})`,
        h('p', { class: 'muted' }, "These songs go out even though their artist is not on the list. A credited artist you block, or one Zemer's list flags as a woman, still stops them, and a song on Zemer's blocked list stays blocked until you unblock that very song."),
        d.allowed.length === 0
          ? h('p', { class: 'muted' }, 'None. Find a song on the YouTube tab, or add one below.')
          : h('ul', { class: 'list' }, d.allowed.map((s) => h('li', {}, h('div', { class: 'grow' }, h('b', {}, s.title), h('div', { class: 'muted' }, s.artist || 'artist unknown'), h('div', { class: 'mono muted' }, s.id), h('div', { class: 'muted' }, `allowed ${when(s.at)}`), s.holding ? h('div', {}, badge(`held back: ${s.holding}`, 'warn')) : badge('may be sent', 'ok')), h('div', { class: 'actions' }, action('Remove', async () => { toast((await api('songs/unallow', { videoId: s.id })).message); refresh(); }, { small: true, kind: 'quiet' }))))),
      ),
    );
    const idBox = h('input', { type: 'text', class: 'inline', placeholder: 'YouTube video id (11 characters)', autocomplete: 'off', spellcheck: 'false' });
    const titleBox = h('input', { type: 'text', class: 'inline', placeholder: 'Title', autocomplete: 'off' });
    const artistBox = h('input', { type: 'text', class: 'inline', placeholder: 'Artist', autocomplete: 'off' });
    out.push(
      card(
        'Allow a song by its video id',
        h('p', { class: 'muted' }, 'The id is the v= part of a YouTube Music link. With no channel ids known here, only Zemer’s blocks and your blocks of artists the song is later found under can stop it, so prefer the YouTube tab.'),
        h('div', { class: 'row' }, idBox, titleBox, artistBox),
        action('Allow…', async () => {
          if (!(await confirmNoWomen('Allow this song?', 'Only this song, by itself.'))) return;
          const done = await api('songs/allow', { videoId: idBox.value.trim(), title: titleBox.value.trim(), artist: artistBox.value.trim(), artistIds: [], noWomenConfirmed: true });
          toast(done.message);
          refresh();
        }),
      ),
    );
    out.push(
      card(
        `Zemer’s blocked songs you unblocked (${d.unblocked.length})`,
        d.unblocked.length === 0
          ? h('p', { class: 'muted' }, 'None.')
          : h('ul', { class: 'list' }, d.unblocked.map((s) => h('li', {}, h('div', { class: 'grow' }, h('b', {}, s.title), h('div', { class: 'mono muted' }, s.id), h('div', { class: 'muted' }, `unblocked ${when(s.at)}`)), h('div', { class: 'actions' }, action('Block again', async () => { toast((await api('songs/reblock', { videoId: s.id })).message); refresh(); }, { small: true, kind: 'danger' }))))),
      ),
    );
    const box = h('input', { type: 'search', placeholder: 'Filter by id or title', value: state.sq || '', autocomplete: 'off' });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.sq = box.value.trim(); render(); } });
    const shown = d.blocked.filter((s) => !filter || s.id.toLowerCase().includes(filter) || (s.title || '').toLowerCase().includes(filter));
    out.push(
      card(
        `Blocked by Zemer's list (${num(d.blockedTotal)})`,
        h('p', { class: 'muted' }, "Zemer blocks these songs even when their artist is on its list; the list has no titles, so a name shows only for songs the bot has seen."),
        h('div', { class: 'row' }, box),
        h(
          'ul',
          { class: 'list' },
          shown.slice(0, 100).map((s) =>
            h(
              'li',
              {},
              h('div', { class: 'grow' }, s.title ? h('b', {}, s.title) : null, h('div', { class: 'mono muted' }, s.id)),
              s.unblocked ? badge('unblocked by you', 'warn') : h('div', { class: 'actions' }, action('Unblock…', async () => {
                if (!(await confirmNoWomen('Unblock this song?', `Zemer’s list blocks it${s.title ? ` (${s.title})` : ''}, perhaps because a woman sings on it. Only this song is let through, and its artists must still be allowed.`, 'Unblock'))) return;
                toast((await api('songs/unblock', { videoId: s.id, title: s.title || '', noWomenConfirmed: true })).message);
                refresh();
              }, { small: true, kind: 'danger' })),
            ),
          ),
        ),
        shown.length > 100 ? h('p', { class: 'muted' }, `${shown.length - 100} more: filter to see them.`) : null,
      ),
    );
    return out;
  };

  // --- Library ---

  pages.library = async (state) => {
    const q = state.lq || '';
    const d = await api(`library?q=${encodeURIComponent(q)}`);
    const refresh = () => render();
    const out = [];
    const c = d.counts;
    out.push(
      card(
        'What the catalog holds',
        dl([
          ['Songs', num(c.tracks)],
          ['Artists (from credits)', num(c.artists)],
          ['music-table.com posts', num(c.sitePosts)],
          ['Plays recorded', num(c.plays)],
          ['Artists followed', num(c.follows)],
          ['Songs kept on disk', num(c.audioCache)],
          ["Zemer's releases stored", num(c.zemerReleases)],
          ['Menus and pages (views)', num(c.views)],
          ['Message links', num(c.messageLinks)],
          ['Small facts (state)', num(c.state)],
        ]),
      ),
    );
    const box = h('input', { type: 'search', placeholder: 'Search songs in the catalog', value: q, autocomplete: 'off' });
    const go = () => { state.lq = box.value.trim(); render(); };
    box.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    const trackRow = (t) =>
      h(
        'li',
        {},
        h('div', { class: 'grow' }, h('b', {}, t.title), h('div', { class: 'muted' }, t.artist), t.videoId ? h('div', { class: 'mono muted' }, t.videoId) : null, t.addedAt ? h('div', { class: 'muted' }, `added ${when(Date.parse(t.addedAt.replace(' ', 'T') + (t.addedAt.endsWith('Z') ? '' : 'Z')))}`) : null),
        t.videoId ? badge(t.allowed ? 'may be sent' : `held: ${t.verdict}`, t.allowed ? 'ok' : 'warn') : badge('music-table.com', ''),
        t.videoId && !t.allowed && t.canAllow
          ? h('div', { class: 'actions' }, action('Allow this song…', async () => {
              if (!(await confirmNoWomen(`Allow “${t.title}”?`, `Only this song, by ${t.artist || 'its artist'}. Today it is held back because ${t.verdict}.`))) return;
              toast((await api('songs/allow', { videoId: t.videoId, title: t.title, artist: t.artist, artistIds: t.artistIds || [], noWomenConfirmed: true })).message);
              refresh();
            }, { small: true }))
          : null,
      );
    out.push(
      card('Songs', h('div', { class: 'row' }, box, action('Search', go, { kind: 'quiet' })), d.search ? [h('h3', {}, `Matching “${d.search.query}”`), d.search.tracks.length === 0 ? h('p', { class: 'muted' }, 'None.') : h('ul', { class: 'list' }, d.search.tracks.map(trackRow))] : null, h('h3', {}, 'Added last'), h('ul', { class: 'list' }, d.recent.map(trackRow))),
    );

    const rel = d.releases;
    out.push(
      card(
        "Zemer's new releases",
        rel.status
          ? [
              dl([
                ['Last read', rel.status.lastAttemptAt ? when(iso(rel.status.lastAttemptAt)) : 'not yet this run'],
                ['Result', rel.status.lastOk === null ? '—' : rel.status.lastOk ? `${rel.status.inFeed} in the feed, ${rel.status.passed} pass the list` : rel.status.problem],
              ]),
              h('h3', {}, `Held back from the last read (${rel.status.held.length})`),
              rel.status.held.length === 0 ? h('p', { class: 'muted' }, 'Nothing was held back.') : h('ul', { class: 'list' }, rel.status.held.map((r) => h('li', {}, h('div', { class: 'grow' }, h('b', {}, r.title), h('div', { class: 'muted' }, `${r.artist} · ${r.songs === 1 ? 'single' : r.songs > 1 ? r.songs + ' songs' : 'release'} · ${when(Date.parse(r.releasedAt))}`), h('div', { class: 'mono muted' }, r.artistId)), badge(r.why, r.waiting ? 'warn' : 'bad')))),
            ]
          : h('p', { class: 'muted' }, 'Off, or the bot is not up yet.'),
        h('h3', {}, `Stored (${rel.stored.length})`),
        rel.stored.length === 0 ? h('p', { class: 'muted' }, 'None stored.') : h('ul', { class: 'list' }, rel.stored.map((r) => h('li', {}, h('div', { class: 'grow' }, h('b', {}, r.title), h('div', { class: 'muted' }, `${r.artist} · ${r.songs === 1 ? 'single' : r.songs > 1 ? r.songs + ' songs' : 'release'} · out ${when(Date.parse(r.releasedAt))}`), h('div', { class: 'muted' }, `first seen ${when(Date.parse(r.firstSeenAt))}${r.announcedAt ? ' · in a daily message' : ''}${r.alertedAt ? ' · alerted' : ''}`)), r.inNew ? badge('in “new”', 'ok') : badge('held back now', 'warn')))),
        h('ul', { class: 'list' }, ACTIONS.filter((a) => a[0] === 'refresh-releases').map((a) => actionRow(a, {}, null))),
      ),
    );

    out.push(card('Menus and pages the chat has opened', d.views.length === 0 ? h('p', { class: 'muted' }, 'None.') : h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', 'kind', 'of', 'lines', 'last used'].map((x) => h('th', {}, x)))), h('tbody', {}, d.views.map((v) => h('tr', {}, h('td', {}, v.id), h('td', {}, v.kind), h('td', { class: 'mono' }, v.key), h('td', {}, v.shown), h('td', {}, ago(Date.parse(v.usedAt)))))))))) ;

    const j = d.jobs;
    out.push(
      card(
        'Background jobs',
        j
          ? dl([
              ['Site sync', j.lastSync ? `${when(iso(j.lastSync))}, next due ${j.nextSyncDue ? when(iso(j.nextSyncDue)) : '—'}` : 'never'],
              ['Site failures in a row', j.siteFailures],
              ['Whole-site scan', j.scan.done ? `done ${when(iso(j.scan.done))}` : `${num(j.scan.offset)} posts read`],
              ['Daily message', j.digest.at ? `${j.digest.at}, last for ${j.digest.lastDate ?? '—'}, sent ${j.digest.lastSentAt ? when(iso(j.digest.lastSentAt)) : 'never'}${j.digest.retryAfter ? `, retry after ${when(iso(j.digest.retryAfter))}` : ''}` : 'off'],
              ['Alerts', j.alertFailing ? badge('failing: tried again every minute', 'warn') : 'ok'],
              ["Zemer's feed", j.releasesFailing ? badge('failing', 'warn') : 'ok'],
              ['Songs kept ready', j.cache ? `${j.cache.files} on disk (${Math.round(j.cache.bytes / 1048576)} MB)` : 'none (this host keeps none)'],
              ['Busy now', j.busy ? 'yes' : 'no'],
            ])
          : h('p', { class: 'muted' }, 'Not running: music-table.com is off, or the bot is not up yet.'),
        h('ul', { class: 'list' }, ACTIONS.filter((a) => ['sync-site', 'prefetch', 'digest-preview', 'digest-send', 'alerts-check'].includes(a[0])).map((a) => actionRow(a, {}, null))),
      ),
    );
    if (d.oneDrive) out.push(card('OneDrive', dl([['Signed in', d.oneDrive.connected ? 'yes' : 'no'], ['Saved this month', d.oneDrive.savedThisMonthMb === undefined ? '—' : `${num(d.oneDrive.savedThisMonthMb)} MB`], ['Monthly allowance', d.oneDrive.monthlyLimitMb === null ? 'no limit' : `${num(d.oneDrive.monthlyLimitMb)} MB`], ['Error', d.oneDrive.error]])));
    return out;
  };

  // --- Settings ---

  pages.settings = async (state) => {
    const d = await api('settings');
    const refresh = () => render();
    const filter = (state.setq || '').toLowerCase();
    const filterBox = h('input', { type: 'search', placeholder: 'Filter settings', value: state.setq || '', autocomplete: 'off' });
    filterBox.addEventListener('input', () => { state.setq = filterBox.value.trim(); renderGroups(); });
    const holder = h('div', {});
    const sourceBadge = (s) => (s.source === 'override' ? badge('set in the console', 'warn') : s.source === 'environment' ? badge("Render's environment", '') : badge('default', ''));

    function settingRow(s) {
      const body = [];
      body.push(
        h('div', { class: 'title' }, h('b', {}, s.label), h('span', { class: 'mono muted' }, s.key), s.live ? badge('live', 'ok') : badge('needs a restart', ''), s.secret ? badge('secret', '') : null),
        h('div', { class: 'muted' }, s.note),
      );
      if (s.secret) body.push(h('div', {}, s.isSet ? badge('set', 'ok') : badge('not set', ''), ' ', h('span', { class: 'muted' }, 'The value is never shown.')));
      else body.push(h('div', {}, s.value !== null ? h('code', {}, s.value) : h('span', { class: 'muted' }, s.default ? `not set (default ${s.default})` : 'not set'), ' ', sourceBadge(s)));
      if (s.live) {
        const input = h('input', { type: 'text', class: 'inline', value: s.value ?? '', placeholder: s.example, autocomplete: 'off' });
        body.push(
          h('div', { class: 'muted' }, s.hint),
          h('div', { class: 'row' }, input, action('Save', async () => { toast((await api('settings/set', { key: s.key, value: input.value })).message); refresh(); }, { small: true }), s.source === 'override' ? action("Use Render's value", async () => { toast((await api('settings/clear', { key: s.key })).message); refresh(); }, { small: true, kind: 'quiet' }) : null),
          s.source === 'override' ? h('div', { class: 'muted' }, `Render's environment says ${s.environment === null ? 'nothing' : s.environment}; the console's value wins until you go back to it.`) : null,
        );
      } else body.push(h('div', { class: 'muted' }, 'Change it in Render (Environment); that restarts the bot, about a minute.'));
      return h('div', { class: 'setting' }, body);
    }

    function renderGroups() {
      const groups = new Map();
      for (const s of d.settings) {
        const hay = `${s.key} ${s.label} ${s.note} ${s.group}`.toLowerCase();
        if (state.setq && !hay.includes(filter)) continue;
        if (!groups.has(s.group)) groups.set(s.group, []);
        groups.get(s.group).push(s);
      }
      holder.replaceChildren(...[...groups].map(([name, rows]) => card(name, rows.map(settingRow))));
      if (groups.size === 0) holder.replaceChildren(h('p', { class: 'muted' }, 'No setting matches.'));
    }
    renderGroups();
    const live = d.settings.filter((s) => s.live).length;
    return [card('Settings', h('p', {}, `${live} settings can change while the bot runs; they are marked live and sit over Render's environment. ${d.restart}`), h('p', { class: 'muted' }, 'Secrets show only whether they are set. The console cannot change Render.'), filterBox), holder];
  };

  // --- Follows ---

  pages.follows = async () => {
    const d = await api('follows');
    const refresh = () => render();
    const box = h('input', { type: 'text', class: 'inline', placeholder: 'Artist name, as the menus write it', autocomplete: 'off' });
    return [
      card(
        `Artists you follow (${d.following.length})`,
        d.following.length === 0 ? h('p', { class: 'muted' }, 'No one yet.') : h('ul', { class: 'list' }, d.following.map((a) => h('li', {}, h('div', { class: 'grow' }, h('b', {}, a.name), h('div', { class: 'muted' }, `${a.songs} song${a.songs === 1 ? '' : 's'} in the catalog${a.auto ? ' · followed for you after several plays' : ''}`)), h('div', { class: 'actions' }, action('Unfollow', async () => { toast((await api('follows/remove', { name: a.name })).message); refresh(); }, { small: true, kind: 'danger' }))))),
      ),
      card('Follow an artist', h('p', { class: 'muted' }, 'The artist must already be in the catalog (a song by them has been seen). New releases by followed artists are texted to you as alerts.'), h('div', { class: 'row' }, box, action('Follow', async () => { toast((await api('follows/add', { name: box.value })).message); refresh(); }))),
    ];
  };

  // --- Account: the owner's own user name and password ---

  pages.account = async () => {
    const d = await api('account');
    const refresh = () => render();
    const user = h('input', { type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', value: d.user || '' });
    const password = h('input', { type: 'password', name: 'new-password', autocomplete: 'new-password' });
    const again = h('input', { type: 'password', autocomplete: 'new-password' });
    const current = h('input', { type: 'password', autocomplete: 'off' });
    const message = h('div', {});
    const form = h(
      'form',
      {},
      h('label', {}, 'User name'),
      user,
      h('label', {}, `New password (at least ${d.policy.minPasswordChars} characters; a few words in a row make a good one)`),
      password,
      h('label', {}, 'New password again'),
      again,
      h('label', {}, d.set ? 'Your current password' : "The host's ADMIN_TOKEN (the first time, it is the way in)"),
      current,
      message,
      h('div', { class: 'row gap' }, h('button', { type: 'submit' }, d.set ? 'Change user name and password' : 'Set my user name and password')),
    );
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.replaceChildren();
      const say = (text) => message.replaceChildren(h('div', { class: 'notice bad' }, text));
      if (password.value !== again.value) return say('The two new passwords are not the same.');
      try {
        const done = await api('account/set', { user: user.value, password: password.value, current: current.value });
        // Every browser was signed out by the change: sign this one in again with the new password.
        const res = await fetch('/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-admin-console': '1' }, body: JSON.stringify({ user: user.value, password: password.value }) });
        toast(res.ok ? done.message : `${done.message} Sign in again with them.`);
        if (!res.ok) return location.assign('/login');
        refresh();
      } catch (err) {
        say(err.message);
      }
    });
    const sessions = d.sessions;
    return [
      card(
        'Your sign-in',
        d.set
          ? dl([['User name', d.user], ['Changed', when(d.changedAt)], ['ADMIN_TOKEN', d.tokenSet ? 'still signs in with any user name: the recovery way in' : 'not set in Render']])
          : [h('p', {}, "You haven't made your own yet: you sign in with the host's ADMIN_TOKEN (any user name)."), dl([['ADMIN_TOKEN', d.tokenSet ? 'set in Render' : 'not set']])],
        h('p', { class: 'muted' }, 'Your user name and password are kept in the database as a salted hash (never the password itself), not in Render. ADMIN_TOKEN stays in Render for the Worker and the check script, and as the way back in if you forget the password.'),
      ),
      card(d.set ? 'Change your user name and password' : 'Make your own user name and password', form),
      card(
        'Browsers signed in',
        sessions.length === 0 ? h('p', { class: 'muted' }, 'None are recorded (this one signed in with the ADMIN_TOKEN header).') : h('ul', { class: 'list' }, sessions.map((s) => h('li', {}, h('div', { class: 'grow' }, h('b', {}, s.current ? 'This browser' : 'Another browser'), h('div', { class: 'muted' }, `signed in ${when(s.at)}, until ${when(s.expiresAt)}`)), s.current ? badge('this one', 'ok') : null))),
        h('div', { class: 'row gap' }, action('Sign out everywhere', async () => { await api('account/signout-all', {}); location.assign('/login'); }, { kind: 'danger' }), d.set ? action('Remove my user name and password', async () => {
          const current = await askPassword('Remove your user name and password?', 'Only ADMIN_TOKEN will sign in after this.', 'Remove');
          if (current === undefined) return;
          toast((await api('account/clear', { current })).message);
          location.assign('/login');
        }, { kind: 'danger' }) : null),
      ),
    ];
  };

  // --- Activity (the log) and the changes made here ---

  pages.activity = async (state) => {
    const level = state.level || 'all';
    const search = state.logq || '';
    const d = await api(`log?limit=500&level=${level}&search=${encodeURIComponent(search)}`);
    const box = h('input', { type: 'search', placeholder: 'Filter the lines', value: search, autocomplete: 'off' });
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.logq = box.value.trim(); render(); } });
    const levelSel = h('select', {}, h('option', { value: 'all' }, 'All lines'), h('option', { value: 'problems' }, 'Warnings and errors'));
    levelSel.value = level;
    levelSel.addEventListener('change', () => { state.level = levelSel.value; render(); });
    const log = h('div', { class: 'log' }, d.lines.length === 0 ? h('div', { class: 'muted' }, 'Nothing logged yet.') : d.lines.map((l) => h('div', { class: l.level }, h('time', {}, clock(l.at)), l.text)));
    setTimeout(() => (log.scrollTop = log.scrollHeight), 0);
    return [card('Recent activity', h('p', { class: 'muted' }, `The last ${d.kept} lines the bot logged (up to 500, kept in memory only and cleared at every restart; secrets are masked). Render's own logs have the rest.`), h('div', { class: 'row' }, levelSel, box, action('Refresh', () => render(), { kind: 'quiet' })), log)];
  };

  pages.changes = async () => {
    const d = await api('audit');
    return [
      card(
        'Changes made here',
        h('p', { class: 'muted' }, 'Every change made from this console, newest first. (Artists you allow or block by texting the bot are not listed.)'),
        d.entries.length === 0 ? h('p', { class: 'muted' }, 'Nothing yet.') : h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'What', 'About', 'From', 'To'].map((x) => h('th', {}, x)))), h('tbody', {}, d.entries.map((e) => h('tr', {}, h('td', {}, when(e.at)), h('td', {}, e.what), h('td', {}, e.detail || ''), h('td', {}, e.from || ''), h('td', {}, e.to || '')))))),
      ),
    ];
  };

  // ---------- the router ----------

  const TABS = [
    ['overview', 'Overview'],
    ['artists', 'Artists'],
    ['youtube', 'YouTube'],
    ['songs', 'Songs'],
    ['library', 'Library'],
    ['settings', 'Settings'],
    ['account', 'Account'],
    ['follows', 'Follows'],
    ['activity', 'Activity'],
    ['changes', 'Changes'],
  ];
  const state = {};
  let drawing = 0;

  function currentTab() {
    const id = location.hash.replace(/^#/, '');
    return TABS.some(([key]) => key === id) ? id : 'overview';
  }

  async function render() {
    const tab = currentTab();
    const mine = ++drawing;
    for (const link of tabsBar.children) if (link.dataset.tab === tab) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    document.getElementById('whereami').textContent = TABS.find(([key]) => key === tab)[1];
    try {
      const nodes = await pages[tab](state);
      if (mine !== drawing) return;
      view.replaceChildren(...[nodes, tab === 'overview' || tab === 'library' ? h('div', { class: 'row' }, action('Refresh this page', () => render(), { kind: 'quiet' })) : null].flat().filter(Boolean));
    } catch (err) {
      if (mine !== drawing) return;
      view.replaceChildren(h('div', { class: 'notice bad' }, err.message), action('Try again', () => render()));
    }
  }

  document.getElementById('signout').addEventListener('click', async () => {
    try {
      await fetch('/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-admin-console': '1' }, body: '{}' });
    } finally {
      location.assign('/login');
    }
  });

  for (const [id, label] of TABS) tabsBar.append(h('a', { href: `#${id}`, 'data-tab': id }, label));
  window.addEventListener('hashchange', render);
  render();
})();
