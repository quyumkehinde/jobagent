import { RawJob, UA } from "./types";
import { hostGate, hostCoolingDown, reportRateLimit } from "@/lib/hostgate";
import { fetchGreenhouse } from "./greenhouse";
import { fetchLever } from "./lever";
import { fetchAshby } from "./ashby";
import { fetchRecruitee } from "./recruitee";
import { fetchWorkable } from "./workable";
import { fetchPersonio, personioFeedUrls } from "./personio";
import { fetchSmartrecruiters } from "./smartrecruiters";
import { fetchBreezy } from "./breezy";
import { fetchBamboohr } from "./bamboohr";

// Single source of truth for ATS connectors: how to fetch a board's jobs, how to cheaply
// probe whether {slug} is a real board on that ATS (used by the company-resolution
// engine), the human board URL, and the URL patterns discovery scans for.

// Must stay in sync with the `ats` enum in src/db/schema.ts
export type AtsName =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "recruitee"
  | "workable"
  | "personio"
  | "smartrecruiters"
  | "breezy"
  | "bamboohr";

export interface ProbeResult {
  exists: boolean;
  boardName?: string; // company name as the ATS reports it — used to validate probe hits
  jobCount?: number;
  rateLimited?: boolean; // 429/cooldown — NOT a miss; resolution must defer, not conclude
}

export interface FetchCtx {
  knownExternalIds?: Set<string>; // two-phase connectors skip detail fetches for these
}

export interface AtsConnector {
  ats: AtsName;
  fetchJobs(token: string, companyName: string, companyId: number, ctx?: FetchCtx): Promise<RawJob[]>;
  probe(token: string): Promise<ProbeResult>; // exactly one cheap request; never throws
  boardUrl(token: string): string;
  discoveryPatterns: RegExp[];
}

// Probe helper: fetch JSON, null on any failure. Probes must never throw — a miss is
// data. A 429 is NOT a miss: it returns the "rate-limited" sentinel and cools the host
// down so we stop feeding a tripped limiter (that's how the user's own browser got blocked).
async function probeJson<T>(url: string): Promise<T | "rate-limited" | null> {
  const host = new URL(url).host;
  if (hostCoolingDown(host)) return "rate-limited";
  await hostGate(host);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (res.status === 429) {
      await reportRateLimit(host, "board probing");
      return "rate-limited";
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const greenhouse: AtsConnector = {
  ats: "greenhouse",
  fetchJobs: (t, n, id) => fetchGreenhouse(t, n, id),
  async probe(token) {
    const data = await probeJson<{ name?: string }>(
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}`
    );
    if (data === "rate-limited") return { exists: false, rateLimited: true };
    return data ? { exists: true, boardName: data.name } : { exists: false };
  },
  boardUrl: (t) => `https://boards.greenhouse.io/${t}`,
  discoveryPatterns: [
    /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9_-]+)/gi,
    /greenhouse\.io\/embed\/job_board\?for=([a-z0-9_-]+)/gi,
  ],
};

const lever: AtsConnector = {
  ats: "lever",
  fetchJobs: (t, n, id) => fetchLever(t, n, id),
  async probe(token) {
    // no board name in the payload — resolution falls back to boardUrl HTML title
    const data = await probeJson<unknown[]>(
      `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json&limit=1`
    );
    if (data === "rate-limited") return { exists: false, rateLimited: true };
    return Array.isArray(data) ? { exists: true, jobCount: data.length } : { exists: false };
  },
  boardUrl: (t) => `https://jobs.lever.co/${t}`,
  discoveryPatterns: [/jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]+)/gi],
};

