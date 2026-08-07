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
├── extension/                 # Chrome extension (MV3): autofills ATS forms from drafted answers
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
    │   ├── types.ts           # RawJob, fetchJson, stripHtml, title prefilter (EN+NL)
    │   ├── registry.ts        # ATS connector registry: fetch/probe/boardUrl/patterns
    │   ├── greenhouse.ts      # boards-api.greenhouse.io
    │   ├── lever.ts           # api.lever.co/v0/postings
    │   ├── ashby.ts           # api.ashbyhq.com/posting-api
    │   ├── remoteok.ts        # remoteok.com/api
    │   ├── weworkremotely.ts  # 4 RSS category feeds (hand-rolled parser)
    │   ├── hn.ts              # HN "Who is hiring" via Algolia
    │   ├── yc.ts              # YC job board (ycombinator.com/jobs, public WaaS pages)
    │   ├── recruitee.ts ├── workable.ts ├── personio.ts   # NL/EU ATS pack
    │   ├── smartrecruiters.ts ├── breezy.ts ├── bamboohr.ts
    │   ├── generic.ts         # last-resort careers-page scraper (heuristics + capped LLM)
    │   └── discovery.ts       # extracts ATS board tokens from aggregator posts
    ├── lib/
    │   ├── settings.ts        # settings KV + DEFAULTS
    │   ├── gemini.ts          # Gemini client, throttle, retries, JSON mode
    │   ├── candidate.ts       # builds the candidate summary that grounds all AI calls
    │   ├── ingest.ts          # upsert/dedupe scraped jobs
    │   ├── resolve.ts         # company→board resolution (probing, name validation, web fallback)
    │   ├── scoring.ts         # batch scoring: score + eligibility + visa signal
    │   ├── pipeline.ts        # orchestrates scrape → ingest → discover → score
    │   ├── forms.ts           # ATS form-schema fetching (FormField)
    │   ├── answers.ts         # application drafting: deterministic → QA bank → AI
    │   ├── submit.ts          # programmatic submission (Greenhouse/Lever) + fallback
    │   ├── resume.ts          # PDF → structured JSON via Gemini
    │   ├── latex.ts           # tectonic compile + page count (pdf-lib)
    │   ├── tailor.ts          # per-job resume tailoring with 1-page validation
    │   ├── copilot.ts         # review-page natural-language edit engine
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

### `companies` — ATS boards we poll (and companies still being resolved)
| column | notes |
|---|---|
| `ats` | one of 9 supported ATSs — **nullable**: imported companies have none until resolved |
| `nameNormalized` | indexed dedupe key for bulk imports (diacritics folded, legal suffixes stripped) |
| `careersUrl`, `country`, `resolveStatus`, `resolveNote` | resolution lifecycle: `pending → probing → resolved \| unresolved` (null = pre-existing row) |
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
- `tailoredResumeLatex` + `tailoredResumePdf`: the per-job resume (§8.6); null → submissions attach the default uploaded resume.

### `applicationAnswers` — one row per form field
`fieldKey` (ATS-native input name, used for programmatic submit), `label`, `fieldType` (`text|textarea|select|multiselect|boolean|file`), `options` (JSON for selects), `required`, `answer`, `aiGenerated`, `confidence` (`high|medium|low`), `sortOrder`. Cascade-deleted with the application; wiped and regenerated on re-draft.

### `events` — application timeline
`type` ∈ `created | status_change | submitted | note | interview | reminder`, plus free-text `detail`. Written by the drafting engine, submit engine, and status changes.

### `profile` — single-user key-value store (JSON values)
Well-known keys: `fullName`, `email`, `phone`, `location`, `links` (`{linkedin, github, website}`), `workAuthorization`, `salaryExpectation`, `noticePeriod`, `yearsExperience`, `skills`, `headline`, `extraContext`, `resumeLatex` (base LaTeX source that enables per-job tailoring, §8.6). Resume parsing seeds empty keys; the Profile page edits them.

### `resumes`
Uploaded PDFs (files in `data/resumes/`, metadata + parsed JSON here). Exactly one `isDefault` — it's attached to submissions and grounds the candidate summary.

