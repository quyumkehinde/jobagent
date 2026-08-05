// Quick connector smoke test: hits one real board per source, prints counts.
import { fetchGreenhouse } from "../src/connectors/greenhouse";
import { fetchLever } from "../src/connectors/lever";
import { fetchAshby } from "../src/connectors/ashby";
import { fetchRemoteOk } from "../src/connectors/remoteok";
import { fetchWeWorkRemotely } from "../src/connectors/weworkremotely";
import { fetchHnWhoIsHiring } from "../src/connectors/hn";
import { fetchYcJobs } from "../src/connectors/yc";
import { fetchRecruitee } from "../src/connectors/recruitee";
import { fetchWorkable } from "../src/connectors/workable";
import { fetchPersonio } from "../src/connectors/personio";
import { fetchSmartrecruiters } from "../src/connectors/smartrecruiters";
import { fetchBreezy } from "../src/connectors/breezy";
import { fetchBamboohr } from "../src/connectors/bamboohr";

async function main() {
  const tests: [string, () => Promise<{ title: string }[]>][] = [
    ["greenhouse(gitlab)", () => fetchGreenhouse("gitlab", "GitLab", 0)],
    ["lever(kraken)", () => fetchLever("kraken", "Kraken", 0)],
    ["ashby(openai)", () => fetchAshby("openai", "OpenAI", 0)],
    ["remoteok", fetchRemoteOk],
    ["weworkremotely", fetchWeWorkRemotely],
    ["hn", fetchHnWhoIsHiring],
    ["yc", () => fetchYcJobs(undefined, 3)],
    ["recruitee(tellent)", () => fetchRecruitee("tellent", "Tellent", 0)],
    ["workable(blueground)", () => fetchWorkable("blueground", "Blueground", 0)],
    ["personio(personio-gmbh)", () => fetchPersonio("personio-gmbh", "Personio", 0, undefined, 3)],
    ["smartrecruiters(smartrecruiters)", () => fetchSmartrecruiters("smartrecruiters", "SmartRecruiters", 0, undefined, 3)],
    ["breezy(breezy-hr)", () => fetchBreezy("breezy-hr", "Breezy HR", 0, undefined, 3)],
    ["bamboohr(sendoso)", () => fetchBamboohr("sendoso", "Sendoso", 0, undefined, 3)],
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
