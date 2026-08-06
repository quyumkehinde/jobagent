import { UA, fetchJson } from "@/connectors/types";

export interface FormField {
  fieldKey: string; // ATS-native field name, used for programmatic submit
  label: string;
  fieldType: "text" | "textarea" | "select" | "multiselect" | "boolean" | "file";
  options?: string[];
  required: boolean;
}

// The universal field set used when we can't introspect the real form (SmartRecruiters
// sits behind DataDome, BambooHR/Personio expose no public form API, aggregators link
// out). Matches what ~every application asks.
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

// Workable serves the real per-job application form (identity fields, resume, screening
// questions with choices) as JSON. Repeating groups (education/experience history) are
// skipped — they can't be drafted flat and the real form collects them interactively.
interface WorkableFormField {
  id?: string;
  name?: string;
  label?: string;
  body?: string;
  type?: string;
  required?: boolean;
  options?: { name?: string; label?: string; value?: string; body?: string }[];
  choices?: { name?: string; label?: string; value?: string; body?: string }[];
  fields?: WorkableFormField[];
  singleOption?: boolean;
}

function workableField(f: WorkableFormField): FormField | null {
  const key = f.id || f.name;
  const label = f.label || f.body;
  if (!key || !label) return null;
  const opts = (f.options || f.choices || [])
    .map((o) => o.name ?? o.label ?? o.body ?? o.value)
    .filter((s): s is string => !!s);
  let fieldType: FormField["fieldType"];
  switch (f.type) {
    case "group":
      return null; // repeating history sections
    case "paragraph":
      fieldType = "textarea";
      break;
    case "file":
      fieldType = "file";
      break;
    case "boolean":
      return { fieldKey: key, label, fieldType: "select", options: ["Yes", "No"], required: !!f.required };
    default:
      fieldType = opts.length ? (/multiple|checkbox/.test(f.type || "") ? "multiselect" : "select") : "text";
  }
  return { fieldKey: key, label, fieldType, options: opts.length ? opts : undefined, required: !!f.required };
}

export async function fetchWorkableForm(shortcode: string): Promise<FormField[]> {
  const sections = await fetchJson<{ fields?: WorkableFormField[] }[]>(
    `https://apply.workable.com/api/v1/jobs/${encodeURIComponent(shortcode)}/form`
  );
  const out: FormField[] = [];
  for (const s of sections || [])
    for (const f of s.fields || []) {
      const mapped = workableField(f);
      if (mapped) out.push(mapped);
    }
  return out;
}

// Lever renders the whole application form server-side: standard inputs under their
// submit names (name, email, urls[LinkedIn], …), custom-question cards as hidden
// baseTemplate JSON blobs (answers post as cards[<id>][field<N>]), and the EEO block as
// selects/radios. Parsing that HTML gives the real per-posting form — including which
// URL fields exist and which are required.
interface LeverCardField {
  type?: string;
  text?: string;
  required?: boolean;
  options?: { text?: string }[];
}

const LEVER_STANDARD: { name: string; label: string; type: FormField["fieldType"] }[] = [
  { name: "resume", label: "Resume/CV", type: "file" },
  { name: "name", label: "Full name", type: "text" },
  { name: "email", label: "Email", type: "text" },
  { name: "phone", label: "Phone", type: "text" },
  { name: "org", label: "Current company", type: "text" },
  { name: "location", label: "Current location", type: "text" },
];

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

function leverSelectOptions(selectHtml: string): string[] {
  const out: string[] = [];
  for (const m of selectHtml.matchAll(/<option[^>]*>([^<]*)<\/option>/gi)) {
    const text = decodeEntities(m[1]).trim();
    if (text && !/^select|^--/i.test(text)) out.push(text);
  }
  return out;
}

