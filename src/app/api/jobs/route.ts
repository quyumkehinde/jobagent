import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { UA, stripHtml } from "@/connectors/types";
import { genericExternalId } from "@/connectors/generic";
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
    orderBy: [desc(sql`coalesce(${tables.jobs.score}, -1)`), desc(tables.jobs.firstSeenAt)],
    limit: 300,
  });
  return NextResponse.json({ jobs: rows });
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
