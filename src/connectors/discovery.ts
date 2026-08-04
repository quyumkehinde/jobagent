import { db, tables } from "@/db";
import { RawJob } from "./types";

// Finds ATS board links inside aggregator job posts and registers those companies
// so their full boards get polled on future runs.
const PATTERNS: { ats: "greenhouse" | "lever" | "ashby"; re: RegExp }[] = [
  { ats: "greenhouse", re: /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9_-]+)/gi },
  { ats: "greenhouse", re: /greenhouse\.io\/embed\/job_board\?for=([a-z0-9_-]+)/gi },
  { ats: "lever", re: /jobs\.lever\.co\/([a-z0-9_-]+)/gi },
  { ats: "ashby", re: /jobs\.ashbyhq\.com\/([a-zA-Z0-9_ %-]+)/gi },
];

const IGNORE_TOKENS = new Set(["embed", "jobs", "api", "careers", "apply"]);

export async function discoverBoards(rawJobs: RawJob[]): Promise<number> {
  const found = new Map<string, { ats: "greenhouse" | "lever" | "ashby"; token: string; name: string }>();
  for (const job of rawJobs) {
    const haystack = `${job.url} ${job.applyUrl || ""} ${job.description || ""}`;
    for (const { ats, re } of PATTERNS) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(haystack))) {
        const token = decodeURIComponent(m[1]).trim();
        if (!token || IGNORE_TOKENS.has(token.toLowerCase()) || token.length > 60) continue;
        found.set(`${ats}:${token.toLowerCase()}`, { ats, token, name: job.companyName || token });
      }
    }
  }
  let added = 0;
  for (const { ats, token, name } of found.values()) {
    const res = await db
      .insert(tables.companies)
      .values({ name, ats, token, origin: "discovery" })
      .onConflictDoNothing();
    if (res.changes > 0) added++;
  }
  return added;
}
