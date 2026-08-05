import { db, tables } from "@/db";
import { eq, isNull, isNotNull, and, desc, inArray } from "drizzle-orm";
import { generateJSON } from "./gemini";
import { buildCandidateSummary } from "./candidate";
import { getSetting, DEFAULTS } from "./settings";
import { createLogger, startTimer } from "./log";

const BATCH_SIZE = 8;
const log = createLogger("scoring");

// eligibility values that are allowed into the review queue
const QUEUE_ELIGIBLE = ["remote-worldwide", "remote-region-restricted", "onsite-europe", "unknown"];

interface ScoreResult {
  index: number;
  score: number;
  eligibility:
    | "remote-worldwide"
    | "remote-region-restricted"
    | "country-restricted"
    | "onsite-europe"
    | "onsite-other"
    | "unknown";
  visaSignal: "yes" | "likely" | "no" | "unknown";
  roleCategory: string;
  reasons: string[];
}

const RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      index: { type: "integer" },
      score: { type: "integer", description: "0-100 overall fit & attainability" },
      eligibility: {
        type: "string",
        enum: [
          "remote-worldwide",
          "remote-region-restricted",
          "country-restricted",
          "onsite-europe",
          "onsite-other",
          "unknown",
        ],
      },
      visaSignal: { type: "string", enum: ["yes", "likely", "no", "unknown"] },
      roleCategory: { type: "string", enum: ["backend", "infra", "fullstack", "mobile", "other"] },
      reasons: { type: "array", items: { type: "string" }, maxItems: 3 },
    },
    required: ["index", "score", "eligibility", "visaSignal", "roleCategory", "reasons"],
  },
};

const SYSTEM = `You are a precise job-matching engine for one specific candidate. For each job you output:
- score: 0-100. Fit of the candidate's skills/seniority AND whether the candidate can actually get/do this job given location rules. Jobs the candidate is ineligible for score under 30 regardless of skill fit.
- eligibility classification:
  * remote-worldwide: remote, open to candidates anywhere.
  * remote-region-restricted: remote but limited to broad regions/timezones (EMEA, Europe, UK+EU, US/EU overlap) that plausibly include the candidate.
  * country-restricted: remote but explicitly only hiring people already located/authorized in one specific country the candidate is not in (e.g. "US only", "must be based in Canada").
  * onsite-europe: onsite/hybrid role located in London or elsewhere in Europe.
  * onsite-other: onsite/hybrid anywhere else.
- visaSignal: does the company/job sponsor visas or offer relocation? "yes" only if stated in the posting; "likely" if the company is known to sponsor; "no" if posting says no sponsorship.
- An explicit statement that the position is NOT eligible for relocation assistance (or that the candidate must already be located in/authorized for the area) is a hard negative for any onsite/hybrid role the candidate would have to move for: set visaSignal "no" unless visa sponsorship is separately and explicitly stated, and score it like an ineligible job (<30). Statements in an [eligibility signals] block override your assumptions about the company.
- Be strict about eligibility: read location requirements carefully. When the posting is ambiguous, use "unknown" rather than guessing.
- If a RECENTLY DISMISSED list is provided, treat those stated reasons as strong negative preferences: a job matching a dismissed pattern (same seniority mismatch, role type, or constraint) must score low, with the pattern named in its reasons.`;

