'use strict';

const CODE = location.pathname.split('/').filter(Boolean)[1].toUpperCase();
let state = null;

// ---- boot -----------------------------------------------------------------
const joinUrl = location.origin + '/join/' + CODE;
document.getElementById('codeBadge').textContent = CODE;
document.getElementById('codeBadge2').textContent = CODE;
document.getElementById('hostUrl').textContent = location.host;
document.getElementById('joinLink').textContent = joinUrl;
if (window.QR) QR.render(document.getElementById('qr'), joinUrl, { size: 168 });

// Ticks arrive in bursts — 120 ms apart while a room is answering — and each one
// is a whole new room. Coalescing onto the next frame turns a burst into a single
// render, and a backgrounded console (rAF does not fire there) into none at all
// until it comes forward and paints the latest.
let frameQueued = false;
let ended = false;
function schedule() {
  if (frameQueued || ended) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; render(); });
}
// A console left in a background tab queues a frame that may never be delivered,
// and the flag above would then hold every later tick back — a facilitator who
// checked their slides comes back to a screen frozen at the moment they left.
// Clearing the flag here costs one duplicate render at worst; the paint guards
// make that a no-op.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  frameQueued = false;
  render();
});

function connect() {
  // stage view: the console renders every response, so it needs the full room payload — participants get a slim private one
  const es = new EventSource('/api/stream/' + CODE + '?view=stage');
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.ended) { showEnded(); es.close(); return; }
    state = d;
    schedule();
  };
  es.onerror = () => {/* auto-reconnect */};
}
connect();

function showEnded() {
  ended = true;      // a frame queued behind this would render into a page that no longer has a stage
  ocrWatch(false);   // the body is about to be replaced, and the OCR line with it
  document.body.innerHTML =
    '<div class="wrap" style="max-width:620px"><div class="card center" style="margin-top:80px">' +
    '<p class="eyebrow">Session ended</p><h2 style="border:0">This session has been closed.</h2>' +
    '<p class="muted">Results are saved. View them anytime on the dashboard.</p>' +
    '<div style="height:16px"></div><a class="btn" href="/dashboard" style="text-decoration:none">Go to dashboard</a></div></div>';
}

// ---- session controls -----------------------------------------------------
function exportCsv() { window.location = '/api/room/' + CODE + '/export.csv'; }

async function endSession() {
  if (!confirm('End this session? It stops accepting responses and closes for anyone who joined. Results are kept for the dashboard.')) return;
  await api('/end');
  window.location = '/dashboard';
}
async function deleteSession() {
  if (!confirm('Permanently DELETE this session and all its results? This cannot be undone.')) return;
  await api('/delete');
  window.location = '/';
}

async function api(pathSuffix, body) {
  const res = await fetch('/api/room/' + CODE + pathSuffix, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json().catch(() => ({}));
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1700);
}
function copyLink() { navigator.clipboard.writeText(joinUrl).then(() => toast('Join link copied')); }

// ---- fullscreen join screen (big QR for the room to scan) -----------------
let joinScreenReady = false;
function showJoinScreen() {
  document.getElementById('joinScreenCode').textContent = CODE;
  document.getElementById('joinScreenUrl').textContent = joinUrl;
  if (!joinScreenReady && window.QR) {
    QR.render(document.getElementById('joinScreenQr'), joinUrl, { size: 560 });
    joinScreenReady = true;
  }
  document.getElementById('joinScreen').classList.remove('hidden');
}
function hideJoinScreen() { document.getElementById('joinScreen').classList.add('hidden'); }
function toggleJoinScreen() {
  document.getElementById('joinScreen').classList.contains('hidden') ? showJoinScreen() : hideJoinScreen();
}

const TYPE_LABEL = {
  multiple_choice: 'Multiple choice', word_cloud: 'Word cloud', rating: 'Rating', open_text: 'Open text',
  worksheet: 'Worksheet',
};

