import fs from "node:fs";
import path from "node:path";
import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import { UA } from "@/connectors/types";
import { createLogger } from "./log";

const log = createLogger("submit");

// Programmatic submission is best-effort: ATSs increasingly gate public forms with
// captchas. We attempt the classic form POST and STRICTLY verify success; anything
// ambiguous throws, and the caller falls back to assisted (manual) mode with all
// answers ready to paste. We never mark "submitted" unless the ATS confirmed it.

export class SubmitNotPossibleError extends Error {}

// The tailored per-job PDF wins when it exists; otherwise the default uploaded resume.
async function getResumeForApplication(applicationId: number): Promise<{ path: string; name: string } | null> {
  const app = await db.query.applications.findFirst({ where: eq(tables.applications.id, applicationId) });
  if (app?.tailoredResumePdf) {
    const p = path.join(process.cwd(), "data", "resumes", "tailored", app.tailoredResumePdf);
    if (fs.existsSync(p)) return { path: p, name: app.tailoredResumePdf };
  }
  const resume = await db.query.resumes.findFirst({ where: eq(tables.resumes.isDefault, true) });
  if (!resume) return null;
  const p = path.join(process.cwd(), "data", "resumes", resume.fileName);
  return fs.existsSync(p) ? { path: p, name: resume.fileName } : null;
}

interface AnswerRow {
  fieldKey: string;
  fieldType: string;
  answer: string | null;
}

function buildLeverForm(answers: AnswerRow[], resume: { path: string; name: string } | null): FormData {
  const fd = new FormData();
  for (const a of answers) {
    if (a.fieldType === "file") continue;
    if (a.answer) fd.append(a.fieldKey, a.answer);
  }
  if (resume) {
    const buf = fs.readFileSync(resume.path);
    fd.append("resume", new Blob([buf], { type: "application/pdf" }), resume.name);
  }
  return fd;
}

export async function submitLever(
  applicationId: number,
  jobUrl: string,
  answers: AnswerRow[]
): Promise<void> {
  // hostedUrl form: https://jobs.lever.co/{company}/{posting-id}
  const m = /jobs\.(?:eu\.)?lever\.co\/([^/]+)\/([a-f0-9-]+)/i.exec(jobUrl);
  if (!m) throw new SubmitNotPossibleError("not a recognizable Lever posting URL");
  const applyUrl = `https://jobs.lever.co/${m[1]}/${m[2]}/apply`;

  const resume = await getResumeForApplication(applicationId);
  const fd = buildLeverForm(answers, resume);

  const res = await fetch(applyUrl, {
    method: "POST",
    headers: { "User-Agent": UA, Referer: `${jobUrl}/apply`, Origin: "https://jobs.lever.co" },
    body: fd,
    redirect: "follow",
  });
  const text = await res.text();
  const ok =
    res.ok &&
    (/thanks/i.test(res.url) || /application (?:has been )?(?:received|submitted)/i.test(text));
  if (!ok) {
    throw new SubmitNotPossibleError(
      /captcha/i.test(text) ? "Lever board requires captcha" : `Lever submit unconfirmed (HTTP ${res.status})`
    );
  }
  await db.insert(tables.events).values({
    applicationId,
    type: "submitted",
    detail: `Submitted programmatically to Lever (${applyUrl})`,
  });
}

export async function submitGreenhouse(
  applicationId: number,
  jobUrl: string,
  answers: AnswerRow[]
): Promise<void> {
  // classic boards form: https://boards.greenhouse.io/{token}/jobs/{id}
  const m = /boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/i.exec(jobUrl);
  if (!m) throw new SubmitNotPossibleError("not a classic Greenhouse board URL (new job-boards UI requires captcha)");

  // 1) fetch the form page for CSRF token + cookies
  const pageRes = await fetch(jobUrl, { headers: { "User-Agent": UA } });
  const html = await pageRes.text();
  const tokenMatch = /name="authenticity_token"\s+value="([^"]+)"/.exec(html);
  if (!tokenMatch) throw new SubmitNotPossibleError("no authenticity_token found (likely captcha-gated board)");
  if (/recaptcha|hcaptcha/i.test(html)) throw new SubmitNotPossibleError("Greenhouse board requires captcha");
  const cookies = pageRes.headers.getSetCookie?.().map((c) => c.split(";")[0]).join("; ") || "";

  // 2) POST the application
  const fd = new FormData();
  fd.append("authenticity_token", tokenMatch[1]);
  for (const a of answers) {
    if (a.fieldType === "file" || !a.answer) continue;
    // boards-api field names are the raw input names on the classic form
    const key = a.fieldKey.startsWith("job_application") ? a.fieldKey : a.fieldKey;
    fd.append(key, a.answer);
  }
  const resume = await getResumeForApplication(applicationId);
  if (resume) {
    const buf = fs.readFileSync(resume.path);
    fd.append("resume", new Blob([buf], { type: "application/pdf" }), resume.name);
  }

  const res = await fetch(jobUrl, {
    method: "POST",
    headers: { "User-Agent": UA, Cookie: cookies, Referer: jobUrl, Origin: "https://boards.greenhouse.io" },
    body: fd,
    redirect: "follow",
  });
  const text = await res.text();
  const ok = res.ok && /thank(s| you)|application (?:was |has been )?(?:received|submitted)/i.test(text);
  if (!ok) throw new SubmitNotPossibleError(`Greenhouse submit unconfirmed (HTTP ${res.status})`);

  await db.insert(tables.events).values({
    applicationId,
    type: "submitted",
    detail: `Submitted programmatically to Greenhouse (${jobUrl})`,
  });
}

// Attempts programmatic submission; returns "api" on success. Throws
// SubmitNotPossibleError when the user should finish it manually (assisted).
export async function trySubmit(applicationId: number): Promise<"api"> {
  const app = await db.query.applications.findFirst({ where: eq(tables.applications.id, applicationId) });
  if (!app) throw new Error("application not found");
  const job = await db.query.jobs.findFirst({ where: eq(tables.jobs.id, app.jobId) });
  if (!job) throw new Error("job not found");
  const answers = await db.query.applicationAnswers.findMany({
    where: eq(tables.applicationAnswers.applicationId, applicationId),
  });

  log.info("attempting programmatic submit", { applicationId, source: job.source, url: job.url });
  try {
    if (job.source === "lever") await submitLever(applicationId, job.url, answers);
    else if (job.source === "greenhouse") await submitGreenhouse(applicationId, job.url, answers);
    else throw new SubmitNotPossibleError(`programmatic submit not supported for source "${job.source}"`);
  } catch (err) {
    if (err instanceof SubmitNotPossibleError) {
      log.warn("falling back to assisted", { applicationId, source: job.source, reason: err.message });
    } else {
      log.error("submit failed", { applicationId, source: job.source, error: String(err).slice(0, 300) });
    }
    throw err;
  }

  await db
    .update(tables.applications)
    .set({ status: "submitted", method: "api", submittedAt: new Date(), updatedAt: new Date() })
    .where(eq(tables.applications.id, applicationId));
  log.info("submitted programmatically", { applicationId, source: job.source });
  return "api";
}

// User confirms they submitted manually via the assisted view.
export async function markSubmittedManually(applicationId: number): Promise<void> {
  log.info("marked submitted manually", { applicationId });
  await db
    .update(tables.applications)
    .set({ status: "submitted", method: "assisted", submittedAt: new Date(), updatedAt: new Date() })
    .where(eq(tables.applications.id, applicationId));
  await db.insert(tables.events).values({
    applicationId,
    type: "submitted",
    detail: "Marked as submitted (assisted/manual)",
  });
}
