import { db, tables } from "@/db";
import { and, eq } from "drizzle-orm";
import { UA, stripHtml } from "@/connectors/types";
import { createRenderBudget } from "./browser";
import { hostGate, reportRateLimit } from "./hostgate";
import { CONNECTORS, PROBE_ORDER, AtsName } from "@/connectors/registry";
import { scanForBoards } from "@/connectors/discovery";
import { getSetting, DEFAULTS } from "./settings";
import { createLogger, startTimer } from "./log";

const log = createLogger("resolve");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- name handling ----------------------------------------------------------

// Legal suffixes seen in the IND register and elsewhere. Matched before punctuation is
// stripped so "B.V." still carries its dots.
const LEGAL_SUFFIX_RE =
  /\b(b\.?\s?v\.?|n\.?\s?v\.?|c\.?\s?v\.?|v\.?\s?o\.?\s?f\.?|u\.?\s?a\.?|s\.?\s?e\.?|inc\.?|llc|ltd\.?|plc|gmbh|ag|sarl|sas|holdings?|group|groep|stichting|co[öo]peratie|coop|&\s*co\.?\s?(kg)?)\b/gi;

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // fold diacritics: Coöperatie → cooperatie
    .replace(/&\s*co\.?\s*(kg)?/gi, " ") // "& Co. KG" — \b can't anchor on "&", so handled first
    .replace(LEGAL_SUFFIX_RE, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugCandidates(name: string): string[] {
  const norm = normalizeCompanyName(name);
  if (!norm) return [];
  const words = norm.split(" ");
  const joined = words.join("");
  const candidates = [joined, words.join("-"), words.join("_"), words[0]];
  return [...new Set(candidates)].filter((s) => s.length > 2).slice(0, 4);
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

// Does the board's self-reported name plausibly belong to the imported company?
export function namesMatch(imported: string, boardName: string): boolean {
  const a = normalizeCompanyName(imported).replace(/ /g, "");
  const b = normalizeCompanyName(boardName).replace(/ /g, "");
  if (!a || !b) return false;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return true;
  const ba = bigrams(a);
  const bb = bigrams(b);
  let common = 0;
  for (const g of ba) if (bb.has(g)) common++;
  const dice = (2 * common) / (ba.size + bb.size);
  return dice >= 0.75;
}

// ---------- HTML helpers ------------------------------------------------------------

async function fetchHtml(url: string, timeoutMs = 12000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (type && !type.includes("html")) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function pageNames(html: string): string[] {
  const out: string[] = [];
  const title = /<title[^>]*>([\s\S]{1,200}?)<\/title>/i.exec(html)?.[1];
  if (title) out.push(...title.split(/[|·–—-]/).map((s) => s.trim()));
  const og = /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,100})["']/i.exec(html)?.[1];
  if (og) out.push(og.trim());
  return out.filter(Boolean);
}

// Validate a probe hit that carried no board name: does the board's public page title
// mention the company?
async function boardPageMatches(ats: AtsName, token: string, companyName: string): Promise<boolean> {
  const conn = CONNECTORS[ats];
  if (!conn) return false;
  const html = await fetchHtml(conn.boardUrl(token));
  if (!html) return false;
  return pageNames(html).some((n) => namesMatch(companyName, n));
}

// ---------- probing -----------------------------------------------------------------

interface Hit {
  ats: AtsName;
  token: string;
  boardName?: string;
}

// Probe every registered ATS with every slug candidate; return the first VALIDATED hit.
// Unvalidated hits are recorded in `notes` but never claimed — a slug collision must not
// resolve to someone else's board. A validated hit with a KNOWN-ZERO job count (vestigial
// account, e.g. a company that migrated ATS) is held as a fallback while we keep probing
// for a non-empty board.
interface AtsProbeOutcome {
  liveHit: Hit | null;
  emptyHit: Hit | null;
  rateLimited: boolean;
  notes: string[];
}

// One platform, slugs in sequence (pacing per platform comes from hostGate).
async function probeOneAts(conn: NonNullable<(typeof CONNECTORS)[AtsName]>, slugs: string[], companyName: string): Promise<AtsProbeOutcome> {
  const out: AtsProbeOutcome = { liveHit: null, emptyHit: null, rateLimited: false, notes: [] };
  for (const slug of slugs) {
    const probe = await conn.probe(slug);
    if (probe.rateLimited) {
      // this platform is throttling us — a "miss" from it proves nothing; stop asking
      out.rateLimited = true;
      return out;
    }
    if (!probe.exists) continue;
    let hit: Hit | null = null;
    if (probe.boardName) {
      if (!namesMatch(companyName, probe.boardName)) {
        out.notes.push(`${conn.ats}/${slug} exists but is "${probe.boardName}" — name mismatch`);
        continue;
      }
      hit = { ats: conn.ats, token: slug, boardName: probe.boardName };
    } else if (await boardPageMatches(conn.ats, slug, companyName)) {
      hit = { ats: conn.ats, token: slug };
    } else {
      out.notes.push(`${conn.ats}/${slug} exists but name unverifiable`);
      continue;
    }
    if (probe.jobCount === 0) {
      if (!out.emptyHit) out.emptyHit = hit;
      out.notes.push(`${conn.ats}/${slug} validated but has 0 jobs — kept looking for a live board`);
      continue;
    }
    out.liveHit = hit;
    return out;
  }
  return out;
}

// All platforms probed IN PARALLEL (the per-platform hostGate keeps each one polite);
// the winner is picked deterministically in PROBE_ORDER priority afterward. This is the
// difference between ~20s and ~2s per company — Workable has no reason to wait for Recruitee.
async function probeAll(
  company: { name: string },
  notes: string[]
): Promise<{ hit: Hit | null; sawRateLimit: boolean }> {
  const slugs = slugCandidates(company.name);
  const outcomes = await Promise.all(
    PROBE_ORDER.map(async (ats) => {
      const conn = CONNECTORS[ats as AtsName];
      return conn ? probeOneAts(conn, slugs, company.name) : null;
    })
  );
  let emptyHit: Hit | null = null;
  let sawRateLimit = false;
  let liveHit: Hit | null = null;
  for (const o of outcomes) {
    if (!o) continue;
    notes.push(...o.notes);
    if (o.rateLimited) sawRateLimit = true;
    if (!liveHit && o.liveHit) liveHit = o.liveHit; // outcomes are in PROBE_ORDER
    if (!emptyHit && o.emptyHit) emptyHit = o.emptyHit;
  }
  return { hit: liveHit || emptyHit, sawRateLimit };
}

// ---------- web fallback (keyless) --------------------------------------------------

const AGGREGATOR_DOMAINS =
  /linkedin|indeed|glassdoor|wikipedia|crunchbase|facebook|instagram|twitter|x\.com|youtube|werkzoeken|nationalevacaturebank|jobbird|monsterboard|stepstone|kvk\.nl|drimble|bedrijvenmonitor|companyinfo/i;

const CAREERS_LINK_RE =
  /(careers?|jobs?|vacatures?|vacancies|werken[-_ ]?bij|werkenbij|join[-_ ]?(us|the[-_ ]team)|work[-_ ]?(with|at|for)[-_ ]?us?|team)/i;

let ddgBlockedThisRun = false;
// per-batch headless render budget for JS-shell careers pages (set in resolvePendingCompanies)
let renderFn: ((url: string) => Promise<string | null>) | null = null;

async function ddgFindWebsite(name: string, country: string | null): Promise<string | null> {
  if (ddgBlockedThisRun) return null;
  await hostGate("html.duckduckgo.com"); // concurrent resolvers must not gang up on DDG
  const q = encodeURIComponent(`${name} ${country || ""} careers`);
  const html = await fetchHtml(`https://html.duckduckgo.com/html/?q=${q}`);
  await sleep(2500); // DDG is generous but not infinitely so
  if (!html) return null;
  if (/anomaly|captcha|challenge/i.test(html) || !html.includes("uddg=")) {
    ddgBlockedThisRun = true;
    await reportRateLimit("html.duckduckgo.com", "web-search fallback", 0);
    log.warn("duckduckgo blocked/empty — web fallback disabled for this run");
    return null;
  }
  const links = [...html.matchAll(/uddg=([^&"]+)/g)].map((m) => {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return "";
    }
  });
  for (const link of links) {
    try {
      const u = new URL(link);
      if (AGGREGATOR_DOMAINS.test(u.host)) continue;
      return `${u.protocol}//${u.host}`;
    } catch {
      continue;
    }
  }
  return null;
}

// Domain guesses are free: {slug}.nl / .com — but only trusted when the page title
// actually matches the company name. Tries both the joined name and the brand word
// ("9altitudes Business Analytics" → 9altitudesbusinessanalytics AND 9altitudes).
async function guessWebsite(name: string): Promise<string | null> {
  const all = slugCandidates(name);
  const slugs = [...new Set([all[0], all[all.length - 1]])].filter(Boolean);
  for (const slug of slugs) {
    for (const domain of [`https://www.${slug}.nl`, `https://${slug}.nl`, `https://www.${slug}.com`, `https://${slug}.com`]) {
      const html = await fetchHtml(domain, 8000);
      if (html && pageNames(html).some((n) => namesMatch(name, n))) return domain;
    }
  }
  return null;
}

function extractCareersLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const aRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = aRe.exec(html))) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ");
    if (!CAREERS_LINK_RE.test(href) && !CAREERS_LINK_RE.test(text)) continue;
    try {
      out.push(new URL(href, baseUrl).toString());
    } catch {
      continue;
    }
  }
  return [...new Set(out)].slice(0, 3);
}

