import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting, DEFAULTS } from "@/lib/settings";

export async function GET() {
  const settings = {
    openrouterApiKey: (await getSetting("openrouterApiKey", "")) ? "•••set•••" : "",
    openrouterKeyFromEnv: !!process.env.OPENROUTER_API_KEY,
    scoringModel: await getSetting("scoringModel", DEFAULTS.scoringModel),
    writerModel: await getSetting("writerModel", DEFAULTS.writerModel),
    queueThreshold: await getSetting("queueThreshold", DEFAULTS.queueThreshold),
    maxQueuedPerCompany: await getSetting("maxQueuedPerCompany", DEFAULTS.maxQueuedPerCompany),
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
    "openrouterApiKey",
    "scoringModel",
    "writerModel",
    "queueThreshold",
    "maxQueuedPerCompany",
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
  return NextResponse.json({ ok: true });
}
