// Live Polls — bespoke interactive polling server (Slido/Mentimeter-style)
// Zero dependencies. Node built-in HTTP + Server-Sent Events for real-time push.
//
// Run:  node server.js         (defaults to port 3000)
//       PORT=8080 node server.js

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Supabase (durable store) ---------------------------------------------
// The Node server is the ONLY Supabase client — browsers talk to this server,
// never to Supabase directly — so the key lives only in the server env.
// Configure via env: SUPABASE_URL + SUPABASE_KEY (the publishable key).
// If either is unset the app runs in-memory only (no persistence); handy for
// local dev and a safe fallback if the DB is unreachable.
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const SB_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);

// --- Claude API (AI features) ---------------------------------------------
// Powers the AI endpoints (Q&A clustering, response synthesis, poll drafting,
// event debrief, cross-event trends). Configure via env: ANTHROPIC_API_KEY
// (required to enable), ANTHROPIC_MODEL (defaults to Opus 4.8), and optionally
// ANTHROPIC_BASE_URL. If the key is unset, AI endpoints report "not configured"
// and the rest of the app is unaffected.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';
const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
const AI_ENABLED = !!ANTHROPIC_KEY;

// Env knob reader. A knob set to garbage falls back to the default rather than
// poisoning a counter with NaN, and `min` lets 0 be a legal setting for retries
// while concurrency still has to be at least 1.
function envInt(name, def, min = 0) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= min ? n : def;
}

// --- AI call queue ---------------------------------------------------------
// A worksheet drop fans one vision call out per participant, so 100 calls can be
// in flight at once. Unbounded that means rate-limit 429s treated as hard
// failures, and — with no timeout — a hung socket leaking a request forever.
// Two lanes: a presenter clicking an AI button must never queue behind 40
// participant OCR jobs.
const AI_CONCURRENCY_OCR = envInt('AI_CONCURRENCY_OCR', 5, 1);
const AI_CONCURRENCY_INTERACTIVE = envInt('AI_CONCURRENCY_INTERACTIVE', 2, 1);
const AI_QUEUE_MAX = envInt('AI_QUEUE_MAX', 12, 1);
// Per attempt, not per call. Bounded low on purpose: with retries on top, a
// generous timeout multiplies into minutes of spinner for a socket that is dead.
const AI_TIMEOUT_MS = envInt('AI_TIMEOUT_MS', 60000, 1000);
const AI_MAX_RETRIES = envInt('AI_MAX_RETRIES', 4);
const AI_MAX_WAIT_MS = envInt('AI_MAX_WAIT_MS', 60000, 1000);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// rooms[code] = {
//   code, title, createdAt,
//   polls: [ Poll ],
//   activePollId: string|null,
//   questions: [ { id, text, votes, voters:Set, ts } ],   // Q&A board
// }
// Poll = {
//   id, type, question, state:'draft'|'active'|'closed',
//   options: [{id,text}],   // multiple_choice
//   scaleMax,               // rating
//   scaleLabelLow, scaleLabelHigh,
//   votes: { optionId: count },        // multiple_choice
//   words: [text],                     // word_cloud
//   ratings: [number],                 // rating
//   responses: [{id,text,ts}],         // open_text
// }
const rooms = Object.create(null);

// SSE clients per room: Map<code, Set<res>>
const clients = new Map();

// Reusable agenda templates (a saved run of show), keyed by lowercased name.
// agendas[key] = { name, polls: [ pollDef ], savedAt }
const agendas = Object.create(null);

// ---------------------------------------------------------------------------
// Persistence — Supabase Postgres via its REST API (no npm dependency).
// In-memory stays the live/realtime layer; Supabase is the durable source of
// truth so state survives redeploys and past events stay queryable.
// ---------------------------------------------------------------------------

