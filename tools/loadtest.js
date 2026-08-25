#!/usr/bin/env node
// Burst load test — proves ExCo Live survives N people answering simultaneously.
//
// Run:  node tools/loadtest.js [--host 127.0.0.1:3000] [--n 100] [--type open_text]
//       --type: open_text (default) | multiple_choice | rating | word_cloud
//
// Zero dependencies, http only — so the SSE client is hand-rolled below. Node
// has no EventSource and a polyfill is not worth a house-rule exemption.
// Exits 0 only if every criterion in the report passes.

'use strict';

const http = require('http');

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);

function flag(name, def) {
  const i = argv.indexOf('--' + name);
  if (i >= 0 && argv[i + 1] && argv[i + 1].slice(0, 2) !== '--') return argv[i + 1];
  const eq = argv.find((a) => a.indexOf('--' + name + '=') === 0);
  return eq ? eq.slice(name.length + 3) : def;
}

const TYPES = ['open_text', 'multiple_choice', 'rating', 'word_cloud'];
const HOSTFLAG = flag('host', '127.0.0.1:3000').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
const HOSTNAME = HOSTFLAG.split(':')[0] || '127.0.0.1';
const PORT = parseInt(HOSTFLAG.split(':')[1], 10) || 3000;
const N = Math.max(1, parseInt(flag('n', '100'), 10) || 100);
const TYPE = flag('type', 'open_text');

if (!TYPES.includes(TYPE)) {
  console.error(`unknown --type "${TYPE}" — expected one of: ${TYPES.join(', ')}`);
  process.exit(1);
}

const WAIT_MS = 1500; // long enough for the last coalesced broadcast tick

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
// TWO agents on purpose. Sharing one would park N idle SSE sockets in the pool
// and queue every POST behind them — the test would then measure the client's
// socket starvation instead of the server's throughput.
const sseAgent = new http.Agent({ maxSockets: N + 50, keepAlive: false });
const postAgent = new http.Agent({ maxSockets: N + 50, keepAlive: true, keepAliveMsecs: 10000 });

