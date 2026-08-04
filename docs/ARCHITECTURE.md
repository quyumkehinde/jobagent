# JobAgent — Architecture & Internals

This document explains every layer of the system: the stack choices, the data model, the scraping pipeline, the AI scoring and drafting machinery, the submission engine, the API surface, the UI, and the operational details (scheduling, rate limits, failure handling). Read this before changing anything.

---

## 1. Design goals & constraints

These were the decisions the project was built around:

| Decision | Choice | Why |
|---|---|---|
| Autonomy model | **Review-then-submit** | Applications must be accurate. The agent prepares everything; a human approves every submission. Nothing is ever sent without explicit approval. |
| Hosting | **Local-first, single user** | Free, private, and scraping from a residential IP gets blocked far less than cloud IPs. No auth layer needed. |
| Stack | **One Next.js app + one worker process, one language** | UI, API routes, scraper, and AI layer share one TypeScript codebase and one set of types. |
| Database | **SQLite (better-sqlite3 + Drizzle ORM)** | Zero setup, no daemon. Drizzle makes a later move to Postgres (for cloud deploy) a config change plus minor SQL dialect fixes. |
| LLM | **Gemini API, free tier** | User has a free key. Everything is throttled and batched to fit free-tier RPM/RPD caps; quota exhaustion degrades gracefully (jobs wait, nothing breaks). |
| Matching rules | Hard-coded eligibility taxonomy | Remote-worldwide / remote-region-restricted / onsite-Europe are eligible; **country-restricted** remote roles (e.g. "US only") are excluded from the queue and surfaced in a separate Flagged list. On-site Europe roles carry a visa-sponsorship signal. |
| Volume | Max top-of-funnel | Everything above the queue threshold (default score ≥ 55) is queued — target 50+/day. |

## 2. System overview

```
                ┌─────────────────────────── worker (npm run worker) ───────────────────────────┐
                │                                                                               │
  Greenhouse ─┐ │   ┌──────────┐    ┌────────────┐    ┌──────────────┐    ┌─────────────────┐   │
  Lever      ─┼─┼──►│ connectors│──►│ ingest/dedupe│──►│ board discovery│──►│ Gemini scoring  │   │
  Ashby      ─┘ │   └──────────┘    └────────────┘    └──────────────┘    └─────────────────┘   │
  RemoteOK   ───┤        every N hours (cron) or on-demand via POST /api/pipeline               │
  WWR (RSS)  ───┤                                                                               │
  HN thread  ───┤                                                                               │
  YC jobs    ───┘                                                                               │
                └───────────────────────────────────────────────────────────────────────────────┘
                                                   │
                                                   ▼
                                          SQLite (data/jobagent.db)
                                                   ▲
                                                   │
                ┌──────────────────────── Next.js app (npm run dev) ────────────────────────────┐
                │  UI pages (React client components)  ◄──►  API route handlers (/api/*)        │
                │  Today · Jobs · Pipeline · Analytics · Profile · Settings · Application review │
                └───────────────────────────────────────────────────────────────────────────────┘
```

Two processes, one database:

- **`npm run dev`** (or `next start`) — the UI and all API routes. The pipeline can also be triggered from here (fire-and-forget) so the worker is optional.
- **`npm run worker`** — `src/worker/index.ts` via `tsx`. Seeds companies if the table is empty, runs the pipeline immediately, then on a cron schedule (default every 3 hours, minute 5).

Both processes open the same SQLite file. WAL mode (`journal_mode = WAL` in `src/db/index.ts`) makes concurrent reader/writer access safe.

## 3. Repository layout

