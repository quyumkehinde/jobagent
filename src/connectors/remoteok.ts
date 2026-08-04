import { RawJob, fetchJson, stripHtml, titleLooksRelevant } from "./types";

interface RemoteOkJob {
  id?: string | number;
  slug?: string;
  position?: string;
  company?: string;
  location?: string;
  url?: string;
  apply_url?: string;
  description?: string;
  date?: string;
  salary_min?: number;
  salary_max?: number;
  tags?: string[];
}

export async function fetchRemoteOk(): Promise<RawJob[]> {
  const data = await fetchJson<RemoteOkJob[]>("https://remoteok.com/api");
  return data
    .filter((j) => j.id && j.position && j.company)
    .filter((j) => titleLooksRelevant(j.position!))
    .map((j) => ({
      source: "remoteok",
      externalId: String(j.id),
      url: j.url || `https://remoteok.com/remote-jobs/${j.slug || j.id}`,
      applyUrl: j.apply_url ? `https://remoteok.com${j.apply_url}` : undefined,
      title: j.position!,
      companyName: j.company!,
      location: j.location || "Remote",
      salary: j.salary_min ? `$${j.salary_min}-${j.salary_max}` : undefined,
      description: j.description ? stripHtml(j.description) : undefined,
      postedAt: j.date ? new Date(j.date) : undefined,
      raw: { tags: j.tags },
    }));
}
