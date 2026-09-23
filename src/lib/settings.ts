import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import type { DomainBoosts, TargetingSettings } from "./targeting";

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
  llmProvider: "openrouter", // "openrouter" | "claude" (headless Claude Code CLI on the user's subscription)
  scoringModel: "stealth/ox-alpha",
  writerModel: "stealth/ox-alpha",
  queueThreshold: 55, // score >= this -> auto-queued into review feed
  maxQueuedPerCompany: 5, // per company, keep only the N best-scoring jobs queued
  maxYearsRemote: 4, // category A (fully remote): max stated years of experience
  enableCategoryA: true, // queue fully-remote roles hireable from Nigeria
  enableCategoryB: true, // queue early-career roles (remote, or onsite/hybrid with sponsorship)
  // points added to the model's score per domain, so better-fit domains rank higher
  domainBoosts: { fintech: 15, "infra-devtools-data": 10, "ai-tooling": 8, "general-backend": 0, other: 0 },
  scrapeIntervalHours: 3,
  maxScoringPerRun: 120, // cap LLM scoring calls per scrape run (batched 8/call)
  resolveBatchPerRun: 1000, // imported companies probed per pipeline run
  resolveWebPerRun: 40, // of those, how many may use the web-search fallback
  genericCompaniesPerRun: 10, // unresolved-with-careersUrl companies scraped per run
  genericJobsPerCompany: 15, // job-page fetches per company per run
  genericLlmPerRun: 5, // LLM extraction calls the generic scraper may spend per run
  headlessPagesPerRun: 30, // headless-Chrome renders the generic scraper may spend per run
  headlessResolvePerRun: 10, // headless renders the resolution web-fallback may spend per run
  closeAfterDays: 14, // board-backed jobs unseen this long are marked closed
  llmMinIntervalMs: 3000, // OpenRouter free/preview models are RPM-limited; drop on a paid tier
};

export async function getTargetingSettings(): Promise<TargetingSettings & { domainBoosts: DomainBoosts }> {
  return {
    maxYearsRemote: await getSetting("maxYearsRemote", DEFAULTS.maxYearsRemote),
    enableCategoryA: await getSetting("enableCategoryA", DEFAULTS.enableCategoryA),
    enableCategoryB: await getSetting("enableCategoryB", DEFAULTS.enableCategoryB),
    // merged so a domain added later still gets its default
    domainBoosts: { ...DEFAULTS.domainBoosts, ...(await getSetting<Partial<DomainBoosts>>("domainBoosts", {})) },
  };
}
