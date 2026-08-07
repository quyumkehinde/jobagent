import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { eq } from "drizzle-orm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await db.query.jobs.findFirst({ where: eq(tables.jobs.id, Number(id)) });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ job });
}

// PATCH { feedStatus, dismissReason? } — queue/dismiss/restore/mark-applied a job.
// The optional dismiss reason is fed back into future scoring as a negative preference.
// "applied" marks a job applied WITHOUT drafting (the user applied outside the app):
// a minimal submitted application record is created so it shows up in tracking.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jobId = Number(id);
  const body = await req.json();
  const allowed = ["new", "queued", "dismissed", "applied"];
  if (!allowed.includes(body.feedStatus)) {
    return NextResponse.json({ error: "invalid feedStatus" }, { status: 400 });
  }
  const update: Record<string, unknown> = { feedStatus: body.feedStatus };
  if (body.feedStatus === "dismissed") {
    update.dismissedAt = new Date();
    if (typeof body.dismissReason === "string" && body.dismissReason.trim())
      update.dismissReason = body.dismissReason.trim().slice(0, 300);
  }
  if (body.feedStatus === "applied") {
    const job = await db.query.jobs.findFirst({ where: eq(tables.jobs.id, jobId) });
    if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
    const existing = await db.query.applications.findFirst({
      where: eq(tables.applications.jobId, jobId),
    });
    if (existing) {
      if (existing.status !== "submitted")
        await db
          .update(tables.applications)
          .set({ status: "submitted", submittedAt: new Date(), updatedAt: new Date() })
          .where(eq(tables.applications.id, existing.id));
    } else {
      const [app] = await db
        .insert(tables.applications)
        .values({
          jobId,
          status: "submitted",
          method: "assisted",
          submittedAt: new Date(),
          jdSnapshot: job.description,
        })
        .returning();
      await db.insert(tables.events).values({
        applicationId: app.id,
        type: "submitted",
        detail: "Marked as applied from the jobs feed (applied outside the app)",
      });
    }
  }
  await db.update(tables.jobs).set(update).where(eq(tables.jobs.id, jobId));
  return NextResponse.json({ ok: true });
}
