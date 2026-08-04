import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { desc, eq } from "drizzle-orm";
import { rememberAnswer } from "@/lib/answers";

export async function GET() {
  const rows = await db.query.qaBank.findMany({ orderBy: desc(tables.qaBank.timesUsed) });
  return NextResponse.json({ qa: rows });
}

// POST { question, answer }
export async function POST(req: NextRequest) {
  const { question, answer } = await req.json();
  if (!question || !answer) return NextResponse.json({ error: "question and answer required" }, { status: 400 });
  await rememberAnswer(question, answer);
  return NextResponse.json({ ok: true });
}

// DELETE { id }
export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  await db.delete(tables.qaBank).where(eq(tables.qaBank.id, Number(id)));
  return NextResponse.json({ ok: true });
}
