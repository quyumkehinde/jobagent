# JobAgent

A local-first job-search machine: scrapes jobs from ATS APIs and aggregators, scores every posting against your profile with Gemini, drafts complete applications grounded in your real experience, and tracks everything through a kanban pipeline.

Single user, runs on your machine, all data in `data/jobagent.db`.

📖 **Full architecture & internals:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## Quick start

```bash
npm install
npm run db:push              # create the SQLite schema
npm run seed                 # load ~125 company ATS boards
cp .env.example .env.local   # add your Gemini API key (or set it in Settings)
npm run dev                  # UI at http://localhost:3000
npm run worker               # separate terminal: scrape+score every 3h
```

First run, in the UI:
1. **Profile** → upload your resume (PDF) and fill in work authorization, salary, notice period, links.
2. **Settings** → confirm your Gemini key.
3. **Today** → hit **Scrape & score now**.

## Commands

| command | what it does |
|---|---|
| `npm run dev` | UI + API at localhost:3000 |
| `npm run worker` | scheduled scrape+score loop |
| `npm run db:push` | apply schema changes |
| `npm run seed` | seed company boards (no-op if already seeded) |
| `npx tsx scripts/smoke.ts` | live-test all six connectors |

## Roadmap

- **v1.5:** Gmail status sync, per-job tailored resume PDFs, Indeed/Google Jobs, LinkedIn.
- **v2:** Chrome extension that autofills any application form from the drafted answers.
