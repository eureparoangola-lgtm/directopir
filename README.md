# DroneView: multi-drone live streaming

Stream up to 16 DJI drones per room (default 10) over RTMP and share **one link** that opens a
passcode-protected multi-view grid. Latency is typically **1–3 s**.

```
DJI remote ──RTMP──▶ :1935 ┐
DJI remote ──RTMP──▶ :1935 ├─ DroneView ──WebSocket-FLV──▶ viewers' browsers (https://your-domain/v/<room>)
   … ×10               ┘     (passcode-checked; stream keys never leave the server)
```

## Features
- **Admin dashboard** (`/admin`): create rooms, get a unique RTMP URL per drone, see live/offline status, rename feeds,
  issue a new URL for a slot (disconnects the old one), change the passcode (signs out current viewers), delete rooms.
- **Share link** `https://your-domain/v/<room>` goes straight to the multi-view page. Viewers enter the passcode once
  (stays valid for 12 h by default) and the grid starts.
- **Multi-view**: lays itself out to fill the screen, tiles start on their own when a drone goes live and reconnect if the
  signal drops, double-click a tile to enlarge it, per-tile sound, fullscreen, works on phones.
- **Security**: drones with unknown stream keys are rejected; viewers never see stream keys; the internal media port
  only accepts short-lived signed requests; passcode and admin login are rate-limited; passcodes are stored as scrypt hashes.
- Link previews (Open Graph) so the link shows a title card in WhatsApp, Slack and similar apps.

## Run locally
```bash
npm install
ADMIN_PASSWORD=secret node server.js
```
Open http://localhost:3000/admin. Test without a drone by pushing a fake feed:
```bash
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -c:v libx264 -preset veryfast -tune zerolatency -g 60 -f flv rtmp://localhost/live/<stream-key>
```

## Try it in GitHub Codespaces (no install)
1. On the repo page: **Code → Codespaces → Create codespace on main**. Wait for the setup to finish (2–3 min the first time).
2. In the terminal at the bottom: `npm start`. A browser tab opens on the app (or use the **Ports** tab → port 3000 → globe icon).
3. Add `/admin` to the end of that URL, log in with `test1234`, and create a room.
4. Open a **second terminal** (the **+** button) and run `npm run demo`. This pushes 10 fake drone feeds into the room.
5. Back on the room page, click **Open multi-view** and enter the passcode.

Codespaces only forwards web traffic, so **real DJI remotes cannot connect to a codespace** (RTMP port 1935 stays
private). Use it to try the pages. For real drones, run it on your computer (same Wi-Fi as the remote) or on a server.
To let someone else open the share link, set port 3000 to **Public** in the Ports tab (right-click → Port Visibility).
Stop the codespace when you're done so it doesn't use up your free hours.

## Deploy (VPS + Docker, HTTPS included)
1. Get a VPS (Ubuntu 24.04, 4 vCPU / 8 GB is plenty; **bandwidth is what matters**, see below) and a domain.
   Point the domain's DNS A record at the server.
2. Open ports **80, 443, 1935 (TCP)** in the firewall. Do **not** expose 3000 or 8000.
3. On the server:
   ```bash
   git clone <your repo> droneview && cd droneview
   cp .env.example .env && nano .env        # set DOMAIN, PUBLIC_URL, RTMP_HOST, ADMIN_PASSWORD
   docker compose up -d --build
   ```
4. Go to `https://your-domain/admin`, create a room, then copy each RTMP URL into a remote.

## Entering the URL on DJI remotes
| App | Where |
|---|---|
| **DJI Pilot 2** (Matrice 30/350/4, Mavic 3 Enterprise; RC Plus / RC Pro Enterprise) | ••• → Live Stream → RTMP → paste URL → Start |
| **DJI Fly** (Mini / Air / Mavic 3 / Avata) | Camera view → ••• → Transmission → Live Streaming Platforms → RTMP → paste URL |

The remote needs internet (4G dongle, Wi-Fi or a phone hotspot). Use 720p–1080p at 2–4 Mbps for stable 4G uploads.
If an app asks for a separate server and key: server = `rtmp://your-domain/live`, key = the part after `/live/`.
DJI apps send plain RTMP (not RTMPS), so the video travels unencrypted from the remote to the server. The share page is HTTPS.

## Bandwidth planning
Each feed is about 3 Mbps. Incoming: 10 × 3 = **30 Mbps**. Outgoing: 30 Mbps **per viewer** watching the full grid
(for example, 20 viewers ≈ 600 Mbps). Choose a VPS with enough unmetered bandwidth (Hetzner, OVH, etc.), or put a CDN
or media server in front when you expect large audiences.

## Config (env vars)
| Var | Default | |
|---|---|---|
| `ADMIN_PASSWORD` | (required) | operator login |
| `PUBLIC_URL` | request host | base of share links |
| `RTMP_HOST` | request host | host shown in RTMP URLs |
| `PORT` / `RTMP_PORT` / `MEDIA_HTTP_PORT` | 3000 / 1935 / 8000 | |
| `VIEWER_SESSION_HOURS` | 12 | passcode session length |
| `DATA_DIR` | `./data` | rooms and the server secret (back this up) |
