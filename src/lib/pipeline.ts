import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import { fetchGreenhouse } from "@/connectors/greenhouse";
import { fetchLever } from "@/connectors/lever";
import { fetchAshby } from "@/connectors/ashby";
import { fetchRemoteOk } from "@/connectors/remoteok";
import { fetchWeWorkRemotely } from "@/connectors/weworkremotely";
import { fetchHnWhoIsHiring } from "@/connectors/hn";
import { discoverBoards } from "@/connectors/discovery";
import { RawJob } from "@/connectors/types";
import { ingestJobs } from "./ingest";
import { scoreUnscored } from "./scoring";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recordRun(source: string, fn: () => Promise<RawJob[]>): Promise<RawJob[]> {
  const [run] = await db.insert(tables.scrapeRuns).values({ source }).returning({ id: tables.scrapeRuns.id });
  try {
    const raw = await fn();
    const { added } = await ingestJobs(raw);
    await db
      .update(tables.scrapeRuns)
      .set({ finishedAt: new Date(), found: raw.length, added })
      .where(eq(tables.scrapeRuns.id, run.id));
    return raw;
  } catch (err) {
    await db
      .update(tables.scrapeRuns)
      .set({ finishedAt: new Date(), error: String(err).slice(0, 500) })
      .where(eq(tables.scrapeRuns.id, run.id));
    return [];
  }
}

export async function scrapeAtsBoards(): Promise<RawJob[]> {
  const companies = await db.query.companies.findMany({ where: eq(tables.companies.active, true) });
  const all: RawJob[] = [];
  for (const c of companies) {
    try {
      let jobs: RawJob[] = [];
      if (c.ats === "greenhouse") jobs = await fetchGreenhouse(c.token, c.name, c.id);
      else if (c.ats === "lever") jobs = await fetchLever(c.token, c.name, c.id);
      else if (c.ats === "ashby") jobs = await fetchAshby(c.token, c.name, c.id);
      all.push(...jobs);
      await db
        .update(tables.companies)
        .set({ lastPolledAt: new Date(), errorCount: 0, lastError: null })
        .where(eq(tables.companies.id, c.id));
    } catch (err) {
      const errorCount = c.errorCount + 1;
      await db
        .update(tables.companies)
        .set({
          lastPolledAt: new Date(),
          errorCount,
          lastError: String(err).slice(0, 300),
          // 404s mean a bad/renamed board token — retire it after 3 strikes
          active: errorCount < 3,
        })
        .where(eq(tables.companies.id, c.id));
    }
    await sleep(150);
  }
  return all;
}

export interface PipelineResult {
  found: number;
  added: number;
  discovered: number;
  scored: number;
  queued: number;
}

let running = false;

export async function runPipeline(): Promise<PipelineResult> {
  if (running) throw new Error("pipeline already running");
  running = true;
  try {
    const atsJobs = await scrapeAtsBoards();
    const atsIngest = await ingestJobs(atsJobs);

    const aggregated: RawJob[] = [];
    for (const [source, fn] of [
      ["remoteok", fetchRemoteOk],
      ["weworkremotely", fetchWeWorkRemotely],
      ["hn", fetchHnWhoIsHiring],
    ] as const) {
      const raw = await recordRun(source, fn);
      aggregated.push(...raw);
    }

    // grow the company list from ATS links found in aggregator posts
    const discovered = await discoverBoards(aggregated);

    const { scored, queued } = await scoreUnscored();
    return {
      found: atsJobs.length + aggregated.length,
      added: atsIngest.added, // aggregator adds are counted inside recordRun; approximate combined below
      discovered,
      scored,
      queued,
    };
  } finally {
    running = false;
  }
}

export function isPipelineRunning() {
  return running;
}
