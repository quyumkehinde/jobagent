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

function slugToText(pathname: string): string {
  const seg = pathname.split("/").filter(Boolean).pop() || "";
  return decodeURIComponent(seg).replace(/[-_+]/g, " ").replace(/\.\w{2,5}$/, "").trim();
}

const normUrl = (s: string) => s.replace(/\/+$/, "");

function extractJobLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const base = new URL(baseUrl);
  // relevant text alone must NOT qualify a link — nav/service pages ("Cloud Infrastructure")
  // masquerade as jobs. It only counts for links living under the careers section itself.
  const careersPath = base.pathname.replace(/\/+$/, "");
  const qualifies = (url: URL, text: string) =>
    JOB_LINK_RE.test(url.pathname) ||
    (titleLooksRelevant(text) && careersPath.length > 1 && url.pathname.startsWith(careersPath + "/"));
  const out = new Map<string, string>();
  // pass 1: anchors with capturable inner text (cap generous — SPA job cards nest deep markup)
  const aRe = /<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,600}?)<\/a>/gi;
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
    if (normUrl(url.toString()) === normUrl(baseUrl)) continue;
    if (!qualifies(url, text)) continue;
    if (!out.has(url.toString())) out.set(url.toString(), text);
  }
  // pass 2: href-only — anchors whose closing tag sits beyond any sane capture window
  // (deeply nested job cards). Title is derived from the URL slug; the caller's
  // titleLooksRelevant filter then judges "senior-software-developer" as text.
  const hrefRe = /<a\s[^>]*href=["']([^"'#]+)["']/gi;
  while ((m = hrefRe.exec(html))) {
    let url: URL;
    try {
      url = new URL(m[1], baseUrl);
    } catch {
      continue;
    }
    if (url.host !== base.host || normUrl(url.toString()) === normUrl(baseUrl)) continue;
    if (!JOB_LINK_RE.test(url.pathname)) continue;
    const key = url.toString();
    if (!out.has(key) || !out.get(key)) out.set(key, out.get(key) || slugToText(url.pathname));
  }
  return [...out.entries()].map(([url, text]) => ({ url, text }));
}

export interface GenericOpts {
  maxJobs: number;
  knownExternalIds: Set<string>;
  // returns true if the caller's per-run Gemini extraction budget allows one more call
  tryGeminiExtract?: (pageText: string, companyName: string) => Promise<{ title: string; url: string; location?: string }[] | null>;
  // budgeted headless render (src/lib/browser.ts) — used only when static HTML is empty-ish
  render?: (url: string) => Promise<string | null>;
}

