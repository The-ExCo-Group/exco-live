'use strict';

const CODE = location.pathname.split('/').filter(Boolean)[1].toUpperCase();
let state = null;

// Stable anonymous id per device (for de-duping votes / upvotes — soft, internal use)
let ME = localStorage.getItem('lp_me');
if (!ME) { ME = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('lp_me', ME); }

// Track what this device has already done, keyed by poll/question id
const done = JSON.parse(localStorage.getItem('lp_done_' + CODE) || '{}');
// The stored value is a marker, not a flag — worksheet records how many boxes
// went in so the confirmation can say so. isDone() only ever reads truthiness.
function markDone(k, v) { done[k] = v || 1; localStorage.setItem('lp_done_' + CODE, JSON.stringify(done)); }
function isDone(k) { return !!done[k]; }

// Participant name — remembered on this device across sessions. Answering
// anonymously is a first-class choice, not a fallback: ANON records that the
// participant chose it, so we stop asking. Without that flag an empty name is
// indistinguishable from "hasn't decided yet" and the modal reopens every load.
let NAME = localStorage.getItem('lp_name') || '';
let ANON = localStorage.getItem('lp_anon') === '1';
function renderNamePill() {
  const p = document.getElementById('namePill');
  if (p) p.textContent = NAME ? '☰ ' + NAME : (ANON ? '☰ Anonymous' : '☰ Set name');
}
function closeNameModal() {
  document.getElementById('nameModal').classList.add('hidden');
  renderNamePill();
}
function saveName() {
  const v = document.getElementById('nameInput').value.trim().slice(0, 40);
  if (v) { NAME = v; ANON = false; localStorage.setItem('lp_name', NAME); localStorage.removeItem('lp_anon'); }
  else { goAnonymous(); return; }   // an empty box means anonymous, not "ask again"
  closeNameModal();
}
// Clear any stored name and remember the choice, so nothing already submitted
// under a name is re-attributed and we never re-prompt.
function goAnonymous() {
  NAME = ''; ANON = true;
  localStorage.removeItem('lp_name');
  localStorage.setItem('lp_anon', '1');
  closeNameModal();
}
function editName() {
  document.getElementById('nameInput').value = NAME;
  document.getElementById('anonBtn').textContent = NAME ? 'Switch to anonymous' : 'Stay anonymous';
  document.getElementById('nameModal').classList.remove('hidden');
  document.getElementById('nameInput').focus();
}
renderNamePill();
if (!NAME && !ANON) {
  document.getElementById('anonBtn').textContent = 'Stay anonymous';
  document.getElementById('nameModal').classList.remove('hidden');
  document.getElementById('nameInput').focus();
}
document.getElementById('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });

function connect() {
  const es = new EventSource('/api/stream/' + CODE);
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.ended) { showEnded(); es.close(); return; }
    state = d;
    render();
  };
}
connect();

function showEnded() {
  document.getElementById('panelVote').innerHTML =
    '<div class="card center"><p class="eyebrow">Session ended</p>' +
    '<h2 style="border:0">Thanks for taking part.</h2>' +
    '<p class="muted">This session has been closed by the host.</p></div>';
  document.getElementById('panelQa').classList.add('hidden');
  document.getElementById('panelVote').classList.remove('hidden');
  const tb = document.querySelector('.tabbar');
  if (tb) tb.classList.add('hidden');
}

// Submission id: device + time + randomness, so two people (or two taps) never collide.
function newSid() {
  return ME + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function api(pathSuffix, body) {
  // The sid is minted once, outside the retry loop: every retry of this one submission must carry
  // the SAME sid so the server's de-dupe counts it once. Minting it per attempt would double-count.
  const payload = JSON.stringify(Object.assign({}, body || {}, { sid: newSid() }));
  const url = '/api/room/' + CODE + pathSuffix;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      // 4xx is the server's real verdict — resending won't change it. Only 5xx is worth another go.
      if (res.status < 500) return res;
    } catch (e) {
      // Network dropped (flaky conference wifi) — fall through and try again.
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1) + Math.random() * 200));
  }
  return { ok: false, status: 0 }; // shaped like a failed Response; callers only read .ok
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1600);
}

function showTab(which) {
  document.getElementById('panelVote').classList.toggle('hidden', which !== 'vote');
  document.getElementById('panelQa').classList.toggle('hidden', which !== 'qa');
  document.getElementById('tabVote').classList.toggle('active', which === 'vote');
  document.getElementById('tabQa').classList.toggle('active', which === 'qa');
}

