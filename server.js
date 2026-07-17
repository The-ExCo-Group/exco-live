// Live Polls — bespoke interactive polling server (Slido/Mentimeter-style)
// Zero dependencies. Node built-in HTTP + Server-Sent Events for real-time push.
//
// Run:  node server.js         (defaults to port 3000)
//       PORT=8080 node server.js

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// DATA_DIR lets the host point persistence at a writable/mounted path.
// Defaults to the app dir. NOTE: on DigitalOcean App Platform the container
// filesystem is ephemeral (state resets on redeploy/restart) — fine for
// per-event sessions; use a managed DB/Spaces if agendas must survive redeploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

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
const AGENDA_FILE = path.join(DATA_DIR, 'agendas.json');
const agendas = Object.create(null);

// ---------------------------------------------------------------------------
// Persistence (best-effort, prototype-grade)
// ---------------------------------------------------------------------------
function serialize() {
  const out = {};
  for (const code of Object.keys(rooms)) {
    const r = rooms[code];
    out[code] = {
      ...r,
      questions: r.questions.map((q) => ({ ...q, voters: [...q.voters] })),
    };
  }
  return JSON.stringify(out);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, serialize(), () => {});
  }, 150);
}

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    for (const code of Object.keys(parsed)) {
      const r = parsed[code];
      r.questions = (r.questions || []).map((q) => ({
        ...q,
        voters: new Set(q.voters || []),
      }));
      rooms[code] = r;
    }
    console.log(`Loaded ${Object.keys(rooms).length} room(s) from disk.`);
  } catch {
    /* no data file yet */
  }
}

function saveAgendas() {
  fs.writeFile(AGENDA_FILE, JSON.stringify(agendas), () => {});
}
function loadAgendas() {
  try {
    const parsed = JSON.parse(fs.readFileSync(AGENDA_FILE, 'utf8'));
    for (const k of Object.keys(parsed)) agendas[k] = parsed[k];
    console.log(`Loaded ${Object.keys(agendas).length} agenda template(s).`);
  } catch {
    /* none yet */
  }
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
      .map((q) => ({ id: q.id, text: q.text, votes: q.votes, ts: q.ts }))
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
    save();
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
    agendas[name.toLowerCase()] = { name, polls: defs, savedAt: now() };
    saveAgendas();
    return send(res, 200, { ok: true, name, count: defs.length });
  }
  if (seg[0] === 'agenda' && seg[1] && seg[2] === 'delete' && req.method === 'POST') {
    delete agendas[decodeURIComponent(seg[1]).toLowerCase()];
    saveAgendas();
    return send(res, 200, { ok: true });
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

  if (!room && seg[0] === 'room') return notFound(res);

  // POST /api/room/:code/...   (mutations)
  if (seg[0] === 'room' && room && req.method === 'POST') {
    const action = seg[2];
    const body = await readBody(req);

    // ---- Poll management (presenter) --------------------------------
    if (action === 'poll' && seg[3] === undefined) {
      const poll = makePoll(body);
      room.polls.push(poll);
      save();
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
      save();
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
      save();
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
        save();
        broadcast(code);
        return send(res, 200, { ok: true });
      }
      if (op === 'close') {
        poll.state = 'closed';
        if (room.activePollId === poll.id) room.activePollId = null;
        save();
        broadcast(code);
        return send(res, 200, { ok: true });
      }
      if (op === 'delete') {
        room.polls = room.polls.filter((p) => p.id !== poll.id);
        if (room.activePollId === poll.id) room.activePollId = null;
        save();
        broadcast(code);
        return send(res, 200, { ok: true });
      }
      if (op === 'move') {
        const i = room.polls.findIndex((p) => p.id === poll.id);
        const j = body.dir === 'up' ? i - 1 : i + 1;
        if (i >= 0 && j >= 0 && j < room.polls.length) {
          [room.polls[i], room.polls[j]] = [room.polls[j], room.polls[i]];
          save();
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
        save();
        broadcast(code);
        return send(res, 200, { ok: true });
      }

      // ---- Participant submissions --------------------------------
      // Only allow submissions to the active poll.
      if (poll.state !== 'active') return send(res, 409, { error: 'poll_not_active' });

      if (op === 'vote' && poll.type === 'multiple_choice') {
        if (Object.prototype.hasOwnProperty.call(poll.votes, body.optionId)) {
          poll.votes[body.optionId]++;
          save();
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
        save();
        broadcast(code);
        return send(res, 200, { ok: true });
      }
      if (op === 'rate' && poll.type === 'rating') {
        const v = parseInt(body.value, 10);
        if (v >= 1 && v <= poll.scaleMax) {
          poll.ratings.push(v);
          save();
          broadcast(code);
          return send(res, 200, { ok: true });
        }
        return send(res, 400, { error: 'bad_value' });
      }
      if (op === 'text' && poll.type === 'open_text') {
        const t = clean(body.text, 280);
        if (t) {
          poll.responses.push({ id: id(), text: t, ts: now() });
          if (poll.responses.length > 2000) poll.responses = poll.responses.slice(-2000);
          save();
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
      room.questions.push({ id: id(), text, votes: 0, voters: new Set(), ts: now() });
      save();
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
          save();
          broadcast(code);
        }
        return send(res, 200, { ok: true });
      }
      if (seg[4] === 'delete') {
        room.questions = room.questions.filter((x) => x.id !== q.id);
        save();
        broadcast(code);
        return send(res, 200, { ok: true });
      }
    }
  }

  return notFound(res);
}

load();
loadAgendas();
server.listen(PORT, () => {
  console.log(`\n  Live Polls running:  http://localhost:${PORT}\n`);
});
