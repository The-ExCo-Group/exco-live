'use strict';

// Cross-event analytics dashboard. Reads from the server's Supabase-backed
// analytics API (no direct DB access from the browser).

const TYPE_LABEL = {
  multiple_choice: 'Multiple choice', word_cloud: 'Word cloud', rating: 'Rating', open_text: 'Open text',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1700);
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---- list -----------------------------------------------------------------
async function loadList() {
  let data;
  try { data = await fetch('/api/analytics').then((r) => r.json()); }
  catch { document.getElementById('sessionList').innerHTML = '<p class="empty">Could not load analytics.</p>'; return; }

  const t = data.totals || { sessions: 0, responses: 0, questions: 0 };
  document.getElementById('totals').innerHTML =
    tile(t.sessions, 'Sessions') + tile(t.responses, 'Responses') + tile(t.questions, 'Questions');

  const sessions = data.sessions || [];
  document.getElementById('sessionCount').textContent = sessions.length + (sessions.length === 1 ? ' session' : ' sessions');
  const box = document.getElementById('sessionList');
  if (!sessions.length) { box.innerHTML = '<p class="empty">No sessions yet. Create one to get started.</p>'; return; }

  box.innerHTML = sessions.map((s) => (
    '<div class="poll-list-item" style="flex-wrap:wrap">' +
    '<div class="grow" style="min-width:200px">' +
    '<div class="row" style="align-items:center;gap:10px">' +
    '<b style="font-family:var(--font-display);font-size:16px">' + esc(s.title || 'Untitled session') + '</b>' +
    (s.live ? '<span class="pill live"><span class="ping"></span>Live</span>' : '<span class="type-chip">Ended</span>') +
    '</div>' +
    '<div class="type-chip" style="margin-top:4px">' + esc(s.code) + ' · ' + fmtDate(s.createdAt) +
    ' · ' + s.polls + ' poll' + (s.polls === 1 ? '' : 's') +
    ' · ' + s.responses + ' response' + (s.responses === 1 ? '' : 's') +
    ' · ' + s.questions + ' question' + (s.questions === 1 ? '' : 's') + '</div>' +
    '</div>' +
    '<div class="row tight" style="align-items:center">' +
    '<button class="btn sm" onclick="openDetail(\'' + s.code + '\')">View</button>' +
    '<a class="btn ghost sm" href="/api/room/' + s.code + '/export.csv" style="text-decoration:none">CSV</a>' +
    (s.live ? '<a class="btn ghost sm" href="/present/' + s.code + '" style="text-decoration:none">Present</a>' : '') +
    '<button class="btn danger sm" onclick="delSession(\'' + s.code + '\',\'' + esc(s.title).replace(/'/g, "\\'") + '\')">Delete</button>' +
    '</div></div>'
  )).join('');
}

function tile(n, label) {
  return '<div class="card grow" style="text-align:center;min-width:120px">' +
    '<div class="stat-big">' + n + '</div>' +
    '<p class="eyebrow" style="margin:8px 0 0">' + label + '</p></div>';
}

async function delSession(code, title) {
  if (!confirm('Permanently delete "' + title + '" (' + code + ') and all its results? This cannot be undone.')) return;
  await fetch('/api/room/' + code + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  toast('Session deleted');
  loadList();
}

// ---- detail ---------------------------------------------------------------
async function openDetail(code) {
  const modal = document.getElementById('detailModal');
  document.getElementById('detailBody').innerHTML = '<p class="empty">Loading…</p>';
  document.getElementById('detailTitle').textContent = '—';
  document.getElementById('detailMeta').textContent = '';
  document.getElementById('detailCsv').onclick = () => { window.location = '/api/room/' + code + '/export.csv'; };
  modal.classList.remove('hidden');

  let d;
  try { d = await fetch('/api/analytics/' + code).then((r) => r.json()); }
  catch { document.getElementById('detailBody').innerHTML = '<p class="empty">Could not load session.</p>'; return; }

  document.getElementById('detailTitle').textContent = d.title || 'Untitled session';
  document.getElementById('detailMeta').textContent =
    d.code + ' · ' + fmtDate(d.createdAt) + (d.endedAt ? ' · ended ' + fmtDate(d.endedAt) : ' · live');

  let html = '';
  if (!d.polls.length) html += '<p class="empty">No polls were run in this session.</p>';
  d.polls.forEach((p) => {
    html += '<div class="card" style="margin-bottom:16px">' +
      '<div class="row" style="align-items:center"><span class="type-chip">' + TYPE_LABEL[p.type] + '</span>' +
      '<span class="pill right">' + p.totalVotes + ' response' + (p.totalVotes === 1 ? '' : 's') + '</span></div>' +
      '<div class="big-q" style="font-size:22px;margin:10px 0 14px">' + esc(p.question) + '</div>' +
      renderResult(p) + '</div>';
  });
  if (d.questions && d.questions.length) {
    html += '<div class="card"><p class="eyebrow">Audience Q&amp;A</p>' +
      d.questions.map((q) => '<div class="qitem"><div class="qvote" style="cursor:default"><span class="arrow">▲</span>' +
        q.votes + '</div><div class="qtext">' + esc(q.text) +
        (q.author ? '<div class="small muted" style="margin-top:3px">— ' + esc(q.author) + '</div>' : '') +
        '</div></div>').join('') + '</div>';
  }
  document.getElementById('detailBody').innerHTML = html;
}

function renderResult(p) {
  if (p.type === 'multiple_choice') {
    const total = Object.values(p.votes).reduce((a, b) => a + b, 0);
    const max = Math.max(0, ...Object.values(p.votes));
    let lead = false;
    return '<div class="bars">' + p.options.map((o) => {
      const v = p.votes[o.id] || 0;
      const pct = total ? Math.round((v / total) * 100) : 0;
      const isLead = !lead && v > 0 && v === max; if (isLead) lead = true;
      return '<div class="bar-row"><div class="bar-top"><span class="bar-label">' + esc(o.text) +
        '</span><span class="bar-val">' + pct + '% · ' + v + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill ' + (isLead ? 'lead' : '') + '" style="width:' +
        Math.max(pct, v ? 3 : 0) + '%"></div></div></div>';
    }).join('') + '</div>';
  }
  if (p.type === 'rating') {
    const n = p.ratings.length;
    const avg = n ? (p.ratings.reduce((a, b) => a + b, 0) / n).toFixed(2) : '0.00';
    const counts = new Array((p.scaleMax || 5) + 1).fill(0);
    p.ratings.forEach((r) => counts[r]++);
    let rows = '';
    for (let v = (p.scaleMax || 5); v >= 1; v--) {
      const c = counts[v]; const pct = n ? Math.round((c / n) * 100) : 0;
      rows += '<div class="bar-row"><div class="bar-top"><span class="bar-label">' + v +
        '</span><span class="bar-val">' + c + '</span></div><div class="bar-track"><div class="bar-fill" style="width:' +
        Math.max(pct, c ? 3 : 0) + '%"></div></div></div>';
    }
    return '<div class="row" style="align-items:baseline;gap:14px;margin-bottom:10px">' +
      '<div class="stat-big stat-grad">' + avg + '</div><div class="muted">avg of ' + n + ' rating' + (n === 1 ? '' : 's') + '</div></div>' +
      '<div class="bars">' + rows + '</div>';
  }
  if (p.type === 'word_cloud') {
    const freq = {};
    p.words.forEach((w) => { const k = w.toLowerCase(); freq[k] = (freq[k] || 0) + 1; });
    const entries = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '<p class="muted small">No words submitted.</p>';
    return '<div class="bars">' + entries.map(([w, c]) =>
      '<div class="bar-row"><div class="bar-top"><span class="bar-label">' + esc(w) +
      '</span><span class="bar-val">' + c + '</span></div></div>').join('') + '</div>';
  }
  // open_text
  if (!p.responses.length) return '<p class="muted small">No responses submitted.</p>';
  return '<div class="responses">' + p.responses.map((r) => '<div class="response">' + esc(r.text) +
    (r.author ? '<div class="small muted" style="margin-top:6px">— ' + esc(r.author) + '</div>' : '') + '</div>').join('') + '</div>';
}

function closeDetail() { document.getElementById('detailModal').classList.add('hidden'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

loadList();
