import { NextRequest, NextResponse } from "next/server";
import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { TAILORED_DIR } from "@/lib/latex";
import { getProfileValue } from "@/lib/candidate";

// What the file is called wherever it lands: the browser tab, the download, and the
// attachment the extension uploads. Recruiters see this name, so it reads like a person
// wrote it rather than like our storage key (app-12.pdf / 1785878398796-....pdf).
async function attachmentName(): Promise<string> {
  const fullName = ((await getProfileValue<string>("fullName")) || "").trim();
  const base = fullName ? `${fullName} - Resume` : "Resume";
  // strip anything that would break the Content-Disposition header or a filesystem
  return `${base.replace(/[\\/:*?"<>|\r\n]/g, " ").replace(/\s+/g, " ").trim()}.pdf`;
}

// GET → the resume PDF this application would attach: tailored if present, else default
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = await db.query.applications.findFirst({ where: eq(tables.applications.id, Number(id)) });
  if (!app) return NextResponse.json({ error: "not found" }, { status: 404 });

  let pdfPath: string | null = null;
  let fileName: string | null = null;
  if (app.tailoredResumePdf) {
    // the stored value is a bare generated filename (app-<id>.pdf), but resolve+check anyway
    const p = path.resolve(TAILORED_DIR, app.tailoredResumePdf);
    if (p.startsWith(TAILORED_DIR) && fs.existsSync(p)) {
      pdfPath = p;
      fileName = app.tailoredResumePdf;
    }
  }
  if (!pdfPath) {
    const dflt = await db.query.resumes.findFirst({ where: eq(tables.resumes.isDefault, true) });
    if (dflt) {
      const dir = path.join(process.cwd(), "data", "resumes");
      const p = path.resolve(dir, dflt.fileName);
      if (p.startsWith(dir) && fs.existsSync(p)) {
        pdfPath = p;
        fileName = dflt.fileName;
      }
    }
  }
  if (!pdfPath || !fileName) return NextResponse.json({ error: "no resume on file" }, { status: 404 });

  const downloadName = await attachmentName();
  return new NextResponse(new Uint8Array(fs.readFileSync(pdfPath)), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
    },
  });
}
