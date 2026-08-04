import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";

export async function GET() {
  const rows = await db.query.profile.findMany();
  const profile: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      profile[r.key] = JSON.parse(r.value);
    } catch {
      profile[r.key] = r.value;
    }
  }
  return NextResponse.json({ profile });
}

// PUT { key1: value1, ... } — upserts every provided key
export async function PUT(req: NextRequest) {
  const body = (await req.json()) as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    const json = JSON.stringify(value);
    await db
      .insert(tables.profile)
      .values({ key, value: json })
      .onConflictDoUpdate({ target: tables.profile.key, set: { value: json, updatedAt: new Date() } });
  }
  return NextResponse.json({ ok: true });
}
