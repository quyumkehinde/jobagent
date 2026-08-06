import { fetchJson } from "@/connectors/types";

export interface FormField {
  fieldKey: string; // ATS-native field name, used for programmatic submit
  label: string;
  fieldType: "text" | "textarea" | "select" | "multiselect" | "boolean" | "file";
  options?: string[];
  required: boolean;
}

// The universal field set used when we can't introspect the real form (Lever custom
// questions, aggregators). Matches what ~every application asks.
export function standardFields(): FormField[] {
  return [
    { fieldKey: "name", label: "Full name", fieldType: "text", required: true },
    { fieldKey: "email", label: "Email", fieldType: "text", required: true },
    { fieldKey: "phone", label: "Phone", fieldType: "text", required: false },
    { fieldKey: "urls[LinkedIn]", label: "LinkedIn URL", fieldType: "text", required: false },
    { fieldKey: "urls[GitHub]", label: "GitHub URL", fieldType: "text", required: false },
    { fieldKey: "urls[Portfolio]", label: "Portfolio/Website", fieldType: "text", required: false },
    { fieldKey: "location", label: "Current location", fieldType: "text", required: false },
    { fieldKey: "comments", label: "Cover letter / additional information", fieldType: "textarea", required: false },
  ];
}

interface GhQuestionField {
  name: string;
  type: string;
  values?: { label: string; value: number | string }[];
}
interface GhQuestion {
  label: string;
  required: boolean;
  fields: GhQuestionField[];
}
interface GhJobDetail {
  questions?: GhQuestion[];
  compliance?: { questions: GhQuestion[] }[];
  location_questions?: GhQuestion[];
}

function ghType(t: string): FormField["fieldType"] {
  switch (t) {
    case "input_file":
      return "file";
    case "textarea":
      return "textarea";
    case "multi_value_single_select":
      return "select";
    case "multi_value_multi_select":
      return "multiselect";
    default:
      return "text";
  }
}

// Greenhouse exposes the real application form via its public job board API.
export async function fetchGreenhouseForm(boardToken: string, jobId: string): Promise<FormField[]> {
  const data = await fetchJson<GhJobDetail>(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${jobId}?questions=true`
  );
  const out: FormField[] = [];
  const push = (q: GhQuestion) => {
    // File questions (Resume/CV, cover letter) come with a sibling "or paste text"
    // field — we always attach the real file, so only keep the file field.
    const hasFile = (q.fields || []).some((f) => f.type === "input_file");
    for (const f of q.fields || []) {
      if (hasFile && f.type !== "input_file") continue;
      out.push({
        fieldKey: f.name,
        label: q.label,
        fieldType: ghType(f.type),
        options: f.values?.map((v) => v.label),
        required: q.required,
      });
    }
  };
  for (const q of data.questions || []) push(q);
  for (const q of data.location_questions || []) push(q);
  for (const block of data.compliance || []) for (const q of block.questions || []) push(q);
  return out;
}

// Ashby serves the real application form through the same public GraphQL endpoint its
// hosted job board uses. `path` is the ATS-native field key (a `_systemfield_*` name or
// a question UUID) — kept as fieldKey so the extension/submit layer can target it.
interface AshbyFormField {
  path: string;
  title: string;
  type: string;
  isDeactivated?: boolean;
  selectableValues?: { label: string }[];
}
interface AshbyFormResponse {
  data?: {
    jobPosting?: {
      applicationForm?: {
        sections?: { fieldEntries?: { field?: AshbyFormField; isRequired?: boolean }[] }[];
      };
    };
  };
}

function ashbyType(t: string): { fieldType: FormField["fieldType"]; options?: string[] } {
  switch (t) {
    case "LongText":
      return { fieldType: "textarea" };
    case "File":
      return { fieldType: "file" };
    case "Boolean":
      // rendered as Yes/No buttons on Ashby — a two-option select reviews/fills cleanly
      return { fieldType: "select", options: ["Yes", "No"] };
    case "ValueSelect":
      return { fieldType: "select" };
    case "MultiValueSelect":
      return { fieldType: "multiselect" };
    default:
      // String, Email, Phone, Url, Location, Number, Date — all free-text for our purposes
      return { fieldType: "text" };
  }
}

export async function fetchAshbyForm(token: string, jobPostingId: string): Promise<FormField[]> {
  const data = await fetchJson<AshbyFormResponse>(
    "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationName: "ApiJobPosting",
        variables: { organizationHostedJobsPageName: token, jobPostingId },
        query:
          "query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) { jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) { id applicationForm { sections { fieldEntries { field isRequired } } } } }",
      }),
    }
  );
  const out: FormField[] = [];
  for (const s of data.data?.jobPosting?.applicationForm?.sections || []) {
    for (const e of s.fieldEntries || []) {
      const f = e.field;
      if (!f?.path || !f.title || f.isDeactivated) continue;
      const { fieldType, options } = ashbyType(f.type);
      out.push({
        fieldKey: f.path,
        label: f.title,
        fieldType,
        options: options ?? f.selectableValues?.map((v) => v.label),
        required: e.isRequired ?? false,
      });
    }
  }
  return out;
}

export async function fetchFormForJob(job: {
  source: string;
  externalId: string;
  raw: string | null;
}): Promise<{ fields: FormField[]; introspected: boolean }> {
  if (job.source === "greenhouse" && job.raw) {
    try {
      const raw = JSON.parse(job.raw) as { token?: string };
      if (raw.token) {
        const fields = await fetchGreenhouseForm(raw.token, job.externalId);
        if (fields.length) return { fields, introspected: true };
      }
    } catch {
      // fall through to standard fields
    }
  }
  if (job.source === "ashby" && job.raw) {
    try {
      const raw = JSON.parse(job.raw) as { id?: string; token?: string };
      if (raw.id && raw.token) {
        const fields = await fetchAshbyForm(raw.token, raw.id);
        if (fields.length) return { fields, introspected: true };
      }
    } catch {
      // fall through to standard fields
    }
  }
  if (job.source === "yc" && job.raw) {
    try {
      const raw = JSON.parse(job.raw) as { customQuestions?: unknown[] };
      const custom: FormField[] = [];
      (raw.customQuestions || []).forEach((q, i) => {
        const label =
          typeof q === "string"
            ? q
            : (q as { question?: string; text?: string; label?: string })?.question ??
              (q as { text?: string })?.text ??
              (q as { label?: string })?.label;
        if (label) {
          custom.push({
            fieldKey: `yc_custom_${i}`,
            label: String(label).slice(0, 300),
            fieldType: "textarea",
            required: false,
          });
        }
      });
      // still assisted (WaaS is login-gated) — these exist so drafting prepares answers
      if (custom.length) return { fields: [...standardFields(), ...custom], introspected: false };
    } catch {
      // fall through to standard fields
    }
  }
  return { fields: standardFields(), introspected: false };
}