interface WebResult {
  website?: string;
  careersUrl?: string;
  hit?: Hit;
}

async function findViaWeb(company: { name: string; country: string | null; website: string | null }, notes: string[]): Promise<WebResult> {
  const website =
    company.website || (await guessWebsite(company.name)) || (await ddgFindWebsite(company.name, company.country));
  if (!website) {
    notes.push("no website found (probes missed, domain guess + web search failed)");
    return {};
  }

  const homepage = await fetchHtml(website);
  if (!homepage) return { website };

  const careersLinks = extractCareersLinks(homepage, website);
  let careersHtml = "";
  for (const link of careersLinks) {
    let html = await fetchHtml(link);
    await sleep(150);
    // JS-shell careers pages hide their ATS embeds from static HTML — render when budget allows
    if (renderFn && (!html || stripHtml(html).length < 100)) html = (await renderFn(link)) || html;
    if (html) careersHtml += "\n" + html;
  }

  // any embedded ATS links on homepage or careers pages?
  for (const { ats, token } of scanForBoards(homepage + careersHtml)) {
    const conn = CONNECTORS[ats];
    if (!conn) continue;
    const probe = await conn.probe(token);
    await sleep(150);
    if (!probe.exists) continue;
    // a link on the company's own site is strong evidence — name-validate when possible,
    // accept otherwise
    if (probe.boardName && !namesMatch(company.name, probe.boardName)) {
      notes.push(`site links ${ats}/${token} but board is "${probe.boardName}"`);
      continue;
    }
    return { website, careersUrl: careersLinks[0], hit: { ats, token, boardName: probe.boardName } };
  }

  if (careersLinks.length) notes.push(`careers page found, no supported ATS detected`);
  else notes.push(`website found, no careers link detected`);
  return { website, careersUrl: careersLinks[0] };
}

