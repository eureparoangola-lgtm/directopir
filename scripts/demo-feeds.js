// Pushes demo "drone" feeds into a room so you can try the multi-view without live drones.
//
//   npm run demo                                  test patterns into the newest room
//   npm run demo -- --file DJI_0001.MP4           your recorded drone video into every feed
//   npm run demo -- --file a.mp4 --file b.mp4     several videos, spread across the feeds
//   npm run demo -- <room-slug> ...               a specific room instead of the newest
//
// Recorded videos are converted once to a browser-friendly format (H.264 720p), because many
// DJI drones record H.265, which browsers can't play in a live stream. The copy is cached.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'db.json');

// ---- Arguments ----
const args = process.argv.slice(2);
const files = [];
let slug = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') files.push(args[++i]);
  else if (!slug) slug = args[i];
}

// ---- Room ----
if (!fs.existsSync(dbFile)) {
  console.error('No rooms yet. Start the app (npm start), log in, create a room, then run this again.');
  process.exit(1);
}
const { rooms } = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const room = slug ? rooms.find((r) => r.slug === slug) : rooms[rooms.length - 1];
if (!room) {
  console.error(slug ? `Room "${slug}" not found.` : 'No rooms yet. Log in and create one first.');
  process.exit(1);
}

const port = process.env.RTMP_PORT || 1935;
const target = (feed) => `rtmp://127.0.0.1:${port}/live/${feed.key}`;
const run = (argv) => spawn('ffmpeg', argv, { stdio: ['ignore', 'ignore', 'inherit'] })
  .on('error', () => { console.error('ffmpeg not found. Install ffmpeg first.'); process.exit(1); });

// ---- Prepare recorded videos ----
function prepare(file) {
  if (!fs.existsSync(file)) { console.error(`Video not found: ${file}`); process.exit(1); }
  const stat = fs.statSync(file);
  const cacheDir = path.join(dataDir, 'demo-cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const out = path.join(cacheDir, `${path.basename(file).replace(/[^\w.-]/g, '_')}-${stat.size}-${Math.floor(stat.mtimeMs)}.flv`);
  if (!fs.existsSync(out)) {
    console.log(`Converting ${path.basename(file)} for the browser (one time only, may take a minute)…`);
    const r = spawnSync('ffmpeg', [
      '-nostdin', '-loglevel', 'error', '-y', '-i', file, '-t', '600', // first 10 minutes is plenty
      '-vf', 'scale=-2:720', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '3M', '-maxrate', '3M', '-bufsize', '6M',
      '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-f', 'flv', out + '.tmp',
    ], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (r.status !== 0) { console.error(`Could not convert ${file}.`); process.exit(1); }
    fs.renameSync(out + '.tmp', out);
  }
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]);
  return { file: out, duration: parseFloat(String(probe.stdout)) || 0 };
}

let procs;
if (files.length) {
  const videos = files.map(prepare);
  console.log(`Streaming ${videos.length} video(s) into ${room.feeds.length} feeds of "${room.name}". Press Ctrl+C to stop.`);
  procs = room.feeds.map((feed, i) => {
    const v = videos[i % videos.length];
    // Start each feed at a different point so tiles sharing one video don't look identical.
    const offset = v.duration > 10 ? (Math.floor(i / videos.length) * 13) % Math.floor(v.duration - 5) : 0;
    return run(['-nostdin', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-ss', String(offset), '-i', v.file, '-c', 'copy', '-f', 'flv', target(feed)]);
  });
} else {
  console.log(`Streaming ${room.feeds.length} test feeds into "${room.name}". Press Ctrl+C to stop.`);
  procs = room.feeds.map((feed, i) => run([
    '-nostdin', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 50}`,
    '-vf', `drawtext=text='${feed.label.replace(/[':\\]/g, '')}  %{localtime\\:%T}':fontsize=32:fontcolor=white:box=1:boxcolor=black@0.6:x=20:y=20`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '50',
    '-c:a', 'aac', '-f', 'flv', target(feed),
  ]));
}
process.on('SIGINT', () => { procs.forEach((p) => p.kill('SIGINT')); process.exit(0); });