// ---- render ---------------------------------------------------------------
function render() {
  if (!state) return;
  const nt = document.getElementById('nameModalTitle');
  if (nt) nt.textContent = state.title && state.title !== 'Untitled session' ? state.title : "You're joining";
  renderVote();
  renderQA();
}

let lastPollId = null;
function renderVote() {
  const empty = document.getElementById('voteEmpty');
  const content = document.getElementById('voteContent');
  const poll = state.polls.find((p) => p.id === state.activePollId);

  if (!poll) {
    const t = document.getElementById('joinTitle');
    if (t) t.textContent = state.title && state.title !== 'Untitled session' ? state.title : 'Waiting for the host…';
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    lastPollId = null;
    return;
  }
  empty.classList.add('hidden');
  content.classList.remove('hidden');

  // Only rebuild the input UI when the poll changes, so typing isn't interrupted.
  if (poll.id !== lastPollId) {
    lastPollId = poll.id;
    content.innerHTML = buildInput(poll);
    // The grid's counter and draft wiring can only be attached once the markup
    // exists, and must survive every later tick without being re-attached.
    if (poll.type === 'worksheet') mountWorksheet(poll);
  }
  // Always refresh the "already answered" confirmation state.
  refreshVoteState(poll);
}

function buildInput(poll) {
  const q = '<div class="big-q">' + esc(poll.question) + '</div>';
  if (poll.type === 'multiple_choice') {
    const opts = poll.options
      .map(
        (o) =>
          '<button class="answer-btn" onclick="vote(\'' + poll.id + '\',\'' + o.id + '\',this)">' +
          esc(o.text) + '</button>'
      )
      .join('');
    return q + '<div id="voteState"></div>' + '<div id="voteInputs">' + opts + '</div>';
  }
  if (poll.type === 'rating') {
    let btns = '';
    for (let v = 1; v <= poll.scaleMax; v++) {
      btns += '<button class="scale-btn" onclick="rate(\'' + poll.id + '\',' + v + ',this)">' + v + '</button>';
    }
    return q +
      '<div class="row small muted" style="justify-content:space-between;margin-bottom:8px"><span>' + esc(poll.scaleLabelLow) +
      '</span><span>' + esc(poll.scaleLabelHigh) + '</span></div>' +
      '<div id="voteState"></div>' +
      '<div id="voteInputs" class="row tight">' + btns + '</div>';
  }
  if (poll.type === 'word_cloud') {
    return q +
      '<div id="voteState"></div>' +
      '<div id="voteInputs"><input id="wordInput" type="text" placeholder="Type a word or short phrase" maxlength="60" />' +
      '<div style="height:10px"></div><button class="btn go full" onclick="submitWord(\'' + poll.id +
      '\')">Send</button><p class="small muted center" style="margin-top:8px">You can submit more than once.</p></div>';
  }
  if (poll.type === 'worksheet') {
    const rows = poll.rows || [];
    const cols = poll.columns || [];
    if (!rows.length || !cols.length) return q + '<div id="voteState"></div><div id="voteInputs"></div>';
    // Restored INLINE, not after mount: a phone that reloads mid-worksheet must
    // never flash nine empty boxes before the draft lands.
    const draft = wsDraft(poll.id);
    let filled = 0;
    let groups = '';
    for (const r of rows) {
      let fields = '';
      for (const c of cols) {
        const key = r.id + c.id;
        const val = String(draft[key] || '');
        if (val.trim()) filled++;
        fields +=
          '<div class="ws-field"><label for="ws_' + key + '">' + esc(c.text) + '</label>' +
          '<textarea id="ws_' + key + '" data-cell="' + key + '" maxlength="400" placeholder="Type here…">' +
          esc(val) + '</textarea></div>';
      }
      // A row is a nested .card.tint so the card token inversion applies locally.
      groups += '<div class="card tint ws-row"><h3 class="ws-row-name">' + esc(r.text) + '</h3>' +
        '<div class="ws-fields" data-cols="' + cols.length + '">' + fields + '</div></div>';
    }
    return q +
      (poll.instructions ? '<p class="ws-intro">' + esc(poll.instructions) + '</p>' : '') +
      '<div id="voteState"></div>' +
      '<div id="voteInputs">' +
      (poll.rowHeader ? '<p class="eyebrow ws-head">' + esc(poll.rowHeader) + '</p>' : '') +
      '<div id="wsGrid" data-poll="' + poll.id + '">' + groups + '</div>' +
      (poll.footnote ? '<p class="ws-foot">' + esc(poll.footnote) + '</p>' : '') +
      '<div class="ws-bar"><span class="ws-count" id="wsCount">' + wsCountText(filled, rows.length * cols.length) +
      '</span><button class="btn go" id="wsSend" onclick="submitWorksheet(\'' + poll.id + '\')">Send</button></div>' +
      '</div>';
  }
  // open_text
  return q +
    '<div id="voteState"></div>' +
    '<div id="voteInputs"><textarea id="textInput" placeholder="Type your response…" maxlength="280"></textarea>' +
    '<div style="height:10px"></div><button class="btn go full" onclick="submitText(\'' + poll.id +
    '\')">Send</button></div>';
}

