import { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-zinc-800 bg-zinc-900 p-4 ${className}`}>{children}</div>;
}

export function Badge({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "green" | "yellow" | "red" | "blue" | "purple";
}) {
  const tones: Record<string, string> = {
    default: "bg-zinc-800 text-zinc-300",
    green: "bg-emerald-900/60 text-emerald-300",
    yellow: "bg-amber-900/60 text-amber-300",
    red: "bg-red-900/60 text-red-300",
    blue: "bg-sky-900/60 text-sky-300",
    purple: "bg-violet-900/60 text-violet-300",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function ScoreBadge({ score }: { score: number | null }) {
  if (score == null) return <Badge>unscored</Badge>;
  const tone = score >= 75 ? "green" : score >= 55 ? "yellow" : "red";
  return <Badge tone={tone}>{Math.round(score)}</Badge>;
}

export function eligibilityBadge(e: string | null) {
  switch (e) {
    case "remote-worldwide":
      return <Badge tone="green">remote · worldwide</Badge>;
    case "remote-region-restricted":
      return <Badge tone="blue">remote · region</Badge>;
    case "country-restricted":
      return <Badge tone="red">country-restricted</Badge>;
    case "onsite-europe":
      return <Badge tone="purple">on-site · Europe</Badge>;
    case "onsite-other":
      return <Badge tone="default">on-site · other</Badge>;
    default:
      return <Badge>eligibility?</Badge>;
  }
}

// Which target category queued this job: A = fully remote, B = early career.
export function categoryBadge(c: string | null) {
  switch (c) {
    case "remote":
      return <Badge tone="green">A · remote</Badge>;
    case "early-career":
      return <Badge tone="purple">B · early career</Badge>;
    case "both":
      return <Badge tone="green">A+B</Badge>;
    default:
      return null;
  }
}

const REMOTE_ELIGIBILITY_LABEL: Record<string, string> = {
  worldwide: "worldwide",
  "includes-nigeria": "incl. Nigeria",
  africa: "Africa",
  "emea-incl-africa": "EMEA",
  "timezone-compatible": "timezone ok",
  "country-restricted": "country-restricted",
  "region-excludes-nigeria": "region excl. Nigeria",
};

// Work mode + where it can hire from; falls back to the legacy eligibility badge for
// jobs scored before targeting.
export function workModeBadge(j: {
  workMode: string | null;
  remoteEligibility: string | null;
  officeRegion: string | null;
  eligibility: string | null;
}) {
  if (!j.workMode) return eligibilityBadge(j.eligibility);
  if (j.workMode === "fully-remote") {
    const label = j.remoteEligibility ? REMOTE_ELIGIBILITY_LABEL[j.remoteEligibility] : undefined;
    const bad = j.remoteEligibility === "country-restricted" || j.remoteEligibility === "region-excludes-nigeria";
    return <Badge tone={bad ? "red" : label ? "green" : "yellow"}>remote · {label ?? "eligibility?"}</Badge>;
  }
  if (j.workMode === "hybrid" || j.workMode === "onsite") {
    const where = j.officeRegion === "uk-europe" ? "UK/Europe" : j.officeRegion === "other" ? "other" : "?";
    return <Badge tone={j.officeRegion === "uk-europe" ? "blue" : "default"}>{j.workMode} · {where}</Badge>;
  }
  return <Badge tone="yellow">work mode?</Badge>;
}

export const btn =
  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
export const btnPrimary = `${btn} bg-emerald-600 hover:bg-emerald-500 text-white`;
export const btnSecondary = `${btn} bg-zinc-800 hover:bg-zinc-700 text-zinc-200`;
export const btnDanger = `${btn} bg-red-900/70 hover:bg-red-800 text-red-100`;
export const input =
  "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm text-zinc-100 focus:border-emerald-500 focus:outline-none";
