import { RawJob, UA, titleLooksRelevant } from "./types";
import { EARLY_CAREER_TITLE_RE } from "@/lib/targeting";
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
  role?: string; // "eng" for engineering — only set on company-page postings
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
    company?: { slug?: string; name?: string; one_liner?: string };
    customQuestions?: unknown[];
  };
}

const BASE = "https://www.ycombinator.com";
// Listing slices to sweep; postings are deduped by id across slices.
const SLICES = ["/jobs/role/software-engineer", "/jobs/role/software-engineer/remote"];
// The listing pages have no industry or experience filter, so fintech coverage comes from
// the company directory (Algolia-backed, public search key embedded in the page) and each
// hiring fintech company's own jobs page.
const FINTECH_INDUSTRY = "Fintech";

// "Any (new grads ok)", "0-1 years", "1+ years", "2+ years" — early-career on YC's own scale
const EARLY_EXPERIENCE_RE = /new grads|^any\b|^[0-2]\s*(\+|-|–)/i;

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

interface AlgoliaHit {
  slug: string;
  name: string;
  one_liner?: string;
}

// Hiring YC companies tagged Fintech in the directory. The search key is read from the
// directory page each run (it is a public, index-restricted key that YC may rotate).
async function fetchFintechCompanies(): Promise<AlgoliaHit[]> {
  const res = await fetch(`${BASE}/companies`, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`${res.status} for ${BASE}/companies`);
  const m = (await res.text()).match(/AlgoliaOpts\s*=\s*(\{[^}]+\})/);
  if (!m) throw new Error("no AlgoliaOpts on the YC company directory (page markup may have changed)");
  const { app, key } = JSON.parse(m[1]) as { app: string; key: string };
  const hits: AlgoliaHit[] = [];
  for (let page = 0; page < 10; page++) {
    const r = await fetch(`https://${app.toLowerCase()}-dsn.algolia.net/1/indexes/YCCompany_production/query`, {
      method: "POST",
      headers: { "x-algolia-application-id": app, "x-algolia-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "",
        hitsPerPage: 100,
        page,
        facetFilters: [[`industries:${FINTECH_INDUSTRY}`], ["isHiring:true"]],
        attributesToRetrieve: ["slug", "name", "one_liner"],
      }),
    });
    if (!r.ok) throw new Error(`algolia ${r.status}`);
    const data = (await r.json()) as { hits: AlgoliaHit[]; nbPages: number };
    hits.push(...data.hits.filter((h) => h.slug));
    if (page + 1 >= data.nbPages) break;
  }
  return hits;
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
  maxDetailFetches = 60
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
  // fintech companies' own job pages (engineering roles only), tagged for the scorer
  const fintechIds = new Set<number>();
  try {
    const companies = await fetchFintechCompanies();
    for (const c of companies) {
      try {
        const page = await fetchDataPage(`${BASE}/companies/${encodeURIComponent(c.slug)}/jobs`);
        for (const p of page.props?.jobPostings ?? []) {
          if (!p?.id || !p.title || !p.url || (p.role && p.role !== "eng")) continue;
          postings.set(p.id, {
            ...p,
            companyName: p.companyName || c.name,
            companyOneLiner: p.companyOneLiner || c.one_liner,
          });
          fintechIds.add(p.id);
        }
      } catch (err) {
        log.warn("fintech company page failed", { company: c.slug, error: String(err).slice(0, 200) });
      }
      await sleep(150);
    }
    log.info("fintech companies swept", { companies: companies.length, postings: fintechIds.size });
  } catch (err) {
    log.warn("fintech company directory failed", { error: String(err).slice(0, 200) });
  }
  if (!postings.size && sliceErrors.length) throw new Error(sliceErrors[0]);

  // Detail fetches are capped per run, so spend them on the targets first: early-career
  // postings (new grads ok / ≤2 yrs / early-career title), then fintech, then the rest.
  const priority = (p: YcPosting) =>
    (EARLY_EXPERIENCE_RE.test(p.minExperience ?? "") || EARLY_CAREER_TITLE_RE.test(p.title) ? 0 : 2) +
    (fintechIds.has(p.id) ? 0 : 1);
  const ordered = [...postings.values()].sort((a, b) => priority(a) - priority(b));

  const jobs: RawJob[] = [];
  let detailFetches = 0;
  let detailFailures = 0;
  let overCap = 0;
  let known = 0;
  for (const p of ordered) {
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
            minExperience: job.minExperience ?? p.minExperience,
            companyOneLiner: job.companyOneLiner ?? p.companyOneLiner,
            ...(fintechIds.has(p.id) ? { sector: "fintech" } : {}),
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
