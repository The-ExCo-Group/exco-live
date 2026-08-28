'use strict';

const CODE = location.pathname.split('/').filter(Boolean)[1].toUpperCase();
let state = null;

// Stable anonymous id per device (for de-duping votes / upvotes — soft, internal use)
let ME = localStorage.getItem('lp_me');
if (!ME) { ME = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('lp_me', ME); }

// Track what this device has already done, keyed by poll/question id. Only the
// single-submit types are here: one device can send many worksheets, so that
// type keeps its own record of every sheet instead (wsSentList).
const done = JSON.parse(localStorage.getItem('lp_done_' + CODE) || '{}');
function markDone(k) { done[k] = 1; localStorage.setItem('lp_done_' + CODE, JSON.stringify(done)); }
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
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      // 4xx is the server's real verdict — resending won't change it. Only 5xx is worth another go.
      if (res.status < 500) return res;
      // Kept unread: a 503 that survives all three attempts is still the server
      // telling us it is shedding load, and throwing it away here is what turned
      // "we're catching up, try in 20s" into the generic "could not send".
      last = res;
    } catch (e) {
      // Network dropped (flaky conference wifi) — fall through and try again.
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1) + Math.random() * 200));
  }
  return last || { ok: false, status: 0 }; // status 0 = never got a reply; callers read .ok and .status
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1600);
}

// ---- failed submissions ---------------------------------------------------
// A card above the question, not a toast. By the time a submission fails the
// host has often already swapped the question out — the input the participant
// was looking at is gone, and 1.6 seconds at the bottom of the screen is not
// where you tell someone their ten minutes of typing did not send. Built here
// rather than in join.html so render() never has to know about it: it lives
// outside #voteContent, which renderVote rewrites wholesale on every poll swap.
function noticeBox() {
  let box = document.getElementById('joinNotice');
  if (!box) {
    box = document.createElement('div');
    box.id = 'joinNotice';
    const panel = document.getElementById('panelVote');
    panel.insertBefore(box, panel.firstChild);
  }
  return box;
}
function notice(label, text, extraHtml) {
  noticeBox().innerHTML =
    '<div class="card tint"><p class="eyebrow" style="margin:0 0 6px">' + esc(label) + '</p>' +
    '<p class="muted" style="margin:0">' + esc(text) + '</p>' +
    (extraHtml || '') +
    '<div style="height:12px"></div><button class="btn ghost sm" onclick="noticeClear()">Got it</button></div>';
}

// A closed poll hides the grid, so "nothing you typed has been lost" lands on an
// empty screen and reads as false. Show the answers back instead — seeing the
// words is the only thing that actually settles it. Read straight off the DOM:
// by the time a 409 arrives the host has advanced and currentPoll() is null, so
// the poll object is not there to ask.
function wsTypedRecap() {
  let html = '';
  document.querySelectorAll('.ws-row').forEach((row) => {
    const rowName = (row.querySelector('.ws-row-name') || {}).textContent || '';
    row.querySelectorAll('.ws-field').forEach((field) => {
      const ta = field.querySelector('textarea');
      const v = ta && ta.value.trim();
      if (!v) return;
      const col = (field.querySelector('label') || {}).textContent || '';
      html += '<p class="small" style="margin:10px 0 0"><b>' + esc(rowName) + '</b> · ' + esc(col) + '</p>' +
        '<p class="small muted" style="margin:2px 0 0;white-space:pre-wrap">' + esc(v) + '</p>';
    });
  });
  return html ? '<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:4px">' +
    '<p class="eyebrow" style="margin:8px 0 0">What was in the boxes</p>' + html + '</div>' : '';
}
function noticeClear() {
  const box = document.getElementById('joinNotice');
  if (box) box.innerHTML = '';
}

