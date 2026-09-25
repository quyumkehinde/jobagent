# JobAgent

A local-first job-search machine: scrapes jobs from ATS APIs and aggregators, scores every posting against your profile with an LLM (headless Claude Code on your subscription, or any OpenRouter model), queues only the jobs in your two target categories, drafts complete applications grounded in your real experience, and tracks everything through a kanban pipeline.

Single user, runs on your machine, all data in `data/jobagent.db`.

📖 **Full architecture & internals:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Quick start

```bash
npm install
npm run db:push              # create the SQLite schema
npm run seed                 # load ~125 company ATS boards
cp .env.example .env.local   # OPENROUTER_API_KEY if using OpenRouter; the Claude provider needs no key
npm run dev                  # UI at http://localhost:3000
npm run worker               # separate terminal: scrape+score every 3h
```

First run, in the UI:
1. **Profile** → upload your resume (PDF) and fill in work authorization, salary, notice period, links.
2. **Settings** → pick the LLM provider (Claude CLI or OpenRouter) and models; review the target categories.
3. **Today** → hit **Scrape & score now**.

## What gets queued

The model only classifies each posting (work mode, where a remote hire may live, office region, seniority, minimum years, domain, visa); a pure, unit-tested rule in `src/lib/targeting.ts` decides. A job queues when it scores ≥ the threshold **and** is in:

- **A · remote**: fully remote (no office time ever), hireable from Nigeria (worldwide, Africa/Nigeria, EMEA not excluding Africa, or a timezone band including UTC+1), mid-level or below, ≤ 4 years required (`maxYearsRemote`).
- **B · early career**: new grad / junior / ≤ 2 years, and either A's remote bar or onsite/hybrid in the UK/Europe with visa sponsorship stated or likely.

Domain is a score boost, not a gate: fintech/crypto infra +15, infra/devtools/data +10, AI tooling +8 (tunable in Settings). Remote roles restricted to places that exclude Nigeria land in **Flagged**; jobs that would qualify but don't state their work mode or eligibility land in **Needs check**. Details: [ARCHITECTURE §7](docs/ARCHITECTURE.md#7-scoring-srclibscoringts-and-targeting-srclibtargetingts).

## Commands

| command | what it does |
|---|---|
| `npm run dev` | UI + API at localhost:3000 |
| `npm run worker` | scheduled scrape+score loop |
| `npm run db:push` | apply schema changes |
| `npm run seed` | seed company boards (no-op if already seeded) |
| `npm run seed:fintech` | import the fintech company list (`seed/fintech-companies.txt`), tagged `sector=fintech` |
| `npm test` | unit tests (the queueing rule) |
| `npx tsx scripts/eval-scoring.ts` | run the acceptance JDs through the live model + rule (one LLM call) |
| `npx tsx scripts/smoke.ts` | live-test all six connectors |

## Roadmap

- **v1.5:** Gmail status sync, per-job tailored resume PDFs, Indeed/Google Jobs, LinkedIn.
- **v2:** Chrome extension that autofills any application form from the drafted answers.
