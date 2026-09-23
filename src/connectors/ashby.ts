import { RawJob, fetchJson, stripHtml, titleLooksRelevant } from "./types";

interface AshbyJob {
  id: string;
  title: string;
  location?: string;
  secondaryLocations?: { location: string }[];
  jobUrl: string;
  applyUrl?: string;
  isRemote?: boolean;
  // "Remote" | "Hybrid" | "OnSite" — the only field that tells the three apart
  workplaceType?: string;
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
      // Ashby sets isRemote=true for hybrid roles as well as fully-remote ones, so it
      // cannot distinguish them — on Ramp's board alone that mislabels 107 hybrid jobs
      // as Remote. workplaceType is authoritative; isRemote is only a fallback for
      // boards that don't report one.
      const mode = j.workplaceType
        ? j.workplaceType.replace(/^onsite$/i, "Onsite") // Ashby spells it "OnSite"
        : j.isRemote
          ? "Remote"
          : null;
      return {
        source: "ashby",
        externalId: j.id,
        url: j.jobUrl,
        applyUrl: j.applyUrl || j.jobUrl,
        title: j.title,
        companyName,
        companyId,
        location: [mode, ...locs].filter(Boolean).join(" · "),
        salary: j.compensation?.compensationTierSummary,
        description: j.descriptionHtml ? stripHtml(j.descriptionHtml) : undefined,
        postedAt: j.publishedAt ? new Date(j.publishedAt) : undefined,
        // structured fields the scorer reads verbatim (see scoring.structuredFields)
        raw: {
          id: j.id,
          token,
          workplaceType: j.workplaceType,
          isRemote: j.isRemote,
          secondaryLocations: j.secondaryLocations?.map((l) => l.location).filter(Boolean),
        },
      };
    });
}
