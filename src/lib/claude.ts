import { spawn } from "node:child_process";
import path from "node:path";
import { createLogger } from "./log";
import { reportRateLimit } from "./hostgate";
import type { GenOptions } from "./llm";

const log = createLogger("claude");

const CALL_TIMEOUT_MS = 300_000;

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
}

// One headless Claude Code CLI call (`claude -p`). Runs on the user's logged-in
// subscription — no API key. ANTHROPIC_API_KEY is stripped from the child env so a
// stray key can never flip the call onto API billing.
function runCli(args: string[], stdin: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn("claude", args, { env, cwd: process.cwd() });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude CLI timed out after ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn claude CLI — is it installed and on PATH? (${err.message})`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

export async function claudeGenerate(prompt: string, opts: GenOptions): Promise<string> {
  // Structured output requires an object root — wrap array-root schemas (scoring,
  // answers) in {items: …} and unwrap the result below.
  const schemaRoot = opts.responseSchema as { type?: string } | undefined;
  const needsWrap = !!schemaRoot && schemaRoot.type !== "object";
  const effectiveSchema = needsWrap
    ? { type: "object", properties: { items: schemaRoot }, required: ["items"] }
    : schemaRoot;

  const args = [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--model",
    opts.model,
    // pure LLM call — no tools, except Read when the prompt references a file on disk
    "--tools",
    opts.file?.path ? "Read" : "",
  ];
  if (opts.system) args.push("--system-prompt", opts.system);
  if (effectiveSchema) args.push("--json-schema", JSON.stringify(effectiveSchema));

  let fullPrompt = prompt;
  if (opts.file) {
    if (!opts.file.path) throw new Error("claude provider needs file.path — inline base64 files are not supported");
    fullPrompt = `Read the file at ${path.resolve(opts.file.path)} first, then follow these instructions:\n\n${prompt}`;
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { code, stdout, stderr } = await runCli(args, fullPrompt);
      let data: CliResult | undefined;
      try {
        data = JSON.parse(stdout) as CliResult;
      } catch {
        /* non-JSON output — fall through to the error below */
      }
      if (code !== 0 || !data || data.is_error || data.subtype !== "success")
        throw new Error(
          `claude CLI failed (exit ${code}, subtype ${data?.subtype || "?"}): ${(data?.result || stderr || stdout).slice(0, 300)}`
        );
      // --json-schema puts validated JSON in structured_output; return it as text so
      // generate() keeps a single string contract across providers
      if (data.structured_output != null) {
        const out = needsWrap ? (data.structured_output as { items: unknown }).items : data.structured_output;
        return JSON.stringify(out);
      }
      if (!data.result) throw new Error("empty response");
      return data.result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const limited = /usage limit|rate.?limit|429/i.test(msg);
      const retryable = limited || /overloaded|5\d\d|timed out|empty response/i.test(msg);
      if (limited) await reportRateLimit("claude-code", `claude ${opts.model}`, 0);
      if (!retryable || attempt === 3) throw err;
      const backoffMs = (attempt + 1) * 15000;
      log.warn("retrying after error", { attempt: attempt + 1, backoffMs, model: opts.model, error: msg.slice(0, 200) });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw new Error("unreachable");
}