### `qaBank` — the answer memory
`question`, `normalized` (lowercased, punctuation-stripped; unique), `answer`, `timesUsed`. See §8 for matching rules. This is the system's long-term memory: every question you ever answer gets reused.

### `scrapeRuns` — observability
One row per source per run: `found`, `added`, `error`, timings. Shown on the Today dashboard.

### `locks` — cross-process advisory locks
One row per lock name (`pipeline` is the only one today): `owner` (pid+nonce), `acquiredAt`, `heartbeatAt`. See §6.

### `settings` — runtime config KV
`geminiApiKey`, `scoringModel`, `writerModel`, `queueThreshold`, `maxQueuedPerCompany`, `scrapeIntervalHours`, `maxScoringPerRun`. Defaults in `src/lib/settings.ts` (`DEFAULTS`). `GEMINI_API_KEY` env var takes precedence over the stored key.

## 5. Connectors (`src/connectors/`)

ATS connectors are registered in **`src/connectors/registry.ts`** (`CONNECTORS`), which is the single source of truth for: `fetchJobs` (the sweep), `probe(slug)` (one cheap request — does this board exist on this ATS, and what company name does it report?), `boardUrl`, and `discoveryPatterns` (URL regexes; discovery and the resolution engine both consume them). Adding an ATS = one connector file + one registry entry. Supported ATSs (9): greenhouse, lever, ashby, **recruitee, workable, personio (XML feed), smartrecruiters, breezy, bamboohr** — the latter six chosen for NL/EU hit-rate. SmartRecruiters/Breezy/BambooHR/Personio-without-feed-content are **two-phase** like the YC connector (list first; per-NEW-job detail fetch, capped per run, never ingest without a description). The title prefilter includes Dutch terms (ontwikkelaar/programmeur; excludes verkoop/klantenservice/…).

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

