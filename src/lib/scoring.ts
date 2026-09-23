import { db, tables } from "@/db";
import { eq, isNull, isNotNull, and, desc, inArray, or, gte, sql } from "drizzle-orm";
import { generateJSON } from "./llm";
import { buildCandidateSummary } from "./candidate";
import { getSetting, getTargetingSettings, DEFAULTS } from "./settings";
import { createLogger, startTimer } from "./log";
import {
  classify,
  shouldQueue,
  boostedScore,
  type WorkMode,
  type RemoteEligibility,
  type OfficeRegion,
  type Seniority,
  type VisaSignal,
  type Domain,
  type TargetCategory,
  type TargetingSettings,
  type DomainBoosts,
} from "./targeting";

const BATCH_SIZE = 8;
const log = createLogger("scoring");
// jobs scored under the old eligibility taxonomy this recently are rescored once (see scoreUnscored)
const RESCORE_WINDOW_DAYS = 30;

interface ScoreResult {
  index: number;
  score: number;
  workMode: WorkMode;
  remoteEligibility: RemoteEligibility;
  officeRegion: OfficeRegion;
  isFintech: boolean;
  fintechSubdomain: string | null;
  minYearsExperience: number | null;
  seniority: Seniority;
  domain: Domain;
  targetCategory: TargetCategory; // the model's proposal — logged, never trusted
  visaSignal: VisaSignal;
  roleCategory: string;
  locationQuote: string | null;
  experienceQuote: string | null;
  reasons: string[];
}

const RESPONSE_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      index: { type: "integer" },
      score: { type: "integer", description: "0-100 skill/seniority fit & attainability, NO domain preference" },
      workMode: { type: "string", enum: ["fully-remote", "hybrid", "onsite", "unknown"] },
      remoteEligibility: {
        type: "string",
        enum: [
          "worldwide",
          "includes-nigeria",
          "africa",
          "emea-incl-africa",
          "timezone-compatible",
          "country-restricted",
          "region-excludes-nigeria",
          "unknown",
        ],
      },
      officeRegion: { type: "string", enum: ["uk-europe", "other", "unknown"] },
      isFintech: { type: "boolean" },
      fintechSubdomain: { type: ["string", "null"] },
      minYearsExperience: { type: ["integer", "null"], description: "minimum years stated in the posting; null if not stated" },
      seniority: { type: "string", enum: ["new-grad", "junior", "mid", "senior", "staff-plus", "unknown"] },
      domain: { type: "string", enum: ["fintech", "infra-devtools-data", "ai-tooling", "general-backend", "other"] },
      targetCategory: { type: "string", enum: ["remote", "early-career", "both", "none"] },
      visaSignal: { type: "string", enum: ["yes", "likely", "no", "unknown"] },
      roleCategory: { type: "string", enum: ["backend", "infra", "fullstack", "mobile", "other"] },
      locationQuote: { type: ["string", "null"], description: "verbatim location / work-mode line from the posting" },
      experienceQuote: { type: ["string", "null"], description: "verbatim experience requirement line from the posting" },
      reasons: { type: "array", items: { type: "string" }, maxItems: 3 },
    },
    required: [
      "index",
      "score",
      "workMode",
      "remoteEligibility",
      "officeRegion",
      "isFintech",
      "fintechSubdomain",
      "minYearsExperience",
      "seniority",
      "domain",
      "targetCategory",
      "visaSignal",
      "roleCategory",
      "locationQuote",
      "experienceQuote",
      "reasons",
    ],
  },
};

