import { RawJob, fetchJson, stripHtml, titleLooksRelevant } from "./types";

interface RecruiteeOffer {
  id: number;
  title: string;
  slug?: string;
  careers_url?: string;
  location?: string;
  city?: string;
  country?: string;
  country_code?: string;
  description?: string; // HTML
  requirements?: string; // HTML
  created_at?: string;
  status?: string;
}

// Recruitee (Dutch ATS, heavy NL adoption). Public careers-site API, offers inline.
// Wrong slugs return HTTP 404 with a JSON error body — callers must check shape, not
// just status (handled by fetchJson throwing on !ok).
export async function fetchRecruitee(token: string, companyName: string, companyId: number): Promise<RawJob[]> {
  const data = await fetchJson<{ offers?: RecruiteeOffer[] }>(
    `https://${encodeURIComponent(token)}.recruitee.com/api/offers/`
  );
  return (data.offers || [])
    .filter((o) => o.title && titleLooksRelevant(o.title))
    .map((o) => {
      const html = [o.description, o.requirements].filter(Boolean).join("\n");
      return {
        source: "recruitee",
        externalId: String(o.id),
        url: o.careers_url || `https://${token}.recruitee.com/o/${o.slug || o.id}`,
        applyUrl: o.careers_url ? `${o.careers_url}/c/new` : undefined,
        title: o.title,
        companyName,
        companyId,
        location: o.location || [o.city, o.country || o.country_code].filter(Boolean).join(", ") || undefined,
        description: html ? stripHtml(html) : undefined,
        postedAt: o.created_at ? new Date(o.created_at) : undefined,
        raw: { id: o.id, token },
      };
    });
}