### Company resolution (`src/lib/resolve.ts`) — "paste any company list"
`POST /api/companies/import` takes a pasted list of company names (e.g. the Dutch IND sponsor register; optional CSV `name,country,visaSponsor`), dedupes against existing companies on `nameNormalized` (lowercased, diacritics folded, legal suffixes like B.V./N.V./Stichting/Coöperatie stripped) — existing companies only get their flags updated — and inserts the rest as `resolveStatus: 'pending'`. At the start of every pipeline run, `resolvePendingCompanies()` works through a batch (`resolveBatchPerRun`, default 200): for each company it probes **all 9 ATSs × up to 4 slug candidates — platforms in parallel** (each platform's request rate is paced per registrable domain by `src/lib/hostgate.ts`; 4 companies resolve concurrently, so a 1000-company batch takes minutes, not hours). A 429 from any platform puts it in a 10-minute cooldown and the affected companies **defer** back to pending rather than concluding on partial evidence. **A hit only resolves if the board's self-reported name matches the company** (containment or bigram-Dice ≥ 0.75; name-less ATSs fall back to the board page's HTML title) — slug collisions can never claim someone else's board; ambiguity lands in `unresolved` with an actionable note. Probe misses fall back (capped at `resolveWebPerRun`/run) to: direct domain guesses (`{slug}.nl/.com`, title-validated) → keyless DuckDuckGo HTML search (anomaly-detection aborts it for the run) → homepage → careers-link crawl (incl. `vacatures`/`werken-bij`) → discovery-pattern scan of those pages. Resolved boards sweep the same run. Manual overrides (set ats+token, set careersUrl, retry) via `PATCH /api/companies`.

### Generic careers-page scraper (`src/connectors/generic.ts`) — last resort
Two constituencies get the capped generic sweep (`genericCompaniesPerRun` 10/run, oldest-polled first, source `generic`): unresolved companies **with** a `careersUrl`, and — the vestigial-board fix — **resolved companies whose validated ATS board currently yields zero live jobs** (a Workable ghost while real jobs live on the company site; they drop back out the moment the board produces jobs, so no double-ingestion). Board-empty companies without a stored `careersUrl` get one discovered first (website → careers-link crawl, ≤5/run). Probing itself also prefers a non-empty validated board over an empty one when job counts are known (companies that migrated ATS often leave a dead account behind).

Per company: fetch the page → re-scan for late ATS links (hit → resolve properly) → heuristic job-link extraction (two passes: anchors with text, then href-only with slug-derived titles — SPA job cards nest too deep for text capture; **relevant-sounding text alone never qualifies a link** unless it lives under the careers path, or nav/service pages masquerade as jobs), following up to 4 listing-hub links ("Alle vacatures →", locale hubs) → if heuristics find <3 links, ONE Gemini extraction call (`genericGeminiPerRun` cap) → per-new-job page fetch for the description (`externalId` = URL hash; URL moves are healed by closing detection).

**Headless rendering** (`src/lib/browser.ts`, playwright-core driving the machine's installed Chrome — no bundled-browser download): static-first, render-on-need. The browser is used only when static HTML is an empty shell, when static extraction finds zero relevant links (SPA listings hide behind static nav text), or when a job page fails/403s statically (bot walls reject curl-style fetches but not real Chrome). Budgeted per run (`headlessPagesPerRun` 30 for generic, `headlessResolvePerRun` 10 for the resolution web-fallback, which renders JS-shell careers pages before scanning for ATS embeds). Hosts whose renders time out are skipped for the rest of the company. Dutch careers-subdomain links that only resolve on the brand apex (`werkenbijcoolblue.nl/x` → `coolblue.nl/x`) are retried there automatically. One browser per pipeline run, launched lazily, closed in the run's `finally`. No Chrome installed → rendering reports unavailable and everything degrades to static behavior.

`runPipeline()` — guarded by an in-process `running` flag **and a cross-process advisory lock** (`locks` table row via `src/lib/lock.ts`, heartbeat every 60 s, stealable after 5 min without a heartbeat so a crashed holder self-heals). The worker and the Next.js server share the DB but not memory — the lock is what stops them scoring the same jobs twice. The API returns 409 if either process is running a pipeline:

0. **Resolution** — `resolvePendingCompanies()` (see above) so freshly-imported boards sweep immediately.
1. **ATS sweep** — every `active` company board with a resolved ats+token, sequentially with a 150 ms gap (polite, avoids rate limiting). Registry-dispatched; two-phase sources get their known-externalId sets. Per-board success resets `errorCount`; failure increments it (3 strikes → `active = false`).
2. **Ingest** (`ingest.ts`) — upsert on `(source, externalId)`. Existing jobs: bump `lastSeenAt`, clear `closed`. New jobs: insert with capped field lengths. Returns new-job IDs.
3. **Aggregator sweep** — RemoteOK, WWR, HN, YC, generic careers pages; each wrapped in a `scrapeRuns` row for the dashboard.
4. **Discovery** — scan aggregator results for new ATS boards (patterns from the connector registry, all 9 ATSs).
5. **Closing detection** — board-backed jobs (ATS sources + yc + generic) not re-seen for `closeAfterDays` (default 14) get `closed = true` and drop out of scoring, queueing, and the actionable feed tabs. Aggregator posts are exempt (never re-seen by design).
6. **Scoring** — see §7.

The pipeline is triggered three ways: worker cron, `POST /api/pipeline` (fire-and-forget from the Today page button), or on worker startup.

## 7. Scoring (`src/lib/scoring.ts`)

**What it does:** turns "3,600 postings" into "a ranked queue of jobs you can actually get."

- Selects unscored jobs (`scoredAt IS NULL AND feedStatus = 'new' AND closed = 0`), capped at `maxScoringPerRun` (default 120/run to respect free-tier daily caps), **ordered visa-sponsor-companies-first, then newest-first** — so after a large import the queue is useful from day 1 while the backlog drains.
- Batches **8 jobs per Gemini call** (title + company + location + salary + first 1800 chars of description each), with the candidate summary (§8.1) prepended.
- Uses Gemini **JSON mode** (`responseSchema`) so output is machine-parseable by construction: per job → `{ index, score, eligibility, visaSignal, roleCategory, reasons[≤3] }`.
- The system prompt encodes the hard rules: ineligible jobs score <30 regardless of skill fit; eligibility must be read strictly from location language; ambiguity → `unknown` (which stays eligible — better to over-queue than silently drop); visa `yes` only if stated in the posting.
- **Dismissal feedback loop**: dismissing a job optionally takes a free-text reason ("managerial, needs 8+ yrs, I'm mid-level"). The 15 most recent reasons (with job title + company) ride along in every scoring prompt as explicit negative preferences, and the system prompt instructs the model to sink jobs matching a dismissed pattern and name the pattern in its reasons. Restoring a job removes it from the feedback set.
- **Queueing decision** (code, not model): `score ≥ queueThreshold` **AND** eligibility ∈ {remote-worldwide, remote-region-restricted, onsite-europe, unknown} → `feedStatus = 'queued'`. `country-restricted` can never queue — it lands in the Flagged tab.
- **Per-company cap** (`rebalanceCompanyQueues`, runs after every scoring pass — even a no-op one): each company (matched on normalized `companyName`) keeps at most `maxQueuedPerCompany` (default 5) jobs queued, best score first; the overflow is demoted back to `new`. Demoted jobs keep their scores, so when a slot frees up (dismiss, draft, higher scorer leaves) the next-best is promoted automatically. Only `new ⇄ queued` transitions — dismissed/applied are never touched, and currently-queued jobs win score ties to avoid churn. Note a manually queued job competes on score like any other and can be demoted if the company is over cap.
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
- **Ashby**: the real form, per job, via the hosted board's public GraphQL (`ApiJobPosting` → `applicationForm.sections`) — system fields and custom questions with types (Boolean → Yes/No select, ValueSelect options, LongText → textarea); `fieldKey` is the ATS-native `path`. Ashby's voluntary EEO survey is a separate form and intentionally not drafted.
- **Lever**: the real form, parsed from the server-rendered `/apply` page — standard inputs under their submit names (`name`, `email`, `urls[…]` with real per-posting labels and required flags), custom-question cards decoded from their hidden `baseTemplate` JSON (answers keyed `cards[<id>][field<N>]`, dropdown/multiple-choice options included), and the EEO block (gender/veteran/disability selects + race radios). `submitLever` re-fetches and posts the `baseTemplate` blobs alongside card answers, as the real form does.
- **Workable**: the real form via `GET apply.workable.com/api/v1/jobs/{shortcode}/form` — identity fields, resume, cover letter, `QA_*` screening questions (boolean → Yes/No select) and `CA_*` custom asks. Repeating education/experience groups are skipped (collected interactively on the real form).
- **Recruitee**: the real form via the offer's public API (`{token}.recruitee.com/api/offers/{id}`) — name/email plus per-offer toggles (`options_phone/cv/cover_letter`) and `open_questions` (boolean → Yes/No, string/text, selects with options; video/photo asks skipped).
- Introspection ≠ submittability: `method` is `api` only for sources in `API_SUBMIT_SOURCES` (greenhouse, lever); Ashby/Workable/Recruitee draft against the real form but submit assisted.
- **SmartRecruiters / BambooHR / Personio / aggregators**: a universal `standardFields()` set (name, email, phone, LinkedIn/GitHub/portfolio URLs, location, cover-letter textarea) — SmartRecruiters' apply flow is behind a DataDome captcha and BambooHR/Personio expose no public form API. `introspected: false` → the application is `assisted`-first.
- **YC**: `standardFields()` plus any WaaS custom questions captured at scrape time (stored in `raw.customQuestions`), appended as optional textareas so drafting prepares copy-paste answers for the real form.

### 8.3 Drafting (`src/lib/answers.ts` → `draftApplication(jobId)`)
Answer resolution runs in strict precedence order — cheapest and most reliable first:

1. **Deterministic** — label-regex → profile lookup (name/email/phone/links/location/notice period). Never touches the AI. Marked confidence `high`.
2. **QA bank** — normalized label matched against saved answers (exact, then containment either way). Hits bump `timesUsed`. Reused **verbatim**.
3. **Gemini** — everything left, in one batched JSON-mode call with the candidate summary + full JD. The system prompt enforces: *never invent facts; selects must use provided options exactly; EEO questions prefer "decline to identify" options; unanswerable → best safe attempt + confidence `low`*. Low-confidence and empty answers are visually flagged amber in the review UI.

Plus: file fields get "(default resume)", the JD is snapshotted, and the application lands in `status: ready`. There is no dedicated cover-letter generation call — cover-letter-ish form fields are answered in the batch like any other field (one Gemini call saved per draft); the copilot can still write/edit `application.coverLetter` on request. Re-drafting wipes and regenerates answers. Runtime is ~30–60 s (free-tier pacing).

Drafting runs through a **background draft queue** (`src/lib/draftQueue.ts`, `GET/POST /api/draft-queue`): clicking Draft enqueues the job and returns immediately; an in-process worker drafts strictly one at a time (free-tier Gemini spacing makes parallelism pointless, and serializing avoids racing the naive throttle). The Jobs page polls every 2.5 s while anything is pending and shows per-card status (Queued… / Drafting… / Open draft / Retry draft with the error). The queue is in-memory by design — a dev-server restart or HMR reload drops pending entries; finished entries are pruned after an hour. Re-enqueueing a job while pending/drafting is a no-op.

**The remember loop:** in the review screen, editing an answer with "Remember this answer" checked calls `rememberAnswer()` → upserts the QA bank → step 2 catches it on every future application. The system gets more deterministic (and cheaper) the more you use it.

### 8.4 Submission (`src/lib/submit.ts`)
Philosophy: **never fake a success.** `status: submitted` requires either ATS confirmation or the user saying "I submitted it".

- **Lever**: multipart POST to `jobs.lever.co/{company}/{id}/apply` with standard fields + resume PDF. Success only if the response redirects to `/thanks` or contains a received-confirmation string.
- **Greenhouse** (classic `boards.greenhouse.io` only): GET the job page → extract Rails `authenticity_token` + cookies → bail early if reCAPTCHA/hCaptcha markup is present → multipart POST → verify thank-you text.
- Anything else (Ashby, aggregators, YC — login-gated, captcha-gated boards, unconfirmed responses) throws `SubmitNotPossibleError` → the API returns `{ assisted: true, reason }` → the UI shows the reason and switches you to assisted mode: open the real form, copy each prepared answer, then **"I submitted it manually — mark as applied."**

Expect programmatic submit to work on a minority of boards and shrink over time as ATSs add captchas — the architecture treats it as an optimization, not the core path. The core path is assisted, and it's what the v2 Chrome extension will automate properly (in-browser, so captchas are the user's one click).

### 8.5 Resume parsing (`src/lib/resume.ts`)
Upload (PDF only) → stored in `data/resumes/` → sent inline (base64) to Gemini with a JSON schema → structured `{fullName, contact, links, summary, skills, experience[{company,title,dates,highlights}], education}`. The prompt demands **verbatim highlight extraction** (no embellishment) because these strings ground future answers. Parsed fields seed empty profile keys (`onConflictDoNothing` — never overwrites your edits). Newest upload becomes the default.

### 8.6 Per-job resume tailoring (`src/lib/tailor.ts` + `src/lib/latex.ts`) & the review copilot (`src/lib/copilot.ts`)
When the profile holds a base LaTeX resume (`resumeLatex`, pasted on the Profile page), drafting also produces a per-job copy. The editor is deliberately conservative: the **skills section** is the main target (surface what the JD asks for, but only skills evidenced in the resume/profile — fabrication is prohibited by prompt *and* the skill list is passed explicitly); elsewhere only bullet reordering/tightening. Validation gauntlet, all code: **bounded diff** (>30% changed lines → rejected as overreach) → **compiles** (tectonic, `brew install tectonic`) → **exactly one page** (counted with pdf-lib). Failures feed back to the model for up to 3 attempts; final failure is soft — the application keeps the default resume. Compiled PDFs live in `data/resumes/tailored/app-{id}.pdf` and are attached by the submit engine in place of the default resume.

The **copilot** on the review page takes plain-language instructions ("add Kafka to the resume skills", "remove the last bullet", "make the cover letter mention X", "set the notice period answer to 2 weeks") and returns structured edits — cover letter, resume LaTeX, and/or answer changes by fieldKey — applied server-side. Resume edits pass the same compile + one-page gauntlet (one feedback retry); a failed edit is reported in the reply, never silently saved. Every exchange logs a `copilot` event with what changed.

## 9. API surface (all under `src/app/api/`)

| route | methods | purpose |
|---|---|---|
| `/api/pipeline` | GET / POST | last 20 scrape runs + running flag / fire-and-forget full run (409 if running) |
| `/api/jobs?tab=&q=` | GET / POST | feed query (tabs: `queued`, `new`, `flagged`, `dismissed`, `all`; score desc — except unscored-but-queued jobs, i.e. fresh manual adds, which pin to the top until scored) / **manual add by URL** `{url, title?, companyName?}` — known-ATS URLs (greenhouse, lever, ashby, recruitee, workable incl. `/j/` short links, smartrecruiters) are detected by `src/connectors/fromUrl.ts` and ingested **natively**: single-posting API fetch, real company name, ATS externalId (dedupes against board scrapes — re-adding an already-tracked job promotes it to queued instead of duplicating), linked to the tracked company when the board is known. Unknown hosts fall back to generic extraction (page fetched, rendered if JS) as `source: manual`. Either way: straight to queued, scored next run, never demoted by the model |
| `/api/jobs/[id]` | GET / PATCH | job detail / feedStatus change (queue·dismiss·restore) |
| `/api/jobs/[id]/draft` | POST | run `draftApplication` → `{applicationId, aiCount, needsReview}` |
| `/api/applications?status=` | GET | list (single status or comma list) joined with jobs |
| `/api/applications/[id]` | GET / PATCH | full detail (app+job+answers+events) / update status·notes·nextAction·coverLetter (status changes auto-log events) |
| `/api/applications/[id]/submit` | POST | `{mode:"auto"}` → try programmatic, may return `{assisted:true,reason}`; `{mode:"manual"}` → mark submitted |
| `/api/applications/[id]/tailor` | POST | (re)generate the tailored resume → `{applied, changes, reason?}` |
| `/api/applications/[id]/resume` | GET | the compiled tailored-resume PDF |
| `/api/applications/[id]/copilot` | POST | `{message, history?}` → apply natural-language edits → `{reply, updated}` |
| `/api/answers/[id]` | PATCH | edit an answer; `remember:true` → QA bank |
| `/api/profile` | GET / PUT | full KV / bulk upsert |
| `/api/qa` | GET / POST / DELETE | answer bank CRUD |
| `/api/resumes` | GET / POST | list / multipart upload (`resume` field) + immediate parse |
| `/api/companies?status=&q=&limit=&offset=` | GET / POST / PATCH | filtered+paged boards list with status counts / manual add / enable·disable, board override (`ats`+`token`), `careersUrl`, `retryResolve` |
| `/api/companies/import` | POST | bulk company import `{text, defaults}` → `{added, updatedExisting, skipped}`; resolution happens on the next pipeline run |
| `/api/settings` | GET / PUT | config (API key write-only masked as `•••set•••`) |
| `/api/analytics` | GET | stage counts, per-source submitted/response, per-week submissions, job stats |

No auth anywhere — the app binds to localhost for one user. **Do not port-forward it** without adding auth. This unauthenticated local API is what the Chrome extension (`extension/`, §8.7) talks to.

### 8.7-adjacent: the Chrome extension (`extension/`)
MV3, no build step; load unpacked from `extension/` (README there). Permissions: `activeTab` + `scripting` (injects only when you click) + `storage` + host access to localhost (any port — match patterns can't carry ports; the JobAgent URL is configurable in the popup's Settings). The popup lists `ready` applications (best URL-match to the current tab preselected); **Fill this form** injects `fill.js`, which matches drafted answers to form controls — ATS-native input name first (Lever/classic-Greenhouse names equal our `fieldKey`s), then exact label, then containment — sets values via native setters + `input`/`change` events (so React-based forms register them), picks select options (placeholder options can never match), clicks radios, **drives combobox widgets** (new Greenhouse/Ashby/react-select: type → wait for listbox → commit best option via mousedown; no match → clear and report rather than leave junk), attaches the resume PDF (tailored when present) to file inputs via `DataTransfer`, and drops the cover letter into a cover/comments textarea. Multi-step forms: click Fill again per step. Filled fields outline green, unmatched ones are listed. It never clicks submit — the human reviews, solves the captcha, submits, then hits **mark as applied** in the popup (`POST .../submit {mode:"manual"}`).

## 10. UI (all client components, dark theme, Tailwind v4)

- **Today (`/`)** — stat cards (ready for review / queued / follow-ups due), review shortcuts, due follow-ups, top of queue, scrape-run health table, the **Scrape & score now** button. Polls every 15 s.
- **Jobs (`/jobs`)** — tabbed ranked feed, plus **"+ Add job by URL"** (paste any posting; extraction + queueing is automatic). Each card: score badge (green ≥75 / yellow ≥55 / red), eligibility badge, visa badge, role category, source, salary; **Why?** expands the model's reasons; **Draft application** → enqueues a background draft (per-card status, "Open draft" when ready — queue several without waiting); **Applied** → mark as applied without drafting (`PATCH {feedStatus:"applied"}` creates a minimal submitted application + event so it lands in tracking — for jobs applied to outside the app); Dismiss (with optional why — feeds the scorer)/Restore; **select-all + bulk dismiss** with one shared reason (`PATCH /api/jobs {ids, feedStatus, dismissReason?}`) for cases like "all country-restricted roles of one company"; the Dismissed tab shows stored reasons.
- **Application review (`/applications/[id]`)** — the money screen: status selector, submit panel (auto-submit where supported / open form / mark-as-applied), the **copilot box** (plain-language edits to resume/cover letter/answers), the **resume card** (tailored-vs-default status, view PDF, re-tailor), every answer as an editor (type-appropriate input, confidence badge, copy button, save + remember), cover-letter editor, next-action reminder, notes, event timeline, JD snapshot.
- **Pipeline (`/board`)** — HTML5 drag-and-drop kanban over the application statuses; cards show overdue follow-up warnings; status changes persist via PATCH and log events.
- **Analytics (`/analytics`)** — submitted count, response rate (responded = screening+interviewing+offer over submitted), interviews, offers; by-source table; per-week submissions; funnel stats (discovered → scored → queued → flagged).
- **Profile (`/profile`)** — resume upload/parse status, basics, links, the "what applications always ask" intake (work authorization free-text is deliberately precise-form — it's fed verbatim to the AI), extra context, and the answer bank editor.
- **Settings (`/settings`)** — Gemini key (env-aware), model names, queue threshold, per-company queue cap, scrape interval, per-run scoring cap, close-after days, Gemini call gap (the paid-tier lever), the **bulk-import panel** (paste the IND register → live resolution progress), and the company-board table (add/enable/disable, error visibility, seed/discovery/manual origin badges).

Shared primitives live in `src/components/ui.tsx`; save-on-blur is the form idiom throughout.

## 11. Operations

- **Scheduling**: worker cron `5 */N * * *`. Change N in Settings (worker restart required — it reads the setting at boot). For auto-start on login, wrap `npm run worker` in a LaunchAgent plist.
- **Gemini budget math**: scoring = ~15 calls/120 jobs; drafting ≈ 2 calls/application. At free-tier ~250 requests/day that's roughly 120 scored jobs + ~40 drafted applications — above the 50/day review target. The throttle (§7) keeps RPM legal; RPD exhaustion just delays scoring to the next run.
- **Logging**: `src/lib/log.ts` — a tiny logfmt-style console logger (`2026-08-04T12:00:00.000Z INFO [pipeline] ats sweep done boards=118 found=3402 ms=41250`). Scopes: `worker`, `pipeline` (run/sweep/ingest/discovery, per-board failures + strike counts), `yc` (slice/detail fetch health), `scoring` (batch progress, quota aborts), `gemini` (retries/backoff), `draft` (form fetch, deterministic/QA-bank/AI answer split, timings), `submit` (attempts, assisted fallbacks with reason). Logs go to the stdout/stderr of whichever process ran the code: the worker terminal for cron runs, the `next dev` terminal for UI-triggered actions. Grep by scope, e.g. `npm run worker 2>&1 | grep '\[scoring\]'`.
- **Bulk-import scale math** (6,000-company register): resolution ≈ 180–220k HTTP requests total; at 200 companies/run × 8 runs/day the probe pass completes in ~4 days (web-fallback tail longer at 40/run). Expect 25–40% to resolve to a supported ATS, 10–20% careersUrl-only (generic/manual), the rest unresolved (hospitals/universities/Workday shops — Workday support is the biggest future coverage lever). Sweep cost grows ~0.5 s/board. Scoring backlog 8–15k jobs: free tier drains ~960/day (9–16 days, sponsor-first so the good stuff surfaces immediately); paid tier = raise `maxScoringPerRun`, drop `geminiMinIntervalMs` (~500) in Settings — whole backlog costs single-digit dollars on flash and drains in hours. No code change needed.
- **Headless rendering**: JS-careers-page scraping needs Google Chrome installed (used via playwright-core `channel: "chrome"`); alternatively `npx playwright install chromium`. Without either, rendering is disabled with a logged warning and scraping stays static-only.
- **LaTeX**: resume tailoring needs `tectonic` on PATH (`brew install tectonic`; the first compile downloads packages, later ones are fast). Without it, tailoring fails soft and applications use the default PDF.
- **Reset scoring** (e.g. after changing the prompt): `sqlite3 data/jobagent.db "UPDATE jobs SET scored_at=NULL, score=NULL WHERE feed_status='new';"`
- **Postgres migration path**: swap the Drizzle driver/dialect, re-run `db:push`, replace the two raw-SQL analytics queries (`strftime` → `to_char`). Schema and app code otherwise carry over.

## 12. Known limitations (honest list)

1. **Programmatic submit is fragile by design of the ATS ecosystem** — captchas win; assisted mode is the dependable path (and the v2 extension's job).
2. **SmartRecruiters/BambooHR/Personio forms aren't introspected** (captcha-walled or no public form API) — those get the standard field set; custom questions surface only on the real form. Greenhouse, Ashby, Lever, Workable and Recruitee are all introspected for real since 2026-08.
3. **QA-bank matching is string containment**, not semantic — "Why do you want to work here?" vs "What excites you about this role?" are different entries. (Cheap fix later: embedding similarity.)
4. **Eligibility classification is LLM judgment** — strict prompt + `unknown`-stays-eligible biases it toward false positives (wasted review seconds) over false negatives (missed jobs), which is the right failure direction.
5. **No inbox integration yet** — ghosted/rejected/screening transitions are manual until the v1.5 Gmail sync.
6. **36 of the 125 seed board tokens were stale** at first run — expected; the 3-strike system retires them and discovery/manual adds replace them.
7. **Company resolution is conservative by design** — no name validation, no auto-resolve; expect a meaningful unresolved pile (fix via the Settings override, or wait for better evidence). Empty-but-valid boards (e.g. a company with a vestigial Workable account) resolve "correctly" yet yield no jobs — the real careers site then needs the careersUrl/generic path or a manual override. JS-rendered careers pages are handled by the headless fetcher (§6); the remaining wall is **aggressive bot protection that blocks even real-Chrome headless** — those fail soft with a note. DuckDuckGo can rate-limit the web fallback (detected, non-fatal, probe path unaffected).
8. **YC jobs are snapshot-once and assisted-only** — the detail page is fetched a single time (a later JD edit on YC's side isn't picked up), and applying requires a Work at a Startup login, so programmatic submit is permanently impossible for this source.
9. **Pipeline mutual exclusion is heartbeat-based** — the DB lock (§6) prevents the UI trigger and the worker from running (and double-scoring) simultaneously. The one rough edge: killing a process mid-run leaves its lock row until the 5-minute heartbeat staleness window passes, so a retrigger inside that window gets a 409 — wait it out or delete the `locks` row.

## 13. Roadmap

- **v1.5**: Gmail OAuth sync (auto stage transitions from recruiter emails), per-job tailored resume PDF generation (HTML → PDF, reordered bullets, review-gated), Indeed/Google Jobs scraping, LinkedIn via logged-in browser session, embedding-based QA-bank matching.
- **v2**: Chrome extension — **shipped** (see §9 note / `extension/README.md`), including combobox driving for new-Greenhouse/Ashby widgets, per-step filling for multi-page flows, resume attach, and a configurable app URL. Possible later: per-site fill recipes for bespoke widgets, iframe form support.
