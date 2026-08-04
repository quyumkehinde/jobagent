import { NextResponse } from "next/server";
import { db, tables } from "@/db";
import { desc } from "drizzle-orm";
import { runPipeline, isPipelineRunning } from "@/lib/pipeline";
import { seedCompaniesIfEmpty } from "@/lib/seed";

export async function GET() {
  const runs = await db.query.scrapeRuns.findMany({ orderBy: desc(tables.scrapeRuns.startedAt), limit: 20 });
  return NextResponse.json({ running: isPipelineRunning(), runs });
}

// Fire-and-forget trigger; progress is visible via GET.
export async function POST() {
  if (isPipelineRunning()) return NextResponse.json({ started: false, reason: "already running" }, { status: 409 });
  await seedCompaniesIfEmpty();
  runPipeline().catch((err) => console.error("[pipeline]", err));
  return NextResponse.json({ started: true });
}