// Enforces the per-company queue cap: for each company, only its `cap` best-scoring
// queue-worthy jobs stay queued; the rest are demoted to `new`. Demoted jobs keep their
// score, so if a slot frees up later (dismiss/draft/re-run) the next-best is promoted
// back automatically. Only ever moves jobs between `new` and `queued` — dismissed and
// applied jobs are untouched, and currently-queued jobs win score ties (no churn).
export async function rebalanceCompanyQueues(
  threshold: number,
  cap: number
): Promise<{ demoted: number; promoted: number }> {
  const rows = await db.query.jobs.findMany({
    where: and(
      inArray(tables.jobs.feedStatus, ["queued", "new"]),
      isNotNull(tables.jobs.scoredAt),
      eq(tables.jobs.closed, false)
    ),
    columns: { id: true, companyName: true, score: true, eligibility: true, feedStatus: true },
  });

  const byCompany = new Map<string, typeof rows>();
  for (const j of rows) {
    // queued jobs always occupy a slot; `new` jobs compete only if queue-worthy
    const queueWorthy =
      j.feedStatus === "queued" ||
      ((j.score ?? 0) >= threshold && QUEUE_ELIGIBLE.includes(j.eligibility ?? ""));
    if (!queueWorthy) continue;
    const key = j.companyName.trim().toLowerCase();
    const list = byCompany.get(key) ?? [];
    list.push(j);
    byCompany.set(key, list);
  }

  let demoted = 0;
  let promoted = 0;
  const queuedFirst = (j: { feedStatus: string }) => (j.feedStatus === "queued" ? 0 : 1);
  for (const list of byCompany.values()) {
    list.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || queuedFirst(a) - queuedFirst(b) || a.id - b.id);
    for (const [i, j] of list.entries()) {
      const want = i < cap ? "queued" : "new";
      if (j.feedStatus === want) continue;
      await db.update(tables.jobs).set({ feedStatus: want }).where(eq(tables.jobs.id, j.id));
      if (want === "queued") promoted++;
      else demoted++;
    }
  }
  if (demoted || promoted) log.info("company queues rebalanced", { cap, demoted, promoted });
  return { demoted, promoted };
}

// ATSs bury the sentences that decide eligibility (relocation, work authorization,
// "must be located in…") at the BOTTOM of postings — past any sane excerpt cap. Pull
// them out of the full text and pin them to the excerpt so truncation can't hide them.
const SIGNAL_RE =
  /(relocat|visa|sponsor|work authori[sz]|authori[sz]ed to work|eligible to work|right to work|must (be|currently) (based|located|reside)|time ?zones?|remote (in|within|from)|citizens?|residents?|work permit)/i;

