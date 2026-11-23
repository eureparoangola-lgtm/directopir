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
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || 'admin').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');   // e.g. https://live.example.com
const RTMP_HOST = process.env.RTMP_HOST || '';                         // e.g. live.example.com or server IP
const VIEWER_SESSION_HOURS = parseFloat(process.env.VIEWER_SESSION_HOURS || '12');
const LOGIN_SESSION_HOURS = 24 * 7;

if (!ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD env var is required.');
  process.exit(1);
}
db.ensureAdmin(ADMIN_USERNAME, ADMIN_PASSWORD);
const SECRET = db.secret();

// ---------- Media server (RTMP ingest + internal HTTP-FLV) ----------
const nms = new NodeMediaServer({
  logType: 1,
  rtmp: { port: RTMP_PORT, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
  http: { port: MEDIA_PORT, allow_origin: '*' },
  // Playback requires a signed URL that only this app can mint; the NMS API is locked down.
  auth: { play: true, publish: false, secret: SECRET, api: true, api_user: 'admin', api_pass: crypto.randomBytes(16).toString('hex') },
});

const live = new Map(); // streamKey -> { sessionId, since, counted }

// Block an IP for 15 minutes after 20 wrong stream keys, so short keys can't be guessed.
const badPublish = new Map(); // ip -> { n, until }
nms.on('prePublish', (id, streamPath) => {
  const [, app, key] = streamPath.split('/');
  const session = nms.getSession(id);
  const ip = (session && session.ip) || '?';
  const now = Date.now();
  const rec = badPublish.get(ip);
  if (rec && rec.until > now && rec.n >= 20) {
    console.log(`[rtmp] blocked ${ip} (too many wrong stream keys)`);
    return session && session.reject();
  }
  const hit = app === 'live' && db.findFeedByKey(key);
  if (!hit) {
    const r = rec && rec.until > now ? rec : { n: 0, until: now + 15 * 60e3 };
    r.n++;
    badPublish.set(ip, r);
    console.log(`[rtmp] rejected unknown stream ${streamPath} from ${ip}`);
    return session && session.reject();
  }
  const block = db.streamingBlock(db.getUser(hit.room.ownerId));
  if (block) {
    console.log(`[rtmp] rejected ${hit.room.name} / ${hit.feed.label}: streaming ${block.reason}`);
    return session && session.reject();
  }
});
nms.on('postPublish', (id, streamPath) => {
  const key = streamPath.split('/')[2];
  const hit = db.findFeedByKey(key);
  if (!hit) return;
  live.set(key, { sessionId: id, since: Date.now(), counted: Date.now() });
  console.log(`[rtmp] LIVE  ${hit.room.name} / ${hit.feed.label}`);
});
nms.on('donePublish', (id, streamPath) => {
  const key = streamPath.split('/')[2];
  const entry = live.get(key);
  if (entry && entry.sessionId === id) {
    countUsage(key, entry);
    live.delete(key);
    db.save();
  }
  const hit = db.findFeedByKey(key);
  if (hit) console.log(`[rtmp] ended ${hit.room.name} / ${hit.feed.label}`);
});
nms.run();

function kickStream(key) {
  const entry = live.get(key);
  if (!entry) return;
  countUsage(key, entry);
  live.delete(key);
  const s = nms.getSession(entry.sessionId);
  if (s) s.reject();
}
function kickOwner(userId) {
  db.rooms().filter((r) => r.ownerId === userId).forEach((r) => r.feeds.forEach((f) => kickStream(f.key)));
}

// ---------- Live-stream minutes ----------
// Every live drone feed counts: 10 drones live for 1 hour = 600 minutes.
function countUsage(key, entry) {
  const now = Date.now();
  const seconds = (now - entry.counted) / 1000;
  entry.counted = now;
  const hit = db.findFeedByKey(key);
  return hit && seconds > 0 ? db.addUsage(hit.room, seconds) : null;
}
setInterval(() => {
  if (!live.size) return;
  const owners = new Set();
  for (const [key, entry] of live) { const o = countUsage(key, entry); if (o) owners.add(o); }
  db.save();
  // Cut off users who just ran out of minutes.
  owners.forEach((o) => { if (db.streamingBlock(o)) { console.log(`[usage] ${o.username} reached limit, stopping streams`); kickOwner(o.id); } });
}, parseInt(process.env.USAGE_TICK_MS || '10000', 10));

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
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
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

// The logged-in account, or null. Tokens die when the password changes or the account is deleted.
function currentUser(req) {
  const t = readToken(cookies(req).dv_session);
  const user = t && db.getUser(t.uid);
  return user && t.sv === (user.sessionVersion || 0) ? user : null;
}
const canManage = (user, room) => !!user && !!room && (user.role === 'admin' || room.ownerId === user.id);
function canView(req, room) {
  if (canManage(currentUser(req), room)) return true;
  const t = readToken(cookies(req)[`dv_v_${room.id}`]);
  return t && t.room === room.id && t.pv === (room.passVersion || 0);
}

// Basic brute-force protection for passcodes and logins.
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
app.use(express.urlencoded({ extended: false, limit: '3mb' })); // forms can carry a base64 logo
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/static/mpegts.js', (req, res) => res.sendFile(require.resolve('mpegts.js/dist/mpegts.js')));

// Behind a proxy (Codespaces, Caddy, nginx) the real public address is in X-Forwarded-Host, not Host.
const publicHost = (req) => (req.get('x-forwarded-host') || req.get('host') || '').split(',')[0].trim();
const baseUrl = (req) => PUBLIC_URL || `${req.protocol}://${publicHost(req)}`;
const rtmpBase = (req) => `rtmp://${RTMP_HOST || req.hostname}${RTMP_PORT === 1935 ? '' : ':' + RTMP_PORT}/live`;
const back = (res, url, err, msg) => res.redirect(`${url}${err ? `?error=${encodeURIComponent(err)}` : msg ? `?ok=${encodeURIComponent(msg)}` : ''}`);

function requireLogin(req, res, next) {
  req.user = currentUser(req);
  if (req.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  res.redirect('/login');
}
function requireAdmin(req, res, next) {
  requireLogin(req, res, () => (req.user.role === 'admin' ? next() : res.status(403).send(pages.forbidden(db.themeFor(req.user)))));
}
// Loads :id as a room the logged-in account may manage.
function loadRoom(req, res, next) {
  const room = db.getRoom(req.params.id);
  if (!canManage(req.user, room)) return req.path.startsWith('/api/') ? res.status(404).json({ error: 'not found' }) : res.status(404).send(pages.notFound());
  req.room = room;
  next();
}

// --- Login ---
app.get('/', (req, res) => res.redirect(currentUser(req) ? '/dashboard' : '/login'));
app.get(['/admin', '/admin/login'], (req, res) => res.redirect('/dashboard'));
app.get('/login', (req, res) => (currentUser(req) ? res.redirect('/dashboard') : res.send(pages.login(db.defaultTheme()))));
app.post('/login', (req, res) => {
  if (tooManyAttempts(`login:${req.ip}`)) return res.status(429).send(pages.login(db.defaultTheme(), 'Too many attempts. Wait 15 minutes.'));
  const user = db.getUserByName(req.body.username || '');
  if (!user || !db.checkSecret(user.pass, req.body.password || '')) return res.status(401).send(pages.login(db.defaultTheme(), 'Wrong username or password.'));
  setCookie(req, res, 'dv_session', makeToken({ uid: user.id, sv: user.sessionVersion || 0 }, LOGIN_SESSION_HOURS), LOGIN_SESSION_HOURS);
  res.redirect('/dashboard');
});
app.post('/logout', (req, res) => { setCookie(req, res, 'dv_session', '', 0); res.redirect('/login'); });

// --- Dashboard (every role) ---
function usageOf(user) {
  const own = db.rooms().filter((r) => r.ownerId === user.id);
  return {
    usedMinutes: Math.floor((user.usedSeconds || 0) / 60),
    limitMinutes: user.limitMinutes ?? null,
    block: db.streamingBlock(user),
    liveFeeds: own.reduce((n, r) => n + r.feeds.filter((f) => live.has(f.key)).length, 0),
    rooms: own.map((r) => ({ id: r.id, minutes: Math.floor((r.usedSeconds || 0) / 60) })),
  };
}
app.get('/dashboard', requireLogin, (req, res) => {
  res.send(pages.dashboard({ user: req.user, theme: db.themeFor(req.user), rooms: db.roomsOf(req.user), users: db.users(), live, base: baseUrl(req), usage: usageOf(req.user), q: req.query }));
});
app.get('/api/me/usage', requireLogin, (req, res) => res.set('Cache-Control', 'no-store').json(usageOf(req.user)));
app.post('/account/password', requireLogin, (req, res) => {
  if (req.user.role === 'admin') return back(res, '/dashboard', 'The admin password is set with ADMIN_PASSWORD in the server settings.');
  if (!db.checkSecret(req.user.pass, req.body.current || '')) return back(res, '/dashboard', 'Your current password is wrong.');
  const err = db.setPassword(req.user, req.body.password);
  if (err) return back(res, '/dashboard', err);
  setCookie(req, res, 'dv_session', makeToken({ uid: req.user.id, sv: req.user.sessionVersion }, LOGIN_SESSION_HOURS), LOGIN_SESSION_HOURS);
  back(res, '/dashboard', null, 'Password changed.');
});

// --- Rooms ---
const canUploadLogo = (user) => user.role !== 'collab';
app.post('/rooms', requireLogin, (req, res) => {
  const { name, passcode, feedCount } = req.body;
  if (!name || !passcode || String(passcode).length < 4) return back(res, '/dashboard', 'Name and a passcode of 4+ characters are required.');
  const room = db.createRoom({ name, passcode, feedCount, ownerId: req.user.id });
  const err = req.body.logo && canUploadLogo(req.user) ? db.setLogo(room, req.body.logo) : null;
  back(res, `/rooms/${room.id}`, err);
});
app.get('/rooms/:id', requireLogin, loadRoom, (req, res) => {
  const owner = db.getUser(req.room.ownerId);
  res.send(pages.room({ user: req.user, theme: db.themeFor(req.user), room: req.room, owner, ownerBlock: db.streamingBlock(owner), live, base: baseUrl(req), rtmpBase: rtmpBase(req), q: req.query }));
});
app.post('/rooms/:id/settings', requireLogin, loadRoom, (req, res) => {
  const room = req.room;
  db.updateRoom(room, { name: req.body.name, passcode: req.body.passcode });
  let err = null;
  if (canUploadLogo(req.user)) {
    if (req.body.removeLogo) db.removeLogo(room);
    else if (req.body.logo) err = db.setLogo(room, req.body.logo);
  }
  back(res, `/rooms/${room.id}`, err, err ? null : 'Saved.');
});
app.post('/rooms/:id/delete', requireLogin, loadRoom, (req, res) => {
  req.room.feeds.forEach((f) => kickStream(f.key));
  db.deleteRoom(req.room);
  res.redirect('/dashboard');
});
app.post('/api/rooms/:id/feeds/:feedId', requireLogin, loadRoom, (req, res) => {
  const feed = req.room.feeds.find((f) => f.id === req.params.feedId);
  if (!feed) return res.status(404).json({ error: 'not found' });
  if (req.body.label !== undefined) db.renameFeed(feed, req.body.label);
  if (req.body.regenerate) { kickStream(feed.key); db.regenerateKey(feed); }
  res.json({ label: feed.label, rtmpUrl: `${rtmpBase(req)}/${feed.key}` });
});
app.get('/api/rooms/:id/status', requireLogin, loadRoom, (req, res) => {
  res.set('Cache-Control', 'no-store').json({ feeds: roomStatus(req.room) });
});

// --- Admin: accounts, subscriptions, themes ---
app.get('/admin/accounts', requireAdmin, (req, res) => {
  const usage = Object.fromEntries(db.users().map((u) => [u.id, usageOf(u)]));
  res.send(pages.accounts({ user: req.user, theme: db.themeFor(req.user), users: db.users(), usage, defaultTheme: db.defaultTheme(), q: req.query }));
});
app.post('/admin/accounts', requireAdmin, (req, res) => {
  const { error, user } = db.createUser(req.body);
  if (error) return back(res, '/admin/accounts', error);
  back(res, `/admin/accounts/${user.id}`, null, `Account "${user.username}" created.`);
});
app.post('/admin/theme', requireAdmin, (req, res) => {
  const theme = db.setDefaultTheme(req.body);
  let err = null;
  if (req.body.removeBrandLogo) db.removeBrandLogo(theme);
  else if (req.body.logo) err = db.setBrandLogo(theme, req.body.logo);
  back(res, '/admin/accounts', err, err ? null : 'Platform theme saved.');
});

function loadAccount(req, res, next) {
  const acc = db.getUser(req.params.uid);
  if (!acc || acc.role === 'admin') return res.status(404).send(pages.notFound());
  req.account = acc;
  next();
}
const accUrl = (req) => `/admin/accounts/${req.account.id}`;
app.get('/admin/accounts/:uid', requireAdmin, loadAccount, (req, res) => {
  res.send(pages.account({ user: req.user, theme: db.themeFor(req.user), account: req.account, rooms: db.roomsOf(req.account), live, usage: usageOf(req.account), defaultTheme: db.defaultTheme(), q: req.query }));
});
app.post('/admin/accounts/:uid/streaming', requireAdmin, loadAccount, (req, res) => {
  const acc = req.account;
  const enable = req.body.action === 'enable';
  db.updateUser(acc, { streamingDisabled: !enable, disabledMessage: String(req.body.message || '').trim().slice(0, 500) });
  if (db.streamingBlock(acc)) kickOwner(acc.id);
  back(res, accUrl(req), null, enable ? 'Streaming enabled.' : 'Streaming disabled. Live drones were disconnected.');
});
app.post('/admin/accounts/:uid/limit', requireAdmin, loadAccount, (req, res) => {
  const acc = req.account;
  const fields = {};
  if (req.body.limitMinutes !== undefined) {
    const v = String(req.body.limitMinutes).trim();
    fields.limitMinutes = v === '' ? null : Math.max(0, parseInt(v, 10) || 0);
  }
  if (req.body.addMinutes) fields.limitMinutes = (acc.limitMinutes || 0) + Math.max(0, parseInt(req.body.addMinutes, 10) || 0);
  if (req.body.resetUsage) fields.usedSeconds = 0;
  db.updateUser(acc, fields);
  if (db.streamingBlock(acc)) kickOwner(acc.id);
  back(res, accUrl(req), null, 'Minutes updated.');
});
app.post('/admin/accounts/:uid/theme', requireAdmin, loadAccount, (req, res) => {
  const acc = req.account;
  if (acc.role !== 'user') return back(res, accUrl(req), 'Collaborators use the platform theme.');
  if (req.body.useDefault) { db.clearUserTheme(acc); return back(res, accUrl(req), null, 'Now using the platform theme.'); }
  const theme = db.setUserTheme(acc, req.body);
  let err = null;
  if (req.body.removeBrandLogo) db.removeBrandLogo(theme);
  else if (req.body.logo) err = db.setBrandLogo(theme, req.body.logo);
  back(res, accUrl(req), err, err ? null : 'Theme saved.');
});
app.post('/admin/accounts/:uid/password', requireAdmin, loadAccount, (req, res) => {
  const err = db.setPassword(req.account, req.body.password);
  back(res, accUrl(req), err, err ? null : 'Password reset. The account was signed out everywhere.');
});
app.post('/admin/accounts/:uid/delete', requireAdmin, loadAccount, (req, res) => {
  kickOwner(req.account.id);
  db.deleteUser(req.account);
  back(res, '/admin/accounts', null, 'Account deleted.');
});

// --- Public assets ---
app.get('/logo/:slug.png', (req, res) => {
  const room = db.getRoomBySlug(req.params.slug);
  if (!room || !room.logo) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400').sendFile(db.logoPath(room));
});
app.get('/brand/:id.png', (req, res) => {
  const theme = db.findThemeById(req.params.id);
  if (!theme || !theme.logo) return res.sendStatus(404);
  res.set('Cache-Control', 'public, max-age=86400').sendFile(db.brandLogoPath(theme.id));
});

// --- Viewer ---
function roomStatus(room) {
  return room.feeds.map((f) => ({ id: f.id, label: f.label, live: live.has(f.key), since: live.get(f.key)?.since || null }));
}
const roomTheme = (room) => db.themeFor(db.getUser(room.ownerId));
const roomBlocked = (room) => !!db.streamingBlock(db.getUser(room.ownerId));

app.get('/v/:slug', (req, res) => {
  const room = db.getRoomBySlug(req.params.slug);
  if (!room) return res.status(404).send(pages.notFound());
  const theme = roomTheme(room);
  if (roomBlocked(room)) return res.send(pages.unavailable(room, theme));
  if (!canView(req, room)) return res.send(pages.passcode(room, theme, baseUrl(req)));
  res.send(pages.multiview(room, theme, baseUrl(req)));
});
app.post('/v/:slug', (req, res) => {
  const room = db.getRoomBySlug(req.params.slug);
  if (!room) return res.status(404).send(pages.notFound());
  const theme = roomTheme(room);
  if (tooManyAttempts(`room:${room.id}:${req.ip}`)) return res.status(429).send(pages.passcode(room, theme, baseUrl(req), 'Too many attempts. Try again in 15 minutes.'));
  if (!db.checkPasscode(room, req.body.passcode || '')) return res.status(401).send(pages.passcode(room, theme, baseUrl(req), 'Incorrect passcode.'));
  setCookie(req, res, `dv_v_${room.id}`, makeToken({ room: room.id, pv: room.passVersion || 0 }, VIEWER_SESSION_HOURS), VIEWER_SESSION_HOURS);
  res.redirect(`/v/${room.slug}`);
});
app.get('/api/v/:slug/status', (req, res) => {
  const room = db.getRoomBySlug(req.params.slug);
  if (!room) return res.status(404).json({ error: 'not found' });
  if (!canView(req, room)) return res.status(401).json({ error: 'passcode required' });
  res.set('Cache-Control', 'no-store').json({ name: room.name, unavailable: roomBlocked(room), feeds: roomStatus(room) });
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
  console.log(`DroneView web on http://localhost:${PORT}  (log in as "${ADMIN_USERNAME}")`);
  console.log(`RTMP ingest on port ${RTMP_PORT}`);
});
server.on('upgrade', handleUpgrade);
