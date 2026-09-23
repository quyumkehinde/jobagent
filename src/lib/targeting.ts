// The two-category queueing rule. Pure on purpose: the model only classifies (work mode,
// eligibility, seniority, experience, domain); every decision about what queues lives
// here, in code, where it is unit-tested (targeting.test.ts) and tunable from Settings.
//
//   A · remote        fully remote, hireable from Nigeria, mid-level or below
//   B · early career  new grad / junior / ≤2 yrs, AND (A's remote bar OR onsite/hybrid in the
//                     UK/Europe with visa yes|likely)

export type WorkMode = "fully-remote" | "hybrid" | "onsite" | "unknown";
export type RemoteEligibility =
  | "worldwide"
  | "includes-nigeria"
  | "africa"
  | "emea-incl-africa"
  | "timezone-compatible"
  | "country-restricted"
  | "region-excludes-nigeria"
  | "unknown";
export type OfficeRegion = "uk-europe" | "other" | "unknown";
export type Seniority = "new-grad" | "junior" | "mid" | "senior" | "staff-plus" | "unknown";
export type VisaSignal = "yes" | "likely" | "no" | "unknown";
export type Domain = "fintech" | "infra-devtools-data" | "ai-tooling" | "general-backend" | "other";
export type TargetCategory = "remote" | "early-career" | "both" | "none";

export const HIREABLE: readonly RemoteEligibility[] = [
  "worldwide",
  "includes-nigeria",
  "africa",
  "emea-incl-africa",
  "timezone-compatible",
];
export const FLAGGED: readonly RemoteEligibility[] = ["country-restricted", "region-excludes-nigeria"];

export interface TargetingFields {
  workMode: WorkMode | null;
  remoteEligibility: RemoteEligibility | null;
  officeRegion: OfficeRegion | null; // where an onsite/hybrid role's office is
  seniority: Seniority | null;
  minYearsExperience: number | null;
  visaSignal: VisaSignal | null;
}

export interface TargetingSettings {
  maxYearsRemote: number;
  enableCategoryA: boolean;
  enableCategoryB: boolean;
}

export type DomainBoosts = Record<Domain, number>;

export interface Classification {
  catA: boolean;
  catB: boolean;
  category: TargetCategory;
  // ambiguous work mode / eligibility on a job that would otherwise qualify → Needs check
  needsCheck: boolean;
  // explicitly not hireable from Nigeria → Flagged
  flagged: boolean;
}

export function isEarlyCareer(f: Pick<TargetingFields, "seniority" | "minYearsExperience">): boolean {
  return (
    f.seniority === "new-grad" ||
    f.seniority === "junior" ||
    (f.minYearsExperience != null && f.minYearsExperience <= 2)
  );
}

// "mid-level or below", within the experience ceiling (unstated years don't disqualify)
function seniorityFitsRemote(f: TargetingFields, s: TargetingSettings): boolean {
  return (
    f.seniority !== "senior" &&
    f.seniority !== "staff-plus" &&
    (f.minYearsExperience == null || f.minYearsExperience <= s.maxYearsRemote)
  );
}

export function classify(f: TargetingFields, s: TargetingSettings): Classification {
  const hireable = f.remoteEligibility != null && HIREABLE.includes(f.remoteEligibility);
  const remoteOk = f.workMode === "fully-remote" && hireable;
  const early = isEarlyCareer(f);
  const visaOk = f.visaSignal === "yes" || f.visaSignal === "likely";
  // relocating on a sponsored visa only counts for UK/Europe offices
  const onsiteOk = (f.workMode === "onsite" || f.workMode === "hybrid") && f.officeRegion === "uk-europe" && visaOk;

  const catA = s.enableCategoryA && remoteOk && seniorityFitsRemote(f, s);
  const catB = s.enableCategoryB && early && (remoteOk || onsiteOk);
  const category: TargetCategory = catA && catB ? "both" : catA ? "remote" : catB ? "early-career" : "none";

  const flagged = f.remoteEligibility != null && FLAGGED.includes(f.remoteEligibility);
  // Unknown no longer queues — but a job that WOULD qualify if the unknown resolved the
  // right way must not vanish silently. Onsite/hybrid jobs don't need remote eligibility,
  // so an unknown there is not ambiguous — only an unknown office region is.
  const ambiguous =
    f.workMode == null ||
    f.workMode === "unknown" ||
    (f.workMode === "fully-remote" && (f.remoteEligibility == null || f.remoteEligibility === "unknown")) ||
    // sponsored onsite/hybrid whose office location isn't stated
    ((f.workMode === "onsite" || f.workMode === "hybrid") && visaOk && (f.officeRegion == null || f.officeRegion === "unknown"));
  const couldQualify = (s.enableCategoryA && seniorityFitsRemote(f, s)) || (s.enableCategoryB && early);
  const needsCheck = category === "none" && !flagged && ambiguous && couldQualify;

  return { catA, catB, category, needsCheck, flagged };
}

export function shouldQueue(score: number | null, threshold: number, c: Classification): boolean {
  return score != null && score >= threshold && c.category !== "none";
}

export function boostedScore(baseScore: number, domain: Domain | null, boosts: DomainBoosts): number {
  const boost = domain ? (boosts[domain] ?? 0) : 0;
  return Math.max(0, Math.min(100, Math.round(baseScore + boost)));
}

// Early-career title keywords: these jobs are scored first so a backlog can't bury them.
export const EARLY_CAREER_TITLE_RE =
  /\b(new[- ]?grad(uate)?|graduate|entry[- ]level|entry|junior|jr\.?|early[- ]career|campus|associate)\b/i;
