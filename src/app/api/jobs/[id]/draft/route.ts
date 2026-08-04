import { NextRequest, NextResponse } from "next/server";
import { draftApplication } from "@/lib/answers";

// Creates the application draft (form fetch + answer generation). Can take ~30s
// due to Gemini free-tier pacing.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await draftApplication(Number(id));
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
