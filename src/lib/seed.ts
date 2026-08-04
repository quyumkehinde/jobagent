import fs from "node:fs";
import path from "node:path";
import { db, tables } from "@/db";

interface SeedCompany {
  name: string;
  ats: "greenhouse" | "lever" | "ashby";
  token: string;
  visaSponsor?: boolean;
}

export async function seedCompaniesIfEmpty(): Promise<number> {
  const existing = await db.query.companies.findFirst();
  if (existing) return 0;
  const file = path.join(process.cwd(), "seed", "companies.json");
  if (!fs.existsSync(file)) return 0;
  const list = JSON.parse(fs.readFileSync(file, "utf8")) as SeedCompany[];
  let added = 0;
  for (const c of list) {
    const res = await db
      .insert(tables.companies)
      .values({ name: c.name, ats: c.ats, token: c.token, visaSponsor: c.visaSponsor, origin: "seed" })
      .onConflictDoNothing();
    if (res.changes > 0) added++;
  }
  console.log(`[seed] inserted ${added} companies`);
  return added;
}