// The one exit for every failed submission. `what` names what did not go ("your
// vote", "your worksheet"); `kept` says whether the text is still on this
// device, which is the only sentence worth reading when a full grid bounces.
async function sendFailed(res, what, kept, extraHtml) {
  const status = res.status || 0;
  // status 0 is api()'s own "three attempts, no reply" — there is no body to read.
  const d = status ? await res.json().catch(() => ({})) : {};
  // The host advancing closes the poll and the server answers 409; a deleted
  // poll answers 404. Both are final: api() retries 5xx only, so "try again"
  // here would be an instruction the participant could follow forever without
  // it ever working. Say what happened and offer no retry.
  if (status === 409 || status === 404 || d.error === 'poll_not_active') {
    return notice('Question closed',
      'The host has moved on from this question, so ' + what + ' could not be sent.' +
      (kept ? ' Nothing you typed has been lost — it is still saved on this device, and it comes back if the host reopens the question.' : ''),
      extraHtml);
  }
  if (status === 503) {
    const s = d.retryAfterSeconds || Number(res.headers.get('Retry-After')) || 0;
    return notice('Everyone answered at once',
      'The server is catching up and did not take ' + what + '. Press Send again in ' +
      (s > 0 ? 'about ' + s + 's' : 'a moment') + '.');
  }
  if (!status) {
    return notice('No connection',
      'We could not reach the server, so ' + what + ' has not been sent. Check your signal, then send again.');
  }
  return notice('Not sent', 'Something went wrong sending ' + what + '. Try again.');
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
    // Restored INLINE for the same reason the worksheet is: a reload, or a host
    // who reopens this question, must not blank what they had typed.
    return q +
      '<div id="voteState"></div>' +
      '<div id="voteInputs"><input id="wordInput" type="text" placeholder="Type a word or short phrase" maxlength="60"' +
      ' oninput="boxKeep(\'' + poll.id + '\',this)" value="' + esc(boxDraft(poll.id)) + '" />' +
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
      // Offered ABOVE the grid: after nine boxes of typing the photo is worthless.
      // #wsPhotoMsg is the only node the photo flow ever rewrites as a string.
      '<div class="ws-photo" id="wsPhotoIntro">' +
      '<input type="file" id="wsPhotoFile" class="hidden" accept="image/*" capture="environment" onchange="wsPhotoPicked(this)" />' +
      '<button class="btn ghost sm" id="wsPhotoBtn" onclick="wsPhotoPick()">Use a photo instead</button>' +
      '<span class="small muted ws-photo-hint">Sheet filled in on paper? Photograph it and we\'ll type it up for you to check.</span>' +
      '</div><div id="wsPhotoMsg"></div>' +
      // Optional, and pointedly not a name: anyone holding the room code can open
      // this page, and a sheet photographed for someone else is not the
      // photographer's to attribute. A table number says enough for the analysis.
      '<div class="ws-label"><label for="wsLabel">Label this sheet (optional)</label>' +
      '<input id="wsLabel" type="text" maxlength="40" placeholder="e.g. Table 7" value="' + esc(wsLabelGet()) +
      '" oninput="wsLabelKeep(this)" />' +
      '<p class="small muted ws-label-hint">A table or group number helps the host sort the sheets. Please don\'t use anyone\'s name — this session has no sign-in.</p></div>' +
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
    '<div id="voteInputs"><textarea id="textInput" placeholder="Type your response…" maxlength="1500"' +
    ' oninput="boxKeep(\'' + poll.id + '\',this)">' + esc(boxDraft(poll.id)) + '</textarea>' +
    '<div style="height:10px"></div><button class="btn go full" onclick="submitText(\'' + poll.id +
    '\')">Send</button></div>';
}

function refreshVoteState(poll) {
  const stateEl = document.getElementById('voteState');
  const inputs = document.getElementById('voteInputs');
  // No poll: the submit's own callers reach here after the host closed the last
  // question, and reading .type off nothing would throw away the confirmation
  // toast for a submission the server had already accepted.
  if (!stateEl || !poll) return;
  // A worksheet is the one type a single device sends several of — one paper
  // sheet per person, all photographed from the same phone — so it never seals
  // itself off after a send and runs its own state below.
  if (poll.type === 'worksheet') return wsRefreshState(poll, stateEl, inputs);
  // Multiple choice and rating are single-submit per device.
  const singleSubmit = poll.type === 'multiple_choice' || poll.type === 'rating';
  if (singleSubmit && isDone('poll_' + poll.id)) {
    if (inputs) inputs.classList.add('hidden');
    stateEl.innerHTML =
      '<div class="card tint center"><p class="eyebrow" style="margin:0 0 6px">Answer received</p>' +
      '<p class="muted" style="margin:0">Watch the big screen for live results.</p></div>';
  } else {
    if (inputs) inputs.classList.remove('hidden');
    stateEl.innerHTML = '';
  }
}

