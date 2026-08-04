import { db, tables } from "@/db";
import { eq, isNull, and } from "drizzle-orm";
import { generateJSON } from "./gemini";
import { buildCandidateSummary } from "./candidate";
import { getSetting, DEFAULTS } from "./settings";
import { createLogger, startTimer } from "./log";

const BATCH_SIZE = 8;
const log = createLogger("scoring");

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
- Be strict about eligibility: read location requirements carefully. When the posting is ambiguous, use "unknown" rather than guessing.`;

export async function scoreUnscored(limit?: number): Promise<{ scored: number; queued: number }> {
  const maxPerRun = limit ?? (await getSetting("maxScoringPerRun", DEFAULTS.maxScoringPerRun));
  const threshold = await getSetting("queueThreshold", DEFAULTS.queueThreshold);
  const model = await getSetting("scoringModel", DEFAULTS.scoringModel);

  const unscored = await db.query.jobs.findMany({
    where: and(isNull(tables.jobs.scoredAt), eq(tables.jobs.feedStatus, "new"), eq(tables.jobs.closed, false)),
    limit: maxPerRun,
    columns: { id: true, title: true, companyName: true, location: true, salary: true, description: true },
  });
  if (unscored.length === 0) {
    log.info("nothing to score");
    return { scored: 0, queued: 0 };
  }

  const elapsed = startTimer();
  const totalBatches = Math.ceil(unscored.length / BATCH_SIZE);
  log.info("start", { jobs: unscored.length, batches: totalBatches, model, threshold });

  const candidate = await buildCandidateSummary();
  let scored = 0;
  let queued = 0;

  for (let i = 0; i < unscored.length; i += BATCH_SIZE) {
    const batch = unscored.slice(i, i + BATCH_SIZE);
    const jobsText = batch
      .map(
        (j, idx) =>
          `--- JOB ${idx} ---\nTitle: ${j.title}\nCompany: ${j.companyName}\nLocation: ${j.location || "unspecified"}\n${j.salary ? `Salary: ${j.salary}\n` : ""}Description (excerpt):\n${(j.description || "no description").slice(0, 1800)}`
      )
      .join("\n\n");

    try {
      const results = await generateJSON<ScoreResult[]>(
        `CANDIDATE PROFILE:\n${candidate}\n\nScore each of the following ${batch.length} jobs for this candidate. Return one entry per job, using the job's index.\n\n${jobsText}`,
        { model, system: SYSTEM, responseSchema: RESPONSE_SCHEMA, temperature: 0.1 }
      );
      for (const r of results) {
        const job = batch[r.index];
        if (!job) continue;
        const eligible = ["remote-worldwide", "remote-region-restricted", "onsite-europe", "unknown"].includes(
          r.eligibility
        );
        const shouldQueue = r.score >= threshold && eligible;
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
  log.info("done", { scored, queued, ms: elapsed() });
  return { scored, queued };
}
