import { RawJob, fetchJson, stripHtml, titleLooksRelevant } from "./types";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  jobUrl: string;
  applyUrl?: string;
  isRemote?: boolean;
  publishedAt?: string;
  descriptionHtml?: string;
  compensation?: { compensationTierSummary?: string };
}

export async function fetchAshby(token: string, companyName: string, companyId: number): Promise<RawJob[]> {
  const data = await fetchJson<{ jobs: AshbyJob[] }>(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`
  );
  return (data.jobs || [])
    .filter((j) => titleLooksRelevant(j.title))
    .map((j) => {
      const locs = [j.location, ...(j.secondaryLocations?.map((s) => s.location) || [])].filter(Boolean);
      return {
        source: "ashby",
        externalId: j.id,
        url: j.jobUrl,
        applyUrl: j.applyUrl || j.jobUrl,
        title: j.title,
        companyName,
        companyId,
        location: [j.isRemote ? "Remote" : null, ...locs].filter(Boolean).join(" · "),
        salary: j.compensation?.compensationTierSummary,
        description: j.descriptionHtml ? stripHtml(j.descriptionHtml) : undefined,
        postedAt: j.publishedAt ? new Date(j.publishedAt) : undefined,
        raw: { id: j.id, token },
      };
    });
}