// ---- single-box drafts ----------------------------------------------------
// A word or an open-text answer is one box, but it is lost exactly the way a
// worksheet is: the participant frame carries only the ACTIVE poll, so the
// moment the host advances, renderVote rebuilds #voteContent and whatever was
// half-typed is gone — before they ever pressed Send. Same shelf as the
// worksheet's, one string instead of nine.
function boxKey(pollId) { return 'lp_box_' + CODE + '_' + pollId; }
function boxDraft(pollId) {
  try { return localStorage.getItem(boxKey(pollId)) || ''; }
  catch (e) { return ''; }   // private mode — start clean rather than blow up render
}
function boxKeep(pollId, el) { queueDraft(boxKey(pollId), el.value); }

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
    if (r.ok) { noticeClear(); markDone('poll_' + pollId); refreshVoteState(currentPoll()); toast('Vote counted'); }
    // The optimistic highlight has to come back off: a vote that never landed
    // otherwise sits on screen looking exactly like one that did.
    else { if (el) el.classList.remove('chosen'); await sendFailed(r, 'your vote', false); }
  } finally { delete inFlight[pollId]; }
}
async function rate(pollId, value, el) {
  if (isDone('poll_' + pollId) || inFlight[pollId]) return;
  inFlight[pollId] = 1;
  if (el) el.classList.add('chosen');
  try {
    const r = await api('/poll/' + pollId + '/rate', { value });
    if (r.ok) { noticeClear(); markDone('poll_' + pollId); refreshVoteState(currentPoll()); toast('Rating sent'); }
    else { if (el) el.classList.remove('chosen'); await sendFailed(r, 'your rating', false); }
  } finally { delete inFlight[pollId]; }
}
async function submitWord(pollId) {
  const el = document.getElementById('wordInput');
  const text = el.value.trim();
  if (!text) return;
  wsFlushDraft();   // the debounce has up to 400ms left to run, and the failure message promises it is already saved
  const r = await api('/poll/' + pollId + '/word', { text });
  if (r.ok) { el.value = ''; clearDraft(boxKey(pollId)); noticeClear(); toast('Added'); }
  else await sendFailed(r, 'your word', true);   // left in the box AND on the shelf
}
async function submitText(pollId) {
  const el = document.getElementById('textInput');
  const text = el.value.trim();
  if (!text) return;
  wsFlushDraft();
  const r = await api('/poll/' + pollId + '/text', { text, author: NAME });
  if (r.ok) { el.value = ''; clearDraft(boxKey(pollId)); noticeClear(); markDone('poll_' + pollId); toast('Response sent'); }
  else await sendFailed(r, 'your response', true);
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
// "1 of 1 box" — a one-column worksheet is a real shape, and the count line,
// the confirmation and the receipt all read off this.
function wsBoxes(n, total) { return n + ' of ' + total + (total === 1 ? ' box' : ' boxes'); }
function wsCountText(n, total) { return wsBoxes(n, total) + ' filled — partial is fine'; }
function wsTotal(poll) { return (poll.rows || []).length * (poll.columns || []).length; }
// Shared, because the photo path sets .value directly and no 'input' event fires
// for it — the count would sit at the pre-photo number until the next keystroke.
function wsSyncCount(total) {
  const c = document.getElementById('wsCount');
  if (c) c.textContent = wsCountText(wsCells().filter((x) => x.value.trim()).length, total);
}

function mountWorksheet(poll) {
  const grid = document.getElementById('wsGrid');
  if (!grid) return;
  const total = wsTotal(poll);
  wsPhotoReset();
  wsCardHtml = null;   // a brand-new #voteState node — nothing has been painted on it
  // A reload after a send comes back to the confirmation, not to an empty grid
  // that invites the same sheet a second time. An unsaved draft outranks it:
  // that is a sheet in progress, and it is already back in the boxes.
  wsMode = wsSentList(poll.id).length && !Object.keys(wsDraft(poll.id)).length ? 'sent' : 'entering';
  // ONE delegated listener on the container. Nine inline handlers would mean nine
  // closures rebuilt on every poll swap, and no place to hang the debounce.
  grid.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.cell) return;
    wsSyncCount(total);
    wsQueueDraft(poll.id);
  });
}

let wsTimer = null;
let wsPending = null;   // { key, data } — snapshotted at keystroke, written on the timer

// The snapshot is taken NOW and the write deferred, not the other way round: the
// host can swap the active poll inside the debounce window, and a flush that read
// the DOM at fire time would save the new poll's boxes under the old poll's key.
// One pending write is enough — only ever one poll's inputs are on screen.
function queueDraft(key, data) {
  wsPending = { key, data };
  clearTimeout(wsTimer);
  wsTimer = setTimeout(wsFlushDraft, 400);   // per-keystroke writes would thrash localStorage on a phone
}
function wsQueueDraft(pollId) {
  const out = {};
  for (const t of wsCells()) if (t.value.trim()) out[t.dataset.cell] = t.value;
  queueDraft(wsKey(pollId), JSON.stringify(out));
}

function wsFlushDraft() {
  clearTimeout(wsTimer);
  wsTimer = null;
  if (!wsPending) return;
  // An emptied box leaves no key behind: '' is the single-box types' "nothing
  // typed", where the worksheet's empty draft is '{}' and stays a real write.
  try {
    if (wsPending.data) localStorage.setItem(wsPending.key, wsPending.data);
    else localStorage.removeItem(wsPending.key);
  } catch (e) {}
  wsPending = null;
}

function clearDraft(key) {
  // Drop a queued write for this key too, or it would resurrect the draft we
  // just cleared 400ms after a successful submit.
  if (wsPending && wsPending.key === key) { clearTimeout(wsTimer); wsTimer = null; wsPending = null; }
  try { localStorage.removeItem(key); } catch (e) {}
}
function wsClearDraft(pollId) { clearDraft(wsKey(pollId)); }

