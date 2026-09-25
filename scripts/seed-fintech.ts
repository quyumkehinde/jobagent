// Imports seed/fintech-companies.txt through the regular bulk-import path, tagged
// sector=fintech (sponsor status unknown). Idempotent: known companies just get the tag.
import fs from "node:fs";
import path from "node:path";
import { importCompanies } from "@/lib/companyImport";

(async () => {
  const text = fs.readFileSync(path.join(process.cwd(), "seed", "fintech-companies.txt"), "utf8");
  const result = await importCompanies(text, { visaSponsor: null, country: null, sector: "fintech" });
  console.log("[seed:fintech]", result);
})();