// ---- AI features ----------------------------------------------------------
function aiShow(title, html) {
  document.getElementById('aiTitle').textContent = title;
  document.getElementById('aiBody').innerHTML = html;
  document.getElementById('aiModal').classList.remove('hidden');
}
function aiNotConfigured() {
  return '<div class="card tint"><p class="eyebrow">AI not configured</p>' +
    '<p class="muted" style="margin:0">Set the <code>ANTHROPIC_API_KEY</code> environment variable on the server to turn on AI features.</p></div>';
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
function aiFailCard(f) {
  return '<div class="card tint"><p class="eyebrow">' + esc(f.label) + '</p>' +
    '<p class="muted" style="margin:0">' + esc(f.message) + '</p></div>';
}
async function aiCall(title, path, body) {
  aiShow(title, '<p class="empty">Thinking…</p>');
  let res;
  try {
    res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  } catch { aiShow(title, '<p class="empty">Network error — try again.</p>'); return null; }
  if (res.status === 503) {
    const busy = await aiBusyMessage(res);
    aiShow(title, busy ? '<p class="empty">' + esc(busy) + '</p>' : aiNotConfigured());
    return null;
  }
  if (!res.ok) {
    const f = await aiFail(res);
    aiShow(title, f ? aiFailCard(f) : '<p class="empty">AI request failed — try again.</p>');
    return null;
  }
  return res.json().catch(() => null);
}

async function aiQa() {
  const d = await aiCall('Q&A themes', '/api/room/' + CODE + '/ai/qa', {});
  if (!d) return;
  let html = d.overview ? '<p class="sub">' + esc(d.overview) + '</p>' : '';
  if (!d.themes || !d.themes.length) html += '<p class="empty">No themes yet.</p>';
  else html += d.themes.map((t) =>
    '<div class="card" style="margin-bottom:12px"><div class="row" style="align-items:center">' +
    '<b style="font-family:var(--font-display);font-size:16px">' + esc(t.title) + '</b>' +
    '<span class="pill right">' + (t.count || 0) + '</span></div>' +
    '<p class="small" style="margin:6px 0 0">' + esc(t.summary) + '</p>' +
    (t.sample ? '<p class="small muted" style="margin:6px 0 0">e.g. “' + esc(t.sample) + '”</p>' : '') + '</div>').join('');
  aiShow('Q&A themes', html);
}

async function aiSynth(pollId) {
  const d = await aiCall('Response synthesis', '/api/room/' + CODE + '/poll/' + pollId + '/ai/synthesize', {});
  if (!d) return;
  let html = '<div class="row" style="gap:10px;align-items:baseline;margin-bottom:6px"><span class="type-chip">Sentiment</span>' +
    '<b style="font-family:var(--font-display);font-size:16px">' + esc(d.sentiment || '') + '</b></div>';
  if (d.pulse) html += '<p class="sub">' + esc(d.pulse) + '</p>';
  if (d.themes && d.themes.length) {
    html += '<p class="eyebrow">Themes</p>' +
      d.themes.map((t) => '<div style="margin-bottom:8px"><b>' + esc(t.label) + '</b> — <span class="muted">' + esc(t.summary) + '</span></div>').join('');
  }
  if (d.quotes && d.quotes.length) {
    html += '<p class="eyebrow" style="margin-top:12px">Representative quotes</p><div class="responses">' +
      d.quotes.map((q) => '<div class="response">' + esc(q) + '</div>').join('') + '</div>';
  }
  aiShow('Response synthesis', html);
}

function bullets(arr) {
  return '<ul style="margin:6px 0 0;padding-left:20px">' +
    arr.map((x) => '<li style="margin-bottom:4px">' + esc(x) + '</li>').join('') + '</ul>';
}
function aiSection(label, arr) {
  if (!arr || !arr.length) return '';
  return '<p class="eyebrow" style="margin:22px 0 0">' + label + '</p>' + bullets(arr);
}
// Verbatim, in the room's own words — these get read aloud, and nobody recognises
// their own answer in a paraphrase.
function wsQuotes(label, list, accent) {
  if (!list || !list.length) return '';
  return '<p class="eyebrow" style="margin:18px 0 0">' + label + '</p><div class="responses">' +
    list.map((q) => '<div class="response" style="white-space:pre-wrap;border-left-color:' + accent + '">' +
      esc(q) + '</div>').join('') + '</div>';
}
// howToSharpen is {answer, question} pairs, not strings — the answer is verbatim
// and the question is what to put to whoever wrote it. Plain strings out, because
// aiSection escapes what it is handed.
function wsSharpen(list) {
  return (Array.isArray(list) ? list : [])
    .filter((e) => e && e.answer && e.question)
    .map((e) => '“' + e.answer + '” — ' + e.question);
}
// Row by row in the sheet's own order: the facilitator reads the grid the way it
// was printed, not the order boxes came back in. The server tallies against this
// same grid, so a box it named is a box we can label.
function wsCellGroups(groups, poll) {
  const rows = poll.rows || [];
  const cols = poll.columns || [];
  if (!groups || !groups.length || !rows.length) return '';
  const n = poll.gridCount || 0;
  const fill = poll.cellFill || {};
  return rows.map((r) => {
    const boxes = cols.map((c) => {
      const g = groups.find((x) => x.rowId === r.id && x.columnId === c.id);
      if (!g) return '';
      const themes = (g.themes || []).map((t) =>
        '<div style="margin-top:12px"><b style="font-family:var(--font-display);font-size:15px">' + esc(t.label) + '</b>' +
        '<p class="small" style="margin:4px 0 0">' + esc(t.detail) + '</p>' +
        (t.examples || []).map((x) => '<p class="small muted" style="margin:6px 0 0">“' + esc(x) + '”</p>').join('') +
        '</div>').join('');
      return '<div class="card" style="margin-top:10px"><div class="row" style="align-items:baseline">' +
        '<span class="type-chip">' + esc(c.text) + '</span>' +
        '<span class="pill right">' + (fill[r.id + c.id] || 0) + ' of ' + n + '</span></div>' +
        (g.note ? '<p class="small" style="margin:8px 0 0">' + esc(g.note) + '</p>' : '') + themes + '</div>';
    }).join('');
    return boxes ? '<p class="eyebrow" style="margin:20px 0 0">' + esc(r.text) + '</p>' + boxes : '';
  }).join('');
}
// The sheet's own footnote makes measurability the point — "you can't measure this"
// is not an answer — so the panel leads with the verdict and the verbatim answers
// that fail it. Those are what gets read back to the room.
async function aiWorksheet(pollId) {
  const title = 'Worksheet analysis';
  const d = await aiCall(title, '/api/room/' + CODE + '/ai/worksheet', { pollId });
  if (!d) return;
  if (d.insufficientData) {
    aiShow(title, '<div class="card tint"><p class="eyebrow">Answers needed</p>' +
      '<p class="muted" style="margin:0">' + esc(d.message || d.dataNotes ||
        'There are not enough worksheet answers to analyse yet. Collect a few, then try again.') + '</p></div>');
    return;
  }
  const poll = state.polls.find((p) => p.id === pollId) || {};
  const m = d.measurability || {};
  let html = d.overview ? '<p class="sub">' + esc(d.overview) + '</p>' : '';
  html += '<div class="card tint"><p class="eyebrow">Measurability</p>' +
    (m.verdict ? '<p style="margin:0;font-size:16px">' + esc(m.verdict) + '</p>' : '') +
    wsQuotes('Answers that pass the test', m.strongExamples, 'var(--green)') +
    wsQuotes('Read these back — no observer, or no signal', m.vagueExamples, 'var(--text)') +
    aiSection('Questions that would sharpen them', wsSharpen(m.howToSharpen)) + '</div>';
  if (d.gaps && d.gaps.length) {
    html += '<div class="card" style="margin-top:14px"><p class="eyebrow">Boxes nobody could fill</p>' +
      bullets(d.gaps) + '</div>';
  }
  const cells = wsCellGroups(d.cellGroups, poll);
  if (cells) html += '<p class="eyebrow" style="margin:26px 0 0">Box by box</p>' + cells;
  if (d.crossCutting && d.crossCutting.length) {
    html += '<p class="eyebrow" style="margin:26px 0 0">Across the sheet</p>' + d.crossCutting.map((c) =>
      '<div class="card" style="margin-top:10px"><b style="font-family:var(--font-display);font-size:16px">' + esc(c.title) + '</b>' +
      '<p class="small" style="margin:6px 0 0">' + esc(c.detail) + '</p></div>').join('');
  }
  html += aiSection('Recommendations', d.recommendations);
  // Counts are the server's own tally, not the model's — the facilitator quotes
  // these at the room as fact, and a thin sample has to read as thin.
  const n = d.sampleSize || 0;
  html += '<p class="muted small" style="margin-top:26px">Built from ' + n + ' worksheet' + (n === 1 ? '' : 's') +
    ' · ' + (d.filledCells || 0) + ' of ' + (d.totalCells || 0) + ' boxes got at least one answer.' +
    (d.dataNotes ? ' ' + esc(d.dataNotes) : '') + '</p>';
  if (n < 5) {
    html += '<p class="small" style="margin:8px 0 0;border-left:2px solid var(--line-strong);padding-left:10px">' +
      'Small sample — this describes these ' + n + ' worksheet' + (n === 1 ? '' : 's') + ', not the group.</p>';
  }
  aiShow(title, html);
}

async function aiDraft() {
  const topic = document.getElementById('pTopic').value.trim();
  if (!topic) { toast('Enter a topic to draft'); return; }
  const type = document.getElementById('pType').value;
  const btn = document.getElementById('aiDraftBtn');
  const label = btn.textContent; btn.textContent = '…'; btn.disabled = true;
  let res;
  try {
    res = await fetch('/api/ai/draft-poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic, type }) });
  } catch { toast('Network error'); btn.textContent = label; btn.disabled = false; return; }
  btn.textContent = label; btn.disabled = false;
  if (res.status === 503) { toast((await aiBusyMessage(res)) || 'AI not configured'); return; }
  // Same three verdicts as aiCall's. "Draft failed" for a rejected key sends a
  // facilitator retyping the topic instead of fixing the server.
  if (!res.ok) { const f = await aiFail(res); toast(f ? f.label : 'Draft failed'); return; }
  const d = await res.json().catch(() => null);
  if (!d) return;
  document.getElementById('pQuestion').value = d.question || '';
  if (type === 'multiple_choice' && Array.isArray(d.options) && d.options.length) {
    const box = document.getElementById('opts');
    if (box) { box.innerHTML = ''; d.options.forEach((o) => addOpt(o)); }
  }
  if (type === 'rating') {
    const lo = document.getElementById('labLow'); if (lo && d.scaleLabelLow) lo.value = d.scaleLabelLow;
    const hi = document.getElementById('labHigh'); if (hi && d.scaleLabelHigh) hi.value = d.scaleLabelHigh;
  }
  toast('Draft ready — edit and create');
}

// ---- create poll modal ----------------------------------------------------
// The shipped worksheet, verbatim from the client's document. Kept here as well
// as on the server so the "load" button fills the form with no round-trip.
const MFI = {
  title: 'Mentoring for Impact',
  rowHeader: "Typical focus areas of a client's action plan",
  rows: ['Delegation', 'Prioritization', 'Peer and stakeholder management'],
  columns: [
    'Stakeholders who would need to notice improvement',
    'What might early indicators of success be?',
    'How might longer-term impact show up?',
  ],
  instructions: 'What would stakeholders ideally see/think/feel differently about a client if we were making progress with them? Please fill out your suggestions for each box below.',
  footnote: 'Friendly nudge here that "you can\'t measure this" is not an answer. If you had to help your client find a way to measure and demonstrate impact, what would it be?',
};

function openCreate() {
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('pQuestion').value = '';
  renderTypeFields();
}
function closeCreate() { document.getElementById('modal').classList.add('hidden'); }

function renderTypeFields() {
  const type = document.getElementById('pType').value;
  const el = document.getElementById('typeFields');
  // aiDraftPoll only knows the four question types; asked for a worksheet it
  // would hand back a multiple-choice draft without saying so.
  document.getElementById('aiDraftRow').classList.toggle('hidden', type === 'worksheet');
  if (type === 'multiple_choice') {
    el.innerHTML = '<label>Options</label><div id="opts"></div>' +
      '<button class="btn ghost sm" onclick="addOpt()">+ Add option</button>';
    addOpt('Yes'); addOpt('No');
  } else if (type === 'rating') {
    el.innerHTML =
      '<label>Scale maximum (2–10)</label><input id="scaleMax" type="number" min="2" max="10" value="5" />' +
      '<label>Low-end label</label><input id="labLow" type="text" value="Not at all" />' +
      '<label>High-end label</label><input id="labHigh" type="text" value="Fully" />';
  } else if (type === 'word_cloud') {
    el.innerHTML = '<p class="small muted">Participants submit words or short phrases that appear sized by frequency.</p>';
  } else if (type === 'worksheet') {
    el.innerHTML =
      '<p class="small muted">Participants fill in every box of a grid and submit it. Each submission is one person’s sheet, ' +
      'so one phone can send in several — a stack of paper sheets photographed one by one — each with an optional label ' +
      'such as a table number. Rows × columns is the whole worksheet.</p>' +
      '<button class="btn ghost sm" onclick="loadMfiWorksheet()">Load the Mentoring for Impact worksheet</button>' +
      '<label>Row header</label><input id="wsRowHeader" type="text" placeholder="What the rows are, e.g. Focus areas" />' +
      '<label>Rows — one per line (max 6)</label>' +
      '<textarea id="wsRows" style="min-height:84px" placeholder="Delegation&#10;Prioritization"></textarea>' +
      '<label>Columns — one per line (max 4)</label>' +
      '<textarea id="wsCols" style="min-height:84px" placeholder="Who would notice?&#10;Early indicators?"></textarea>' +
      '<label>Instructions</label>' +
      '<textarea id="wsInstructions" style="min-height:70px" placeholder="Shown above the grid on every phone"></textarea>' +
      '<label>Footnote</label>' +
      '<textarea id="wsFootnote" style="min-height:70px" placeholder="Shown under the grid"></textarea>';
  } else {
    el.innerHTML = '<p class="small muted">Participants submit free-text responses that stream in live.</p>';
  }
}
function loadMfiWorksheet() {
  document.getElementById('pQuestion').value = MFI.title;
  document.getElementById('wsRowHeader').value = MFI.rowHeader;
  document.getElementById('wsRows').value = MFI.rows.join('\n');
  document.getElementById('wsCols').value = MFI.columns.join('\n');
  document.getElementById('wsInstructions').value = MFI.instructions;
  document.getElementById('wsFootnote').value = MFI.footnote;
  toast('Worksheet loaded — edit and create');
}
const splitLines = (s) => s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
function addOpt(val) {
  const box = document.getElementById('opts');
  const div = document.createElement('div');
  div.className = 'option-editor';
  div.innerHTML = '<input type="text" class="opt-input grow" value="' + (val || '').replace(/"/g, '&quot;') +
    '" placeholder="Option text" /><button class="btn ghost sm" onclick="this.parentNode.remove()">✕</button>';
  box.appendChild(div);
}
// No "create and present": a poll is answerable from the moment it exists, so
// creating one IS putting it in front of the room.
async function createPoll() {
  const type = document.getElementById('pType').value;
  const question = document.getElementById('pQuestion').value.trim();
  if (!question) { toast('Add a question first'); return; }
  const payload = { type, question };
  if (type === 'multiple_choice') {
    payload.options = [...document.querySelectorAll('.opt-input')].map((i) => i.value.trim()).filter(Boolean);
  }
  if (type === 'rating') {
    payload.scaleMax = document.getElementById('scaleMax').value;
    payload.scaleLabelLow = document.getElementById('labLow').value;
    payload.scaleLabelHigh = document.getElementById('labHigh').value;
  }
  if (type === 'worksheet') {
    payload.rowHeader = document.getElementById('wsRowHeader').value.trim();
    payload.rows = splitLines(document.getElementById('wsRows').value);
    payload.columns = splitLines(document.getElementById('wsCols').value);
    payload.instructions = document.getElementById('wsInstructions').value.trim();
    payload.footnote = document.getElementById('wsFootnote').value.trim();
    // An axis-less worksheet is nothing a phone can render, so the server quietly
    // substitutes the shipped one — creating a poll nobody asked for.
    if (!payload.rows.length !== !payload.columns.length) {
      toast('Add both rows and columns, or leave both blank for the standard worksheet');
      return;
    }
  }
  await api('/poll', payload);
  closeCreate();
  toast('Added to the run of show');
}

// ---- preload / import -----------------------------------------------------
function openImport() { document.getElementById('importModal').classList.remove('hidden'); }
function closeImport() { document.getElementById('importModal').classList.add('hidden'); }

const TYPE_ALIAS = {
  mc: 'multiple_choice', choice: 'multiple_choice', multiple: 'multiple_choice', multiple_choice: 'multiple_choice',
  poll: 'multiple_choice', word: 'word_cloud', wordcloud: 'word_cloud', word_cloud: 'word_cloud', cloud: 'word_cloud',
  rating: 'rating', rate: 'rating', scale: 'rating',
  text: 'open_text', open: 'open_text', open_text: 'open_text', opentext: 'open_text',
  worksheet: 'worksheet', grid: 'worksheet', ws: 'worksheet',
};

// Append a ready-made worksheet block rather than replacing what is already typed:
// the worksheet is one item in a run of show, not the whole run.
function insertMfiBlock() {
  const ta = document.getElementById('importText');
  const block = '[worksheet] ' + MFI.title + '\n' +
    '* ' + MFI.rowHeader + '\n' +
    MFI.rows.map((r) => '- ' + r).join('\n') + '\n' +
    MFI.columns.map((c) => '| ' + c).join('\n') + '\n' +
    '> ' + MFI.instructions + '\n' +
    '~ ' + MFI.footnote + '\n';
  ta.value = ta.value.trim() ? ta.value.trim() + '\n\n' + block : block;
  ta.focus();
  toast('Worksheet block added');
}

// Parse the paste syntax into an array of poll definitions.
function parseImport(raw) {
  const lines = raw.split(/\r?\n/);
  const polls = [];
  let cur = null;
  const push = () => { if (cur) polls.push(cur); cur = null; };
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const header = t.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (header) {
      push();
      const tag = header[1].trim().toLowerCase();
      const kind = tag.split(/\s+/)[0];
      const type = TYPE_ALIAS[kind] || 'multiple_choice';
      let question = header[2].trim();
      const def = { type, options: [] };
      if (type === 'rating') {
        const range = tag.match(/(\d+)\s*-\s*(\d+)/);
        if (range) def.scaleMax = parseInt(range[2], 10);
        const parts = question.split('|').map((s) => s.trim());
        question = parts[0];
        if (parts[1]) def.scaleLabelLow = parts[1];
        if (parts[2]) def.scaleLabelHigh = parts[2];
      }
      if (type === 'worksheet') def.columns = [];
      def.question = question;
      cur = def;
    } else if (cur && cur.type === 'worksheet' && /^[>*|~]\s+/.test(t)) {
      // Before the bullet rule on purpose: inside a worksheet '*' labels the row
      // axis. '-' bullets still land in options, which makePoll reads as rows.
      const val = t.slice(1).trim();
      if (t[0] === '>') cur.instructions = val;
      else if (t[0] === '*') cur.rowHeader = val;
      else if (t[0] === '|') cur.columns.push(val);
      else cur.footnote = val;
    } else if (cur && /^[-*•]\s+/.test(t)) {
      cur.options.push(t.replace(/^[-*•]\s+/, '').trim());
    } else if (cur && !cur.question) {
      cur.question = t;
    }
  }
  push();
  return polls.filter((p) => p.question);
}

async function runImport() {
  const raw = document.getElementById('importText').value;
  const replace = document.getElementById('importReplace').checked;
  const polls = parseImport(raw);
  if (!polls.length) { toast('Nothing to load — check the format'); return; }
  // Same verdict the create modal reaches, and the server's. '-' rows with no '|'
  // column lines — or '*' used as a plain bullet, which inside a worksheet is the
  // row header — leaves one axis empty. A block with NEITHER axis is the shipped-
  // worksheet shorthand and stays legal. Name the question, before the post.
  const half = polls.find((p) => p.type === 'worksheet' &&
    !!(p.rows || p.options || []).length !== !!(p.columns || []).length);
  if (half) { toast('“' + half.question + '” needs at least one row (-) and one column (|)'); return; }
  const r = await api('/polls', { polls, replace });
  closeImport();
  document.getElementById('importText').value = '';
  toast('Loaded ' + (r.count || polls.length) + ' question' + (polls.length === 1 ? '' : 's'));
}

// ---- agenda templates -----------------------------------------------------
function openSaveAgenda() {
  if (!state || !state.polls.length) { toast('Add questions first'); return; }
  document.getElementById('agendaName').value = state.title && state.title !== 'Untitled session' ? state.title : '';
  document.getElementById('saveModal').classList.remove('hidden');
}
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
async function saveAgenda() {
  const name = document.getElementById('agendaName').value.trim();
  if (!name) { toast('Name the template'); return; }
  const r = await fetch('/api/agenda', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, fromRoom: CODE }),
  }).then((x) => x.json());
  closeModal('saveModal');
  toast(r.ok ? 'Saved “' + name + '”' : 'Could not save');
}
async function openLoadAgenda() {
  const box = document.getElementById('agendaList');
  box.innerHTML = '<p class="muted small">Loading…</p>';
  document.getElementById('loadModal').classList.remove('hidden');
  const { agendas } = await fetch('/api/agendas').then((x) => x.json());
  if (!agendas || !agendas.length) { box.innerHTML = '<p class="empty">No saved templates yet.</p>'; return; }
  box.innerHTML = agendas
    .map((a) => '<div class="poll-list-item"><div class="grow"><b>' + esc(a.name) + '</b>' +
      '<div class="type-chip">' + a.count + ' question' + (a.count === 1 ? '' : 's') + '</div></div>' +
      '<button class="btn sm" onclick="loadAgenda(\'' + esc(a.name).replace(/'/g, "\\'") + '\')">Load</button></div>')
    .join('');
}
async function loadAgenda(name) {
  const r = await api('/load-agenda', { name });
  closeModal('loadModal');
  toast('Loaded ' + (r.count || 0) + ' question' + (r.count === 1 ? '' : 's'));
}

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === 'Escape') { hideJoinScreen(); return; }
  if (document.querySelector('.modal-bg:not(.hidden)')) return;
  if (e.key === 'j' || e.key === 'J') { e.preventDefault(); toggleJoinScreen(); }
});