// Minimal PostgREST client over Node's built-in https.
function sb(method, pathAndQuery, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + '/rest/v1' + pathAndQuery);
    const payload = opts.body != null ? JSON.stringify(opts.body) : null;
    const headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (opts.prefer) headers.Prefer = opts.prefer;
    const req = https.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); }
        } else {
          reject(new Error(`supabase ${method} ${pathAndQuery} -> ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const iso = (ms) => new Date(ms || Date.now()).toISOString();
// PostgREST in-list of text ids (our ids are hex/alnum, so no quoting needed).
const inList = (ids) => `(${ids.join(',')})`;

// The row shapes are the schema contract, so they live in one place — the
// change detector below fingerprints exactly what gets POSTed.
// The tables are managed by hand, and PostgREST 400s the WHOLE batch on one
// unknown column — so adding a field here without adding the column first stops
// every poll of every type persisting, not just the new one. `grids` and
// `worksheet` are new; run this once against the project before deploying:
//   alter table polls
//     add column if not exists grids jsonb not null default '[]'::jsonb,
//     add column if not exists worksheet jsonb not null default '{}'::jsonb;
// Fingerprints are only committed once a write lands, so the next save() after
// the columns exist re-sends everything the failed batch dropped — a room that is
// still live recovers on its own. One already archived by /end never saves again.
const pollRow = (code, p, i) => ({
  id: p.id,
  room_code: code,
  position: i,
  type: p.type,
  question: p.question,
  state: p.state,
  options: p.options || [],
  scale_max: p.scaleMax,
  scale_label_low: p.scaleLabelLow,
  scale_label_high: p.scaleLabelHigh,
  votes: p.votes || {},
  words: p.words || [],
  ratings: p.ratings || [],
  responses: p.responses || [],
  grids: p.grids || [],
  // One jsonb blob rather than five more columns: this row shape is written out
  // field by field, and the five are only ever read back together.
  worksheet: p.type === 'worksheet'
    ? {
      rows: p.rows || [],
      columns: p.columns || [],
      rowHeader: p.rowHeader || '',
      instructions: p.instructions || '',
      footnote: p.footnote || '',
    }
    : {},
  total_votes: totalVotes(p),
});

const questionRow = (code, q) => ({
  id: q.id,
  room_code: code,
  text: q.text,
  votes: q.votes,
  voters: [...q.voters],
  ts: q.ts,
  author: q.author || null,
});

// code -> Map<'p:'|'q:' + id, fingerprint of the row we last sent>. Without it
// a flush mid-burst re-POSTs every poll in the run of show (only one changed)
// and fires both prune DELETEs, several times a second.
const sentRows = new Map();
const rowFp = (row) => crypto.createHash('sha1').update(JSON.stringify(row)).digest('base64');
// Not a possible base64 digest, so a seeded id always re-sends once; it exists
// only so the pruner can tell a deleted id from one it has never seen.
const FP_UNKNOWN = '-';

// Write one room's CHANGED rows through to Supabase (upsert diffs, prune removals).
async function persistRoom(code) {
  const r = rooms[code];
  if (!r) {
    // Never delete on "gone from memory": /end archives by dropping the room but
    // keeps the rows, and a handler resuming on that orphan re-arms a flush that
    // would land here and cascade the freshly archived session away. Only
    // /delete removes a room, and it issues its own DELETE.
    sentRows.delete(code);
    return;
  }
  let seen = sentRows.get(code);
  if (!seen) sentRows.set(code, (seen = new Map()));

  await sb('POST', '/rooms', {
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: [{
      code: r.code,
      title: r.title,
      active_poll_id: r.activePollId,
      created_at: iso(r.createdAt),
      updated_at: iso(),
    }],
  });
  // /delete can cascade this room away while we await. Without the guard the
  // upserts below re-insert its polls and questions as a zombie room.
  if (!rooms[code]) return;

  const fresh = [];   // [key, fingerprint], committed only once the write lands
  const live = new Set();
  const polls = [];
  r.polls.forEach((p, i) => {
    const row = pollRow(code, p, i);
    const key = 'p:' + p.id;
    const f = rowFp(row);
    live.add(key);
    if (seen.get(key) === f) return;
    polls.push(row);
    fresh.push([key, f]);
  });
  const questions = [];
  for (const q of r.questions) {
    const row = questionRow(code, q);
    const key = 'q:' + q.id;
    const f = rowFp(row);
    live.add(key);
    if (seen.get(key) === f) continue;
    questions.push(row);
    fresh.push([key, f]);
  }
  const gone = [...seen.keys()].filter((key) => !live.has(key));

  const jobs = [];
  if (polls.length) jobs.push(sb('POST', '/polls', { prefer: 'resolution=merge-duplicates,return=minimal', body: polls }));
  if (questions.length) jobs.push(sb('POST', '/questions', { prefer: 'resolution=merge-duplicates,return=minimal', body: questions }));
  // Prune only when an id actually disappeared — these two fired on every
  // single flush before, two wasted round-trips each time.
  if (gone.some((key) => key[0] === 'p')) {
    const ids = r.polls.map((p) => p.id);
    jobs.push(sb('DELETE', `/polls?room_code=eq.${code}` + (ids.length ? `&id=not.in.${inList(ids)}` : '')));
  }
  if (gone.some((key) => key[0] === 'q')) {
    const ids = r.questions.map((q) => q.id);
    jobs.push(sb('DELETE', `/questions?room_code=eq.${code}` + (ids.length ? `&id=not.in.${inList(ids)}` : '')));
  }
  if (!jobs.length) return;
  await Promise.all(jobs);
  if (!rooms[code]) return;   // same cascade race, second await point
  for (const key of gone) seen.delete(key);
  for (const [key, f] of fresh) seen.set(key, f);
}

// Per-room write-through. Fire-and-forget from request handlers.
const dirty = new Set();
const saveTimers = new Map();   // code -> pending flush timer
const saveFirst = new Map();    // code -> ms of the first save() in this window
const saving = new Map();       // code -> in-flight persistRoom() promise
const resave = new Set();       // rooms that changed while persisting
const SAVE_MS = 150;
const SAVE_MAX_MS = 1000;       // a burst may delay a flush, never starve it

function save(code) {
  // The room must still be live: cancelSave() is a point-in-time cancel and
  // cannot stop a save() issued after /end has already returned, which would
  // persist a stale room object on top of the archive.
  if (!SB_ENABLED || !code || !rooms[code]) return;
  dirty.add(code);
  // Never two persistRoom() for one room at once — re-armed when this one lands.
  if (saving.has(code)) { resave.add(code); return; }
  const t = saveTimers.get(code);
  if (t) clearTimeout(t);
  const first = saveFirst.get(code) || Date.now();
  saveFirst.set(code, first);
  // Debounce, but capped: under a continuous burst the wait floors at 0 so the
  // flush actually runs instead of being pushed out one tap at a time. Timers
  // are per room so a busy room cannot starve a quiet one.
  const wait = Math.max(0, Math.min(SAVE_MS, first + SAVE_MAX_MS - Date.now()));
  saveTimers.set(code, setTimeout(() => flushRoom(code), wait));
}

function cancelSave(code) {
  const t = saveTimers.get(code);
  if (t) clearTimeout(t);
  saveTimers.delete(code);
  saveFirst.delete(code);
  dirty.delete(code);
  resave.delete(code);
}

async function flushRoom(code) {
  const t = saveTimers.get(code);
  if (t) clearTimeout(t);
  saveTimers.delete(code);
  saveFirst.delete(code);
  // Wait an in-flight persist out rather than skip it: /end flushes before it
  // archives and must not lose the batch that is still being written.
  while (saving.has(code)) await saving.get(code);
  if (!dirty.has(code)) return;
  dirty.delete(code);
  const p = persistRoom(code)
    .catch((e) => console.error('persist room', code, 'failed:', e.message))
    .finally(() => {
      saving.delete(code);
      if (resave.delete(code)) save(code);
    });
  saving.set(code, p);
  await p;
}

// For shutdown: land everything still pending before the process goes.
// `saving` too, not just `dirty`: a persist already in flight has been taken out
// of dirty, and exiting mid-round-trip drops exactly the batch this protects.
// flushRoom waits one out and then returns without re-writing it.
function flushAll() {
  return Promise.all([...new Set([...dirty, ...saving.keys()])].map((code) => flushRoom(code)));
}

async function saveAgenda(key) {
  if (!SB_ENABLED) return;
  const a = agendas[key];
  if (!a) return;
  try {
    await sb('POST', '/agendas', {
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: [{ key, name: a.name, polls: a.polls, saved_at: iso(a.savedAt) }],
    });
  } catch (e) { console.error('persist agenda', key, 'failed:', e.message); }
}
async function deleteAgenda(key) {
  if (!SB_ENABLED) return;
  try { await sb('DELETE', `/agendas?key=eq.${encodeURIComponent(key)}`); }
  catch (e) { console.error('delete agenda', key, 'failed:', e.message); }
}

// Load all state from Supabase into memory on boot.
async function load() {
  if (!SB_ENABLED) {
    console.log('Supabase not configured (SUPABASE_URL / SUPABASE_KEY) — running in-memory only, no persistence.');
    return;
  }
  try {
    // Live sessions only. /end archives a room by stamping ended_at and leaving
    // the rows; without the filter every session ever run is rebuilt in memory
    // on each boot — joinable again, and growing RSS forever. Archived sessions
    // are read straight from Supabase by analyticsList()/fetchRoomDetail().
    const [roomRows, agRows, codeRows] = await Promise.all([
      sb('GET', '/rooms?select=*&ended_at=is.null'),
      sb('GET', '/agendas?select=*'),
      sb('GET', '/rooms?select=code'),   // codes only — archived ones stay reserved
    ]);
    for (const c of codeRows || []) takenCodes.add(c.code);
    for (const rr of roomRows || []) {
      rooms[rr.code] = {
        code: rr.code,
        title: rr.title,
        createdAt: Date.parse(rr.created_at) || Date.now(),
        activePollId: rr.active_poll_id || null,
        polls: [],
        questions: [],
      };
    }
    // Scope the children to the live codes so the archive is not pulled over the
    // wire either. An empty in-list is not valid PostgREST, hence the branch.
    const liveCodes = Object.keys(rooms);
    const [pollRows, qRows] = liveCodes.length
      ? await Promise.all([
        sb('GET', `/polls?select=*&room_code=in.${inList(liveCodes)}&order=room_code,position`),
        sb('GET', `/questions?select=*&room_code=in.${inList(liveCodes)}&order=ts`),
      ])
      : [[], []];
    for (const p of pollRows || []) {
      const r = rooms[p.room_code];
      if (!r) continue;
      const w = p.worksheet || {};
      r.polls.push({
        id: p.id,
        type: p.type,
        question: p.question,
        state: p.state,
        options: p.options || [],
        scaleMax: p.scale_max,
        scaleLabelLow: p.scale_label_low,
        scaleLabelHigh: p.scale_label_high,
        votes: p.votes || {},
        words: p.words || [],
        ratings: p.ratings || [],
        responses: p.responses || [],
        grids: p.grids || [],
        rows: w.rows || [],
        columns: w.columns || [],
        rowHeader: w.rowHeader || '',
        instructions: w.instructions || '',
        footnote: w.footnote || '',
      });
    }
    for (const q of qRows || []) {
      const r = rooms[q.room_code];
      if (!r) continue;
      r.questions.push({ id: q.id, text: q.text, votes: q.votes, voters: new Set(q.voters || []), ts: Number(q.ts), author: q.author || '' });
    }
    for (const a of agRows || []) {
      agendas[a.key] = { name: a.name, polls: a.polls || [], savedAt: Date.parse(a.saved_at) || Date.now() };
    }
    // Seed the change tracker with the ids the DB already holds, so a poll
    // deleted before the first flush is still pruned.
    for (const c of Object.keys(rooms)) {
      const seen = new Map();
      for (const p of rooms[c].polls) seen.set('p:' + p.id, FP_UNKNOWN);
      for (const q of rooms[c].questions) seen.set('q:' + q.id, FP_UNKNOWN);
      sentRows.set(c, seen);
    }
    console.log(`Loaded ${Object.keys(rooms).length} room(s) and ${Object.keys(agendas).length} agenda(s) from Supabase.`);
  } catch (e) {
    console.error('Supabase load failed — starting with empty state:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Analytics / export (reads from Supabase — includes ended events not in memory)
// ---------------------------------------------------------------------------

// Summary of every session for the dashboard list.
async function analyticsList() {
  if (!SB_ENABLED) return { sessions: [], totals: { sessions: 0, responses: 0, questions: 0 } };
  const [roomRows, pollRows, qRows] = await Promise.all([
    sb('GET', '/rooms?select=code,title,created_at,ended_at,active_poll_id&order=created_at.desc'),
    sb('GET', '/polls?select=room_code,total_votes'),
    sb('GET', '/questions?select=room_code'),
  ]);
  const pollAgg = {};   // room_code -> { polls, responses }
  for (const p of pollRows || []) {
    const a = (pollAgg[p.room_code] = pollAgg[p.room_code] || { polls: 0, responses: 0 });
    a.polls++;
    a.responses += p.total_votes || 0;
  }
  const qAgg = {};      // room_code -> count
  for (const q of qRows || []) qAgg[q.room_code] = (qAgg[q.room_code] || 0) + 1;

  const sessions = (roomRows || []).map((r) => ({
    code: r.code,
    title: r.title,
    createdAt: r.created_at,
    endedAt: r.ended_at,
    live: !r.ended_at,
    polls: (pollAgg[r.code] || {}).polls || 0,
    responses: (pollAgg[r.code] || {}).responses || 0,
    questions: qAgg[r.code] || 0,
  }));
  const totals = sessions.reduce(
    (t, s) => ({ sessions: t.sessions + 1, responses: t.responses + s.responses, questions: t.questions + s.questions }),
    { sessions: 0, responses: 0, questions: 0 }
  );
  return { sessions, totals };
}

// Full detail for one session (for dashboard drill-down + CSV).
async function fetchRoomDetail(code) {
  if (!SB_ENABLED) return null;
  const rows = await sb('GET', `/rooms?code=eq.${code}&select=*`);
  const r = (rows || [])[0];
  if (!r) return null;
  const [polls, questions] = await Promise.all([
    sb('GET', `/polls?room_code=eq.${code}&select=*&order=position`),
    sb('GET', `/questions?room_code=eq.${code}&select=text,votes,author&order=votes.desc`),
  ]);
  return {
    code: r.code,
    title: r.title,
    createdAt: r.created_at,
    endedAt: r.ended_at,
    activePollId: r.active_poll_id,
    polls: (polls || []).map((p) => ({
      id: p.id,   // the dashboard needs to address one specific poll, not just its position
      position: p.position,
      type: p.type,
      question: p.question,
      state: p.state,
      options: p.options || [],
      scaleMax: p.scale_max,
      scaleLabelLow: p.scale_label_low,
      scaleLabelHigh: p.scale_label_high,
      votes: p.votes || {},
      words: p.words || [],
      ratings: p.ratings || [],
      responses: p.responses || [],
      grids: p.grids || [],
      rows: (p.worksheet || {}).rows || [],
      columns: (p.worksheet || {}).columns || [],
      rowHeader: (p.worksheet || {}).rowHeader || '',
      instructions: (p.worksheet || {}).instructions || '',
      footnote: (p.worksheet || {}).footnote || '',
      totalVotes: p.total_votes || 0,
    })),
    questions: questions || [],
  };
}

// One CSV cell (quote + escape).
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Flatten a session's results into analysis-friendly CSV rows.
function toCSV(d) {
  const header = ['session', 'code', 'date', 'poll', 'type', 'question', 'worksheet_row', 'worksheet_column', 'answer', 'count', 'percent', 'author'];
  const rows = [header];
  const date = (d.createdAt || '').slice(0, 10);
  const add = (poll, type, question, answer, count, percent, author) =>
    rows.push([d.title, d.code, date, poll, type, question, '', '', answer, count, percent, author || '']);
  // Separate helper so the two new columns cost no existing call site an argument.
  const addWs = (poll, question, row, col, answer, count, author) =>
    rows.push([d.title, d.code, date, poll, 'worksheet', question, row, col, answer, count, '', author || '']);

  d.polls.forEach((p) => {
    const n = p.position + 1;
    if (p.type === 'multiple_choice') {
      const total = Object.values(p.votes).reduce((a, b) => a + b, 0);
      p.options.forEach((o) => {
        const v = p.votes[o.id] || 0;
        add(n, p.type, p.question, o.text, v, total ? Math.round((v / total) * 100) + '%' : '0%');
      });
    } else if (p.type === 'rating') {
      const counts = {};
      p.ratings.forEach((r) => (counts[r] = (counts[r] || 0) + 1));
      const nR = p.ratings.length;
      const avg = nR ? (p.ratings.reduce((a, b) => a + b, 0) / nR).toFixed(2) : '';
      for (let v = 1; v <= (p.scaleMax || 5); v++) {
        const c = counts[v] || 0;
        add(n, p.type, p.question, v, c, nR ? Math.round((c / nR) * 100) + '%' : '0%');
      }
      add(n, p.type, p.question, 'AVERAGE', avg, '');
    } else if (p.type === 'word_cloud') {
      // Null prototype: the keys are whatever the room typed, and on a plain {}
      // the word "constructor" reads back a function instead of 0.
      const freq = Object.create(null);
      p.words.forEach((w) => { const k = w.toLowerCase(); freq[k] = (freq[k] || 0) + 1; });
      Object.entries(freq).sort((a, b) => b[1] - a[1]).forEach(([w, c]) => add(n, p.type, p.question, w, c, ''));
    } else if (p.type === 'open_text') {
      p.responses.forEach((r) => add(n, p.type, p.question, r.text, 1, '', r.author));
    } else if (p.type === 'worksheet') {
      // Every cell of every respondent, blanks included with count 0. The grid
      // stays rectangular, so "which boxes could nobody fill" is one pivot away.
      (p.grids || []).forEach((g) => {
        (p.rows || []).forEach((r) => (p.columns || []).forEach((c) => {
          const t = (g.cells || {})[r.id + c.id] || '';
          addWs(n, p.question, r.text, c.text, t, t ? 1 : 0, g.author);
        }));
      });
    }
  });
  d.questions.forEach((q) => add('', 'qa', 'Audience Q&A', q.text, q.votes, '', q.author));
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}

// ---------------------------------------------------------------------------
// AI features — Claude Messages API over Node's built-in https (no dependency).
// Uses structured outputs (output_config.format) so responses are valid JSON.
// ---------------------------------------------------------------------------

// One pooled socket set per protocol, shared by every lane: N queued calls
// should not mean N TLS handshakes. http is here only because
// ANTHROPIC_BASE_URL can point at a local proxy or mock.
const AI_SOCKETS = AI_CONCURRENCY_OCR + AI_CONCURRENCY_INTERACTIVE;
const aiAgents = {
  'https:': new https.Agent({ keepAlive: true, maxSockets: AI_SOCKETS }),
  'http:': new http.Agent({ keepAlive: true, maxSockets: AI_SOCKETS }),
};

// Worth another attempt; everything else (400/401/403/413) is our bug or our
// payload and retrying only burns the rate limit twice.
const AI_RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const AI_RETRY_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND']);

// retry-after is delta-seconds OR an HTTP-date — both are legal and both appear
// in the wild. Clamped: a server asking us to sleep for an hour is not an answer
// we can give a presenter mid-session.
function parseRetryAfter(h) {
  if (!h) return null;
  const s = String(h).trim();
  if (!s) return null;
  const secs = Number(s);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(s) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.min(60000, ms));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One HTTP round-trip to /v1/messages. No queueing, no retry — claude() owns
// both. Errors carry .status/.retryable/.retryAfterMs for the retry loop.
function claudeOnce({ system, user, content, schema, maxTokens = 2048, model }) {
  return new Promise((resolve, reject) => {
    const body = {
      model: model || ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      // `content` carries raw Anthropic content blocks (an image + text, for
      // worksheet OCR); `user` stays the plain-string path every caller uses.
      messages: [{ role: 'user', content: content || user }],
    };
    if (system) body.system = system;
    if (schema) body.output_config = { format: { type: 'json_schema', schema } };
    const payload = JSON.stringify(body);
    const url = new URL(ANTHROPIC_BASE + '/v1/messages');
    const transport = url.protocol === 'http:' ? http : https;
    // A timeout destroys the socket, which then emits its own error; first
    // settlement wins so the caller sees 'anthropic timeout', not ECONNRESET.
    let settled = false;
    const ok = (v) => { if (!settled) { settled = true; resolve(v); } };
    // Classified here rather than per-handler: the same dropped connection
    // arrives on `req` before the headers and on `res` after them, and an
    // unclassified ECONNRESET is a hard failure the retry loop never sees.
    const fail = (e) => {
      if (settled) return;
      settled = true;
      if (e && e.retryable == null) e.retryable = AI_RETRY_CODES.has(e.code);
      reject(e);
    };
    const req = transport.request(url, {
      method: 'POST',
      agent: aiAgents[url.protocol],
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      const chunks = [];
      // Buffered, not string-concatenated: a chunk boundary can fall inside a
      // multi-byte character and decoding per chunk corrupts it.
      res.on('data', (c) => chunks.push(c));
      res.on('error', fail);
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(`anthropic ${res.statusCode}: ${data.slice(0, 300)}`);
          e.status = res.statusCode;
          e.retryable = AI_RETRY_STATUS.has(res.statusCode);
          const ra = parseRetryAfter(res.headers['retry-after']);
          if (ra != null) e.retryAfterMs = ra;
          return fail(e);
        }
        try {
          const json = JSON.parse(data);
          const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          if (!schema) return ok(text);
          try { ok(JSON.parse(text)); }
          catch { fail(new Error('model did not return valid JSON')); }
        } catch (e) { fail(e); }
      });
    });
    req.setTimeout(AI_TIMEOUT_MS, () => {
      const e = new Error('anthropic timeout');
      e.code = 'timeout';
      e.retryable = true;
      req.destroy();
      fail(e);
    });
    req.on('error', fail);
    req.write(payload);
    req.end();
  });
}

// --- Lanes -----------------------------------------------------------------
const AI_ETA_SAMPLES = 20;
const AI_ETA_FALLBACK_MS = 8000;   // before this process has completed a single call

const newLane = (limit) => ({ limit, running: 0, waiting: [], durations: [], durSum: 0 });
const aiLanes = {
  ocr: newLane(AI_CONCURRENCY_OCR),
  interactive: newLane(AI_CONCURRENCY_INTERACTIVE),
};

// Successful calls only. A call that failed fast at the socket says nothing
// about how long the person behind it in the queue will wait.
function laneRecord(lane, ms) {
  lane.durations.push(ms);
  lane.durSum += ms;
  if (lane.durations.length > AI_ETA_SAMPLES) lane.durSum -= lane.durations.shift();
}

// Lane names are ours, never a client's — but an own-property check keeps a typo
// like 'constructor' from resolving to something off Object.prototype.
const isLane = (name) => Object.prototype.hasOwnProperty.call(aiLanes, name);

// How long a call submitted right now would sit before it starts — 0 on an idle
// lane. The caller turns this into "about 20 seconds" instead of a bare spinner.
function aiQueueDepth(name) {
  const lane = isLane(name) ? aiLanes[name] : aiLanes.interactive;
  const avg = lane.durations.length ? lane.durSum / lane.durations.length : AI_ETA_FALLBACK_MS;
  const ahead = lane.running + lane.waiting.length;
  return {
    running: lane.running,
    waiting: lane.waiting.length,
    etaSeconds: Math.round((Math.ceil(ahead / lane.limit) * avg) / 1000),
  };
}

// Shed load with a shape the router can map: 503 + a Retry-After the client can
// act on, never a 500 that reads like a bug.
function queueErr(code, message, lane) {
  const e = new Error(message);
  e.code = code;
  e.status = 503;
  e.retryAfterMs = Math.max(1, aiQueueDepth(lane).etaSeconds) * 1000;
  return e;
}

function lanePump(lane) {
  while (lane.running < lane.limit && lane.waiting.length) {
    const job = lane.waiting.shift();
    clearTimeout(job.timer);
    lane.running++;
    const started = Date.now();
    claudeRetry(job.opts, 0)
      .then((v) => { laneRecord(lane, Date.now() - started); job.resolve(v); }, job.reject)
      .finally(() => { lane.running--; lanePump(lane); });
  }
}

async function claudeRetry(opts, attempt) {
  try {
    return await claudeOnce(opts);
  } catch (e) {
    if (!e.retryable || attempt >= AI_MAX_RETRIES) throw e;
    // Full jitter, always — a fixed backoff re-synchronises the very fleet of
    // callers whose simultaneity caused the 429 in the first place. Retry-After
    // shifts that jitter later instead of replacing it: used as the whole wait,
    // a header parsing to 0 (clock skew, a literal "0") spends every attempt in
    // one burst, and a well-formed one wakes every lane slot in lockstep.
    const backoff = Math.random() * Math.min(30000, 500 * Math.pow(2, attempt));
    await sleep((e.retryAfterMs || 0) + backoff);
    return claudeRetry(opts, attempt + 1);
  }
}

// Same call signature as before the queue existed, so every AI endpoint gets
// concurrency limiting, retries and a timeout without an edit. `opts.lane`
// opts into the OCR lane; everything else stays interactive.
function claude(opts) {
  const name = opts && isLane(opts.lane) ? opts.lane : 'interactive';
  const lane = aiLanes[name];
  return new Promise((resolve, reject) => {
    if (lane.waiting.length >= AI_QUEUE_MAX) return reject(queueErr('queue_full', 'ai queue full', name));
    const job = { opts, resolve, reject, timer: null };
    // A clear failure at a minute beats a spinner at three. Only waiting jobs
    // are dropped — a call already on the wire is left to finish.
    job.timer = setTimeout(() => {
      const i = lane.waiting.indexOf(job);
      if (i < 0) return;
      lane.waiting.splice(i, 1);
      reject(queueErr('queue_timeout', 'ai queue timeout', name));
    }, AI_MAX_WAIT_MS);
    lane.waiting.push(job);
    lanePump(lane);
  });
}

// JSON-schema helper: object with all listed string/array props required.
const strObj = (props, req) => ({ type: 'object', additionalProperties: false, properties: props, required: req });

// The shipped worksheet, verbatim from the client's document. Also the fallback
// for a worksheet that arrives with no grid of its own: a worksheet with no rows
// or columns is nothing a participant can fill in, so an empty one is worse than
// the default one.
const MFI_WORKSHEET = {
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

// Prepended to every prompt that reports on real session data. Structured outputs
// force the model to emit every required field, so a model handed a thin session
// has no legal way to abstain — and fills the empty sections with invention that
// reads exactly like findings. These rules give it permission to return nothing.
const GROUNDING_RULES = [
  'GROUNDING RULES - these override every other instruction below:',
  '1. Use ONLY the text between the BEGIN SESSION DATA and END SESSION DATA markers. That text is the COMPLETE data set - not an excerpt, sample, preview or truncation. Nothing was withheld from you.',
  '2. Every claim must be traceable to a specific line of that text. If you cannot point at the line it came from, do not write the claim.',
  '3. Invent nothing: no counts, rankings, percentages, themes, topics, opinions or quotes. Do not illustrate, do not extrapolate, do not describe what a typical case would look like.',
  '4. Quotes are copied verbatim, character for character, from a response line. No response lines means no quotes.',
  '5. A poll marked (NO RESPONSES SUBMITTED) contributed nothing - do not describe it, rank it, or guess what people would have said about it. A question the PRESENTER asked is not data about the audience.',
  '6. Prefer omitting a section to filling it. An empty array is a correct answer.',
  '7. If the data cannot support the deliverable, set insufficientData to true, say what is missing in dataNotes, and leave every analytical array empty.',
  '8. Use no knowledge from outside the data - not about leadership, not about this client, not about what sessions like this usually surface.',
].join('\n');

// 1) Cluster & summarize a room's Q&A questions.
function aiQaClusters(room) {
  const qs = room.questions;
  if (!qs.length) return Promise.resolve({ themes: [], overview: 'No audience questions yet.' });
  const user =
    `Session: "${room.title}".\nAudience questions (with upvotes):\n` +
    qs.map((q, i) => `${i + 1}. (${q.votes} upvotes) ${q.text}`).join('\n');
  return claude({
    system:
      'You help a live-event host make sense of audience questions. Group similar or ' +
      'duplicate questions into a few clear themes. Rank themes by combined interest ' +
      '(number of questions + their upvotes). Keep titles and summaries short and neutral. ' +
      'Return at most 6 themes.',
    user,
    maxTokens: 1500,
    schema: strObj({
      themes: {
        type: 'array',
        items: strObj({
          title: { type: 'string' },
          summary: { type: 'string' },
          count: { type: 'integer' },
          sample: { type: 'string' },
        }, ['title', 'summary', 'count', 'sample']),
      },
      overview: { type: 'string' },
    }, ['themes', 'overview']),
  });
}

// 2) Synthesize open-text / word-cloud responses for a poll.
function aiSynthesize(poll) {
  let items = [];
  if (poll.type === 'open_text') items = poll.responses.map((r) => r.text);
  else if (poll.type === 'word_cloud') items = poll.words;
  else return Promise.reject(new Error('synthesis applies to open-text and word-cloud polls'));
  if (!items.length) return Promise.resolve({ themes: [], sentiment: 'no responses yet', quotes: [], pulse: 'No responses submitted yet.' });
  const user =
    `Question: "${poll.question}"\nResponses (${items.length}):\n` + items.map((t) => `- ${t}`).join('\n');
  return claude({
    system:
      'You synthesize live audience responses for a presenter to read aloud. Identify the ' +
      'main themes, gauge overall sentiment in a few words, pull 2-4 short representative ' +
      'verbatim quotes, and write a one-sentence "pulse of the room". Be concise and neutral. ' +
      'Each quote must be copied character for character from a response line - never ' +
      'paraphrased, tidied, merged or composed. The presenter reads these aloud as ' +
      'someone\'s actual words.',
    user,
    maxTokens: 1500,
    schema: strObj({
      themes: {
        type: 'array',
        items: strObj({ label: { type: 'string' }, summary: { type: 'string' } }, ['label', 'summary']),
      },
      sentiment: { type: 'string' },
      quotes: { type: 'array', items: { type: 'string' }, description: 'Verbatim substrings of the response lines. Anything not literally present is discarded.' },
      pulse: { type: 'string' },
    }, ['themes', 'sentiment', 'quotes', 'pulse']),
  }).then((r) => Object.assign({}, r, { quotes: verifyQuotes(r.quotes, items, `synthesize "${poll.question}"`) }));
}

// 3) Draft a poll from a topic.
function aiDraftPoll(topic, type) {
  const t = ['multiple_choice', 'word_cloud', 'rating', 'open_text'].includes(type) ? type : 'multiple_choice';
  return claude({
    system:
      'You draft a single audience poll for a live leadership session. Write one clear, ' +
      'neutral question. For multiple_choice, give 2-5 concise, mutually distinct options. ' +
      'For rating, leave options empty and give short low/high scale labels. For word_cloud ' +
      'and open_text, leave options empty and scale labels empty. Only fill fields that apply.',
    user: `Poll type: ${t}\nTopic: ${topic}`,
    maxTokens: 500,
    schema: strObj({
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' } },
      scaleLabelLow: { type: 'string' },
      scaleLabelHigh: { type: 'string' },
    }, ['question', 'options', 'scaleLabelLow', 'scaleLabelHigh']),
  });
}

// What a session actually holds. Counts are recomputed from the raw arrays rather
// than read from the stored total_votes column: a half-finished write-through can
// leave that column non-zero on a poll with no responses, and it is these numbers
// that decide whether Claude is called at all.
function responseStats(d) {
  const polls = (d && d.polls) || [];
  const counts = polls.map((p) => totalVotes(p));
  const responses = counts.reduce((a, b) => a + b, 0);
  const questions = ((d && d.questions) || []).length;
  return {
    counts,
    polls: polls.length,  // same key the analytics list item uses; the dashboard reads one shape for both
    answeredPolls: counts.filter((n) => n > 0).length,
    responses,
    questions,
    hasData: responses > 0 || questions > 0,
  };
}

// Fold typography so a quote the model re-typed with smart punctuation still
// matches the raw text a participant submitted from a phone keyboard.
function normQuote(s) {
  return String(s == null ? '' : s)
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Exactly what participants typed, and nothing else. The corpus a prompt is built
// from also carries poll questions, option labels, the session title and the app's
// own scaffolding - all presenter-authored - so checking quotes against it would
// pass the presenter's words back as the room's.
function participantText(d) {
  const out = [];
  ((d && d.polls) || []).forEach((p) => {
    if (p.type === 'open_text') (p.responses || []).forEach((r) => out.push(r.text));
    else if (p.type === 'word_cloud') (p.words || []).forEach((w) => out.push(w));
    // One item per cell, not per submission: a joined grid would let two people's
    // boxes be stitched into one passing "quote". Newlines are folded because the
    // corpus folds them too, and a quote is only ever copied from the corpus.
    else if (p.type === 'worksheet') {
      (p.grids || []).forEach((g) => Object.values(g.cells || {}).forEach((t) => out.push(String(t).replace(/\n+/g, ' / '))));
    }
  });
  return out;
}

// The hard guarantee against invented quotes. A prompt can ask for verbatim text;
// only a substring check can enforce it, and the presenter reads these aloud as
// somebody's actual words. Matched per submission, never against a joined blob: a
// join lets two participants' answers be stitched into one passing "quote".
function verifyQuotes(quotes, items, label) {
  const hay = (Array.isArray(items) ? items : [items]).map(normQuote).filter(Boolean);
  const list = Array.isArray(quotes) ? quotes : [];
  const kept = list.filter((q) => {
    const n = normQuote(q).replace(/^["']+|["']+$/g, '').replace(/\.\.\.$/, '').trim();
    return n.length >= 3 && hay.some((h) => h.indexOf(n) !== -1);
  });
  if (kept.length < list.length) {
    console.warn(`AI quote check (${label}): dropped ${list.length - kept.length} of ${list.length} unverifiable quote(s)`);
  }
  return kept;
}

// Answered without calling Claude. 200 rather than an error: the ask was valid,
// the answer is "nothing has been submitted yet". headline/summary repeat the
// message so a browser still running a cached dashboard.js — which knows nothing
// about insufficientData — shows the reason instead of empty sections.
function insufficientDebrief(st) {
  const message = st.polls
    ? `Answers are needed to generate a debrief. This session has ${st.polls} ${st.polls === 1 ? 'poll' : 'polls'} but 0 responses and 0 audience questions, so there is nothing to summarize. Collect answers first - the debrief is built only from what participants submit.`
    : 'Answers are needed to generate a debrief. This session has no polls and no audience questions yet, so there is nothing to summarize.';
  return {
    insufficientData: true,
    reason: 'no_responses',
    message,
    stats: st,
    headline: message,
    summary: message,
    dataNotes: message,
    pollTakeaways: [],
    qaThemes: [],
    quotes: [],
    followUps: [],
  };
}

function insufficientTrends(total, answered) {
  const message = total
    ? `Answers are needed to spot cross-event trends. Sessions with responses: ${answered} of ${total}. At least 2 are needed to compare across events. Trends are drawn only from submitted answers - nothing is inferred.`
    : 'Answers are needed to spot cross-event trends. There are no sessions yet.';
  return {
    insufficientData: true,
    reason: answered > 0 ? 'not_enough_answered_sessions' : 'no_answered_sessions',
    message,
    stats: { sessions: total, answeredSessions: answered },
    summary: message,
    dataNotes: message,
    trends: [],
    recommendations: [],
  };
}

// Compact text corpus of a session's results (shared by debrief and trends).
// Emptiness is spelled out at every level. A question line with nothing under it
// is indistinguishable from a truncated payload, and a model that believes data
// was withheld supplies its own. BEGIN/END markers replace '---' because
// participant text can contain a markdown rule and split a session in two.
const CELL_SAMPLE = 8;   // answers printed per worksheet box; the count line carries the rest
function sessionCorpus(d) {
  const st = responseStats(d);
  const lines = [
    '=== BEGIN SESSION DATA ===',
    `Session: "${d.title}" (${(d.createdAt || '').slice(0, 10)})`,
    `Totals: ${st.polls} poll(s); ${st.responses} participant response(s) across ${st.answeredPolls} answered poll(s); ${st.questions} audience question(s).`,
  ];
  if (!st.hasData) lines.push('NOTE: this session has NO participant data at all - no poll responses and no audience questions.');
  d.polls.forEach((p, i) => {
    const n = st.counts[i];
    lines.push(`\nPoll ${i + 1} [${p.type}] - ${n} response(s): ${p.question}`);
    if (!n) { lines.push('  (NO RESPONSES SUBMITTED)'); return; }  // nothing below is safe to divide by, or to report
    if (p.type === 'multiple_choice') {
      p.options.forEach((o) => lines.push(`  - ${o.text}: ${p.votes[o.id] || 0} (${Math.round((100 * (p.votes[o.id] || 0)) / n)}%)`));
    } else if (p.type === 'rating') {
      const avg = (p.ratings.reduce((a, b) => a + b, 0) / n).toFixed(2);
      lines.push(`  average rating ${avg} on a 1-${p.scaleMax || 5} scale, from ${n} responses (${p.scaleLabelLow || 'low'}=low .. ${p.scaleLabelHigh || 'high'}=high)`);
    } else if (p.type === 'word_cloud') {
      lines.push('  words: ' + p.words.join(', '));
    } else if (p.type === 'open_text') {
      p.responses.forEach((r) => lines.push(`  · ${r.text}`));
    } else if (p.type === 'worksheet') {
      lines.push(`  worksheet grid - rows: ${p.rowHeader || '(unlabelled)'}`);
      (p.rows || []).forEach((r) => (p.columns || []).forEach((c) => {
        const answers = (p.grids || [])
          .map((g) => (g.cells || {})[r.id + c.id])
          .filter((t) => t && t.trim());
        lines.push(`  [${r.text} | ${c.text}] - ${answers.length} of ${n} answered`);
        // One answer per line: a cell can hold newlines, and a wrapped answer
        // reads as several separate ones. Sampled, because a worksheet holds
        // rows x cols bodies per participant where every other type holds one —
        // 25 unsampled sessions overrun the model's context on their own.
        answers.slice(0, CELL_SAMPLE).forEach((t) => lines.push(`    · ${t.replace(/\n+/g, ' / ')}`));
        if (answers.length > CELL_SAMPLE) lines.push(`    ... and ${answers.length - CELL_SAMPLE} more answer(s) in this box`);
      }));
    }
  });
  lines.push(st.questions
    ? '\nAudience Q&A:\n' + d.questions.map((q) => `  (${q.votes}) ${q.text}`).join('\n')
    : '\nAudience Q&A: (NO QUESTIONS SUBMITTED)');
  lines.push('=== END SESSION DATA ===');
  return lines.join('\n');
}

// 4) Executive debrief for one session.
// Every field stays in `required`: required constrains presence, not content — an
// array may be [] and a string may be "". Dropping fields from `required` buys no
// behaviour and risks a 400 from /v1/messages. The licence to abstain lives in each
// field's description instead, which the model reads inside the constrained-decoding
// path, at the moment it decides whether to emit an item.
function aiDebrief(detail) {
  const corpus = sessionCorpus(detail);
  const stats = responseStats(detail);
  return claude({
    system:
      GROUNDING_RULES + '\n\n' +
      'You are an executive facilitator writing a concise post-session debrief for The ExCo ' +
      'Group (leadership advisory). Write one takeaway for each poll THAT HAS RESPONSES and ' +
      'skip every other poll entirely. Q&A themes come only from questions the audience ' +
      'submitted. Every follow-up must follow from a specific submitted response - not from ' +
      'general leadership best practice, and not from what the poll questions were about.',
    user: corpus,
    maxTokens: 3000,
    schema: strObj({
      insufficientData: { type: 'boolean', description: 'True when the submitted data cannot support a debrief. Say why in dataNotes and leave the arrays empty.' },
      dataNotes: { type: 'string', description: 'What is missing or too thin to report on, in one line. Empty string if the data fully supports the debrief.' },
      headline: { type: 'string', description: 'One line, drawn only from submitted answers. With no answers, state that no answers were submitted - never characterise the group.' },
      summary: { type: 'string', description: 'What the submitted answers show. With no answers, say so plainly in one sentence and stop.' },
      pollTakeaways: { type: 'array', items: { type: 'string' }, description: 'One entry per poll that has responses, naming that poll. Skip polls marked (NO RESPONSES SUBMITTED). Empty array if no poll has responses.' },
      qaThemes: { type: 'array', items: { type: 'string' }, description: 'Themes across audience-submitted questions only. Empty array if no questions were submitted.' },
      quotes: { type: 'array', items: { type: 'string' }, description: 'Verbatim substrings of response lines, copied character for character. Empty array if there are no response lines.' },
      followUps: { type: 'array', items: { type: 'string' }, description: 'Each traceable to a specific submitted response. Empty array if nothing was submitted to act on.' },
    }, ['insufficientData', 'dataNotes', 'headline', 'summary', 'pollTakeaways', 'qaThemes', 'quotes', 'followUps']),
  }).then((r) => Object.assign({}, r, {
    quotes: verifyQuotes(r.quotes, participantText(detail), `debrief ${detail.code}`),
    stats,
  }));
}

// Trends joins up to 25 corpora into one prompt, so a single long session cannot be
// allowed to eat the context the other 24 need. Truncated rather than dropped: a
// thin slice of a session still counts toward "the same theme in two sessions".
const TRENDS_SESSION_BYTES = 12000;
const clipCorpus = (s) => (s.length <= TRENDS_SESSION_BYTES
  ? s
  : s.slice(0, TRENDS_SESSION_BYTES) + '\n... (this session\'s data is truncated here to fit the comparison)\n=== END SESSION DATA ===');

// 5) Cross-event trends across multiple session detail objects.
// Sessions with no participant data are dropped from the corpus, not just labelled.
// An empty session still prints its PRESENTER-AUTHORED poll questions, which are
// topical and suggestive — feed a dozen of those to a trends prompt and it will
// read the presenter's agenda back as the audience's concerns.
function aiTrends(details, totalSessions) {
  const withData = details.filter((d) => responseStats(d).hasData);
  const total = totalSessions == null ? details.length : totalSessions;
  const excluded = Math.max(0, total - withData.length);
  const header =
    `${total} session(s) exist. ${withData.length} contain participant data and appear below, ` +
    `oldest to newest. ${excluded} contain no responses and no questions and are excluded.`;
  return claude({
    system:
      GROUNDING_RULES + '\n\n' +
      'You analyze audience polling across multiple leadership sessions for The ExCo Group. ' +
      'A trend requires the SAME theme in the responses of at least TWO DIFFERENT sessions; ' +
      'one session\'s data is never a trend. Name the sessions each trend was read from. Do ' +
      'not claim a shift over time unless both endpoints of that shift appear in the data. ' +
      'Write a short summary, the trends, and recommendations that follow from them.',
    user: `${header}\n\n${withData.map((d) => clipCorpus(sessionCorpus(d))).join('\n\n')}`,
    maxTokens: 3000,
    schema: strObj({
      insufficientData: { type: 'boolean', description: 'True when fewer than two sessions share a theme, or the data is too thin to compare. Say why in dataNotes and leave the arrays empty.' },
      dataNotes: { type: 'string', description: 'What is missing or too thin to compare across events, in one line. Empty string if the data fully supports the analysis.' },
      summary: { type: 'string', description: 'What the submitted answers show across sessions. If nothing recurs across two sessions, say exactly that.' },
      trends: {
        type: 'array',
        description: 'Empty array unless a theme appears in the responses of two or more sessions. One thin session is not a trend.',
        items: strObj({
          title: { type: 'string' },
          detail: { type: 'string', description: 'What was said, in which sessions. Traceable to specific response lines.' },
          sessions: { type: 'array', items: { type: 'string' }, description: 'Titles of the sessions this trend was read from - at least two, named exactly as they appear in the data.' },
        }, ['title', 'detail', 'sessions']),
      },
      recommendations: { type: 'array', items: { type: 'string' }, description: 'Each following from a listed trend. Empty array if there are no trends.' },
    }, ['insufficientData', 'dataNotes', 'summary', 'trends', 'recommendations']),
  }).then((r) => Object.assign({}, r, {
    stats: { sessions: total, answeredSessions: withData.length },
  }));
}

// Convert a room's polls back into reusable definitions (strip live results/ids).
function pollsToDefs(polls) {
  return polls.map((p) => ({
    type: p.type,
    question: p.question,
    options: (p.options || []).map((o) => o.text),
    scaleMax: p.scaleMax,
    scaleLabelLow: p.scaleLabelLow,
    scaleLabelHigh: p.scaleLabelHigh,
    // Without these a saved agenda round-trips a custom worksheet back through
    // makePoll, which finds no grid and quietly substitutes the default one.
    rows: (p.rows || []).map((r) => r.text),
    columns: (p.columns || []).map((c) => c.text),
    rowHeader: p.rowHeader,
    instructions: p.instructions,
    footnote: p.footnote,
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
// Every code the DB holds, archived included. load() only hydrates live rooms, so
// `rooms` alone would hand out a code an archived session still owns — and the
// room upsert would then merge a new session onto that archive row.
const takenCodes = new Set();
function newCode(len = 5) {
  let code;
  do {
    code = '';
    const bytes = crypto.randomBytes(len);
    for (let i = 0; i < len; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  } while (rooms[code] || takenCodes.has(code));
  takenCodes.add(code);
  return code;
}

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function now() {
  return Date.now();
}

function publicRoom(r) {
  // Shape sent to clients (Set -> count, hide voter identities)
  return {
    code: r.code,
    title: r.title,
    activePollId: r.activePollId,
    polls: r.polls.map((p) => ({
      id: p.id,
      type: p.type,
      question: p.question,
      state: p.state,
      options: p.options,
      scaleMax: p.scaleMax,
      scaleLabelLow: p.scaleLabelLow,
      scaleLabelHigh: p.scaleLabelHigh,
      votes: p.votes,
      words: p.words,
      ratings: p.ratings,
      responses: p.responses,
      rows: p.rows || [],
      columns: p.columns || [],
      rowHeader: p.rowHeader || '',
      instructions: p.instructions || '',
      footnote: p.footnote || '',
      // Never the bodies: 100 grids x 9 cells is ~135 KB on every tick, to every
      // client. The presenter pulls them from /poll/:id/worksheet on demand.
      grids: [],
      gridCount: (p.grids || []).length,
      cellFill: cellFill(p),
      totalVotes: totalVotes(p),
    })),
    questions: r.questions
      .map((q) => ({ id: q.id, text: q.text, votes: q.votes, ts: q.ts, author: q.author || '' }))
      .sort((a, b) => b.votes - a.votes || a.ts - b.ts),
  };
}

// Slim frame for participant phones. join.js reads only the active poll and the
// Q&A vote counts, never per-poll results — so shipping the whole room to 100
// phones on every submission was pure waste (and the OOM). `polls` stays an
// ARRAY of one so join.js's polls.find(...) keeps working untouched.
function participantRoom(r) {
  const p = r.polls.find((x) => x.id === r.activePollId);
  return {
    code: r.code,
    title: r.title,
    activePollId: r.activePollId,
    polls: p
      ? [{
        id: p.id,
        type: p.type,
        question: p.question,
        state: p.state,
        options: p.options,
        scaleMax: p.scaleMax,
        scaleLabelLow: p.scaleLabelLow,
        scaleLabelHigh: p.scaleLabelHigh,
        // The grid definition, without a single body: a phone cannot render the
        // worksheet at all without these five, and needs nothing else.
        rows: p.rows || [],
        columns: p.columns || [],
        rowHeader: p.rowHeader || '',
        instructions: p.instructions || '',
        footnote: p.footnote || '',
        totalVotes: totalVotes(p),   // aggregate only — never the raw responses
      }]
      : [],
    questions: r.questions
      .map((q) => ({ id: q.id, text: q.text, votes: q.votes, ts: q.ts, author: q.author || '' }))
      .sort((a, b) => b.votes - a.votes || a.ts - b.ts),
  };
}

function totalVotes(p) {
  if (p.type === 'multiple_choice') return Object.values(p.votes).reduce((a, b) => a + b, 0);
  if (p.type === 'word_cloud') return p.words.length;
  if (p.type === 'rating') return p.ratings.length;
  if (p.type === 'open_text') return p.responses.length;
  // Load-bearing: this is what total_votes persists, so without it a fully
  // answered worksheet reports zero responses to analytics, the presenter pill
  // and the AI data gates alike.
  if (p.type === 'worksheet') return (p.grids || []).length;
  return 0;
}

// How many respondents filled each cell — 9 ints, ~100 bytes. Derived on the way
// out and never persisted, so the stage can show fill progress live without the
// bodies riding every broadcast tick.
function cellFill(p) {
  const out = {};
  const rows = p.rows || [];
  const cols = p.columns || [];
  for (const r of rows) for (const c of cols) out[r.id + c.id] = 0;
  for (const g of p.grids || []) {
    for (const r of rows) for (const c of cols) {
      if (String((g.cells || {})[r.id + c.id] || '').trim()) out[r.id + c.id]++;
    }
  }
  return out;
}

const BROADCAST_MS = 120;
const bcTimers = new Map();   // code -> pending tick
const bcLast = new Map();     // code -> ms of the last emit

// Skip rather than buffer. Frames are full snapshots, so the next one repairs a
// client that missed this one — and one stalled phone can no longer pile
// megabytes of backlog into our heap, which is what actually caused the OOM.
function writeSse(res, frame) {
  try {
    if (res.writableLength > (1 << 20)) return;
    res.write(frame);
  } catch {
    /* dead connection cleaned up on close */
  }
}

function emit(code) {
  const set = clients.get(code);
  const r = rooms[code];
  // A room can be ended between a tick being scheduled and it firing.
  if (!r || !set || set.size === 0) return;
  bcLast.set(code, Date.now());
  let stage = null;
  let join = null;
  for (const res of set) {
    // Serialize once per view per tick, and only build the stage frame if a
    // stage client is actually watching.
    if (res.lpView === 'stage') writeSse(res, (stage || (stage = `data: ${JSON.stringify(publicRoom(r))}\n\n`)));
    else writeSse(res, (join || (join = `data: ${JSON.stringify(participantRoom(r))}\n\n`)));
  }
}

// Throttle, NOT a debounce: a debounce would reset its timer on every
// submission and never fire during a continuous burst. The pending tick is set
// once and left alone, so a burst still delivers a frame per window.
function broadcast(code, immediate) {
  const set = clients.get(code);
  if (!set || set.size === 0) return;
  const t = bcTimers.get(code);
  if (immediate) {
    if (t) { clearTimeout(t); bcTimers.delete(code); }
    return emit(code);
  }
  if (t) return;
  const wait = BROADCAST_MS - (Date.now() - (bcLast.get(code) || 0));
  if (wait <= 0) return emit(code);   // leading edge: the first response still lands instantly
  bcTimers.set(code, setTimeout(() => { bcTimers.delete(code); emit(code); }, wait));
}

function cancelBroadcast(code) {
  const t = bcTimers.get(code);
  if (t) clearTimeout(t);
  bcTimers.delete(code);
  bcLast.delete(code);
}

// Tell everyone watching a room that it has ended, then close their streams.
function endStreams(code) {
  cancelBroadcast(code);   // a scheduled tick would otherwise write to closed responses
  const set = clients.get(code);
  if (!set) return;
  for (const res of set) {
    try {
      res.write(`data: ${JSON.stringify({ ended: true })}\n\n`);
      res.end();
      // A stream sitting on the 1 MB backpressure cap cannot drain, so end()
      // leaves it half-open forever — nothing else reclaims it (no server.timeout).
      if (res.writableLength > (1 << 20) && res.socket) res.socket.destroy();
    } catch {
      /* ignore */
    }
  }
  clients.delete(code);
}

function send(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  }, headers || null));
  res.end(body);
}

function notFound(res) {
  send(res, 404, { error: 'not_found' });
}

// Load shedding is not a server fault. A queue-full, a queue timeout or a body
// over budget is a "come back in a moment", so it gets a 503 with a Retry-After
// rather than a 500 the client reads as a bug worth retrying immediately.
const BUSY_CODES = new Set(['queue_full', 'queue_timeout', 'server_busy']);
function sendApiError(res, e) {
  // A body error usually fires because the socket went away; writing to it
  // throws ERR_STREAM_WRITE_AFTER_END and takes down the whole request handler.
  if (res.writableEnded || res.destroyed) return;
  // A body shed mid-stream leaves the rest of it unread on the socket, which a
  // kept-alive connection would parse as the next request — so those answers
  // hang up once the status is out.
  const conn = e && e.closeConn ? { Connection: 'close' } : null;
  if (e && (e.status === 503 || BUSY_CODES.has(e.code))) {
    const secs = Math.max(1, Math.ceil((e.retryAfterMs != null ? e.retryAfterMs : 5000) / 1000));
    return send(res, 503, { error: 'busy', reason: e.code || 'busy', retryAfterSeconds: secs }, Object.assign({ 'Retry-After': String(secs) }, conn));
  }
  if (e && e.status === 413) return send(res, 413, { error: 'payload_too_large' }, conn);
  return send(res, 500, { error: 'server_error', message: e.message }, conn);
}

// An AI endpoint that catches its own failure still has to tell a shed call
// apart from an upstream fault, or the queue's 503 + Retry-After is flattened
// into a 502 the client can only read as "AI request failed".
function sendAiError(res, e) {
  if (e && (e.status === 503 || BUSY_CODES.has(e.code))) return sendApiError(res, e);
  return send(res, 502, { error: 'ai_error', message: e.message });
}

// Per-request cap. Stays the default for every existing caller, so nothing but
// an explicit opt-in can push a bigger body through.
const BODY_MAX = 1e6;
// Process-wide ceiling across all concurrent bodies. Per-request caps alone do
// not bound memory: 100 phones uploading at once is 100 × the per-request cap.
const BODY_BUDGET = envInt('BODY_BUDGET', 96e6, 1);
let bodyInFlight = 0;

// Shaped for the router's error map: 413 -> payload_too_large, 503 -> busy.
function bodyErr(status, code) {
  const e = new Error(code);
  e.status = status;
  e.code = code;
  if (status === 503) e.retryAfterMs = 2000;
  return e;
}

function readBody(req, max = BODY_MAX) {
  return new Promise((resolve, reject) => {
    // Refuse on the declared size before reading a byte — no reason to stream in
    // 10 MB only to throw it away at the end.
    const declared = Number(req.headers['content-length']);
    const claim = Number.isFinite(declared) && declared > 0 ? declared : 0;
    if (claim > max) return reject(bodyErr(413, 'payload_too_large'));
    if (bodyInFlight + claim > BODY_BUDGET) return reject(bodyErr(503, 'server_busy'));

    const chunks = [];
    let size = 0;
    let charged = 0;
    // A counter that leaks once wedges every later request on this process, and
    // 'end', 'error' and 'aborted' can fire in combination — so release exactly
    // what was charged, exactly once.
    let released = false;
    const release = () => { if (!released) { released = true; bodyInFlight -= charged; } };
    const fail = (e) => { release(); reject(e); };
    // Answer before tearing down. req.destroy() takes the socket with it, so
    // sendApiError finds a dead response and the client gets a bare reset
    // instead of the 413 or the 503 + Retry-After it could act on. Pausing
    // stops the read (and stops charging) without killing the answer.
    const shed = (e) => { req.pause(); e.closeConn = true; return fail(e); };

    req.on('data', (chunk) => {
      size += chunk.length;
      charged += chunk.length;
      bodyInFlight += chunk.length;
      if (size > max) return shed(bodyErr(413, 'payload_too_large'));
      if (bodyInFlight > BODY_BUDGET) return shed(bodyErr(503, 'server_busy'));
      // Buffers, not string +=: V8 can hold a concatenated string at 2 bytes per
      // char, roughly doubling peak memory on a large body.
      chunks.push(chunk);
    });
    req.on('end', () => {
      release();
      if (!size) return resolve({});
      // Unparseable stays {} exactly as before — and the input is never echoed
      // back, because on this path it may be image bytes.
      try { resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
      catch { resolve({}); }
    });
    req.on('aborted', () => fail(bodyErr(400, 'client_aborted')));
    req.on('error', fail);
  });
}

function clean(str, max = 280) {
  return String(str == null ? '' : str)
    .replace(/[\x00-\x1f\x7f]/g, ' ') // strip control chars
    .trim()
    .slice(0, max);
}

// Same sweep, but \n survives. Worksheet cells are longer-form and people type
// short lists into them — clean() flattens every control char to a space and
// would silently run those lists into one line.
function cleanMulti(str, max = 400) {
  return String(str == null ? '' : str)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

// Submission de-dupe. With 100 phones on venue wifi the client has to retry,
// and retrying is only safe if a repeat is a no-op instead of a second count.
// Bounded FIFO so a long session cannot grow the set without limit.
// Hanging .sids/.sidQ off the poll (or room) is safe: pollRow() and
// publicRoom() both enumerate their fields explicitly, so these are never
// persisted and never broadcast.
const SID_MAX = 4000;
function applied(holder, sid) {
  if (!sid) return false;   // no sid — old clients behave exactly as before
  if (!holder.sids) { holder.sids = new Set(); holder.sidQ = []; }
  if (holder.sids.has(sid)) return true;
  holder.sids.add(sid);
  holder.sidQ.push(sid);
  if (holder.sidQ.length > SID_MAX) holder.sids.delete(holder.sidQ.shift());
  return false;
}

// One axis of a worksheet grid. The ids are positional (r1..rN / c1..cN), never
// id() hex: the key set has to be small and closed so a participant's saved draft
// still matches after a reload, and so a CSV column header stays readable.
const gridAxis = (list, max, cap, prefix) =>
  (Array.isArray(list) ? list : [])
    .map((t) => clean(t, max))
    .filter(Boolean)
    .slice(0, cap)
    .map((text, i) => ({ id: prefix + (i + 1), text }));

// A worksheet definition carrying exactly one axis. The presenter typed rows and
// forgot the columns (or the reverse) — makePoll cannot guess the other half, and
// the run-of-show importer reaches this on an ordinary typo, so every create path
// says so rather than silently shipping a grid nobody wrote.
function halfWorksheet(d) {
  if (!d || d.type !== 'worksheet') return false;
  const rows = gridAxis(d.rows || d.options, 120, 6, 'r').length;
  const cols = gridAxis(d.columns, 160, 4, 'c').length;
  return (rows > 0) !== (cols > 0);
}
const WORKSHEET_AXES_ERROR = { error: 'worksheet_needs_both_axes' };

// Build a validated poll object from a raw definition (used by single + bulk create).
function makePoll(def) {
  def = def || {};
  const type = ['multiple_choice', 'word_cloud', 'rating', 'open_text', 'worksheet'].includes(def.type)
    ? def.type
    : 'multiple_choice';
  const poll = {
    id: id(),
    type,
    question: clean(def.question, 200) || 'Untitled question',
    state: 'draft',
    options: [],
    scaleMax: 5,
    scaleLabelLow: clean(def.scaleLabelLow, 40) || 'Poor',
    scaleLabelHigh: clean(def.scaleLabelHigh, 40) || 'Excellent',
    votes: {},
    words: [],
    ratings: [],
    responses: [],
    rows: [],
    columns: [],
    rowHeader: '',
    instructions: '',
    footnote: '',
    grids: [],
  };
  if (type === 'multiple_choice') {
    const opts = Array.isArray(def.options) ? def.options : [];
    poll.options = opts
      .map((t) => clean(t, 120))
      .filter(Boolean)
      .slice(0, 12)
      .map((t) => ({ id: id(), text: t }));
    if (poll.options.length < 2) {
      poll.options = [
        { id: id(), text: 'Option 1' },
        { id: id(), text: 'Option 2' },
      ];
    }
    for (const o of poll.options) poll.votes[o.id] = 0;
  }
  if (type === 'rating') {
    const m = parseInt(def.scaleMax, 10);
    poll.scaleMax = m >= 2 && m <= 10 ? m : 5;
  }
  if (type === 'worksheet') {
    poll.rowHeader = clean(def.rowHeader, 120);
    poll.instructions = cleanMulti(def.instructions, 400);
    poll.footnote = cleanMulti(def.footnote, 400);
    // def.options as well as def.rows: the run-of-show importer already parses
    // '- bullet' lines into options, so worksheet rows come for free there.
    poll.rows = gridAxis(def.rows || def.options, 120, 6, 'r');
    poll.columns = gridAxis(def.columns, 160, 4, 'c');
    // Both axes empty is the "give me the shipped worksheet" shorthand. One axis
    // empty is a half-written definition, and substituting MFI's grid there would
    // publish rows the presenter never wrote under the title they did — so the
    // create endpoints reject that case before it reaches here.
    if (!poll.rows.length && !poll.columns.length) {
      poll.rowHeader = poll.rowHeader || MFI_WORKSHEET.rowHeader;
      poll.instructions = poll.instructions || MFI_WORKSHEET.instructions;
      poll.footnote = poll.footnote || MFI_WORKSHEET.footnote;
      poll.rows = gridAxis(MFI_WORKSHEET.rows, 120, 6, 'r');
      poll.columns = gridAxis(MFI_WORKSHEET.columns, 160, 4, 'c');
      if (!clean(def.question, 200)) poll.question = MFI_WORKSHEET.title;
    }
  }
  return poll;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return notFound(res);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// Request router
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  // --- Health check (App Platform / load balancer) ---------------------
  if (url.pathname === '/healthz') {
    // ?stats — live memory / fan-out counters for the load test. The plain
    // probe stays a bare 'ok' so the platform check is unaffected.
    if (url.searchParams.has('stats')) {
      const mem = process.memoryUsage();
      const mb = (b) => Math.round((b / 1048576) * 10) / 10;
      let sse = 0;
      let bufferedBytes = 0;
      for (const set of clients.values()) {
        for (const r of set) { sse++; bufferedBytes += r.writableLength || 0; }
      }
      const ocr = aiQueueDepth('ocr');
      const inter = aiQueueDepth('interactive');
      return send(res, 200, {
        rssMB: mb(mem.rss),
        heapMB: mb(mem.heapUsed),
        sse,
        bufferedBytes,
        rooms: Object.keys(rooms).length,
        dirty: dirty.size,
        saving: saving.size,
        aiRunning: ocr.running + inter.running,
        aiWaiting: ocr.waiting + inter.waiting,
        bodyInFlight,
      });
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // --- Page routes -----------------------------------------------------
  if (req.method === 'GET') {
    if (url.pathname === '/' || url.pathname === '') {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (parts[0] === 'present' && parts[1]) {
      return serveFile(res, path.join(PUBLIC_DIR, 'present.html'));
    }
    if (parts[0] === 'dashboard') {
      return serveFile(res, path.join(PUBLIC_DIR, 'dashboard.html'));
    }
    if ((parts[0] === 'join' || parts[0] === 'r') && parts[1]) {
      return serveFile(res, path.join(PUBLIC_DIR, 'join.html'));
    }
    if (parts[0] === 'static' && parts[1]) {
      const safe = path.normalize(parts.slice(1).join('/')).replace(/^(\.\.[/\\])+/, '');
      return serveFile(res, path.join(PUBLIC_DIR, safe));
    }
  }

  // --- API -------------------------------------------------------------
  if (parts[0] === 'api') {
    try {
      return await handleApi(req, res, parts.slice(1), url);
    } catch (e) {
      return sendApiError(res, e);
    }
  }

  return notFound(res);
});

async function handleApi(req, res, seg, url) {
  // POST /api/room                       -> create room (optionally preloaded)
  if (seg[0] === 'room' && seg.length === 1 && req.method === 'POST') {
    const body = await readBody(req);
    const code = newCode();
    let polls = [];
    if (Array.isArray(body.polls)) {
      const defs = body.polls.slice(0, 100);
      if (defs.some(halfWorksheet)) return send(res, 400, WORKSHEET_AXES_ERROR);
      polls = defs.map((d) => makePoll(d));
    } else if (body.agenda && agendas[String(body.agenda).toLowerCase()]) {
      polls = agendas[String(body.agenda).toLowerCase()].polls.map((d) => makePoll(d));
    }
    rooms[code] = {
      code,
      title: clean(body.title, 120) || 'Untitled session',
      createdAt: now(),
      polls,
      activePollId: null,
      questions: [],
    };
    save(code);
    return send(res, 200, { code });
  }

  // ---- Agenda templates (reusable run of show, not room-scoped) --------
  if (seg[0] === 'agendas' && req.method === 'GET') {
    return send(res, 200, {
      agendas: Object.values(agendas).map((a) => ({ name: a.name, count: a.polls.length })),
    });
  }
  if (seg[0] === 'agenda' && seg[1] && req.method === 'GET') {
    const a = agendas[decodeURIComponent(seg[1]).toLowerCase()];
    if (!a) return notFound(res);
    return send(res, 200, a);
  }
  if (seg[0] === 'agenda' && seg.length === 1 && req.method === 'POST') {
    const body = await readBody(req);
    const name = clean(body.name, 80);
    if (!name) return send(res, 400, { error: 'name_required' });
    let polls = Array.isArray(body.polls) ? body.polls : null;
    // Or snapshot an existing room's polls by code
    if (!polls && body.fromRoom && rooms[String(body.fromRoom).toUpperCase()]) {
      polls = pollsToDefs(rooms[String(body.fromRoom).toUpperCase()].polls);
    }
    if (!polls || !polls.length) return send(res, 400, { error: 'no_polls' });
    if (polls.some(halfWorksheet)) return send(res, 400, WORKSHEET_AXES_ERROR);
    // sanitize through makePoll then back to defs so stored data is clean
    const defs = pollsToDefs(polls.map((d) => makePoll(d)));
    const key = name.toLowerCase();
    agendas[key] = { name, polls: defs, savedAt: now() };
    saveAgenda(key);
    return send(res, 200, { ok: true, name, count: defs.length });
  }
  if (seg[0] === 'agenda' && seg[1] && seg[2] === 'delete' && req.method === 'POST') {
    const key = decodeURIComponent(seg[1]).toLowerCase();
    delete agendas[key];
    deleteAgenda(key);
    return send(res, 200, { ok: true });
  }

  // ---- Analytics / export (cross-event dashboard + per-event CSV) ------
  if (seg[0] === 'analytics' && seg.length === 1 && req.method === 'GET') {
    return send(res, 200, await analyticsList());
  }
  if (seg[0] === 'analytics' && seg[1] && req.method === 'GET') {
    const detail = await fetchRoomDetail(seg[1].toUpperCase());
    if (!detail) return notFound(res);
    return send(res, 200, detail);
  }
  if (seg[0] === 'room' && seg[2] === 'export.csv' && req.method === 'GET') {
    const detail = await fetchRoomDetail((seg[1] || '').toUpperCase());
    if (!detail) return notFound(res);
    const csv = '﻿' + toCSV(detail); // BOM so Excel reads UTF-8
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="exco-live-${detail.code}.csv"`,
      'Cache-Control': 'no-store',
    });
    return res.end(csv);
  }

  // ---- AI (Claude) — draft poll, cross-event trends, per-event debrief ---
  if (seg[0] === 'ai' && seg[1] === 'draft-poll' && req.method === 'POST') {
    if (!AI_ENABLED) return send(res, 503, { error: 'ai_not_configured' });
    const body = await readBody(req);
    const topic = clean(body.topic, 400);
    if (!topic) return send(res, 400, { error: 'topic_required' });
    return send(res, 200, await aiDraftPoll(topic, body.type));
  }
  if (seg[0] === 'ai' && seg[1] === 'trends' && req.method === 'POST') {
    if (!AI_ENABLED) return send(res, 503, { error: 'ai_not_configured' });
    const { sessions } = await analyticsList();
    // Filter before slicing. The list is created_at.desc, so slicing first can fill
    // the cap with 25 empty sessions and drop every session that actually holds
    // answers — after paying for 25 detail round-trips to find that out.
    const answered = sessions.filter((s) => s.responses > 0 || s.questions > 0);
    if (answered.length < 2) return send(res, 200, insufficientTrends(sessions.length, answered.length));
    const recent = answered.slice(0, 25).reverse(); // oldest→newest, cap for token budget
    const details = (await Promise.all(recent.map((s) => fetchRoomDetail(s.code)))).filter(Boolean);
    // Second gate against the raw arrays: the counts above come from the stored
    // total_votes column, which a half-finished write-through can overstate.
    const withData = details.filter((d) => responseStats(d).hasData);
    if (withData.length < 2) return send(res, 200, insufficientTrends(sessions.length, withData.length));
    try { return send(res, 200, await aiTrends(withData, sessions.length)); }
    catch (e) { return sendAiError(res, e); }
  }
  if (seg[0] === 'room' && seg[2] === 'ai' && seg[3] === 'debrief' && req.method === 'POST') {
    if (!AI_ENABLED) return send(res, 503, { error: 'ai_not_configured' });
    const detail = await fetchRoomDetail((seg[1] || '').toUpperCase());
    if (!detail) return notFound(res);
    // Never ask the model about a session with nothing in it. Structured outputs
    // require every field, so it cannot answer "no data" — it answers with fiction.
    const st = responseStats(detail);
    if (!st.hasData) return send(res, 200, insufficientDebrief(st));
    try { return send(res, 200, await aiDebrief(detail)); }
    catch (e) { return sendAiError(res, e); }
  }

  // Everything below is scoped to a room code at seg[1]
  const code = (seg[1] || '').toUpperCase();
  const room = rooms[code];

  // GET /api/room/:code
  if (seg[0] === 'room' && seg[2] === undefined && req.method === 'GET') {
    if (!room) return notFound(res);
    return send(res, 200, publicRoom(room));
  }

  // GET /api/room/:code/poll/:id/worksheet — the bodies, on demand. They are kept
  // out of every broadcast frame, so the presenter fetches them when a panel opens.
  if (seg[0] === 'room' && seg[2] === 'poll' && seg[4] === 'worksheet' && req.method === 'GET') {
    if (!room) return notFound(res);
    const p = room.polls.find((x) => x.id === seg[3]);
    if (!p || p.type !== 'worksheet') return notFound(res);
    return send(res, 200, { rows: p.rows, columns: p.columns, grids: p.grids });
  }

  // GET /api/stream/:code   (SSE)
  if (seg[0] === 'stream' && req.method === 'GET') {
    if (!room) return notFound(res);
    // Default to the participant view, so an unknown or spoofed client gets the
    // small private payload rather than every response in the room.
    res.lpView = url.searchParams.get('view') === 'stage' ? 'stage' : 'join';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',   // no proxy in front of us may buffer the stream
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(res.lpView === 'stage' ? publicRoom(room) : participantRoom(room))}\n\n`);

    if (!clients.has(code)) clients.set(code, new Set());
    clients.get(code).add(res);
    // write-after-end is reported asynchronously as an 'error' event, not thrown,
    // so no try/catch can see it — unhandled it kills the process and every other
    // live session on the box.
    res.on('error', () => {});

    const keepAlive = setInterval(() => {
      // A client too far behind to drain never fires 'close' after endStreams()
      // ends it, so this interval would go on pinging a finished response.
      if (res.writableEnded || res.destroyed) { clearInterval(keepAlive); return; }
      try {
        if (res.writableLength > (1 << 20)) return;   // same cap as writeSse
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      const set = clients.get(code);
      if (set) set.delete(res);
    });
    return;
  }

  // POST /api/room/:code/end — end a live session: archive it (keep the data
  // for analytics), tell joiners it's over, and drop it from the live layer.
  if (seg[0] === 'room' && seg[2] === 'end' && req.method === 'POST') {
    if (!room) return notFound(res);
    await flushRoom(code);   // land the last batch first — dropping it lost up to 54 submissions
    cancelSave(code);        // then stop anything further racing the archive
    if (SB_ENABLED) {
      try { await sb('PATCH', `/rooms?code=eq.${code}`, { body: { ended_at: iso() }, prefer: 'return=minimal' }); }
      catch (e) { console.error('end session persist failed:', e.message); }
    }
    cancelBroadcast(code);
    endStreams(code);
    delete rooms[code];
    sentRows.delete(code);
    // Again, last: a submission that landed during the PATCH would re-arm a
    // flush for a room that no longer exists, which persistRoom reads as
    // "deleted" and would take the archive down with it.
    cancelSave(code);
    return send(res, 200, { ok: true });
  }

  // POST /api/room/:code/delete — permanently remove a session and its data.
  // Works whether the session is live (in memory) or archived (Supabase only).
  if (seg[0] === 'room' && seg[2] === 'delete' && req.method === 'POST') {
    cancelSave(code);   // no flush — the rows are about to be cascade-deleted
    cancelBroadcast(code);
    endStreams(code);
    // Drop the room BEFORE awaiting the cascade: an in-flight persistRoom()
    // checks rooms[code], so leaving it there for the length of the round-trip
    // lets it write polls back in after the cascade has cleared them.
    delete rooms[code];
    sentRows.delete(code);
    if (SB_ENABLED) {
      try { await sb('DELETE', `/rooms?code=eq.${code}`); } // cascade clears polls/questions
      catch (e) { console.error('delete session failed:', e.message); }
    }
    return send(res, 200, { ok: true });
  }

  if (!room && seg[0] === 'room') return notFound(res);

  // POST /api/room/:code/...   (mutations)
  if (seg[0] === 'room' && room && req.method === 'POST') {
    const action = seg[2];
    const body = await readBody(req);
    // A phone's body can land seconds after its headers on venue wifi — long
    // enough for /end or /delete to have torn the room down. `room` is then an
    // orphan and every mutation below would be written to nothing.
    if (!rooms[code]) return notFound(res);

    // ---- AI: cluster & summarize the Q&A board ----------------------
    if (action === 'ai' && seg[3] === 'qa') {
      if (!AI_ENABLED) return send(res, 503, { error: 'ai_not_configured' });
      try { return send(res, 200, await aiQaClusters(room)); }
      catch (e) { return sendAiError(res, e); }
    }

    // ---- Poll management (presenter) --------------------------------
    if (action === 'poll' && seg[3] === undefined) {
      if (halfWorksheet(body)) return send(res, 400, WORKSHEET_AXES_ERROR);
      const poll = makePoll(body);
      room.polls.push(poll);
      save(code);
      broadcast(code, true);
      return send(res, 200, { id: poll.id });
    }

    // Bulk preload — create many polls at once (run of show). Optionally replace existing drafts.
    if (action === 'polls' && seg[3] === undefined) {
      const defs = Array.isArray(body.polls) ? body.polls.slice(0, 100) : [];
      // Before `replace` drops the existing drafts: a rejected import must leave
      // the run of show exactly as it was.
      if (defs.some(halfWorksheet)) return send(res, 400, WORKSHEET_AXES_ERROR);
      if (body.replace) {
        // keep any poll that already has responses; drop untouched drafts
        room.polls = room.polls.filter((p) => totalVotes(p) > 0);
        room.activePollId = null;
      }
      const created = defs.map((d) => makePoll(d));
      room.polls.push(...created);
      save(code);
      broadcast(code, true);
      return send(res, 200, { ids: created.map((p) => p.id), count: created.length });
    }

    // Load a saved agenda template into this room (append its polls).
    if (action === 'load-agenda' && seg[3] === undefined) {
      const name = clean(body.name, 80);
      const ag = agendas[name.toLowerCase()];
      if (!ag) return send(res, 404, { error: 'agenda_not_found' });
      const created = ag.polls.map((d) => makePoll(d));
      room.polls.push(...created);
      save(code);
      broadcast(code, true);
      return send(res, 200, { count: created.length });
    }

    const poll = room.polls.find((p) => p.id === seg[3]);

    if (action === 'poll' && seg[3] && poll) {
      const op = seg[4];

      // AI: synthesize open-text / word-cloud responses for this poll
      if (op === 'ai' && seg[5] === 'synthesize') {
        if (!AI_ENABLED) return send(res, 503, { error: 'ai_not_configured' });
        try { return send(res, 200, await aiSynthesize(poll)); }
        catch (e) { return sendAiError(res, e); }
      }

      // activate — makes this the live poll
      if (op === 'activate') {
        for (const p of room.polls) if (p.state === 'active') p.state = 'closed';
        poll.state = 'active';
        room.activePollId = poll.id;
        save(code);
        broadcast(code, true);
        return send(res, 200, { ok: true });
      }
      if (op === 'close') {
        poll.state = 'closed';
        if (room.activePollId === poll.id) room.activePollId = null;
        save(code);
        broadcast(code, true);
        return send(res, 200, { ok: true });
      }
      if (op === 'delete') {
        room.polls = room.polls.filter((p) => p.id !== poll.id);
        if (room.activePollId === poll.id) room.activePollId = null;
        save(code);
        broadcast(code, true);
        return send(res, 200, { ok: true });
      }
      if (op === 'move') {
        const i = room.polls.findIndex((p) => p.id === poll.id);
        const j = body.dir === 'up' ? i - 1 : i + 1;
        if (i >= 0 && j >= 0 && j < room.polls.length) {
          [room.polls[i], room.polls[j]] = [room.polls[j], room.polls[i]];
          save(code);
          broadcast(code, true);
        }
        return send(res, 200, { ok: true });
      }
      if (op === 'reset') {
        poll.votes = {};
        for (const o of poll.options) poll.votes[o.id] = 0;
        poll.words = [];
        poll.ratings = [];
        poll.responses = [];
        poll.grids = [];
        save(code);
        broadcast(code, true);
        return send(res, 200, { ok: true });
      }

      // ---- Participant submissions --------------------------------
      // Only allow submissions to the active poll.
      if (poll.state !== 'active') return send(res, 409, { error: 'poll_not_active' });

      if (op === 'vote' && poll.type === 'multiple_choice') {
        if (applied(poll, clean(body.sid, 64))) return send(res, 200, { ok: true, duplicate: true });
        if (Object.prototype.hasOwnProperty.call(poll.votes, body.optionId)) {
          poll.votes[body.optionId]++;
          save(code);
          broadcast(code);
          return send(res, 200, { ok: true });
        }
        return send(res, 400, { error: 'bad_option' });
      }
      if (op === 'word' && poll.type === 'word_cloud') {
        if (applied(poll, clean(body.sid, 64))) return send(res, 200, { ok: true, duplicate: true });
        const words = clean(body.text, 60)
          .split(/[\s,]+/)
          .map((w) => w.trim())
          .filter(Boolean)
          .slice(0, 5);
        for (const w of words) poll.words.push(w);
        if (poll.words.length > 5000) poll.words = poll.words.slice(-5000);
        save(code);
        broadcast(code);
        return send(res, 200, { ok: true });
      }
      if (op === 'rate' && poll.type === 'rating') {
        if (applied(poll, clean(body.sid, 64))) return send(res, 200, { ok: true, duplicate: true });
        const v = parseInt(body.value, 10);
        if (v >= 1 && v <= poll.scaleMax) {
          poll.ratings.push(v);
          save(code);
          broadcast(code);
          return send(res, 200, { ok: true });
        }
        return send(res, 400, { error: 'bad_value' });
      }
      if (op === 'text' && poll.type === 'open_text') {
        if (applied(poll, clean(body.sid, 64))) return send(res, 200, { ok: true, duplicate: true });
        const t = clean(body.text, 280);
        if (t) {
          poll.responses.push({ id: id(), text: t, ts: now(), author: clean(body.author, 40) });
          if (poll.responses.length > 2000) poll.responses = poll.responses.slice(-2000);
          save(code);
          broadcast(code);
          return send(res, 200, { ok: true });
        }
        return send(res, 400, { error: 'empty' });
      }
      if (op === 'worksheet' && poll.type === 'worksheet') {
        if (applied(poll, clean(body.sid, 64))) return send(res, 200, { ok: true, duplicate: true });
        const src = (body.cells && typeof body.cells === 'object') ? body.cells : {};
        // Keys are built from this poll's own axes, so a key from a stale draft
        // (or anything else) is dropped rather than stored under a cell that no
        // longer exists.
        const cells = {};
        for (const r of poll.rows) {
          for (const c of poll.columns) {
            const t = cleanMulti(src[r.id + c.id], 400);
            if (t) cells[r.id + c.id] = t;
          }
        }
        if (!Object.keys(cells).length) return send(res, 400, { error: 'empty' });
        poll.grids.push({ id: id(), ts: now(), author: clean(body.author, 40), source: 'typed', cells });
        if (poll.grids.length > 500) poll.grids = poll.grids.slice(-500);
        save(code);
        broadcast(code);
        return send(res, 200, { ok: true });
      }
    }

    // ---- Q&A board --------------------------------------------------
    if (action === 'question' && seg[3] === undefined) {
      if (applied(room, clean(body.sid, 64))) return send(res, 200, { ok: true, duplicate: true });
      const text = clean(body.text, 280);
      if (!text) return send(res, 400, { error: 'empty' });
      room.questions.push({ id: id(), text, votes: 0, voters: new Set(), ts: now(), author: clean(body.author, 40) });
      save(code);
      broadcast(code);
      return send(res, 200, { ok: true });
    }
    if (action === 'question' && seg[3]) {
      const q = room.questions.find((x) => x.id === seg[3]);
      if (!q) return notFound(res);
      if (seg[4] === 'upvote') {
        const voter = clean(body.voter, 40) || 'anon';
        if (!q.voters.has(voter)) {
          q.voters.add(voter);
          q.votes++;
          save(code);
          broadcast(code);
        }
        return send(res, 200, { ok: true });
      }
      if (seg[4] === 'delete') {
        room.questions = room.questions.filter((x) => x.id !== q.id);
        save(code);
        broadcast(code, true);
        return send(res, 200, { ok: true });
      }
    }
  }

  return notFound(res);
}

// Node closes idle keep-alive sockets at 5s while DigitalOcean's router holds
// them longer, so DO reuses a socket Node has just closed and returns
// intermittent 502s — exactly when 100 phones fire short POSTs over reused
// sockets. requestTimeout is deliberately left alone: it does not affect SSE
// (its timer clears once the request is received).
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

// A redeploy must not drop the last unflushed batch of submissions.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close();
    flushAll().finally(() => process.exit(0));
  });
}

// save() and broadcast() are fire-and-forget from request handlers; a rejected
// one must be logged, not fatal.
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', (e && e.message) || e));

// Load persisted state (if any), then start serving. `.finally` ensures the
// server still comes up even if Supabase is unreachable at boot.
load().finally(() => {
  server.listen(PORT, () => {
    console.log(`\n  Live Polls running:  http://localhost:${PORT}\n`);
  });
});
