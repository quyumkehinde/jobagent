import { NextRequest, NextResponse } from "next/server";
import { tailorResume } from "@/lib/tailor";

// POST → (re)generate the tailored resume for this application from the base LaTeX
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const result = await tailorResume(Number(id));
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
  }
}
