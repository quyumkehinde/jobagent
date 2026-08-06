import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import { generateJSON } from "./gemini";
import { buildCandidateSummary, getProfileValue } from "./candidate";
import { getSetting, DEFAULTS } from "./settings";
import { FormField, fetchFormForJob } from "./forms";
import { tailorResume } from "./tailor";
import { createLogger, startTimer } from "./log";

const log = createLogger("draft");

// sources whose applications we can actually POST programmatically (see submit.ts)
const API_SUBMIT_SOURCES = ["greenhouse", "lever"];

function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

// Deterministic mappings from common labels to profile keys — never AI-generated.
async function deterministicAnswer(label: string): Promise<string | null> {
  const l = label.toLowerCase();
  const links = (await getProfileValue<Record<string, string>>("links")) || {};
  const fullName = (await getProfileValue<string>("fullName")) || "";
  if (/^(full |legal )?name$/.test(l.trim())) return fullName || null;
  if (/first name/.test(l)) return fullName.split(" ")[0] || null;
  if (/last name|surname|family name/.test(l)) return fullName.split(" ").slice(1).join(" ") || null;
  if (/e-?mail/.test(l)) return getProfileValue<string>("email");
  if (/phone|mobile/.test(l)) return getProfileValue<string>("phone");
  if (/linkedin/.test(l)) return links.linkedin || null;
  if (/github/.test(l)) return links.github || null;
  if (/portfolio|website|personal site/.test(l)) return links.website || null;
  if (/current location|where.*(located|based)|^location$|city of residence/.test(l))
    return getProfileValue<string>("location");
  if (/notice period|availability|start date|when can you start/.test(l))
    return getProfileValue<string>("noticePeriod");
  return null;
}

async function qaBankAnswer(label: string): Promise<string | null> {
  const norm = normalizeQuestion(label);
  if (!norm) return null;
  const all = await db.query.qaBank.findMany();
  // exact normalized match, else containment either way
  const hit =
    all.find((q) => q.normalized === norm) ||
    all.find((q) => norm.includes(q.normalized) || q.normalized.includes(norm));
  if (hit) {
    await db
      .update(tables.qaBank)
      .set({ timesUsed: hit.timesUsed + 1 })
      .where(eq(tables.qaBank.id, hit.id));
    return hit.answer;
  }
  return null;
}

const ANSWER_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      fieldKey: { type: "string" },
      answer: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
    },
    required: ["fieldKey", "answer", "confidence"],
  },
};

// Style rules shared with the copilot: answers must read like the candidate typed them.
export const WRITING_STYLE = `How to write prose answers (open-ended questions, cover letters):
- Tell ONE specific, coherent story with a point: why this particular company or role fits this candidate's actual path. Do NOT stuff keywords from the job description into the text; weaving in one or two naturally is the maximum.
- Sound like a person typing, not an AI: plain direct sentences, varied length, contractions are fine. No bullet lists inside prose answers.
- Banned (they scream AI): em dashes and " - " asides, semicolons, "I am excited", "I am writing to express", "passionate", "leverage", "delve", "aligns with", "resonates", "I'd love to", chains of buzzwords, and grammatically perfect but hollow filler sentences.
- 80-160 words for open-ended questions unless the field clearly wants less.`;

const ANSWER_SYSTEM = `You write job application answers for a specific candidate.

Facts vs. story:
- Hard facts must come from the CANDIDATE PROFILE and never be invented: employers, titles, dates, technologies used, degrees, certifications, skills, visa/work-authorization status, notice period, salary.
- Motivation and narrative ("Why us?", "What excites you?", "Tell us about a time...") may be constructed — they don't have to be literally true, since the candidate reviews and edits every answer before anything is submitted. They MUST stay consistent with the profile and the job; never contradict a hard fact.

${WRITING_STYLE}

Form mechanics:
- For select/multiselect fields, the answer MUST be exactly one of (or a comma-separated subset of) the provided options.
- For demographic/EEO questions, prefer "Decline to self identify" / "I don't wish to answer"-style options when available.
- For yes/no work-authorization questions, use the profile's work authorization facts; if unclear for the country in question, set confidence "low".
- If a question asks for information you don't have at all, give your best safe attempt and set confidence "low" so a human reviews it.`;

export interface DraftResult {
  applicationId: number;
  aiCount: number;
  needsReview: number;
}

