// Worker process: runs the scrape -> ingest -> discover -> score pipeline on a schedule.
// Start with: npm run worker
import cron from "node-cron";
import { runPipeline } from "@/lib/pipeline";
import { getSetting, DEFAULTS } from "@/lib/settings";
import { seedCompaniesIfEmpty } from "@/lib/seed";

async function tick() {
  const started = new Date().toISOString();
  console.log(`[worker] pipeline start ${started}`);
  try {
    const result = await runPipeline();
    console.log(`[worker] done:`, result);
  } catch (err) {
    console.error(`[worker] pipeline failed:`, err);
  }
}

async function main() {
  await seedCompaniesIfEmpty();
  const hours = await getSetting("scrapeIntervalHours", DEFAULTS.scrapeIntervalHours);
  console.log(`[worker] scheduling every ${hours}h; running once now`);
  cron.schedule(`5 */${hours} * * *`, tick);
  await tick();
}

main();