const ashby: AtsConnector = {
  ats: "ashby",
  fetchJobs: (t, n, id) => fetchAshby(t, n, id),
  async probe(token) {
    const data = await probeJson<{ jobs?: unknown[]; name?: string; organizationName?: string }>(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`
    );
    if (data === "rate-limited") return { exists: false, rateLimited: true };
    if (!data || !Array.isArray(data.jobs)) return { exists: false };
    return { exists: true, boardName: data.organizationName || data.name, jobCount: data.jobs.length };
  },
  boardUrl: (t) => `https://jobs.ashbyhq.com/${t}`,
  discoveryPatterns: [/jobs\.ashbyhq\.com\/([a-zA-Z0-9_ %-]+)/gi],
};

const recruitee: AtsConnector = {
  ats: "recruitee",
  fetchJobs: (t, n, id) => fetchRecruitee(t, n, id),
  async probe(token) {
    // no board name in the payload — HTML-title fallback validates
    const data = await probeJson<{ offers?: unknown[] }>(
      `https://${encodeURIComponent(token)}.recruitee.com/api/offers/`
    );
    if (data === "rate-limited") return { exists: false, rateLimited: true };
    if (!data || !Array.isArray(data.offers)) return { exists: false };
    return { exists: true, jobCount: data.offers.length };
  },
  boardUrl: (t) => `https://${t}.recruitee.com`,
  discoveryPatterns: [/([a-z0-9-]+)\.recruitee\.com/gi],
};

const workable: AtsConnector = {
  ats: "workable",
  fetchJobs: (t, n, id) => fetchWorkable(t, n, id),
  async probe(token) {
    // beware: some bad slugs return 200 with a text body — probeJson's parse fails → null
    const data = await probeJson<{ name?: string; jobs?: unknown[] }>(
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=false`
    );
    if (data === "rate-limited") return { exists: false, rateLimited: true };
    if (!data || !data.name) return { exists: false };
    return { exists: true, boardName: data.name, jobCount: Array.isArray(data.jobs) ? data.jobs.length : undefined };
  },
  boardUrl: (t) => `https://apply.workable.com/${t}/`,
  discoveryPatterns: [/apply\.workable\.com\/([a-z0-9_-]+)/gi],
};

const personio: AtsConnector = {
  ats: "personio",
  fetchJobs: (t, n, id, ctx) => fetchPersonio(t, n, id, ctx?.knownExternalIds),
  async probe(token) {
    for (const url of personioFeedUrls(token)) {
      const host = new URL(url).host;
      if (hostCoolingDown(host)) return { exists: false, rateLimited: true };
      await hostGate(host);
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (res.status === 429) {
          await reportRateLimit(host, "probe personio");
          return { exists: false, rateLimited: true };
        }
        if (res.ok) {
          const text = await res.text();
          if (text.includes("<workzag-jobs") || text.includes("<position>")) return { exists: true };
        }
      } catch {
        // try next variant
      }
    }
    return { exists: false };
  },
  boardUrl: (t) => `https://${t}.jobs.personio.de`,
  discoveryPatterns: [/([a-z0-9-]+)\.jobs\.personio\.(?:de|com)/gi],
};

const smartrecruiters: AtsConnector = {
  ats: "smartrecruiters",
  fetchJobs: (t, n, id, ctx) => fetchSmartrecruiters(t, n, id, ctx?.knownExternalIds),
  async probe(token) {
    const data = await probeJson<{ totalFound?: number; content?: { company?: { name?: string } }[] }>(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=1`
    );
    if (data === "rate-limited") return { exists: false, rateLimited: true };
    if (!data || typeof data.totalFound !== "number") return { exists: false };
    return { exists: true, boardName: data.content?.[0]?.company?.name, jobCount: data.totalFound };
  },
  boardUrl: (t) => `https://jobs.smartrecruiters.com/${t}`,
  discoveryPatterns: [/(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9]+)/gi],
};

const breezy: AtsConnector = {
  ats: "breezy",
  fetchJobs: (t, n, id, ctx) => fetchBreezy(t, n, id, ctx?.knownExternalIds),
  async probe(token) {
    const data = await probeJson<unknown[]>(`https://${encodeURIComponent(token)}.breezy.hr/json`);
    if (data === "rate-limited") return { exists: false, rateLimited: true };
    return Array.isArray(data) ? { exists: true, jobCount: data.length } : { exists: false };
  },
  boardUrl: (t) => `https://${t}.breezy.hr`,
  discoveryPatterns: [/([a-z0-9-]+)\.breezy\.hr/gi],
};

const bamboohr: AtsConnector = {
  ats: "bamboohr",
  fetchJobs: (t, n, id, ctx) => fetchBamboohr(t, n, id, ctx?.knownExternalIds),
  async probe(token) {
    const data = await probeJson<{ result?: unknown[] }>(
      `https://${encodeURIComponent(token)}.bamboohr.com/careers/list`
    );
    if (data === "rate-limited") return { exists: false, rateLimited: true };
    if (!data || !Array.isArray(data.result)) return { exists: false };
    return { exists: true, jobCount: data.result.length };
  },
  boardUrl: (t) => `https://${t}.bamboohr.com/careers`,
  discoveryPatterns: [/([a-z0-9-]+)\.bamboohr\.com\/careers/gi],
};

export const CONNECTORS: Partial<Record<AtsName, AtsConnector>> = {
  greenhouse,
  lever,
  ashby,
  recruitee,
  workable,
  personio,
  smartrecruiters,
  breezy,
  bamboohr,
};

export function registerConnector(c: AtsConnector) {
  CONNECTORS[c.ats] = c;
}

// Probe order for company resolution: NL hit-rate first, best-validating first.
// resolve.ts skips entries not (yet) registered in CONNECTORS.
export const PROBE_ORDER = [
  "recruitee",
  "workable",
  "greenhouse",
  "personio",
  "lever",
  "ashby",
  "smartrecruiters",
  "breezy",
  "bamboohr",
];