// ---- paint guards ---------------------------------------------------------
// A tick is a whole new room, but a burst of answers usually moves one number in
// one card. Rewriting innerHTML that has not changed relays out the entire run
// of show on every frame — visible as scroll drift on a long stage, and it drops
// whatever the facilitator was mid-selection on. So each region carries a
// fingerprint of exactly the fields its renderer reads. Hashing a few thousand
// characters costs microseconds; the layout it skips costs milliseconds.
function hash(h, s) {
  s = String(s);
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}
const hashAll = (h, ...xs) => xs.reduce(hash, h);
const painted = Object.create(null);
function paint(id, sig, build) {
  const el = document.getElementById(id);
  if (!el || painted[id] === sig) return;
  painted[id] = sig;
  el.innerHTML = build();
}
function setText(id, s) {
  const el = document.getElementById(id);
  if (el && el.textContent !== s) el.textContent = s;
}

// The run of show drives the rail and the progress panel alike, and both read
// only these five fields, so one fingerprint covers both.
function rosSig() {
  let h = 5381;
  for (const p of state.polls) h = hashAll(h, p.id, p.type, p.state, p.question, p.totalVotes);
  return h;
}

// ---- render ---------------------------------------------------------------
function render() {
  if (ended || !state) return;
  setText('roomTitle', state.title || 'Session');
  const ros = rosSig();
  paint('pollList', ros, pollListHtml);
  paint('progressBody', ros, progressHtml);
  renderStage();
  renderQA();
}