const SYSTEM = `You are a precise job-classification engine for one specific candidate, based in Lagos, Nigeria (UTC+1). You classify; code decides what gets queued. For each job output:

FACTS — read strictly from the posting text, the Location line and any [structured ATS fields] block. When a fact is not stated, answer "unknown"/null. Never infer from the company's reputation, HQ city, or what is typical.
- workMode:
  * fully-remote: no office attendance required, ever.
  * hybrid: any required office time ("remote-first but 2 days a month in office", "remote within commuting distance of X" count as hybrid).
  * onsite: office-based.
  * unknown: not stated. A bare city name with no remote/hybrid/onsite wording is unknown, not onsite — unless a structured ATS field says so.
- remoteEligibility (where a remote hire may live):
  * worldwide: "anywhere", "worldwide", "global".
  * includes-nigeria: names Nigeria. africa: names Africa.
  * emea-incl-africa: EMEA without excluding Africa.
  * timezone-compatible: a timezone band that includes UTC+1 (e.g. "UTC-1 to UTC+3", "CET ±3h").
  * country-restricted: limited to specific countries not including Nigeria ("Remote (US only)", "Remote UK", "must be authorized to work in X").
  * region-excludes-nigeria: a region that excludes Nigeria ("Remote Europe/EU", "Americas", "LATAM").
  * unknown: not stated, or the role isn't remote.
  EOR/Deel/Remote.com/contractor mentions are a positive hint but not proof of eligibility on their own.
- officeRegion (for onsite/hybrid roles — where the office is): uk-europe (UK or any European country), other, unknown (not stated, or fully remote).
- minYearsExperience: the minimum years the posting requires (e.g. "3+ years" -> 3, "2-4 years" -> 2); null if not stated. "Any (new grads ok)" -> 0.
- seniority: new-grad (new grad/graduate/campus/entry level), junior, mid, senior (senior/lead), staff-plus (staff/principal/distinguished/manager/head of), unknown. Take it from the title and JD.
- visaSignal: "yes" only if the posting states visa sponsorship/relocation; "likely" if the company is flagged as a known sponsor or a [structured ATS fields] block says it sponsors; "no" if the posting says no sponsorship or no relocation; else "unknown".
- locationQuote / experienceQuote: copy the posting's location/work-mode sentence and its experience-requirement sentence VERBATIM (short). null if there is none.

DOMAIN — judge by what the company's product is, not a stray keyword in the JD. When the JD is vague, use the company description (a "Company:" line, a sector tag, or the "About us" part of the posting).
- isFintech + fintechSubdomain: payments, banking/neobank, lending, cards, treasury, stablecoins/crypto infrastructure and exchanges, trading/market data, billing, accounting/ledger, payroll, FX/remittance, insurtech, fraud/risk/compliance tooling, financial-infrastructure APIs.
- domain: fintech (any of the above, incl. crypto infrastructure) | infra-devtools-data (infrastructure, developer tools, data infrastructure: Go, Kubernetes, Postgres, event pipelines) | ai-tooling (AI tooling, agent infrastructure) | general-backend | other (frontend-only, mobile-only, non-engineering, anything else).

SCORE — 0-100 fit of the candidate's skills and seniority to the role, and whether they can realistically get it. Do NOT add any preference for domain (that is applied in code). Frontend-only, mobile-only and non-engineering roles score low on skill fit. Roles that clearly fail both target categories below score under 30.

TARGET CATEGORIES (propose targetCategory; code re-derives it from your facts):
- remote: fully remote AND hireable from Nigeria (worldwide / includes-nigeria / africa / emea-incl-africa / timezone-compatible) AND mid-level or below.
- early-career: new grad / junior / ≤2 years required, AND either the remote bar above OR onsite/hybrid in the UK/Europe with visaSignal yes|likely.
- both / none.

REASONS — at most 3; the first must cite the category evidence by quoting the location or experience line.

An explicit statement that the role is NOT eligible for relocation (or that the candidate must already be located in/authorized for the area) means visaSignal "no" unless sponsorship is separately stated. Statements in an [eligibility signals] block override your assumptions about the company.
If a RECENTLY DISMISSED list is provided, treat those stated reasons as strong negative preferences: a job matching a dismissed pattern must score low, with the pattern named in its reasons.`;

interface TargetingRow {
  baseScore: number | null;
  domain: Domain | null;
  workMode: WorkMode | null;
  remoteEligibility: RemoteEligibility | null;
  officeRegion: OfficeRegion | null;
  seniority: Seniority | null;
  minYearsExperience: number | null;
  visaSignal: VisaSignal | null;
}

