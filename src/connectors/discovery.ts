import { db, tables } from "@/db";
import { RawJob } from "./types";
import { CONNECTORS, AtsName } from "./registry";

// Finds ATS board links inside aggregator job posts and registers those companies
// so their full boards get polled on future runs. Patterns come from the connector
// registry, so a new ATS connector automatically becomes discoverable.
const IGNORE_TOKENS = new Set(["embed", "jobs", "api", "careers", "apply", "www", "app", "docs"]);

export function scanForBoards(haystack: string): { ats: AtsName; token: string }[] {
  const out: { ats: AtsName; token: string }[] = [];
  for (const conn of Object.values(CONNECTORS)) {
    for (const re of conn.discoveryPatterns) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(haystack))) {
        const token = decodeURIComponent(m[1]).trim();
        if (!token || IGNORE_TOKENS.has(token.toLowerCase()) || token.length > 60) continue;
        out.push({ ats: conn.ats, token });
      }
    }
  }
  return out;
}

export async function discoverBoards(rawJobs: RawJob[]): Promise<number> {
  const found = new Map<string, { ats: AtsName; token: string; name: string }>();
  for (const job of rawJobs) {
    const haystack = `${job.url} ${job.applyUrl || ""} ${job.description || ""}`;
    for (const { ats, token } of scanForBoards(haystack)) {
      found.set(`${ats}:${token.toLowerCase()}`, { ats, token, name: job.companyName || token });
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
