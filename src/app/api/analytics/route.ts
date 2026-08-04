import { NextResponse } from "next/server";
import { db, tables } from "@/db";
import { sql } from "drizzle-orm";

export async function GET() {
  const stageCounts = await db
    .select({ status: tables.applications.status, count: sql<number>`count(*)` })
    .from(tables.applications)
    .groupBy(tables.applications.status);

  // response = any application that moved beyond "submitted"
  const bySource = await db.all<{ source: string; submitted: number; responded: number }>(sql`
    SELECT j.source as source,
      SUM(CASE WHEN a.status NOT IN ('drafting','ready') THEN 1 ELSE 0 END) as submitted,
      SUM(CASE WHEN a.status IN ('screening','interviewing','offer') THEN 1 ELSE 0 END) as responded
    FROM applications a JOIN jobs j ON j.id = a.job_id
    GROUP BY j.source ORDER BY submitted DESC
  `);

  const perWeek = await db.all<{ week: string; count: number }>(sql`
    SELECT strftime('%Y-W%W', datetime(submitted_at, 'unixepoch')) as week, COUNT(*) as count
    FROM applications WHERE submitted_at IS NOT NULL
    GROUP BY week ORDER BY week DESC LIMIT 12
  `);

  const jobStats = await db.all<{ k: string; v: number }>(sql`
    SELECT 'total_jobs' as k, COUNT(*) as v FROM jobs
    UNION ALL SELECT 'scored', COUNT(*) FROM jobs WHERE scored_at IS NOT NULL
    UNION ALL SELECT 'queued', COUNT(*) FROM jobs WHERE feed_status = 'queued'
    UNION ALL SELECT 'flagged_country_restricted', COUNT(*) FROM jobs WHERE eligibility = 'country-restricted'
    UNION ALL SELECT 'active_companies', COUNT(*) FROM companies WHERE active = 1
  `);

  return NextResponse.json({ stageCounts, bySource, perWeek, jobStats });
}
