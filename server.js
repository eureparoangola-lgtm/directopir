const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const NodeMediaServer = require('node-media-server');
const db = require('./lib/db');
const pages = require('./lib/pages');

// ---------- Config ----------
const PORT = parseInt(process.env.PORT || '3000', 10);           // web app (put HTTPS proxy in front)
const RTMP_PORT = parseInt(process.env.RTMP_PORT || '1935', 10); // drones push here
const MEDIA_PORT = parseInt(process.env.MEDIA_HTTP_PORT || '8000', 10); // internal only, firewall it
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');   // e.g. https://live.example.com
const RTMP_HOST = process.env.RTMP_HOST || '';                         // e.g. live.example.com or server IP
const VIEWER_SESSION_HOURS = parseFloat(process.env.VIEWER_SESSION_HOURS || '12');

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD env var is required.');
  process.exit(1);
}
const SECRET = db.secret();

// ---------- Media server (RTMP ingest + internal HTTP-FLV) ----------
const nms = new NodeMediaServer({
  logType: 1,
  rtmp: { port: RTMP_PORT, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
  http: { port: MEDIA_PORT, allow_origin: '*' },
  // Playback requires a signed URL that only this app can mint; the NMS API is locked down.
  auth: { play: true, publish: false, secret: SECRET, api: true, api_user: 'admin', api_pass: crypto.randomBytes(16).toString('hex') },
});

const live = new Map(); // streamKey -> { sessionId, since }

nms.on('prePublish', (id, streamPath) => {
  const [, app, key] = streamPath.split('/');
  const session = nms.getSession(id);
  if (app !== 'live' || !db.findFeedByKey(key)) {
    console.log(`[rtmp] rejected unknown stream ${streamPath}`);
    return session && session.reject();
  }
});
nms.on('postPublish', (id, streamPath) => {
  const key = streamPath.split('/')[2];
  const hit = db.findFeedByKey(key);
  if (!hit) return;
  live.set(key, { sessionId: id, since: Date.now() });
  console.log(`[rtmp] LIVE  ${hit.room.name} / ${hit.feed.label}`);
});
nms.on('donePublish', (id, streamPath) => {
  const key = streamPath.split('/')[2];
  const entry = live.get(key);
  if (entry && entry.sessionId === id) live.delete(key);
  const hit = db.findFeedByKey(key);
  if (hit) console.log(`[rtmp] ended ${hit.room.name} / ${hit.feed.label}`);
});
nms.run();

function kickStream(key) {
  const entry = live.get(key);
  if (!entry) return;
  const s = nms.getSession(entry.sessionId);
  if (s) s.reject();
  live.delete(key);
}

// ---------- Signed cookies ----------
const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function makeToken(payload, hours) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + hours * 3600e3 })).toString('base64url');
  return `${body}.${hmac(body)}`;
}
function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = hmac(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString());
  return data.exp > Date.now() ? data : null;
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function setCookie(req, res, name, value, hours) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(hours * 3600)}${secure}`);
}

const isAdmin = (req) => readToken(cookies(req).dv_admin)?.admin === true;
function canView(req, room) {
  if (isAdmin(req)) return true;
  const t = readToken(cookies(req)[`dv_v_${room.id}`]);
  return t && t.room === room.id && t.pv === (room.passVersion || 0);
}

// Basic brute-force protection for passcode / admin login.
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const a = attempts.get(key) || { n: 0, reset: now + 15 * 60e3 };
  if (now > a.reset) { a.n = 0; a.reset = now + 15 * 60e3; }
  a.n++;
  attempts.set(key, a);
  return a.n > 10;
}

// ---------- Web app ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '3mb' })); // room forms can carry a base64 logo
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/static/mpegts.js', (req, res) => res.sendFile(require.resolve('mpegts.js/dist/mpegts.js')));

// Behind a proxy (Codespaces, Caddy, nginx) the real public address is in X-Forwarded-Host, not Host.
const publicHost = (req) => (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
const baseUrl = (req) => PUBLIC_URL || `${req.protocol}://${publicHost(req)}`;
const rtmpBase = (req) => `rtmp://${RTMP_HOST || req.hostname}${RTMP_PORT === 1935 ? '' : ':' + RTMP_PORT}/live`;

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/admin/login');
}

app.get('/', (req, res) => res.redirect('/admin'));

// --- Admin ---
app.get('/admin/login', (req, res) => res.send(pages.adminLogin()));
app.post('/admin/login', (req, res) => {
  if (tooManyAttempts(`admin:${req.ip}`)) return res.status(429).send(pages.adminLogin('Too many attempts. Wait 15 minutes.'));
  const ok = typeof req.body.password === 'string' &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(req.body.password).digest(), crypto.createHash('sha256').update(ADMIN_PASSWORD).digest());
  if (!ok) return res.status(401).send(pages.adminLogin('Wrong password.'));
  setCookie(req, res, 'dv_admin', makeToken({ admin: true }, 24 * 7), 24 * 7);
  res.redirect('/admin');
});
app.post('/admin/logout', (req, res) => { setCookie(req, res, 'dv_admin', '', 0); res.redirect('/admin/login'); });

