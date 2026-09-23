import { EARLY_CAREER_TITLE_RE } from "@/lib/targeting";

export interface RawJob {
  source: string;
  externalId: string;
  url: string;
  applyUrl?: string;
  title: string;
  companyName: string;
  companyId?: number;
  location?: string;
  salary?: string;
  description?: string;
  postedAt?: Date;
  raw?: unknown;
}

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, Accept: "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#x27;/gi, "'")
    .replace(/&#x2f;|&#47;/gi, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Cheap title prefilter so we only spend LLM quota on plausibly-relevant roles.
const TITLE_RE =
  /(software|backend|back[- ]end|full[- ]?stack|mobile|ios|android|platform|infra(structure)?|devops|dev ?ops|site reliability|sre|systems?|distributed|api|cloud|golang|\bgo\b|node|typescript|python|rust|react native|flutter|engineer|developer|swe|ontwikkelaar|programmeur)/i;
const TITLE_EXCLUDE =
  /(recruiter|sales|marketing|designer|product manager|program manager|engineering manager|account (exec|manager)|customer success|support engineer|solutions? (engineer|architect)|data scientist|analyst|qa\b|test engineer|intern\b|internship|electrical|mechanical|civil|hardware|verkoop|klantenservice|magazijn|monteur|stagiair)/i;

// Early-career programmes are often titled without a role word ("Graduate Programme 2027 –
// Technology"), so an early-career keyword plus a tech word is enough to get scored.
const TECH_RE = /\b(tech(nology)?|engineering|software|developer|backend|platform)\b/i;

export function titleLooksRelevant(title: string): boolean {
  if (TITLE_EXCLUDE.test(title)) return false;
  return TITLE_RE.test(title) || (EARLY_CAREER_TITLE_RE.test(title) && TECH_RE.test(title));
}
