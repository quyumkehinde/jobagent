import { RawJob, UA, fetchJson, stripHtml, titleLooksRelevant } from "./types";

interface BreezyPosition {
  id: string;
  friendly_id?: string;
  name: string;
  url?: string;
  published_date?: string;
  location?: { name?: string; is_remote?: boolean };
  type?: { name?: string };
  department?: string;
  description?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Breezy's public position list. Descriptions aren't in the list payload, so for NEW
// jobs we fetch the (server-rendered) position page and strip it — two-phase like yc.ts;
// jobs are never ingested without a description.
export async function fetchBreezy(
  token: string,
  companyName: string,
  companyId: number,
  knownExternalIds: Set<string> = new Set(),
  maxDetailFetches = 25
): Promise<RawJob[]> {
  const positions = await fetchJson<BreezyPosition[]>(`https://${encodeURIComponent(token)}.breezy.hr/json`);
  if (!Array.isArray(positions)) return [];

  const jobs: RawJob[] = [];
  let details = 0;
  for (const p of positions.filter((p) => p.name && titleLooksRelevant(p.name))) {
    const url = p.url || `https://${token}.breezy.hr/p/${p.friendly_id || p.id}`;
    const base: RawJob = {
      source: "breezy",
      externalId: p.id,
      url,
      applyUrl: `${url.replace(/\/$/, "")}/apply`,
      title: p.name,
      companyName,
      companyId,
      location: [p.location?.is_remote ? "Remote" : null, p.location?.name || null].filter(Boolean).join(" · ") || undefined,
      postedAt: p.published_date ? new Date(p.published_date) : undefined,
      raw: { id: p.id, token },
    };

    if (p.description) {
      jobs.push({ ...base, description: stripHtml(p.description) });
      continue;
    }
    if (knownExternalIds.has(p.id)) {
      jobs.push(base);
      continue;
    }
    if (details >= maxDetailFetches) continue;
    details++;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) {
        const text = stripHtml(await res.text());
        if (text.length > 200) jobs.push({ ...base, description: text.slice(0, 20000) });
      }
    } catch {
      // skip — retried next run
    }
    await sleep(150);
  }
  return jobs;
}