app.get('/admin', requireAdmin, (req, res) => res.send(pages.adminHome(db.rooms(), live, baseUrl(req))));
app.post('/admin/rooms', requireAdmin, (req, res) => {
  const { name, passcode, feedCount } = req.body;
  if (!name || !passcode || String(passcode).length < 4) return res.status(400).send('Name and a passcode of 4+ characters are required.');
  const room = db.createRoom({ name, passcode, feedCount });
  const err = req.body.logo ? db.setLogo(room, req.body.logo) : null;
  res.redirect(`/admin/rooms/${room.id}${err ? `?error=${encodeURIComponent(err)}` : ''}`);
});
app.get('/admin/rooms/:id', requireAdmin, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).send('Not found');
  res.send(pages.adminRoom(room, live, baseUrl(req), rtmpBase(req), req.query.error));
});
app.post('/admin/rooms/:id/settings', requireAdmin, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).send('Not found');
  db.updateRoom(room, { name: req.body.name, passcode: req.body.passcode });
  let err = null;
  if (req.body.removeLogo) db.removeLogo(room);
  else if (req.body.logo) err = db.setLogo(room, req.body.logo);
  res.redirect(`/admin/rooms/${room.id}${err ? `?error=${encodeURIComponent(err)}` : ''}`);
});
app.post('/admin/rooms/:id/delete', requireAdmin, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (room) { room.feeds.forEach((f) => kickStream(f.key)); db.deleteRoom(room); }
  res.redirect('/admin');
});
app.post('/admin/api/rooms/:id/feeds/:feedId', requireAdmin, (req, res) => {
  const room = db.getRoom(req.params.id);
  const feed = room && room.feeds.find((f) => f.id === req.params.feedId);
  if (!feed) return res.status(404).json({ error: 'not found' });
  if (req.body.label !== undefined) db.renameFeed(feed, req.body.label);
  if (req.body.regenerate) { const old = db.regenerateKey(feed); kickStream(old); }
  res.json({ label: feed.label, rtmpUrl: `${rtmpBase(req)}/${feed.key}` });
});

// --- Viewer ---
// Room logo (not secret: it is also shown on the passcode screen).
app.get('/logo/:slug.png', (req, res) => {
  const room = db.getRoomBySlug(req.params.slug);
  if (!room || !room.logo) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400').sendFile(db.logoPath(room));
});

function roomStatus(room) {
  return room.feeds.map((f) => ({ id: f.id, label: f.label, live: live.has(f.key), since: live.get(f.key)?.since || null }));
}

app.get('/v/:slug', (req, res) => {
  const room = db.getRoomBySlug(req.params.slug);
  if (!room) return res.status(404).send(pages.notFound());
  if (!canView(req, room)) return res.send(pages.passcode(room, baseUrl(req)));
  res.send(pages.multiview(room, baseUrl(req)));
});
app.post('/v/:slug', (req, res) => {
  const room = db.getRoomBySlug(req.params.slug);
  if (!room) return res.status(404).send(pages.notFound());
  if (tooManyAttempts(`room:${room.id}:${req.ip}`)) return res.status(429).send(pages.passcode(room, baseUrl(req), 'Too many attempts. Try again in 15 minutes.'));
  if (!db.checkPasscode(room, req.body.passcode || '')) return res.status(401).send(pages.passcode(room, baseUrl(req), 'Incorrect passcode.'));
  setCookie(req, res, `dv_v_${room.id}`, makeToken({ room: room.id, pv: room.passVersion || 0 }, VIEWER_SESSION_HOURS), VIEWER_SESSION_HOURS);
  res.redirect(`/v/${room.slug}`);
});
app.get('/api/v/:slug/status', (req, res) => {
  const room = db.getRoomBySlug(req.params.slug);
  if (!room) return res.status(404).json({ error: 'not found' });
  if (!canView(req, room)) return res.status(401).json({ error: 'passcode required' });
  res.set('Cache-Control', 'no-store').json({ name: room.name, feeds: roomStatus(room) });
});
app.get('/admin/api/rooms/:id/status', requireAdmin, (req, res) => {
  const room = db.getRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'no-store').json({ feeds: roomStatus(room) });
});

// Video proxy over WebSocket (avoids the browser's 6-connections-per-host limit with 10+ feeds).
// Viewers only ever see /ws/<slug>/<feedId>.flv; the stream key never leaves the server.
function signedPath(key) {
  const streamPath = `/live/${key}`;
  const exp = Math.floor(Date.now() / 1000) + 60;
  return `${streamPath}.flv?sign=${exp}-${crypto.createHash('md5').update(`${streamPath}-${exp}-${SECRET}`).digest('hex')}`;
}
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
function handleUpgrade(req, socket, head) {
  const m = req.url.match(/^\/ws\/([^/?]+)\/([^/?]+)\.flv/);
  const room = m && db.getRoomBySlug(decodeURIComponent(m[1]));
  const feed = room && room.feeds.find((f) => f.id === decodeURIComponent(m[2]));
  const deny = (code) => { socket.write(`HTTP/1.1 ${code}\r\n\r\n`); socket.destroy(); };
  if (!feed) return deny('404 Not Found');
  if (!canView(req, room)) return deny('401 Unauthorized');
  if (!live.has(feed.key)) return deny('404 Not Found');
  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${MEDIA_PORT}${signedPath(feed.key)}`, { perMessageDeflate: false });
    upstream.on('message', (data) => {
      if (client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > 8 * 1024 * 1024) return client.terminate(); // viewer too slow, let it reconnect
      client.send(data, { binary: true });
    });
    const closeBoth = () => { client.terminate(); upstream.terminate(); };
    upstream.on('close', closeBoth); upstream.on('error', closeBoth);
    client.on('close', closeBoth); client.on('error', closeBoth);
  });
}

const server = app.listen(PORT, () => {
  console.log(`DroneView web on http://localhost:${PORT}  (admin: /admin)`);
  console.log(`RTMP ingest on port ${RTMP_PORT}`);
});
server.on('upgrade', handleUpgrade);
