(function () {
  const roomId = window.DV_ROOM;

  function copy(text, btn) {
    const done = () => { const t = btn.textContent; btn.textContent = 'Copied ✓'; setTimeout(() => (btn.textContent = t), 1200); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done);
    else { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done(); }
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.copy) return copy(b.dataset.copy, b);
    const row = b.closest('tr[data-feed]');
    if (!row) return;
    if ('copyUrl' in b.dataset) return copy(row.querySelector('[data-url]').textContent, b);
    if ('regen' in b.dataset) {
      if (!confirm('Issue a new RTMP URL for this slot? The old URL stops working and a live drone on it is disconnected.')) return;
      const r = await api(row.dataset.feed, { regenerate: true });
      row.querySelector('[data-url]').textContent = r.rtmpUrl;
    }
  });

  document.addEventListener('change', (e) => {
    if (!e.target.matches('[data-label]')) return;
    api(e.target.closest('tr').dataset.feed, { label: e.target.value });
  });

  async function api(feedId, body) {
    const res = await fetch(`/admin/api/rooms/${roomId}/feeds/${feedId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }

  async function poll() {
    try {
      const { feeds } = await (await fetch(`/admin/api/rooms/${roomId}/status`)).json();
      feeds.forEach((f) => {
        const el = document.querySelector(`tr[data-feed="${f.id}"] [data-status]`);
        if (!el) return;
        el.textContent = f.live ? 'LIVE' : 'offline';
        el.classList.toggle('on', f.live);
      });
    } catch (_) {}
  }
  setInterval(poll, 3000);
})();
