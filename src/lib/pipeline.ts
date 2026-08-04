import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import { fetchGreenhouse } from "@/connectors/greenhouse";
import { fetchLever } from "@/connectors/lever";
import { fetchAshby } from "@/connectors/ashby";
import { fetchRemoteOk } from "@/connectors/remoteok";
import { fetchWeWorkRemotely } from "@/connectors/weworkremotely";
import { fetchHnWhoIsHiring } from "@/connectors/hn";
import { fetchYcJobs } from "@/connectors/yc";
import { discoverBoards } from "@/connectors/discovery";
import { RawJob } from "@/connectors/types";
import { ingestJobs } from "./ingest";
import { scoreUnscored } from "./scoring";
import { createLogger, startTimer } from "./log";
import { acquireLock, releaseLock, heartbeatLock, isLockHeld } from "./lock";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = createLogger("pipeline");
const PIPELINE_LOCK = "pipeline";

async function recordRun(source: string, fn: () => Promise<RawJob[]>): Promise<RawJob[]> {
  const [run] = await db.insert(tables.scrapeRuns).values({ source }).returning({ id: tables.scrapeRuns.id });
  const elapsed = startTimer();
  try {
    const raw = await fn();
    const { added } = await ingestJobs(raw);
    await db
      .update(tables.scrapeRuns)
      .set({ finishedAt: new Date(), found: raw.length, added })
      .where(eq(tables.scrapeRuns.id, run.id));
    log.info("aggregator done", { source, found: raw.length, added, ms: elapsed() });
    return raw;
  } catch (err) {
    await db
      .update(tables.scrapeRuns)
      .set({ finishedAt: new Date(), error: String(err).slice(0, 500) })
      .where(eq(tables.scrapeRuns.id, run.id));
    log.error("aggregator failed", { source, ms: elapsed(), error: String(err).slice(0, 300) });
    return [];
  }
}

export async function scrapeAtsBoards(): Promise<RawJob[]> {
  const companies = await db.query.companies.findMany({ where: eq(tables.companies.active, true) });
  const elapsed = startTimer();
  log.info("ats sweep start", { boards: companies.length });
  const all: RawJob[] = [];
  let failed = 0;
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
      failed++;
      const errorCount = c.errorCount + 1;
      log.warn("board poll failed", {
        board: `${c.ats}/${c.token}`,
        strike: errorCount,
        retired: errorCount >= 3,
        error: String(err).slice(0, 200),
      });
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
  log.info("ats sweep done", { boards: companies.length, failed, found: all.length, ms: elapsed() });
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
  // cross-process guard: the worker and the Next.js server share one DB but not memory
  if (!(await acquireLock(PIPELINE_LOCK)))
    throw new Error("pipeline already running in another process (worker or dev server)");
  running = true;
  const heartbeat = setInterval(() => heartbeatLock(PIPELINE_LOCK).catch(() => {}), 60_000);
  heartbeat.unref?.();
  const elapsed = startTimer();
  log.info("run start");
  try {
    const atsJobs = await scrapeAtsBoards();
    const atsIngest = await ingestJobs(atsJobs);
    log.info("ats ingest done", { found: atsJobs.length, added: atsIngest.added });

    // yc fetches a detail page per new job — pass what's already ingested so it skips those
    const ycKnown = new Set(
      (
        await db.query.jobs.findMany({
          where: eq(tables.jobs.source, "yc"),
          columns: { externalId: true },
        })
      ).map((j) => j.externalId)
    );

    const aggregated: RawJob[] = [];
    for (const [source, fn] of [
      ["remoteok", fetchRemoteOk],
      ["weworkremotely", fetchWeWorkRemotely],
      ["hn", fetchHnWhoIsHiring],
      ["yc", () => fetchYcJobs(ycKnown)],
    ] as const) {
      const raw = await recordRun(source, fn);
      aggregated.push(...raw);
    }

    // grow the company list from ATS links found in aggregator posts
    const discovered = await discoverBoards(aggregated);
    if (discovered) log.info("boards discovered", { discovered });

    const { scored, queued } = await scoreUnscored();
    const result = {
      found: atsJobs.length + aggregated.length,
      added: atsIngest.added, // aggregator adds are counted inside recordRun; approximate combined below
      discovered,
      scored,
      queued,
    };
    log.info("run done", { ...result, ms: elapsed() });
    return result;
  } catch (err) {
    log.error("run failed", { ms: elapsed(), error: String(err).slice(0, 300) });
    throw err;
  } finally {
    clearInterval(heartbeat);
    running = false;
    await releaseLock(PIPELINE_LOCK);
  }
}

// True if a pipeline is running in ANY process (this one or the other side of the DB).
export async function isPipelineRunning(): Promise<boolean> {
  return running || isLockHeld(PIPELINE_LOCK);
}
