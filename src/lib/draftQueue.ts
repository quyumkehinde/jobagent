import { draftApplication } from "./answers";
import { createLogger } from "./log";

// In-process background draft queue: enqueue N jobs, they draft strictly one at a time
// (free-tier Gemini calls are globally spaced anyway, so parallel drafting buys nothing)
// while the UI polls per-job status instead of click-waiting. In-memory by design — a
// dev-server restart or HMR reload drops pending entries, which only means re-clicking.

export interface DraftQueueItem {
  jobId: number;
  status: "pending" | "drafting" | "done" | "failed";
  applicationId?: number;
  error?: string;
  queuedAt: number;
  finishedAt?: number;
}

const log = createLogger("draft-queue");
const items: DraftQueueItem[] = [];
let running = false;

export function getDraftQueue(): DraftQueueItem[] {
  // prune finished entries after an hour so the list can't grow unbounded
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if ((it.status === "done" || it.status === "failed") && (it.finishedAt ?? 0) < cutoff)
      items.splice(i, 1);
  }
  return items;
}

export function enqueueDraft(jobId: number): DraftQueueItem {
  const active = items.find(
    (i) => i.jobId === jobId && (i.status === "pending" || i.status === "drafting")
  );
  if (active) return active; // double-click safe

  // re-queue after done/failed: replace the stale entry so status reads fresh
  const stale = items.findIndex((i) => i.jobId === jobId);
  if (stale >= 0) items.splice(stale, 1);

  const item: DraftQueueItem = { jobId, status: "pending", queuedAt: Date.now() };
  items.push(item);
  log.info("enqueued", { jobId, depth: items.filter((i) => i.status === "pending").length });
  void run();
  return item;
}

async function run() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = items.find((i) => i.status === "pending");
      if (!next) break;
      next.status = "drafting";
      try {
        const r = await draftApplication(next.jobId);
        next.status = "done";
        next.applicationId = r.applicationId;
      } catch (err) {
        next.status = "failed";
        next.error = String(err).slice(0, 300);
        log.error("draft failed", { jobId: next.jobId, error: next.error });
      }
      next.finishedAt = Date.now();
    }
  } finally {
    running = false;
  }
}
