import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { desc, eq, inArray } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status");
  const apps = await db.query.applications.findMany({
    where: status
      ? status.includes(",")
        ? inArray(tables.applications.status, status.split(",") as (typeof tables.applications.status.enumValues)[number][])
        : eq(tables.applications.status, status as (typeof tables.applications.status.enumValues)[number])
      : undefined,
    orderBy: desc(tables.applications.updatedAt),
    limit: 500,
  });
  const jobIds = apps.map((a) => a.jobId);
  const jobs = jobIds.length
    ? await db.query.jobs.findMany({ where: inArray(tables.jobs.id, jobIds) })
    : [];
  const jobMap = Object.fromEntries(jobs.map((j) => [j.id, j]));
  return NextResponse.json({ applications: apps.map((a) => ({ ...a, job: jobMap[a.jobId] })) });
}
