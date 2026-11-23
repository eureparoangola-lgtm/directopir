// Pushes fake "drone" test-pattern feeds into a room so you can try the multi-view without drones.
// Usage: npm run demo            (uses the most recently created room)
//        npm run demo -- <slug>  (a specific room)
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'db.json');
if (!fs.existsSync(dbFile)) {
  console.error('No rooms yet. Start the app (npm start), create a room at /admin, then run this again.');
  process.exit(1);
}
const { rooms } = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const slug = process.argv[2];
const room = slug ? rooms.find((r) => r.slug === slug) : rooms[rooms.length - 1];
if (!room) {
  console.error(slug ? `Room "${slug}" not found.` : 'No rooms yet. Create one at /admin first.');
  process.exit(1);
}

const port = process.env.RTMP_PORT || 1935;
console.log(`Streaming ${room.feeds.length} test feeds into "${room.name}". Press Ctrl+C to stop.`);
const procs = room.feeds.map((feed, i) => {
  const p = spawn('ffmpeg', [
    '-nostdin', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
    '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 50}`,
    '-vf', `drawtext=text='${feed.label.replace(/[':\\]/g, '')}  %{localtime\\:%T}':fontsize=32:fontcolor=white:box=1:boxcolor=black@0.6:x=20:y=20`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '50',
    '-c:a', 'aac', '-f', 'flv', `rtmp://127.0.0.1:${port}/live/${feed.key}`,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  p.on('error', () => { console.error('ffmpeg not found. Install ffmpeg first.'); process.exit(1); });
  return p;
});
process.on('SIGINT', () => { procs.forEach((p) => p.kill('SIGINT')); process.exit(0); });
