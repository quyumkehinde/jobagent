import { db, tables } from "@/db";
import { eq } from "drizzle-orm";

// Builds a compact plain-text candidate summary used to ground scoring and answer generation.
export async function buildCandidateSummary(): Promise<string> {
  const rows = await db.query.profile.findMany();
  const p: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      p[r.key] = JSON.parse(r.value);
    } catch {
      p[r.key] = r.value;
    }
  }

  const resume = await db.query.resumes.findFirst({ where: eq(tables.resumes.isDefault, true) });
  const parsed = resume?.parsed ? JSON.parse(resume.parsed) : null;

  const lines: string[] = [];
  if (p.fullName) lines.push(`Name: ${p.fullName}`);
  if (p.headline) lines.push(`Headline: ${p.headline}`);
  if (p.location) lines.push(`Current location: ${p.location}`);
  lines.push(
    `Target roles: Software Engineer — backend, infrastructure/platform, full-stack, mobile.`,
    `Location preferences: (a) Remote roles hiring worldwide or in regions that include the candidate; (b) On-site/hybrid in London or anywhere in Europe ONLY IF the company sponsors work visas. Remote roles restricted to hiring within one specific country the candidate is not in are NOT eligible (flag as country-restricted).`
  );
  if (p.workAuthorization) lines.push(`Work authorization: ${JSON.stringify(p.workAuthorization)}`);
  if (p.salaryExpectation) lines.push(`Salary expectation: ${JSON.stringify(p.salaryExpectation)}`);
  if (p.noticePeriod) lines.push(`Notice period: ${p.noticePeriod}`);
  if (p.yearsExperience) lines.push(`Years of experience: ${p.yearsExperience}`);
  if (p.skills) lines.push(`Skills: ${Array.isArray(p.skills) ? (p.skills as string[]).join(", ") : p.skills}`);

  if (parsed) {
    if (parsed.summary) lines.push(`Summary: ${parsed.summary}`);
    if (Array.isArray(parsed.experience)) {
      lines.push("Experience:");
      for (const e of parsed.experience.slice(0, 8)) {
        lines.push(`- ${e.title} @ ${e.company} (${e.start || "?"}–${e.end || "present"}): ${(e.highlights || []).slice(0, 3).join("; ")}`);
      }
    }
    if (Array.isArray(parsed.education) && parsed.education.length) {
      lines.push(`Education: ${parsed.education.map((e: { school: string; degree?: string }) => `${e.degree || ""} ${e.school}`).join("; ")}`);
    }
  }
  return lines.join("\n");
}

export async function getProfileValue<T>(key: string): Promise<T | null> {
  const row = await db.query.profile.findFirst({ where: eq(tables.profile.key, key) });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}
