# ExCo Live

A bespoke, self-hosted interactive polling app in the spirit of Slido / Mentimeter,
styled to **The ExCo Group** brand system. Zero external dependencies — just Node.js.

## What it does

- **Host a session** → get a 5-character join code + shareable link + scannable QR.
- **Audience joins** from any phone/laptop on the network — no login, no install.
- **Five interaction types**, all with live results that push instantly to every screen:
  - Multiple choice (bar chart)
  - Word cloud (sized by frequency)
  - Rating / scale (average + distribution)
  - Open text (responses stream in as cards)
  - **Worksheet grid** (a rows x columns sheet — e.g. the *Mentoring for Impact*
    worksheet — filled in on each participant's phone, by typing or by photographing
    the paper copy; the stage shows a live fill matrix of which boxes the room can
    and can't answer)
- **Live Q&A board** — audience submits questions and upvotes; host moderates and dismisses.
- **Preloaded run of show** — load all your questions before the event and step through them
  live with Next / Prev (or the ← → arrow keys). Save a run of show as a reusable **agenda
  template** and load it at the next event.
- **Answer anonymously** — a participant can choose to give no name; the choice is
  remembered on their device.

Real-time updates use Server-Sent Events, so nothing needs installing beyond Node.

## Run it locally

```bash
npm start          # from the repo root
# → http://localhost:3000
```

`npm start` is `node --env-file-if-exists=.env server.js`. That flag is the **only**
thing that loads `.env` — there is no dotenv package and nothing in `server.js` reads
the file. Running `node server.js` directly starts the app with whatever is already in
your shell environment and **silently ignores `.env`**: no Supabase, no AI, no custom
port. That is a legitimate way to run it (see the load test below, where you *want* no
database), but if the AI buttons say "not configured" after you filled in a key, this
is why.

To set up: copy [`.env.example`](.env.example) to `.env` in the same directory and fill
it in. It documents every variable with the defaults inline.

```bash
cp .env.example .env
$EDITOR .env          # every value in it is a placeholder — replace or delete each one
npm start
```

**Copying is not configuring.** `.env.example` is committed, so it holds **no real
values** — only placeholders. `cp` gives you a file that starts the app but has no
working key and no database. In particular, leaving the literal `sk-ant-...` in place is
*worse* than having no key at all: see [Unset key vs wrong key](#unset-key-vs-wrong-key).
The server prints a loud boot warning when the key doesn't look real.

Where the real values come from:

| | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys. Never commit it anywhere. |
| `SUPABASE_URL` / `SUPABASE_KEY` | Supabase dashboard → Project Settings → API. The deployed project's values are pinned in [`.do/app.yaml`](.do/app.yaml). |

**`.env` is gitignored and must never be committed.** It holds a live Anthropic key.
`.gitignore` covers `.env` and `.env.*` with an explicit exception for `.env.example`.

`SUPABASE_KEY` is the **publishable** key, not the service-role key. Publishable is the
key designed to be handed out — but that is only safe if **row-level security is enabled
on every table**, which is the only thing between that key and a direct PostgREST read of
every past session. Nothing in this repo checks or asserts that RLS is on; confirm it in
the Supabase dashboard. A service-role key must never go in `.env.example` or
`.do/app.yaml`, both of which are committed.

**DigitalOcean does not use `.env` at all.** The deployed app reads its environment
from the App Platform dashboard (App → Settings → web → Environment Variables), with
`ANTHROPIC_API_KEY` marked **SECRET**. Editing `.do/app.yaml` does not push env vars to
a running app; either set them in the dashboard or run `doctl apps update --spec`.

With no environment at all the app runs in memory on port 3000 with the AI features
switched off. That is fine for local dev and for the load test, but it is **not** a
degraded-but-complete app — read [In-memory mode](#in-memory-mode-what-actually-stops-working)
before running an event that way.

## Environment variables

Every variable the server actually reads, with its default. Anything unset falls back
to the default; a value that doesn't parse as an integer falls back too, rather than
poisoning a counter with `NaN`.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | HTTP port. App Platform sets this to 8080. |
| `SUPABASE_URL` | *(unset)* | Durable store. **Both** this and `SUPABASE_KEY` must be set, or the app runs in memory only — which takes CSV export, the AI debrief and the whole dashboard down with it. See [In-memory mode](#in-memory-mode-what-actually-stops-working). |
| `SUPABASE_KEY` | *(unset)* | The publishable key — safe to commit **only** if RLS is on (see above). The Node server is the only Supabase client; browsers never talk to Supabase directly. |
| `ANTHROPIC_API_KEY` | *(unset)* | Enables every AI feature. Unset → `ai_not_configured` (503) and nothing else changes. Set but **wrong** → every call fails with `ai_key_rejected` (502). See [Unset key vs wrong key](#unset-key-vs-wrong-key). |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5` | The latency-sensitive lane: Q&A clustering, response synthesis, poll drafting. |
| `ANTHROPIC_MODEL_OCR` | `claude-sonnet-5` | Handwriting transcription. Nobody is watching a spinner mid-answer here, so quality beats speed. |
| `ANTHROPIC_MODEL_ANALYSIS` | `claude-sonnet-5` | Worksheet analysis, debrief, cross-event trends — read back to a room as their own words. |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Override the API host (proxy, or a mock server in tests). Trailing slash is stripped. |
| `AI_CONCURRENCY_OCR` | `10` | Parallel calls in the photo lane. Raise on a higher API tier. Minimum 1. |
| `AI_CONCURRENCY_INTERACTIVE` | `2` | Parallel calls in the presenter lane. Separate from OCR so a presenter clicking an AI button never queues behind 40 participant photos. Minimum 1. |
| `AI_QUEUE_MAX` | `120` | Waiting jobs per lane before shedding with 503 + `Retry-After`. Each queued photo holds its decoded image until its call runs — `OCR_B64_MAX` caps that at ~880 KB, and the **measured** resident cost is ~1.5 MB per job. 10 running + 120 queued measured ~245 MB RSS; the full arithmetic is in [`.do/app.yaml`](.do/app.yaml). |
| `AI_TIMEOUT_MS` | `60000` | Socket timeout **per attempt**, not per call. Minimum 1000. |
| `AI_MAX_RETRIES` | `4` | Retries after a retryable failure, with full-jitter backoff that honours `retry-after`. 4xx is never retried. `0` disables retries. |
| `AI_MAX_WAIT_MS` | `60000` | How long a queued **interactive** job waits before failing. A presenter wants a clear failure at a minute, not a spinner at three. Minimum 1000. |
| `AI_MAX_WAIT_OCR_MS` | `240000` | How long a queued **photo** job waits. Long on purpose: 100 photos at 10 concurrent is ~100s of drain, and the last phones in the queue shouldn't fail for being last. Minimum 1000. |
| `BODY_BUDGET` | `96000000` | Process-wide ceiling, in bytes, across all request bodies being read at once. Per-request caps alone don't bound memory — 100 phones uploading simultaneously is 100× the per-request cap. Over budget returns 503 + `Retry-After`. |

Per-request body caps are **not** env-configurable: 1 MB for ordinary API calls, 1.6 MB
for the worksheet photo endpoint (of which at most ~1.2 MB may be base64 image).

`NODE_ENV` appears in `.do/app.yaml` but the app never reads it.

## Deploying to DigitalOcean App Platform

The app runs as a single always-on Node process (that's what powers the live SSE
broadcast), so it deploys to App Platform as one **web service, single instance**.

> **The spec deploys `main`, and this work is not on `main`.** The worksheet type, the
> photo/OCR path and the 100-participant scale work all live on `scale-and-worksheet`.
> Deploying today builds a `main` with none of it. The branch in `.do/app.yaml` is
> deliberately left alone — which branch to ship is a call for whoever owns the repo —
> but **the merge has to happen first**, and because `deploy_on_push: true` is set,
> **merging to `main` *is* the deploy**. There is no separate go-live step to schedule,
> and no confirmation prompt. See [Operational risks](#operational-risks-running-a-real-event).

1. **Push to GitHub.** Create a private repo under the ExCo org and push this project:
   ```
   git remote add origin git@github.com:your-org/exco-live.git
   git push -u origin main
   ```
2. **Create the app.** In DigitalOcean → **Apps → Create App**, connect that repo.
   App Platform auto-detects Node and the spec in [`.do/app.yaml`](.do/app.yaml).
   (Or from a machine with `doctl` authed to the ExCo team: edit the `repo:` field in
   `.do/app.yaml`, then `doctl apps create --spec .do/app.yaml`.)
3. **Set the env vars in the dashboard**, per the table above. `ANTHROPIC_API_KEY` must
   be type SECRET. Do not commit it to `.do/app.yaml`.
4. **Keep it at 1 instance.** The spec pins `instance_count: 1` — required, because live
   results fan out over SSE from one in-memory process, and so do the persistence
   guard, the fingerprint cache and the duplicate-submission sid sets. See *Scale*
   below.
5. **Leave the sizing alone unless you've read why.** `.do/app.yaml` pins the instance
   size and a `--max-old-space-size` ceiling, and carries the measured memory arithmetic
   behind both. The realtime path is cheap; what sets the floor is the worksheet photo
   queue holding one decoded image per job. Note the flag bounds the **JS heap only** —
   Buffers are external and uncounted — and V8 adds ~192 MB of semi-space to whatever
   number you give it, so the ceiling is deliberately well below the container limit.
6. **Custom domain.** Add e.g. `live.excoleadership.com` in the app's Settings → Domains,
   then add the CNAME it gives you to DNS. TLS is automatic.

**Persistence:** State is stored durably in **Supabase Postgres**, so sessions, poll
results, Q&A, and agenda templates survive redeploys/restarts and past events stay
queryable for analysis. In-memory state remains the live/realtime layer; every change
writes through to Supabase, and the server reloads from it on boot. Writes are
debounced per room (~150 ms, flushed within 1s at the latest), send only the rows that
actually changed, and are drained on shutdown.

### In-memory mode: what actually stops working

If `SUPABASE_URL`/`SUPABASE_KEY` are unset the app boots with
`Supabase not configured … running in-memory only, no persistence` and keeps serving. It
is a fine fallback for local dev and the load test. It is **not** a fallback for an
event, because losing the database does not only lose history — several features read
*back* through Supabase even for a session that is live in front of you:

| | In-memory behaviour | Why |
|---|---|---|
| **CSV export** (presenter console **and** dashboard) | `404 not_found`, even mid-session | `fetchRoomDetail()` returns `null` with no Supabase, and the route 404s before it can read the in-memory room |
| **AI debrief** | `404 not_found` | same `fetchRoomDetail()` |
| **Dashboard session list** | Empty — 0 sessions, 0 responses, 0 questions | `analyticsList()` short-circuits to empty arrays |
| **Cross-event trends** | Reports "there are no sessions yet" | it counts the (empty) `analyticsList()` result, so it never reaches two answered sessions |
| **Worksheet analysis** | Works **while the room is live**, `404` after **End session** | it tries the in-memory room first and only then Supabase; `/end` deletes the room from memory |
| Live polling, Q&A, worksheets, OCR | Unaffected | all served from memory |

So an in-memory event runs fine on stage and then leaves you with **nothing**: no export,
no debrief, no record. Verified against the running server, not inferred.

**Database schema:** the `polls` table needs two columns for the worksheet poll type.
They are additive and safe to run on an existing database (existing rows backfill to the
defaults). Run once in the Supabase SQL editor before deploying:

```sql
alter table polls add column if not exists worksheet jsonb not null default '{}'::jsonb;
alter table polls add column if not exists grids     jsonb not null default '[]'::jsonb;
```

**An un-migrated table fails in two different shapes, and only one of them is loud.**

1. **On write — loud, and it takes every poll with it.** PostgREST 400s the *whole*
   `polls` batch on one unknown column, so **no poll of any type persists** — not just
   the worksheet ones. The `rooms` row is written first and separately, so it lands; the
   session shows up in the dashboard with zero polls and zero responses, which reads like
   an empty event rather than a broken one. Row fingerprints are only committed once a
   write lands, so every later flush re-sends the same failing batch. `PERSIST FAILED`
   appears in the logs and `persistErrors` climbs on `/healthz?stats=1`.
2. **On read/boot — completely silent.** Reads never fail on a missing column. `load()`
   and `fetchRoomDetail()` both select `*`, so an absent `worksheet` simply isn't in the
   response; the code reads it as `p.worksheet || {}` and the poll comes back with
   **empty rows and empty columns**. That renders as a worksheet question a participant
   cannot fill in — and there is no error anywhere: not in the logs, not in the UI, not
   in `persistErrors`. On the dashboard and in the CSV the same poll simply has no
   worksheet cells. A worksheet that looks blank on every phone after a restart is this,
   not a browser problem.

   This is what you hit when the column is absent for a reason other than "never
   migrated": pointed at a second project (staging) that was never migrated, a backup
   restored from before the migration, a dropped or renamed column. The write path is
   what fails loudly; the read path fails quietly, so **the absence of an error is not
   evidence the schema is right**.

Run the migration **before** the first worksheet ever reaches the database, and confirm
it by checking that a real row lands (below) rather than by the absence of an error.

## Use it

1. Open `http://localhost:3000`, give the session a title, click **Create session**.
   You land on the presenter console (`/present/<CODE>`).
2. Create a poll, click **Create & present** to put it live on the stage.
3. Share the code / link / QR. On the same network, others open the join link
   (e.g. `http://<your-lan-ip>:3000/join/<CODE>`) and vote from their phones.
4. Results animate live on the presenter stage. Switch polls anytime; the audience
   view follows automatically. The Q&A tab is always open to the audience.

> **Finding your LAN IP (macOS):** `ipconfig getifaddr en0`

## Preloading questions (seamless event presenting)

Three ways to get questions in before you go on stage:

1. **Preload (paste a run of show)** — on the presenter console, click **Preload** and paste
   your questions in this simple format. They load in order as drafts:

   ```
   [mc] Which region are you joining from?
   - Americas
   - EMEA
   - APAC

   [rating 1-5] How prepared do you feel? | Not at all | Fully

   [wordcloud] One word for this quarter?

   [text] What's the biggest barrier to your team's performance?
   ```

   Tags: `[mc]` multiple choice, `[wordcloud]`, `[rating 1-N] … | lowLabel | highLabel`, `[text]`.

   `[worksheet]` builds a grid — see below.

2. **Agenda templates** — **Save agenda** stores the current run of show under a name;
   **Load agenda** preloads it into any session. Reuse the same set across events.

3. **+ New poll** — add or tweak individual questions one at a time.

During the session, **Next ▶ / ◀ Prev** (or the **← →** arrow keys) advance through the run
of show, activating each question live. Reorder with the ↑ / ↓ buttons in the list.

## The worksheet poll type

A worksheet is a generic **rows × columns** grid — up to **6 rows and 4 columns** — that
every participant fills in on their own phone and submits once. It ships with the ExCo
*Mentoring for Impact* sheet built in.

**The poll type is generic; the AI analysis is not.** Authoring, filling in, photo OCR,
the live fill matrix, persistence and CSV export all treat rows and columns as arbitrary
strings and work with any grid you write. But the **AI: Analyse worksheet** prompt
hardcodes the MFI column meanings: it tells the model the three columns are *who would
need to notice improvement*, *what early indicators of success would be*, and *how
longer-term impact might show up*, and it applies a measurability test drawn from the MFI
footnote ("you can't measure this" is not an answer). Point it at a worksheet with
different columns and you get an analysis reading your columns as if they were those
three. Generalising it means editing the `aiWorksheet` system prompt in `server.js`;
nobody has done that. Everything except the analysis button is safe to reuse today.

### Authoring

Three routes, all producing the same poll:

- **+ New poll → Worksheet.** Fields for the row header, rows (one per line), columns
  (one per line), the instruction shown above the grid, and the footnote shown below it.
  A **Load the Mentoring for Impact worksheet** button fills all five in one click, so
  the shipped sheet is a starting point you can edit rather than a fixed thing.
- **Preload syntax.** Inside a `[worksheet]` block: `-` lines are rows, `|` lines are
  columns, `>` is the instruction, `*` the row header, `~` the footnote.

  ```
  [worksheet] Mentoring for Impact
  * Typical focus areas of a client's action plan
  > What would stakeholders ideally see/think/feel differently…
  - Delegation
  - Prioritization
  - Peer and stakeholder management
  | Stakeholders who would need to notice improvement
  | What might early indicators of success be?
  | How might longer-term impact show up?
  ~ "You can't measure this" is not an answer.
  ```

  A **bare `[worksheet]` with no body** loads the shipped *Mentoring for Impact* sheet.
  A worksheet with rows but no columns (or the reverse) is rejected rather than
  half-filled from the default — publishing rows the presenter never wrote, under the
  title they did, is worse than an error.

Cell ids are deterministic — `r1..rN` and `c1..cN`, so a cell key is `r2c3`. That is
what lets the OCR call use a closed schema: the model cannot invent a box, omit one, or
return a key whose position we'd have to guess.

### Filling it in: typing

The participant gets the grid as text areas, with a live count of how many boxes are
filled. Typing is saved to a **local draft** (`localStorage`, debounced ~400 ms) keyed
to the poll, so a phone that locks, reloads, or gets backgrounded doesn't lose the work.
The draft is cleared on successful submit. Cells accept newlines (people type short
lists into them) and are capped at 400 characters.

### Filling it in: photograph the paper

Offered **above** the grid, because after nine boxes of typing a photo is worthless:

1. **Capture.** A file input with `capture="environment"` — the native camera, not
   `getUserMedia`. The browser downscales and re-encodes to JPEG before upload
   (correcting iPhone EXIF rotation, which is the single biggest cause of a bad read).
2. **OCR.** `POST /api/room/:code/poll/:id/ocr` runs one Claude vision call in the OCR
   lane. The prompt is transcription-only: copy verbatim, keep the writer's own
   abbreviations and arrows, never expand or tidy, never answer the worksheet, never
   merge two boxes. A box with writing it cannot read comes back **empty and flagged**
   rather than guessed — a confident invention reads as correct and gets submitted as
   someone's words. It also classifies the photo (`match` / `different_worksheet` /
   `not_a_worksheet`) and refuses a sheet that isn't this one. While the job is queued
   the phone polls `/api/ocr-status` and shows a real wait ("about 30s") rather than a
   spinner.
3. **Review and edit.** The transcription lands in the grid, per box, marked *"From your
   photo — check it"*; unreadable boxes are marked as such. Anything already typed is
   never overwritten, and a retake only replaces boxes the new photo actually has
   something to say about. The participant fixes what's wrong.
4. **Submit.** The same submit path as the typed grid, with `source: 'photo'`.

**Photos are never stored.** The OCR endpoint has no write path to `poll.grids`, nothing
touches disk, and the image bytes are never logged (errors carry the message only, so a
failure can't ship the payload back out). The base64 string is dropped the moment it is
decoded, and the decoded buffer is released when the call returns. What is persisted is:

- **the approved text** — what the participant reviewed and submitted, and
- **`ocrRaw`** — the model's **pre-edit** transcription, sanitised identically and keyed
  by the same cell ids.

`ocrRaw` is an audit trail, kept deliberately. Comparing it to the submitted cells is a
**per-cell edit rate**, which is the only empirical answer to "is OCR good enough for
our handwriting". It costs about 1 KB per grid and carries none of the image's PII.

### Analysis

**AI: Analyse worksheet** (presenter console, and the dashboard after the event) reads
the submitted grids back measurability-first — the sheet itself says "you can't measure
this" is not an answer, so the analysis sorts every response into measurable (names an
observer *and* a countable/dated/cadenced signal) versus vague, quotes the vague ones
verbatim so the facilitator can read them back, and suggests how to sharpen them. Themes
are scoped to the box they came from: a theme printed under one row and column must be
evidenced by an answer from *that* box, not from anywhere on the sheet. A box with fewer
than two answers gets no themes at all. Sample size, filled cells and per-box counts are
counted in code, not asked of the model.

On stage, a live **fill matrix** shows which boxes the room can and can't answer as the
worksheets land.

## AI features, and what they will not do

With `ANTHROPIC_API_KEY` set, the app adds Claude-powered helpers, called server-side
over plain HTTPS (no npm dependency):

| Where | What |
|---|---|
| Presenter console | Q&A theme clustering; open-text / word-cloud synthesis; worksheet analysis |
| New-poll modal | AI poll drafter (the four non-worksheet types) |
| Dashboard | Per-event debrief; cross-event trends; worksheet analysis after the event |
| Participant phone | Worksheet handwriting OCR |

All of it goes through a two-lane queue (see the env table): a presenter clicking a
button never waits behind a room's worth of photos, retries use full jitter and honour
`retry-after`, 4xx is never retried, and an overloaded lane sheds with `503` +
`Retry-After` rather than a 500 that reads like a bug.

### The grounding rules

Structured outputs force the model to emit every required field. A model handed a thin
session therefore has **no legal way to abstain** — it fills the empty sections with
invention that reads exactly like findings. Four things prevent that:

1. **Deterministic refusal, before any model call.** A debrief on a session with zero
   responses and zero audience questions returns `insufficientData: true` and a plain
   message saying so — no API call is made. Cross-event trends do the same when fewer
   than two sessions have any data (checked twice: once against stored counts, once
   against the actual arrays after fetching). Worksheet analysis does the same with no
   submitted grids.
2. **The corpus states its own totals** and marks every empty poll `NO RESPONSES
   SUBMITTED`, so a question the *presenter* asked is never mistaken for data about the
   audience. Participant text is fenced with explicit BEGIN/END markers and labelled as
   material to analyse, never as instructions to follow.
3. **Quotes are verified, not trusted.** Every quote the model returns is substring-
   checked against **participant-submitted text only** — open-text responses, word-cloud
   words, worksheet cells. Poll questions and option labels are *not* in that haystack,
   so a "quote" lifted from the presenter's own wording is dropped. Matching is per
   submission, never against a joined blob, so two people's answers can't be stitched
   into one passing quote. Unverifiable quotes are dropped and the drop is logged.
4. **Counts are computed in code** and attached after the call. A model asked how many
   people answered will produce a plausible number, and the facilitator quotes it at the
   room as a fact.

### The honest limits

- **OCR accuracy on real handwriting has not been measured.** There is no benchmark and
  no error rate for this app. The review-and-edit step exists precisely because accuracy
  cannot be assumed — the participant, not the model, decides what gets submitted.
  `ocrRaw` exists so the edit rate can be measured later against real sessions; until
  someone does that, treat the transcription as a first draft.
- The grounding rules stop the model **inventing findings out of nothing**. They do not
  make its reading of real text correct. Quote verification proves the words were
  written by a participant; it does not prove the theme they've been filed under is the
  right one. Read an AI debrief against the CSV before you present it.
- The worksheet analysis prompt **assumes the MFI column meanings** — see
  [The worksheet poll type](#the-worksheet-poll-type). On a differently-worded grid it
  will still produce confident-looking output.

### Unset key vs wrong key

"Everything AI is optional" is true of an **unset** key. A **wrong** one is a different
failure, and it is the one that shows up on stage:

| | `ANTHROPIC_API_KEY` unset | `ANTHROPIC_API_KEY` set but wrong |
|---|---|---|
| When it's decided | Before any network call — `AI_ENABLED` is false | On the first call, by Anthropic |
| Response | `503 { error: 'ai_not_configured' }` | `502 { error: 'ai_key_rejected', retryable: false }` |
| Presenter console / dashboard | Panels read "AI not configured" | "AI key rejected" |
| Participant phone | "Reading photos is not switched on for this session — please type your answers in." | "Photo reading is misconfigured for this session — the AI key was rejected. Let the host know, and type your answers in." |
| Retried? | No call to retry | No — 401/403 is never retried, and the client is told not to press again |
| Rest of the app | Unaffected | Unaffected — but every AI button is lit and every one of them fails |

`AI_ENABLED` is `!!ANTHROPIC_API_KEY` and nothing more: presence is the only thing that
can be checked locally, so a typo, a revoked key, or the literal `sk-ant-...` placeholder
from `.env.example` all *enable* AI and then fail every call. The server prints a loud
boot warning when the key doesn't look real (wrong length, no `sk-ant-` prefix), but the
warning is a heuristic and never gates the feature — only the API can settle whether a
key is live. **If you are not using AI, unset the key rather than leaving a placeholder.**
If you are, make one real AI call against the deployed app before the event.

## Answering anonymously

On first join, a participant is asked for a name — and choosing **not** to give one is a
real option, not a fallback. Leaving the box empty, or clicking "Stay anonymous", stores
that decision on the device (`lp_anon`), so the modal doesn't reopen on every load. The
pill in the header reads "Anonymous" and can be switched to a name (and back) at any
time; switching to anonymous clears the stored name so nothing already submitted gets
re-attributed.

There is no separate anonymous mode server-side. An anonymous submission simply carries
`author: ''` — through open text, worksheets and Q&A alike — and exports with an empty
`author` column.

## Exporting results (CSV)

Per-session CSV is available from the presenter console (**Export CSV**) and from the
dashboard, at `GET /api/room/<CODE>/export.csv`. UTF-8 with a BOM, so Excel opens it
correctly.

**The header changed** when the worksheet type shipped. Two columns were inserted in the
middle, not appended:

```
session, code, date, poll, type, question, worksheet_row, worksheet_column, answer, count, percent, author
```

`worksheet_row` and `worksheet_column` sit **between `question` and `answer`**. Anything
parsing these exports by column position — a script, a saved Excel import, a Sheets
formula with fixed column letters — will silently read the wrong fields and needs
updating. Parse by header name. For every non-worksheet row the two new columns are
empty.

Worksheet rows are **one row per respondent per cell**, blanks included:

| type | worksheet_row | worksheet_column | answer | count |
|---|---|---|---|---|
| worksheet | Delegation | Stakeholders who would need to notice improvement | Her skip-level, in the weekly 1:1 | 1 |
| worksheet | Delegation | What might early indicators of success be? | | 0 |

An empty cell is emitted with `count` 0 rather than skipped. That keeps every submitted
grid rectangular — respondents × rows × columns rows per worksheet — which is what makes
it pivot-ready: "which boxes could nobody fill?" is a single pivot on row × column
summing `count`, and it only gives the right answer if the blanks are present to be
counted as zero. Skipping them would make an unanswerable box indistinguishable from a
box nobody was asked.

## Scale

The app was rebuilt to survive a full room answering at once, and the fix is measured,
not asserted. With 100 concurrent submitters and 100 open SSE connections:

| | Before | After |
|---|---|---|
| Bytes written to 100 participant sockets during the burst | ~1,045 MB | 0.10 MB |
| RSS growth over the burst | +627 MB — an OOM kill on a 512 MB box | +2 MB |

What changed: per-room SSE broadcasts are coalesced on a 120 ms tick instead of one
frame per submission; participants receive a slim payload (the active poll and the Q&A
only) while the stage gets the full room; a socket carrying more than 1 MB of unflushed
data is skipped for that tick rather than buffered further, and is destroyed outright
when the room ends, since a stream sitting on the cap can never drain; persistence is
debounced per room with an in-flight guard and writes only changed rows; and submissions
are idempotent on a client-supplied `sid`, so the retries a phone on venue wifi *must*
make are no-ops instead of second votes.

### Re-running the load test

```bash
lsof -ti tcp:3000                         # anything already on 3000? kill it, then confirm this is silent
node server.js                            # note: NOT `npm start` — see below
node tools/loadtest.js --type open_text    # in a second terminal
```

Flags: `--host 127.0.0.1:3000`, `--n 100`, `--type open_text|multiple_choice|rating|word_cloud`.

Start the server with **`node server.js`, not `npm start`**. The test creates a real
room and submits 100 real answers; with `.env` loaded, all of that is written to the
production Supabase project. Without it, the run is in-memory and disappears on exit.

The test opens 100 participant streams plus one stage stream, fires 100 submissions with
zero stagger, then replays 20 of them with the **same** `sid`s. It exits 0 only if all
seven criteria pass:

| # | Criterion | Threshold |
|---|---|---|
| 1 | Status distribution | exactly 100 × `200` |
| 2 | Server `totalVotes` | exactly 100, *after* the 20 duplicate sids were replayed (idempotency) |
| 3 | Bytes to the 100 participant streams | < 10 MB |
| 4 | Participant frame count | max ≤ 32 and well under n — proves coalescing |
| 5 | Vote-visibility latency on the stage | p95 < 300 ms, all 100 votes seen |
| 6 | `bufferedBytes` after the burst | < 100 KB — proves no backpressure accumulation |
| 7 | RSS growth | < 30 MB |

Criteria 6 and 7 read `/healthz?stats=1`; against an older server that doesn't report
those fields they print SKIP rather than failing the run.

### instance_count must stay 1

`.do/app.yaml` pins `instance_count: 1`, and it has to stay there. This is a
**correctness constraint, not a cost decision** — every piece of coordination in the
server is per-process, in-memory, and has no cross-instance equivalent:

- **SSE fan-out.** A second instance would put half the audience on a process that never
  hears the other half's submissions. The room splits silently, each half seeing partial
  results and neither knowing.
- **The 120 ms coalescing timer** is a local timer, so N instances means N uncoordinated
  flushes per room.
- **The persistence in-flight guard** ("one Supabase write per room at a time") is a
  local flag. Two instances would interleave writes to the same row and last-write-wins
  would silently drop responses.
- **The changed-row fingerprint cache** is local, so a second instance starts cold and
  rewrites rows it believes changed.
- **Duplicate-submission suppression** is a local `Set` of client sids per poll. Split
  across instances, a phone retrying lands on the other one and double-counts — the
  idempotency the load test checks for stops holding.

Scaling out means shared pub/sub (Redis, or Supabase Realtime) for the fan-out *plus* a
shared store for the guards, fingerprints and sid sets. It is not a slider you can move.
`.do/app.yaml` carries the same list next to the setting.

## Operations

**`GET /healthz`** → `200 ok`, `text/plain`. This is the App Platform health check path;
it stays a bare `ok` on purpose so the platform probe is unaffected by anything below.

**`GET /healthz?stats=1`** → JSON counters, for the load test and for looking at a live
event:

| Field | Meaning |
|---|---|
| `rssMB` | Process resident set size. Compare against the instance size pinned in `.do/app.yaml`. |
| `heapMB` | V8 heap used. |
| `sse` | Open SSE connections across all rooms — roughly "people watching". |
| `bufferedBytes` | Total bytes queued in those sockets and not yet flushed. Should sit near zero; sustained growth means a slow or dead client is backing up. |
| `rooms` | Rooms currently held in memory. |
| `dirty` | Rooms with unsaved changes waiting for the next Supabase flush. Spikes during a burst and drains back to 0 — **but see below: 0 is not evidence anything was written.** |
| `saving` | Rooms with a persistence write in flight right now. |
| `persistErrors` | Count of failed persistence writes since boot. **This is the field that matters.** |
| `lastPersistError` | Message from the most recent failure (`null` if there has been none). The upstream PostgREST body is deliberately kept out of it and only reaches the logs. |
| `lastPersistErrorAt` | ISO timestamp of that failure. |
| `aiRunning` | Claude calls on the wire, both lanes combined. |
| `aiWaiting` | Claude calls queued, both lanes combined. Compare against `AI_QUEUE_MAX`. |
| `bodyInFlight` | Bytes of request bodies currently being read, against `BODY_BUDGET`. |

**`dirty` returning to 0 proves nothing on its own.** Every `save()` is fire-and-forget,
and `flushRoom()` removes the room from `dirty` *before* the write is attempted — and
does not put it back if the write fails, on purpose (a broken schema 400s every attempt,
and a re-arming retry loop against one is an unattended write storm). So a session that
persisted **nothing** shows exactly the same `dirty: 0, saving: 0` as one that persisted
everything.

What actually indicates a healthy write:

- **`persistErrors: 0`**, with `lastPersistError: null`. Anything above 0 means at least
  one batch never landed, and `lastPersistError` / `lastPersistErrorAt` say which and
  when. `PERSIST FAILED —` in the logs carries the PostgREST detail.
- **`POST /api/room/:code/end` returning `ok: true`.** If the final flush or the archive
  PATCH failed, `/end` returns `200` with `ok: false, persisted: false,
  error: 'persist_failed'` and a message saying the stored results may be incomplete. It
  still ends the session (keeping a dead room in memory loses more), but it refuses to
  claim a clean finish. **Check this before closing the laptop.**
- **A row you can actually see.** The only end-to-end proof is the data being there:
  submit one answer and confirm the session appears in the dashboard, or in Supabase's
  table editor. Do this once before the event — it is also the only check that catches
  the silent [un-migrated read](#deploying-to-digitalocean-app-platform) shape.

**`GET /api/ocr-status`** → `{ running, waiting, etaSeconds }` for the photo lane. This
is what a participant's phone polls to show a real wait instead of a spinner. Not
room-scoped — the lane is process-wide, and it is three integers about our own queue.

When either queue sheds, the response is `503` with `{ error: 'busy', reason,
retryAfterSeconds }` and a `Retry-After` header — a client can act on that. Reasons are
`queue_full`, `queue_timeout` and `server_busy`.

## Operational risks: running a real event

This is a prototype being pointed at a room of 100 people. These are the ways it bites,
in the order they are likely to.

**Do not deploy during an event — and know what counts as deploying.**
`.do/app.yaml` sets `deploy_on_push: true` on `main`, so **merging a PR to `main` is a
deploy**. There is no separate go-live button and no confirmation. A deploy replaces the
process, and the process *is* the live layer: every open SSE connection is dropped and
every room is rebuilt from Supabase on boot. If Supabase is slow or erroring at that
moment, `load()` catches it and the app comes up with **empty state** — every live room
gone, every join code dead, mid-session. Freeze merges to `main` for the duration, and
merge the outstanding branch well before the day, not on it.

**Rehearse once, with the real key, against the real deployment.** The two configuration
failures that matter both look fine until the moment they don't: a placeholder or revoked
`ANTHROPIC_API_KEY` lights every AI button and fails every press
([above](#unset-key-vs-wrong-key)), and an un-migrated `polls` table either blocks every
write or silently serves an unfillable worksheet
([above](#deploying-to-digitalocean-app-platform)). Neither is visible from the presenter
console. Run a full dry run on the deployed URL: create a session, submit a worksheet
from a phone, take one photo through OCR, press one AI button, export the CSV.

**Confirm a row actually lands in Supabase before the event.** `dirty: 0` is not proof
([above](#operations)). Submit one answer, then check `persistErrors` is `0` on
`/healthz?stats=1` **and** that the session shows up in the dashboard. Do this after any
env-var change, since env changes in the DO dashboard restart the app.

**End the session properly and read the response.** `End session` is what stamps
`ended_at` and flushes the last batch. If it comes back `ok: false` /
`persisted: false`, the stored results may be short — deal with it before everyone leaves,
while the room is still reproducible.

**One instance, no auth, no rate limit.** There is no failover: if the process dies
mid-event, live rooms rebuild from Supabase only if Supabase answers. Anyone with the URL
can drive `/present/<CODE>` — treat the presenter link as the credential. And ordinary
submissions have no per-IP limiter, so the app assumes a trusted room, not the open
internet.

**Have a paper fallback for the worksheet.** The photo path depends on a third-party API
being up and on OCR accuracy that [has never been measured](#the-honest-limits).
Participants can always type instead, and that path needs no AI at all — say so from the
stage rather than discovering it live.

## Branding

The UI is built on the tokens in `~/Desktop/Brand Kit/` (Design System + `tokens.json`)
and tuned to match **excoleadership.com**'s actual balance — black / charcoal grounds with
light type, rather than a white-dominant page. Palette roles:

- **Ground:** near-black `#0c0d0e` page with **white cards** and light-on-black chrome
  (topbar/logo) — the site's black-hero + white-section rhythm.
- **CTAs:** ExCo blue `#00527A` is the workhorse primary; ExCo green `#73B278` is the
  primary affirmative ("go") action — create & present, submit, send.
- **Data:** result bars use ExCo blue as the base, with green marking the leading option;
  rating averages render as monumental green Newsreader numerals.
- **Gradient:** the 45° blue→green gradient anchors the logo X and the header thread.
- **Type:** D-DIN headers, Lato body, Newsreader for proof numerals. Logo is the white
  lockup on the dark ground.

Fonts live in `public/fonts/`, logo + favicon in `public/brand/`.

> Notes: the brand kit marks its **gray ramp and charcoal/off-white values as "proposed"**
> (not fixed in the manual). The kit's strict reading is "~90% monochrome, gradient rationed
> to one moment"; this app deliberately leans on solid blue/green CTAs and data colors for a
> product UI, matching the live site. Worth a quick designer confirm before client-facing use.

## How it's built

| File | Role |
|------|------|
| `server.js` | HTTP + SSE server, in-memory room state, write-through persistence to Supabase Postgres (via its REST API), Claude API client + queue |
| `public/index.html` | Landing (create / join) |
| `public/present.html` + `present.js` | Presenter console & live stage |
| `public/join.html` + `join.js` | Participant app (voting, worksheet grid, photo capture) |
| `public/dashboard.html` + `dashboard.js` | Cross-event dashboard, debrief, trends, CSV |
| `public/qrcode.js` | Tiny dependency-free QR generator |
| `public/styles.css` | ExCo visual system (tokens, fonts, components) |
| `public/fonts/`, `public/brand/` | ExCo web fonts, logo lockups, favicon |
| `tools/loadtest.js` | 100-participant burst test (see Scale) |
| `.env.example` | Every env var, documented — **placeholders only**, copy to `.env` and replace each one |
| `.do/app.yaml` | DigitalOcean App Platform spec |

State is held in memory for fast realtime fan-out and written through to Supabase
Postgres (tables: `rooms`, `polls`, `questions`, `agendas`), so a restart or redeploy
doesn't lose a session and past events can be queried for analysis.

## Prototype notes / next steps

This is a working prototype tuned for **trusted internal use** (no auth by design).

Done since the first cut:

- **Durable state.** Sessions, results, Q&A and agenda templates survive restarts and
  redeploys (Supabase Postgres, write-through).
- **CSV export**, per session, from both the presenter console and the dashboard.
- **Load shedding for the expensive path.** The two-lane AI queue bounds concurrency,
  queue depth, retries and timeouts, and sheds with `Retry-After`; per-request body caps
  plus a process-wide body budget bound memory under a full-room upload.
- **Measured burst capacity** at 100 concurrent submitters, with a repeatable test.

Still open — none of this is built:

- **Presenter authentication.** There is none. Anyone who can reach `/present/<CODE>`
  can drive the session, activate polls and dismiss questions. The whole app is
  unauthenticated by design and assumes a trusted network; add SSO before exposing it.
- **General rate limiting.** The AI queue is not one. Ordinary submissions are bounded
  only by the body budget and per-poll caps — a real per-IP limiter is needed before this
  is reachable from the open internet.
- **Horizontal scale.** See *instance_count must stay 1* — needs shared pub/sub and a
  shared live store, not a bigger instance.
- **PDF export** of results.
- **A measured OCR error rate.** `ocrRaw` records what the model transcribed before the
  participant edited it; nobody has yet run the comparison.