// The rail is the editor — order, delete, jump. What a question is *doing* is on
// its stage card, which is where the answers are.
function pollListHtml() {
  const polls = state.polls;
  if (!polls.length) return '<p class="small muted center">No questions preloaded yet.</p>';
  return polls.map((p, i) =>
    '<div class="poll-list-item ros">' +
    '<div class="pli-main">' +
    '<span class="idx">' + (i + 1) + '</span>' +
    '<div class="grow"><div class="type-chip">' + TYPE_LABEL[p.type] +
    (p.state === 'closed' ? ' · Closed' : '') + '</div>' +
    '<div class="pli-q">' + esc(p.question) + '</div></div>' +
    '<span class="pill">' + p.totalVotes + '</span>' +
    '</div>' +
    '<div class="pli-controls">' +
    '<button class="btn ghost sm" title="Move up" onclick="api(\'/poll/' + p.id + '/move\',{dir:\'up\'})"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
    '<button class="btn ghost sm" title="Move down" onclick="api(\'/poll/' + p.id + '/move\',{dir:\'down\'})"' + (i === polls.length - 1 ? ' disabled' : '') + '>↓</button>' +
    '<span class="spacer"></span>' +
    '<button class="btn ghost sm" onclick="jumpTo(\'' + p.id + '\')">Results</button>' +
    '<button class="btn ghost sm" title="Delete" onclick="delPoll(\'' + p.id + '\')">✕</button>' +
    '</div></div>').join('');
}
async function delPoll(id) { await api('/poll/' + id + '/delete'); }
// One Reset per card now, twenty of them down a long stage — near enough to the
// buttons a facilitator does press mid-session to be worth a question first.
async function resetPoll(id) {
  const p = state.polls.find((x) => x.id === id);
  if (!confirm('Delete every answer to “' + (p ? p.question : 'this question') + '”? This cannot be undone.')) return;
  await api('/poll/' + id + '/reset');
}