// Locate a company's careers page without full re-resolution: website (stored → domain
// guess → web search) → homepage → first careers link. Persists what it finds. Used by
// the generic sweep for companies whose validated board turned out to be empty.
export async function discoverCareersUrl(company: {
  id: number;
  name: string;
  country: string | null;
  website: string | null;
}): Promise<string | null> {
  const website =
    company.website || (await guessWebsite(company.name)) || (await ddgFindWebsite(company.name, company.country));
  if (!website) return null;
  const homepage = await fetchHtml(website);
  const careersUrl = homepage ? extractCareersLinks(homepage, website)[0] || null : null;
  await db
    .update(tables.companies)
    .set({ website, ...(careersUrl ? { careersUrl } : {}) })
    .where(eq(tables.companies.id, company.id));
  return careersUrl;
}

// ---------- the engine --------------------------------------------------------------

export interface ResolveOutcome {
  status: "resolved" | "unresolved" | "deferred";
  usedWeb: boolean;
}

export async function resolveCompany(companyId: number, allowWeb = true): Promise<ResolveOutcome> {
  const c = await db.query.companies.findFirst({ where: eq(tables.companies.id, companyId) });
  if (!c) throw new Error(`company ${companyId} not found`);
  const notes: string[] = [];

  await db.update(tables.companies).set({ resolveStatus: "probing" }).where(eq(tables.companies.id, c.id));

  const probed = await probeAll(c, notes);
  let hit = probed.hit;
  let web: WebResult = {};
  let usedWeb = false;
  if (!hit) {
    if (!allowWeb) {
      // probes missed and the run's web-fallback budget is spent — try again next run
      await db.update(tables.companies).set({ resolveStatus: "pending" }).where(eq(tables.companies.id, c.id));
      return { status: "deferred", usedWeb: false };
    }
    usedWeb = true;
    web = await findViaWeb(c, notes);
    hit = web.hit || null;
  }

  if (hit) {
    // (ats, token) is unique — if another row already owns this board, don't duplicate it
    const existing = await db.query.companies.findFirst({
      where: and(eq(tables.companies.ats, hit.ats), eq(tables.companies.token, hit.token)),
    });
    if (existing && existing.id !== c.id) {
      await db
        .update(tables.companies)
        .set({
          resolveStatus: "resolved",
          resolveNote: `board already tracked by company #${existing.id} (${existing.name})`,
          active: false,
          website: web.website || c.website,
        })
        .where(eq(tables.companies.id, c.id));
      // carry the visa flag onto the row that owns the board
      if (c.visaSponsor && !existing.visaSponsor)
        await db.update(tables.companies).set({ visaSponsor: true }).where(eq(tables.companies.id, existing.id));
      log.info("resolved to already-tracked board", { company: c.name, board: `${hit.ats}/${hit.token}` });
      return { status: "resolved", usedWeb };
    }

    await db
      .update(tables.companies)
      .set({
        ats: hit.ats,
        token: hit.token,
        active: true,
        errorCount: 0,
        resolveStatus: "resolved",
        resolveNote: hit.boardName ? `validated against board name "${hit.boardName}"` : "validated via board page title",
        website: web.website || c.website,
        careersUrl: web.careersUrl || c.careersUrl,
      })
      .where(eq(tables.companies.id, c.id));
    log.info("resolved", { company: c.name, board: `${hit.ats}/${hit.token}` });
    return { status: "resolved", usedWeb };
  }

  if (probed.sawRateLimit) {
    // some ATS never got a fair probe — concluding "unresolved" now would be a false
    // negative. Keep whatever web evidence we gathered and retry next run.
    await db
      .update(tables.companies)
      .set({
        resolveStatus: "pending",
        resolveNote: "probing was rate-limited — deferred to next run",
        website: web.website || c.website,
        careersUrl: web.careersUrl || c.careersUrl,
      })
      .where(eq(tables.companies.id, c.id));
    log.info("deferred (rate-limited)", { company: c.name });
    return { status: "deferred", usedWeb };
  }

  await db
    .update(tables.companies)
    .set({
      resolveStatus: "unresolved",
      resolveNote: notes.slice(0, 4).join("; ").slice(0, 500) || "no board found",
      website: web.website || c.website,
      careersUrl: web.careersUrl || c.careersUrl,
    })
    .where(eq(tables.companies.id, c.id));
  log.info("unresolved", { company: c.name, note: notes[0] || "no evidence" });
  return { status: "unresolved", usedWeb };
}

