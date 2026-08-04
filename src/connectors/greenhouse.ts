import { RawJob, fetchJson, stripHtml, titleLooksRelevant } from "./types";

interface GhJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at: string;
  location?: { name: string };
  content?: string;
  offices?: { name: string }[];
}

export async function fetchGreenhouse(token: string, companyName: string, companyId: number): Promise<RawJob[]> {
  const data = await fetchJson<{ jobs: GhJob[] }>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`
  );
  return (data.jobs || [])
    .filter((j) => titleLooksRelevant(j.title))
    .map((j) => ({
      source: "greenhouse",
      externalId: String(j.id),
      url: j.absolute_url,
      applyUrl: j.absolute_url,
      title: j.title,
      companyName,
      companyId,
      location: j.location?.name || j.offices?.map((o) => o.name).join(", "),
      description: j.content ? stripHtml(decodeEntities(j.content)) : undefined,
      postedAt: j.updated_at ? new Date(j.updated_at) : undefined,
      raw: { id: j.id, token },
    }));
}

// Greenhouse double-encodes HTML entities in `content`
function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
