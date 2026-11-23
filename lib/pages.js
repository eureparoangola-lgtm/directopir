const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function layout({ title, body, head = '', bodyClass = '' }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/styles.css">
${head}
</head><body class="${bodyClass}">${body}</body></html>`;
}

// Open Graph tags so the share link shows a nice preview card in WhatsApp/Slack/iMessage.
const ogTags = (room, base) => `
<meta property="og:title" content="${esc(room.name)} · Live drone feeds">
<meta property="og:description" content="${room.feeds.length} live drone feeds · passcode required">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(base)}/v/${esc(room.slug)}">
<meta name="robots" content="noindex">`;

const brand = `<div class="brand"><span class="brand-dot"></span>DroneView</div>`;

exports.notFound = () => layout({ title: 'Not found', bodyClass: 'center', body: `<div class="card narrow">${brand}<h1>Link not found</h1><p class="muted">This stream link doesn't exist or was removed.</p></div>` });

exports.adminLogin = (error) => layout({
  title: 'Admin login · DroneView',
  bodyClass: 'center',
  body: `<form class="card narrow" method="post" action="/admin/login">
    ${brand}<h1>Operator login</h1>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <label>Admin password<input type="password" name="password" autofocus required></label>
    <button class="btn primary" type="submit">Sign in</button>
  </form>`,
});

exports.passcode = (room, base, error) => layout({
  title: `${room.name} · Live`,
  head: ogTags(room, base),
  bodyClass: 'center',
  body: `<form class="card narrow" method="post">
    ${brand}
    <h1>${esc(room.name)}</h1>
    <p class="muted">${room.feeds.length} live drone feeds. Enter the passcode to watch.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <label>Passcode<input type="password" name="passcode" autocomplete="off" autofocus required></label>
    <button class="btn primary" type="submit">Watch live</button>
  </form>`,
});

exports.multiview = (room, base) => layout({
  title: `${room.name} · Live`,
  head: ogTags(room, base),
  bodyClass: 'viewer',
  body: `<header class="vbar">
      ${brand}<div class="vtitle">${esc(room.name)}</div>
      <div class="vstat"><span id="liveCount">0</span>/${room.feeds.length} live</div>
      <button class="btn ghost" id="fsBtn" title="Fullscreen">⛶ Fullscreen</button>
    </header>
    <main id="grid" class="grid"></main>
    <script>window.DV = ${JSON.stringify({ slug: room.slug, feeds: room.feeds.map((f) => ({ id: f.id, label: f.label })) })};</script>
    <script src="/static/mpegts.js"></script>
    <script src="/static/viewer.js"></script>`,
});

exports.adminHome = (rooms, live, base) => layout({
  title: 'Rooms · DroneView',
  body: `<header class="topbar">${brand}<form method="post" action="/admin/logout"><button class="btn ghost">Log out</button></form></header>
  <div class="wrap">
    <section class="card">
      <h2>New stream room</h2>
      <p class="muted">A room is one share link with up to 16 drone feeds (default 10). Each feed gets its own RTMP URL for a DJI remote.</p>
      <form method="post" action="/admin/rooms" class="row">
        <label>Room name<input name="name" placeholder="e.g. Site inspection – North block" required></label>
        <label>Viewer passcode<input name="passcode" minlength="4" required></label>
        <label class="small">Feeds<input name="feedCount" type="number" min="1" max="16" value="10"></label>
        <button class="btn primary" type="submit">Create room</button>
      </form>
    </section>
    <section class="card">
      <h2>Rooms</h2>
      ${rooms.length === 0 ? '<p class="muted">No rooms yet.</p>' : `<table class="table">
        <thead><tr><th>Name</th><th>Live</th><th>Share link</th><th></th></tr></thead><tbody>
        ${rooms.map((r) => {
          const n = r.feeds.filter((f) => live.has(f.key)).length;
          return `<tr><td>${esc(r.name)}</td><td><span class="pill ${n ? 'on' : ''}">${n}/${r.feeds.length}</span></td>
          <td><code>${esc(base)}/v/${esc(r.slug)}</code></td><td><a class="btn" href="/admin/rooms/${r.id}">Manage</a></td></tr>`;
        }).join('')}
        </tbody></table>`}
    </section>
  </div>`,
});

exports.adminRoom = (room, live, base, rtmpBase) => {
  const share = `${base}/v/${room.slug}`;
  return layout({
    title: `${room.name} · DroneView`,
    body: `<header class="topbar">${brand}<a class="btn ghost" href="/admin">← All rooms</a></header>
  <div class="wrap">
    <section class="card">
      <h2>${esc(room.name)}</h2>
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
      <form method="post" action="/admin/rooms/${room.id}/settings" class="row">
        <label>Room name<input name="name" value="${esc(room.name)}"></label>
        <label>New passcode<input name="passcode" minlength="4" placeholder="leave blank to keep"></label>
        <button class="btn" type="submit">Save</button>
      </form>
      <p class="muted">Changing the passcode signs out everyone currently watching.</p>
      <form method="post" action="/admin/rooms/${room.id}/delete" onsubmit="return confirm('Delete this room and disconnect all its drones?')">
        <button class="btn danger" type="submit">Delete room</button>
      </form>
    </section>
  </div>
  <script>window.DV_ROOM = ${JSON.stringify(room.id)};</script>
  <script src="/static/admin.js"></script>`,
  });
};