export function genericExternalId(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

// Dutch convention: careers sites live on werkenbij{brand}.nl (etc.) while their job
// links only resolve on the brand's apex domain. Derive apex variants of a URL.
const CAREERS_HOST_PREFIX = /^(werken-?bij|werken-?voor|careers?|jobs?|talent|vacatures)/;

export function apexVariants(url: string): string[] {
  try {
    const u = new URL(url);
    const labels = u.hostname.split(".");
    const registrable = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
    const brand = registrable.replace(CAREERS_HOST_PREFIX, "");
    if (!brand || brand.length < 4 || brand === registrable) return [];
    const tld = labels[labels.length - 1];
    return [`https://www.${brand}.${tld}${u.pathname}${u.search}`, `https://${brand}.${tld}${u.pathname}${u.search}`];
  } catch {
    return [];
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// static fetch first; if the result is a JS shell and a render budget exists, render
async function fetchPageMaybeRendered(
  url: string,
  render: GenericOpts["render"]
): Promise<{ html: string | null; rendered: boolean }> {
  const staticHtml = await fetchPage(url);
  if (staticHtml && stripHtml(staticHtml).length >= 100) return { html: staticHtml, rendered: false };
  if (render) {
    const renderedHtml = await render(url);
    if (renderedHtml && stripHtml(renderedHtml).length >= 100) return { html: renderedHtml, rendered: true };
  }
  return { html: staticHtml, rendered: false };
}

export async function fetchGenericCareers(
  company: { id: number; name: string; careersUrl: string },
  opts: GenericOpts
): Promise<GenericResult> {
  const { html } = await fetchPageMaybeRendered(company.careersUrl, opts.render);
  if (!html) throw new Error(`careers page unreachable: ${company.careersUrl}`);

  // maybe the page embeds a supported ATS after all (late catch → resolve properly);
  // rendered HTML routinely reveals client-side-injected ATS embeds
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
      .slice(0, 4);
    for (const hub of hubs) {
      const { html: hubHtml } = await fetchPageMaybeRendered(hub.url, opts.render);
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

  // Static heuristics found NOTHING → the listing itself is client-rendered (an SPA shell
  // can be full of static nav/footer text, so text-length checks don't catch this).
  // Redo the whole pass with the browser: rendered careers page + rendered hubs.
  if (candidates.filter((c) => titleLooksRelevant(c.text)).length === 0 && opts.render) {
    const pages: { html: string; base: string }[] = [];
    const renderedMain = await opts.render(company.careersUrl);
    if (renderedMain) {
      pages.push({ html: renderedMain, base: company.careersUrl });
      const HUB_RE = /(all|alle|zoeken|search|overview|open)/i;
      const hubs = extractJobLinks(renderedMain, company.careersUrl)
        .filter((c) => HUB_RE.test(c.text) || /(zoeken|search|vacatures\/?$|jobs\/?$|vacancies\/?$)/i.test(c.url))
        .slice(0, 4);
      for (const hub of hubs) {
        const hubHtml = await opts.render(hub.url);
        if (hubHtml) pages.push({ html: hubHtml, base: hub.url });
      }
    }
    for (const p of pages) {
      // rendered HTML often reveals client-side-injected ATS embeds
      for (const hit of scanForBoards(p.html)) {
        const conn = CONNECTORS[hit.ats];
        if (!conn) continue;
        const probe = await conn.probe(hit.token);
        if (probe.exists) return { jobs: [], atsHit: { ...hit, boardName: probe.boardName } };
      }
      candidates = candidates.concat(
        extractJobLinks(p.html, p.base).filter((c) => titleLooksRelevant(c.text) || JOB_LINK_RE.test(c.url))
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
  const deadHosts = new Set<string>(); // hosts whose renders time out — don't burn budget twice

  // static → render (bot walls reject curl-style fetches but not a real Chrome; SPAs are
  // SPAs all the way down). Returns content only when it's substantial.
  const fetchJobPage = async (url: string): Promise<string | null> => {
    const host = new URL(url).host;
    let page = await fetchPage(url);
    await sleep(150);
    if ((!page || stripHtml(page).length < 200) && opts.render && !deadHosts.has(host)) {
      const rendered = await opts.render(url);
      if (!page && !rendered) deadHosts.add(host);
      page = rendered || page;
    }
    return page && stripHtml(page).length >= 200 ? page : null;
  };

  for (const c of relevant) {
    if (opts.knownExternalIds.has(genericExternalId(c.url))) {
      jobs.push({
        source: "generic",
        externalId: genericExternalId(c.url),
        url: c.url,
        title: c.text.slice(0, 150),
        companyName: company.name,
        companyId: company.id,
      });
      continue;
    }

    let pageUrl = c.url;
    let page = await fetchJobPage(pageUrl);
    if (!page) {
      // careers-subdomain link that only resolves on the brand apex (werkenbijX.nl → X.nl)
      for (const alt of apexVariants(c.url)) {
        if (opts.knownExternalIds.has(genericExternalId(alt))) break; // already ingested under the apex URL
        page = await fetchJobPage(alt);
        if (page) {
          pageUrl = alt;
          break;
        }
      }
    }
    if (!page) continue;
    const desc = stripHtml(page);
    jobs.push({
      source: "generic",
      externalId: genericExternalId(pageUrl),
      url: pageUrl,
      title: c.text.slice(0, 150),
      companyName: company.name,
      companyId: company.id,
      description: desc.slice(0, 20000),
      raw: { careersUrl: company.careersUrl },
    });
  }
  return { jobs };
}