// Called at the top of every pipeline run: works through pending imports in batches.
export async function resolvePendingCompanies(): Promise<{ resolved: number; unresolved: number; remaining: number }> {
  const batch = await getSetting("resolveBatchPerRun", DEFAULTS.resolveBatchPerRun);
  const webCap = await getSetting("resolveWebPerRun", DEFAULTS.resolveWebPerRun);
  ddgBlockedThisRun = false;
  renderFn = createRenderBudget(await getSetting("headlessResolvePerRun", DEFAULTS.headlessResolvePerRun));

  const pending = await db.query.companies.findMany({
    where: eq(tables.companies.resolveStatus, "pending"),
    orderBy: (t, { asc }) => asc(t.id),
    limit: batch,
  });
  if (!pending.length) return { resolved: 0, unresolved: 0, remaining: 0 };

  const elapsed = startTimer();
  log.info("batch start", { pending: pending.length });
  let resolved = 0;
  let unresolved = 0;
  let webUsed = 0;
  // several companies in flight at once — per-platform politeness is enforced by
  // hostGate, so concurrency here costs the ATSs nothing extra per second
  const queue = [...pending];
  const CONCURRENCY = 4;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const c = queue.shift()!;
        try {
          const outcome = await resolveCompany(c.id, webUsed < webCap);
          if (outcome.usedWeb) webUsed++;
          if (outcome.status === "resolved") resolved++;
          else if (outcome.status === "unresolved") unresolved++;
          // deferred stays pending for a future run
        } catch (err) {
          log.warn("resolve failed", { company: c.name, error: String(err).slice(0, 200) });
          await db
            .update(tables.companies)
            .set({ resolveStatus: "pending", resolveNote: `error: ${String(err).slice(0, 200)}` })
            .where(eq(tables.companies.id, c.id));
        }
      }
    })
  );
  const remaining = (
    await db.query.companies.findMany({ where: eq(tables.companies.resolveStatus, "pending"), columns: { id: true } })
  ).length;
  log.info("batch done", { resolved, unresolved, remaining, ms: elapsed() });
  return { resolved, unresolved, remaining };
}
