import { RawJob, fetchJson, titleLooksRelevant } from "./types";

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl: string;
  createdAt: number;
  descriptionPlain?: string;
  categories?: { location?: string; team?: string; commitment?: string; allLocations?: string[] };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export async function fetchLever(token: string, companyName: string, companyId: number): Promise<RawJob[]> {
  const postings = await fetchJson<LeverPosting[]>(
    `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`
  );
  return (postings || [])
    .filter((p) => titleLooksRelevant(p.text))
    .map((p) => ({
      source: "lever",
      externalId: p.id,
      url: p.hostedUrl,
      applyUrl: p.applyUrl,
      title: p.text,
      companyName,
      companyId,
      location: p.categories?.allLocations?.join(", ") || p.categories?.location,
      salary: p.salaryRange?.min
        ? `${p.salaryRange.currency || ""} ${p.salaryRange.min}-${p.salaryRange.max} ${p.salaryRange.interval || ""}`.trim()
        : undefined,
      description: p.descriptionPlain,
      postedAt: p.createdAt ? new Date(p.createdAt) : undefined,
      raw: { id: p.id, token },
    }));
}
