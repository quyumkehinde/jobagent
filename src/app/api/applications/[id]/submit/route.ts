import { NextRequest, NextResponse } from "next/server";
import { trySubmit, markSubmittedManually, SubmitNotPossibleError } from "@/lib/submit";

// POST { mode: "auto" | "manual" }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { mode } = await req.json();
  const appId = Number(id);
  if (mode === "manual") {
    await markSubmittedManually(appId);
    return NextResponse.json({ submitted: true, method: "assisted" });
  }
  try {
    await trySubmit(appId);
    return NextResponse.json({ submitted: true, method: "api" });
  } catch (err) {
    if (err instanceof SubmitNotPossibleError) {
      return NextResponse.json({ submitted: false, assisted: true, reason: err.message });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
