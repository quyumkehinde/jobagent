import { NextRequest, NextResponse } from "next/server";
import { runCopilot, CopilotTurn } from "@/lib/copilot";

// POST { message, history?: [{role, text}] } → { reply, updated }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as { message?: string; history?: CopilotTurn[] };
  if (!body.message?.trim()) return NextResponse.json({ error: "message required" }, { status: 400 });
  try {
    const result = await runCopilot(Number(id), body.message.trim(), body.history || []);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
