import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { and, desc, eq, like, or, sql } from "drizzle-orm";

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