// iOS can freeze or discard a backgrounded tab before the debounce fires — and
// that is exactly the participant who has typed the most.
document.addEventListener('visibilitychange', () => { if (document.hidden) wsFlushDraft(); });
window.addEventListener('pagehide', wsFlushDraft);

// ---- worksheet: many sheets, one device ------------------------------------
// The room fills these in on PAPER and one person per table photographs their
// table's pile, so a single phone carries four to ten DIFFERENT people's sheets.
// Two things follow. The poll cannot be single-submit; and the device needs a
// record of what actually went through, because a pile of paper is the only
// other thing to check against. Someone typing their own single sheet meets the
// same machinery with one line in it, which is why none of the copy below says
// "table" or "your worksheet".
let wsMode = 'entering';   // 'sent' keeps the grid behind the confirmation until a fresh one is asked for
let wsGen = 0;             // one per sheet: a read of the LAST sheet must never land in this one's boxes
let wsCardHtml = null;     // what wsRefreshState last painted — see the note there

// Held in memory, mirrored to storage — never read back out of it. iOS private
// browsing lets setItem throw while getItem keeps working, and a confirmation
// that depends on a write succeeding leaves a captain with seven sheets still
// to send looking at a hidden grid and an empty panel.
const wsSent = {};   // pollId -> entries, seeded from storage on mount
function wsSentKey(pollId) { return 'lp_wss_' + CODE + '_' + pollId; }
function wsSentSeed(pollId) {
  if (wsSent[pollId]) return;
  try {
    const v = JSON.parse(localStorage.getItem(wsSentKey(pollId)) || '[]');
    wsSent[pollId] = Array.isArray(v) ? v : [];
  } catch (e) { wsSent[pollId] = []; }   // private mode — an empty record beats a broken render
}
function wsSentList(pollId) { wsSentSeed(pollId); return wsSent[pollId]; }
// Capped: a captain carries ten sheets, not forty, and the tail is what matters.
function wsSentAdd(pollId, entry) {
  const list = wsSentList(pollId).concat([entry]).slice(-40);
  wsSent[pollId] = list;
  try { localStorage.setItem(wsSentKey(pollId), JSON.stringify(list)); } catch (e) {}
}

// Remembered per ROOM, not per poll and not per sheet: whoever is carrying a
// table's paper is on that table all session, and should type "Table 7" once.
function wsLabelKey() { return 'lp_wslabel_' + CODE; }
function wsLabelGet() { try { return localStorage.getItem(wsLabelKey()) || ''; } catch (e) { return ''; } }
// Written straight through rather than through queueDraft: that shelf holds ONE
// pending write, and a label keystroke would evict the grid's own snapshot.
function wsLabelKeep(el) { try { localStorage.setItem(wsLabelKey(), el.value.slice(0, 40)); } catch (e) {} }
function wsLabelValue() {
  const el = document.getElementById('wsLabel');
  return el ? el.value.trim().slice(0, 40) : '';
}

function wsSentRow(s) {
  const d = s.ts ? new Date(s.ts) : null;
  const time = d && !isNaN(d.getTime()) ? ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  return '<li>' + (s.label ? '<b>' + esc(s.label) + '</b> · ' : '') + wsBoxes(s.n, s.total) + ' · ' +
    (s.source === 'photo' ? 'from a photo' : 'typed') + time + '</li>';
}

// The receipt. Numbered, because "four of my six are in" is the only question
// being asked of it, and it has to survive a reload — a phone that drops the
// list halfway through a pile sends someone's sheet twice or not at all.
function wsSentCard(pollId) {
  const list = wsSentList(pollId);
  if (!list.length) return '';
  const last = list[list.length - 1];
  let rows = '';
  for (const s of list) rows += wsSentRow(s);
  let head = '<p class="eyebrow" style="margin:0 0 6px">Sent from this device</p>';
  // The action sits ABOVE the record, not under it: ten sent sheets would push
  // the only way back to a blank grid off the bottom of a phone.
  if (wsMode === 'sent') {
    head = '<p class="eyebrow" style="margin:0 0 6px">Worksheet sent</p>' +
      '<p class="muted" style="margin:0">' + wsBoxes(last.n, last.total) + ' went to the host' +
      (last.label ? ', labelled “' + esc(last.label) + '”' : '') + '. Watch the big screen for live results.</p>' +
      '<p class="small muted" style="margin:16px 0 10px">Another sheet to send? Start a fresh one — each worksheet is counted as one person.</p>' +
      '<button class="btn ghost" onclick="wsAddAnother(\'' + pollId + '\')">Add another worksheet</button>';
  }
  return '<div class="card tint ws-sent">' + head + '<ol class="ws-sent-list">' + rows + '</ol></div>';
}

