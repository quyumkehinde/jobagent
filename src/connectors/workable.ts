import { RawJob, fetchJson, stripHtml, titleLooksRelevant } from "./types";

interface WorkableJob {
  title: string;
  shortcode: string;
  code?: string;
  country?: string;
  city?: string;
  state?: string;
  remote?: boolean;
  telecommuting?: boolean;
  department?: string;
  url?: string;
  application_url?: string;
  description?: string; // HTML, present with details=true
  created_at?: string;
}

interface WorkableAccount {
  name?: string;
  jobs?: WorkableJob[];
}

// Workable's public careers-widget API. NOTE: some bad slugs return HTTP 200 with a
// bare "Not Found" text body — always parse and verify shape.
export async function fetchWorkable(token: string, companyName: string, companyId: number): Promise<RawJob[]> {
  const data = await fetchJson<WorkableAccount>(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}?details=true`
  );
  if (!Array.isArray(data.jobs)) return [];
  return data.jobs
    .filter((j) => j.title && j.shortcode && titleLooksRelevant(j.title))
    .map((j) => ({
      source: "workable",
      externalId: j.shortcode,
      url: j.url || `https://apply.workable.com/${token}/j/${j.shortcode}/`,
      applyUrl: j.application_url || (j.url ? `${j.url.replace(/\/$/, "")}/apply` : undefined),
      title: j.title,
      companyName: data.name || companyName,
      companyId,
      location: [
        j.remote || j.telecommuting ? "Remote" : null,
        [j.city, j.state, j.country].filter(Boolean).join(", ") || null,
      ]
        .filter(Boolean)
        .join(" · ") || undefined,
      description: j.description ? stripHtml(j.description) : undefined,
      postedAt: j.created_at ? new Date(j.created_at) : undefined,
      raw: { shortcode: j.shortcode, token },
    }));
}
