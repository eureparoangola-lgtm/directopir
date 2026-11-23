(function () {
  const { slug, feeds, logo } = window.DV;
  const grid = document.getElementById('grid');
  const tiles = new Map(); // feedId -> { el, video, player, live }
  let focused = null;

  // ---- Build tiles ----
  feeds.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = 'tile offline';
    el.innerHTML = `
      <video muted playsinline></video>
      <div class="overlay">
        <span class="tag"><span class="num">${i + 1}</span><span class="name"></span></span>
        <span class="state">OFFLINE</span>
      </div>
      <div class="placeholder"><div class="spinner"></div><div>Waiting for drone…</div></div>
      <div class="tools">
        <button data-act="audio" title="Toggle sound">🔇</button>
        <button data-act="focus" title="Enlarge">⤢</button>
      </div>`;
    el.querySelector('.name').textContent = f.label;
    if (logo) {
      const img = document.createElement('img');
      img.className = 'tile-logo'; img.src = logo; img.alt = '';
      el.appendChild(img);
    }
    grid.appendChild(el);
    tiles.set(f.id, { el, video: el.querySelector('video'), player: null, live: false, label: f.label });
    el.addEventListener('dblclick', () => toggleFocus(f.id));
    el.querySelector('[data-act=focus]').onclick = () => toggleFocus(f.id);
    el.querySelector('[data-act=audio]').onclick = (e) => {
      const v = tiles.get(f.id).video;
      v.muted = !v.muted;
      e.currentTarget.textContent = v.muted ? '🔇' : '🔊';
    };
  });

  // ---- Layout: pick the column count that gives the biggest 16:9 tiles ----
  function layout() {
    const visible = focused ? 1 : feeds.length;
    const W = grid.clientWidth, H = grid.clientHeight, gap = 6;
    let best = { cols: 1, size: 0 };
    for (let cols = 1; cols <= visible; cols++) {
      const rows = Math.ceil(visible / cols);
      const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9);
      if (w > best.size) best = { cols, size: w };
    }
    grid.style.gridTemplateColumns = `repeat(${best.cols}, ${Math.floor(best.size)}px)`;
    grid.style.gridAutoRows = `${Math.floor(best.size * 9 / 16)}px`;
  }
  window.addEventListener('resize', layout);
  layout();

  function toggleFocus(id) {
    focused = focused === id ? null : id;
    tiles.forEach((t, fid) => t.el.classList.toggle('hidden', !!focused && fid !== focused));
    layout();
  }

  // ---- Playback ----
  function start(id) {
    const t = tiles.get(id);
    if (t.player || !mpegts.isSupported()) return;
    const player = mpegts.createPlayer(
      { type: 'flv', isLive: true, url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${encodeURIComponent(slug)}/${id}.flv` },
      { enableStashBuffer: false, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: 3, liveBufferLatencyMinRemain: 0.5, lazyLoad: false, autoCleanupSourceBuffer: true }
    );
    player.attachMediaElement(t.video);
    player.on(mpegts.Events.ERROR, () => stop(id));
    player.on(mpegts.Events.LOADING_COMPLETE, () => stop(id));
    player.load();
    const p = player.play();
    if (p && p.catch) p.catch(() => {});
    t.player = player;
    t.el.classList.add('connecting');
    t.video.onplaying = () => t.el.classList.remove('connecting', 'offline');
  }

  function stop(id) {
    const t = tiles.get(id);
    if (!t.player) return;
    try { t.player.pause(); t.player.unload(); t.player.detachMediaElement(); t.player.destroy(); } catch (_) {}
    t.player = null;
    t.el.classList.add('offline');
    t.el.classList.remove('connecting');
  }

  // Keep live tiles near real-time if the tab was in the background.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    tiles.forEach((t) => {
      const b = t.video.buffered;
      if (t.player && b.length && b.end(b.length - 1) - t.video.currentTime > 2) t.video.currentTime = b.end(b.length - 1) - 0.3;
    });
  });

  // ---- Status polling: start/stop players as drones go live ----
  async function poll() {
    try {
      const res = await fetch(`/api/v/${encodeURIComponent(slug)}/status`, { cache: 'no-store' });
      if (res.status === 401) return location.reload(); // passcode changed / session expired
      const data = await res.json();
      let n = 0;
      data.feeds.forEach((f) => {
        const t = tiles.get(f.id);
        if (!t) return;
        if (f.label !== t.label) { t.label = f.label; t.el.querySelector('.name').textContent = f.label; }
        t.live = f.live;
        t.el.querySelector('.state').textContent = f.live ? 'LIVE' : 'OFFLINE';
        t.el.classList.toggle('is-live', f.live);
        if (f.live) { n++; if (!t.player) start(f.id); }
        else stop(f.id);
      });
      document.getElementById('liveCount').textContent = n;
    } catch (_) {}
  }
  poll();
  setInterval(poll, 3000);

  document.getElementById('fsBtn').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };
})();
