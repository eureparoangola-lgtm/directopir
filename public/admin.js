(function () {
  const roomId = window.DV_ROOM;

  // Logo picker: check the file, then put it into the form's hidden "logo" field as a data URL.
  document.addEventListener('change', (e) => {
    if (!e.target.matches('[data-logo-file]')) return;
    const input = e.target, hidden = input.parentElement.querySelector('input[name=logo]');
    const file = input.files[0];
    hidden.value = '';
    if (!file) return;
    if (file.type !== 'image/png') { alert('Please choose a PNG file.'); input.value = ''; return; }
    if (file.size > 1024 * 1024) { alert('The logo must be smaller than 1 MB.'); input.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => { hidden.value = reader.result; };
    reader.readAsDataURL(file);
  });

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
    const res = await fetch(`/api/rooms/${roomId}/feeds/${feedId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }

  async function poll() {
    try {
      const { feeds } = await (await fetch(`/api/rooms/${roomId}/status`)).json();
      feeds.forEach((f) => {
        const el = document.querySelector(`tr[data-feed="${f.id}"] [data-status]`);
        if (!el) return;
        el.textContent = f.live ? 'LIVE' : 'offline';
        el.classList.toggle('on', f.live);
      });
    } catch (_) {}
  }
  if (roomId) setInterval(poll, 3000);

  // User dashboard: keep the minutes counter current.
  const usageCard = document.querySelector('[data-usage]');
  async function pollUsage() {
    try {
      const u = await (await fetch('/api/me/usage', { cache: 'no-store' })).json();
      const fmt = (n) => Number(n).toLocaleString('en-US');
      usageCard.querySelector('[data-used]').textContent = fmt(u.usedMinutes);
      usageCard.querySelector('[data-live]').textContent = u.liveFeeds;
      if (u.limitMinutes != null) {
        usageCard.querySelector('[data-remaining]').textContent = fmt(Math.max(0, u.limitMinutes - u.usedMinutes));
        const m = usageCard.querySelector('[data-meter]');
        const pct = Math.min(100, Math.round((u.usedMinutes / u.limitMinutes) * 100));
        if (m) { m.style.width = pct + '%'; m.classList.toggle('warn', pct >= 90); }
      }
      if (!!u.block !== !!document.querySelector('.banner')) location.reload(); // paused or resumed
    } catch (_) {}
  }
  if (usageCard) setInterval(pollUsage, 15000);
})();
