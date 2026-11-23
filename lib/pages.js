const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMin = (m) => Number(m || 0).toLocaleString('en-US');

// ---------- Theme → CSS variables ----------
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
const mix = (hex, other, t) => { const a = rgb(hex), b = rgb(other); return toHex(a.map((v, i) => v + (b[i] - v) * t)); };
const lum = (hex) => { const [r, g, b] = rgb(hex).map((v) => v / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
function themeCss(t) {
  const light = lum(t.bg) > 0.5;
  const toward = light ? '#000000' : '#ffffff';
  return `<style>:root{
    --bg:${t.bg};--panel:${mix(t.bg, toward, 0.05)};--panel2:${mix(t.bg, toward, 0.09)};--line:${mix(t.bg, toward, 0.16)};
    --text:${light ? '#14181d' : '#e6edf3'};--muted:${light ? '#5b6672' : '#8b9bab'};
    --accent:${t.accent};--accent-text:${lum(t.accent) > 0.45 ? '#0b1520' : '#ffffff'};
  }</style>`;
}

function layout({ title, body, theme, head = '', bodyClass = '' }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/styles.css">
${theme ? themeCss(theme) : ''}
${head}
</head><body class="${bodyClass}">${body}</body></html>`;
}

const brand = (t) => (t && t.logo
  ? `<div class="brand"><img class="brand-logo" src="/brand/${esc(t.id)}.png?v=${t.logo}" alt="${esc(t.brandName)}"></div>`
  : `<div class="brand"><span class="brand-dot"></span>${esc((t && t.brandName) || 'DroneView')}</div>`);

const ROLE_LABEL = { admin: 'Admin', collab: 'Collaborator', user: 'User' };
function topbar(user, theme) {
  return `<header class="topbar">${brand(theme)}
    <nav class="nav">
      <a href="/dashboard">Rooms</a>
      ${user.role === 'admin' ? '<a href="/admin/accounts">Accounts</a>' : ''}
      <span class="who">${esc(user.username)} <span class="pill">${ROLE_LABEL[user.role]}</span></span>
      <form method="post" action="/logout"><button class="btn ghost">Log out</button></form>
    </nav></header>`;
}
const flash = (q = {}) => (q.error ? `<p class="error">${esc(q.error)}</p>` : q.ok ? `<p class="ok">${esc(q.ok)}</p>` : '');

// Open Graph tags so the share link shows a nice preview card in WhatsApp/Slack/iMessage.
const ogTags = (room, base, theme) => `
<meta property="og:title" content="${esc(room.name)} · Live drone feeds">
<meta property="og:description" content="${room.feeds.length} live drone feeds on ${esc(theme.brandName)} · passcode required">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(base)}/v/${esc(room.slug)}">
<meta name="robots" content="noindex">`;

const logoUrl = (room) => (room.logo ? `/logo/${encodeURIComponent(room.slug)}.png?v=${room.logo}` : null);
const logoField = (label, hint = 'PNG, under 1 MB. A transparent background looks best.') => `<label class="logo-field">${label}
  <input type="file" accept="image/png" data-logo-file><input type="hidden" name="logo">
  <span class="hint">${hint}</span></label>`;

// ---------- Simple pages ----------
exports.notFound = () => layout({ title: 'Not found', bodyClass: 'center', body: `<div class="card narrow">${brand()}<h1>Not found</h1><p class="muted">This page or link doesn't exist or was removed.</p></div>` });
exports.forbidden = (theme) => layout({ title: 'No access', theme, bodyClass: 'center', body: `<div class="card narrow">${brand(theme)}<h1>No access</h1><p class="muted">Only the platform admin can open this page.</p><a class="btn" href="/dashboard">Back</a></div>` });

exports.login = (theme, error) => layout({
  title: `Log in · ${theme.brandName}`,
  theme,
  bodyClass: 'center',
  body: `<form class="card narrow" method="post" action="/login">
    ${brand(theme)}<h1>Log in</h1>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <label>Username<input name="username" autocomplete="username" autocapitalize="none" autofocus required></label>
    <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
    <button class="btn primary" type="submit">Log in</button>
  </form>`,
});

// ---------- Viewer pages ----------
exports.passcode = (room, theme, base, error) => layout({
  title: `${room.name} · Live`,
  theme,
  head: ogTags(room, base, theme),
  bodyClass: 'center',
  body: `<form class="card narrow" method="post">
    ${brand(theme)}
    ${logoUrl(room) ? `<img class="room-logo" src="${logoUrl(room)}" alt="">` : ''}
    <h1>${esc(room.name)}</h1>
    <p class="muted">${room.feeds.length} live drone feeds. Enter the passcode to watch.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <label>Passcode<input type="password" name="passcode" autocomplete="off" autofocus required></label>
    <button class="btn primary" type="submit">Watch live</button>
  </form>`,
});

exports.unavailable = (room, theme) => layout({
  title: `${room.name} · Unavailable`,
  theme,
  bodyClass: 'center',
  body: `<div class="card narrow">${brand(theme)}
    ${logoUrl(room) ? `<img class="room-logo" src="${logoUrl(room)}" alt="">` : ''}
    <h1>${esc(room.name)}</h1>
    <p class="muted">This live stream is currently unavailable. Please contact the organiser.</p></div>`,
});

exports.multiview = (room, theme, base) => layout({
  title: `${room.name} · Live`,
  theme,
  head: ogTags(room, base, theme),
  bodyClass: 'viewer',
  body: `<header class="vbar">
      ${brand(theme)}<div class="vtitle">${esc(room.name)}</div>
      <div class="vstat"><span id="liveCount">0</span>/${room.feeds.length} live</div>
      <button class="btn ghost" id="fsBtn" title="Fullscreen">⛶ Fullscreen</button>
    </header>
    <main id="grid" class="grid"></main>
    <script>window.DV = ${JSON.stringify({ slug: room.slug, logo: logoUrl(room), feeds: room.feeds.map((f) => ({ id: f.id, label: f.label })) })};</script>
    <script src="/static/mpegts.js"></script>
    <script src="/static/viewer.js"></script>`,
});

// ---------- Dashboard ----------
function usageCard(usage) {
  const { usedMinutes, limitMinutes, liveFeeds } = usage;
  const pct = limitMinutes ? Math.min(100, Math.round((usedMinutes / limitMinutes) * 100)) : 0;
  const remaining = limitMinutes != null ? Math.max(0, limitMinutes - usedMinutes) : null;
  return `<section class="card" data-usage>
    <h2>Live-stream minutes</h2>
    <div class="stats">
      <div class="stat"><div class="stat-num" data-used>${fmtMin(usedMinutes)}</div><div class="stat-label">minutes used</div></div>
      <div class="stat"><div class="stat-num" data-remaining>${remaining == null ? '∞' : fmtMin(remaining)}</div><div class="stat-label">minutes remaining</div></div>
      <div class="stat"><div class="stat-num">${limitMinutes == null ? 'Unlimited' : fmtMin(limitMinutes)}</div><div class="stat-label">plan limit</div></div>
      <div class="stat"><div class="stat-num" data-live>${liveFeeds}</div><div class="stat-label">drones live now</div></div>
    </div>
    ${limitMinutes != null ? `<div class="meter"><div class="meter-fill ${pct >= 90 ? 'warn' : ''}" data-meter style="width:${pct}%"></div></div>` : ''}
    <p class="hint">Every live drone counts: 10 drones live for 1 hour uses 600 minutes. Updates every 15 seconds.</p>
  </section>`;
}

function roomsTable(rooms, live, base, { showOwner, users, usage }) {
  if (!rooms.length) return '<p class="muted">No rooms yet.</p>';
  const minutesById = Object.fromEntries((usage && usage.rooms || []).map((r) => [r.id, r.minutes]));
  const ownerName = (id) => esc((users.find((u) => u.id === id) || {}).username || '—');
  return `<table class="table">
    <thead><tr><th>Name</th>${showOwner ? '<th>Owner</th>' : ''}<th>Live</th><th>Minutes</th><th>Share link</th><th></th></tr></thead><tbody>
    ${rooms.map((r) => {
      const n = r.feeds.filter((f) => live.has(f.key)).length;
      return `<tr><td>${esc(r.name)}</td>${showOwner ? `<td>${ownerName(r.ownerId)}</td>` : ''}
        <td><span class="pill ${n ? 'on' : ''}">${n}/${r.feeds.length}</span></td>
        <td>${fmtMin(minutesById[r.id] ?? Math.floor((r.usedSeconds || 0) / 60))}</td>
        <td><code>${esc(base)}/v/${esc(r.slug)}</code></td><td><a class="btn" href="/rooms/${r.id}">Manage</a></td></tr>`;
    }).join('')}
    </tbody></table>`;
}

exports.dashboard = ({ user, theme, rooms, users, live, base, usage, q }) => layout({
  title: `Rooms · ${theme.brandName}`,
  theme,
  body: `${topbar(user, theme)}
  <div class="wrap">
    ${flash(q)}
    ${usage.block ? `<div class="banner"><b>Streaming is paused on your account.</b><br>${esc(usage.block.message)}</div>` : ''}
    ${user.role === 'user' ? usageCard(usage) : ''}
    <section class="card">
      <h2>New stream room</h2>
      <p class="muted">A room is one share link with up to 16 drone feeds (default 10). Each feed gets its own RTMP URL for a DJI remote.</p>
      <form method="post" action="/rooms" class="row">
        <label>Room name<input name="name" placeholder="e.g. Site inspection – North block" required></label>
        <label>Viewer passcode<input name="passcode" minlength="4" required></label>
        <label class="small">Feeds<input name="feedCount" type="number" min="1" max="16" value="10"></label>
        ${user.role !== 'collab' ? logoField('Logo (optional, shown bottom-left of every feed)') : ''}
        <button class="btn primary" type="submit">Create room</button>
      </form>
    </section>
    <section class="card">
      <h2>${user.role === 'admin' ? 'All rooms' : 'Your rooms'}</h2>
      ${roomsTable(rooms, live, base, { showOwner: user.role === 'admin', users, usage: user.role === 'admin' ? null : usage })}
    </section>
    ${user.role !== 'admin' ? `<section class="card">
      <h2>Change password</h2>
      <form method="post" action="/account/password" class="row">
        <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
        <label>New password<input type="password" name="password" minlength="8" autocomplete="new-password" required></label>
        <button class="btn" type="submit">Change</button>
      </form></section>` : ''}
  </div>
  <script src="/static/admin.js"></script>`,
});

// ---------- Room management ----------
exports.room = ({ user, theme, room, owner, ownerBlock, live, base, rtmpBase, q }) => {
  const share = `${base}/v/${room.slug}`;
  const canLogo = user.role !== 'collab';
  return layout({
    title: `${room.name} · ${theme.brandName}`,
    theme,
    body: `${topbar(user, theme)}
  <div class="wrap">
    <a class="backlink" href="/dashboard">← All rooms</a>
    ${flash(q)}
    ${ownerBlock ? `<div class="banner"><b>Streaming is paused for this ${user.role === 'admin' ? `room's owner (${esc(owner.username)})` : 'account'}.</b><br>${esc(ownerBlock.message)}</div>` : ''}
    <section class="card">
      <h2>${esc(room.name)}</h2>
      ${user.role === 'admin' && owner ? `<p class="muted">Owner: ${esc(owner.username)} (${ROLE_LABEL[owner.role]})</p>` : ''}
      <div class="share">
        <div><div class="label">Share link (opens multi-view after passcode)</div><code id="shareUrl">${esc(share)}</code></div>
        <button class="btn primary" data-copy="${esc(share)}">Copy link</button>
        <a class="btn" href="/v/${esc(room.slug)}" target="_blank">Open multi-view</a>
      </div>
    </section>

    <section class="card">
      <h2>Drone feeds</h2>
      <p class="muted">Paste each RTMP URL into a drone's remote controller. Treat these URLs like passwords: anyone holding one can push video into that slot.</p>
      <table class="table feeds">
        <thead><tr><th>Status</th><th>Label</th><th>RTMP URL for DJI remote</th><th></th></tr></thead>
        <tbody>
        ${room.feeds.map((f) => `<tr data-feed="${f.id}">
          <td><span class="pill ${live.has(f.key) ? 'on' : ''}" data-status>${live.has(f.key) ? 'LIVE' : 'offline'}</span></td>
          <td><input class="inline" value="${esc(f.label)}" data-label></td>
          <td><code data-url>${esc(rtmpBase)}/${esc(f.key)}</code></td>
          <td class="actions"><button class="btn" data-copy-url>Copy</button><button class="btn ghost" data-regen title="Issue a new URL and disconnect the current one">New URL</button></td>
        </tr>`).join('')}
        </tbody>
      </table>
      <details class="help"><summary>How to enter the URL in DJI apps</summary>
        <ul>
          <li><b>DJI Pilot 2</b> (Matrice / Mavic 3 Enterprise, RC Plus / RC Pro Enterprise): ••• menu → <i>Live Stream</i> → <i>RTMP</i> → paste the URL → Start.</li>
          <li><b>DJI Fly</b> (Mini / Air / Mavic consumer drones): camera view → ••• → <i>Transmission</i> → <i>Live Streaming Platforms</i> → <i>RTMP</i> → paste the URL → Start.</li>
          <li>Recommended: 720p or 1080p, 2–4 Mbps. Remote must have internet (built-in 4G, Wi-Fi or a phone hotspot).</li>
          <li>If the app has separate "server" and "stream key" fields: server = <code>${esc(rtmpBase)}</code>, key = the part after <code>/live/</code>.</li>
        </ul>
      </details>
    </section>

    <section class="card">
      <h2>Settings</h2>
      <form method="post" action="/rooms/${room.id}/settings" class="row">
        <label>Room name<input name="name" value="${esc(room.name)}"></label>
        <label>New passcode<input name="passcode" minlength="4" placeholder="leave blank to keep"></label>
        ${canLogo ? logoField(room.logo ? 'Replace logo' : 'Logo (shown bottom-left of every feed)') : ''}
        <button class="btn" type="submit">Save</button>
      </form>
      ${canLogo && room.logo ? `<div class="logo-current"><span class="logo-chip"><img src="${logoUrl(room)}" alt="Current logo"></span>
        <form method="post" action="/rooms/${room.id}/settings"><input type="hidden" name="removeLogo" value="1"><button class="btn ghost" type="submit">Remove logo</button></form></div>` : ''}
      <p class="muted">Changing the passcode signs out everyone currently watching.</p>
      <form method="post" action="/rooms/${room.id}/delete" onsubmit="return confirm('Delete this room and disconnect all its drones?')">
        <button class="btn danger" type="submit">Delete room</button>
      </form>
    </section>
  </div>
  <script>window.DV_ROOM = ${JSON.stringify(room.id)};</script>
  <script src="/static/admin.js"></script>`,
  });
};

// ---------- Admin: accounts ----------
function statusPill(acc, usage) {
  if (acc.role !== 'user') return '<span class="pill">No limit</span>';
  if (!usage.block) return '<span class="pill ok">Active</span>';
  return `<span class="pill off">${usage.block.reason === 'limit' ? 'Minutes used up' : 'Disabled'}</span>`;
}

function themeForm(action, t, { allowDefault }) {
  return `<form method="post" action="${action}" class="row">
      <label>Platform name<input name="brandName" value="${esc(t.brandName)}" maxlength="40"></label>
      <label class="small">Accent<input type="color" name="accent" value="${esc(t.accent)}"></label>
      <label class="small">Background<input type="color" name="bg" value="${esc(t.bg)}"></label>
      ${logoField(t.logo ? 'Replace brand logo' : 'Brand logo (optional, replaces the name in the header)', 'PNG, under 1 MB. Wide logos work best (about 4:1).')}
      <button class="btn primary" type="submit">Save theme</button>
    </form>
    <div class="row">
      ${t.logo ? `<span class="logo-chip"><img src="/brand/${esc(t.id)}.png?v=${t.logo}" alt=""></span>
        <form method="post" action="${action}"><input type="hidden" name="brandName" value="${esc(t.brandName)}"><input type="hidden" name="accent" value="${esc(t.accent)}"><input type="hidden" name="bg" value="${esc(t.bg)}">
        <input type="hidden" name="removeBrandLogo" value="1"><button class="btn ghost">Remove brand logo</button></form>` : ''}
      ${allowDefault ? `<form method="post" action="${action}"><input type="hidden" name="useDefault" value="1"><button class="btn ghost">Use platform theme</button></form>` : ''}
    </div>`;
}

exports.accounts = ({ user, theme, users, usage, defaultTheme, q }) => layout({
  title: `Accounts · ${theme.brandName}`,
  theme,
  body: `${topbar(user, theme)}
  <div class="wrap">
    ${flash(q)}
    <section class="card">
      <h2>New account</h2>
      <p class="muted"><b>Collaborators</b> create rooms and share links for you, without logos, themes or minute limits.
        <b>Users</b> are your customers: they create rooms, add room logos and see their minutes; you set their theme and limits.</p>
      <form method="post" action="/admin/accounts" class="row">
        <label>Username<input name="username" autocapitalize="none" required pattern="[A-Za-z0-9._\\-]{3,32}"></label>
        <label>Password<input name="password" minlength="8" required></label>
        <label class="small">Role<select name="role"><option value="user">User</option><option value="collab">Collaborator</option></select></label>
        <label class="small">Minutes limit<input name="limitMinutes" type="number" min="0" placeholder="none"></label>
        <button class="btn primary" type="submit">Create account</button>
      </form>
      <p class="hint">Leave the minutes limit empty for unlimited. It only applies to users.</p>
    </section>

    <section class="card">
      <h2>Accounts</h2>
      <table class="table">
        <thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Minutes used</th><th>Live</th><th></th></tr></thead><tbody>
        ${users.map((u) => {
          const us = usage[u.id];
          return `<tr><td>${esc(u.username)}</td><td>${ROLE_LABEL[u.role]}</td><td>${u.role === 'admin' ? '<span class="pill">Owner</span>' : statusPill(u, us)}</td>
            <td>${fmtMin(us.usedMinutes)}${u.limitMinutes != null ? ` / ${fmtMin(u.limitMinutes)}` : ''}</td>
            <td><span class="pill ${us.liveFeeds ? 'on' : ''}">${us.liveFeeds}</span></td>
            <td>${u.role === 'admin' ? '' : `<a class="btn" href="/admin/accounts/${u.id}">Manage</a>`}</td></tr>`;
        }).join('')}
        </tbody></table>
    </section>

    <section class="card">
      <h2>Platform theme</h2>
      <p class="muted">Used on the login page, your pages, collaborators' rooms, and users who don't have their own theme.</p>
      ${themeForm('/admin/theme', defaultTheme, { allowDefault: false })}
    </section>
  </div>
  <script src="/static/admin.js"></script>`,
});

exports.account = ({ user, theme, account: a, rooms, live, usage, defaultTheme, q }) => layout({
  title: `${a.username} · ${theme.brandName}`,
  theme,
  body: `${topbar(user, theme)}
  <div class="wrap">
    <a class="backlink" href="/admin/accounts">← All accounts</a>
    ${flash(q)}
    <section class="card">
      <h2>${esc(a.username)} <span class="pill">${ROLE_LABEL[a.role]}</span> ${statusPill(a, usage)}</h2>
      <div class="stats">
        <div class="stat"><div class="stat-num">${fmtMin(usage.usedMinutes)}</div><div class="stat-label">minutes used</div></div>
        <div class="stat"><div class="stat-num">${a.limitMinutes == null ? 'Unlimited' : fmtMin(a.limitMinutes)}</div><div class="stat-label">limit</div></div>
        <div class="stat"><div class="stat-num">${rooms.length}</div><div class="stat-label">rooms</div></div>
        <div class="stat"><div class="stat-num">${usage.liveFeeds}</div><div class="stat-label">drones live now</div></div>
      </div>
    </section>

    ${a.role === 'user' ? `
    <section class="card">
      <h2>Streaming</h2>
      ${usage.block ? `<p class="banner small"><b>${usage.block.reason === 'limit' ? 'Paused: minutes used up.' : 'Disabled by you.'}</b> The user sees: “${esc(usage.block.message)}”</p>` : '<p class="muted">Streaming is active.</p>'}
      <form method="post" action="/admin/accounts/${a.id}/streaming">
        <label>Message shown to the user when streaming is off
          <textarea name="message" rows="2" maxlength="500" placeholder="Leave empty for the default: Your subscription has ended. Please contact us to renew…">${esc(a.disabledMessage)}</textarea></label>
        <div class="row">
          ${a.streamingDisabled
            ? '<button class="btn primary" name="action" value="enable">Enable streaming</button>'
            : `<button class="btn danger" name="action" value="disable" onclick="return confirm('Disable streaming for ${esc(a.username)}? Their live drones will be disconnected now.')">Disable streaming</button>
               <button class="btn" name="action" value="enable">Save message</button>`}
        </div>
      </form>
    </section>

    <section class="card">
      <h2>Minutes limit</h2>
      <p class="muted">When used minutes reach the limit, streaming stops automatically and the user sees the message above. Raise the limit, add minutes or reset the counter to let them stream again.</p>
      <form method="post" action="/admin/accounts/${a.id}/limit" class="row">
        <label>Limit in minutes<input name="limitMinutes" type="number" min="0" value="${a.limitMinutes ?? ''}" placeholder="unlimited"></label>
        <button class="btn" type="submit">Set limit</button>
      </form>
      <div class="row">
        <form method="post" action="/admin/accounts/${a.id}/limit" class="row inline-form">
          <label class="small">Add minutes<input name="addMinutes" type="number" min="1" placeholder="600"></label>
          <button class="btn" type="submit">Add</button>
        </form>
        <form method="post" action="/admin/accounts/${a.id}/limit" onsubmit="return confirm('Reset used minutes to 0?')">
          <input type="hidden" name="resetUsage" value="1"><button class="btn ghost" type="submit">Reset used minutes to 0</button>
        </form>
      </div>
    </section>

    <section class="card">
      <h2>Theme</h2>
      <p class="muted">${a.theme ? 'This user has a custom theme.' : 'This user currently uses the platform theme. Saving below gives them their own.'} It is used on their dashboard and their viewers' pages.</p>
      ${themeForm(`/admin/accounts/${a.id}/theme`, a.theme || defaultTheme, { allowDefault: !!a.theme })}
    </section>` : ''}

    <section class="card">
      <h2>Rooms</h2>
      ${rooms.length ? `<table class="table"><thead><tr><th>Name</th><th>Live</th><th>Minutes</th><th></th></tr></thead><tbody>
        ${rooms.map((r) => { const n = r.feeds.filter((f) => live.has(f.key)).length; return `<tr><td>${esc(r.name)}</td><td><span class="pill ${n ? 'on' : ''}">${n}/${r.feeds.length}</span></td><td>${fmtMin(Math.floor((r.usedSeconds || 0) / 60))}</td><td><a class="btn" href="/rooms/${r.id}">Open</a></td></tr>`; }).join('')}
        </tbody></table>` : '<p class="muted">No rooms yet.</p>'}
    </section>

    <section class="card">
      <h2>Password</h2>
      <form method="post" action="/admin/accounts/${a.id}/password" class="row">
        <label>New password<input name="password" minlength="8" required></label>
        <button class="btn" type="submit">Reset password</button>
      </form>
      <p class="hint">The account is signed out everywhere. Send them the new password yourself.</p>
      <form method="post" action="/admin/accounts/${a.id}/delete" onsubmit="return confirm('Delete ${esc(a.username)} and all of their rooms? This cannot be undone.')">
        <button class="btn danger" type="submit">Delete account and its rooms</button>
      </form>
    </section>
  </div>
  <script src="/static/admin.js"></script>`,
});
