import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { TAILORED_DIR } from "@/lib/latex";

// GET → the compiled tailored-resume PDF for this application
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = await db.query.applications.findFirst({ where: eq(tables.applications.id, Number(id)) });
  if (!app?.tailoredResumePdf) return NextResponse.json({ error: "no tailored resume" }, { status: 404 });
  // the stored value is a bare generated filename (app-<id>.pdf), but resolve+check anyway
  const pdfPath = path.resolve(TAILORED_DIR, app.tailoredResumePdf);
  if (!pdfPath.startsWith(TAILORED_DIR) || !fs.existsSync(pdfPath))
    return NextResponse.json({ error: "pdf missing" }, { status: 404 });
  return new NextResponse(new Uint8Array(fs.readFileSync(pdfPath)), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${app.tailoredResumePdf}"`,
    },
  });
}