// Repainted only when it actually changes. In a room this size an SSE tick lands
// every time anyone submits anything, and rebuilding this card under a finger is
// how a tap on "Add another worksheet" gets swallowed.
function wsRefreshState(poll, stateEl, inputs) {
  if (inputs) inputs.classList.toggle('hidden', wsMode === 'sent');
  const html = wsSentCard(poll.id);
  if (html === wsCardHtml) return;
  wsCardHtml = html;
  stateEl.innerHTML = html;
}

// The next sheet is a DIFFERENT person's. Anything left behind here is filed
// under the wrong participant, so this clears the boxes, the saved draft and
// every marker the photo lane left, and bumps the generation so a read still in
// flight for the last sheet cannot land in these boxes. Two things stay on
// purpose: the label, which names a table and not a person, and wsOcrBusy —
// releasing that would put a second OCR call on the room from one device.
function wsResetSheet(pollId) {
  wsGen++;
  wsOcrRaw = null;
  wsOcrApplied = {};
  for (const t of wsCells()) {
    t.value = '';
    t.readOnly = false;   // the send that just succeeded locked them
    const field = t.closest('.ws-field') || t.parentNode;
    field.classList.remove('ws-from-photo', 'ws-unread');
    wsCellNote(field, '');
  }
  wsClearDraft(pollId);   // drops the queued write too, which would otherwise restore the sheet 400ms later
  const msg = document.getElementById('wsPhotoMsg');
  if (msg) msg.innerHTML = '';
  const intro = document.getElementById('wsPhotoIntro');
  if (intro) intro.classList.remove('hidden');
  const btn = document.getElementById('wsPhotoBtn');
  if (btn) btn.disabled = wsOcrBusy;   // still reading the last sheet's photo — the lock stands
  const send = document.getElementById('wsSend');
  if (send) send.disabled = false;
  wsSyncCount(wsCells().length);
}

function wsAddAnother(pollId) {
  const poll = currentPoll();
  if (!poll || poll.id !== pollId || !wsGridIs(pollId)) return;   // host has moved on; there is no grid to clear
  wsResetSheet(pollId);
  wsMode = 'entering';
  refreshVoteState(poll);
  // Ten sent sheets push the empty grid well below the fold.
  const inputs = document.getElementById('voteInputs');
  if (inputs) inputs.scrollIntoView(true);
}

async function submitWorksheet(pollId) {
  if (inFlight[pollId]) return;
  const cells = {};
  let filled = 0;
  for (const t of wsCells()) {
    const v = t.value.trim();
    if (v) { cells[t.dataset.cell] = v; filled++; }
  }
  if (!filled) { toast('Fill at least one box'); return; }
  const total = wsCells().length;
  // Snapshotted with the cells: api() can retry for over a second, and the
  // record has to say what was actually attached to this submission.
  const label = wsLabelValue();
  const source = wsOcrRaw ? 'photo' : 'typed';
  // Once this device has sent one sheet it is carrying somebody else's paper,
  // and a sheet photographed for someone else is not the photographer's to sign
  // — the label says which table it came from, which is all the analysis wants.
  // The first sheet keeps the name: that is the individual filling in their own.
  const author = wsSentList(pollId).length ? '' : NAME;
  wsFlushDraft();   // the shelf must already match the screen before the send that might fail
  inFlight[pollId] = 1;
  const btn = document.getElementById('wsSend');
  if (btn) btn.disabled = true;
  // The cells were snapshotted above but api() can retry for over a second. Left
  // editable, anything typed in that window is neither sent nor kept: success
  // clears the draft and hides the grid, so the sentence just disappears.
  for (const t of wsCells()) t.readOnly = true;
  try {
    // The pre-edit transcription rides along with the corrected cells: the gap
    // between the two is the only honest answer to "is OCR good enough for this
    // room's handwriting", and it costs ~1 KB with none of the photo's PII.
    const r = await api('/poll/' + pollId + '/worksheet', source === 'photo'
      ? { cells, label, author, source, ocrRaw: wsOcrRaw }
      : { cells, label, author, source });
    if (r.ok) {
      // This sheet is closed. Bumping the generation is what stops a photo still
      // being read for it from landing in the next person's boxes — or writing a
      // draft that a reload would restore into them.
      wsGen++;
      wsClearDraft(pollId);
      noticeClear();
      wsSentAdd(pollId, { label, n: filled, total, source, ts: Date.now() });
      const p = currentPoll();
      // The host can advance mid-send; this confirmation belongs to THIS grid only.
      if (p && p.id === pollId) { wsMode = 'sent'; refreshVoteState(p); }
      toast('Worksheet sent');
    } else {
      // The draft stays put, and the boxes go back to editable — whatever the
      // failure was, nothing they typed is thrown away here. On a 409 the host
      // has usually already swapped the question and these cells belong to the
      // NEXT poll's grid; unlocking them is harmless, and sendFailed is the part
      // that tells them where their answers actually went.
      if (btn) btn.disabled = false;
      for (const t of wsCells()) t.readOnly = false;
      await sendFailed(r, 'this worksheet', true, wsTypedRecap());
    }
  } finally { delete inFlight[pollId]; }
}

