import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db, tables } from "@/db";
import { desc, ne } from "drizzle-orm";
import { parseResume } from "@/lib/resume";

export async function GET() {
  const rows = await db.query.resumes.findMany({ orderBy: desc(tables.resumes.createdAt) });
  return NextResponse.json({ resumes: rows });
}

// multipart upload: file field "resume"; parses immediately after saving
export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("resume") as File | null;
  if (!file) return NextResponse.json({ error: "no file" }, { status: 400 });
  if (!/\.pdf$/i.test(file.name)) return NextResponse.json({ error: "PDF only for now" }, { status: 400 });

  const dir = path.join(process.cwd(), "data", "resumes");
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  fs.writeFileSync(path.join(dir, fileName), Buffer.from(await file.arrayBuffer()));

  const [row] = await db
    .insert(tables.resumes)
    .values({ name: file.name, fileName, isDefault: true })
    .returning();
  // only one default
  await db.update(tables.resumes).set({ isDefault: false }).where(ne(tables.resumes.id, row.id));

  try {
    const parsed = await parseResume(row.id);
    return NextResponse.json({ resume: row, parsed });
  } catch (err) {
    return NextResponse.json({ resume: row, parseError: String(err) });
  }
}
