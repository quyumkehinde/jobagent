import { RawJob, fetchJson, stripHtml, titleLooksRelevant } from "./types";

interface SrPosting {
  id: string;
  uuid?: string;
  name: string;
  refNumber?: string;
  releasedDate?: string;
  location?: { city?: string; region?: string; country?: string; remote?: boolean };
  company?: { name?: string; identifier?: string };
}

interface SrList {
  totalFound?: number;
  content?: SrPosting[];
}

interface SrDetail {
  jobAd?: {
    sections?: Record<string, { title?: string; text?: string }>;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// SmartRecruiters public postings API. The list has no descriptions — those need a
// per-posting fetch, so this is two-phase like yc.ts: detail-fetch only jobs not
// already ingested (knownExternalIds), capped per run; a job is never emitted without
// its description (first ingest is permanent). All companies share api.smartrecruiters.com,
// so detail fetches keep a >=200ms gap.
export async function fetchSmartrecruiters(
  token: string,
  companyName: string,
  companyId: number,
  knownExternalIds: Set<string> = new Set(),
  maxDetailFetches = 40
): Promise<RawJob[]> {
  const list = await fetchJson<SrList>(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=100`
  );
  const postings = (list.content || []).filter((p) => p.name && titleLooksRelevant(p.name));

  const jobs: RawJob[] = [];
  let details = 0;
  for (const p of postings) {
    const externalId = p.id;
    const base: RawJob = {
      source: "smartrecruiters",
      externalId,
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${p.id}`,
      title: p.name,
      companyName: p.company?.name || companyName,
      companyId,
      location: [
        p.location?.remote ? "Remote" : null,
        [p.location?.city, p.location?.region, p.location?.country].filter(Boolean).join(", ") || null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
      postedAt: p.releasedDate ? new Date(p.releasedDate) : undefined,
      raw: { id: p.id, token },
    };

    if (knownExternalIds.has(externalId)) {
      jobs.push(base); // listing-only: ingest just bumps lastSeenAt
      continue;
    }
    if (details >= maxDetailFetches) continue; // waits for the next run
    details++;
    try {
      const detail = await fetchJson<SrDetail>(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings/${p.id}`
      );
      const sections = Object.values(detail.jobAd?.sections || {});
      const description = sections
        .map((s) => [s.title, s.text ? stripHtml(s.text) : ""].filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n\n");
      if (description) jobs.push({ ...base, description });
      // no description → omit; retried next run
    } catch {
      // skip — stays absent from the DB, retried next run
    }
    await sleep(200);
  }
  return jobs;
}
