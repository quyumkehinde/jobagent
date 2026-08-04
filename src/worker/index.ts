// Worker process: runs the scrape -> ingest -> discover -> score pipeline on a schedule.
// Start with: npm run worker
import cron from "node-cron";
import { runPipeline } from "@/lib/pipeline";
import { getSetting, DEFAULTS } from "@/lib/settings";
import { seedCompaniesIfEmpty } from "@/lib/seed";
import { createLogger } from "@/lib/log";

const log = createLogger("worker");

async function tick() {
  try {
    await runPipeline(); // pipeline logs its own start/done/failure
  } catch (err) {
    log.error("tick failed", { error: String(err).slice(0, 300) });
  }
}

async function main() {
  await seedCompaniesIfEmpty();
  const hours = await getSetting("scrapeIntervalHours", DEFAULTS.scrapeIntervalHours);
  log.info("scheduled", { everyHours: hours, cron: `5 */${hours} * * *` });
  cron.schedule(`5 */${hours} * * *`, tick);
  await tick();
}

main();