```
jobagent/
├── data/                      # gitignored runtime data
│   ├── jobagent.db            # the entire application state
│   └── resumes/               # uploaded resume PDFs
├── docs/ARCHITECTURE.md       # this file
├── drizzle.config.ts          # drizzle-kit config (sqlite, ./data/jobagent.db)
├── seed/companies.json        # ~125 seed ATS boards {name, ats, token, visaSponsor?}
├── scripts/
│   ├── seed.ts                # npm run seed
│   └── smoke.ts               # live-tests all seven connectors
└── src/
    ├── db/
    │   ├── schema.ts          # ALL tables (Drizzle)
    │   └── index.ts           # db client (better-sqlite3, WAL, FK on)
    ├── connectors/            # one file per job source + shared helpers
    │   ├── types.ts           # RawJob, fetchJson, stripHtml, title prefilter
    │   ├── greenhouse.ts      # boards-api.greenhouse.io
    │   ├── lever.ts           # api.lever.co/v0/postings
    │   ├── ashby.ts           # api.ashbyhq.com/posting-api
    │   ├── remoteok.ts        # remoteok.com/api
    │   ├── weworkremotely.ts  # 4 RSS category feeds (hand-rolled parser)
    │   ├── hn.ts              # HN "Who is hiring" via Algolia
    │   ├── yc.ts              # YC job board (ycombinator.com/jobs, public WaaS pages)
    │   └── discovery.ts       # extracts ATS board tokens from aggregator posts
    ├── lib/
    │   ├── settings.ts        # settings KV + DEFAULTS
    │   ├── gemini.ts          # Gemini client, throttle, retries, JSON mode
    │   ├── candidate.ts       # builds the candidate summary that grounds all AI calls
    │   ├── ingest.ts          # upsert/dedupe scraped jobs
    │   ├── scoring.ts         # batch scoring: score + eligibility + visa signal
    │   ├── pipeline.ts        # orchestrates scrape → ingest → discover → score
    │   ├── forms.ts           # ATS form-schema fetching (FormField)
    │   ├── answers.ts         # application drafting: deterministic → QA bank → AI
    │   ├── submit.ts          # programmatic submission (Greenhouse/Lever) + fallback
    │   ├── resume.ts          # PDF → structured JSON via Gemini
    │   └── seed.ts            # seedCompaniesIfEmpty
    ├── worker/index.ts        # cron loop
    ├── components/ui.tsx      # Card, Badge, ScoreBadge, eligibilityBadge, button/input styles
    └── app/                   # Next.js App Router
        ├── page.tsx           # Today dashboard
        ├── jobs/page.tsx      # ranked feed with tabs
        ├── board/page.tsx     # kanban pipeline
        ├── applications/[id]/page.tsx   # review & submit screen
        ├── analytics/page.tsx
        ├── profile/page.tsx   # resume, intake fields, answer bank
        ├── settings/page.tsx  # Gemini key, models, thresholds, company boards
        └── api/               # route handlers (see §9)
```

Import alias: `@/*` → `src/*` (works in Next and in `tsx` scripts — tsx resolves tsconfig paths).

## 4. Data model (`src/db/schema.ts`)

Timestamps are stored as unix epoch integers (Drizzle `mode: "timestamp"`). JSON is stored as text columns, parsed at the edges.

### `companies` — ATS boards we poll
| column | notes |
|---|---|
| `ats` | `greenhouse \| lever \| ashby` |
| `token` | board slug, e.g. `stripe` → `boards-api.greenhouse.io/v1/boards/stripe`. Unique per (ats, token). |
| `origin` | `seed` (from seed/companies.json) · `discovery` (auto-found in aggregator posts) · `manual` (added in Settings) |
| `visaSponsor` | tri-state: true/false/null(unknown). Shown as a badge; feeds ranking context. |
| `errorCount`, `lastError`, `active` | **3-strike retirement**: each failed poll increments `errorCount`; at 3 the board is deactivated. A successful poll resets to 0. Re-enabling in Settings resets the count. |

