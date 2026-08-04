// Quick connector smoke test: hits one real board per source, prints counts.
import { fetchGreenhouse } from "../src/connectors/greenhouse";
import { fetchLever } from "../src/connectors/lever";
import { fetchAshby } from "../src/connectors/ashby";
import { fetchRemoteOk } from "../src/connectors/remoteok";
import { fetchWeWorkRemotely } from "../src/connectors/weworkremotely";
import { fetchHnWhoIsHiring } from "../src/connectors/hn";
import { fetchYcJobs } from "../src/connectors/yc";

async function main() {
  const tests: [string, () => Promise<{ title: string }[]>][] = [
    ["greenhouse(gitlab)", () => fetchGreenhouse("gitlab", "GitLab", 0)],
    ["lever(kraken)", () => fetchLever("kraken", "Kraken", 0)],
    ["ashby(openai)", () => fetchAshby("openai", "OpenAI", 0)],
    ["remoteok", fetchRemoteOk],
    ["weworkremotely", fetchWeWorkRemotely],
    ["hn", fetchHnWhoIsHiring],
    ["yc", () => fetchYcJobs(undefined, 3)],
  ];
  for (const [name, fn] of tests) {
    try {
      const jobs = await fn();
      console.log(`✓ ${name}: ${jobs.length} relevant jobs — e.g. "${jobs[0]?.title ?? "n/a"}"`);
    } catch (err) {
      console.log(`✗ ${name}: ${err}`);
    }
  }
}
main();
