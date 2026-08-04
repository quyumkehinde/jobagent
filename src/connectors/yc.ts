import { RawJob, UA, titleLooksRelevant } from "./types";
import { createLogger } from "@/lib/log";

const log = createLogger("yc");

interface YcPosting {
  id: number;
  title: string;
  url: string; // relative, e.g. /companies/foo/jobs/AbC123-senior-engineer
  applyUrl?: string;
  location?: string;
  type?: string;
  salaryRange?: string;
  equityRange?: string;
  minExperience?: string;
  visa?: string;
  companyName?: string;
  companyBatchName?: string;
  companyOneLiner?: string;
}

interface YcJobDetail extends YcPosting {
  description?: string;
  interview_process?: string;
}

interface YcDataPage {
  props?: {
    jobPostings?: YcPosting[];
    job?: YcJobDetail;
    company?: { slug?: string };
    customQuestions?: unknown[];
  };
}

const BASE = "https://www.ycombinator.com";
// Listing slices to sweep; postings are deduped by id across slices.
const SLICES = ["/jobs/role/software-engineer", "/jobs/role/software-engineer/remote"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The pages are server-rendered with all data HTML-escaped inside a data-page attribute.
// &amp; must be decoded last, otherwise "&amp;quot;" would double-decode to a stray quote.
function unescapeAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function fetchDataPage(url: string): Promise<YcDataPage> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const html = await res.text();
  const m = html.match(/data-page="([^"]+)"/);
  if (!m) throw new Error(`no data-page JSON at ${url} (page markup may have changed)`);
  try {
    return JSON.parse(unescapeAttr(m[1])) as YcDataPage;
  } catch {
    throw new Error(`unparseable data-page JSON at ${url}`);
  }
}

function toRawJob(p: YcPosting): RawJob {
  return {
    source: "yc",
    externalId: String(p.id),
    url: BASE + p.url,
    applyUrl: p.applyUrl,
    title: p.title.trim(),
    companyName: (p.companyName || "YC startup").trim(),
    location: p.location,
    salary: p.salaryRange
      ? p.salaryRange + (p.equityRange ? ` + ${p.equityRange} equity` : "")
      : undefined,
  };
}

// Structured facts the listing carries that scoring should see — its excerpt only
// reads the first 1800 chars of the description, so they go on top.
function buildDescription(job: YcJobDetail): string {
  const lines: string[] = [];
  if (job.visa) lines.push(`Visa sponsorship: ${job.visa}`);
  if (job.minExperience) lines.push(`Minimum experience: ${job.minExperience}`);
  if (job.companyBatchName) lines.push(`YC batch: ${job.companyBatchName}`);
  if (job.type) lines.push(`Job type: ${job.type}`);
  if (job.companyOneLiner) lines.push(`Company: ${job.companyOneLiner}`);
  const parts = [lines.join("\n")];
  if (job.description?.trim()) parts.push(job.description.trim());
  if (job.interview_process?.trim()) parts.push(`Interview process:\n${job.interview_process.trim()}`);
  return parts.filter(Boolean).join("\n\n");
}

// Scrapes the public YC job board (ycombinator.com/jobs, the public face of Work at a
// Startup). Two-phase: listing slices give id/title/salary/visa; the detail page (fetched
// only for jobs not in knownExternalIds, capped per run) adds the markdown JD. Jobs whose
// detail fetch fails or falls over the cap are omitted entirely — (source, externalId)
// dedupe makes the first insert permanent, so a job must never be ingested without its JD.
// Applying requires a WaaS login, so these applications are always assisted-mode.
export async function fetchYcJobs(
  knownExternalIds: Set<string> = new Set(),
  maxDetailFetches = 40
): Promise<RawJob[]> {
  const postings = new Map<number, YcPosting>();
  const sliceErrors: string[] = [];
  for (const slice of SLICES) {
    try {
      const page = await fetchDataPage(BASE + slice);
      for (const p of page.props?.jobPostings ?? []) {
        if (p?.id && p.title && p.url) postings.set(p.id, p);
      }
    } catch (err) {
      log.warn("slice fetch failed", { slice, error: String(err).slice(0, 200) });
      sliceErrors.push(String(err));
    }
  }
  if (!postings.size && sliceErrors.length) throw new Error(sliceErrors[0]);

  const jobs: RawJob[] = [];
  let detailFetches = 0;
  let detailFailures = 0;
  let overCap = 0;
  let known = 0;
  for (const p of postings.values()) {
    if (!titleLooksRelevant(p.title.trim())) continue;
    if (knownExternalIds.has(String(p.id))) {
      // Already ingested — listing-only is enough for ingest to bump lastSeenAt/reopen.
      known++;
      jobs.push(toRawJob(p));
      continue;
    }
    if (detailFetches >= maxDetailFetches) {
      overCap++; // waits for the next run
      continue;
    }
    detailFetches++;
    try {
      const page = await fetchDataPage(BASE + p.url);
      const job = page.props?.job;
      if (job?.description) {
        const customQuestions = page.props?.customQuestions;
        jobs.push({
          ...toRawJob({ ...p, ...job }),
          description: buildDescription(job),
          raw: {
            companySlug: page.props?.company?.slug,
            visa: job.visa,
            batch: job.companyBatchName,
            ...(Array.isArray(customQuestions) && customQuestions.length
              ? { customQuestions }
              : {}),
          },
        });
      }
    } catch (err) {
      // skip — the job stays absent from the DB and is retried next run
      detailFailures++;
      log.warn("detail fetch failed, will retry next run", { job: p.url, error: String(err).slice(0, 200) });
    }
    await sleep(200);
  }
  log.info("sweep done", {
    listed: postings.size,
    known,
    detailFetched: detailFetches,
    detailFailed: detailFailures,
    overCap,
  });
  return jobs;
}
