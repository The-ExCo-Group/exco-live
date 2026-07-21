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

function connect() {
  const es = new EventSource('/api/stream/' + CODE);
  es.onmessage = (e) => { state = JSON.parse(e.data); render(); };
  es.onerror = () => {/* auto-reconnect */};
}
connect();

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
};

// ---- create poll modal ----------------------------------------------------
function openCreate() {
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('pQuestion').value = '';
  renderTypeFields();
}
function closeCreate() { document.getElementById('modal').classList.add('hidden'); }

function renderTypeFields() {
  const type = document.getElementById('pType').value;
  const el = document.getElementById('typeFields');
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
  } else {
    el.innerHTML = '<p class="small muted">Participants submit free-text responses that stream in live.</p>';
  }
}
function addOpt(val) {
  const box = document.getElementById('opts');
  const div = document.createElement('div');
  div.className = 'option-editor';
  div.innerHTML = '<input type="text" class="opt-input grow" value="' + (val || '').replace(/"/g, '&quot;') +
    '" placeholder="Option text" /><button class="btn ghost sm" onclick="this.parentNode.remove()">✕</button>';
  box.appendChild(div);
}
async function createPoll(present) {
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
  const { id } = await api('/poll', payload);
  closeCreate();
  if (present && id) await api('/poll/' + id + '/activate');
}

// ---- preload / import -----------------------------------------------------
function openImport() { document.getElementById('importModal').classList.remove('hidden'); }
function closeImport() { document.getElementById('importModal').classList.add('hidden'); }

const TYPE_ALIAS = {
  mc: 'multiple_choice', choice: 'multiple_choice', multiple: 'multiple_choice', multiple_choice: 'multiple_choice',
  poll: 'multiple_choice', word: 'word_cloud', wordcloud: 'word_cloud', word_cloud: 'word_cloud', cloud: 'word_cloud',
  rating: 'rating', rate: 'rating', scale: 'rating',
  text: 'open_text', open: 'open_text', open_text: 'open_text', opentext: 'open_text',
};

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
      def.question = question;
      cur = def;
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

// ---- navigation (seamless stepping through the run of show) ---------------
function currentIndex() {
  if (!state) return -1;
  return state.polls.findIndex((p) => p.id === state.activePollId);
}
async function step(dir) {
  if (!state || !state.polls.length) return;
  let idx = currentIndex();
  if (idx === -1) idx = dir > 0 ? 0 : 0;
  else idx = Math.min(Math.max(idx + dir, 0), state.polls.length - 1);
  const target = state.polls[idx];
  if (target && target.id !== state.activePollId) await api('/poll/' + target.id + '/activate');
}
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === 'Escape') { hideJoinScreen(); return; }
  if (document.querySelector('.modal-bg:not(.hidden)')) return;
  if (e.key === 'j' || e.key === 'J') { e.preventDefault(); toggleJoinScreen(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
});

// ---- render ---------------------------------------------------------------
function render() {
  if (!state) return;
  document.getElementById('roomTitle').textContent = state.title || 'Session';
  renderPollList();
  renderStage();
  renderNav();
  renderQA();
}

function renderNav() {
  const idx = currentIndex();
  const total = state.polls.length;
  const pos = document.getElementById('navPos');
  const prev = document.getElementById('prevBtn');
  const next = document.getElementById('nextBtn');
  pos.textContent = total ? (idx === -1 ? '— / ' + total : (idx + 1) + ' / ' + total) : '0 questions';
  prev.disabled = idx <= 0;
  next.disabled = !total || idx >= total - 1;
  next.textContent = idx === -1 && total ? 'Start ▶' : 'Next ▶';
}

function renderPollList() {
  const box = document.getElementById('pollList');
  if (!state.polls.length) { box.innerHTML = '<p class="small muted center">No questions preloaded yet.</p>'; return; }
  box.innerHTML = state.polls
    .map((p, i) => {
      const isActive = p.id === state.activePollId;
      return (
        '<div class="poll-list-item ros ' + (isActive ? 'active' : '') + '">' +
        '<div class="pli-main">' +
        '<span class="idx">' + (i + 1) + '</span>' +
        '<div class="grow"><div class="type-chip">' + TYPE_LABEL[p.type] + '</div>' +
        '<div class="pli-q">' + esc(p.question) + '</div></div>' +
        (isActive ? '<span class="pill live"><span class="ping"></span>Live</span>' : '') +
        '</div>' +
        '<div class="pli-controls">' +
        '<button class="btn ghost sm" title="Move up" onclick="api(\'/poll/' + p.id + '/move\',{dir:\'up\'})"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button class="btn ghost sm" title="Move down" onclick="api(\'/poll/' + p.id + '/move\',{dir:\'down\'})"' + (i === state.polls.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<span class="spacer"></span>' +
        (isActive ? '' : '<button class="btn sm" onclick="api(\'/poll/' + p.id + '/activate\')">Present</button>') +
        '<button class="btn ghost sm" title="Delete" onclick="delPoll(\'' + p.id + '\')">✕</button>' +
        '</div></div>'
      );
    })
    .join('');
}
async function delPoll(id) { await api('/poll/' + id + '/delete'); }

function renderStage() {
  const empty = document.getElementById('stageEmpty');
  const content = document.getElementById('stageContent');
  const poll = state.polls.find((p) => p.id === state.activePollId);
  if (!poll) { empty.classList.remove('hidden'); content.classList.add('hidden'); return; }
  empty.classList.add('hidden');
  content.classList.remove('hidden');

  const head =
    '<div class="row" style="align-items:center;margin-bottom:8px">' +
    '<span class="type-chip">' + TYPE_LABEL[poll.type] + '</span>' +
    '<span class="pill right">' + poll.totalVotes + ' responses</span>' +
    '<button class="btn ghost sm" onclick="api(\'/poll/' + poll.id + '/reset\')">Reset</button>' +
    '<button class="btn danger sm" onclick="api(\'/poll/' + poll.id + '/close\')">End</button>' +
    '</div>' +
    '<div class="big-q">' + esc(poll.question) + '</div>';

  let body = '';
  if (poll.type === 'multiple_choice') body = renderBars(poll);
  else if (poll.type === 'rating') body = renderRating(poll);
  else if (poll.type === 'word_cloud') body = renderCloud(poll);
  else if (poll.type === 'open_text') body = renderResponses(poll);
  content.innerHTML = head + body;
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
  const freq = {};
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
  const cards = poll.responses.slice().reverse().map((r) => '<div class="response">' + esc(r.text) + '</div>').join('');
  return '<div class="responses">' + cards + '</div>';
}

function renderQA() {
  const board = document.getElementById('qaBoard');
  document.getElementById('qCount').textContent = state.questions.length + (state.questions.length === 1 ? ' question' : ' questions');
  if (!state.questions.length) { board.innerHTML = '<p class="empty">Questions from the audience appear here.</p>'; return; }
  board.innerHTML = state.questions
    .map((q) => '<div class="qitem"><div class="qvote" style="cursor:default"><span class="arrow">▲</span>' + q.votes +
      '</div><div class="qtext">' + esc(q.text) + '</div>' +
      '<button class="btn ghost sm" onclick="api(\'/question/' + q.id + '/delete\')">Dismiss</button></div>')
    .join('');
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