// ---- worksheet: the photo lane --------------------------------------------
// A file input with `capture`, not getUserMedia: it opens the native camera on
// iOS and Android, it survives the in-app browsers people actually join from
// (Teams, Outlook, LinkedIn) where getUserMedia is blocked or permission-gated,
// and on a laptop it degrades to a file picker. No permission plumbing to break.
//
// OCR never submits anything. It proposes text into the boxes the participant is
// already looking at, and they press Send on it themselves — so the worst a bad
// read can cost is a minute of correcting, never a machine's guess going on the
// record as their words. Typing stays live the whole time: nothing below blocks,
// hides or disables the grid.
const WS_MAX_EDGE = 1568;    // the vision model's long edge — pixels past it are bytes it throws away anyway
const WS_B64_MAX = 900000;   // the server takes 6e6 of base64; this keeps the upload survivable on venue wifi
const WS_STATUS_MS = 3000;
// Null-prototype: `data.error` is whatever the server said, and a plain object
// would answer to 'constructor'.
const WS_NO_RETRY = Object.assign(Object.create(null), { ai_not_configured: 1, ai_key_rejected: 1 });

let wsOcrBusy = false;
let wsOcrRaw = null;         // the model's pre-edit transcription, sent with the corrected cells
let wsOcrApplied = {};       // what we wrote into each box, so a retake can tell its own text from theirs
let wsStatusTimer = null;

function wsPhotoReset() {
  wsStatusStop();
  wsGen++;
  wsOcrBusy = false;
  wsOcrRaw = null;
  wsOcrApplied = {};
}

// Every await below hands the host a window to swap the poll underneath us.
// Writing OCR into whatever grid happens to be on screen afterwards would put
// one worksheet's answers into another's boxes.
function wsGridIs(pollId) {
  const g = document.getElementById('wsGrid');
  return !!g && g.dataset.poll === pollId;
}

function wsPhotoPick() {
  if (wsOcrBusy) return;
  // Opening the camera backgrounds the tab, and iOS discards backgrounded tabs
  // freely. Anything typed since the last 400ms debounce tick exists only in
  // wsPending, so flush it synchronously before handing control to the OS —
  // otherwise the photo path is itself the likeliest way to lose typing.
  wsFlushDraft();
  const f = document.getElementById('wsPhotoFile');
  if (f) f.click();
}

