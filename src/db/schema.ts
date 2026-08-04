import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ---------- Companies (ATS boards we poll) ----------
export const companies = sqliteTable(
  "companies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    ats: text("ats", { enum: ["greenhouse", "lever", "ashby"] }).notNull(),
    // board token/slug, e.g. "stripe" for boards-api.greenhouse.io/v1/boards/stripe
    token: text("token").notNull(),
    website: text("website"),
    // null = unknown; set from scoring signals or manually
    visaSponsor: integer("visa_sponsor", { mode: "boolean" }),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    // how this board entered the system: "seed" | "discovery" | "manual"
    origin: text("origin").notNull().default("seed"),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp" }),
    lastError: text("last_error"),
    errorCount: integer("error_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("companies_ats_token").on(t.ats, t.token)]
);

// ---------- Jobs ----------
export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    companyId: integer("company_id").references(() => companies.id),
    source: text("source").notNull(), // greenhouse | lever | ashby | remoteok | weworkremotely | hn | yc | manual
    externalId: text("external_id").notNull(),
    url: text("url").notNull(),
    applyUrl: text("apply_url"),
    title: text("title").notNull(),
    companyName: text("company_name").notNull(),
    location: text("location"),
    salary: text("salary"),
    description: text("description"),
    postedAt: integer("posted_at", { mode: "timestamp" }),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    closed: integer("closed", { mode: "boolean" }).notNull().default(false),

    // AI scoring
    score: real("score"), // 0-100 fit score
    eligibility: text("eligibility", {
      enum: [
        "remote-worldwide",
        "remote-region-restricted", // remote but limited to broad regions/timezones that could include you
        "country-restricted", // remote but hiring in specific countries only -> flagged list
        "onsite-europe", // onsite/hybrid in London/Europe
        "onsite-other",
        "unknown",
      ],
    }),
    visaSignal: text("visa_signal", { enum: ["yes", "likely", "no", "unknown"] }),
    scoreReasons: text("score_reasons"), // JSON string[]
    roleCategory: text("role_category"), // backend | infra | fullstack | mobile | other
    scoredAt: integer("scored_at", { mode: "timestamp" }),

    // feed lifecycle
    feedStatus: text("feed_status", { enum: ["new", "queued", "dismissed", "applied"] })
      .notNull()
      .default("new"),
    raw: text("raw"), // JSON of the original payload
  },
  (t) => [
    uniqueIndex("jobs_source_external").on(t.source, t.externalId),
    index("jobs_feed_status").on(t.feedStatus),
    index("jobs_score").on(t.score),
  ]
);

// ---------- Applications ----------
export const applications = sqliteTable(
  "applications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobs.id),
    status: text("status", {
      enum: [
        "drafting", // answers being generated / edited
        "ready", // ready for user review
        "submitted",
        "screening",
        "interviewing",
        "offer",
        "rejected",
        "ghosted",
        "withdrawn",
      ],
    })
      .notNull()
      .default("drafting"),
    method: text("method", { enum: ["api", "assisted"] }).notNull().default("assisted"),
    coverLetter: text("cover_letter"),
    jdSnapshot: text("jd_snapshot"), // job description at time of application
    formSchema: text("form_schema"), // JSON: the ATS form fields we discovered
    submittedAt: integer("submitted_at", { mode: "timestamp" }),
    nextActionAt: integer("next_action_at", { mode: "timestamp" }),
    nextActionNote: text("next_action_note"),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("applications_status").on(t.status), uniqueIndex("applications_job").on(t.jobId)]
);

// Individual form fields + generated answers for an application
export const applicationAnswers = sqliteTable(
  "application_answers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: integer("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    fieldKey: text("field_key").notNull(), // ATS field name for programmatic submit
    label: text("label").notNull(),
    fieldType: text("field_type").notNull().default("text"), // text | textarea | select | multiselect | boolean | file
    options: text("options"), // JSON string[] for selects
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    answer: text("answer"),
    aiGenerated: integer("ai_generated", { mode: "boolean" }).notNull().default(false),
    confidence: text("confidence", { enum: ["high", "medium", "low"] }),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("answers_application").on(t.applicationId)]
);

// ---------- Timeline events ----------
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    applicationId: integer("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    type: text("type").notNull(), // created | status_change | submitted | note | interview | reminder
    detail: text("detail"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [index("events_application").on(t.applicationId)]
);

// ---------- Profile (key-value with JSON values) ----------
export const profile = sqliteTable("profile", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ---------- Resumes ----------
export const resumes = sqliteTable("resumes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  fileName: text("file_name").notNull(), // stored under data/resumes/
  parsed: text("parsed"), // JSON structured resume
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ---------- QA bank: every question ever answered, remembered forever ----------
export const qaBank = sqliteTable(
  "qa_bank",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    question: text("question").notNull(),
    normalized: text("normalized").notNull(), // lowercased/stripped for matching
    answer: text("answer").notNull(),
    timesUsed: integer("times_used").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (t) => [uniqueIndex("qa_normalized").on(t.normalized)]
);

// ---------- Scrape runs ----------
export const scrapeRuns = sqliteTable("scrape_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source: text("source").notNull(),
  startedAt: integer("started_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  found: integer("found").notNull().default(0),
  added: integer("added").notNull().default(0),
  error: text("error"),
});

// ---------- Settings ----------
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON
});
