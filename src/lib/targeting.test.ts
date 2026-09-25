import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  shouldQueue,
  boostedScore,
  EARLY_CAREER_TITLE_RE,
  type TargetingFields,
  type Domain,
  type TargetCategory,
} from "./targeting";

const SETTINGS = { maxYearsRemote: 4, enableCategoryA: true, enableCategoryB: true };
const BOOSTS = { fintech: 15, "infra-devtools-data": 10, "ai-tooling": 8, "general-backend": 0, other: 0 };
const THRESHOLD = 55;

// Each fixture pairs a JD snippet with the classification a correct scorer must emit for
// it (per the prompt's definitions), then asserts what the code does with that output.
// The model is not exercised here: `scripts/eval-scoring.ts` runs the same JDs live.
interface Fixture {
  jd: string;
  model: TargetingFields & { baseScore: number; domain: Domain };
  expect: { category: TargetCategory; queued: boolean; flagged?: boolean; needsCheck?: boolean };
}

const FIXTURES: Fixture[] = [
  {
    jd: "Backend Engineer, Payments. Remote (US only). 3+ years.",
    model: { workMode: "fully-remote", officeRegion: "unknown", remoteEligibility: "country-restricted", seniority: "mid", minYearsExperience: 3, visaSignal: "unknown", baseScore: 70, domain: "fintech" },
    expect: { category: "none", queued: false, flagged: true, needsCheck: false },
  },
  {
    jd: "Fully remote, anywhere. Build our payments infrastructure. 3+ years of backend experience.",
    model: { workMode: "fully-remote", officeRegion: "unknown", remoteEligibility: "worldwide", seniority: "mid", minYearsExperience: 3, visaSignal: "unknown", baseScore: 60, domain: "fintech" },
    expect: { category: "remote", queued: true },
  },
  {
    jd: "Remote, EMEA. Stablecoin custody platform engineer.",
    model: { workMode: "fully-remote", officeRegion: "unknown", remoteEligibility: "emea-incl-africa", seniority: "mid", minYearsExperience: null, visaSignal: "unknown", baseScore: 65, domain: "fintech" },
    expect: { category: "remote", queued: true },
  },
  {
    jd: "Remote, Europe only. Backend engineer.",
    model: { workMode: "fully-remote", officeRegion: "unknown", remoteEligibility: "region-excludes-nigeria", seniority: "mid", minYearsExperience: null, visaSignal: "unknown", baseScore: 70, domain: "general-backend" },
    expect: { category: "none", queued: false, flagged: true },
  },
  {
    jd: "Fully remote, worldwide. Go backend engineer at a developer-tools company. 2+ years.",
    model: { workMode: "fully-remote", officeRegion: "unknown", remoteEligibility: "worldwide", seniority: "mid", minYearsExperience: 2, visaSignal: "unknown", baseScore: 60, domain: "infra-devtools-data" },
    // 2 yrs also satisfies the early-career bar, so it lands in both
    expect: { category: "both", queued: true },
  },
  {
    jd: "Hybrid London (3 days in office). New grad software engineer. Visa sponsorship available.",
    model: { workMode: "hybrid", officeRegion: "uk-europe", remoteEligibility: "unknown", seniority: "new-grad", minYearsExperience: null, visaSignal: "yes", baseScore: 65, domain: "general-backend" },
    expect: { category: "early-career", queued: true, needsCheck: false },
  },
  {
    jd: "Onsite Berlin. Junior backend developer.",
    model: { workMode: "onsite", officeRegion: "uk-europe", remoteEligibility: "unknown", seniority: "junior", minYearsExperience: null, visaSignal: "unknown", baseScore: 65, domain: "general-backend" },
    expect: { category: "none", queued: false, needsCheck: false },
  },
  {
    jd: "Remote, worldwide. New grad engineer at a consumer social app.",
    model: { workMode: "fully-remote", officeRegion: "unknown", remoteEligibility: "worldwide", seniority: "new-grad", minYearsExperience: null, visaSignal: "unknown", baseScore: 60, domain: "other" },
    expect: { category: "both", queued: true },
  },
  {
    jd: "Senior Staff Engineer. Remote, worldwide. Payments ledger.",
    model: { workMode: "fully-remote", officeRegion: "unknown", remoteEligibility: "worldwide", seniority: "staff-plus", minYearsExperience: 10, visaSignal: "unknown", baseScore: 70, domain: "fintech" },
    expect: { category: "none", queued: false, needsCheck: false },
  },
  {
    jd: "Backend Engineer. We build payroll APIs. 3+ years with Go.",
    model: { workMode: "unknown", officeRegion: "unknown", remoteEligibility: "unknown", seniority: "mid", minYearsExperience: 3, visaSignal: "unknown", baseScore: 75, domain: "fintech" },
    expect: { category: "none", queued: false, needsCheck: true },
  },
  {
    jd: "Senior Backend Engineer. Remote, worldwide. 5+ years.",
    model: { workMode: "fully-remote", officeRegion: "unknown", remoteEligibility: "worldwide", seniority: "senior", minYearsExperience: 5, visaSignal: "unknown", baseScore: 70, domain: "general-backend" },
    expect: { category: "none", queued: false },
  },
  {
    jd: "Backend Engineer. Remote (CET ±3h). 6+ years.",
    model: { workMode: "fully-remote", officeRegion: "unknown", remoteEligibility: "timezone-compatible", seniority: "mid", minYearsExperience: 6, visaSignal: "unknown", baseScore: 70, domain: "general-backend" },
    expect: { category: "none", queued: false },
  },
  {
    jd: "Remote-first, 2 days a month in the Amsterdam office. Junior engineer, sponsorship likely (IND recognised sponsor).",
    model: { workMode: "hybrid", officeRegion: "uk-europe", remoteEligibility: "unknown", seniority: "junior", minYearsExperience: 1, visaSignal: "likely", baseScore: 58, domain: "general-backend" },
    expect: { category: "early-career", queued: true },
  },
  {
    jd: "Fully remote engineer, 1+ years. (no region stated)",
    model: { workMode: "fully-remote", officeRegion: "unknown", remoteEligibility: "unknown", seniority: "junior", minYearsExperience: 1, visaSignal: "unknown", baseScore: 70, domain: "general-backend" },
    expect: { category: "none", queued: false, needsCheck: true },
  },
];

