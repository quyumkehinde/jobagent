import fs from "node:fs";
import path from "node:path";
import { db, tables } from "@/db";
import { eq } from "drizzle-orm";
import { generateJSON } from "./gemini";
import { getSetting, DEFAULTS } from "./settings";

const RESUME_SCHEMA = {
  type: "object",
  properties: {
    fullName: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
    location: { type: "string" },
    links: {
      type: "object",
      properties: {
        linkedin: { type: "string" },
        github: { type: "string" },
        website: { type: "string" },
      },
    },
    summary: { type: "string" },
    yearsExperience: { type: "number" },
    skills: { type: "array", items: { type: "string" } },
    experience: {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          title: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          location: { type: "string" },
          highlights: { type: "array", items: { type: "string" } },
        },
        required: ["company", "title"],
      },
    },
    education: {
      type: "array",
      items: {
        type: "object",
        properties: {
          school: { type: "string" },
          degree: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
        },
        required: ["school"],
      },
    },
  },
  required: ["fullName", "skills", "experience"],
};

export async function parseResume(resumeId: number): Promise<object> {
  const resume = await db.query.resumes.findFirst({ where: eq(tables.resumes.id, resumeId) });
  if (!resume) throw new Error("resume not found");
  const filePath = path.join(process.cwd(), "data", "resumes", resume.fileName);
  const data = fs.readFileSync(filePath).toString("base64");
  const model = await getSetting("writerModel", DEFAULTS.writerModel);

  const parsed = await generateJSON<Record<string, unknown>>(
    "Extract this resume into the structured JSON schema. Preserve exact wording of experience highlights (these ground future application answers — do not embellish). Include every role.",
    { model, responseSchema: RESUME_SCHEMA, file: { mimeType: "application/pdf", data } }
  );

  await db.update(tables.resumes).set({ parsed: JSON.stringify(parsed) }).where(eq(tables.resumes.id, resumeId));

  // seed profile keys that are still empty
  const seedIfEmpty = async (key: string, value: unknown) => {
    if (value == null || value === "") return;
    await db
      .insert(tables.profile)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoNothing();
  };
  await seedIfEmpty("fullName", parsed.fullName);
  await seedIfEmpty("email", parsed.email);
  await seedIfEmpty("phone", parsed.phone);
  await seedIfEmpty("location", parsed.location);
  await seedIfEmpty("links", parsed.links);
  await seedIfEmpty("skills", parsed.skills);
  await seedIfEmpty("yearsExperience", parsed.yearsExperience);
  await seedIfEmpty("headline", parsed.summary);

  return parsed;
}
