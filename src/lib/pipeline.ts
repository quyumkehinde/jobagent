import { db, tables } from "@/db";
import { and, asc, eq, inArray, isNotNull, lt, notExists, or, sql } from "drizzle-orm";
import { CONNECTORS } from "@/connectors/registry";
import { fetchRemoteOk } from "@/connectors/remoteok";
import { fetchWeWorkRemotely } from "@/connectors/weworkremotely";
import { fetchHnWhoIsHiring } from "@/connectors/hn";
import { fetchYcJobs } from "@/connectors/yc";
import { discoverBoards } from "@/connectors/discovery";
import { RawJob } from "@/connectors/types";
import { ingestJobs } from "./ingest";
import { scoreUnscored } from "./scoring";
import { resolvePendingCompanies, discoverCareersUrl } from "./resolve";
import { fetchGenericCareers, JsRequiredError } from "@/connectors/generic";
import { createRenderBudget, closeBrowser } from "./browser";
import { reportRateLimit } from "./hostgate";
import { generateJSON } from "./gemini";
import { getSetting, DEFAULTS } from "./settings";
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

// Sources whose connectors fetch a detail page per NEW job — they get the set of
// already-ingested externalIds so re-sweeps stay cheap.
const TWO_PHASE_SOURCES = ["smartrecruiters", "breezy", "bamboohr", "personio"] as const;

async function knownIdsBySource(): Promise<Map<string, Set<string>>> {
  const rows = await db.query.jobs.findMany({
    where: inArray(tables.jobs.source, [...TWO_PHASE_SOURCES]),
    columns: { source: true, externalId: true },
  });
  const map = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!map.has(r.source)) map.set(r.source, new Set());
    map.get(r.source)!.add(r.externalId);
  }
  return map;
}

