import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { asc, eq } from "drizzle-orm";

export async function GET() {
  const rows = await db.query.companies.findMany({ orderBy: asc(tables.companies.name) });
  return NextResponse.json({ companies: rows });
}

// POST { name, ats, token } — add a board manually
export async function POST(req: NextRequest) {
  const { name, ats, token } = await req.json();
  if (!name || !ats || !token) return NextResponse.json({ error: "name, ats, token required" }, { status: 400 });
  const [row] = await db
    .insert(tables.companies)
    .values({ name, ats, token, origin: "manual" })
    .onConflictDoNothing()
    .returning();
  return NextResponse.json({ company: row || null });
}

// PATCH { id, active?, visaSponsor? }
export async function PATCH(req: NextRequest) {
  const { id, ...fields } = await req.json();
  const update: Record<string, unknown> = {};
  if ("active" in fields) {
    update.active = !!fields.active;
    if (fields.active) update.errorCount = 0;
  }
  if ("visaSponsor" in fields) update.visaSponsor = fields.visaSponsor;
  await db.update(tables.companies).set(update).where(eq(tables.companies.id, Number(id)));
  return NextResponse.json({ ok: true });
}