// Derives everything code owns from the model's facts: final score and category.
function decide(row: TargetingRow, t: TargetingSettings & { domainBoosts: DomainBoosts }) {
  const score = row.baseScore == null ? null : boostedScore(row.baseScore, row.domain, t.domainBoosts);
  return { score, ...classify(row, t) };
}

// Enforces the per-company queue cap: for each company, only its `cap` best-scoring
// queue-worthy jobs stay queued; the rest are demoted to `new`. Demoted jobs keep their
// score, so if a slot frees up later (dismiss/draft/re-run) the next-best is promoted
// back automatically. Only ever moves jobs between `new` and `queued` — dismissed and
// applied jobs are untouched, and currently-queued jobs win score ties (no churn).
//
// It first re-derives the code-owned verdict (boosted score, category, needs-check) of
// every targeting-scored job from the stored model facts, so changing domain boosts,
// category toggles or the experience ceiling in Settings takes effect without rescoring.
export async function rebalanceCompanyQueues(
  threshold: number,
  cap: number
): Promise<{ demoted: number; promoted: number }> {
  const targeting = await getTargetingSettings();
  const rows = await db.query.jobs.findMany({
    where: and(
      inArray(tables.jobs.feedStatus, ["queued", "new"]),
      isNotNull(tables.jobs.scoredAt),
      eq(tables.jobs.closed, false)
    ),
    columns: {
      id: true,
      companyName: true,
      score: true,
      feedStatus: true,
      baseScore: true,
      domain: true,
      workMode: true,
      remoteEligibility: true,
      officeRegion: true,
      seniority: true,
      minYearsExperience: true,
      visaSignal: true,
      targetCategory: true,
      needsCheck: true,
    },
  });

  let rederived = 0;
  const byCompany = new Map<string, typeof rows>();
  for (const j of rows) {
    // legacy rows (scored before targeting) have no model facts: never queue-worthy
    let queueWorthy = false;
    if (j.workMode != null) {
      const d = decide(j, targeting);
      if (d.score !== j.score || d.category !== j.targetCategory || d.needsCheck !== j.needsCheck) {
        await db
          .update(tables.jobs)
          .set({ score: d.score, targetCategory: d.category, needsCheck: d.needsCheck })
          .where(eq(tables.jobs.id, j.id));
        j.score = d.score;
        rederived++;
      }
      queueWorthy = shouldQueue(d.score, threshold, d);
    }
    // queued jobs always occupy a slot; `new` jobs compete only if queue-worthy
    if (j.feedStatus !== "queued" && !queueWorthy) continue;
    const key = j.companyName.trim().toLowerCase();
    const list = byCompany.get(key) ?? [];
    list.push(j);
    byCompany.set(key, list);
  }
  if (rederived) log.info("verdicts re-derived from settings", { rederived });

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

// Structured ATS/company facts the scorer should read alongside the free text: Ashby's
// workplaceType/isRemote/secondary locations, YC's minimum experience and visa field,
// and the company's sector tag / sponsor flag / one-liner (domain context for vague JDs).
export function structuredFields(job: {
  source: string;
  raw: string | null;
  sector: string | null;
  visaSponsor: boolean | null;
}): string {
  let raw: Record<string, unknown> = {};
  try {
    raw = job.raw ? JSON.parse(job.raw) : {};
  } catch {
    /* not JSON — no structured fields */
  }
  const lines: string[] = [];
  if (job.source === "ashby") {
    if (typeof raw.workplaceType === "string") lines.push(`workplaceType: ${raw.workplaceType}`);
    if (typeof raw.isRemote === "boolean") lines.push(`isRemote: ${raw.isRemote} (Ashby also sets this for hybrid roles)`);
    if (Array.isArray(raw.secondaryLocations) && raw.secondaryLocations.length)
      lines.push(`secondary locations: ${raw.secondaryLocations.join("; ")}`);
  }
  if (job.source === "yc") {
    if (typeof raw.minExperience === "string") lines.push(`minimum experience: ${raw.minExperience}`);
    if (typeof raw.visa === "string") lines.push(`visa: ${raw.visa}`);
    if (typeof raw.companyOneLiner === "string") lines.push(`company: ${raw.companyOneLiner}`);
  }
  const sector = job.sector ?? (typeof raw.sector === "string" ? raw.sector : null);
  if (sector) lines.push(`company sector: ${sector}`);
  if (job.visaSponsor) lines.push(`company is a known visa sponsor`);
  return lines.length ? `[structured ATS fields]\n${lines.join("\n")}\n` : "";
}

export interface ScoringRunStats {
  scored: number;
  queued: number;
  remote: number;
  earlyCareer: number;
  both: number;
  needsCheck: number;
  flagged: number;
  fintech: number;
}

export async function scoreUnscored(limit?: number): Promise<{ scored: number; queued: number }> {
  const maxPerRun = limit ?? (await getSetting("maxScoringPerRun", DEFAULTS.maxScoringPerRun));
  const threshold = await getSetting("queueThreshold", DEFAULTS.queueThreshold);
  const perCompanyCap = await getSetting("maxQueuedPerCompany", DEFAULTS.maxQueuedPerCompany);
  const model = await getSetting("scoringModel", DEFAULTS.scoringModel);
  const targeting = await getTargetingSettings();

  // Two kinds of work share the per-run cap: never-scored jobs, and the one-off rescore
  // of jobs scored under the old eligibility taxonomy (no workMode) in the last 30 days.
  // Each rescored job gains a workMode, so the rescore drains itself over a few runs.
  // Priority: never-scored first, then early-career titles, then visa-sponsoring
  // companies, then newest. (SQLite sorts NULLs last under DESC.)
  const rescoreCutoff = new Date(Date.now() - RESCORE_WINDOW_DAYS * 24 * 3600_000);
  const earlyTitle = sql`(${tables.jobs.title} like '%new grad%' or ${tables.jobs.title} like '%newgrad%'
    or ${tables.jobs.title} like '%graduate%' or ${tables.jobs.title} like '%entry%'
    or ${tables.jobs.title} like '%junior%' or ${tables.jobs.title} like '%early career%'
    or ${tables.jobs.title} like '%campus%' or ${tables.jobs.title} like '%associate%')`;
  const candidates = await db
    .select({
      id: tables.jobs.id,
      title: tables.jobs.title,
      companyName: tables.jobs.companyName,
      location: tables.jobs.location,
      salary: tables.jobs.salary,
      description: tables.jobs.description,
      feedStatus: tables.jobs.feedStatus,
      scoredAt: tables.jobs.scoredAt,
      source: tables.jobs.source,
      raw: tables.jobs.raw,
      sector: tables.companies.sector,
      visaSponsor: tables.companies.visaSponsor,
    })
    .from(tables.jobs)
    .leftJoin(tables.companies, eq(tables.jobs.companyId, tables.companies.id))
    // "queued" is included for manually-added jobs, which enter the queue unscored
    .where(
      and(
        inArray(tables.jobs.feedStatus, ["new", "queued"]),
        eq(tables.jobs.closed, false),
        or(
          isNull(tables.jobs.scoredAt),
          and(isNull(tables.jobs.workMode), gte(tables.jobs.scoredAt, rescoreCutoff))
        )
      )
    )
    .orderBy(
      desc(sql`${tables.jobs.scoredAt} is null`),
      desc(earlyTitle),
      desc(tables.companies.visaSponsor),
      desc(tables.jobs.firstSeenAt)
    )
    .limit(maxPerRun);
  if (candidates.length === 0) {
    log.info("nothing to score");
    // still rebalance: dismissals/drafts/settings changes since the last run may move slots
    await rebalanceCompanyQueues(threshold, perCompanyCap);
    return { scored: 0, queued: 0 };
  }

  const elapsed = startTimer();
  const totalBatches = Math.ceil(candidates.length / BATCH_SIZE);
  const rescoring = candidates.filter((c) => c.scoredAt != null).length;
  log.info("start", { jobs: candidates.length, rescoring, batches: totalBatches, model, threshold });

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

  const stats: ScoringRunStats = { scored: 0, queued: 0, remote: 0, earlyCareer: 0, both: 0, needsCheck: 0, flagged: 0, fintech: 0 };
  let overridden = 0;
  const [run] = await db
    .insert(tables.scrapeRuns)
    .values({ source: "scoring" })
    .returning({ id: tables.scrapeRuns.id });

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);
    const jobsText = batch
      .map(
        (j, idx) =>
          `--- JOB ${idx} ---\nTitle: ${j.title}\nCompany: ${j.companyName}\nLocation: ${j.location || "unspecified"}\n${j.salary ? `Salary: ${j.salary}\n` : ""}${structuredFields(j)}Description (excerpt):\n${scoringExcerpt(j.description)}`
      )
      .join("\n\n");

    try {
      const results = await generateJSON<ScoreResult[]>(
        `CANDIDATE PROFILE:\n${candidate}${feedback}\n\nClassify and score each of the following ${batch.length} jobs for this candidate. Return one entry per job, using the job's index.\n\n${jobsText}`,
        { model, system: SYSTEM, responseSchema: RESPONSE_SCHEMA, temperature: 0.1 }
      );
      for (const r of results) {
        const job = batch[r.index];
        if (!job) continue;
        const facts = {
          baseScore: r.score,
          domain: r.domain,
          workMode: r.workMode,
          remoteEligibility: r.remoteEligibility,
          officeRegion: r.officeRegion,
          seniority: r.seniority,
          minYearsExperience: r.minYearsExperience,
          visaSignal: r.visaSignal,
        };
        const d = decide(facts, targeting);
        if (r.targetCategory !== d.category) overridden++; // the model's proposal is advisory only
        // a job the user queued by hand (queued before it was ever scored) stays queued
        // no matter what the model thinks; everything else is decided by the rule
        const manual = job.feedStatus === "queued" && job.scoredAt == null;
        const queue = manual || shouldQueue(d.score, threshold, d);
        await db
          .update(tables.jobs)
          .set({
            ...facts,
            score: d.score,
            eligibility: null, // legacy taxonomy — superseded by the fields above
            isFintech: r.isFintech,
            fintechSubdomain: r.isFintech ? r.fintechSubdomain : null,
            targetCategory: d.category,
            needsCheck: d.needsCheck,
            locationQuote: r.locationQuote?.slice(0, 300) || null,
            experienceQuote: r.experienceQuote?.slice(0, 300) || null,
            roleCategory: r.roleCategory,
            scoreReasons: JSON.stringify(r.reasons),
            scoredAt: new Date(),
            feedStatus: queue ? "queued" : "new",
          })
          .where(eq(tables.jobs.id, job.id));
        stats.scored++;
        if (queue) stats.queued++;
        if (d.category === "remote") stats.remote++;
        if (d.category === "early-career") stats.earlyCareer++;
        if (d.category === "both") stats.both++;
        if (d.needsCheck) stats.needsCheck++;
        if (d.flagged) stats.flagged++;
        if (r.isFintech) stats.fintech++;
      }
      log.info("batch done", { batch: `${Math.floor(i / BATCH_SIZE) + 1}/${totalBatches}`, ...stats });
    } catch (err) {
      log.error("batch failed", {
        batch: `${Math.floor(i / BATCH_SIZE) + 1}/${totalBatches}`,
        error: String(err).slice(0, 300),
      });
      // stop the run on quota errors; remaining jobs stay unscored for next run
      if (/429|RESOURCE_EXHAUSTED|usage limit|rate.?limit/i.test(String(err))) {
        log.warn("quota exhausted — aborting scoring, remaining jobs wait for next run", {
          remaining: candidates.length - stats.scored,
        });
        break;
      }
    }
  }
  const { demoted, promoted } = await rebalanceCompanyQueues(threshold, perCompanyCap);
  const netQueued = Math.max(0, stats.queued - demoted + promoted);
  await db
    .update(tables.scrapeRuns)
    .set({
      finishedAt: new Date(),
      found: candidates.length,
      added: netQueued,
      stats: JSON.stringify({ ...stats, queued: netQueued }),
    })
    .where(eq(tables.scrapeRuns.id, run.id));
  log.info("done", { ...stats, queued: netQueued, modelCategoryOverridden: overridden, ms: elapsed() });
  return { scored: stats.scored, queued: netQueued };
}
