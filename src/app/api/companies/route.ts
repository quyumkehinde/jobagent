import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { and, asc, count, eq, isNotNull, isNull, like, or, SQL } from "drizzle-orm";
import { CONNECTORS, AtsName } from "@/connectors/registry";

// GET /api/companies?status=all|resolved|pending|unresolved|inactive&q=&limit=&offset=
// Server-side filtering/paging — the company table must survive a 6k-row import.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") || "all";
  const q = sp.get("q");
  const limit = Math.min(Number(sp.get("limit")) || 50, 200);
  const offset = Number(sp.get("offset")) || 0;

  const conds: (SQL | undefined)[] = [];
  if (status === "resolved")
    conds.push(or(eq(tables.companies.resolveStatus, "resolved"), and(isNull(tables.companies.resolveStatus), isNotNull(tables.companies.ats))));
  else if (status === "pending")
    conds.push(or(eq(tables.companies.resolveStatus, "pending"), eq(tables.companies.resolveStatus, "probing")));
  else if (status === "unresolved") conds.push(eq(tables.companies.resolveStatus, "unresolved"));
  else if (status === "inactive") conds.push(eq(tables.companies.active, false));
  if (q) conds.push(or(like(tables.companies.name, `%${q}%`), like(tables.companies.token, `%${q}%`)));
  const where = conds.length ? and(...conds) : undefined;

  const [rows, [{ value: total }]] = await Promise.all([
    db.query.companies.findMany({ where, orderBy: asc(tables.companies.name), limit, offset }),
    db.select({ value: count() }).from(tables.companies).where(where),
  ]);

  const countBy = async (w: SQL | undefined) =>
    (await db.select({ value: count() }).from(tables.companies).where(w))[0].value;
  const counts = {
    all: await countBy(undefined),
    pending: await countBy(or(eq(tables.companies.resolveStatus, "pending"), eq(tables.companies.resolveStatus, "probing"))),
    unresolved: await countBy(eq(tables.companies.resolveStatus, "unresolved")),
    resolved: await countBy(
      or(eq(tables.companies.resolveStatus, "resolved"), and(isNull(tables.companies.resolveStatus), isNotNull(tables.companies.ats)))
    ),
    inactive: await countBy(eq(tables.companies.active, false)),
  };

  return NextResponse.json({ companies: rows, total, counts });
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

// PATCH { id, active?, visaSponsor?, ats?+token?, careersUrl?, retryResolve? }
export async function PATCH(req: NextRequest) {
  const { id, ...fields } = await req.json();
  const update: Record<string, unknown> = {};
  if ("active" in fields) {
    update.active = !!fields.active;
    if (fields.active) update.errorCount = 0;
  }
  if ("visaSponsor" in fields) update.visaSponsor = fields.visaSponsor;

  // manual board override: probe-validate, but the human wins even on mismatch
  if (fields.ats && fields.token) {
    const conn = CONNECTORS[fields.ats as AtsName];
    if (!conn) return NextResponse.json({ error: `unknown ats "${fields.ats}"` }, { status: 400 });
    const probe = await conn.probe(String(fields.token));
    update.ats = fields.ats;
    update.token = String(fields.token);
    update.active = true;
    update.errorCount = 0;
    update.resolveStatus = "resolved";
    update.resolveNote = probe.exists
      ? `set manually${probe.boardName ? ` (board reports "${probe.boardName}")` : ""}`
      : "set manually — WARNING: probe found no board at this token";
  }
  if ("careersUrl" in fields) update.careersUrl = fields.careersUrl || null;
  if (fields.retryResolve) {
    update.resolveStatus = "pending";
    update.resolveNote = null;
  }

  await db.update(tables.companies).set(update).where(eq(tables.companies.id, Number(id)));
  return NextResponse.json({ ok: true });
}
