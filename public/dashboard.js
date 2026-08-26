'use strict';

// Cross-event analytics dashboard. Reads from the server's Supabase-backed
// analytics API (no direct DB access from the browser).

const TYPE_LABEL = {
  multiple_choice: 'Multiple choice', word_cloud: 'Word cloud', rating: 'Rating', open_text: 'Open text',
  worksheet: 'Worksheet',
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

// ---- AI ------------------------------------------------------------------
function aiShow(title, html) {
  document.getElementById('aiTitle').textContent = title;
  document.getElementById('aiBody').innerHTML = html;
  document.getElementById('aiModal').classList.remove('hidden');
}
function aiNotConfigured() {
  return '<div class="card tint"><p class="eyebrow">AI not configured</p>' +
    '<p class="muted" style="margin:0">Set the <code>ANTHROPIC_API_KEY</code> environment variable on the server to turn on AI features.</p></div>';
}
function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
// Refusal card. The gate fires either server-side (message + stats) or from the
// model itself (dataNotes, no message), so both origins land here.
function aiInsufficient(d) {
  const s = d.stats || {};
  const msg = d.message || d.dataNotes ||
    'There is not enough captured data here to report on yet. Collect some responses, then try again.';
  let counts = '';
  if (s.sessions != null) counts = 'Checked ' + plural(s.sessions, 'session') + ' · ' + (s.answeredSessions || 0) + ' with responses';
  else if (s.polls != null || s.responses != null || s.questions != null) {
    counts = plural(s.polls || 0, 'poll') + ' · ' + plural(s.responses || 0, 'response') +
      ' · ' + plural(s.questions || 0, 'audience question');
  }
  return '<div class="card tint"><p class="eyebrow">Answers needed</p>' +
    '<p class="muted" style="margin:0">' + esc(msg) + '</p>' +
    (counts ? '<p class="muted small" style="margin:8px 0 0">' + esc(counts) + '</p>' : '') + '</div>';
}
// bullets() renders an em-dash for an empty array, which reads as a broken render
// rather than "nothing to report" — so drop the whole section instead.
function aiSection(label, arr) {
  if (!arr || !arr.length) return '';
  return '<p class="eyebrow" style="margin-top:14px">' + label + '</p>' + bullets(arr);
}
// A 503 means either "no API key" or "the AI queue shed this call" — very different
// remedies, so read the body rather than guessing from the status alone.
async function aiBusyMessage(res) {
  const d = await res.json().catch(() => null);
  if (d && d.error === 'busy') {
    const s = d.retryAfterSeconds || Number(res.headers.get('Retry-After')) || 20;
    return 'AI is busy right now — try again in about ' + s + 's.';
  }
  return null;
}
// The three failures the server names because pressing the button again cannot
// fix any of them: a rejected key is a config fix, a cut-off answer is a
// max_tokens fix, a refusal is a prompt fix. The server sends the remedy with
// the code; these are only the headings. Null-prototype so an unexpected code
// cannot resolve to something off Object.prototype.
const AI_FATAL_LABEL = Object.assign(Object.create(null), {
  ai_key_rejected: 'AI key rejected',
  ai_truncated: 'Answer cut off',
  ai_refused: 'Request declined',
});
// null for anything unclassified — a dropped socket really is worth another go.
async function aiFail(res) {
  const d = await res.json().catch(() => null);
  const label = d && AI_FATAL_LABEL[d.error];
  return label ? { label, message: d.message || '' } : null;
}
async function aiCall(title, path, body) {
  aiShow(title, '<p class="empty">Thinking…</p>');
  let res;
  try { res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); }
  catch { aiShow(title, '<p class="empty">Network error — try again.</p>'); return null; }
  if (res.status === 503) {
    const busy = await aiBusyMessage(res);
    aiShow(title, busy ? '<p class="empty">' + esc(busy) + '</p>' : aiNotConfigured());
    return null;
  }
  if (!res.ok) {
    const f = await aiFail(res);
    aiShow(title, f
      ? '<div class="card tint"><p class="eyebrow">' + esc(f.label) + '</p>' +
        '<p class="muted" style="margin:0">' + esc(f.message) + '</p></div>'
      : '<p class="empty">AI request failed — try again.</p>');
    return null;
  }
  return res.json().catch(() => null);
}
function bullets(arr) {
  return (arr && arr.length) ? '<ul style="margin:6px 0 0;padding-left:20px">' + arr.map((x) => '<li style="margin-bottom:4px">' + esc(x) + '</li>').join('') + '</ul>' : '<p class="muted small">—</p>';
}
// The server verifies these are verbatim substrings of what the room wrote, and
// the facilitator reads them back aloud — so they render as the room's own words,
// not as bullets that invite a paraphrase.
function aiQuotes(label, arr) {
  if (!arr || !arr.length) return '';
  return '<p class="eyebrow" style="margin-top:14px">' + label + '</p><div class="responses">' +
    arr.map((q) => '<div class="response" style="white-space:pre-wrap">' + esc(q) + '</div>').join('') + '</div>';
}
async function aiDebrief(code) {
  const d = await aiCall('Session debrief', '/api/room/' + code + '/ai/debrief');
  if (!d) return;
  if (d.insufficientData) { aiShow('Session debrief', aiInsufficient(d)); return; }
  let html = '<h2 style="margin:0 0 6px">' + esc(d.headline || '') + '</h2>';
  html += '<p class="sub">' + esc(d.summary || '') + '</p>';
  html += aiSection('Poll takeaways', d.pollTakeaways);
  html += aiSection('Q&amp;A themes', d.qaThemes);
  html += aiSection('Notable quotes', d.quotes);
  html += aiSection('Recommended follow-ups', d.followUps);
  // Keep the denominator in front of the reader so a thin debrief reads as thin.
  if (d.stats) {
    html += '<p class="muted small" style="margin-top:18px">Built from ' + plural(d.stats.responses || 0, 'response') +
      ' across ' + plural(d.stats.polls || 0, 'poll') + ' and ' + plural(d.stats.questions || 0, 'audience question') + '.</p>';
  }
  aiShow('Session debrief', html);
}
// Same section order as the presenter's read-out, so a facilitator who ran the
// analysis in the room recognises the write-up afterwards.
async function aiWorksheet(code, pollId) {
  const title = 'Worksheet analysis';
  const d = await aiCall(title, '/api/room/' + code + '/ai/worksheet', { pollId });
  if (!d) return;
  if (d.insufficientData) { aiShow(title, aiInsufficient(d)); return; }
  // cellGroups carry row/column ids, which only mean something against the sheet
  // they came from — and the analysis response does not carry the box headings.
  const p = detailPolls.find((x) => x.id === pollId) || {};
  const labelOf = (arr, key) => { const hit = (arr || []).find((x) => x.id === key); return hit ? hit.text : key; };

  let html = '<p class="sub">' + esc(d.overview || '') + '</p>';
  const m = d.measurability || {};
  html += '<div class="card tint"><p class="eyebrow">Measurability</p>' +
    '<p style="margin:0">' + esc(m.verdict || '') + '</p>' +
    aiQuotes('Answers that pass', m.strongExamples) +
    aiQuotes('Answers that do not', m.vagueExamples) +
    aiSection('Questions that would sharpen these', m.howToSharpen) + '</div>';
  html += aiSection('Gaps', d.gaps);

  if (d.cellGroups && d.cellGroups.length) {
    html += '<p class="eyebrow" style="margin-top:14px">Box by box</p>' + d.cellGroups.map((g) =>
      '<div class="card" style="margin-bottom:12px">' +
      '<b style="font-family:var(--font-display);font-size:16px">' + esc(labelOf(p.rows, g.rowId)) +
      ' · ' + esc(labelOf(p.columns, g.columnId)) + '</b>' +
      '<p class="small muted" style="margin:6px 0 0">' + esc(g.note || '') + '</p>' +
      (g.themes || []).map((t) =>
        '<p class="small" style="margin:12px 0 0"><b>' + esc(t.label || '') + '</b> — ' + esc(t.detail || '') + '</p>' +
        '<ul style="margin:6px 0 0;padding-left:20px">' + (t.examples || []).map((e) =>
          '<li class="small muted" style="margin-bottom:4px">“' + esc(e) + '”</li>').join('') + '</ul>').join('') +
      '</div>').join('');
  }
  if (d.crossCutting && d.crossCutting.length) {
    html += '<p class="eyebrow" style="margin-top:14px">Across boxes</p>' + d.crossCutting.map((c) =>
      '<div class="card" style="margin-bottom:12px"><b style="font-family:var(--font-display);font-size:16px">' + esc(c.title || '') + '</b>' +
      '<p class="small" style="margin:6px 0 0">' + esc(c.detail || '') + '</p></div>').join('');
  }
  html += aiSection('Recommendations', d.recommendations);

  // Counted by the server, never by the model. Boxes here means boxes on the
  // sheet that got at least one answer, not cells filled across all worksheets.
  html += '<p class="muted small" style="margin-top:18px">Built from ' + plural(d.sampleSize || 0, 'worksheet') +
    ' · ' + (d.filledCells || 0) + ' of ' + (d.totalCells || 0) + ' boxes answered.</p>';
  // Matches the server's small-sample gate, which stops the model writing "the
  // group" below this line — say so rather than leaving the reader to notice.
  if ((d.sampleSize || 0) < 5) {
    html += '<p class="muted small" style="margin:6px 0 0">Fewer than five worksheets — this describes these respondents, not the group.</p>';
  }
  if (d.dataNotes) html += '<p class="muted small" style="margin:6px 0 0">' + esc(d.dataNotes) + '</p>';
  aiShow(title, html);
}
async function aiTrends() {
  const d = await aiCall('Cross-event trends', '/api/ai/trends');
  if (!d) return;
  if (d.insufficientData) { aiShow('Cross-event trends', aiInsufficient(d)); return; }
  let html = '<p class="sub">' + esc(d.summary || '') + '</p>';
  if (d.trends && d.trends.length) {
    html += '<p class="eyebrow">Trends</p>' + d.trends.map((t) =>
      '<div class="card" style="margin-bottom:12px"><b style="font-family:var(--font-display);font-size:16px">' + esc(t.title) + '</b>' +
      '<p class="small" style="margin:6px 0 0">' + esc(t.detail) + '</p>' +
      // Naming the sessions behind a trend makes a one-session "trend" self-evident.
      ((t.sessions && t.sessions.length) ? '<p class="muted small" style="margin:6px 0 0">From: ' + esc(t.sessions.join(', ')) + '</p>' : '') +
      '</div>').join('');
  }
  html += aiSection('Recommendations', d.recommendations);
  aiShow('Cross-event trends', html);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('aiModal').classList.add('hidden'); });

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
// The worksheet analysis comes back keyed by row/column id, so the open session's
// polls stay to hand to turn those ids back into the headings on the sheet.
let detailPolls = [];