// ---- overall progress -----------------------------------------------------
// Nobody registers to join, and the server never broadcasts who submitted what,
// so the room has no attendance list. The busiest question is the closest thing
// to a headcount: for these three types one device holds exactly one answer,
// because going back and changing it replaces the old one. A word cloud counts
// words and a worksheet counts sheets — one phone sends several of each — so
// neither can be read as people.
const HEADCOUNT_TYPE = { multiple_choice: true, rating: true, open_text: true };
const isHeadcount = (p) => HEADCOUNT_TYPE[p.type] === true;
const COUNT_NOUN = { word_cloud: 'word', worksheet: 'worksheet' };
const nounOf = (p) => COUNT_NOUN[p.type] || 'response';
const countNoun = (p, n) => nounOf(p) + (n === 1 ? '' : 's');

function progress() {
  const polls = state.polls;
  const counted = polls.filter(isHeadcount);
  const reach = counted.reduce((m, p) => Math.max(m, p.totalVotes), 0);
  // "Has anyone got this far" needs no headcount, so worksheets and clouds count here.
  let frontier = -1;
  polls.forEach((p, i) => { if (p.totalVotes > 0) frontier = i; });
  // The prefix everyone still answering has finished: it breaks at the first
  // question short of the busiest one. A question with no headcount is skipped
  // rather than assumed done — a worksheet cannot confirm the streak either way.
  let together = -1;
  if (reach) {
    for (let i = 0; i < polls.length; i++) {
      if (!isHeadcount(polls[i])) continue;
      if (polls[i].totalVotes < reach) break;
      together = i;
    }
  }
  const answered = counted.reduce((a, p) => a + Math.min(p.totalVotes, reach), 0);
  const pct = reach && counted.length ? Math.round((answered / (reach * counted.length)) * 100) : 0;
  return { reach, frontier, together, pct, counted: counted.length };
}

function progressHtml() {
  const polls = state.polls;
  const head = '<div class="row" style="align-items:center"><p class="eyebrow" style="margin:0">Room progress</p>';
  if (!polls.length) {
    return head + '</div><p class="small muted" style="margin:14px 0 0">' +
      'Add questions — the room can start on them the moment they exist.</p>';
  }
  const g = progress();
  const total = polls.reduce((a, p) => a + p.totalVotes, 0);
  const stat = g.counted
    ? '<div class="stat-big stat-grad">' + g.pct + '%</div>' +
      '<div class="muted">of the run of show answered' +
      '<span class="small" style="display:block">averaged over the ' + g.counted + ' question' +
      (g.counted === 1 ? '' : 's') + ' that count one answer per person</span></div>'
    : '<div class="stat-big stat-grad">' + total + '</div>' +
      '<div class="muted">answers in' +
      '<span class="small" style="display:block">nothing here counts one answer per person, ' +
      'so there is no headcount to measure against</span></div>';

  const facts = [];
  if (g.together >= 0) facts.push('All ' + g.reach + ' have answered through question ' + (g.together + 1) + '.');
  facts.push(g.frontier >= 0
    ? 'The furthest anyone has got is question ' + (g.frontier + 1) + ' of ' + polls.length + '.'
    : 'Nobody has answered anything yet.');
  if (polls.some((p) => !isHeadcount(p))) {
    facts.push('Word clouds count words and worksheets count sheets — neither is a headcount.');
  }

  // Silent rather than "no answers yet" when a room of worksheets and clouds has
  // plenty of answers and simply no headcount to state — the stat below says so.
  const pill = g.reach ? g.reach + ' answering' : (total ? '' : 'No answers yet');
  return head + (pill ? '<span class="pill right">' + pill + '</span>' : '') + '</div>' +
    '<div class="row" style="align-items:baseline;gap:18px;margin:16px 0 12px">' + stat + '</div>' +
    '<p class="small muted" style="margin:0 0 8px">' + facts.join(' ') + '</p>' +
    polls.map((p, i) => progressRow(p, i, g.reach)).join('');
}

// One row per question in run-of-show order, so where the room has got to is the
// row where the bars fall off. Clicking jumps to that question's live results.
function progressRow(p, i, reach) {
  const n = p.totalVotes;
  const pct = reach ? Math.round((Math.min(n, reach) / reach) * 100) : 0;
  const gauge = isHeadcount(p)
    ? '<div class="bar-track" style="height:8px"><div class="bar-fill' + (reach && n >= reach ? ' lead' : '') +
      '" style="width:' + Math.max(pct, n ? 4 : 0) + '%"></div></div>'
    // No bar where there is nothing to measure against — the unit instead.
    : '<span class="type-chip">' + nounOf(p) + 's</span>';
  return '<div class="row tight" onclick="jumpTo(\'' + p.id + '\')" title="Jump to this question" ' +
    'style="align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--line);cursor:pointer">' +
    '<span style="font-family:var(--font-serif);color:var(--muted);min-width:18px;text-align:right">' + (i + 1) + '</span>' +
    '<div class="grow" style="min-width:0;font-family:var(--font-display);font-weight:700;font-size:13px;' +
    'line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(p.question) + '</div>' +
    (p.state === 'closed' ? '<span class="type-chip">Closed</span>' : '') +
    '<div style="flex:0 0 104px">' + gauge + '</div>' +
    '<span class="small muted" style="flex:0 0 68px;text-align:right">' +
    (isHeadcount(p) ? n + ' of ' + reach : n) + '</span></div>';
}

// ---- stage: the whole run of show, live -----------------------------------
// Nothing is "on screen" any more — the room is spread across every question at
// once — so the stage is one card per question, in order, each with its own
// results. Cards are kept as elements rather than rebuilt from a string: only
// the one whose numbers moved is rewritten, so a long stage neither jitters nor
// loses the reader's place on every tick.
const cards = new Map();    // pollId -> { el, sig }
const folded = new Set();   // collapsed cards, held across ticks

