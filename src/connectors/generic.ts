import crypto from "node:crypto";
import { RawJob, UA, stripHtml, titleLooksRelevant } from "./types";
import { scanForBoards } from "./discovery";
import { CONNECTORS } from "./registry";
import { AtsName } from "./registry";

// Last-resort scraper for companies whose careers page runs on no supported ATS.
// Heuristics first, one optional Gemini extraction call when they come up dry.
// Jobs get externalId = hash(url) — if the site moves URLs, the old row is reaped by
// closing detection and the new URL ingests fresh. Page 1 only; honest cap.

export class JsRequiredError extends Error {
  constructor() {
    super("careers page appears to be JS-rendered (no static text)");
  }
}

export interface GenericResult {
  jobs: RawJob[];
  // careers page turned out to link a supported ATS — caller should resolve the company
  atsHit?: { ats: AtsName; token: string; boardName?: string };
}

const JOB_LINK_RE = /(job|vacature|vacancy|position|opening|role|careers?\/[a-z0-9])/i;

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractJobLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const base = new URL(baseUrl);
  const out = new Map<string, string>();
  const aRe = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,160}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html))) {
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    let url: URL;
    try {
      url = new URL(m[1], baseUrl);
    } catch {
      continue;
    }
    if (url.host !== base.host) continue; // same-site only; ATS links are handled via scanForBoards
    if (url.toString() === baseUrl) continue;
    if (!JOB_LINK_RE.test(url.pathname) && !titleLooksRelevant(text)) continue;
    if (!out.has(url.toString())) out.set(url.toString(), text);
  }
  return [...out.entries()].map(([url, text]) => ({ url, text }));
}

export interface GenericOpts {
  maxJobs: number;
  knownExternalIds: Set<string>;
  // returns true if the caller's per-run Gemini extraction budget allows one more call
  tryGeminiExtract?: (pageText: string, companyName: string) => Promise<{ title: string; url: string; location?: string }[] | null>;
}

export function genericExternalId(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchGenericCareers(
  company: { id: number; name: string; careersUrl: string },
  opts: GenericOpts
): Promise<GenericResult> {
  const html = await fetchPage(company.careersUrl);
  if (!html) throw new Error(`careers page unreachable: ${company.careersUrl}`);

  // maybe the page embeds a supported ATS after all (late catch → resolve properly)
  for (const hit of scanForBoards(html)) {
    const conn = CONNECTORS[hit.ats];
    if (!conn) continue;
    const probe = await conn.probe(hit.token);
    if (probe.exists) return { jobs: [], atsHit: { ...hit, boardName: probe.boardName } };
  }

  const text = stripHtml(html);
  if (text.length < 100) throw new JsRequiredError();

  let candidates = extractJobLinks(html, company.careersUrl).filter(
    (c) => titleLooksRelevant(c.text) || JOB_LINK_RE.test(c.url)
  );

  // Careers landing pages are often hubs ("All vacancies →"); follow one level of
  // listing-index links before giving up on heuristics.
  if (candidates.filter((c) => titleLooksRelevant(c.text)).length < 3) {
    const HUB_RE = /(all|alle|zoeken|search|overview|open)/i;
    const hubs = extractJobLinks(html, company.careersUrl)
      .filter((c) => HUB_RE.test(c.text) || /(zoeken|search|vacatures\/?$|jobs\/?$|vacancies\/?$)/i.test(c.url))
      .slice(0, 2);
    for (const hub of hubs) {
      const hubHtml = await fetchPage(hub.url);
      await sleep(150);
      if (!hubHtml) continue;
      // hub page may itself embed a supported ATS
      for (const hit of scanForBoards(hubHtml)) {
        const conn = CONNECTORS[hit.ats];
        if (!conn) continue;
        const probe = await conn.probe(hit.token);
        if (probe.exists) return { jobs: [], atsHit: { ...hit, boardName: probe.boardName } };
      }
      candidates = candidates.concat(
        extractJobLinks(hubHtml, hub.url).filter((c) => titleLooksRelevant(c.text) || JOB_LINK_RE.test(c.url))
      );
    }
    const seen = new Set<string>();
    candidates = candidates.filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)));
  }

  // heuristics came up dry → one Gemini extraction if the run's budget allows
  if (candidates.length < 3 && opts.tryGeminiExtract) {
    const extracted = await opts.tryGeminiExtract(text.slice(0, 15000), company.name);
    if (extracted) {
      for (const e of extracted) {
        try {
          const url = new URL(e.url, company.careersUrl).toString();
          if (!candidates.some((c) => c.url === url)) candidates.push({ url, text: e.title });
        } catch {
          continue;
        }
      }
    }
  }

  const relevant = candidates.filter((c) => titleLooksRelevant(c.text)).slice(0, opts.maxJobs);
  const jobs: RawJob[] = [];
  for (const c of relevant) {
    const externalId = genericExternalId(c.url);
    if (opts.knownExternalIds.has(externalId)) {
      jobs.push({
        source: "generic",
        externalId,
        url: c.url,
        title: c.text.slice(0, 150),
        companyName: company.name,
        companyId: company.id,
      });
      continue;
    }
    const page = await fetchPage(c.url);
    await sleep(150);
    if (!page) continue;
    const desc = stripHtml(page);
    if (desc.length < 200) continue; // JS-only or junk page — never ingest without content
    jobs.push({
      source: "generic",
      externalId,
      url: c.url,
      title: c.text.slice(0, 150),
      companyName: company.name,
      companyId: company.id,
      description: desc.slice(0, 20000),
      raw: { careersUrl: company.careersUrl },
    });
  }
  return { jobs };
}
