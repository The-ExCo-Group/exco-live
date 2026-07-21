# ExCo Live

A bespoke, self-hosted interactive polling app in the spirit of Slido / Mentimeter,
styled to **The ExCo Group** brand system. Zero external dependencies — just Node.js.

## What it does

- **Host a session** → get a 5-character join code + shareable link + scannable QR.
- **Audience joins** from any phone/laptop on the network — no login, no install.
- **Four interaction types**, all with live results that push instantly to every screen:
  - Multiple choice (bar chart)
  - Word cloud (sized by frequency)
  - Rating / scale (average + distribution)
  - Open text (responses stream in as cards)
- **Live Q&A board** — audience submits questions and upvotes; host moderates and dismisses.
- **Preloaded run of show** — load all your questions before the event and step through them
  live with Next / Prev (or the ← → arrow keys). Save a run of show as a reusable **agenda
  template** and load it at the next event.

Real-time updates use Server-Sent Events, so nothing needs installing beyond Node.

## Deploying to DigitalOcean App Platform

The app runs as a single always-on Node process (that's what powers the live SSE
broadcast), so it deploys to App Platform as one **web service, single instance**.

1. **Push to GitHub.** Create a private repo under the ExCo org and push this project:
   ```
   git remote add origin git@github.com:your-org/exco-live.git
   git push -u origin main
   ```
2. **Create the app.** In DigitalOcean → **Apps → Create App**, connect that repo.
   App Platform auto-detects Node and the spec in [`.do/app.yaml`](.do/app.yaml).
   (Or from a machine with `doctl` authed to the ExCo team: edit the `repo:` field in
   `.do/app.yaml`, then `doctl apps create --spec .do/app.yaml`.)
3. **Keep it at 1 instance.** The spec pins `instance_count: 1` — required, because live
   results fan out over SSE from one in-memory process. Basic plan (~$5/mo) is plenty.
4. **Custom domain.** Add e.g. `live.excoleadership.com` in the app's Settings → Domains,
   then add the CNAME it gives you to DNS. TLS is automatic.

**Persistence:** State is stored durably in **Supabase Postgres**, so sessions, poll
results, Q&A, and agenda templates survive redeploys/restarts and past events stay
queryable for analysis. In-memory state remains the live/realtime layer; every change
writes through to Supabase, and the server reloads from it on boot. Configure via two
env vars — `SUPABASE_URL` and `SUPABASE_KEY` (the publishable key). If they're unset the
app runs in-memory only (no persistence), which is a safe fallback for local dev.

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

2. **Agenda templates** — **Save agenda** stores the current run of show under a name;
   **Load agenda** preloads it into any session. Reuse the same set across events.

3. **+ New poll** — add or tweak individual questions one at a time.

During the session, **Next ▶ / ◀ Prev** (or the **← →** arrow keys) advance through the run
of show, activating each question live. Reorder with the ↑ / ↓ buttons in the list.

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

## Run it

```bash
cd live-polls
node server.js
# → http://localhost:3000
```

Set a different port with `PORT=8080 node server.js`.

To persist to Supabase locally, set the two env vars first (otherwise it runs
in-memory only):

```bash
export SUPABASE_URL="https://<project>.supabase.co"
export SUPABASE_KEY="sb_publishable_..."
node server.js
```

## Use it

1. Open `http://localhost:3000`, give the session a title, click **Create session**.
   You land on the presenter console (`/present/<CODE>`).
2. Create a poll, click **Create & present** to put it live on the stage.
3. Share the code / link / QR. On the same network, others open the join link
   (e.g. `http://<your-lan-ip>:3000/join/<CODE>`) and vote from their phones.
4. Results animate live on the presenter stage. Switch polls anytime; the audience
   view follows automatically. The Q&A tab is always open to the audience.

> **Finding your LAN IP (macOS):** `ipconfig getifaddr en0`

## How it's built

| File | Role |
|------|------|
| `server.js` | HTTP + SSE server, in-memory room state, write-through persistence to Supabase Postgres (via its REST API) |
| `public/index.html` | Landing (create / join) |
| `public/present.html` + `present.js` | Presenter console & live stage |
| `public/join.html` + `join.js` | Participant app |
| `public/qrcode.js` | Tiny dependency-free QR generator |
| `public/styles.css` | ExCo visual system (tokens, fonts, components) |
| `public/fonts/`, `public/brand/` | ExCo web fonts, logo lockups, favicon |

State is held in memory for fast realtime fan-out and written through to Supabase
Postgres (tables: `rooms`, `polls`, `questions`, `agendas`), so a restart or redeploy
doesn't lose a session and past events can be queried for analysis.

## Prototype notes / next steps

This is a working prototype tuned for **trusted internal use** (no auth by design).
Natural next steps toward production:

- Move state to a real store + horizontally-scalable real-time (Cloudflare Durable
  Objects or Supabase Realtime) so it survives restarts and multiple server instances.
- Add presenter authentication (SSO) if sessions should be access-controlled.
- Export results (CSV / PDF) and a post-session summary.
- Rate-limiting / abuse controls if ever exposed beyond the internal network.