function pollSig(p, open, i) {
  let h = hashAll(5381, p.id, p.type, p.state, p.question, i, p.totalVotes);
  if (!open) return h;   // a folded card draws no results, so nothing below can change it
  if (p.type === 'multiple_choice') {
    for (const o of p.options) h = hashAll(h, o.id, o.text, p.votes[o.id] || 0);
  } else if (p.type === 'rating') {
    h = hashAll(h, p.scaleMax, p.scaleLabelLow, p.scaleLabelHigh, p.ratings.join(','));
  } else if (p.type === 'word_cloud') {
    // Not the length: one person revising "agile" to "fast" leaves the count alone.
    for (const w of p.words) h = hash(h, w);
  } else if (p.type === 'open_text') {
    for (const r of p.responses) h = hashAll(h, r.id, r.text, r.author || '');
  } else if (p.type === 'worksheet') {
    h = hashAll(h, p.gridCount, p.rowHeader || '', p.instructions || '');
    for (const r of p.rows || []) h = hashAll(h, r.id, r.text);
    for (const c of p.columns || []) h = hashAll(h, c.id, c.text);
    const fill = p.cellFill || {};
    for (const k of Object.keys(fill)) h = hashAll(h, k, fill[k]);
    for (const t of wsLabelTally(p)) h = hashAll(h, t.label, t.count);
  }
  return h;
}

function renderStage() {
  const emptyCard = document.getElementById('stageEmpty');
  const content = document.getElementById('stageContent');
  const foldBtn = document.getElementById('foldAllBtn');
  const polls = state.polls;
  // Only a worksheet can put anything in the OCR lane — but any of them can now.
  ocrWatch(polls.some((p) => p.type === 'worksheet'));
  setText('stageCount', polls.length ? polls.length + (polls.length === 1 ? ' question' : ' questions') : '');
  if (!polls.length) {
    emptyCard.classList.remove('hidden');
    content.classList.add('hidden');
    content.innerHTML = '';
    cards.clear();
    folded.clear();
    foldBtn.classList.add('hidden');
    return;
  }
  emptyCard.classList.add('hidden');
  content.classList.remove('hidden');
  foldBtn.classList.remove('hidden');
  setText('foldAllBtn', polls.some((p) => !folded.has(p.id)) ? 'Collapse all' : 'Expand all');

  const live = new Set(polls.map((p) => p.id));
  for (const [pollId, c] of cards) {
    if (live.has(pollId)) continue;
    c.el.remove();
    cards.delete(pollId);
    folded.delete(pollId);
  }
  polls.forEach((p, i) => {
    const open = !folded.has(p.id);
    const sig = pollSig(p, open, i);
    let c = cards.get(p.id);
    if (!c) {
      c = { el: document.createElement('div'), sig: null };
      c.el.className = 'card';
      c.el.id = 'card-' + p.id;
      cards.set(p.id, c);
    }
    if (c.sig !== sig) { c.el.innerHTML = cardHtml(p, i, open); c.sig = sig; }
    // Moving a question reorders the elements; it does not rebuild them.
    if (content.children[i] !== c.el) content.insertBefore(c.el, content.children[i] || null);
  });
}

function cardHtml(poll, i, open) {
  // Legacy rows still say 'draft' or 'active' and the server treats both as open,
  // so 'closed' is the only state left that means anything.
  const closed = poll.state === 'closed';
  const canSynth = poll.type === 'open_text' || poll.type === 'word_cloud';
  const isWs = poll.type === 'worksheet';
  const head =
    '<div class="row" style="align-items:center;margin-bottom:10px">' +
    '<button class="btn ghost sm" title="' + (open ? 'Collapse' : 'Expand') +
    '" onclick="toggleFold(\'' + poll.id + '\')">' + (open ? '▾' : '▸') + '</button>' +
    '<span class="type-chip">' + (i + 1) + ' · ' + TYPE_LABEL[poll.type] + '</span>' +
    (closed ? '<span class="type-chip">Closed</span>' : '') +
    // Worksheets, not people: ~80 sheets can arrive from ~15 phones.
    '<span class="pill right">' + poll.totalVotes + ' ' + countNoun(poll, poll.totalVotes) + '</span>' +
    (canSynth ? '<button class="btn ghost sm" onclick="aiSynth(\'' + poll.id + '\')">AI: Synthesize</button>' : '') +
    (isWs ? '<button class="btn ghost sm" onclick="aiWorksheet(\'' + poll.id + '\')">AI: Analyse worksheet</button>' +
      '<button class="btn ghost sm" onclick="viewWorksheets(\'' + poll.id + '\')">View submissions</button>' : '') +
    '<button class="btn ghost sm" onclick="resetPoll(\'' + poll.id + '\')">Reset</button>' +
    (closed
      ? '<button class="btn sm" onclick="api(\'/poll/' + poll.id + '/activate\')">Reopen</button>'
      : '<button class="btn danger sm" onclick="api(\'/poll/' + poll.id + '/close\')">Close</button>') +
    '</div>' +
    // Down from the hero size the one-question stage used: these are stacked now.
    '<div class="big-q" style="font-size:24px;margin:0 0 ' + (open ? '20px' : '0') + '">' + esc(poll.question) + '</div>';
  if (!open) return head;

  let body = '';
  if (poll.type === 'multiple_choice') body = renderBars(poll);
  else if (poll.type === 'rating') body = renderRating(poll);
  else if (poll.type === 'word_cloud') body = renderCloud(poll);
  else if (poll.type === 'open_text') body = renderResponses(poll);
  else if (poll.type === 'worksheet') body = renderWorksheetLive(poll);
  return head + body;
}

function toggleFold(pollId) {
  if (folded.has(pollId)) folded.delete(pollId); else folded.add(pollId);
  renderStage();
}
function toggleAll() {
  if (!state) return;
  const anyOpen = state.polls.some((p) => !folded.has(p.id));
  folded.clear();
  if (anyOpen) state.polls.forEach((p) => folded.add(p.id));
  renderStage();
}
// Jumped to from the progress panel and the rail alike, so it unfolds first —
// scrolling to a card collapsed down to its heading answers nothing.
function jumpTo(pollId) {
  folded.delete(pollId);
  renderStage();
  const el = document.getElementById('card-' + pollId);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Multiple choice: monochrome bars; the single leading bar carries the gradient.
function renderBars(poll) {
  const total = Object.values(poll.votes).reduce((a, b) => a + b, 0);
  const max = Math.max(0, ...Object.values(poll.votes));
  let leadMarked = false;
  const rows = poll.options
    .map((o) => {
      const v = poll.votes[o.id] || 0;
      const pct = total ? Math.round((v / total) * 100) : 0;
      const lead = !leadMarked && v > 0 && v === max;
      if (lead) leadMarked = true;
      return (
        '<div class="bar-row"><div class="bar-top"><span class="bar-label">' + esc(o.text) +
        '</span><span class="bar-val">' + pct + '% · ' + v + '</span></div>' +
        '<div class="bar-track"><div class="bar-fill ' + (lead ? 'lead' : '') + '" style="width:' +
        Math.max(pct, v ? 3 : 0) + '%"></div></div></div>'
      );
    })
    .join('');
  return '<div class="bars">' + rows + '</div>';
}

// Rating: monochrome distribution; the gradient moment is the monumental average numeral.
function renderRating(poll) {
  const n = poll.ratings.length;
  const avg = n ? poll.ratings.reduce((a, b) => a + b, 0) / n : 0;
  const counts = new Array(poll.scaleMax + 1).fill(0);
  poll.ratings.forEach((r) => counts[r]++);
  let rows = '';
  for (let v = poll.scaleMax; v >= 1; v--) {
    const c = counts[v];
    const pct = n ? Math.round((c / n) * 100) : 0;
    rows += '<div class="bar-row"><div class="bar-top"><span class="bar-label">' + v +
      '</span><span class="bar-val">' + c + '</span></div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(pct, c ? 3 : 0) + '%"></div></div></div>';
  }
  return (
    '<div class="row" style="align-items:baseline;gap:18px;margin-bottom:12px">' +
    '<div class="stat-big stat-grad">' + avg.toFixed(2) + '</div>' +
    '<div class="muted">average of ' + n + ' rating' + (n === 1 ? '' : 's') + '</div></div>' +
    '<div class="row small muted" style="justify-content:space-between"><span>' + esc(poll.scaleLabelLow) +
    '</span><span>' + esc(poll.scaleLabelHigh) + '</span></div>' +
    '<div class="bars">' + rows + '</div>'
  );
}

// Word cloud: monochrome, sized by frequency; the single most frequent word is the gradient moment.
function renderCloud(poll) {
  // Null prototype: the keys are whatever the room typed, and on a plain {} the
  // word "constructor" reads back a function — every font-size then computes NaN.
  const freq = Object.create(null);
  poll.words.forEach((w) => { const k = w.toLowerCase(); freq[k] = (freq[k] || 0) + 1; });
  const entries = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 60);
  if (!entries.length) return '<div class="empty">Waiting for the first words…</div>';
  const max = entries[0][1];
  const spans = entries
    .map(([w, c], i) => {
      const size = 20 + (c / max) * 70;
      return '<span class="' + (i === 0 ? 'top' : '') + '" style="font-size:' + size.toFixed(0) + 'px" title="' + c + '">' + esc(w) + '</span>';
    })
    .join('');
  return '<div class="cloud">' + spans + '</div>';
}

