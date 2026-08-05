import { NextResponse } from "next/server";
import { db, tables } from "@/db";
import { desc } from "drizzle-orm";
import { runPipeline, isPipelineRunning } from "@/lib/pipeline";
import { seedCompaniesIfEmpty } from "@/lib/seed";
import { getRateLimitEvents } from "@/lib/hostgate";

export async function GET() {
  const runs = await db.query.scrapeRuns.findMany({ orderBy: desc(tables.scrapeRuns.startedAt), limit: 20 });
  // rate-limit events from the last 24h, aggregated per host for the dashboard banner
  const cutoff = Date.now() - 24 * 3600_000;
  const byHost = new Map<string, { host: string; count: number; lastAt: string; lastContext: string }>();
  for (const e of await getRateLimitEvents()) {
    if (new Date(e.at).getTime() < cutoff) continue;
    const cur = byHost.get(e.host);
    if (cur) {
      cur.count++;
      cur.lastAt = e.at;
      cur.lastContext = e.context;
    } else byHost.set(e.host, { host: e.host, count: 1, lastAt: e.at, lastContext: e.context });
  }
  return NextResponse.json({ running: await isPipelineRunning(), runs, rateLimits: [...byHost.values()] });
}

// Fire-and-forget trigger; progress is visible via GET.
export async function POST() {
  if (await isPipelineRunning())
    return NextResponse.json({ started: false, reason: "already running" }, { status: 409 });
  await seedCompaniesIfEmpty();
  runPipeline().catch((err) => console.error("[pipeline]", err));
  return NextResponse.json({ started: true });
}
