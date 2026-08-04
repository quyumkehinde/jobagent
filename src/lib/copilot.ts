import { db, tables } from "@/db";
import { eq, and } from "drizzle-orm";
import { generateJSON } from "./gemini";
import { buildCandidateSummary, getProfileValue } from "./candidate";
import { getSetting, DEFAULTS } from "./settings";
import { saveTailoredResume } from "./tailor";
import { LatexCompileError } from "./latex";
import { createLogger, startTimer } from "./log";

const log = createLogger("copilot");

export interface CopilotTurn {
  role: "user" | "assistant";
  text: string;
}

export interface CopilotResult {
  reply: string;
  updated: { coverLetter: boolean; resume: boolean; answers: number };
}

const SYSTEM = `You are the review copilot for one job application. The user gives quick edit instructions like "add Kafka to the resume skills", "remove the certifications line from the resume", "make the cover letter mention the migration project", "set the notice period answer to 2 weeks".
Rules:
- Make ONLY the edits the user asked for; omit every field you were not asked to change.
- resumeLatex: return the COMPLETE edited LaTeX document. Keep the documentclass, packages, layout and margins identical — it must still fit one page. Never add skills, employers, or claims the candidate profile doesn't support; if the user asks you to fabricate, refuse in the reply and make no edit.
- coverLetter: return the complete new text (plain text, no LaTeX).
- answerEdits: reference form fields by their exact fieldKey from the provided list.
- reply: 1-2 sentences confirming exactly what you changed, or asking for clarification if the request is ambiguous. Never claim an edit you did not return.`;

const SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    coverLetter: { type: "string", description: "full replacement cover letter — ONLY if asked" },
    resumeLatex: { type: "string", description: "full edited LaTeX document — ONLY if asked" },
    answerEdits: {
      type: "array",
      items: {
        type: "object",
        properties: { fieldKey: { type: "string" }, answer: { type: "string" } },
        required: ["fieldKey", "answer"],
      },
    },
  },
  required: ["reply"],
};

interface CopilotEdits {
  reply: string;
  coverLetter?: string;
  resumeLatex?: string;
  answerEdits?: { fieldKey: string; answer: string }[];
}

// One copilot exchange: interpret the instruction, apply the returned edits, log an event.
// Resume edits go through the same compile + one-page gauntlet as tailoring, with one
// feedback retry; a failing resume edit is reported in the reply, never silently saved.
export async function runCopilot(
  applicationId: number,
  message: string,
  history: CopilotTurn[] = []
): Promise<CopilotResult> {
  const app = await db.query.applications.findFirst({ where: eq(tables.applications.id, applicationId) });
  if (!app) throw new Error("application not found");
  const job = await db.query.jobs.findFirst({ where: eq(tables.jobs.id, app.jobId) });
  if (!job) throw new Error("job not found");
  const answers = await db.query.applicationAnswers.findMany({
    where: eq(tables.applicationAnswers.applicationId, applicationId),
  });

  const resumeLatex = app.tailoredResumeLatex || (await getProfileValue<string>("resumeLatex")) || "";
  const candidate = await buildCandidateSummary();
  const model = await getSetting("writerModel", DEFAULTS.writerModel);
  const elapsed = startTimer();

  const context = [
    `CANDIDATE PROFILE:\n${candidate}`,
    `JOB: ${job.title} at ${job.companyName}`,
    `JOB DESCRIPTION (excerpt):\n${(app.jdSnapshot || job.description || "").slice(0, 4000)}`,
    `CURRENT COVER LETTER:\n${app.coverLetter || "(none)"}`,
    `CURRENT RESUME (LaTeX):\n${resumeLatex || "(none — resume edits are not possible, say so if asked)"}`,
    `FORM ANSWERS (fieldKey → label → current answer):\n${answers
      .map((a) => `${a.fieldKey} → ${a.label} → ${(a.answer || "(empty)").slice(0, 200)}`)
      .join("\n")}`,
    history.length
      ? `RECENT CONVERSATION:\n${history.slice(-6).map((t) => `${t.role}: ${t.text}`).join("\n")}`
      : "",
    `USER INSTRUCTION:\n${message}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const edits = await generateJSON<CopilotEdits>(context, {
    model,
    system: SYSTEM,
    responseSchema: SCHEMA,
    temperature: 0.3,
  });

  const updated = { coverLetter: false, resume: false, answers: 0 };
  let reply = edits.reply;

  if (edits.coverLetter?.trim()) {
    await db
      .update(tables.applications)
      .set({ coverLetter: edits.coverLetter.trim(), updatedAt: new Date() })
      .where(eq(tables.applications.id, applicationId));
    updated.coverLetter = true;
  }

  if (edits.resumeLatex?.trim()) {
    let latex = edits.resumeLatex;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await saveTailoredResume(applicationId, latex);
        updated.resume = true;
        break;
      } catch (err) {
        const problem =
          err instanceof LatexCompileError
            ? `the LaTeX failed to compile:\n${err.compileLog.slice(-600)}`
            : String(err instanceof Error ? err.message : err);
        if (attempt === 2) {
          reply += ` (Resume edit NOT saved — ${problem.split("\n")[0]}.)`;
          break;
        }
        const retry = await generateJSON<{ latex: string }>(
          `${context}\n\nYOUR PREVIOUS EDIT WAS REJECTED because ${problem}\nOutput the corrected COMPLETE LaTeX document (same layout, one page).`,
          {
            model,
            system: SYSTEM,
            responseSchema: {
              type: "object",
              properties: { latex: { type: "string" } },
              required: ["latex"],
            },
            temperature: 0.2,
          }
        );
        latex = retry.latex;
      }
    }
  }

  for (const e of edits.answerEdits || []) {
    const row = answers.find((a) => a.fieldKey === e.fieldKey);
    if (!row) continue;
    await db
      .update(tables.applicationAnswers)
      .set({ answer: e.answer, confidence: "high", aiGenerated: true })
      .where(and(eq(tables.applicationAnswers.id, row.id), eq(tables.applicationAnswers.applicationId, applicationId)));
    updated.answers++;
  }

  const summary = [
    updated.coverLetter && "cover letter",
    updated.resume && "resume",
    updated.answers && `${updated.answers} answer(s)`,
  ]
    .filter(Boolean)
    .join(", ");
  await db.insert(tables.events).values({
    applicationId,
    type: "copilot",
    detail: `"${message.slice(0, 150)}" → ${summary ? `updated ${summary}` : "no changes"}`,
  });

  log.info("exchange done", { applicationId, ...updated, ms: elapsed() });
  return { reply, updated };
}
