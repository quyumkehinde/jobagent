import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import { rememberAnswer } from "@/lib/answers";

// PATCH { answer, remember?: boolean }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const row = await db.query.applicationAnswers.findFirst({
    where: eq(tables.applicationAnswers.id, Number(id)),
  });
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
  await db
    .update(tables.applicationAnswers)
    .set({ answer: body.answer, aiGenerated: false, confidence: "high" })
    .where(eq(tables.applicationAnswers.id, row.id));
  if (body.remember) await rememberAnswer(row.label, body.answer);
  return NextResponse.json({ ok: true });
}
