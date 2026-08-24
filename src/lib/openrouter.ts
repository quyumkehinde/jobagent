import { getSetting } from "./settings";
import { createLogger } from "./log";
import { reportRateLimit } from "./hostgate";
import type { GenOptions } from "./llm";

const log = createLogger("openrouter");

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

async function getKey(): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY || (await getSetting<string>("openrouterApiKey", ""));
  if (!key) throw new Error("OPENROUTER_API_KEY not set (env or Settings page)");
  return key;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "file"; file: { filename: string; file_data: string } };

export async function openrouterGenerate(prompt: string, opts: GenOptions): Promise<string> {
  const key = await getKey();

  // Schema goes into the system prompt rather than response_format: some of our schemas
  // have array roots, which strict structured-output modes reject, and stealth-model
  // support for response_format is not guaranteed. generateJSON() cleans up the result.
  let system = opts.system || "";
  if (opts.responseSchema) {
    system += `${system ? "\n\n" : ""}Respond with ONLY valid JSON matching this JSON Schema — no prose, no markdown fences:\n${JSON.stringify(opts.responseSchema)}`;
  }

  const content: ContentPart[] = [{ type: "text", text: prompt }];
  if (opts.file)
    content.unshift({
      type: "file",
      file: { filename: "document.pdf", file_data: `data:${opts.file.mimeType};base64,${opts.file.data}` },
    });

  const body = {
    model: opts.model,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content }],
    temperature: opts.temperature ?? 0.3,
    // pdf-text is OpenRouter's free extraction engine; only sent when a file is attached
    ...(opts.file ? { plugins: [{ id: "file-parser", pdf: { engine: "pdf-text" } }] } : {}),
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const raw = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
      const data = JSON.parse(raw);
      // OpenRouter can return 200 with an error object in the body
      if (data.error)
        throw new Error(`HTTP ${data.error.code || res.status}: ${String(data.error.message).slice(0, 300)}`);
      const text: string | undefined = data.choices?.[0]?.message?.content;
      if (!text) throw new Error("empty response");
      return text;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = /429|rate.?limit|HTTP 5\d\d|overloaded|empty response|fetch failed/i.test(msg);
      if (/429|rate.?limit/i.test(msg)) await reportRateLimit("openrouter.ai", `openrouter ${opts.model}`, 0);
      if (!retryable || attempt === 3) throw err;
      const backoffMs = (attempt + 1) * 15000;
      log.warn("retrying after error", { attempt: attempt + 1, backoffMs, model: opts.model, error: msg.slice(0, 200) });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw new Error("unreachable");
}