### `jobs` — every posting ever seen
- Identity: `(source, externalId)` unique — this is the dedupe key. Re-seen jobs only get `lastSeenAt` bumped.
- Content: `title`, `companyName`, `location`, `salary`, `description` (plain text, capped at 20k chars), `url`, `applyUrl`, `raw` (original payload JSON, keeps the ATS board token for form fetching).
- **AI verdict** (null until scored): `score` (0–100), `eligibility` (the 6-value taxonomy), `visaSignal` (`yes|likely|no|unknown`), `roleCategory` (`backend|infra|fullstack|mobile|other`), `scoreReasons` (JSON string[]), `scoredAt`.
- **Feed lifecycle**: `feedStatus` = `new` (scored below threshold or not yet scored) → `queued` (passed threshold + eligible) → `dismissed` (user) or `applied` (drafted). The Flagged tab is not a status — it's a filter on `eligibility = 'country-restricted'`.

### `applications` — one per job (unique on `jobId`)
- `status`: `drafting → ready → submitted → screening → interviewing → offer | rejected | ghosted | withdrawn`. The kanban columns map 1:1 to these.
- `method`: `api` (programmatic submit) or `assisted` (manual with copy-paste help).
- `formSchema`: JSON `{ introspected: boolean, fields: FormField[] }` — what the form looked like at draft time.
- `jdSnapshot`: the job description frozen at draft time (postings get edited/removed).
- `coverLetter`, `notes`, `nextActionAt` + `nextActionNote` (drives follow-up reminders), `submittedAt`.

### `applicationAnswers` — one row per form field
`fieldKey` (ATS-native input name, used for programmatic submit), `label`, `fieldType` (`text|textarea|select|multiselect|boolean|file`), `options` (JSON for selects), `required`, `answer`, `aiGenerated`, `confidence` (`high|medium|low`), `sortOrder`. Cascade-deleted with the application; wiped and regenerated on re-draft.

### `events` — application timeline
`type` ∈ `created | status_change | submitted | note | interview | reminder`, plus free-text `detail`. Written by the drafting engine, submit engine, and status changes.

### `profile` — single-user key-value store (JSON values)
Well-known keys: `fullName`, `email`, `phone`, `location`, `links` (`{linkedin, github, website}`), `workAuthorization`, `salaryExpectation`, `noticePeriod`, `yearsExperience`, `skills`, `headline`, `extraContext`. Resume parsing seeds empty keys; the Profile page edits them.

### `resumes`
Uploaded PDFs (files in `data/resumes/`, metadata + parsed JSON here). Exactly one `isDefault` — it's attached to submissions and grounds the candidate summary.

### `qaBank` — the answer memory
`question`, `normalized` (lowercased, punctuation-stripped; unique), `answer`, `timesUsed`. See §8 for matching rules. This is the system's long-term memory: every question you ever answer gets reused.

### `scrapeRuns` — observability
One row per source per run: `found`, `added`, `error`, timings. Shown on the Today dashboard.

### `settings` — runtime config KV
`geminiApiKey`, `scoringModel`, `writerModel`, `queueThreshold`, `scrapeIntervalHours`, `maxScoringPerRun`. Defaults in `src/lib/settings.ts` (`DEFAULTS`). `GEMINI_API_KEY` env var takes precedence over the stored key.

## 5. Connectors (`src/connectors/`)

All connectors return the same shape, `RawJob`:

```ts
{ source, externalId, url, applyUrl?, title, companyName, companyId?,
  location?, salary?, description?, postedAt?, raw? }
```

**Title prefilter.** `titleLooksRelevant()` in `types.ts` runs before anything hits the DB: an include regex (software/backend/full-stack/mobile/infra/SRE/golang/typescript/…) and an exclude regex (recruiter, sales, PM, program manager, engineering manager, QA, intern, hardware, …). This is deliberately cheap and broad — its only job is to avoid wasting Gemini quota on obviously irrelevant roles. The real filtering is the scoring pass.

**HTML stripping.** `stripHtml()` converts ATS HTML descriptions to readable plain text (list markers, entity decoding including numeric entities, block-element line breaks).

Per-source notes:

