import { RawJob, fetchJson, stripHtml, titleLooksRelevant } from "./types";

interface BambooListItem {
  id: string | number;
  jobOpeningName: string;
  departmentLabel?: string;
  department?: string;
  employmentStatusLabel?: string;
  location?: { city?: string; state?: string; postedDate?: string };
  isRemote?: boolean | null;
  locationType?: string; // "0" onsite | "1" hybrid | "2" remote (observed values vary)
}

interface BambooDetail {
  result?: {
    jobOpening?: {
      description?: string; // HTML
      datePosted?: string;
    };
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// BambooHR public careers API. List has no descriptions → two-phase per-job detail
// fetch for new jobs only, like yc.ts; never ingest without a description.
export async function fetchBamboohr(
  token: string,
  companyName: string,
  companyId: number,
  knownExternalIds: Set<string> = new Set(),
  maxDetailFetches = 25
): Promise<RawJob[]> {
  const t = encodeURIComponent(token);
  const list = await fetchJson<{ result?: BambooListItem[] }>(`https://${t}.bamboohr.com/careers/list`);
  const items = (list.result || []).filter((j) => j.jobOpeningName && titleLooksRelevant(j.jobOpeningName));

  const jobs: RawJob[] = [];
  let details = 0;
  for (const j of items) {
    const externalId = String(j.id);
    const base: RawJob = {
      source: "bamboohr",
      externalId,
      url: `https://${t}.bamboohr.com/careers/${j.id}`,
      applyUrl: `https://${t}.bamboohr.com/careers/${j.id}`,
      title: j.jobOpeningName,
      companyName,
      companyId,
      location: [
        j.isRemote || j.locationType === "2" ? "Remote" : null,
        [j.location?.city, j.location?.state].filter(Boolean).join(", ") || null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
      raw: { id: j.id, token },
    };

    if (knownExternalIds.has(externalId)) {
      jobs.push(base);
      continue;
    }
    if (details >= maxDetailFetches) continue;
    details++;
    try {
      const detail = await fetchJson<BambooDetail>(`https://${t}.bamboohr.com/careers/${j.id}/detail`);
      const html = detail.result?.jobOpening?.description;
      if (html) {
        const posted = detail.result?.jobOpening?.datePosted;
        jobs.push({
          ...base,
          description: stripHtml(html),
          postedAt: posted ? new Date(posted) : undefined,
        });
      }
    } catch {
      // skip — retried next run
    }
    await sleep(150);
  }
  return jobs;
}