async function openDetail(code) {
  const modal = document.getElementById('detailModal');
  document.getElementById('detailBody').innerHTML = '<p class="empty">Loading…</p>';
  document.getElementById('detailTitle').textContent = '—';
  document.getElementById('detailMeta').textContent = '';
  document.getElementById('detailCsv').onclick = () => { window.location = '/api/room/' + code + '/export.csv'; };
  document.getElementById('detailDebrief').onclick = () => aiDebrief(code);
  modal.classList.remove('hidden');

  let d;
  try { d = await fetch('/api/analytics/' + code).then((r) => r.json()); }
  catch { document.getElementById('detailBody').innerHTML = '<p class="empty">Could not load session.</p>'; return; }

  document.getElementById('detailTitle').textContent = d.title || 'Untitled session';
  document.getElementById('detailMeta').textContent =
    d.code + ' · ' + fmtDate(d.createdAt) + (d.endedAt ? ' · ended ' + fmtDate(d.endedAt) : ' · live');

  detailPolls = d.polls || [];

  let html = '';
  if (!d.polls.length) html += '<p class="empty">No polls were run in this session.</p>';
  d.polls.forEach((p) => {
    html += '<div class="card" style="margin-bottom:16px">' +
      '<div class="row" style="align-items:center"><span class="type-chip">' + TYPE_LABEL[p.type] + '</span>' +
      (p.type === 'worksheet'
        ? '<button class="btn ghost sm" onclick="aiWorksheet(\'' + esc(code) + '\',\'' + esc(p.id) + '\')">AI: Analyse worksheet</button>'
        : '') +
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
    // Null prototype: the keys are whatever the room typed, and on a plain {}
    // the word "constructor" reads back a function instead of 0.
    const freq = Object.create(null);
    p.words.forEach((w) => { const k = w.toLowerCase(); freq[k] = (freq[k] || 0) + 1; });
    const entries = Object.entries(freq).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '<p class="muted small">No words submitted.</p>';
    return '<div class="bars">' + entries.map(([w, c]) =>
      '<div class="bar-row"><div class="bar-top"><span class="bar-label">' + esc(w) +
      '</span><span class="bar-val">' + c + '</span></div></div>').join('') + '</div>';
  }
  // Unlike the SSE payload, /api/analytics/:code carries the grid bodies, so the
  // archived worksheet is read box by box rather than as a fill-count heatmap.
  if (p.type === 'worksheet') {
    const rows = p.rows || [], cols = p.columns || [], grids = p.grids || [];
    if (!grids.length || !rows.length || !cols.length) return '<p class="muted small">No worksheets submitted.</p>';
    const n = grids.length;
    const answersFor = (key) => grids
      .map((g) => ({
        text: String((g.cells || {})[key] || '').trim(), author: g.author,
        label: String(g.label || '').trim(), photo: g.source === 'photo',
      }))
      .filter((a) => a.text);
    // One device can submit many sheets — a table captain photographs everyone's
    // paper at their table — so the label is what tells those sheets apart in an
    // archived session. Array, not a {} tally: a label of "constructor" reads back
    // a function on a plain object.
    const labels = [];
    let labelled = 0;
    grids.forEach((g) => {
      const l = String(g.label || '').trim();
      if (!l) return;
      labelled++;
      if (labels.indexOf(l) < 0) labels.push(l);
    });
    // Photo answers were OCR'd and then reviewed by the participant before they
    // submitted, so they are as trustworthy as typed ones — but a facilitator
    // querying an odd wording wants to know a camera was in the chain. Anonymous
    // is normal here, so the marker cannot hang off a name.
    const meta = (a) => {
      const bits = [];
      if (a.label) bits.push(esc(a.label));
      // The em dash only reads as an attribution when the name leads the line.
      if (a.author) bits.push((bits.length ? '' : '— ') + esc(a.author));
      if (a.photo) bits.push(bits.length ? 'from photo' : 'From photo');
      return bits.length ? '<div class="small muted" style="margin-top:6px">' + bits.join(' · ') + '</div>' : '';
    };
    let filled = 0, html = '';
    rows.forEach((r) => {
      html += '<p class="eyebrow" style="margin-top:16px">' + esc(r.text) + '</p>';
      cols.forEach((c) => {
        const got = answersFor(r.id + c.id);
        filled += got.length;
        html += '<p style="margin:10px 0 6px"><b>' + esc(c.text) + '</b>' +
          '<span class="muted small"> · answered ' + got.length + ' of ' + n + '</span></p>';
        html += got.length
          // Answers keep their newlines (the server stores them via cleanMulti), and a
          // collapsed multi-line answer reads as one run-on sentence.
          ? '<div class="responses">' + got.map((a) => '<div class="response" style="white-space:pre-wrap">' + esc(a.text) +
            meta(a) + '</div>').join('') + '</div>'
          // A box nobody could fill is a finding for the facilitator, not a rendering gap.
          : '<p class="muted small" style="margin:0">Nobody answered this box.</p>';
      });
    });
    // Spelling out how many sheets carried a label keeps the count honest when a
    // room mixes labelled table batches with people filling in their own sheet.
    const from = !labels.length ? ''
      : labelled === n ? ' from ' + plural(labels.length, 'table')
        : ' · ' + labelled + ' from ' + plural(labels.length, 'table');
    // Numerators and denominators here are the sums of the per-box counts below,
    // so the headline can be checked against the detail.
    return '<p class="muted small" style="margin:0">' + plural(n, 'worksheet') + from + ' · ' +
      filled + ' of ' + (n * rows.length * cols.length) + ' boxes filled</p>' + html;
  }
  // open_text
  if (!p.responses.length) return '<p class="muted small">No responses submitted.</p>';
  return '<div class="responses">' + p.responses.map((r) => '<div class="response">' + esc(r.text) +
    (r.author ? '<div class="small muted" style="margin-top:6px">— ' + esc(r.author) + '</div>' : '') + '</div>').join('') + '</div>';
}

function closeDetail() { document.getElementById('detailModal').classList.add('hidden'); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

loadList();