function renderResponses(poll) {
  if (!poll.responses.length) return '<div class="empty">Waiting for responses…</div>';
  const cards = poll.responses.slice().reverse().map((r) => '<div class="response">' + esc(r.text) +
    (r.author ? '<div class="small muted" style="margin-top:6px">— ' + esc(r.author) + '</div>' : '') + '</div>').join('');
  return '<div class="responses">' + cards + '</div>';
}

// A label is whatever the person submitting typed — most usefully a table number.
// The unlabelled bucket rides the tally as '' and is rendered, and sorted, last.
const labelText = (v) => (v == null ? '' : String(v).trim());
function labelOrder(a, b) {
  if (!a.label !== !b.label) return a.label ? -1 : 1;
  return a.label.localeCompare(b.label, undefined, { numeric: true });   // Table 10 after Table 2
}

// Grid bodies never ride a broadcast frame (publicRoom drops them), so the stage
// breakdown has to be built from the counts that do: a {label: count} map, one
// label per submitted grid, or grid stubs carrying a label. Nothing to show is a
// silent breakdown, not a broken one.
function wsLabelTally(poll) {
  const src = poll.labelCounts || poll.gridLabels || ((poll.grids || []).length ? poll.grids : null);
  if (!src) return [];
  // Null prototype: labels are typed by the room, and on a plain {} the label
  // "constructor" reads back a function rather than a count.
  const counts = Object.create(null);
  const bump = (k, n) => { const t = labelText(k); counts[t] = (counts[t] || 0) + n; };
  if (Array.isArray(src)) {
    // An entry with no count of its own is one grid: that shape is the labels themselves.
    src.forEach((x) => (x && typeof x === 'object' ? bump(x.label, x.count == null ? 1 : Number(x.count) || 0) : bump(x, 1)));
  } else {
    Object.keys(src).forEach((k) => bump(k, Number(src[k]) || 0));
  }
  return Object.keys(counts).filter((k) => counts[k] > 0)
    .map((k) => ({ label: k, count: counts[k] })).sort(labelOrder);
}

const MAX_LABEL_CHIPS = 14;   // a stage row, not a report: 15 tables fit, free text need not

// "6 from Table 7, 4 from Table 3, 2 unlabelled" is the mid-session question once
// sheets are being handed in a table at a time. Sorted by label and not by count:
// these sit on a live screen, and a row that reshuffles itself every time a photo
// lands cannot be read. Silent when nobody labels — the one-person-one-phone path.
function wsLabelChips(poll) {
  const tally = wsLabelTally(poll);
  const named = tally.filter((t) => t.label);
  if (!named.length) return '';
  const chip = (text, n) => '<span class="pill">' + esc(text) + ' · ' + n + '</span>';
  const spill = named.slice(MAX_LABEL_CHIPS);
  const blank = tally.find((t) => !t.label);
  return '<div class="row tight" style="align-items:center;margin:0 0 16px">' +
    '<span class="type-chip">By label</span>' +
    named.slice(0, MAX_LABEL_CHIPS).map((t) => chip(t.label, t.count)).join('') +
    (spill.length ? chip(spill.length + ' more labels', spill.reduce((a, t) => a + t.count, 0)) : '') +
    (blank ? chip('Unlabelled', blank.count) : '') + '</div>';
}

// Worksheet: the gradient moment is how many worksheets landed; the matrix is the
// live signal. A box the room leaves blank is the one worth talking about, so the
// thinnest cell is called out by name — the bodies themselves stay behind a fetch.
function renderWorksheetLive(poll) {
  const n = poll.gridCount || 0;
  const rows = poll.rows || [];
  const cols = poll.columns || [];
  const head =
    '<div class="row" style="align-items:baseline;gap:18px;margin-bottom:12px">' +
    '<div class="stat-big stat-grad">' + n + '</div>' +
    // Sheets, never people: one phone can hand in a whole table's worth.
    '<div class="muted">worksheet' + (n === 1 ? '' : 's') + ' submitted' +
    '<span class="small" style="display:block">one grid per person — several can arrive from one phone</span></div></div>' +
    wsLabelChips(poll) +
    (poll.instructions ? '<p class="small muted" style="margin:0 0 16px;max-width:76ch;white-space:pre-wrap">' + esc(poll.instructions) + '</p>' : '');
  if (!rows.length || !cols.length) return head + '<div class="empty">This worksheet has no grid.</div>';
  if (!n) return head + '<div class="empty">Waiting for the first worksheet…</div>';

  const fill = poll.cellFill || {};
  const at = (r, c) => fill[r.id + c.id] || 0;
  let low = null;
  rows.forEach((r) => cols.forEach((c) => { if (!low || at(r, c) < low.v) low = { v: at(r, c), r, c }; }));

  const cell = (r, c) => {
    const v = at(r, c);
    const pct = Math.round((v / n) * 100);
    const gap = v === low.v && v < n;
    return '<td style="padding:10px;vertical-align:top;border-top:1px solid var(--line);' +
      (gap ? 'background:var(--surface-2)' : '') + '">' +
      '<div class="row" style="gap:8px;align-items:baseline;justify-content:space-between;margin-bottom:6px">' +
      '<b style="font-family:var(--font-serif);font-weight:500;font-size:22px">' + v + '</b>' +
      '<span class="small muted">' + pct + '%</span></div>' +
      '<div class="bar-track" style="height:6px"><div class="bar-fill' + (v === n ? ' lead' : '') +
      '" style="width:' + Math.max(pct, v ? 4 : 0) + '%"></div></div></td>';
  };
  const thead = '<tr><th style="text-align:left;vertical-align:bottom;padding:0 10px 10px 0;width:24%">' +
    '<span class="type-chip">' + esc(poll.rowHeader || 'Rows') + '</span></th>' +
    cols.map((c) => '<th style="text-align:left;vertical-align:bottom;padding:0 10px 10px;font-family:var(--font-display);' +
      'font-weight:700;font-size:13px;line-height:1.25">' + esc(c.text) + '</th>').join('') + '</tr>';
  const tbody = rows.map((r) =>
    '<tr><th style="text-align:left;vertical-align:top;padding:10px 10px 10px 0;border-top:1px solid var(--line);' +
    'font-family:var(--font-display);font-weight:700;font-size:15px;line-height:1.2">' + esc(r.text) + '</th>' +
    cols.map((c) => cell(r, c)).join('') + '</tr>').join('');
  const note = low.v < n
    ? '<p class="small muted" style="margin:16px 0 0">Thinnest box: <b>' + esc(low.r.text) + '</b> × <b>' +
      esc(low.c.text) + '</b> — filled in on only ' + low.v + ' of ' + n + ' worksheets.</p>'
    : '<p class="small muted" style="margin:16px 0 0">Every box filled in on ' +
      (n === 1 ? 'the single worksheet' : 'all ' + n + ' worksheets') + '.</p>';
  return head + '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;min-width:520px">' +
    '<thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>' + note;
}

