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

// Write one room's full state through to Supabase (upsert rows, prune removals).
async function persistRoom(code) {
  const r = rooms[code];
  if (!r) {
    // Room gone from memory — remove it (ON DELETE CASCADE clears children).
    await sb('DELETE', `/rooms?code=eq.${code}`);
    return;
  }
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

  if (r.polls.length) {
    await sb('POST', '/polls', {
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: r.polls.map((p, i) => ({
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
        total_votes: totalVotes(p),
      })),
    });
  }
  const pollIds = r.polls.map((p) => p.id);
  await sb('DELETE', `/polls?room_code=eq.${code}` + (pollIds.length ? `&id=not.in.${inList(pollIds)}` : ''));

  if (r.questions.length) {
    await sb('POST', '/questions', {
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: r.questions.map((q) => ({
        id: q.id,
        room_code: code,
        text: q.text,
        votes: q.votes,
        voters: [...q.voters],
        ts: q.ts,
        author: q.author || null,
      })),
    });
  }
  const qIds = r.questions.map((q) => q.id);
  await sb('DELETE', `/questions?room_code=eq.${code}` + (qIds.length ? `&id=not.in.${inList(qIds)}` : ''));
}

// Debounced, per-room write-through. Fire-and-forget from request handlers.
const dirty = new Set();
let saveTimer = null;
function save(code) {
  if (!SB_ENABLED) return;
  if (code) dirty.add(code);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 150);
}
async function flush() {
  const codes = [...dirty];
  dirty.clear();
  for (const code of codes) {
    try { await persistRoom(code); }
    catch (e) { console.error('persist room', code, 'failed:', e.message); }
  }
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
    const [roomRows, pollRows, qRows, agRows] = await Promise.all([
      sb('GET', '/rooms?select=*'),
      sb('GET', '/polls?select=*&order=room_code,position'),
      sb('GET', '/questions?select=*&order=ts'),
      sb('GET', '/agendas?select=*'),
    ]);
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
    for (const p of pollRows || []) {
      const r = rooms[p.room_code];
      if (!r) continue;
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
  const header = ['session', 'code', 'date', 'poll', 'type', 'question', 'answer', 'count', 'percent', 'author'];
  const rows = [header];
  const date = (d.createdAt || '').slice(0, 10);
  const add = (poll, type, question, answer, count, percent, author) =>
    rows.push([d.title, d.code, date, poll, type, question, answer, count, percent, author || '']);

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
      const freq = {};
      p.words.forEach((w) => { const k = w.toLowerCase(); freq[k] = (freq[k] || 0) + 1; });
      Object.entries(freq).sort((a, b) => b[1] - a[1]).forEach(([w, c]) => add(n, p.type, p.question, w, c, ''));
    } else if (p.type === 'open_text') {
      p.responses.forEach((r) => add(n, p.type, p.question, r.text, 1, '', r.author));
    }
  });
  d.questions.forEach((q) => add('', 'qa', 'Audience Q&A', q.text, q.votes, '', q.author));
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
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
  }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
function newCode(len = 5) {
  let code;
  do {
    code = '';
    const bytes = crypto.randomBytes(len);
    for (let i = 0; i < len; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  } while (rooms[code]);
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
      totalVotes: totalVotes(p),
    })),
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
  return 0;
}