export function scoringExcerpt(description: string | null): string {
  const d = description || "no description";
  const head = d.slice(0, 1800);
  const signals = d
    .slice(1600) // small overlap so a sentence straddling the cut isn't lost
    .split(/\n+|(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 300 && SIGNAL_RE.test(s));
  if (!signals.length) return head;
  return `${head}\n\n[eligibility signals from further down the posting:]\n${[...new Set(signals)].slice(0, 8).join("\n")}`;
}

export async function scoreUnscored(limit?: number): Promise<{ scored: number; queued: number }> {
  const maxPerRun = limit ?? (await getSetting("maxScoringPerRun", DEFAULTS.maxScoringPerRun));
  const threshold = await getSetting("queueThreshold", DEFAULTS.queueThreshold);
  const perCompanyCap = await getSetting("maxQueuedPerCompany", DEFAULTS.maxQueuedPerCompany);
  const model = await getSetting("scoringModel", DEFAULTS.scoringModel);

  // Priority order: jobs at visa-sponsoring companies first, then newest-first — so the
  // queue is useful from day 1 even while a large import backlog drains on free tier.
  // (SQLite sorts NULLs last under DESC, so sponsor=true > false > unknown/no-company.)
  const unscored = await db
    .select({
      id: tables.jobs.id,
      title: tables.jobs.title,
      companyName: tables.jobs.companyName,
      location: tables.jobs.location,
      salary: tables.jobs.salary,
      description: tables.jobs.description,
      feedStatus: tables.jobs.feedStatus,
    })
    .from(tables.jobs)
    .leftJoin(tables.companies, eq(tables.jobs.companyId, tables.companies.id))
    // "queued" is included for manually-added jobs, which enter the queue unscored
    .where(
      and(
        isNull(tables.jobs.scoredAt),
        inArray(tables.jobs.feedStatus, ["new", "queued"]),
        eq(tables.jobs.closed, false)
      )
    )
    .orderBy(desc(tables.companies.visaSponsor), desc(tables.jobs.firstSeenAt))
    .limit(maxPerRun);
  if (unscored.length === 0) {
    log.info("nothing to score");
    // still rebalance: dismissals/drafts since the last run may have freed queue slots
    await rebalanceCompanyQueues(threshold, perCompanyCap);
    return { scored: 0, queued: 0 };
  }

  const elapsed = startTimer();
  const totalBatches = Math.ceil(unscored.length / BATCH_SIZE);
  log.info("start", { jobs: unscored.length, batches: totalBatches, model, threshold });

  const candidate = await buildCandidateSummary();

  // The dismissal feedback loop: recent reasons the user gave when dismissing jobs are
  // shown to the scorer as negative preferences ("managerial, needs 8+ years, I'm
  // mid-level" should sink the next such match before the user ever sees it).
  const dismissed = await db.query.jobs.findMany({
    where: and(eq(tables.jobs.feedStatus, "dismissed"), isNotNull(tables.jobs.dismissReason)),
    orderBy: desc(tables.jobs.dismissedAt),
    limit: 15,
    columns: { title: true, companyName: true, dismissReason: true },
  });
  const feedback = dismissed.length
    ? `\n\nRECENTLY DISMISSED BY THE CANDIDATE (their stated reasons — score similar jobs LOW):\n${dismissed
        .map((d) => `- "${d.title}" at ${d.companyName}: ${d.dismissReason}`)
        .join("\n")}`
    : "";

  let scored = 0;
  let queued = 0;

  for (let i = 0; i < unscored.length; i += BATCH_SIZE) {
    const batch = unscored.slice(i, i + BATCH_SIZE);
    const jobsText = batch
      .map(
        (j, idx) =>
          `--- JOB ${idx} ---\nTitle: ${j.title}\nCompany: ${j.companyName}\nLocation: ${j.location || "unspecified"}\n${j.salary ? `Salary: ${j.salary}\n` : ""}Description (excerpt):\n${scoringExcerpt(j.description)}`
      )
      .join("\n\n");

    try {
      const results = await generateJSON<ScoreResult[]>(
        `CANDIDATE PROFILE:\n${candidate}${feedback}\n\nScore each of the following ${batch.length} jobs for this candidate. Return one entry per job, using the job's index.\n\n${jobsText}`,
        { model, system: SYSTEM, responseSchema: RESPONSE_SCHEMA, temperature: 0.1 }
      );
      for (const r of results) {
        const job = batch[r.index];
        if (!job) continue;
        const eligible = QUEUE_ELIGIBLE.includes(r.eligibility);
        // a job the user queued by hand stays queued no matter what the model thinks
        const shouldQueue = (r.score >= threshold && eligible) || job.feedStatus === "queued";
        await db
          .update(tables.jobs)
          .set({
            score: r.score,
            eligibility: r.eligibility,
            visaSignal: r.visaSignal,
            roleCategory: r.roleCategory,
            scoreReasons: JSON.stringify(r.reasons),
            scoredAt: new Date(),
            feedStatus: shouldQueue ? "queued" : "new",
          })
          .where(eq(tables.jobs.id, job.id));
        scored++;
        if (shouldQueue) queued++;
      }
      log.info("batch done", { batch: `${Math.floor(i / BATCH_SIZE) + 1}/${totalBatches}`, scored, queued });
    } catch (err) {
      log.error("batch failed", {
        batch: `${Math.floor(i / BATCH_SIZE) + 1}/${totalBatches}`,
        error: String(err).slice(0, 300),
      });
      // stop the run on quota errors; remaining jobs stay unscored for next run
      if (/429|RESOURCE_EXHAUSTED/i.test(String(err))) {
        log.warn("quota exhausted — aborting scoring, remaining jobs wait for next run", {
          remaining: unscored.length - scored,
        });
        break;
      }
    }
  }
  const { demoted, promoted } = await rebalanceCompanyQueues(threshold, perCompanyCap);
  const netQueued = Math.max(0, queued - demoted + promoted);
  log.info("done", { scored, queued: netQueued, ms: elapsed() });
  return { scored, queued: netQueued };
}
