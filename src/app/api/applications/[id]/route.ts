import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { asc, eq, desc } from "drizzle-orm";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = await db.query.applications.findFirst({ where: eq(tables.applications.id, Number(id)) });
  if (!app) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [job, answers, events] = await Promise.all([
    db.query.jobs.findFirst({ where: eq(tables.jobs.id, app.jobId) }),
    db.query.applicationAnswers.findMany({
      where: eq(tables.applicationAnswers.applicationId, app.id),
      orderBy: asc(tables.applicationAnswers.sortOrder),
    }),
    db.query.events.findMany({
      where: eq(tables.events.applicationId, app.id),
      orderBy: desc(tables.events.createdAt),
    }),
  ]);
  return NextResponse.json({ application: app, job, answers, events });
}

// PATCH { status?, notes?, nextActionAt?, nextActionNote?, coverLetter? }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const appId = Number(id);
  const current = await db.query.applications.findFirst({ where: eq(tables.applications.id, appId) });
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  const update: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of ["status", "notes", "nextActionNote", "coverLetter"]) {
    if (key in body) update[key] = body[key];
  }
  if ("nextActionAt" in body) update.nextActionAt = body.nextActionAt ? new Date(body.nextActionAt) : null;
  await db.update(tables.applications).set(update).where(eq(tables.applications.id, appId));

  if (body.status && body.status !== current.status) {
    await db.insert(tables.events).values({
      applicationId: appId,
      type: "status_change",
      detail: `${current.status} → ${body.status}`,
    });
  }
  return NextResponse.json({ ok: true });
}
