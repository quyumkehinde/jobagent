import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { eq } from "drizzle-orm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await db.query.jobs.findFirst({ where: eq(tables.jobs.id, Number(id)) });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ job });
}

// PATCH { feedStatus, dismissReason? } — queue/dismiss/restore a job in the feed.
// The optional reason is fed back into future scoring as a negative preference.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const allowed = ["new", "queued", "dismissed"];
  if (!allowed.includes(body.feedStatus)) {
    return NextResponse.json({ error: "invalid feedStatus" }, { status: 400 });
  }
  const update: Record<string, unknown> = { feedStatus: body.feedStatus };
  if (body.feedStatus === "dismissed") {
    update.dismissedAt = new Date();
    if (typeof body.dismissReason === "string" && body.dismissReason.trim())
      update.dismissReason = body.dismissReason.trim().slice(0, 300);
  }
  await db.update(tables.jobs).set(update).where(eq(tables.jobs.id, Number(id)));
  return NextResponse.json({ ok: true });
}