// ---- photo queue ----------------------------------------------------------
// The OCR lane is process-wide and, until this line, invisible from the console:
// the only way to see it was /healthz?stats=1 in another browser tab. Standing
// in front of a room, the facilitator has to be able to tell "nobody has
// submitted yet" from "twelve photos are still being read". It lives in the
// progress card, which is painted from a fingerprint and never rewrites a line
// it did not put there.
const OCR_POLL_MS = 5000;
let ocrTimer = null;

function ocrWatch(on) {
  if (!on) {
    clearInterval(ocrTimer);
    ocrTimer = null;
    const el = document.getElementById('ocrQueue');
    if (el) el.textContent = '';
    return;
  }
  if (ocrTimer) return;   // already watching — renderStage runs on every tick
  ocrTimer = setInterval(ocrTick, OCR_POLL_MS);
  ocrTick();
}

// Silent on an empty lane: a line reading "0 photos" is a line the facilitator
// learns to stop looking at. A server without the endpoint stops the poll for
// good; a dropped request just waits for the next tick.
async function ocrTick() {
  let d;
  try {
    const r = await fetch('/api/ocr-status');
    if (!r.ok) return ocrWatch(false);
    d = await r.json();
  } catch (e) { return; }
  if (!ocrTimer || !d) return;   // the last worksheet was deleted while this was in flight
  const n = (d.running || 0) + (d.waiting || 0);
  const eta = d.etaSeconds > 0 ? ' · about ' + d.etaSeconds + 's' : '';
  const el = document.getElementById('ocrQueue');   // gone once showEnded() has replaced the page
  if (el) el.textContent = n ? n + (n === 1 ? ' photo' : ' photos') + ' being read' + eta : '';
}

// The bodies ride no broadcast frame — 100 grids of 9 cells would be ~135 KB per
// tick — so the panel pulls them the moment the presenter asks to read them.
async function viewWorksheets(pollId) {
  const title = 'Worksheet submissions';
  aiShow(title, '<p class="empty">Loading…</p>');
  let d = null;
  try {
    const res = await fetch('/api/room/' + CODE + '/poll/' + pollId + '/worksheet');
    if (res.ok) d = await res.json().catch(() => null);
  } catch { /* handled below */ }
  if (!d) { aiShow(title, '<p class="empty">Could not load submissions — try again.</p>'); return; }
  const rows = d.rows || [];
  const cols = d.columns || [];
  const grids = d.grids || [];
  if (!grids.length) { aiShow(title, '<p class="empty">No worksheets submitted yet.</p>'); return; }
  const boxes = rows.length * cols.length;
  const card = (g, heading, sub) => {
    const cells = g.cells || {};
    const filled = Object.keys(cells).length;
    const body = rows.map((r) => {
      const answers = cols
        .filter((c) => cells[r.id + c.id])
        .map((c) => '<div class="response" style="white-space:pre-wrap"><div class="small muted" style="margin-bottom:6px">' +
          esc(c.text) + '</div>' + esc(cells[r.id + c.id]) + '</div>')
        .join('');
      if (!answers) return '';
      return '<p class="eyebrow" style="margin:14px 0 0">' + esc(r.text) + '</p><div class="responses">' + answers + '</div>';
    }).join('');
    return '<div class="card" style="margin-bottom:12px"><div class="row" style="align-items:center">' +
      '<b style="font-family:var(--font-display);font-size:16px">' + esc(heading) + '</b>' +
      (sub ? '<span class="small muted">' + esc(sub) + '</span>' : '') +
      '<span class="pill right">' + filled + ' of ' + boxes + ' boxes</span></div>' +
      (body || '<p class="small muted" style="margin:10px 0 0">Every box left blank.</p>') + '</div>';
  };
  const sheets = (k) => k + ' worksheet' + (k === 1 ? '' : 's');

  let lead, html;
  if (!grids.some((g) => labelText(g.label))) {
    // Nobody labelled — arrival order, newest first, so a sheet that lands while
    // the panel is open sits at the top.
    lead = sheets(grids.length) + ', newest first.';
    html = grids.slice().reverse().map((g) => card(g, g.author || 'Anonymous', '')).join('');
  } else {
    // Grouped so the facilitator can say "table 7 said this". Inside a group the
    // sheets keep the order they were handed in — the order the stack was
    // photographed — which is how a table reads its own answers back.
    const by = Object.create(null);   // labels are typed by the room; on a plain {} "constructor" is not an array
    grids.forEach((g) => { const k = labelText(g.label); (by[k] || (by[k] = [])).push(g); });
    const groups = Object.keys(by).map((k) => ({ label: k, count: by[k].length })).sort(labelOrder);
    const named = groups.filter((t) => t.label).length;
    lead = sheets(grids.length) + ' from ' + named + ' label' + (named === 1 ? '' : 's') + '.';
    html = groups.map((t) =>
      '<div class="row" style="align-items:baseline;margin:22px 0 10px">' +
      '<p class="eyebrow" style="margin:0">' + esc(t.label || 'No label') + '</p>' +
      '<span class="type-chip">' + sheets(t.count) + '</span></div>' +
      by[t.label].map((g, i) => card(g, 'Worksheet ' + (i + 1), g.author || '')).join('')).join('');
  }
  aiShow(title, '<p class="sub">' + lead + '</p>' + html);
}

function renderQA() {
  const qs = state.questions;
  setText('qCount', qs.length + (qs.length === 1 ? ' question' : ' questions'));
  let sig = 5381;
  for (const q of qs) sig = hashAll(sig, q.id, q.text, q.votes, q.author || '');
  paint('qaBoard', sig, () => (qs.length
    ? qs.map((q) => '<div class="qitem"><div class="qvote" style="cursor:default"><span class="arrow">▲</span>' + q.votes +
      '</div><div class="qtext">' + esc(q.text) +
      (q.author ? '<div class="small muted" style="margin-top:3px">— ' + esc(q.author) + '</div>' : '') + '</div>' +
      '<button class="btn ghost sm" onclick="api(\'/question/' + q.id + '/delete\')">Dismiss</button></div>').join('')
    : '<p class="empty">Questions from the audience appear here.</p>'));
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