function refreshVoteState(poll) {
  const stateEl = document.getElementById('voteState');
  const inputs = document.getElementById('voteInputs');
  if (!stateEl) return;
  // Multiple choice, rating and worksheet are single-submit per device.
  const singleSubmit = poll.type === 'multiple_choice' || poll.type === 'rating' || poll.type === 'worksheet';
  if (singleSubmit && isDone('poll_' + poll.id)) {
    if (inputs) inputs.classList.add('hidden');
    const ws = poll.type === 'worksheet';
    const n = done['poll_' + poll.id];
    stateEl.innerHTML =
      '<div class="card tint center"><p class="eyebrow" style="margin:0 0 6px">' +
      (ws ? 'Worksheet received' : 'Answer received') + '</p><p class="muted" style="margin:0">' +
      (ws && n > 1 ? n + ' boxes went to the host. Watch the big screen.' : 'Watch the big screen for live results.') +
      '</p></div>';
  } else {
    if (inputs) inputs.classList.remove('hidden');
    stateEl.innerHTML = '';
  }
}

// ---- actions --------------------------------------------------------------
// isDone is only set once the POST lands, and a retry can keep that quiet for
// over a second — long enough for an impatient second tap, which mints a second
// sid the server counts as a second person. One submission in flight per poll.
const inFlight = {};
async function vote(pollId, optionId, el) {
  if (isDone('poll_' + pollId) || inFlight[pollId]) return;
  inFlight[pollId] = 1;
  if (el) el.classList.add('chosen');
  try {
    const r = await api('/poll/' + pollId + '/vote', { optionId });
    if (r.ok) { markDone('poll_' + pollId); refreshVoteState(currentPoll()); toast('Vote counted'); }
  } finally { delete inFlight[pollId]; }
}
async function rate(pollId, value, el) {
  if (isDone('poll_' + pollId) || inFlight[pollId]) return;
  inFlight[pollId] = 1;
  if (el) el.classList.add('chosen');
  try {
    const r = await api('/poll/' + pollId + '/rate', { value });
    if (r.ok) { markDone('poll_' + pollId); refreshVoteState(currentPoll()); toast('Rating sent'); }
  } finally { delete inFlight[pollId]; }
}
async function submitWord(pollId) {
  const el = document.getElementById('wordInput');
  const text = el.value.trim();
  if (!text) return;
  const r = await api('/poll/' + pollId + '/word', { text });
  if (r.ok) { el.value = ''; toast('Added'); }
}
async function submitText(pollId) {
  const el = document.getElementById('textInput');
  const text = el.value.trim();
  if (!text) return;
  const r = await api('/poll/' + pollId + '/text', { text, author: NAME });
  if (r.ok) { el.value = ''; markDone('poll_' + pollId); toast('Response sent'); }
}
async function askQuestion() {
  const el = document.getElementById('qInput');
  const text = el.value.trim();
  if (!text) return;
  const r = await api('/question', { text, author: NAME });
  if (r.ok) { el.value = ''; toast('Question submitted'); showTab('qa'); }
}
async function upvote(qid) {
  if (isDone('q_' + qid)) return;
  markDone('q_' + qid);
  await api('/question/' + qid + '/upvote', { voter: ME });
  renderQA();
}

function currentPoll() {
  return state.polls.find((p) => p.id === state.activePollId);
}

// ---- worksheet ------------------------------------------------------------
// Nine boxes is ten minutes of typing. Everything below exists so that time
// survives a reload, a phone call, or the host swapping the poll underneath.
function wsKey(pollId) { return 'lp_ws_' + CODE + '_' + pollId; }

function wsDraft(pollId) {
  try { return JSON.parse(localStorage.getItem(wsKey(pollId)) || '{}') || {}; }
  catch (e) { return {}; }   // private-mode / corrupt draft — start clean rather than blow up render
}

