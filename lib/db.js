// Tiny JSON-file store. Good for a single server with a handful of rooms.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

let state = { secret: null, rooms: [] };
if (fs.existsSync(DB_FILE)) {
  state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
if (!state.secret) state.secret = crypto.randomBytes(32).toString('hex');
save();

function logoPath(room) {
  return path.join(DATA_DIR, 'logos', `${room.id}.png`);
}

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const rand = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const newStreamKey = () => 'd' + crypto.randomBytes(12).toString('hex'); // letters+digits only, safe for DJI apps

function hashPasscode(passcode) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(passcode), salt, 32).toString('hex');
  return { salt, hash };
}

function checkPasscode(room, passcode) {
  const hash = crypto.scryptSync(String(passcode), room.pass.salt, 32);
  return crypto.timingSafeEqual(hash, Buffer.from(room.pass.hash, 'hex'));
}

function slugify(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'live';
  return `${base}-${rand(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
}

module.exports = {
  secret: () => state.secret,
  rooms: () => state.rooms,
  getRoom: (id) => state.rooms.find((r) => r.id === id),
  getRoomBySlug: (slug) => state.rooms.find((r) => r.slug === slug),
  findFeedByKey(key) {
    for (const room of state.rooms) {
      const feed = room.feeds.find((f) => f.key === key);
      if (feed) return { room, feed };
    }
    return null;
  },
  createRoom({ name, passcode, feedCount }) {
    const n = Math.min(Math.max(parseInt(feedCount, 10) || 10, 1), 16);
    const room = {
      id: rand(8),
      slug: slugify(name),
      name: String(name).slice(0, 80),
      pass: hashPasscode(passcode),
      createdAt: new Date().toISOString(),
      feeds: Array.from({ length: n }, (_, i) => ({ id: rand(6), label: `Drone ${i + 1}`, key: newStreamKey() })),
    };
    state.rooms.push(room);
    save();
    return room;
  },
  updateRoom(room, { name, passcode }) {
    if (name) room.name = String(name).slice(0, 80);
    if (passcode) {
      room.pass = hashPasscode(passcode);
      room.passVersion = (room.passVersion || 0) + 1; // invalidates existing viewer sessions
    }
    save();
  },
  renameFeed(feed, label) {
    feed.label = String(label).slice(0, 40) || feed.label;
    save();
  },
  regenerateKey(feed) {
    const old = feed.key;
    feed.key = newStreamKey();
    save();
    return old;
  },
  deleteRoom(room) {
    state.rooms = state.rooms.filter((r) => r !== room);
    fs.rmSync(logoPath(room), { force: true });
    save();
  },
  logoPath,
  // Accepts a "data:image/png;base64,..." string from the admin form. Returns an error message or null.
  setLogo(room, dataUrl) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m) return 'The logo must be a PNG file.';
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 8 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'The logo must be a PNG file.';
    if (buf.length > 1024 * 1024) return 'The logo must be smaller than 1 MB.';
    fs.mkdirSync(path.dirname(logoPath(room)), { recursive: true });
    fs.writeFileSync(logoPath(room), buf);
    room.logo = Date.now(); // version, used to bust browser caches
    save();
    return null;
  },
  removeLogo(room) {
    fs.rmSync(logoPath(room), { force: true });
    delete room.logo;
    save();
  },
  checkPasscode,
};