for (const f of FIXTURES) {
  test(`fixture: ${f.jd}`, () => {
    const c = classify(f.model, SETTINGS);
    const score = boostedScore(f.model.baseScore, f.model.domain, BOOSTS);
    assert.equal(c.category, f.expect.category);
    assert.equal(shouldQueue(score, THRESHOLD, c), f.expect.queued);
    if (f.expect.flagged !== undefined) assert.equal(c.flagged, f.expect.flagged);
    if (f.expect.needsCheck !== undefined) assert.equal(c.needsCheck, f.expect.needsCheck);
  });
}

test("fintech boost is applied to the fintech payments role", () => {
  assert.equal(boostedScore(60, "fintech", BOOSTS), 75);
});

test("devtools role scores below an equivalent fintech role", () => {
  assert.ok(boostedScore(60, "infra-devtools-data", BOOSTS) < boostedScore(60, "fintech", BOOSTS));
  assert.ok(boostedScore(60, "ai-tooling", BOOSTS) < boostedScore(60, "infra-devtools-data", BOOSTS));
  assert.equal(boostedScore(60, "general-backend", BOOSTS), 60);
});

test("non-engineering and mobile-only roles get no domain boost", () => {
  assert.equal(boostedScore(48, "ai-tooling", BOOSTS, "other"), 48); // e.g. "Director of Corp Dev" at an AI company
  assert.equal(boostedScore(50, "fintech", BOOSTS, "mobile"), 50);
  assert.equal(boostedScore(50, "fintech", BOOSTS, "backend"), 65);
});

test("boosted score is capped at 100 and tolerates a null domain", () => {
  assert.equal(boostedScore(95, "fintech", BOOSTS), 100);
  assert.equal(boostedScore(50, null, BOOSTS), 50);
});

test("below-threshold jobs never queue, even in a category", () => {
  const c = classify(FIXTURES[1].model, SETTINGS);
  assert.equal(c.category, "remote");
  assert.equal(shouldQueue(54, THRESHOLD, c), false);
  assert.equal(shouldQueue(null, THRESHOLD, c), false);
});

test("maxYearsRemote is the category A ceiling", () => {
  const f: TargetingFields = { workMode: "fully-remote", remoteEligibility: "worldwide", officeRegion: "unknown", seniority: "mid", minYearsExperience: 5, visaSignal: "unknown" };
  assert.equal(classify(f, SETTINGS).catA, false);
  assert.equal(classify(f, { ...SETTINGS, maxYearsRemote: 5 }).catA, true);
});

test("category toggles disable each category independently", () => {
  const both = FIXTURES[7].model; // remote new grad → both
  assert.equal(classify(both, { ...SETTINGS, enableCategoryA: false }).category, "early-career");
  assert.equal(classify(both, { ...SETTINGS, enableCategoryB: false }).category, "remote");
  const off = classify(both, { ...SETTINGS, enableCategoryA: false, enableCategoryB: false });
  assert.equal(off.category, "none");
  assert.equal(off.needsCheck, false);
});

test("legacy rows scored before targeting (all nulls) never queue and aren't flagged", () => {
  const c = classify({ workMode: null, remoteEligibility: null, officeRegion: null, seniority: null, minYearsExperience: null, visaSignal: "yes" }, SETTINGS);
  assert.equal(c.category, "none");
  assert.equal(c.flagged, false);
});

test("category B's sponsored onsite/hybrid route only counts UK/Europe offices", () => {
  const f: TargetingFields = { workMode: "onsite", remoteEligibility: "unknown", officeRegion: "uk-europe", seniority: "new-grad", minYearsExperience: null, visaSignal: "yes" };
  assert.equal(classify(f, SETTINGS).category, "early-career");
  assert.equal(classify({ ...f, officeRegion: "other" }, SETTINGS).category, "none"); // e.g. onsite NYC, sponsors
  const unknownRegion = classify({ ...f, officeRegion: "unknown" }, SETTINGS);
  assert.equal(unknownRegion.category, "none");
  assert.equal(unknownRegion.needsCheck, true);
});

test("onsite/hybrid roles are never Flagged, whatever remote eligibility the model reports", () => {
  const f: TargetingFields = { workMode: "hybrid", remoteEligibility: "country-restricted", officeRegion: "uk-europe", seniority: "new-grad", minYearsExperience: 0, visaSignal: "yes" };
  const c = classify(f, SETTINGS);
  assert.equal(c.flagged, false);
  assert.equal(c.category, "early-career");
});

test("early-career title keywords", () => {
  for (const t of ["New Grad Software Engineer", "Graduate Developer", "Entry-Level Backend Engineer", "Junior Go Engineer", "Early Career SWE", "Campus Hire - Engineering", "Associate Software Engineer"])
    assert.ok(EARLY_CAREER_TITLE_RE.test(t), t);
  for (const t of ["Senior Backend Engineer", "Staff Platform Engineer"]) assert.ok(!EARLY_CAREER_TITLE_RE.test(t), t);
});
