import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import { generateJSON } from "./gemini";
import { getSetting, DEFAULTS } from "./settings";
import { getProfileValue } from "./candidate";
import { compileResumeLatex, LatexCompileError } from "./latex";
import { createLogger, startTimer } from "./log";

const log = createLogger("tailor");

// How much of the document the AI may touch. Tailoring is emphasis, not rewriting:
// if more than this fraction of lines changed, we reject the edit as overreach.
const MAX_CHANGED_LINE_RATIO = 0.3;

const TAILOR_SYSTEM = `You edit a candidate's LaTeX resume to better match one specific job description. You are a CONSERVATIVE editor:
- The skills section is your main target: reorder it and surface the skills/technologies the job asks for — but ONLY skills the candidate demonstrably has (they appear in the resume or the candidate profile). NEVER add a skill, tool, employer, metric, or claim that is not already evidenced.
- Outside the skills section you may only make small emphasis edits: reordering bullets within a job, or minor wording tightening. Do not rewrite prose. Do not add new bullets.
- Keep the SAME documentclass, packages, layout commands, fonts, and margins. Do not restructure the document.
- The resume MUST still fit on ONE page. If asked to trim, cut the least job-relevant bullet or skill, never the layout.
- Output the COMPLETE compilable LaTeX document.`;

const TAILOR_SCHEMA = {
  type: "object",
  properties: {
    latex: { type: "string", description: "the complete edited LaTeX document" },
    changes: {
      type: "array",
      items: { type: "string" },
      maxItems: 6,
      description: "short human-readable list of what was changed and why",
    },
  },
  required: ["latex", "changes"],
};

function changedLineRatio(base: string, edited: string): number {
  const baseLines = new Set(base.split("\n").map((l) => l.trim()).filter(Boolean));
  const editedLines = edited.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!editedLines.length) return 1;
  const changed = editedLines.filter((l) => !baseLines.has(l)).length;
  return changed / editedLines.length;
}

// Compiles + saves a (possibly hand- or copilot-edited) tailored resume for an application.
// Enforces the one-page constraint; throws LatexCompileError / Error("not one page") otherwise.
export async function saveTailoredResume(
  applicationId: number,
  latex: string
): Promise<{ fileName: string; pages: number }> {
  const { fileName, pages } = await compileResumeLatex(latex, `app-${applicationId}`);
  if (pages !== 1) throw new Error(`tailored resume is ${pages} pages — must be exactly 1`);
  await db
    .update(tables.applications)
    .set({ tailoredResumeLatex: latex, tailoredResumePdf: fileName, updatedAt: new Date() })
    .where(eq(tables.applications.id, applicationId));
  return { fileName, pages };
}

export interface TailorResult {
  applied: boolean;
  changes: string[];
  reason?: string; // when applied=false
}

// AI-tailors the base resume (profile key "resumeLatex") for an application's job.
// Validation gauntlet: bounded diff → compiles → exactly one page, with feedback retries.
// Failure is soft: the application simply keeps using the default resume.
export async function tailorResume(applicationId: number): Promise<TailorResult> {
  const baseLatex = await getProfileValue<string>("resumeLatex");
  if (!baseLatex?.trim()) return { applied: false, changes: [], reason: "no base LaTeX resume in Profile" };

  const app = await db.query.applications.findFirst({ where: eq(tables.applications.id, applicationId) });
  if (!app) throw new Error(`application ${applicationId} not found`);
  const job = await db.query.jobs.findFirst({ where: eq(tables.jobs.id, app.jobId) });
  if (!job) throw new Error(`job ${app.jobId} not found`);

  const jd = (app.jdSnapshot || job.description || "").slice(0, 6000);
  const skills = (await getProfileValue<string[]>("skills")) || [];
  const model = await getSetting("writerModel", DEFAULTS.writerModel);
  const elapsed = startTimer();

  let feedback = "";
  let lastReason = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await generateJSON<{ latex: string; changes: string[] }>(
      `JOB: ${job.title} at ${job.companyName}\n\nJOB DESCRIPTION:\n${jd}\n\nCANDIDATE'S FULL SKILL LIST (the only skills you may surface):\n${skills.join(", ") || "(see resume)"}\n\nBASE RESUME (LaTeX):\n${baseLatex}${feedback ? `\n\nPREVIOUS ATTEMPT WAS REJECTED: ${feedback}\nFix that and output the corrected full document.` : ""}`,
      { model, system: TAILOR_SYSTEM, responseSchema: TAILOR_SCHEMA, temperature: 0.2 }
    );

    const ratio = changedLineRatio(baseLatex, result.latex);
    if (ratio > MAX_CHANGED_LINE_RATIO) {
      lastReason = `edit too large (${Math.round(ratio * 100)}% of lines changed)`;
      feedback = `You changed ${Math.round(ratio * 100)}% of the document's lines — far too much. Keep the document nearly identical to the base; only adjust the skills section and minor bullet order.`;
      log.warn("attempt rejected", { applicationId, attempt, reason: lastReason });
      continue;
    }

    try {
      await saveTailoredResume(applicationId, result.latex);
    } catch (err) {
      if (err instanceof LatexCompileError) {
        lastReason = "LaTeX did not compile";
        feedback = `The LaTeX failed to compile. Compiler log tail:\n${err.compileLog.slice(-800)}`;
      } else {
        lastReason = String(err instanceof Error ? err.message : err);
        feedback = `${lastReason}. Trim the least job-relevant content until it fits one page; never change the layout/margins.`;
      }
      log.warn("attempt rejected", { applicationId, attempt, reason: lastReason });
      continue;
    }

    await db.insert(tables.events).values({
      applicationId,
      type: "note",
      detail: `Tailored resume generated (1 page). ${result.changes.join("; ").slice(0, 400)}`,
    });
    log.info("tailored", { applicationId, attempt, changes: result.changes.length, ms: elapsed() });
    return { applied: true, changes: result.changes };
  }

  log.warn("giving up, keeping default resume", { applicationId, reason: lastReason, ms: elapsed() });
  return { applied: false, changes: [], reason: lastReason };
}
