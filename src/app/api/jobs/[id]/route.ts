import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { eq } from "drizzle-orm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await db.query.jobs.findFirst({ where: eq(tables.jobs.id, Number(id)) });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ job });
}

// PATCH { feedStatus } — queue/dismiss/restore a job in the feed
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const allowed = ["new", "queued", "dismissed"];
  if (!allowed.includes(body.feedStatus)) {
    return NextResponse.json({ error: "invalid feedStatus" }, { status: 400 });
  }
  await db.update(tables.jobs).set({ feedStatus: body.feedStatus }).where(eq(tables.jobs.id, Number(id)));
  return NextResponse.json({ ok: true });
}
