// Tiny JSON-file store. Good for a single server with a modest number of accounts and rooms.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let state = { secret: null, rooms: [], users: [], theme: null };
if (fs.existsSync(DB_FILE)) state = { ...state, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
if (!state.secret) state.secret = crypto.randomBytes(32).toString('hex');
if (!state.users) state.users = [];

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const rand = (bytes) => crypto.randomBytes(bytes).toString('base64url');

// ---------- Passwords / passcodes (scrypt) ----------
function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(secret), salt, 32).toString('hex') };
}
function checkSecret(stored, secret) {
  if (!stored) return false;
  const hash = crypto.scryptSync(String(secret), stored.salt, 32);
  return crypto.timingSafeEqual(hash, Buffer.from(stored.hash, 'hex'));
}

// ---------- PNG uploads (room logos, brand logos) ----------
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function savePng(file, dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) return 'The logo must be a PNG file.';
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return 'The logo must be a PNG file.';
  if (buf.length > 1024 * 1024) return 'The logo must be smaller than 1 MB.';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return null;
}
const logoPath = (room) => path.join(DATA_DIR, 'logos', `${room.id}.png`);
const brandLogoPath = (themeId) => path.join(DATA_DIR, 'brand', `${themeId}.png`);

// ---------- Accounts ----------
// Roles: admin (platform owner, password from env), collab (creates rooms for the admin), user (customer).
const ADMIN_ID = 'admin';
function ensureAdmin(username, password) {
  let admin = state.users.find((u) => u.id === ADMIN_ID);
  if (!admin) {
    admin = { id: ADMIN_ID, role: 'admin', createdAt: new Date().toISOString(), usedSeconds: 0, sessionVersion: 0 };
    state.users.unshift(admin);
  }
  admin.username = username;
  // The admin password always follows ADMIN_PASSWORD, so changing .env + restart is the reset path.
  if (!checkSecret(admin.pass, password)) { admin.pass = hashSecret(password); admin.sessionVersion = (admin.sessionVersion || 0) + 1; }
  // Rooms from before accounts existed belong to the admin.
  state.rooms.forEach((r) => { if (!r.ownerId) r.ownerId = ADMIN_ID; });
  save();
}

const DEFAULT_DISABLED_MESSAGE = 'Your subscription has ended. Please contact us to renew and continue streaming.';
const DEFAULT_LIMIT_MESSAGE = 'You have used all of your live-stream minutes. Please contact us to add more minutes.';

// Why a user may not stream right now, or null if they can.
function streamingBlock(user) {
  if (!user) return { reason: 'missing', message: 'Account not found.' };
  if (user.role !== 'user') return null;
  if (user.streamingDisabled) return { reason: 'disabled', message: user.disabledMessage || DEFAULT_DISABLED_MESSAGE };
  if (user.limitMinutes != null && user.usedSeconds >= user.limitMinutes * 60) {
    return { reason: 'limit', message: user.disabledMessage || DEFAULT_LIMIT_MESSAGE };
  }
  return null;
}

