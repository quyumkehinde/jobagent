import { GoogleGenAI } from "@google/genai";
import { getSetting } from "./settings";
import { createLogger } from "./log";

const log = createLogger("gemini");

let client: GoogleGenAI | null = null;

async function getClient(): Promise<GoogleGenAI> {
  if (client) return client;
  const key = process.env.GEMINI_API_KEY || (await getSetting<string>("geminiApiKey", ""));
  if (!key) throw new Error("GEMINI_API_KEY not set (env or Settings page)");
  client = new GoogleGenAI({ apiKey: key });
  return client;
}

// Simple spacing between calls to stay inside free-tier RPM limits.
let lastCallAt = 0;
const MIN_INTERVAL_MS = 6500; // ~9 req/min

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

export interface GenOptions {
  model: string;
  system?: string;
  responseSchema?: object; // JSON schema -> forces structured JSON output
  temperature?: number;
  // inline file (e.g. resume PDF)
  file?: { mimeType: string; data: string }; // base64
}

export async function generate(prompt: string, opts: GenOptions): Promise<string> {
  const ai = await getClient();
  const parts: object[] = [{ text: prompt }];
  if (opts.file) parts.unshift({ inlineData: { mimeType: opts.file.mimeType, data: opts.file.data } });

  for (let attempt = 0; attempt < 4; attempt++) {
    await throttle();
    try {
      const res = await ai.models.generateContent({
        model: opts.model,
        contents: [{ role: "user", parts }],
        config: {
          ...(opts.system ? { systemInstruction: opts.system } : {}),
          temperature: opts.temperature ?? 0.3,
          ...(opts.responseSchema
            ? { responseMimeType: "application/json", responseSchema: opts.responseSchema }
            : {}),
        },
      });
      const text = res.text;
      if (!text) throw new Error("empty response");
      return text;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const retryable = /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded|empty response/i.test(msg);
      if (!retryable || attempt === 3) throw err;
      // free tier: back off hard on quota errors
      const backoffMs = (attempt + 1) * 20000;
      log.warn("retrying after error", { attempt: attempt + 1, backoffMs, model: opts.model, error: msg.slice(0, 200) });
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw new Error("unreachable");
}

export async function generateJSON<T>(prompt: string, opts: GenOptions): Promise<T> {
  const text = await generate(prompt, opts);
  // Gemini occasionally wraps JSON in fences even with responseSchema
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  return JSON.parse(cleaned) as T;
}
