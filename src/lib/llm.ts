import { getSetting, DEFAULTS } from "./settings";
import { createLogger } from "./log";
import { openrouterGenerate } from "./openrouter";
import { claudeGenerate } from "./claude";

const log = createLogger("llm");

export interface GenOptions {
  model: string;
  system?: string;
  responseSchema?: object; // JSON schema the output must match
  temperature?: number; // OpenRouter only — the Claude CLI has no temperature control
  // inline file (e.g. resume PDF). `path` lets the Claude CLI read it from disk;
  // OpenRouter uses the base64 `data`.
  file?: { mimeType: string; data: string; path?: string };
}

// Simple spacing between calls to stay inside provider rate limits. Settings-driven
// so a limit change (preview model → paid tier) needs no code change.
let lastCallAt = 0;

async function throttle() {
  const minInterval = await getSetting("llmMinIntervalMs", DEFAULTS.llmMinIntervalMs);
  const wait = lastCallAt + minInterval - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export async function generate(prompt: string, opts: GenOptions): Promise<string> {
  await throttle();
  const provider = await getSetting("llmProvider", DEFAULTS.llmProvider);
  return provider === "claude" ? claudeGenerate(prompt, opts) : openrouterGenerate(prompt, opts);
}

// Models emitting LaTeX (or code) inside JSON string values produce two kinds of
// invalid JSON that a plain retry rarely fixes: literal control characters (raw
// newlines/tabs) and invalid escape sequences (\documentclass, \usepackage — where
// \u even starts a malformed unicode escape). Repair both inside strings only.
function repairJsonStrings(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = json[i + 1] ?? "";
      const validUnicode = next === "u" && /^[0-9a-fA-F]{4}$/.test(json.slice(i + 2, i + 6));
      if ('"\\/bfnrt'.includes(next) || validUnicode) {
        out += ch + next;
        i++;
      } else {
        out += "\\\\"; // lone backslash before e.g. "d" in \documentclass — escape it
      }
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else out += ch;
  }
  return out;
}

function tryParse<T>(text: string): T | undefined {
  for (const candidate of [text, repairJsonStrings(text)]) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

export async function generateJSON<T>(prompt: string, opts: GenOptions): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await generate(prompt, opts);
    // models occasionally wrap JSON in fences or lead-in prose despite instructions
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    let parsed = tryParse<T>(cleaned);
    if (parsed !== undefined) return parsed;

    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
    if (start >= 0 && end > start) {
      parsed = tryParse<T>(cleaned.slice(start, end + 1));
      if (parsed !== undefined) return parsed;
    }

    if (attempt === 1) throw new Error(`model did not return valid JSON: ${cleaned.slice(0, 200)}`);
    log.warn("invalid JSON, retrying once", { model: opts.model });
  }
  throw new Error("unreachable");
}