- **Greenhouse** (`greenhouse.ts`): `GET boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`. Public, no auth, no blocking. Content is double-HTML-encoded — decoded before stripping.
- **Lever** (`lever.ts`): `GET api.lever.co/v0/postings/{token}?mode=json`. Includes `descriptionPlain` and structured salary ranges.
- **Ashby** (`ashby.ts`): `GET api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true`. Has `isRemote`, secondary locations, compensation tiers.
- **RemoteOK** (`remoteok.ts`): `GET remoteok.com/api`. Requires a browser User-Agent. First array element is a legal notice — filtered by requiring `id`/`position`/`company`.
- **WeWorkRemotely** (`weworkremotely.ts`): 4 category RSS feeds (programming, back-end, full-stack, devops), hand-rolled regex RSS parser (no XML dependency), dedupes across feeds, splits WWR's `"Company: Role"` title convention.
- **HN Who's Hiring** (`hn.ts`): finds the latest thread via Algolia (`author_whoishiring` stories), pulls up to 3 pages × 1000 comments, keeps **top-level** comments only (`parent_id === storyId`), parses the `Company | Role | Location` first-line convention. Titles are messy by nature — scoring reads the full text, so that's fine.
- **YC job board** (`yc.ts`): the public directory at `ycombinator.com/jobs` (the public face of Work at a Startup). Pages are server-rendered with all data HTML-escaped inside a `data-page` attribute — the connector regex-extracts and JSON-parses it. Two-phase fetch: listing slices (`/jobs/role/software-engineer` + `/remote`, deduped by id) give title/salary/location/**visa sponsorship**; the detail page adds the markdown JD and any WaaS custom application questions. Detail pages are fetched **only for jobs not already in the DB** (the pipeline passes the known-ID set), capped at 40/run with a 200 ms gap; a job whose detail fetch fails or exceeds the cap is omitted entirely and retried next run — never ingested without its JD. Structured facts (visa, min experience, YC batch, job type, one-liner) are prepended to the description so the scoring excerpt sees them. Applying requires a WaaS login → always assisted mode.
- **Discovery** (`discovery.ts`): regex-scans every aggregator job's URL + description for `boards.greenhouse.io/{token}`, `jobs.lever.co/{token}`, `jobs.ashbyhq.com/{token}`, greenhouse embed URLs. New `(ats, token)` pairs are inserted with `origin: "discovery"` and get polled as full boards on the next run. **This is how the company list grows itself.**

Failure isolation: each company board and each aggregator is try/caught individually — one bad source never kills a run.

## 6. The pipeline (`src/lib/pipeline.ts`)

`runPipeline()` — guarded by an in-process `running` flag (409 from the API if already running):

1. **ATS sweep** — every `active` company board, sequentially with a 150 ms gap (polite, avoids rate limiting). Per-board success resets `errorCount`; failure increments it (3 strikes → `active = false`).
2. **Ingest** (`ingest.ts`) — upsert on `(source, externalId)`. Existing jobs: bump `lastSeenAt`, clear `closed`. New jobs: insert with capped field lengths. Returns new-job IDs.
3. **Aggregator sweep** — RemoteOK, WWR, HN; each wrapped in a `scrapeRuns` row for the dashboard.
4. **Discovery** — scan aggregator results for new ATS boards.
5. **Scoring** — see §7.

The pipeline is triggered three ways: worker cron, `POST /api/pipeline` (fire-and-forget from the Today page button), or on worker startup.

## 7. Scoring (`src/lib/scoring.ts`)

**What it does:** turns "3,600 postings" into "a ranked queue of jobs you can actually get."

- Selects unscored jobs (`scoredAt IS NULL AND feedStatus = 'new'`), capped at `maxScoringPerRun` (default 120/run to respect free-tier daily caps).
- Batches **8 jobs per Gemini call** (title + company + location + salary + first 1800 chars of description each), with the candidate summary (§8.1) prepended.
- Uses Gemini **JSON mode** (`responseSchema`) so output is machine-parseable by construction: per job → `{ index, score, eligibility, visaSignal, roleCategory, reasons[≤3] }`.
- The system prompt encodes the hard rules: ineligible jobs score <30 regardless of skill fit; eligibility must be read strictly from location language; ambiguity → `unknown` (which stays eligible — better to over-queue than silently drop); visa `yes` only if stated in the posting.
- **Queueing decision** (code, not model): `score ≥ queueThreshold` **AND** eligibility ∈ {remote-worldwide, remote-region-restricted, onsite-europe, unknown} → `feedStatus = 'queued'`. `country-restricted` can never queue — it lands in the Flagged tab.
- Failure handling: a failed batch is logged and skipped; a 429/quota error aborts the scoring phase — unscored jobs simply wait for the next run. **Quota exhaustion is a delay, never data loss.**

### Gemini plumbing (`src/lib/gemini.ts`)
- Client from `GEMINI_API_KEY` env or the settings table.
- Global throttle: ≥6.5 s between calls (~9 RPM, under the free tier's 10 RPM).
- Retries: 4 attempts on 429/503/UNAVAILABLE/empty, with 20/40/60 s backoff on quota errors.
- `generateJSON<T>()` strips accidental markdown fences before `JSON.parse`.
- Models are settings-driven: `scoringModel` and `writerModel` both default to `gemini-2.5-flash`; switch the writer to `gemini-2.5-pro` if you have quota.

## 8. The application engine

### 8.1 Candidate grounding (`src/lib/candidate.ts`)
`buildCandidateSummary()` renders one plain-text block from: profile KV + parsed default resume (experience with real highlights, education) + the **hard-coded location/visa preference rules**. This summary is prepended to *every* scoring and writing call — it is the single source of truth the AI is allowed to use.

### 8.2 Form schema (`src/lib/forms.ts`)
- **Greenhouse**: the real form, per job, via `GET .../jobs/{id}?questions=true` — standard fields, custom questions, compliance/EEO blocks, with types and select options. `introspected: true`.
- **Lever / Ashby / aggregators**: a universal `standardFields()` set (name, email, phone, LinkedIn/GitHub/portfolio URLs, location, cover-letter textarea) — the fields ~every application asks. `introspected: false` → the application is `assisted`-first.
- **YC**: `standardFields()` plus any WaaS custom questions captured at scrape time (stored in `raw.customQuestions`), appended as optional textareas so drafting prepares copy-paste answers for the real form.

### 8.3 Drafting (`src/lib/answers.ts` → `draftApplication(jobId)`)
Answer resolution runs in strict precedence order — cheapest and most reliable first:

1. **Deterministic** — label-regex → profile lookup (name/email/phone/links/location/notice period). Never touches the AI. Marked confidence `high`.
2. **QA bank** — normalized label matched against saved answers (exact, then containment either way). Hits bump `timesUsed`. Reused **verbatim**.
3. **Gemini** — everything left, in one batched JSON-mode call with the candidate summary + full JD. The system prompt enforces: *never invent facts; selects must use provided options exactly; EEO questions prefer "decline to identify" options; unanswerable → best safe attempt + confidence `low`*. Low-confidence and empty answers are visually flagged amber in the review UI.

Plus: file fields get "(default resume)", a 150–250-word cover letter is generated when the form wants one (or always, for assisted flows), the JD is snapshotted, and the application lands in `status: ready`. Re-drafting wipes and regenerates answers. Runtime is ~30–60 s (free-tier pacing), so the UI button says so.

**The remember loop:** in the review screen, editing an answer with "Remember this answer" checked calls `rememberAnswer()` → upserts the QA bank → step 2 catches it on every future application. The system gets more deterministic (and cheaper) the more you use it.

### 8.4 Submission (`src/lib/submit.ts`)
Philosophy: **never fake a success.** `status: submitted` requires either ATS confirmation or the user saying "I submitted it".

- **Lever**: multipart POST to `jobs.lever.co/{company}/{id}/apply` with standard fields + resume PDF. Success only if the response redirects to `/thanks` or contains a received-confirmation string.
- **Greenhouse** (classic `boards.greenhouse.io` only): GET the job page → extract Rails `authenticity_token` + cookies → bail early if reCAPTCHA/hCaptcha markup is present → multipart POST → verify thank-you text.
- Anything else (Ashby, aggregators, YC — login-gated, captcha-gated boards, unconfirmed responses) throws `SubmitNotPossibleError` → the API returns `{ assisted: true, reason }` → the UI shows the reason and switches you to assisted mode: open the real form, copy each prepared answer, then **"I submitted it manually — mark as applied."**

Expect programmatic submit to work on a minority of boards and shrink over time as ATSs add captchas — the architecture treats it as an optimization, not the core path. The core path is assisted, and it's what the v2 Chrome extension will automate properly (in-browser, so captchas are the user's one click).

### 8.5 Resume parsing (`src/lib/resume.ts`)
Upload (PDF only) → stored in `data/resumes/` → sent inline (base64) to Gemini with a JSON schema → structured `{fullName, contact, links, summary, skills, experience[{company,title,dates,highlights}], education}`. The prompt demands **verbatim highlight extraction** (no embellishment) because these strings ground future answers. Parsed fields seed empty profile keys (`onConflictDoNothing` — never overwrites your edits). Newest upload becomes the default.

## 9. API surface (all under `src/app/api/`)

| route | methods | purpose |
|---|---|---|
| `/api/pipeline` | GET / POST | last 20 scrape runs + running flag / fire-and-forget full run (409 if running) |
| `/api/jobs?tab=&q=` | GET | feed query; tabs: `queued`, `new`, `flagged` (eligibility=country-restricted), `dismissed`, `all`; sorted score desc, nulls last |
| `/api/jobs/[id]` | GET / PATCH | job detail / feedStatus change (queue·dismiss·restore) |
| `/api/jobs/[id]/draft` | POST | run `draftApplication` → `{applicationId, aiCount, needsReview}` |
| `/api/applications?status=` | GET | list (single status or comma list) joined with jobs |
| `/api/applications/[id]` | GET / PATCH | full detail (app+job+answers+events) / update status·notes·nextAction·coverLetter (status changes auto-log events) |
| `/api/applications/[id]/submit` | POST | `{mode:"auto"}` → try programmatic, may return `{assisted:true,reason}`; `{mode:"manual"}` → mark submitted |
| `/api/answers/[id]` | PATCH | edit an answer; `remember:true` → QA bank |
| `/api/profile` | GET / PUT | full KV / bulk upsert |
| `/api/qa` | GET / POST / DELETE | answer bank CRUD |
| `/api/resumes` | GET / POST | list / multipart upload (`resume` field) + immediate parse |
| `/api/companies` | GET / POST / PATCH | boards list / manual add / enable·disable (enable resets strikes) |
| `/api/settings` | GET / PUT | config (API key write-only masked as `•••set•••`) |
| `/api/analytics` | GET | stage counts, per-source submitted/response, per-week submissions, job stats |

No auth anywhere — the app binds to localhost for one user. **Do not port-forward it** without adding auth. This unauthenticated local API is also the planned integration point for the v2 Chrome extension.

## 10. UI (all client components, dark theme, Tailwind v4)

- **Today (`/`)** — stat cards (ready for review / queued / follow-ups due), review shortcuts, due follow-ups, top of queue, scrape-run health table, the **Scrape & score now** button. Polls every 15 s.
- **Jobs (`/jobs`)** — tabbed ranked feed. Each card: score badge (green ≥75 / yellow ≥55 / red), eligibility badge, visa badge, role category, source, salary; **Why?** expands the model's reasons; **Draft application** → drafts and routes to the review screen; Dismiss/Restore.
- **Application review (`/applications/[id]`)** — the money screen: status selector, submit panel (auto-submit where supported / open form / mark-as-applied), every answer as an editor (type-appropriate input, confidence badge, copy button, save + remember), cover-letter editor, next-action reminder, notes, event timeline, JD snapshot.
- **Pipeline (`/board`)** — HTML5 drag-and-drop kanban over the application statuses; cards show overdue follow-up warnings; status changes persist via PATCH and log events.
- **Analytics (`/analytics`)** — submitted count, response rate (responded = screening+interviewing+offer over submitted), interviews, offers; by-source table; per-week submissions; funnel stats (discovered → scored → queued → flagged).
- **Profile (`/profile`)** — resume upload/parse status, basics, links, the "what applications always ask" intake (work authorization free-text is deliberately precise-form — it's fed verbatim to the AI), extra context, and the answer bank editor.
- **Settings (`/settings`)** — Gemini key (env-aware), model names, queue threshold, scrape interval, per-run scoring cap, and the company-board table (add/enable/disable, error visibility, seed/discovery/manual origin badges).

Shared primitives live in `src/components/ui.tsx`; save-on-blur is the form idiom throughout.

## 11. Operations

- **Scheduling**: worker cron `5 */N * * *`. Change N in Settings (worker restart required — it reads the setting at boot). For auto-start on login, wrap `npm run worker` in a LaunchAgent plist.
- **Gemini budget math**: scoring = ~15 calls/120 jobs; drafting ≈ 2 calls/application. At free-tier ~250 requests/day that's roughly 120 scored jobs + ~40 drafted applications — above the 50/day review target. The throttle (§7) keeps RPM legal; RPD exhaustion just delays scoring to the next run.
- **Backup**: copy `data/` (DB + resumes). That's the entire state.
- **Reset scoring** (e.g. after changing the prompt): `sqlite3 data/jobagent.db "UPDATE jobs SET scored_at=NULL, score=NULL WHERE feed_status='new';"`
- **Postgres migration path**: swap the Drizzle driver/dialect, re-run `db:push`, replace the two raw-SQL analytics queries (`strftime` → `to_char`). Schema and app code otherwise carry over.

## 12. Known limitations (honest list)

1. **Programmatic submit is fragile by design of the ATS ecosystem** — captchas win; assisted mode is the dependable path (and the v2 extension's job).
2. **Lever/Ashby custom questions aren't introspected** — those forms get the standard field set; custom questions surface only on the real form (answer bank + extension close this gap later).
3. **QA-bank matching is string containment**, not semantic — "Why do you want to work here?" vs "What excites you about this role?" are different entries. (Cheap fix later: embedding similarity.)
4. **Eligibility classification is LLM judgment** — strict prompt + `unknown`-stays-eligible biases it toward false positives (wasted review seconds) over false negatives (missed jobs), which is the right failure direction.
5. **No inbox integration yet** — ghosted/rejected/screening transitions are manual until the v1.5 Gmail sync.
6. **36 of the 125 seed board tokens were stale** at first run — expected; the 3-strike system retires them and discovery/manual adds replace them.
7. **YC jobs are snapshot-once and assisted-only** — the detail page is fetched a single time (a later JD edit on YC's side isn't picked up), and applying requires a Work at a Startup login, so programmatic submit is permanently impossible for this source.
8. **Single process assumptions** — the `running` flag is in-process; don't run two workers. (The UI trigger and worker colliding is possible but harmless: SQLite WAL + upserts make duplicate ingestion idempotent.)

## 13. Roadmap

- **v1.5**: Gmail OAuth sync (auto stage transitions from recruiter emails), per-job tailored resume PDF generation (HTML → PDF, reordered bullets, review-gated), Indeed/Google Jobs scraping, LinkedIn via logged-in browser session, embedding-based QA-bank matching.
- **v2**: Chrome extension (MV3) — reads drafted answers from the local API, autofills whatever ATS form the user is on, one click per application, captcha solved by the human who's already there. The `applicationAnswers.fieldKey/label/fieldType` model was designed with this consumer in mind.