function broadcast(code) {
  const set = clients.get(code);
  if (!set || set.size === 0) return;
  const payload = `data: ${JSON.stringify(publicRoom(rooms[code]))}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      /* dead connection cleaned up on close */
    }
  }
}

// Tell everyone watching a room that it has ended, then close their streams.
function endStreams(code) {
  const set = clients.get(code);
  if (!set) return;
  for (const res of set) {
    try {
      res.write(`data: ${JSON.stringify({ ended: true })}\n\n`);
      res.end();
    } catch {
      /* ignore */
    }
  }
  clients.delete(code);
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function notFound(res) {
  send(res, 404, { error: 'not_found' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function clean(str, max = 280) {
  return String(str == null ? '' : str)
    .replace(/[\x00-\x1f\x7f]/g, ' ') // strip control chars
    .trim()
    .slice(0, max);
}

// Build a validated poll object from a raw definition (used by single + bulk create).
function makePoll(def) {
  def = def || {};
  const type = ['multiple_choice', 'word_cloud', 'rating', 'open_text'].includes(def.type)
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
      return send(res, 500, { error: 'server_error', message: e.message });
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
    if (Array.isArray(body.polls)) polls = body.polls.slice(0, 100).map((d) => makePoll(d));
    else if (body.agenda && agendas[String(body.agenda).toLowerCase()]) {
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

  // Everything below is scoped to a room code at seg[1]
  const code = (seg[1] || '').toUpperCase();
  const room = rooms[code];

  // GET /api/room/:code
  if (seg[0] === 'room' && seg[2] === undefined && req.method === 'GET') {
    if (!room) return notFound(res);
    return send(res, 200, publicRoom(room));
  }

  // GET /api/stream/:code   (SSE)
  if (seg[0] === 'stream' && req.method === 'GET') {
    if (!room) return notFound(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify(publicRoom(room))}\n\n`);

    if (!clients.has(code)) clients.set(code, new Set());
    clients.get(code).add(res);

    const keepAlive = setInterval(() => {
      try {
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
    dirty.delete(code); // cancel any pending write-through (would race the archive)
    if (SB_ENABLED) {
      try { await sb('PATCH', `/rooms?code=eq.${code}`, { body: { ended_at: iso() }, prefer: 'return=minimal' }); }
      catch (e) { console.error('end session persist failed:', e.message); }
    }
    endStreams(code);
    delete rooms[code];
    return send(res, 200, { ok: true });
  }

  // POST /api/room/:code/delete — permanently remove a session and its data.
  // Works whether the session is live (in memory) or archived (Supabase only).
  if (seg[0] === 'room' && seg[2] === 'delete' && req.method === 'POST') {
    dirty.delete(code);
    if (SB_ENABLED) {
      try { await sb('DELETE', `/rooms?code=eq.${code}`); } // cascade clears polls/questions
      catch (e) { console.error('delete session failed:', e.message); }
    }
    endStreams(code);
    delete rooms[code];
    return send(res, 200, { ok: true });
  }

  if (!room && seg[0] === 'room') return notFound(res);

  // POST /api/room/:code/...   (mutations)
  if (seg[0] === 'room' && room && req.method === 'POST') {
    const action = seg[2];
    const body = await readBody(req);

    // ---- Poll management (presenter) --------------------------------
    if (action === 'poll' && seg[3] === undefined) {
      const poll = makePoll(body);
      room.polls.push(poll);
      save(code);
      broadcast(code);
      return send(res, 200, { id: poll.id });
    }

    // Bulk preload — create many polls at once (run of show). Optionally replace existing drafts.
    if (action === 'polls' && seg[3] === undefined) {
      const defs = Array.isArray(body.polls) ? body.polls.slice(0, 100) : [];
      if (body.replace) {
        // keep any poll that already has responses; drop untouched drafts
        room.polls = room.polls.filter((p) => totalVotes(p) > 0);
        room.activePollId = null;
      }
      const created = defs.map((d) => makePoll(d));
      room.polls.push(...created);
      save(code);
      broadcast(code);
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
      broadcast(code);
      return send(res, 200, { count: created.length });
    }

    const poll = room.polls.find((p) => p.id === seg[3]);

    if (action === 'poll' && seg[3] && poll) {
      const op = seg[4];

      // activate — makes this the live poll
      if (op === 'activate') {
        for (const p of room.polls) if (p.state === 'active') p.state = 'closed';
        poll.state = 'active';
        room.activePollId = poll.id;
        save(code);
        broadcast(code);
        return send(res, 200, { ok: true });
      }
      if (op === 'close') {
        poll.state = 'closed';
        if (room.activePollId === poll.id) room.activePollId = null;
        save(code);
        broadcast(code);
        return send(res, 200, { ok: true });
      }
      if (op === 'delete') {
        room.polls = room.polls.filter((p) => p.id !== poll.id);
        if (room.activePollId === poll.id) room.activePollId = null;
        save(code);
        broadcast(code);
        return send(res, 200, { ok: true });
      }
      if (op === 'move') {
        const i = room.polls.findIndex((p) => p.id === poll.id);
        const j = body.dir === 'up' ? i - 1 : i + 1;
        if (i >= 0 && j >= 0 && j < room.polls.length) {
          [room.polls[i], room.polls[j]] = [room.polls[j], room.polls[i]];
          save(code);
          broadcast(code);
        }
        return send(res, 200, { ok: true });
      }
      if (op === 'reset') {
        poll.votes = {};
        for (const o of poll.options) poll.votes[o.id] = 0;
        poll.words = [];
        poll.ratings = [];
        poll.responses = [];
        save(code);
        broadcast(code);
        return send(res, 200, { ok: true });
      }

      // ---- Participant submissions --------------------------------
      // Only allow submissions to the active poll.
      if (poll.state !== 'active') return send(res, 409, { error: 'poll_not_active' });

      if (op === 'vote' && poll.type === 'multiple_choice') {
        if (Object.prototype.hasOwnProperty.call(poll.votes, body.optionId)) {
          poll.votes[body.optionId]++;
          save(code);
          broadcast(code);
          return send(res, 200, { ok: true });
        }
        return send(res, 400, { error: 'bad_option' });
      }
      if (op === 'word' && poll.type === 'word_cloud') {
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
    }

    // ---- Q&A board --------------------------------------------------
    if (action === 'question' && seg[3] === undefined) {
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
        broadcast(code);
        return send(res, 200, { ok: true });
      }
    }
  }

  return notFound(res);
}

// Load persisted state (if any), then start serving. `.finally` ensures the
// server still comes up even if Supabase is unreachable at boot.
load().finally(() => {
  server.listen(PORT, () => {
    console.log(`\n  Live Polls running:  http://localhost:${PORT}\n`);
  });
});