// Creates (or refreshes) an application draft for a job: fetch form, fill deterministic
// fields, reuse QA bank, generate the rest with Gemini, and write a cover letter.
export async function draftApplication(jobId: number): Promise<DraftResult> {
  const job = await db.query.jobs.findFirst({ where: eq(tables.jobs.id, jobId) });
  if (!job) throw new Error(`job ${jobId} not found`);
  const elapsed = startTimer();
  log.info("start", { jobId, title: job.title, company: job.companyName, source: job.source });

  let app = await db.query.applications.findFirst({ where: eq(tables.applications.jobId, jobId) });
  if (!app) {
    const [row] = await db
      .insert(tables.applications)
      .values({ jobId, status: "drafting", jdSnapshot: job.description })
      .returning();
    app = row;
    await db.insert(tables.events).values({ applicationId: app.id, type: "created", detail: "Application drafted" });
  }

  const { fields, introspected } = await fetchFormForJob(job);
  // introspected ≠ submittable: Ashby forms are fetched for real but submitted assisted
  const method = introspected && API_SUBMIT_SOURCES.includes(job.source) ? "api" : "assisted";
  log.info("form fetched", { fields: fields.length, introspected, method });
  await db
    .update(tables.applications)
    .set({ formSchema: JSON.stringify({ introspected, fields }), method })
    .where(eq(tables.applications.id, app.id));

  // reset existing answers on re-draft
  await db.delete(tables.applicationAnswers).where(eq(tables.applicationAnswers.applicationId, app.id));

  const pending: FormField[] = [];
  let deterministicCount = 0;
  let qaBankCount = 0;
  let sortOrder = 0;
  for (const f of fields) {
    if (f.fieldType === "file") {
      await db.insert(tables.applicationAnswers).values({
        applicationId: app.id,
        fieldKey: f.fieldKey,
        label: f.label,
        fieldType: f.fieldType,
        required: f.required,
        answer: "(default resume)",
        sortOrder: sortOrder++,
      });
      continue;
    }
    let det = await deterministicAnswer(f.label);
    if (det) deterministicCount++;
    else {
      det = await qaBankAnswer(f.label);
      if (det) qaBankCount++;
    }
    await db.insert(tables.applicationAnswers).values({
      applicationId: app.id,
      fieldKey: f.fieldKey,
      label: f.label,
      fieldType: f.fieldType,
      options: f.options ? JSON.stringify(f.options) : null,
      required: f.required,
      answer: det,
      aiGenerated: false,
      confidence: det ? "high" : null,
      sortOrder: sortOrder++,
    });
    if (!det) pending.push(f);
  }

  log.info("answers resolved", {
    deterministic: deterministicCount,
    qaBank: qaBankCount,
    needsAi: pending.length,
  });

  const candidate = await buildCandidateSummary();
  const model = await getSetting("writerModel", DEFAULTS.writerModel);
  let aiCount = 0;

  if (pending.length) {
    const fieldsText = pending
      .map(
        (f) =>
          `fieldKey: ${f.fieldKey}\nQuestion: ${f.label}\nType: ${f.fieldType}${f.options ? `\nOptions: ${f.options.join(" | ")}` : ""}${f.required ? "\n(required)" : ""}`
      )
      .join("\n---\n");
    const results = await generateJSON<{ fieldKey: string; answer: string; confidence: "high" | "medium" | "low" }[]>(
      `CANDIDATE PROFILE:\n${candidate}\n\nJOB: ${job.title} at ${job.companyName}\nJOB DESCRIPTION:\n${(job.description || "").slice(0, 6000)}\n\nAnswer each application form field below:\n\n${fieldsText}`,
      { model, system: ANSWER_SYSTEM, responseSchema: ANSWER_SCHEMA, temperature: 0.4 }
    );
    const rows = await db.query.applicationAnswers.findMany({
      where: eq(tables.applicationAnswers.applicationId, app.id),
    });
    for (const r of results) {
      const row = rows.find((x) => x.fieldKey === r.fieldKey && !x.answer);
      if (row) {
        await db
          .update(tables.applicationAnswers)
          .set({ answer: r.answer, aiGenerated: true, confidence: r.confidence })
          .where(eq(tables.applicationAnswers.id, row.id));
        aiCount++;
      }
    }
    log.info("ai answers filled", { requested: pending.length, filled: aiCount });
  }

  // Cover letter: generated whenever the form has a cover-letter-ish field or as assisted text
  const wantsCover = fields.some((f) => /cover|additional information|comments|why/i.test(f.label));
  if (wantsCover || !introspected) {
    const cover = await generateJSON<{ coverLetter: string }>(
      `CANDIDATE PROFILE:\n${candidate}\n\nJOB: ${job.title} at ${job.companyName}\nJOB DESCRIPTION:\n${(job.description || "").slice(0, 6000)}\n\nWrite a short cover letter (150-250 words) for this application. Return JSON {"coverLetter": "..."}.`,
      {
        model,
        system: ANSWER_SYSTEM,
        responseSchema: {
          type: "object",
          properties: { coverLetter: { type: "string" } },
          required: ["coverLetter"],
        },
        temperature: 0.5,
      }
    );
    await db
      .update(tables.applications)
      .set({ coverLetter: cover.coverLetter })
      .where(eq(tables.applications.id, app.id));
  }

  // Per-job resume tailoring — best-effort: any failure keeps the default resume
  try {
    const tailored = await tailorResume(app.id);
    if (!tailored.applied && tailored.reason !== "no base LaTeX resume in Profile")
      log.warn("resume tailoring skipped", { reason: tailored.reason });
  } catch (err) {
    log.warn("resume tailoring failed", { error: String(err).slice(0, 200) });
  }

  const answers = await db.query.applicationAnswers.findMany({
    where: eq(tables.applicationAnswers.applicationId, app.id),
  });
  const needsReview = answers.filter((a) => !a.answer || a.confidence === "low").length;

  await db
    .update(tables.applications)
    .set({ status: "ready", updatedAt: new Date() })
    .where(eq(tables.applications.id, app.id));
  await db.update(tables.jobs).set({ feedStatus: "applied" }).where(eq(tables.jobs.id, jobId));

  log.info("done", { applicationId: app.id, aiCount, needsReview, coverLetter: wantsCover || !introspected, ms: elapsed() });
  return { applicationId: app.id, aiCount, needsReview };
}

// Save a user-edited answer back AND remember it in the QA bank for future applications.
export async function rememberAnswer(label: string, answer: string): Promise<void> {
  const normalized = normalizeQuestion(label);
  if (!normalized || !answer.trim()) return;
  await db
    .insert(tables.qaBank)
    .values({ question: label, normalized, answer })
    .onConflictDoUpdate({
      target: tables.qaBank.normalized,
      set: { answer, updatedAt: new Date() },
    });
}