function req(method, path, body, agent) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = data
      ? { 'Content-Type': 'application/json', 'Content-Length': data.length }
      : {};
    const r = http.request({ host: HOSTNAME, port: PORT, method, path, agent, headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, text: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function json(r) {
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
}

// Hand-rolled EventSource: GET the stream, then cut the byte stream on '\n\n'.
// Frames are sliced as Buffers and only decoded when a caller wants the body —
// decoding every participant frame would make the harness the bottleneck on a
// server that has not been fixed yet.
function openStream(path, onFrame) {
  return new Promise((resolve, reject) => {
    const conn = { bytes: 0, frames: 0, req: null };
    const r = http.request(
      { host: HOSTNAME, port: PORT, method: 'GET', path, agent: sseAgent, headers: { Accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('stream returned ' + res.statusCode));
        }
        let pending = Buffer.alloc(0);
        res.on('data', (chunk) => {
          conn.bytes += chunk.length;
          pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          let i;
          while ((i = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.subarray(0, i);
            pending = pending.subarray(i + 2);
            // ': ping' comments and the opening 'retry:' line are not events
            if (frame.length < 6 || frame.subarray(0, 6).toString('latin1') !== 'data: ') continue;
            conn.frames++;
            if (onFrame) onFrame(frame);
          }
        });
        res.on('error', () => {}); // a killed stream at teardown is expected
        resolve(conn);
      }
    );
    r.on('error', reject);
    conn.req = r;
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------
// A real answer, not a token — payload size is part of what we are measuring.
const FILLER =
  'The thing that would most help my team next quarter is a clearer line from the strategy to the work we actually prioritise, and fewer competing initiatives so we can finish what we start and see the impact before the next reorganisation lands on us. ';

function realisticText(i) {
  return `[${i}] ${FILLER.repeat(3)}`.slice(0, 280).replace(/\s+$/, '');
}

// Single tokens only: the server pushes each whitespace-separated word onto the
// cloud, so a multi-word answer would inflate totalVotes past n.
const WORDS = ['clarity', 'pace', 'focus', 'trust', 'candour', 'alignment', 'energy', 'courage'];

let code = '';
let pollId = '';
let optionIds = [];

function pollDef() {
  const question = `Load test — ${TYPE} — ${N} at once`;
  if (TYPE === 'multiple_choice') return { type: TYPE, question, options: ['A', 'B', 'C', 'D'] };
  return { type: TYPE, question };
}

function submit(i) {
  const sid = 'load-' + i;
  const base = `/api/room/${code}/poll/${pollId}`;
  let path;
  let body;
  if (TYPE === 'multiple_choice') {
    path = base + '/vote';
    body = { sid, optionId: optionIds[i % optionIds.length] };
  } else if (TYPE === 'rating') {
    path = base + '/rate';
    body = { sid, value: (i % 5) + 1 };
  } else if (TYPE === 'word_cloud') {
    path = base + '/word';
    body = { sid, text: WORDS[i % WORDS.length] };
  } else {
    path = base + '/text';
    body = { sid, text: realisticText(i), author: 'Loadtest ' + i };
  }
  // Never reject: a connection error is a result we want in the distribution.
  return req('POST', path, body, postAgent).then(
    (r) => r.status,
    (e) => 'ERR ' + (e.code || e.message)
  );
}

// ---------------------------------------------------------------------------
// Stage stream — the visibility latency probe
// ---------------------------------------------------------------------------
let burstStart = 0;
let seenVotes = 0;
const latency = []; // ms from burst start to the frame that first showed each vote

function pollTotal(obj) {
  if (!obj || !Array.isArray(obj.polls)) return null;
  const p = obj.polls.find((x) => x && x.id === pollId);
  if (!p) return null;
  if (typeof p.totalVotes === 'number') return p.totalVotes;
  // Fall back to the raw arrays in case the stage payload drops the rollup.
  if (TYPE === 'multiple_choice' && p.votes) return Object.values(p.votes).reduce((a, b) => a + b, 0);
  if (TYPE === 'rating' && Array.isArray(p.ratings)) return p.ratings.length;
  if (TYPE === 'word_cloud' && Array.isArray(p.words)) return p.words.length;
  if (TYPE === 'open_text' && Array.isArray(p.responses)) return p.responses.length;
  return null;
}

function onStageFrame(frame) {
  let obj;
  try {
    obj = JSON.parse(frame.subarray(6).toString('utf8'));
  } catch {
    return;
  }
  const tv = pollTotal(obj);
  if (tv == null || tv <= seenVotes) return;
  const ms = burstStart ? Date.now() - burstStart : 0;
  // Coalescing means one frame can reveal many votes; each still waited `ms`.
  // Cap at N so a non-idempotent server's replay votes do not land here too —
  // that failure belongs to the totalVotes check, not to latency.
  for (let k = seenVotes; k < tv && latency.length < N; k++) latency.push(ms);
  seenVotes = tv;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const checks = [];

function check(label, value, criterion, ok) {
  checks.push({ label, value: String(value), criterion, ok });
}

function mb(bytes) {
  return (bytes / 1048576).toFixed(2) + ' MB';
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, i))];
}

function distribution(list) {
  const d = Object.create(null);
  for (const s of list) d[s] = (d[s] || 0) + 1;
  return '{ ' + Object.keys(d).map((k) => `${k}: ${d[k]}`).join(', ') + ' }';
}

function range(n) {
  return Array.from({ length: n }, (_, i) => i);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// /healthz?stats=1 is a newer contract; an older server answers plain 'ok'.
// Missing fields degrade to SKIP so the rest of the report still prints.
async function stats() {
  try {
    const o = json(await req('GET', '/healthz?stats=1', undefined, postAgent));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n  ExCo Live burst load test`);
  console.log(`  host ${HOSTNAME}:${PORT}   n ${N}   type ${TYPE}\n`);

  // --- Set up the room, the poll, and make it live ---------------------
  const room = json(await req('POST', '/api/room', { title: `Load test ${new Date().toISOString()}` }, postAgent));
  if (!room || !room.code) throw new Error('could not create a room — is the server running?');
  code = room.code;

  const created = json(await req('POST', `/api/room/${code}/poll`, pollDef(), postAgent));
  if (!created || !created.id) throw new Error('could not create the poll');
  pollId = created.id;

  await req('POST', `/api/room/${code}/poll/${pollId}/activate`, {}, postAgent);

  if (TYPE === 'multiple_choice') {
    // Option ids are server-assigned, so read them back before voting.
    const snap = json(await req('GET', `/api/room/${code}`, undefined, postAgent));
    const p = snap && snap.polls && snap.polls.find((x) => x.id === pollId);
    optionIds = p && p.options ? p.options.map((o) => o.id) : [];
    if (!optionIds.length) throw new Error('poll came back with no options');
  }

  console.log(`  room ${code}   poll ${pollId}`);

  // --- Open N participant streams + one stage stream -------------------
  const participants = [];
  for (const conn of await Promise.all(range(N).map(() => openStream(`/api/stream/${code}`)))) {
    participants.push(conn);
  }
  const stage = await openStream(`/api/stream/${code}?view=stage`, onStageFrame);
  console.log(`  streams open: ${participants.length} participant + 1 stage\n`);

  const before = await stats();

  // --- The burst: zero stagger ----------------------------------------
  burstStart = Date.now();
  const statuses = await Promise.all(range(N).map((i) => submit(i)));
  const burstMs = Date.now() - burstStart;

  // --- Replay with the SAME sids: idempotency --------------------------
  const replayN = Math.min(20, N);
  const replayStatuses = await Promise.all(range(replayN).map((i) => submit(i)));

  await sleep(WAIT_MS);

  const after = await stats();
  const snap = json(await req('GET', `/api/room/${code}`, undefined, postAgent));
  const serverPoll = snap && snap.polls && snap.polls.find((p) => p.id === pollId);
  const serverTotal = serverPoll ? serverPoll.totalVotes : null;

  // --- Criteria --------------------------------------------------------
  const okStatus = statuses.length === N && statuses.every((s) => s === 200);
  check('status distribution', distribution(statuses), `must be exactly { 200: ${N} }`, okStatus);

  check(
    'server totalVotes',
    serverTotal === null ? 'unavailable' : serverTotal,
    `must be exactly ${N}  (after ${replayN} duplicate sids were replayed)`,
    serverTotal === N
  );

  const partBytes = participants.reduce((a, c) => a + c.bytes, 0);
  check('bytes to N participants', mb(partBytes), 'must be < 10 MB  (was 1045 MB before the fix)', partBytes < 10 * 1048576);

  const frames = participants.map((c) => c.frames).sort((a, b) => a - b);
  const maxFrames = frames[frames.length - 1] || 0;
  check(
    'participant frame count',
    `min ${frames[0] || 0}  median ${pct(frames, 50)}  max ${maxFrames}`,
    `must be ~8-16, not ~${N}  (pass: max <= 32 and well under n — proves coalescing)`,
    maxFrames > 0 && maxFrames <= 32 && maxFrames < Math.max(4, N / 2)
  );

  const lat = latency.slice().sort((a, b) => a - b);
  const p95 = pct(lat, 95);
  check(
    'visibility latency p50/p95/max',
    lat.length ? `${pct(lat, 50)} / ${p95} / ${lat[lat.length - 1]} ms  (${lat.length} of ${N} votes seen)` : 'no votes seen on stage',
    'p95 must be < 300 ms',
    lat.length === N && p95 < 300
  );

  const buffered = typeof after.bufferedBytes === 'number' ? after.bufferedBytes : null;
  check(
    'bufferedBytes after burst',
    buffered === null ? 'not reported by /healthz?stats=1' : buffered + ' B',
    'must be ~0  (pass: < 100 KB — proves no backpressure accumulation)',
    buffered === null ? null : buffered < 100000
  );

  const rssOk = typeof before.rssMB === 'number' && typeof after.rssMB === 'number';
  check(
    'RSS before -> after',
    rssOk ? `${before.rssMB} MB -> ${after.rssMB} MB  (+${(after.rssMB - before.rssMB).toFixed(1)} MB)` : 'not reported by /healthz?stats=1',
    'growth must be < 30 MB',
    rssOk ? after.rssMB - before.rssMB < 30 : null
  );

  // --- Print -----------------------------------------------------------
  console.log('  ---------------------------------------------------------------------');
  for (const c of checks) {
    const mark = c.ok === null ? 'SKIP' : c.ok ? 'PASS' : 'FAIL';
    console.log(`  ${mark}  ${c.label.padEnd(30)} ${c.value}`);
    console.log(`        ${''.padEnd(30)} ${c.criterion}`);
  }
  console.log('  ---------------------------------------------------------------------');
  console.log(`  burst wall time            ${burstMs} ms for ${N} submissions`);
  console.log(`  replay of ${String(replayN).padEnd(3)}same sids     ${distribution(replayStatuses)}`);
  console.log(`  stage stream               ${stage.frames} frames, ${mb(stage.bytes)}`);
  if (typeof after.sse === 'number') console.log(`  server sse connections     ${after.sse}`);
  if (typeof after.heapMB === 'number') console.log(`  server heap after          ${after.heapMB} MB`);

  const failed = checks.filter((c) => c.ok === false).length;
  const skipped = checks.filter((c) => c.ok === null).length;
  const passed = checks.length - failed - skipped;
  console.log(
    `\n  ${failed ? 'FAIL' : 'PASS'} — ${passed}/${checks.length} criteria met` +
      (failed ? `, ${failed} failed` : '') +
      (skipped ? `, ${skipped} skipped (server did not report the field)` : '') +
      '\n'
  );

  // Streams die with the process, but closing them first lets the server drop
  // its client set before the delete rather than writing into dead sockets.
  for (const c of participants) c.req.destroy();
  stage.req.destroy();
  return failed ? 1 : 0;
}

main()
  .then(async (exitCode) => {
    if (code) await req('POST', `/api/room/${code}/delete`, {}, postAgent).catch(() => {});
    sseAgent.destroy();
    postAgent.destroy();
    process.exit(exitCode);
  })
  .catch(async (e) => {
    console.error(`\n  load test aborted: ${e.message}\n`);
    if (code) await req('POST', `/api/room/${code}/delete`, {}, postAgent).catch(() => {});
    sseAgent.destroy();
    postAgent.destroy();
    process.exit(1);
  });