export async function fetchLeverForm(jobUrl: string): Promise<FormField[]> {
  const m = /jobs\.(eu\.)?lever\.co\/([^/?#]+)\/([a-f0-9-]+)/i.exec(jobUrl);
  if (!m) return [];
  const res = await fetch(`https://jobs.${m[1] || ""}lever.co/${m[2]}/${m[3]}/apply`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const out: FormField[] = [];

  const inputTag = (name: string) =>
    new RegExp(`<input[^>]*name="${name.replace(/[[\]]/g, "\\$&")}"[^>]*>`, "i").exec(html)?.[0];

  for (const f of LEVER_STANDARD) {
    const tag = inputTag(f.name);
    if (tag) out.push({ fieldKey: f.name, label: f.label, fieldType: f.type, required: /\brequired\b/.test(tag) });
  }
  // URL fields vary per posting: urls[LinkedIn], urls[GitHub], urls[Portfolio], urls[Other], …
  for (const u of html.matchAll(/<input[^>]*name="(urls\[([^\]]+)\])"[^>]*>/gi)) {
    const label = decodeEntities(u[2]);
    out.push({
      fieldKey: decodeEntities(u[1]),
      label: /\s/.test(label) ? label : `${label} URL`,
      fieldType: "text",
      required: /\brequired\b/.test(u[0]),
    });
  }

  // custom question cards — the hidden baseTemplate JSON is the authoritative schema
  // (attribute order varies, so grab the whole tag and pull value out separately)
  for (const tag of html.matchAll(/<input[^>]*name="cards\[([^\]]+)\]\[baseTemplate\]"[^>]*>/gi)) {
    const c = [tag[0], tag[1], /value="([^"]*)"/i.exec(tag[0])?.[1] ?? ""] as const;
    try {
      const tpl = JSON.parse(decodeEntities(c[2])) as { fields?: LeverCardField[] };
      (tpl.fields || []).forEach((f, i) => {
        if (!f.text) return;
        const opts = (f.options || []).map((o) => o.text).filter((s): s is string => !!s);
        const fieldType: FormField["fieldType"] =
          f.type === "textarea"
            ? "textarea"
            : f.type === "file"
              ? "file"
              : f.type === "multiple-select"
                ? "multiselect"
                : opts.length
                  ? "select"
                  : "text";
        out.push({
          fieldKey: `cards[${c[1]}][field${i}]`,
          label: f.text,
          fieldType,
          options: opts.length ? opts : undefined,
          required: !!f.required,
        });
      });
    } catch {
      // unparseable card → its questions surface on the real form only
    }
  }

  if (inputTag("comments") || /<textarea[^>]*name="comments"/i.test(html))
    out.push({ fieldKey: "comments", label: "Additional information", fieldType: "textarea", required: false });

  // EEO block: gender/veteran/disability are selects, race is a radio group
  const EEO_LABELS: Record<string, string> = {
    "eeo[gender]": "Gender",
    "eeo[veteran]": "Veteran status",
    "eeo[disability]": "Disability status",
  };
  for (const s of html.matchAll(/<select[^>]*name="(eeo\[[^\]]+\])"[^>]*>([\s\S]*?)<\/select>/gi)) {
    const options = leverSelectOptions(s[2]);
    if (options.length)
      out.push({
        fieldKey: s[1],
        label: EEO_LABELS[s[1]] || s[1],
        fieldType: "select",
        options,
        required: false,
      });
  }
  const race = [...html.matchAll(/<input[^>]*type="radio"[^>]*name="eeo\[race\]"[^>]*value="([^"]+)"/gi)]
    .map((r) => decodeEntities(r[1]))
    .filter(Boolean);
  if (race.length)
    out.push({ fieldKey: "eeo[race]", label: "Race", fieldType: "select", options: race, required: false });

  return out;
}

// Recruitee exposes the offer (incl. per-offer field toggles and open questions) via its
// public careers API. Video/photo asks are skipped — they can't be drafted or auto-filled.
interface RecruiteeQuestion {
  id: number;
  body?: string;
  kind?: string;
  required?: boolean;
  open_question_options?: { body?: string; title?: string }[];
}
interface RecruiteeOffer {
  offer?: {
    open_questions?: RecruiteeQuestion[];
    options_phone?: string;
    options_cv?: string;
    options_cover_letter?: string;
  };
}

export async function fetchRecruiteeForm(token: string, offerId: number | string): Promise<FormField[]> {
  const data = await fetchJson<RecruiteeOffer>(
    `https://${encodeURIComponent(token)}.recruitee.com/api/offers/${offerId}`
  );
  const offer = data.offer;
  if (!offer) return [];
  const on = (opt?: string) => !!opt && opt !== "off";
  const out: FormField[] = [
    { fieldKey: "candidate[name]", label: "Full name", fieldType: "text", required: true },
    { fieldKey: "candidate[email]", label: "Email", fieldType: "text", required: true },
  ];
  if (on(offer.options_phone))
    out.push({ fieldKey: "candidate[phone]", label: "Phone", fieldType: "text", required: offer.options_phone === "required" });
  if (on(offer.options_cv))
    out.push({ fieldKey: "candidate[cv]", label: "Resume/CV", fieldType: "file", required: offer.options_cv === "required" });
  for (const q of offer.open_questions || []) {
    if (q.body) q.body = q.body.trim();
    if (!q.body || q.kind === "video" || q.kind === "photo") continue;
    const opts = (q.open_question_options || []).map((o) => o.body ?? o.title).filter((s): s is string => !!s);
    if (q.kind === "boolean") {
      out.push({ fieldKey: `oq_${q.id}`, label: q.body, fieldType: "select", options: ["Yes", "No"], required: !!q.required });
      continue;
    }
    let fieldType: FormField["fieldType"];
    if (q.kind === "file") fieldType = "file";
    else if (q.kind === "text") fieldType = "textarea";
    else if (opts.length) fieldType = /multi/.test(q.kind || "") ? "multiselect" : "select";
    else fieldType = "text";
    out.push({ fieldKey: `oq_${q.id}`, label: q.body, fieldType, options: opts.length ? opts : undefined, required: !!q.required });
  }
  if (on(offer.options_cover_letter))
    out.push({
      fieldKey: "candidate[cover_letter]",
      label: "Cover letter",
      fieldType: "textarea",
      required: offer.options_cover_letter === "required",
    });
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
  url: string;
  raw: string | null;
}): Promise<{ fields: FormField[]; introspected: boolean }> {
  if (job.source === "lever") {
    try {
      const fields = await fetchLeverForm(job.url);
      if (fields.length) return { fields, introspected: true };
    } catch {
      // fall through to standard fields
    }
  }
  if (job.source === "workable" && job.raw) {
    try {
      const raw = JSON.parse(job.raw) as { shortcode?: string };
      if (raw.shortcode) {
        const fields = await fetchWorkableForm(raw.shortcode);
        if (fields.length) return { fields, introspected: true };
      }
    } catch {
      // fall through to standard fields
    }
  }
  if (job.source === "recruitee" && job.raw) {
    try {
      const raw = JSON.parse(job.raw) as { id?: number | string; token?: string };
      if (raw.id && raw.token) {
        const fields = await fetchRecruiteeForm(raw.token, raw.id);
        if (fields.length) return { fields, introspected: true };
      }
    } catch {
      // fall through to standard fields
    }
  }
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
