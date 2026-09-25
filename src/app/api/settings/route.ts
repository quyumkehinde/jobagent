import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting, getTargetingSettings, DEFAULTS } from "@/lib/settings";
import { rebalanceCompanyQueues } from "@/lib/scoring";

// settings that change code-owned verdicts — saving one re-derives scores/categories now
const TARGETING_KEYS = ["maxYearsRemote", "enableCategoryA", "enableCategoryB", "domainBoosts", "queueThreshold"];

export async function GET() {
  const settings = {
    llmProvider: await getSetting("llmProvider", DEFAULTS.llmProvider),
    openrouterApiKey: (await getSetting("openrouterApiKey", "")) ? "•••set•••" : "",
    openrouterKeyFromEnv: !!process.env.OPENROUTER_API_KEY,
    scoringModel: await getSetting("scoringModel", DEFAULTS.scoringModel),
    writerModel: await getSetting("writerModel", DEFAULTS.writerModel),
    queueThreshold: await getSetting("queueThreshold", DEFAULTS.queueThreshold),
    maxQueuedPerCompany: await getSetting("maxQueuedPerCompany", DEFAULTS.maxQueuedPerCompany),
    ...(await getTargetingSettings()),
    scrapeIntervalHours: await getSetting("scrapeIntervalHours", DEFAULTS.scrapeIntervalHours),
    maxScoringPerRun: await getSetting("maxScoringPerRun", DEFAULTS.maxScoringPerRun),
    closeAfterDays: await getSetting("closeAfterDays", DEFAULTS.closeAfterDays),
    llmMinIntervalMs: await getSetting("llmMinIntervalMs", DEFAULTS.llmMinIntervalMs),
    resolveBatchPerRun: await getSetting("resolveBatchPerRun", DEFAULTS.resolveBatchPerRun),
    resolveWebPerRun: await getSetting("resolveWebPerRun", DEFAULTS.resolveWebPerRun),
  };
  return NextResponse.json({ settings });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as Record<string, unknown>;
  const allowed = [
    "llmProvider",
    "openrouterApiKey",
    "scoringModel",
    "writerModel",
    "queueThreshold",
    "maxQueuedPerCompany",
    "maxYearsRemote",
    "enableCategoryA",
    "enableCategoryB",
    "domainBoosts",
    "scrapeIntervalHours",
    "maxScoringPerRun",
    "closeAfterDays",
    "llmMinIntervalMs",
    "resolveBatchPerRun",
    "resolveWebPerRun",
    "headlessPagesPerRun",
    "headlessResolvePerRun",
  ];
  for (const key of allowed) {
    if (key in body && body[key] !== "•••set•••") await setSetting(key, body[key]);
  }
  if (TARGETING_KEYS.some((k) => k in body))
    await rebalanceCompanyQueues(
      await getSetting("queueThreshold", DEFAULTS.queueThreshold),
      await getSetting("maxQueuedPerCompany", DEFAULTS.maxQueuedPerCompany)
    );
  return NextResponse.json({ ok: true });
}
