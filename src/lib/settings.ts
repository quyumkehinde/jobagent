import { db, tables } from "@/db";
import { eq } from "drizzle-orm";

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.query.settings.findFirst({
    where: eq(tables.settings.key, key),
  });
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value);
  await db
    .insert(tables.settings)
    .values({ key, value: json })
    .onConflictDoUpdate({ target: tables.settings.key, set: { value: json } });
}

export const DEFAULTS = {
  scoringModel: "gemini-3.6-flash",
  writerModel: "gemini-3.6-flash",
  queueThreshold: 55, // score >= this -> auto-queued into review feed
  maxQueuedPerCompany: 5, // per company, keep only the N best-scoring jobs queued
  scrapeIntervalHours: 3,
  maxScoringPerRun: 120, // cap Gemini scoring calls per scrape run (batched 8/call)
  resolveBatchPerRun: 1000, // imported companies probed per pipeline run
  resolveWebPerRun: 40, // of those, how many may use the web-search fallback
  genericCompaniesPerRun: 10, // unresolved-with-careersUrl companies scraped per run
  genericJobsPerCompany: 15, // job-page fetches per company per run
  genericGeminiPerRun: 5, // Gemini extraction calls the generic scraper may spend per run
  headlessPagesPerRun: 30, // headless-Chrome renders the generic scraper may spend per run
  headlessResolvePerRun: 10, // headless renders the resolution web-fallback may spend per run
  closeAfterDays: 14, // board-backed jobs unseen this long are marked closed
  geminiMinIntervalMs: 6500, // free tier ~9 RPM; drop to ~500 on a paid key
};