export async function scrapeAtsBoards(): Promise<RawJob[]> {
  // active boards that actually have a resolved ATS — pending/unresolved imports have none
  const companies = await db.query.companies.findMany({
    where: and(eq(tables.companies.active, true), isNotNull(tables.companies.ats), isNotNull(tables.companies.token)),
  });
  const knownIds = await knownIdsBySource();
  const elapsed = startTimer();
  log.info("ats sweep start", { boards: companies.length });
  const all: RawJob[] = [];
  let failed = 0;
  for (const c of companies) {
    const conn = c.ats ? CONNECTORS[c.ats] : undefined;
    if (!conn || !c.token) continue; // unresolved imports have no board yet
    try {
      const jobs = await conn.fetchJobs(c.token, c.name, c.id, {
        knownExternalIds: knownIds.get(c.ats!),
      });
      all.push(...jobs);
      await db
        .update(tables.companies)
        .set({ lastPolledAt: new Date(), errorCount: 0, lastError: null })
        .where(eq(tables.companies.id, c.id));
    } catch (err) {
      failed++;
      const msg = String(err);
      // a 429 is the ATS throttling US, not a dead board — never count it as a strike
      const rateLimited = /\b429\b|too many request/i.test(msg);
      if (rateLimited) await reportRateLimit(new URL(conn.boardUrl(c.token)).host, `sweep ${c.ats}/${c.token}`);
      const errorCount = rateLimited ? c.errorCount : c.errorCount + 1;
      log.warn("board poll failed", {
        board: `${c.ats}/${c.token}`,
        rateLimited,
        strike: errorCount,
        retired: errorCount >= 3,
        error: msg.slice(0, 200),
      });
      await db
        .update(tables.companies)
        .set({
          lastPolledAt: new Date(),
          errorCount,
          lastError: msg.slice(0, 300),
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

// Generic careers-page sweep, two constituencies:
//  1. unresolved imports that at least have a careersUrl;
//  2. RESOLVED companies whose validated board currently yields ZERO live jobs — vestigial
//     ATS accounts (a Workable ghost while the real jobs live on the company site). These
//     drop back out automatically the moment their board produces jobs.
// Runs as its own aggregator-style source ("generic") with hard caps.
export async function scrapeGenericCareers(): Promise<RawJob[]> {
  const perRun = await getSetting("genericCompaniesPerRun", DEFAULTS.genericCompaniesPerRun);
  const maxJobs = await getSetting("genericJobsPerCompany", DEFAULTS.genericJobsPerCompany);
  const geminiCap = await getSetting("genericGeminiPerRun", DEFAULTS.genericGeminiPerRun);
  const render = createRenderBudget(await getSetting("headlessPagesPerRun", DEFAULTS.headlessPagesPerRun));

  const hasLiveJobs = db
    .select({ one: sql`1` })
    .from(tables.jobs)
    .where(and(eq(tables.jobs.companyId, tables.companies.id), eq(tables.jobs.closed, false)));

  const candidates = await db
    .select()
    .from(tables.companies)
    .where(
      and(
        eq(tables.companies.active, true),
        or(
          and(eq(tables.companies.resolveStatus, "unresolved"), isNotNull(tables.companies.careersUrl)),
          and(isNotNull(tables.companies.ats), isNotNull(tables.companies.token), notExists(hasLiveJobs))
        )
      )
    )
    .orderBy(asc(tables.companies.lastPolledAt))
    .limit(perRun);
  if (!candidates.length) return [];

  // board-empty companies may not have a careersUrl yet — discover a few per run
  let careersDiscoveries = 0;
  for (const c of candidates) {
    if (c.careersUrl || careersDiscoveries >= 5) continue;
    careersDiscoveries++;
    const found = await discoverCareersUrl(c);
    if (found) {
      c.careersUrl = found;
      await db
        .update(tables.companies)
        .set({ resolveNote: `board ${c.ats}/${c.token} has no live jobs — scraping careers page instead` })
        .where(eq(tables.companies.id, c.id));
      log.info("empty board — careers page discovered", { company: c.name, careersUrl: found });
    } else {
      await db.update(tables.companies).set({ lastPolledAt: new Date() }).where(eq(tables.companies.id, c.id));
    }
  }

  const knownRows = await db.query.jobs.findMany({
    where: eq(tables.jobs.source, "generic"),
    columns: { externalId: true },
  });
  const known = new Set(knownRows.map((r) => r.externalId));

  let geminiUsed = 0;
  const tryGeminiExtract = async (pageText: string, companyName: string) => {
    if (geminiUsed >= geminiCap) return null;
    geminiUsed++;
    try {
      const model = await getSetting("scoringModel", DEFAULTS.scoringModel);
      return await generateJSON<{ title: string; url: string; location?: string }[]>(
        `The following is the text of ${companyName}'s careers page. List the open job postings with their absolute or relative link URLs. Only include real job openings.\n\n${pageText}`,
        {
          model,
          responseSchema: {
            type: "array",
            items: {
              type: "object",
              properties: { title: { type: "string" }, url: { type: "string" }, location: { type: "string" } },
              required: ["title", "url"],
            },
          },
          temperature: 0.1,
        }
      );
    } catch {
      return null;
    }
  };

  const all: RawJob[] = [];
  for (const c of candidates) {
    if (!c.careersUrl) continue; // no page to scrape (discovery failed or over cap)
    try {
      const result = await fetchGenericCareers(
        { id: c.id, name: c.name, careersUrl: c.careersUrl },
        { maxJobs, knownExternalIds: known, tryGeminiExtract, render }
      );
      if (result.atsHit) {
        // the careers page linked a supported ATS after all — resolve the company properly
        await db
          .update(tables.companies)
          .set({
            ats: result.atsHit.ats,
            token: result.atsHit.token,
            resolveStatus: "resolved",
            resolveNote: `ATS found on careers page${result.atsHit.boardName ? ` (board "${result.atsHit.boardName}")` : ""}`,
            errorCount: 0,
          })
          .where(eq(tables.companies.id, c.id));
        log.info("generic sweep resolved company via careers page", {
          company: c.name,
          board: `${result.atsHit.ats}/${result.atsHit.token}`,
        });
      }
      all.push(...result.jobs);
      await db.update(tables.companies).set({ lastPolledAt: new Date() }).where(eq(tables.companies.id, c.id));
    } catch (err) {
      const note = err instanceof JsRequiredError ? "js-required" : `generic scrape failed: ${String(err).slice(0, 150)}`;
      await db
        .update(tables.companies)
        .set({ lastPolledAt: new Date(), resolveNote: note })
        .where(eq(tables.companies.id, c.id));
      log.warn("generic scrape skipped", { company: c.name, reason: note });
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
  // cross-process guard: the worker and the Next.js server share one DB but not memory
  if (!(await acquireLock(PIPELINE_LOCK)))
    throw new Error("pipeline already running in another process (worker or dev server)");
  running = true;
  const heartbeat = setInterval(() => heartbeatLock(PIPELINE_LOCK).catch(() => {}), 60_000);
  heartbeat.unref?.();
  const elapsed = startTimer();
  log.info("run start");
  try {
    // resolve pending imports first so freshly-found boards sweep this same run
    try {
      await resolvePendingCompanies();
    } catch (err) {
      log.error("resolution phase failed", { error: String(err).slice(0, 300) });
    }

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
      ["generic", scrapeGenericCareers],
    ] as const) {
      const raw = await recordRun(source, fn);
      aggregated.push(...raw);
    }

    // grow the company list from ATS links found in aggregator posts
    const discovered = await discoverBoards(aggregated);
    if (discovered) log.info("boards discovered", { discovered });

    // board-backed jobs we haven't re-seen in a while are gone from their boards →
    // closed. Aggregator posts (HN/WWR/RemoteOK) are never re-seen by design — exempt.
    const closeAfterDays = await getSetting("closeAfterDays", DEFAULTS.closeAfterDays);
    const cutoff = new Date(Date.now() - closeAfterDays * 24 * 3600_000);
    const closedRes = await db
      .update(tables.jobs)
      .set({ closed: true })
      .where(
        and(
          eq(tables.jobs.closed, false),
          inArray(tables.jobs.source, [...Object.keys(CONNECTORS), "yc", "generic"]),
          lt(tables.jobs.lastSeenAt, cutoff)
        )
      );
    if (closedRes.changes > 0) log.info("stale jobs closed", { closed: closedRes.changes, closeAfterDays });

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
    await closeBrowser(); // never leave a headless Chrome behind in a long-lived process
    await releaseLock(PIPELINE_LOCK);
  }
}

// True if a pipeline is running in ANY process (this one or the other side of the DB).
export async function isPipelineRunning(): Promise<boolean> {
  return running || isLockHeld(PIPELINE_LOCK);
}