async function wsPhotoPicked(input) {
  const file = input.files && input.files[0];
  input.value = '';   // without this, re-picking the SAME photo fires no change event at all
  if (!file || wsOcrBusy) return;
  const poll = currentPoll();
  if (!poll || poll.type !== 'worksheet' || !wsGridIs(poll.id)) return;
  const pollId = poll.id;
  const gen = wsGen;   // this read belongs to the sheet that is in the boxes NOW
  wsOcrBusy = true;
  const btn = document.getElementById('wsPhotoBtn');
  if (btn) btn.disabled = true;
  wsPhotoNote(pollId, 'Reading your photo — this takes a few seconds.', false);
  wsStatusStart(pollId, gen);
  try {
    let b64;
    try { b64 = await wsShrink(file); }
    catch (e) {
      return wsPhotoNote(pollId, e && e.message === 'too_big'
        ? 'That photo is still too large to send even after shrinking it. Try again in better light, or type the answers in.'
        : 'That file could not be read as a photo. Try another one, or type the answers in.', true);
    }
    let res;
    let data;
    try {
      // Deliberately NOT api(): that retries 5xx, and a 503 here means this photo
      // already took a queue slot. A retry would take a second one off the room.
      res = await fetch('/api/room/' + CODE + '/poll/' + pollId + '/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: b64, mediaType: 'image/jpeg' }),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      return wsPhotoNote(pollId, 'We could not reach the server. Check your signal and try again, or type the answers in.', true);
    }
    if (!wsGridIs(pollId)) return;
    // The sheet this photo was taken of has been sent, and the boxes are now the
    // next person's. An unused read costs a retake; a read filed under the wrong
    // participant cannot be spotted at all.
    if (gen !== wsGen) return wsPhotoNote(pollId, 'That photo was of a worksheet that has already been sent, so nothing was added to these boxes.', true);
    // submitWorksheet snapshotted the cells before it started retrying. Filling
    // boxes now would show text that is not in what the host is about to receive.
    if (inFlight[pollId]) return wsPhotoNote(pollId, 'This worksheet was already on its way to the host, so nothing from the photo was added.', false);
    // No AI at all, and a key the API refuses, are the failures no photo can get
    // past — those get no retry button. A truncated or refused read is about
    // THIS photo, so another one is still worth offering.
    if (!res.ok) return wsPhotoNote(pollId, wsHttpMessage(res.status, data), !WS_NO_RETRY[data.error]);
    if (data.match === false) return wsPhotoNote(pollId, data.message || 'Nothing could be read from that photo. Try another one, or type the answers in.', true);
    wsApplyOcr(poll, data);
  } finally {
    wsStatusStop();
    wsOcrBusy = false;
    const b = document.getElementById('wsPhotoBtn');
    if (b) b.disabled = false;
  }
}

// Every outcome — queued, filled, failed — lands in the one card, so there is
// only ever one place to look for what happened to the photo.
function wsPhotoNote(pollId, text, retry) {
  if (!wsGridIs(pollId)) return;
  const box = document.getElementById('wsPhotoMsg');
  if (!box) return;
  const intro = document.getElementById('wsPhotoIntro');
  if (intro) intro.classList.add('hidden');   // the card carries the retry button from here on
  box.innerHTML = '<div class="card tint ws-photo-msg"><p>' + esc(text) + '</p>' +
    (retry ? '<button class="btn ghost sm" onclick="wsPhotoPick()">Try another photo</button>' : '') + '</div>';
}

function wsHttpMessage(status, d) {
  if (status === 413 || d.error === 'payload_too_large') return 'That photo was too large to send. Try again in better light, or type the answers in.';
  if (d.error === 'ai_not_configured') return 'Reading photos is not switched on for this session — please type the answers in.';
  // A rejected key is not this photo's fault and no photo will get past it. The
  // server's own message names the environment variable, which is for the
  // facilitator's logs, not a phone — so this says what the participant can do
  // and who has to fix it.
  if (d.error === 'ai_key_rejected') return 'Photo reading is misconfigured for this session — the AI key was rejected. Let the host know, and type the answers in.';
  if (d.error === 'ai_truncated') return 'There was too much on that photo to read in one go. Try a photo of one row at a time, or type the answers in.';
  if (d.error === 'ai_refused') return 'The reader would not transcribe that photo. Try another one, or type the answers in.';
  if (status === 503) {
    const s = d.retryAfterSeconds;
    return 'Photos are queued right now — try again in ' + (s > 0 ? 'about ' + s + 's' : 'a moment') + ', or type the answers in.';
  }
  if (status === 409 || status === 404) return 'The host has moved on from this worksheet, so nothing was read.';
  if (status === 400) return 'That file could not be read as a photo. Try another one, or type the answers in.';
  return 'Something went wrong reading that photo. Try another one, or type the answers in.';
}

// ---- downscale ------------------------------------------------------------
async function wsShrink(file) {
  const src = await wsDecode(file);
  try {
    let b64 = await wsEncode(src, 0.8);
    // One retry at a lower quality, then stop. A third pass costs another few
    // seconds of staring at a phone to save bytes that were never the problem.
    if (b64.length > WS_B64_MAX) b64 = await wsEncode(src, 0.6);
    if (b64.length > WS_B64_MAX) throw new Error('too_big');
    return b64;
  } finally { if (src.close) src.close(); }
}

// imageOrientation is doing more work than it looks: iOS writes a portrait photo
// as landscape pixels plus an EXIF rotation flag, and createImageBitmap ignores
// that flag unless asked. A sideways worksheet is the single biggest cause of a
// bad read. Older Safari has no options bag — there, <img> applies the rotation
// itself, which is why the fallback is a decode and not an error.
function wsDecode(file) {
  if (window.createImageBitmap) {
    try { return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => wsDecodeImg(file)); }
    catch (e) { /* threw on the options bag — fall through to the <img> path */ }
  }
  return wsDecodeImg(file);
}

function wsDecodeImg(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    // HEIC straight off an iPhone lands here: nothing decodes it, and a plain
    // "could not read that photo" is more use than a broken upload.
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

function wsEncode(src, quality) {
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  if (!w || !h) return Promise.reject(new Error('decode'));
  const k = Math.min(1, WS_MAX_EDGE / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * k));
  cv.height = Math.max(1, Math.round(h * k));
  cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
  return new Promise((resolve, reject) => {
    cv.toBlob((blob) => {
      if (!blob) return reject(new Error('encode'));
      const fr = new FileReader();
      fr.onload = () => {
        const url = String(fr.result);
        resolve(url.slice(url.indexOf(',') + 1));   // drop the data: prefix — the server takes bare base64
      };
      fr.onerror = () => reject(new Error('read'));
      fr.readAsDataURL(blob);
    }, 'image/jpeg', quality);
  });
}

