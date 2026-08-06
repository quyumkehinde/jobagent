import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import { enqueueDraft, getDraftQueue } from "@/lib/draftQueue";

// GET — current queue (pending/drafting + recently finished, for per-job status chips)
export async function GET() {
  return NextResponse.json({ items: getDraftQueue() });
}

// POST { jobId } — enqueue a background draft; drafts process strictly one at a time
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { jobId?: unknown };
  const jobId = Number(body.jobId);
  if (!Number.isInteger(jobId)) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  const job = await db.query.jobs.findFirst({ where: eq(tables.jobs.id, jobId), columns: { id: true } });
  if (!job) return NextResponse.json({ error: "job not found" }, { status: 404 });
  enqueueDraft(jobId);
  return NextResponse.json({ items: getDraftQueue() });
}
