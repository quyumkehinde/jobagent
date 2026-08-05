import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting, DEFAULTS } from "@/lib/settings";

export async function GET() {
  const settings = {
    geminiApiKey: (await getSetting("geminiApiKey", "")) ? "•••set•••" : "",
    geminiKeyFromEnv: !!process.env.GEMINI_API_KEY,
    scoringModel: await getSetting("scoringModel", DEFAULTS.scoringModel),
    writerModel: await getSetting("writerModel", DEFAULTS.writerModel),
    queueThreshold: await getSetting("queueThreshold", DEFAULTS.queueThreshold),
    maxQueuedPerCompany: await getSetting("maxQueuedPerCompany", DEFAULTS.maxQueuedPerCompany),
    scrapeIntervalHours: await getSetting("scrapeIntervalHours", DEFAULTS.scrapeIntervalHours),
    maxScoringPerRun: await getSetting("maxScoringPerRun", DEFAULTS.maxScoringPerRun),
    closeAfterDays: await getSetting("closeAfterDays", DEFAULTS.closeAfterDays),
    geminiMinIntervalMs: await getSetting("geminiMinIntervalMs", DEFAULTS.geminiMinIntervalMs),
    resolveBatchPerRun: await getSetting("resolveBatchPerRun", DEFAULTS.resolveBatchPerRun),
    resolveWebPerRun: await getSetting("resolveWebPerRun", DEFAULTS.resolveWebPerRun),
  };
  return NextResponse.json({ settings });
}

export async function PUT(req: NextRequest) {
  const body = (await req.json()) as Record<string, unknown>;
  const allowed = [
    "geminiApiKey",
    "scoringModel",
    "writerModel",
    "queueThreshold",
    "maxQueuedPerCompany",
    "scrapeIntervalHours",
    "maxScoringPerRun",
    "closeAfterDays",
    "geminiMinIntervalMs",
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
