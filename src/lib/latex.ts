import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { createLogger } from "./log";

const run = promisify(execFile);
const log = createLogger("latex");

// Compiled per-job resumes live alongside uploaded ones so backup stays "copy data/".
export const TAILORED_DIR = path.join(process.cwd(), "data", "resumes", "tailored");

export class LatexNotAvailableError extends Error {
  constructor() {
    super("no LaTeX compiler found — install tectonic (brew install tectonic)");
  }
}

export class LatexCompileError extends Error {
  constructor(public compileLog: string) {
    super("LaTeX compilation failed");
  }
}

export interface CompileResult {
  fileName: string; // stored in applications.tailoredResumePdf
  pdfPath: string; // absolute
  pages: number;
}

let tectonicChecked: boolean | null = null;
async function tectonicAvailable(): Promise<boolean> {
  if (tectonicChecked !== null) return tectonicChecked;
  try {
    await run("tectonic", ["--version"]);
    tectonicChecked = true;
  } catch {
    tectonicChecked = false;
  }
  return tectonicChecked;
}

// Compiles LaTeX source to data/resumes/tailored/<baseName>.pdf and reports the page
// count (via pdf-lib — tectonic doesn't print one). Throws LatexCompileError with the
// tail of the compiler log on failure; the build dir is temp and always cleaned up.
export async function compileResumeLatex(source: string, baseName: string): Promise<CompileResult> {
  if (!(await tectonicAvailable())) throw new LatexNotAvailableError();

  const buildDir = path.join(TAILORED_DIR, `.build-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(buildDir, { recursive: true });
  const texPath = path.join(buildDir, "resume.tex");
  fs.writeFileSync(texPath, source, "utf8");

  try {
    // --chatter minimal keeps the log to warnings/errors; first-ever run may download packages
    await run("tectonic", ["--chatter", "minimal", "resume.tex"], {
      cwd: buildDir,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const compileLog = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n").slice(-3000);
    fs.rmSync(buildDir, { recursive: true, force: true });
    log.warn("compile failed", { baseName, error: compileLog.slice(-300) });
    throw new LatexCompileError(compileLog);
  }

  const builtPdf = path.join(buildDir, "resume.pdf");
  const bytes = fs.readFileSync(builtPdf);
  const pages = (await PDFDocument.load(bytes)).getPageCount();

  const fileName = `${baseName}.pdf`;
  const pdfPath = path.join(TAILORED_DIR, fileName);
  fs.mkdirSync(TAILORED_DIR, { recursive: true });
  fs.copyFileSync(builtPdf, pdfPath);
  fs.rmSync(buildDir, { recursive: true, force: true });

  log.info("compiled", { fileName, pages, bytes: bytes.length });
  return { fileName, pdfPath, pages };
}
