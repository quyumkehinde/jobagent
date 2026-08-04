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
  scrapeIntervalHours: 3,
  maxScoringPerRun: 120, // cap Gemini scoring calls per scrape run (batched 8/call)
};