// ---- review ---------------------------------------------------------------
// Values only. Rewriting #wsGrid as a string would wipe whatever is half-typed
// in the other boxes and reset the lastPollId guard that stops it happening on
// every SSE tick.
function wsApplyOcr(poll, data) {
  const cells = data.cells || {};
  const unread = new Set(data.unreadable || []);
  const prev = wsOcrApplied;
  wsOcrApplied = {};
  let n = 0;
  let m = 0;
  let kept = 0;
  let carried = 0;
  for (const t of wsCells()) {
    const key = t.dataset.cell;
    const field = t.closest('.ws-field') || t.parentNode;
    field.classList.remove('ws-from-photo', 'ws-unread');
    wsCellNote(field, '');
    const text = cells[key] || '';
    // Does THIS read have anything to say about this box?
    const says = !!text || unread.has(key);
    // Does the box still hold the previous read, untouched?
    const wasOurs = !!prev[key] && t.value === prev[key];
    // A retake replaces the previous read, but only where the new read actually
    // supplies something. People retake because one row came out badly, so the
    // second photo is often a closer crop that misses boxes the first one got —
    // clearing those would silently delete answers already reviewed and accepted.
    if (wasOurs && says) t.value = '';
    if (wasOurs && !says) {
      wsOcrApplied[key] = prev[key];   // still ours, so a third retake can replace it
      field.classList.add('ws-from-photo');
      wsCellNote(field, 'From the photo — check it', 'ws-note-photo');
      carried++;
      continue;
    }
    const mine = t.value.trim();
    if (mine) {
      if (text || unread.has(key)) kept++;
      continue;
    }
    if (text) {
      t.value = text;
      wsOcrApplied[key] = text;
      field.classList.add('ws-from-photo');
      wsCellNote(field, 'From the photo — check it', 'ws-note-photo');
      n++;
    } else if (unread.has(key)) {
      // Left empty on purpose and said so. A guess here reads as correct and
      // gets submitted; a gap is the one thing they can see and fix.
      field.classList.add('ws-unread');
      wsCellNote(field, 'We couldn\'t read the handwriting here', 'ws-note-unread');
      m++;
    }
  }
  // Merge, don't replace: boxes carried over from an earlier read still hold
  // that read's text, and ocrRaw is what the edit-rate audit compares against.
  wsOcrRaw = Object.assign({}, wsOcrRaw || {}, cells);
  wsSyncCount(wsTotal(poll));
  wsQueueDraft(poll.id);   // photo text is a draft like any other — a reload must not lose it
  wsPhotoNote(poll.id, 'We filled in ' + n + (n === 1 ? ' box' : ' boxes') + ', couldn\'t read ' + m +
    ', and left ' + kept + ' already filled in' +
    (carried ? ' and ' + carried + ' from the last photo' : '') +
    '. Read it over, fix anything wrong, then send.', true);
}

// One note element per box, reused rather than appended, or a second photo would
// stack a second hint under every cell.
function wsCellNote(field, text, cls) {
  let note = field.querySelector('.ws-cell-note');
  if (!text) { if (note) note.parentNode.removeChild(note); return; }
  if (!note) { note = document.createElement('p'); field.appendChild(note); }
  note.className = 'ws-cell-note ' + cls;
  note.textContent = text;
}

// ---- queue position -------------------------------------------------------
function wsStatusStart(pollId, gen) {
  wsStatusStop();
  wsStatusTimer = setInterval(() => wsStatusTick(pollId, gen), WS_STATUS_MS);
  wsStatusTick(pollId, gen);
}
function wsStatusStop() { clearInterval(wsStatusTimer); wsStatusTimer = null; }

// "About 30s" beats a spinner: a queued photo behind twenty others is a real
// wait, and a participant who knows that goes back to typing instead of
// re-taking it. The depth counts THIS photo, hence the -1. A server without the
// endpoint is not a failure worth reporting — the generic line just stays.
async function wsStatusTick(pollId, gen) {
  // The generation moves on when the sheet is sent: a queue position for a read
  // nothing will use belongs on nobody's screen.
  if (!wsOcrBusy || gen !== wsGen) return wsStatusStop();
  let d;
  try {
    const r = await fetch('/api/ocr-status');
    if (!r.ok) return wsStatusStop();
    d = await r.json();
  } catch (e) { return; }
  if (!wsOcrBusy || gen !== wsGen || !wsGridIs(pollId) || !d) return;
  const ahead = Math.max(0, (d.running || 0) + (d.waiting || 0) - 1);
  const eta = d.etaSeconds > 0 ? ', about ' + d.etaSeconds + 's' : '';
  wsPhotoNote(pollId, ahead
    ? ahead + (ahead === 1 ? ' photo ahead of yours' : ' photos ahead of yours') + eta +
      '. Carry on typing if you like — this will not interrupt you.'
    : 'Reading your photo now' + eta + '.', false);
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
