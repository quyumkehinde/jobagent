// Live check of the scoring PROMPT against the spec's acceptance JDs: sends them through
// the real model in one batch and applies the real queueing rule. Spends one LLM call.
// (The rule itself is unit-tested without the model: `npm test`.)
//   npx tsx --env-file-if-exists=.env.local scripts/eval-scoring.ts
import { generateJSON } from "@/lib/llm";
import { buildCandidateSummary } from "@/lib/candidate";
import { getSetting, getTargetingSettings, DEFAULTS } from "@/lib/settings";
import { SYSTEM, RESPONSE_SCHEMA, decide, type ScoreResult } from "@/lib/scoring";
import { shouldQueue } from "@/lib/targeting";

const CASES: { title: string; company: string; location: string; jd: string; expect: string }[] = [
  { title: "Backend Engineer", company: "Payfold (payments API)", location: "Remote (US only)", jd: "Build our payments API. 3+ years of backend experience. Must be authorized to work in the United States.", expect: "flagged" },
  { title: "Backend Engineer, Payments Infrastructure", company: "Ledgerline", location: "Fully remote, anywhere", jd: "We build payments infrastructure for marketplaces. This role is fully remote and you can work from anywhere in the world. 3+ years of experience with Go or Java.", expect: "remote" },
  { title: "Software Engineer", company: "Vaultr (stablecoin custody)", location: "Remote, EMEA", jd: "Vaultr provides institutional stablecoin custody. We hire remotely across EMEA. You have solid backend experience.", expect: "remote" },
  { title: "Backend Engineer", company: "Shopnest", location: "Remote, Europe only", jd: "Remote within Europe only (EU residents). Backend engineer on our marketplace.", expect: "flagged" },
  { title: "Go Backend Engineer", company: "Buildkit Cloud (developer tools)", location: "Fully remote, worldwide", jd: "Developer-tools company building CI infrastructure. Fully remote, hire anywhere. 2+ years with Go, Kubernetes and Postgres.", expect: "remote|both" },
  { title: "Software Engineer, New Grad", company: "Tradewise", location: "Hybrid · London", jd: "New grad role. Hybrid: 3 days a week in our London office. Visa sponsorship available.", expect: "early-career" },
  { title: "Junior Backend Developer", company: "Stadtwerk Digital", location: "Onsite · Berlin", jd: "Junior developer joining our Berlin team, fully on-site.", expect: "none" },
  { title: "New Grad Software Engineer", company: "Snapclip (consumer video app)", location: "Remote, worldwide", jd: "New grads welcome. Fully remote; we hire worldwide.", expect: "both" },
  { title: "Senior Staff Engineer", company: "Clearbank Cloud (core banking)", location: "Remote, worldwide", jd: "Senior staff engineer for our core banking ledger. Remote worldwide. 10+ years.", expect: "none" },
  { title: "Backend Engineer", company: "Payrollo (payroll APIs)", location: "", jd: "We build payroll APIs. 3+ years with Go.", expect: "needs-check" },
];

(async () => {
  const model = await getSetting("scoringModel", DEFAULTS.scoringModel);
  const threshold = await getSetting("queueThreshold", DEFAULTS.queueThreshold);
  const targeting = await getTargetingSettings();
  const jobsText = CASES.map(
    (c, i) => `--- JOB ${i} ---\nTitle: ${c.title}\nCompany: ${c.company}\nLocation: ${c.location || "unspecified"}\nDescription (excerpt):\n${c.jd}`
  ).join("\n\n");
  const results = await generateJSON<ScoreResult[]>(
    `CANDIDATE PROFILE:\n${await buildCandidateSummary()}\n\nClassify and score each of the following ${CASES.length} jobs for this candidate. Return one entry per job, using the job's index.\n\n${jobsText}`,
    { model, system: SYSTEM, responseSchema: RESPONSE_SCHEMA, temperature: 0.1 }
  );
  let fails = 0;
  for (const r of results.sort((a, b) => a.index - b.index)) {
    const c = CASES[r.index];
    const d = decide({ ...r, baseScore: r.score }, targeting);
    const got = d.category !== "none" ? d.category : d.flagged ? "flagged" : d.needsCheck ? "needs-check" : "none";
    const queues = shouldQueue(d.score, threshold, d);
    // a category verdict only counts if the job also clears the threshold and queues
    const ok = c.expect.split("|").includes(got) && queues === (d.category !== "none");
    if (!ok) fails++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${c.title} @ ${c.company}: expected ${c.expect}, got ${got}` +
        ` (score ${r.score}→${d.score}${queues ? ", queues" : ""}; ${r.workMode}/${r.remoteEligibility}/${r.officeRegion}, ${r.seniority}, ${r.minYearsExperience ?? "-"}y, visa ${r.visaSignal}, ${r.domain})`
    );
  }
  console.log(`${CASES.length - fails}/${CASES.length} passed`);
  process.exit(fails ? 1 : 0);
})();