function wsCells() {
  return Array.prototype.slice.call(document.querySelectorAll('#wsGrid textarea[data-cell]'));
}
function wsCountText(n, total) { return n + ' of ' + total + ' boxes filled — partial is fine'; }

function mountWorksheet(poll) {
  const grid = document.getElementById('wsGrid');
  if (!grid) return;
  const total = (poll.rows || []).length * (poll.columns || []).length;
  // ONE delegated listener on the container. Nine inline handlers would mean nine
  // closures rebuilt on every poll swap, and no place to hang the debounce.
  grid.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.cell) return;
    const c = document.getElementById('wsCount');
    if (c) c.textContent = wsCountText(wsCells().filter((x) => x.value.trim()).length, total);
    wsQueueDraft(poll.id);
  });
}

let wsTimer = null;
let wsPending = null;   // { key, data } — snapshotted at keystroke, written on the timer

// The snapshot is taken NOW and the write deferred, not the other way round: the
// host can swap the active poll inside the debounce window, and a flush that read
// the DOM at fire time would save the new poll's boxes under the old poll's key.
function wsQueueDraft(pollId) {
  const out = {};
  for (const t of wsCells()) if (t.value.trim()) out[t.dataset.cell] = t.value;
  wsPending = { key: wsKey(pollId), data: JSON.stringify(out) };
  clearTimeout(wsTimer);
  wsTimer = setTimeout(wsFlushDraft, 400);   // per-keystroke writes would thrash localStorage on a phone
}

function wsFlushDraft() {
  clearTimeout(wsTimer);
  wsTimer = null;
  if (!wsPending) return;
  try { localStorage.setItem(wsPending.key, wsPending.data); } catch (e) {}
  wsPending = null;
}

function wsClearDraft(pollId) {
  const k = wsKey(pollId);
  // Drop a queued write for this poll too, or it would resurrect the draft we
  // just cleared 400ms after a successful submit.
  if (wsPending && wsPending.key === k) { clearTimeout(wsTimer); wsTimer = null; wsPending = null; }
  try { localStorage.removeItem(k); } catch (e) {}
}

// iOS can freeze or discard a backgrounded tab before the debounce fires — and
// that is exactly the participant who has typed the most.
document.addEventListener('visibilitychange', () => { if (document.hidden) wsFlushDraft(); });
window.addEventListener('pagehide', wsFlushDraft);

async function submitWorksheet(pollId) {
  if (isDone('poll_' + pollId) || inFlight[pollId]) return;
  const cells = {};
  let filled = 0;
  for (const t of wsCells()) {
    const v = t.value.trim();
    if (v) { cells[t.dataset.cell] = v; filled++; }
  }
  if (!filled) { toast('Fill at least one box'); return; }
  inFlight[pollId] = 1;
  const btn = document.getElementById('wsSend');
  if (btn) btn.disabled = true;
  // The cells were snapshotted above but api() can retry for over a second. Left
  // editable, anything typed in that window is neither sent nor kept: success
  // clears the draft and hides the grid, so the sentence just disappears.
  for (const t of wsCells()) t.readOnly = true;
  try {
    const r = await api('/poll/' + pollId + '/worksheet', { cells, author: NAME, source: 'typed' });
    if (r.ok) {
      wsClearDraft(pollId);
      markDone('poll_' + pollId, filled);
      refreshVoteState(currentPoll());
      toast('Worksheet sent');
    } else {
      // The draft stays put — they can fix the wifi and hit Send again.
      if (btn) btn.disabled = false;
      for (const t of wsCells()) t.readOnly = false;
      toast('Could not send — try again');
    }
  } finally { delete inFlight[pollId]; }
}

// ---- QA -------------------------------------------------------------------
function renderQA() {
  const list = document.getElementById('qaList');
  document.getElementById('qCountP').textContent = state.questions.length;
  if (!state.questions.length) {
    list.innerHTML = '<p class="empty">Be the first to ask.</p>';
    return;
  }
  list.innerHTML = state.questions
    .map((q) => {
      const voted = isDone('q_' + q.id);
      const by = q.author ? '<div class="small muted" style="margin-top:3px">— ' + esc(q.author) + '</div>' : '';
      return (
        '<div class="qitem"><div class="qvote ' + (voted ? 'voted' : '') + '" onclick="upvote(\'' + q.id +
        '\')"><span class="arrow">▲</span>' + q.votes + '</div>' +
        '<div class="qtext">' + esc(q.text) + by + '</div></div>'
      );
    })
    .join('');
}

// ---- utils ----------------------------------------------------------------
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
