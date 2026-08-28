'use strict';

const CODE = location.pathname.split('/').filter(Boolean)[1].toUpperCase();
let state = null;

// Stable anonymous id per device (for de-duping votes / upvotes — soft, internal use)
let ME = localStorage.getItem('lp_me');
if (!ME) { ME = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('lp_me', ME); }

// Track what this device has already done, keyed by poll/question id — and for
// a poll, WHAT it answered. Self-paced means going back and changing an answer,
// the server replaces by device id, and it never sends an answer body to a
// phone: this is the only copy of their own words, so it is what a revisited
// question is pre-filled from. A device that answered under an older build
// holds a bare 1 here — still answered, just nothing to pre-fill with.
// Worksheets are not here: one device deliberately sends many sheets, so that
// type keeps its own record of every sheet instead (wsSentList).
const done = JSON.parse(localStorage.getItem('lp_done_' + CODE) || '{}');
function markDone(k, val) {
  done[k] = val || 1;
  try { localStorage.setItem('lp_done_' + CODE, JSON.stringify(done)); } catch (e) {}   // private mode — the in-memory record still stands
}
function isDone(k) { return !!done[k]; }
function doneVal(k) { const v = done[k]; return v && typeof v === 'object' ? v : null; }
// A bare 1 is an answer sent by an older build: this device does not know what
// it chose, and the server has no record of WHO sent it either — so sending
// again would land as a SECOND answer from the same person instead of replacing
// the first. Answered, and the one thing that cannot be revised.
function isLegacy(pollId) { const k = 'poll_' + pollId; return isDone(k) && !doneVal(k); }

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
  // Nobody advances past a question any more, so a 409 means exactly one thing:
  // the host closed this one. A deleted poll answers 404. Both are final:
  // api() retries 5xx only, so "try again" here would be an instruction the
  // participant could follow forever without it ever working. Say what
  // happened and offer no retry.
  if (status === 409 || status === 404 || d.error === 'poll_not_active') {
    return notice('Question closed',
      'The host has closed this question, so ' + what + ' could not be sent.' +
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
  // Nothing in it the server could read as an answer — a lone comma, or a paste
  // that was all invisible characters. Sending the same thing again would fail
  // the same way, so this says what to do instead of "try again".
  if (d.error === 'empty') {
    return notice('Nothing to send',
      'There was nothing in that the server could read as an answer. What you typed is still here — change it and send again.',
      extraHtml);
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

// ---- the walkthrough ------------------------------------------------------
// The phone now holds the WHOLE run of show and the participant walks it at
// their own pace: nothing is gated on a presenter, and nothing pins the room to
// one question. `at` is the step on screen; polls.length is the end-of-run
// card, which is a real step you arrive at and can walk back from.
//
// atId, not at, is what actually holds the position. The author can add, delete
// or reorder questions in the middle of a session, and an index on its own
// would slide someone onto a different question between two SSE ticks.
const AT_END = '#end';
let at = 0;
let atId = null;      // null until the first frame resolves where they are
let listOpen = false; // the jump list — collapsed by default so the question stays in reach

function atKey() { return 'lp_at_' + CODE; }
function atRemember() { try { localStorage.setItem(atKey(), atId || ''); } catch (e) {} }

// Where a phone opens. The remembered step first — someone who was interrupted
// comes back to the question they were on, skipped ones and all. Failing that,
// the first thing they have not answered, which on a fresh join is question 1.
function atResolve(polls) {
  let saved = '';
  try { saved = localStorage.getItem(atKey()) || ''; } catch (e) {}
  if (saved === AT_END) return polls.length;
  const i = polls.findIndex((p) => p.id === saved);
  if (i >= 0) return i;
  const first = polls.findIndex((p) => p.state !== 'closed' && !isAnswered(p));
  return first >= 0 ? first : polls.length;
}

function syncAt(polls) {
  if (atId === AT_END) { at = polls.length; return; }
  if (atId !== null) {
    const i = polls.findIndex((p) => p.id === atId);
    if (i >= 0) { at = i; return; }        // still there, wherever it moved to
    at = Math.min(at, polls.length);       // deleted under them: hold the place in the run
  } else {
    at = atResolve(polls);
  }
  atId = at >= polls.length ? AT_END : polls[at].id;
  atRemember();
}

function goTo(i) {
  const polls = (state && state.polls) || [];
  // The shelf is up to 400ms behind the boxes and buildInput reads the shelf,
  // so anything typed in the last blink would be rebuilt away. This is the one
  // line that stops Next discarding an in-progress grid.
  wsFlushDraft();
  at = Math.max(0, Math.min(i, polls.length));
  atId = at >= polls.length ? AT_END : polls[at].id;
  atRemember();
  navHtml = null;   // the "you are here" mark moved
  renderVote();
  const card = document.getElementById('voteCard');
  if (card) card.scrollIntoView(true);   // a jump from the bottom of a nine-box grid must land on the question
}
function goNext() { goTo(at + 1); }
function goPrev() { goTo(at - 1); }
function toggleList() { listOpen = !listOpen; navHtml = null; renderVote(); }

// Worksheets are the one type with no single answer to remember: a device sends
// many sheets, and its own record of them is the receipt.
function isAnswered(poll) {
  if (poll.type === 'worksheet') return wsSentList(poll.id).length > 0;
  return isDone('poll_' + poll.id);
}

let lastPollId = null;   // what #voteContent was built for: a poll id, or AT_END
let navHtml = null;
let stepsHtml = null;
let endHtml = null;

function renderVote() {
  const content = document.getElementById('voteContent');
  if (!content) return;   // the session ended and took the panel with it
  const polls = (state && state.polls) || [];
  const empty = document.getElementById('voteEmpty');
  const nav = document.getElementById('navCard');
  const steps = document.getElementById('voteSteps');

  if (!polls.length) {
    // Not "waiting for the host" any more — nothing is gated on a presenter, so
    // an empty screen can only mean nothing has been written yet.
    const t = document.getElementById('joinTitle');
    if (t) t.textContent = state.title && state.title !== 'Untitled session' ? state.title : 'Nothing to answer yet';
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    nav.classList.add('hidden');
    steps.classList.add('hidden');
    lastPollId = navHtml = stepsHtml = endHtml = null;
    return;
  }
  syncAt(polls);
  empty.classList.add('hidden');
  content.classList.remove('hidden');
  nav.classList.remove('hidden');
  steps.classList.remove('hidden');

  // Every card below is repainted only when its own markup actually changes. An
  // SSE tick lands whenever anyone in the room submits anything, and rewriting
  // a card under a finger is how a tap on Next gets swallowed.
  const nh = navMarkup(polls);
  if (nh !== navHtml) { navHtml = nh; nav.innerHTML = nh; }

  const poll = polls[at] || null;
  const key = poll ? poll.id : AT_END;
  if (!poll) {
    // The end card has no inputs to interrupt, and what is still unanswered can
    // change under it, so it is safe to rebuild whenever it reads differently.
    const eh = buildEnd(polls);
    if (key !== lastPollId || eh !== endHtml) { lastPollId = key; endHtml = eh; content.innerHTML = eh; }
  } else if (key !== lastPollId) {
    // Only rebuild the input UI when the step changes, so typing isn't interrupted.
    lastPollId = key;
    endHtml = null;
    content.innerHTML = buildInput(poll);
    // The grid's counter and draft wiring can only be attached once the markup
    // exists, and must survive every later tick without being re-attached.
    if (poll.type === 'worksheet') mountWorksheet(poll);
  }
  if (poll) refreshVoteState(poll);

  const sh = stepsMarkup(polls);
  if (sh !== stepsHtml) { stepsHtml = sh; steps.innerHTML = sh; }
}

// The spine of the screen: how far through they are, and every question one tap
// away. Someone who joins late, or comes back from a phone call, reads their
// position off the count without opening anything.
function navMarkup(polls) {
  let n = 0;
  let total = 0;
  let items = '';
  polls.forEach((p, i) => {
    const mine = isAnswered(p);
    const shut = p.state === 'closed';
    // A closed question nobody answered is not something they can do anything
    // about, so it stays out of the count rather than making 8 of 8 unreachable.
    if (!shut || mine) { total++; if (mine) n++; }
    items += '<li><button class="sp-item' + (mine ? ' done' : '') + (i === at ? ' at' : '') + (shut ? ' shut' : '') +
      '" onclick="goTo(' + i + ')"><span class="sp-num">' + (i + 1) + '</span>' +
      '<span class="sp-q">' + esc(p.question) + '</span>' +
      '<span class="sp-flag">' + (shut ? 'Closed' : mine ? '✓ Answered' : 'Not answered') + '</span></button></li>';
  });
  const pct = total ? Math.round((n / total) * 100) : 0;
  return '<button class="sp-progress" onclick="toggleList()" aria-expanded="' + (listOpen ? 'true' : 'false') + '">' +
    '<span class="sp-count">' + n + ' of ' + total + ' answered</span>' +
    '<span class="sp-caret">' + (listOpen ? 'Hide list' : 'All questions') + '</span></button>' +
    '<div class="sp-bar"><span style="width:' + pct + '%"></span></div>' +
    '<ol class="sp-list' + (listOpen ? '' : ' hidden') + '">' + items + '</ol>';
}

// Next never asks for an answer first: a question can be skipped and come back
// to, which is the whole point of holding the run of show on the phone.
function stepsMarkup(polls) {
  const end = at >= polls.length;
  return '<button class="btn ghost" onclick="goPrev()"' + (at > 0 ? '' : ' disabled') + '>Back</button>' +
    '<span class="sp-pos">' + (end ? 'End of the questions' : 'Question ' + (at + 1) + ' of ' + polls.length) + '</span>' +
    (end ? '' : '<button class="btn go" onclick="goNext()">' + (at === polls.length - 1 ? 'Finish' : 'Next') + '</button>');
}

function buildEnd(polls) {
  const todo = polls.filter((p) => p.state !== 'closed' && !isAnswered(p));
  let head;
  if (!todo.length) {
    head = '<p class="eyebrow" style="color:var(--green)">✓ All done</p>' +
      '<h2 style="border:0">You\'ve answered everything.</h2>' +
      '<p class="muted">Nothing left to send. Go back over any question whenever you like — a new answer replaces the one you sent.</p>';
  } else {
    // Skipping is allowed, so this is a list and not a warning.
    head = '<p class="eyebrow">End of the questions</p>' +
      '<h2 style="border:0">' + todo.length + (todo.length === 1 ? ' question is' : ' questions are') + ' still unanswered.</h2>' +
      '<p class="muted">Nothing here is compulsory. If you want to go back, they are all one tap away.</p>';
  }
  let list = '';
  for (const p of todo) {
    const i = polls.indexOf(p);
    list += '<li><button class="sp-item" onclick="goTo(' + i + ')"><span class="sp-num">' + (i + 1) + '</span>' +
      '<span class="sp-q">' + esc(p.question) + '</span><span class="sp-flag">Answer</span></button></li>';
  }
  return '<div class="sp-end">' + head + '</div>' + (list ? '<ol class="sp-todo">' + list + '</ol>' : '');
}

// An answer already sent comes back into the box it was typed in. A draft wins
// over it: that is an edit in progress, and it is newer than what the host has.
function boxFill(poll) {
  const d = boxDraft(poll.id);
  if (d) return d;
  const mine = doneVal('poll_' + poll.id) || {};
  return mine.t || mine.w || '';
}

function buildInput(poll) {
  const q = '<div class="big-q">' + esc(poll.question) + '</div>';
  if (poll.type === 'multiple_choice') {
    // data-opt so the chosen one can be re-marked without rebuilding the list —
    // a rebuild would drop the tap that is still in flight.
    const opts = poll.options
      .map(
        (o) =>
          '<button class="answer-btn" data-opt="' + esc(o.id) + '" onclick="vote(\'' + poll.id + '\',\'' + o.id + '\')">' +
          esc(o.text) + '</button>'
      )
      .join('');
    return q + '<div id="voteState"></div>' + '<div id="voteInputs">' + opts + '</div>';
  }
  if (poll.type === 'rating') {
    let btns = '';
    for (let v = 1; v <= poll.scaleMax; v++) {
      btns += '<button class="scale-btn" data-val="' + v + '" onclick="rate(\'' + poll.id + '\',' + v + ')">' + v + '</button>';
    }
    return q +
      '<div class="row small muted" style="justify-content:space-between;margin-bottom:8px"><span>' + esc(poll.scaleLabelLow) +
      '</span><span>' + esc(poll.scaleLabelHigh) + '</span></div>' +
      '<div id="voteState"></div>' +
      '<div id="voteInputs" class="row tight">' + btns + '</div>';
  }
  if (poll.type === 'word_cloud') {
    // Restored INLINE for the same reason the worksheet is: a reload, or coming
    // back to this question later, must not blank what they had typed.
    return q +
      '<div id="voteState"></div>' +
      '<div id="voteInputs"><input id="wordInput" type="text" placeholder="Type a word or short phrase" maxlength="60"' +
      ' oninput="boxKeep(\'' + poll.id + '\',this)" value="' + esc(boxFill(poll)) + '" />' +
      '<div style="height:10px"></div><button class="btn go full" id="sendBtn" onclick="submitWord(\'' + poll.id +
      '\')">Send</button><p class="small muted center" style="margin-top:8px">Up to five words at once. Sending again replaces them.</p></div>';
  }
  if (poll.type === 'worksheet') {
    const rows = poll.rows || [];
    const cols = poll.columns || [];
    if (!rows.length || !cols.length) return q + '<div id="voteState"></div><div id="voteInputs"></div>';
    // Restored INLINE, not after mount: a phone that reloads mid-worksheet must
    // never flash nine empty boxes before the draft lands.
    const draft = wsDraft(poll.id);
    const wsEd = wsEditGet(poll.id);   // a correction in progress, with the label its sheet was sent with
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
      // A correction wears its own sheet's label, not the last one typed here.
      '<input id="wsLabel" type="text" maxlength="40" placeholder="e.g. Table 7" value="' + esc(wsEd ? wsEd.label : wsLabelGet()) +
      '" oninput="wsLabelKeep(this,\'' + poll.id + '\')" />' +
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
    ' oninput="boxKeep(\'' + poll.id + '\',this)">' + esc(boxFill(poll)) + '</textarea>' +
    '<div style="height:10px"></div><button class="btn go full" id="sendBtn" onclick="submitText(\'' + poll.id +
    '\')">Send</button></div>';
}

function stateCard(label, text) {
  return '<div class="card tint sp-state"><p class="eyebrow" style="margin:0 0 6px">' + esc(label) + '</p>' +
    '<p class="muted" style="margin:0">' + esc(text) + '</p></div>';
}

// What this device sent, in words, for the one screen that cannot show it in
// its own inputs: a closed question, whose boxes and buttons are gone.
function mineText(poll) {
  const m = doneVal('poll_' + poll.id);
  if (poll.type === 'worksheet') {
    const n = wsSentList(poll.id).length;
    return n ? ' You sent ' + n + (n === 1 ? ' worksheet' : ' worksheets') + '.' : '';
  }
  if (!m) return isDone('poll_' + poll.id) ? ' Your answer is in.' : '';
  if (m.o) {
    const opt = (poll.options || []).find((o) => o.id === m.o);
    return opt ? ' You answered “' + opt.text + '”.' : ' Your answer is in.';
  }
  if (m.v) return ' You rated it ' + m.v + '.';
  if (m.w) return ' You sent “' + m.w + '”.';
  if (m.t) return ' You sent “' + m.t + '”.';
  return ' Your answer is in.';
}

function refreshVoteState(poll) {
  const stateEl = document.getElementById('voteState');
  const inputs = document.getElementById('voteInputs');
  // No poll: the submit's own callers reach here after the participant walked
  // on to the next question, and reading .type off nothing would throw away the
  // confirmation toast for a submission the server had already accepted.
  if (!stateEl || !poll) return;
  // The only state a phone must not offer. It is the host's doing, not the
  // participant's, so it says so and shows them what they already sent.
  if (poll.state === 'closed') {
    if (inputs) inputs.classList.add('hidden');
    wsCardHtml = null;   // the worksheet card below is cached; it must repaint if this reopens
    stateEl.innerHTML = stateCard('Question closed',
      'The host has closed this one, so it can no longer be answered.' + mineText(poll));
    return;
  }
  if (inputs) inputs.classList.remove('hidden');
  // A worksheet is the one type a single device sends several of — one paper
  // sheet per person, all photographed from the same phone — so it never seals
  // itself off after a send and runs its own state below.
  if (poll.type === 'worksheet') return wsRefreshState(poll, stateEl, inputs);

  // Answered before this build existed. Neither end can tell that a second send
  // is the same person, so offering "tap a different option to change it" would
  // be a promise the server cannot keep: it would count them twice. Their answer
  // is safely in — this is the one question they are done with.
  if (isLegacy(poll.id)) {
    if (inputs) inputs.classList.add('hidden');
    stateEl.innerHTML = stateCard('Your answer is in',
      'You answered this one before the app was updated, so it can no longer be changed here. What you sent is still with the host.');
    return;
  }

  const mine = isDone('poll_' + poll.id);
  // The inputs stay live and pre-filled whatever else is true: going back to
  // change an answer is the point, so nothing here hides what they answered
  // with. Only the wording changes — sending again is a change, not a second
  // answer, and the server replaces rather than appends.
  const btn = document.getElementById('sendBtn');
  if (poll.type === 'multiple_choice' || poll.type === 'rating') {
    paintChoice(poll);
    stateEl.innerHTML = mine
      ? stateCard('Your answer is in', poll.type === 'rating'
        ? 'Tap a different number to change it — the new one replaces this.'
        : 'Tap a different option to change it — the new one replaces this.')
      : '';
    return;
  }
  if (btn) btn.textContent = !mine ? 'Send' : poll.type === 'word_cloud' ? 'Replace my words' : 'Send the change';
  stateEl.innerHTML = mine
    ? stateCard(poll.type === 'word_cloud' ? 'Your words are in' : 'Your answer is in',
      'Edit it below and send again — what you send replaces what the host already has.')
    : '';
}

// What the last tap claimed, held until its POST settles. An SSE tick lands
// every time anyone in the room submits anything, and repainting from the
// stored answer would take the highlight straight back off the option they are
// still waiting on.
const pending = {};
function paintChoice(poll) {
  const m = doneVal('poll_' + poll.id) || {};
  const want = pending[poll.id] !== undefined ? pending[poll.id] : (poll.type === 'rating' ? m.v : m.o);
  const attr = poll.type === 'rating' ? 'val' : 'opt';
  const els = document.querySelectorAll('#voteInputs .answer-btn, #voteInputs .scale-btn');
  for (const b of els) b.classList.toggle('chosen', want !== undefined && String(b.dataset[attr]) === String(want));
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

// Every submission carries `by`: the device id, so a second answer to the same
// question REPLACES the first instead of being counted as another person. It is
// not a name and it is not the anonymity choice — that is `author`, which stays
// exactly as the participant set it.
async function vote(pollId, optionId) {
  const was = doneVal('poll_' + pollId);
  // isLegacy: an answer this device cannot revise — the buttons are hidden, and
  // a send would be counted as a second person.
  if (inFlight[pollId] || isLegacy(pollId) || (was && was.o === optionId)) return;   // re-tapping the answer they already sent
  inFlight[pollId] = 1;
  pending[pollId] = optionId;   // the tap moves the highlight now; the POST can take a second
  paintChoice({ id: pollId, type: 'multiple_choice' });
  try {
    const r = await api('/poll/' + pollId + '/vote', { optionId, by: ME });
    if (r.ok) { noticeClear(); markDone('poll_' + pollId, { o: optionId }); toast(was ? 'Answer changed' : 'Vote counted'); }
    else await sendFailed(r, 'your vote', false);
  } finally {
    // The optimistic highlight has to go back to whatever actually landed: a
    // vote that never arrived otherwise sits on screen looking exactly like one
    // that did — and a failed CHANGE has to show the answer it did not replace.
    delete inFlight[pollId];
    delete pending[pollId];
    renderVote();
  }
}
async function rate(pollId, value) {
  const was = doneVal('poll_' + pollId);
  if (inFlight[pollId] || isLegacy(pollId) || (was && was.v === value)) return;
  inFlight[pollId] = 1;
  pending[pollId] = value;
  paintChoice({ id: pollId, type: 'rating' });
  try {
    const r = await api('/poll/' + pollId + '/rate', { value, by: ME });
    if (r.ok) { noticeClear(); markDone('poll_' + pollId, { v: value }); toast(was ? 'Rating changed' : 'Rating sent'); }
    else await sendFailed(r, 'your rating', false);
  } finally {
    delete inFlight[pollId];
    delete pending[pollId];
    renderVote();
  }
}
async function submitWord(pollId) {
  const el = document.getElementById('wordInput');
  const text = el.value.trim();
  if (!text || isLegacy(pollId)) return;
  const was = isDone('poll_' + pollId);
  wsFlushDraft();   // the debounce has up to 400ms left to run, and the failure message promises it is already saved
  const r = await api('/poll/' + pollId + '/word', { text, by: ME });
  if (r.ok) {
    // The box KEEPS the words: they are what the host has from this device now,
    // and sending again replaces that set rather than adding to it. The server's
    // own reading of them is what goes on the shelf — it splits and caps at five.
    const d = await okBody(r);
    clearDraft(boxKey(pollId));
    noticeClear();
    markDone('poll_' + pollId, { w: (d.words || []).join(' ') || text });
    renderVote();
    toast(was ? 'Words replaced' : 'Added');
  } else await sendFailed(r, 'your word', true);   // left in the box AND on the shelf
}
async function submitText(pollId) {
  const el = document.getElementById('textInput');
  const text = el.value.trim();
  if (!text || isLegacy(pollId)) return;
  const was = isDone('poll_' + pollId);
  wsFlushDraft();
  const r = await api('/poll/' + pollId + '/text', { text, author: NAME, by: ME });
  if (r.ok) {
    // Left in the box on purpose: it is their answer, not a spent form, and the
    // next thing they might do with it is edit it.
    clearDraft(boxKey(pollId));
    noticeClear();
    markDone('poll_' + pollId, { t: text });
    renderVote();
    toast(was ? 'Response updated' : 'Response sent');
  } else await sendFailed(r, 'your response', true);
}

// Read once, on success only — sendFailed reads the body on the other path.
async function okBody(r) { try { return await r.json(); } catch (e) { return {}; } }
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

// The question on screen right now. Null on the end-of-run card, and null once
// the poll behind this step has been deleted — every caller treats both as "the
// thing I was working on is no longer in front of me".
function currentPoll() {
  if (!state || atId === null || atId === AT_END) return null;
  return state.polls.find((p) => p.id === atId) || null;
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
  // Stepping to another question and back rebuilds this grid — but a photo
  // still being read, or one that finished while they were away, belongs to the
  // sheet that is still in these boxes. Only THIS sheet's photo state is this
  // mount's to clear: a read running (or waiting) for another worksheet keeps
  // the lock and its own generation, or stepping between two worksheets would
  // bin that read and free the camera for a second OCR call from one device.
  const reading = wsOcrBusy && wsOcrPoll === poll.id;
  const mine = wsOcrHeld && wsOcrHeld.pollId === poll.id ? wsOcrHeld : null;
  if (mine) wsOcrHeld = null;   // applied below or stale — either way it does not outlive this mount
  const held = mine && mine.gen === wsGenOf(poll.id) ? mine : null;
  if (!reading && !held) wsPhotoReset(poll.id);
  wsCardHtml = null;   // a brand-new #voteState node — nothing has been painted on it
  // A correction in progress has to outlive a reload too: without this the
  // corrected sheet would go to the host as a second one.
  const ed = wsEditGet(poll.id);
  wsEditId = ed ? ed.id : null;
  // A reload after a send comes back to the confirmation, not to an empty grid
  // that invites the same sheet a second time. An unsaved draft outranks it:
  // that is a sheet in progress, and it is already back in the boxes. So does a
  // photo still being read — its text is about to land in those boxes.
  wsMode = !reading && !held && wsSentList(poll.id).length && !Object.keys(wsDraft(poll.id)).length ? 'sent' : 'entering';
  // ONE delegated listener on the container. Nine inline handlers would mean nine
  // closures rebuilt on every poll swap, and no place to hang the debounce.
  grid.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.cell) return;
    wsSyncCount(total);
    wsQueueDraft(poll.id);
  });
  // The rebuilt controls start unlocked, but a read or a send still running owns
  // them: cells typed into during a send are in neither the submission nor the
  // draft it is about to clear, which is the one way this grid can still eat
  // someone's typing.
  // wsOcrBusy, not `reading`: the lock is one per device, so a read running for
  // ANOTHER worksheet has to leave this button disabled too — wsPhotoPick would
  // otherwise open the camera and then silently do nothing with the photo.
  if (wsOcrBusy) {
    const btn = document.getElementById('wsPhotoBtn');
    if (btn) btn.disabled = true;
  }
  if (inFlight[poll.id]) {
    for (const t of wsCells()) t.readOnly = true;
    const send = document.getElementById('wsSend');
    if (send) send.disabled = true;
  }
  // The read that finished while they were on another question, landing now
  // that its boxes are back on screen.
  if (held) wsApplyOcr(poll, held.data);
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
// The sheet in the boxes is finished with, so the correction marker goes with
// the draft: whatever is typed next is a new sheet, not a correction of an old
// one, and a stale marker would overwrite somebody else's answers.
function wsClearDraft(pollId) {
  clearDraft(wsKey(pollId));
  wsEditId = null;
  try { localStorage.removeItem(wsEditKey(pollId)); } catch (e) {}
}

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
// One counter per sheet, so a read of the LAST sheet never lands in this one's
// boxes — and one COUNTER PER POLL, because a read outstanding for worksheet A
// is still A's when the participant steps to worksheet B. A single counter for
// the phone made stepping between two worksheets orphan the read.
const wsGen = {};
function wsGenOf(pollId) { return wsGen[pollId] || 0; }
function wsGenBump(pollId) { wsGen[pollId] = wsGenOf(pollId) + 1; }
let wsCardHtml = null;     // what wsRefreshState last painted — see the note there
// The grid being CORRECTED, if any. This is the whole of worksheet revision:
// every other type revises by device id, but this device speaks for four to ten
// different people, so a correction has to name the sheet it corrects. Held in
// storage as well as memory — a reload mid-correction would otherwise send the
// corrected sheet as a second one.
let wsEditId = null;
function wsEditKey(pollId) { return 'lp_wsedit_' + CODE + '_' + pollId; }
// { id, label }. The LABEL rides with the correction, because the box is
// repainted from the room-wide store on every remount and self-paced navigation
// remounts on every Back and Next: a label that lived only in the DOM came back
// as whatever this device last typed, and the corrected sheet went to the host
// wearing another table's name.
function wsEditGet(pollId) {
  let raw = '';
  try { raw = localStorage.getItem(wsEditKey(pollId)) || ''; } catch (e) { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && v.id) return { id: String(v.id), label: String(v.label || '') };
  } catch (e) { /* a marker written when this held a bare id */ }
  return { id: raw, label: '' };
}
function wsEditPut(pollId, id, label) {
  wsEditId = id;
  try { localStorage.setItem(wsEditKey(pollId), JSON.stringify({ id, label: label || '' })); } catch (e) {}
}

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
function wsSentFind(pollId, gridId) { return wsSentList(pollId).find((s) => s.id === gridId) || null; }
// Capped: a captain carries ten sheets, not forty, and the tail is what matters.
// A corrected sheet REPLACES its own row instead of adding one — it went to the
// host once and came back fixed; it is not a second person. The cells ride along
// because a phone is never sent the bodies back: this record is the only thing
// a correction can be re-opened from.
const wsSentLast = {};   // the sheet the confirmation is about: correcting sheet 1 of 9 leaves the LAST row somebody else's
// `replaces` is the sheet a correction was aimed at. It is normally the same id
// coming back, but a correction whose target has gone — the host reset the
// question, or the cap evicted it — is filed by the server as a NEW sheet under
// a new id, and the row it was aimed at has to go with it or the receipt keeps
// offering to correct a sheet the host does not have.
function wsSentPut(pollId, entry, replaces) {
  wsSentLast[pollId] = entry;
  const all = wsSentList(pollId);
  const list = replaces && replaces !== entry.id ? all.filter((s) => s.id !== replaces) : all;
  const i = entry.id ? list.findIndex((s) => s.id === entry.id) : -1;
  const next = i >= 0
    ? list.slice(0, i).concat([entry], list.slice(i + 1))
    : list.concat([entry]).slice(-40);
  wsSent[pollId] = next;
  try { localStorage.setItem(wsSentKey(pollId), JSON.stringify(next)); } catch (e) {}
}

// Remembered per ROOM, not per poll and not per sheet: whoever is carrying a
// table's paper is on that table all session, and should type "Table 7" once.
function wsLabelKey() { return 'lp_wslabel_' + CODE; }
function wsLabelGet() { try { return localStorage.getItem(wsLabelKey()) || ''; } catch (e) { return ''; } }
// Written straight through rather than through queueDraft: that shelf holds ONE
// pending write, and a label keystroke would evict the grid's own snapshot.
// A correction's label is not "the table this device is at" — it is what that
// one sheet was sent with, so while one is in progress it is kept with the
// correction and the room-wide value is left alone.
function wsLabelKeep(el, pollId) {
  const v = el.value.slice(0, 40);
  if (wsEditId) return wsEditPut(pollId, wsEditId, v);
  try { localStorage.setItem(wsLabelKey(), v); } catch (e) {}
}
function wsLabelValue() {
  const el = document.getElementById('wsLabel');
  return el ? el.value.trim().slice(0, 40) : '';
}

function wsSentRow(s, pollId) {
  const d = s.ts ? new Date(s.ts) : null;
  const time = d && !isNaN(d.getTime()) ? ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  // Only sheets this device still holds the cells for can be re-opened; rows
  // written by an older build have the receipt but not the answers.
  const edit = s.id && s.cells
    ? ' · <button class="ws-edit" onclick="wsEdit(\'' + pollId + '\',\'' + s.id + '\')">' +
      (s.id === wsEditId ? 'Correcting…' : 'Correct this one') + '</button>'
    : '';
  return '<li>' + (s.label ? '<b>' + esc(s.label) + '</b> · ' : '') + wsBoxes(s.n, s.total) + ' · ' +
    (s.source === 'photo' ? 'from a photo' : 'typed') + time + edit + '</li>';
}

// The receipt. Numbered, because "four of my six are in" is the only question
// being asked of it, and it has to survive a reload — a phone that drops the
// list halfway through a pile sends someone's sheet twice or not at all.
function wsSentCard(pollId) {
  const list = wsSentList(pollId);
  if (!list.length) return '';
  // After a reload there is no "just sent" — the receipt itself is the record,
  // and its last row is the closest thing to the sheet they left off on.
  const last = wsSentLast[pollId] || list[list.length - 1];
  let rows = '';
  for (const s of list) rows += wsSentRow(s, pollId);
  let head = '<p class="eyebrow" style="margin:0 0 6px">Sent from this device</p>';
  // The action sits ABOVE the record, not under it: ten sent sheets would push
  // the only way back to a blank grid off the bottom of a phone.
  if (wsMode === 'sent') {
    head = '<p class="eyebrow" style="margin:0 0 6px">Worksheet sent</p>' +
      '<p class="muted" style="margin:0">' + wsBoxes(last.n, last.total) + ' went to the host' +
      (last.label ? ', labelled “' + esc(last.label) + '”' : '') + '. Move on whenever you are ready.</p>' +
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
  wsGenBump(pollId);
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
  if (!poll || poll.id !== pollId || !wsGridIs(pollId)) return;   // stepped away; there is no grid to clear
  wsResetSheet(pollId);
  wsMode = 'entering';
  wsCardHtml = null;   // the card carries the mode, and this one just changed
  refreshVoteState(poll);
  // Ten sent sheets push the empty grid well below the fold.
  const inputs = document.getElementById('voteInputs');
  if (inputs) inputs.scrollIntoView(true);
}

// Correcting ONE sheet that already went to the host. Not "my answer": this
// device may have sent nine people's sheets, so the row picks out which one, and
// the send that follows carries its gridId so the server overwrites that sheet
// instead of filing a tenth.
function wsEdit(pollId, gridId) {
  const poll = currentPoll();
  if (!poll || poll.id !== pollId || !wsGridIs(pollId) || inFlight[pollId]) return;
  const entry = wsSentFind(pollId, gridId);
  if (!entry || !entry.cells) return;
  wsResetSheet(pollId);   // clears the boxes, the draft, the photo markers and the last edit marker
  // The label goes into the marker, not just the box: a remount reads it back
  // from there, and every Back and Next is a remount.
  wsEditPut(pollId, gridId, entry.label || '');
  for (const t of wsCells()) t.value = entry.cells[t.dataset.cell] || '';
  const lab = document.getElementById('wsLabel');
  if (lab) lab.value = entry.label || '';
  wsSyncCount(wsCells().length);
  wsQueueDraft(pollId);   // a correction in the boxes is a draft like any other
  wsMode = 'entering';
  wsCardHtml = null;
  refreshVoteState(poll);
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
  const editId = wsEditId;
  const was = editId ? wsSentFind(pollId, editId) : null;
  // Once this device has sent one sheet it is carrying somebody else's paper,
  // and a sheet photographed for someone else is not the photographer's to sign
  // — the label says which table it came from, which is all the analysis wants.
  // The first sheet keeps the name: that is the individual filling in their own.
  // A correction keeps whatever its sheet was sent with, or fixing a typo would
  // quietly re-attribute someone else's answers to whoever holds the phone now.
  const author = was ? (was.author || '') : (wsSentList(pollId).length ? '' : NAME);
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
    // gridId is what makes this an overwrite of one named sheet rather than the
    // tenth sheet from a device that has already sent nine.
    const body = { cells, label, author, source, by: ME };
    if (editId) body.gridId = editId;
    if (source === 'photo') body.ocrRaw = wsOcrRaw;
    const r = await api('/poll/' + pollId + '/worksheet', body);
    if (r.ok) {
      // This sheet is closed. Bumping the generation is what stops a photo still
      // being read for it from landing in the next person's boxes — or writing a
      // draft that a reload would restore into them.
      wsGenBump(pollId);
      const d = await okBody(r);
      wsClearDraft(pollId);   // takes the correction marker with it
      noticeClear();
      // A correction the server could not aim at its sheet comes back under a
      // NEW id — it has been filed as a fresh sheet, and the receipt follows it.
      const gid = d.gridId || editId || '';
      wsSentPut(pollId, { id: gid, label, author, n: filled, total, source, ts: Date.now(), cells }, editId);
      const p = currentPoll();
      // They can step to the next question mid-send; this confirmation belongs
      // to THIS grid only. The rest of the screen still updates — the run of
      // show now shows this question as answered.
      if (p && p.id === pollId) { wsMode = 'sent'; wsCardHtml = null; }
      renderVote();
      toast(editId && gid === editId ? 'Worksheet corrected' : 'Worksheet sent');
    } else {
      // The draft stays put, and the boxes go back to editable — whatever the
      // failure was, nothing they typed is thrown away here. If they stepped on
      // during the retry these are another question's boxes, and unlocking them
      // is harmless; sendFailed is the part that tells them what happened.
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
let wsOcrPoll = null;        // which grid the in-flight read belongs to — the walkthrough can step away from it
let wsOcrHeld = null;        // { pollId, gen, data } — a read that landed while they were on another question
let wsOcrRaw = null;         // the model's pre-edit transcription, sent with the corrected cells
let wsOcrApplied = {};       // what we wrote into each box, so a retake can tell its own text from theirs
let wsStatusTimer = null;

// One sheet's photo state, and nothing else. The lock (wsOcrBusy/wsOcrPoll) and
// the status line belong to whichever read is actually running: clearing them
// from here binned another worksheet's read and let a second one start on the
// same device.
function wsPhotoReset(pollId) {
  if (!wsOcrBusy) wsStatusStop();
  wsGenBump(pollId);
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
  const gen = wsGenOf(pollId);   // this read belongs to the sheet that is in the boxes NOW
  wsOcrBusy = true;
  wsOcrPoll = pollId;  // …of this question, which they are free to step away from while it reads
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
    // They stepped on to another question while this read was running. The sheet
    // is untouched and still theirs, so the read is held rather than binned —
    // waiting thirty seconds for a photo and coming back to empty boxes is how
    // a self-paced room teaches people not to use the camera at all.
    if (!wsGridIs(pollId)) {
      if (gen === wsGenOf(pollId) && res.ok && data && data.match !== false) wsOcrHeld = { pollId, gen, data };
      return;
    }
    // The sheet this photo was taken of has been sent, and the boxes are now the
    // next person's. An unused read costs a retake; a read filed under the wrong
    // participant cannot be spotted at all.
    if (gen !== wsGenOf(pollId)) return wsPhotoNote(pollId, 'That photo was of a worksheet that has already been sent, so nothing was added to these boxes.', true);
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
  if (status === 409 || status === 404) return 'The host has closed this worksheet, so nothing was read.';
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
  if (!wsOcrBusy || gen !== wsGenOf(pollId)) return wsStatusStop();
  let d;
  try {
    const r = await fetch('/api/ocr-status');
    if (!r.ok) return wsStatusStop();
    d = await r.json();
  } catch (e) { return; }
  if (!wsOcrBusy || gen !== wsGenOf(pollId) || !wsGridIs(pollId) || !d) return;
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
