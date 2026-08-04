import { db, tables } from "@/db";
import { and, eq } from "drizzle-orm";
import { RawJob } from "@/connectors/types";

export interface IngestResult {
  found: number;
  added: number;
  addedIds: number[];
}

// Upserts scraped jobs; returns ids of newly-inserted jobs (candidates for scoring).
export async function ingestJobs(rawJobs: RawJob[]): Promise<IngestResult> {
  const addedIds: number[] = [];
  for (const j of rawJobs) {
    const existing = await db.query.jobs.findFirst({
      where: and(eq(tables.jobs.source, j.source), eq(tables.jobs.externalId, j.externalId)),
      columns: { id: true },
    });
    if (existing) {
      await db
        .update(tables.jobs)
        .set({ lastSeenAt: new Date(), closed: false })
        .where(eq(tables.jobs.id, existing.id));
      continue;
    }
    const [row] = await db
      .insert(tables.jobs)
      .values({
        companyId: j.companyId,
        source: j.source,
        externalId: j.externalId,
        url: j.url,
        applyUrl: j.applyUrl,
        title: j.title.slice(0, 200),
        companyName: j.companyName.slice(0, 120),
        location: j.location?.slice(0, 300),
        salary: j.salary,
        description: j.description?.slice(0, 20000),
        postedAt: j.postedAt,
        raw: j.raw ? JSON.stringify(j.raw) : null,
      })
      .returning({ id: tables.jobs.id });
    addedIds.push(row.id);
  }
  return { found: rawJobs.length, added: addedIds.length, addedIds };
}