// ---------- Rooms ----------
// Short keys that are easy to type on a remote: 8 characters, lowercase, no look-alikes (0/o, 1/l/i).
// 31^8 ≈ 850 billion combinations; repeated wrong guesses get the sender's IP blocked (see server.js).
const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newStreamKey() {
  for (;;) {
    let key = '';
    for (let i = 0; i < 8; i++) key += KEY_ALPHABET[crypto.randomInt(KEY_ALPHABET.length)];
    if (!state.rooms.some((r) => r.feeds.some((f) => f.key === key))) return key;
  }
}
function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'live';
  return `${base}-${rand(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
}

// ---------- Themes ----------
const HEX = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_THEME = { brandName: 'DroneView', accent: '#3fa7ff', bg: '#0b0f14' };
function cleanTheme(input, current) {
  return {
    id: (current && current.id) || rand(6),
    brandName: String(input.brandName || '').trim().slice(0, 40) || DEFAULT_THEME.brandName,
    accent: HEX.test(input.accent) ? input.accent.toLowerCase() : DEFAULT_THEME.accent,
    bg: HEX.test(input.bg) ? input.bg.toLowerCase() : DEFAULT_THEME.bg,
    logo: current && current.logo, // version number when a brand logo is uploaded
  };
}

module.exports = {
  DATA_DIR,
  secret: () => state.secret,
  checkSecret,
  ensureAdmin,
  streamingBlock,
  DEFAULT_DISABLED_MESSAGE,

  // --- users ---
  users: () => state.users,
  getUser: (id) => state.users.find((u) => u.id === id),
  getUserByName: (name) => state.users.find((u) => u.username === String(name).trim().toLowerCase()),
  createUser({ username, password, role, limitMinutes }) {
    const name = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(name)) return { error: 'Usernames are 3–32 characters: letters, numbers, dot, dash or underscore.' };
    if (state.users.some((u) => u.username === name)) return { error: 'That username is already taken.' };
    if (!password || String(password).length < 8) return { error: 'Passwords must be at least 8 characters.' };
    if (!['collab', 'user'].includes(role)) return { error: 'Choose a role.' };
    const user = {
      id: rand(8), username: name, role, pass: hashSecret(password), createdAt: new Date().toISOString(),
      usedSeconds: 0, sessionVersion: 0, streamingDisabled: false, disabledMessage: '',
      limitMinutes: role === 'user' && limitMinutes !== '' && limitMinutes != null ? Math.max(0, parseInt(limitMinutes, 10) || 0) : null,
      theme: null,
    };
    state.users.push(user);
    save();
    return { user };
  },
  setPassword(user, password) {
    if (!password || String(password).length < 8) return 'Passwords must be at least 8 characters.';
    user.pass = hashSecret(password);
    user.sessionVersion = (user.sessionVersion || 0) + 1; // signs out other sessions
    save();
    return null;
  },
  updateUser(user, fields) {
    Object.assign(user, fields);
    save();
  },
  deleteUser(user) {
    state.rooms.filter((r) => r.ownerId === user.id).forEach((r) => module.exports.deleteRoom(r));
    if (user.theme && user.theme.logo) fs.rmSync(brandLogoPath(user.theme.id), { force: true });
    state.users = state.users.filter((u) => u !== user);
    save();
  },

  // --- usage accounting ---
  addUsage(room, seconds) {
    room.usedSeconds = (room.usedSeconds || 0) + seconds;
    const owner = state.users.find((u) => u.id === room.ownerId);
    if (owner) owner.usedSeconds = (owner.usedSeconds || 0) + seconds;
    return owner;
  },
  save,

  // --- themes ---
  defaultTheme: () => state.theme || { id: 'default', ...DEFAULT_THEME },
  // The theme a page should use: users get their own (if the admin set one), everyone else the platform default.
  themeFor(user) {
    if (user && user.role === 'user' && user.theme) return user.theme;
    return state.theme || { id: 'default', ...DEFAULT_THEME };
  },
  setDefaultTheme(input) { state.theme = cleanTheme(input, state.theme || { id: 'default' }); save(); return state.theme; },
  setUserTheme(user, input) { user.theme = cleanTheme(input, user.theme); save(); return user.theme; },
  clearUserTheme(user) {
    if (user.theme && user.theme.logo) fs.rmSync(brandLogoPath(user.theme.id), { force: true });
    user.theme = null; save();
  },
  setBrandLogo(theme, dataUrl) {
    const err = savePng(brandLogoPath(theme.id), dataUrl);
    if (!err) { theme.logo = Date.now(); save(); }
    return err;
  },
  removeBrandLogo(theme) { fs.rmSync(brandLogoPath(theme.id), { force: true }); delete theme.logo; save(); },
  findThemeById(id) {
    if ((state.theme && state.theme.id === id) || id === 'default') return state.theme;
    const u = state.users.find((x) => x.theme && x.theme.id === id);
    return u ? u.theme : null;
  },
  brandLogoPath,

  // --- rooms ---
  rooms: () => state.rooms,
  roomsOf: (user) => (user.role === 'admin' ? state.rooms : state.rooms.filter((r) => r.ownerId === user.id)),
  getRoom: (id) => state.rooms.find((r) => r.id === id),
  getRoomBySlug: (slug) => state.rooms.find((r) => r.slug === slug),
  findFeedByKey(key) {
    for (const room of state.rooms) {
      const feed = room.feeds.find((f) => f.key === key);
      if (feed) return { room, feed };
    }
    return null;
  },
  createRoom({ name, passcode, feedCount, ownerId }) {
    const n = Math.min(Math.max(parseInt(feedCount, 10) || 10, 1), 16);
    const room = {
      id: rand(8), slug: slugify(name), name: String(name).slice(0, 80), ownerId,
      pass: hashSecret(passcode), createdAt: new Date().toISOString(), usedSeconds: 0,
      feeds: Array.from({ length: n }, (_, i) => ({ id: rand(6), label: `Drone ${i + 1}`, key: newStreamKey() })),
    };
    state.rooms.push(room);
    save();
    return room;
  },
  updateRoom(room, { name, passcode }) {
    if (name) room.name = String(name).slice(0, 80);
    if (passcode) {
      room.pass = hashSecret(passcode);
      room.passVersion = (room.passVersion || 0) + 1; // invalidates existing viewer sessions
    }
    save();
  },
  checkPasscode: (room, passcode) => checkSecret(room.pass, passcode),
  renameFeed(feed, label) { feed.label = String(label).slice(0, 40) || feed.label; save(); },
  regenerateKey(feed) { const old = feed.key; feed.key = newStreamKey(); save(); return old; },
  deleteRoom(room) {
    state.rooms = state.rooms.filter((r) => r !== room);
    fs.rmSync(logoPath(room), { force: true });
    save();
  },
  logoPath,
  setLogo(room, dataUrl) {
    const err = savePng(logoPath(room), dataUrl);
    if (!err) { room.logo = Date.now(); save(); }
    return err;
  },
  removeLogo(room) { fs.rmSync(logoPath(room), { force: true }); delete room.logo; save(); },
};
