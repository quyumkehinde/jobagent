import { NextRequest, NextResponse } from "next/server";
import { importCompanies } from "@/lib/companyImport";

// POST { text, defaults?: { visaSponsor?: boolean | null, country?: string, sector?: string } }
// text: one company name per line, or CSV lines "name,country,visaSponsor".
// Idempotent: matches existing companies on normalized name and only updates flags.
export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    text?: string;
    defaults?: { visaSponsor?: boolean | null; country?: string; sector?: string };
  };
  if (!body.text?.trim()) return NextResponse.json({ error: "text required" }, { status: 400 });
  const result = await importCompanies(body.text, {
    visaSponsor: body.defaults?.visaSponsor === undefined ? true : body.defaults.visaSponsor,
    country: body.defaults?.country ?? null,
    sector: body.defaults?.sector?.trim().toLowerCase() || null,
  });
  return NextResponse.json(result);
}
