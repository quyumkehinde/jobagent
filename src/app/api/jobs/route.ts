import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { UA, stripHtml } from "@/connectors/types";
import { genericExternalId } from "@/connectors/generic";
import { fetchJobFromUrl } from "@/connectors/fromUrl";
import { ingestJobs } from "@/lib/ingest";
import { renderPage, closeBrowser } from "@/lib/browser";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const tab = sp.get("tab") || "queued"; // queued | new | flagged | dismissed | all
  const search = sp.get("q");

  const conds = [];
  // closed roles vanish from the actionable tabs (they stay reachable via "all")
  if (tab === "queued") conds.push(eq(tables.jobs.feedStatus, "queued"), eq(tables.jobs.closed, false));
  else if (tab === "new") conds.push(eq(tables.jobs.feedStatus, "new"), eq(tables.jobs.closed, false));
  else if (tab === "flagged") conds.push(eq(tables.jobs.eligibility, "country-restricted"));
  else if (tab === "dismissed") conds.push(eq(tables.jobs.feedStatus, "dismissed"));
  if (search) {
    conds.push(
      or(like(tables.jobs.title, `%${search}%`), like(tables.jobs.companyName, `%${search}%`))
    );
  }

  const rows = await db.query.jobs.findMany({
    where: conds.length ? and(...conds) : undefined,
    // unscored-but-queued jobs (fresh manual adds) pin to the top instead of sinking
    // below every scored job — they'd otherwise be invisible until the next scoring run
    orderBy: [
      desc(sql`(${tables.jobs.score} is null and ${tables.jobs.feedStatus} = 'queued')`),
      desc(sql`coalesce(${tables.jobs.score}, -1)`),
      desc(tables.jobs.firstSeenAt),
    ],
    limit: 300,
  });
  return NextResponse.json({ jobs: rows });
}

// PATCH { ids: number[], feedStatus, dismissReason? } — bulk feed-status change
// (e.g. select-all country-restricted roles of one company → dismiss with one reason,
// which then feeds the scoring feedback loop as a pattern).
export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as { ids?: unknown[]; feedStatus?: string; dismissReason?: string };
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger).slice(0, 500) : [];
  if (!ids.length) return NextResponse.json({ error: "ids required" }, { status: 400 });
  if (!["new", "queued", "dismissed"].includes(body.feedStatus || ""))
    return NextResponse.json({ error: "invalid feedStatus" }, { status: 400 });

  const update: Record<string, unknown> = { feedStatus: body.feedStatus };
  if (body.feedStatus === "dismissed") {
    update.dismissedAt = new Date();
    if (typeof body.dismissReason === "string" && body.dismissReason.trim())
      update.dismissReason = body.dismissReason.trim().slice(0, 300);
  }
  const res = await db.update(tables.jobs).set(update).where(inArray(tables.jobs.id, ids));
  return NextResponse.json({ ok: true, updated: res.changes });
}

// POST { url, title?, companyName? } — manually add a job listing by URL. The page is
// fetched (headless-rendered when it's a JS shell), title/company/description extracted
// (overridable), and the job ingested as source "manual" — scored on the next run,
// draftable immediately.
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { url?: string; title?: string; companyName?: string };
  let url: URL;
  try {
    url = new URL(body.url || "");
    if (!/^https?:$/.test(url.protocol)) throw new Error("not http(s)");
  } catch {
    return NextResponse.json({ error: "a valid http(s) job URL is required" }, { status: 400 });
  }

  // Known-ATS URLs ingest natively: right source + ATS externalId (dedupes against
  // future board scrapes), real company name, and form introspection at draft time.
  const native = await fetchJobFromUrl(url.toString());
  if (native) {
    const dupe = await db.query.jobs.findFirst({
      where: and(eq(tables.jobs.source, native.source), eq(tables.jobs.externalId, native.externalId)),
    });
    if (dupe) {
      // the user explicitly wants this job — promote it unless it's already in play
      if (dupe.feedStatus === "new" || dupe.feedStatus === "dismissed") {
        await db.update(tables.jobs).set({ feedStatus: "queued" }).where(eq(tables.jobs.id, dupe.id));
        dupe.feedStatus = "queued";
      }
      return NextResponse.json({ job: dupe, existed: true });
    }
    // link to a tracked company when this board is already known
    const token = (native.raw as { token?: string } | undefined)?.token;
    if (token) {
      const company = await db.query.companies.findFirst({
        where: and(
          eq(tables.companies.ats, native.source as NonNullable<typeof tables.companies.$inferSelect.ats>),
          eq(tables.companies.token, token)
        ),
      });
      if (company) {
        native.companyId = company.id;
        native.companyName = company.name;
      }
    }
    const ingested = await ingestJobs([native]);
    const id = ingested.addedIds[0];
    await db.update(tables.jobs).set({ feedStatus: "queued" }).where(eq(tables.jobs.id, id));
    const job = await db.query.jobs.findFirst({ where: eq(tables.jobs.id, id) });
    return NextResponse.json({
      job,
      extracted: {
        title: native.title,
        companyName: native.companyName,
        descriptionChars: native.description?.length ?? 0,
        native: native.source,
      },
    });
  }

  const externalId = genericExternalId(url.toString());
  const existing = await db.query.jobs.findFirst({
    where: and(eq(tables.jobs.source, "manual"), eq(tables.jobs.externalId, externalId)),
  });
  if (existing) return NextResponse.json({ job: existing, existed: true });

  let html: string | null = null;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) html = await res.text();
  } catch {
    // fall through to render
  }
  if (!html || stripHtml(html).length < 200) {
    html = (await renderPage(url.toString())) || html;
    await closeBrowser(); // route-launched Chrome must not linger in the dev server
  }
  const text = html ? stripHtml(html) : "";

  const pick = (re: RegExp) => re.exec(html || "")?.[1]?.trim();
  const title =
    body.title?.trim() ||
    pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})["']/i) ||
    pick(/<title[^>]*>([\s\S]{1,200}?)<\/title>/i)?.split(/[|·–—]/)[0]?.trim() ||
    "Untitled job";
  const companyName =
    body.companyName?.trim() ||
    pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{1,100})["']/i) ||
    url.hostname.replace(/^www\./, "").split(".")[0];

  const [job] = await db
    .insert(tables.jobs)
    .values({
      source: "manual",
      externalId,
      url: url.toString(),
      applyUrl: url.toString(),
      title: title.slice(0, 200),
      companyName: companyName.slice(0, 120),
      description: text ? text.slice(0, 20000) : undefined,
      feedStatus: "queued", // the user chose this job — straight to the queue, score follows
    })
    .returning();
  return NextResponse.json({ job, extracted: { title, companyName, descriptionChars: text.length } });
}
