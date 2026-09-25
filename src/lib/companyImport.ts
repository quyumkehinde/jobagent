import { db, tables } from "@/db";
import { eq, isNull } from "drizzle-orm";
import { normalizeCompanyName } from "./resolve";

export interface ImportDefaults {
  visaSponsor: boolean | null; // null = unknown
  country: string | null;
  sector: string | null; // e.g. "fintech" — shown to the scorer as domain context
}

export interface ImportResult {
  added: number;
  updatedExisting: number;
  skipped: number;
  total: number;
}

// text: one company name per line, or CSV lines "name,country,visaSponsor".
// Idempotent: matches existing companies on normalized name and only fills in flags
// that are still unknown. New rows enter as pending imports for the resolution engine.
export async function importCompanies(text: string, defaults: ImportDefaults): Promise<ImportResult> {
  // one-time backfill so pre-existing rows (seeds, discovery) participate in dedupe
  const missing = await db.query.companies.findMany({
    where: isNull(tables.companies.nameNormalized),
    columns: { id: true, name: true },
  });
  for (const m of missing) {
    await db
      .update(tables.companies)
      .set({ nameNormalized: normalizeCompanyName(m.name) })
      .where(eq(tables.companies.id, m.id));
  }

  let added = 0;
  let updatedExisting = 0;
  let skipped = 0;
  const seenThisImport = new Set<string>();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // CSV form: name,country,visaSponsor — but names can contain commas, so only
    // treat trailing fields as metadata when they look like it
    let name = line;
    let country = defaults.country;
    let visaSponsor = defaults.visaSponsor;
    const parts = line.split(",").map((s) => s.trim());
    if (parts.length >= 2) {
      const tail = [...parts];
      const last = tail[tail.length - 1].toLowerCase();
      if (["true", "false", "yes", "no", "1", "0"].includes(last)) {
        visaSponsor = ["true", "yes", "1"].includes(last);
        tail.pop();
      }
      const maybeCountry = tail[tail.length - 1];
      if (tail.length >= 2 && /^[a-zA-Z]{2}$/.test(maybeCountry)) {
        country = maybeCountry.toUpperCase();
        tail.pop();
      }
      name = tail.join(",").trim();
    }
    if (!name) continue;

    const norm = normalizeCompanyName(name);
    if (!norm || seenThisImport.has(norm)) {
      skipped++;
      continue;
    }
    seenThisImport.add(norm);

    const existing = await db.query.companies.findFirst({
      where: eq(tables.companies.nameNormalized, norm),
      columns: { id: true, visaSponsor: true, country: true, sector: true },
    });
    if (existing) {
      await db
        .update(tables.companies)
        .set({
          visaSponsor: existing.visaSponsor ?? visaSponsor,
          country: existing.country ?? country,
          sector: existing.sector ?? defaults.sector,
        })
        .where(eq(tables.companies.id, existing.id));
      updatedExisting++;
      continue;
    }

    await db.insert(tables.companies).values({
      name,
      nameNormalized: norm,
      origin: "import",
      visaSponsor,
      country,
      sector: defaults.sector,
      resolveStatus: "pending",
      active: true,
    });
    added++;
  }

  return { added, updatedExisting, skipped, total: added + updatedExisting + skipped };
}
