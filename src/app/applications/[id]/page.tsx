"use client";

import { use, useCallback, useEffect, useState } from "react";
import { Card, Badge, btnPrimary, btnSecondary, input } from "@/components/ui";

interface Answer {
  id: number;
  fieldKey: string;
  label: string;
  fieldType: string;
  options: string | null;
  required: boolean;
  answer: string | null;
  aiGenerated: boolean;
  confidence: string | null;
}
interface AppData {
  application: {
    id: number;
    status: string;
    method: string;
    coverLetter: string | null;
    notes: string | null;
    nextActionAt: string | null;
    nextActionNote: string | null;
    submittedAt: string | null;
  };
  job: { id: number; title: string; companyName: string; url: string; applyUrl: string | null; source: string; description: string | null };
  answers: Answer[];
  events: { id: number; type: string; detail: string | null; createdAt: string }[];
}

const STATUSES = ["drafting", "ready", "submitted", "screening", "interviewing", "offer", "rejected", "ghosted", "withdrawn"];

function ConfidenceBadge({ a }: { a: Answer }) {
  if (!a.answer) return <Badge tone="red">empty</Badge>;
  if (a.confidence === "low") return <Badge tone="red">low confidence — check</Badge>;
  if (a.confidence === "medium") return <Badge tone="yellow">medium</Badge>;
  if (a.aiGenerated) return <Badge tone="blue">AI</Badge>;
  return <Badge tone="green">✓</Badge>;
}

export default function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<AppData | null>(null);
  const [saving, setSaving] = useState<number | null>(null);
  const [submitState, setSubmitState] = useState<{ busy: boolean; assistedReason?: string }>({ busy: false });
  const [copied, setCopied] = useState<number | "cover" | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/applications/${id}`);
    setData(await res.json());
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!data || !data.application) return <div className="text-zinc-500">Loading…</div>;
  const { application: app, job, answers, events } = data;

  const saveAnswer = async (a: Answer, value: string, remember: boolean) => {
    setSaving(a.id);
    await fetch(`/api/answers/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer: value, remember }),
    });
    setSaving(null);
    load();
  };

  const patchApp = async (fields: Record<string, unknown>) => {
    await fetch(`/api/applications/${app.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    load();
  };

  const submit = async (mode: "auto" | "manual") => {
    setSubmitState({ busy: true });
    const res = await fetch(`/api/applications/${app.id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    const result = await res.json();
    if (result.submitted) setSubmitState({ busy: false });
    else setSubmitState({ busy: false, assistedReason: result.reason || result.error });
    load();
  };

  const copy = async (text: string, key: number | "cover") => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 1200);
  };

  const applyLink = job.applyUrl || job.url;

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{job.title}</h1>
          <div className="text-zinc-400">
            {job.companyName} · <Badge>{job.source}</Badge> ·{" "}
            <a href={job.url} target="_blank" rel="noreferrer" className="text-emerald-400 underline">
              posting
            </a>
          </div>
        </div>
        <select
          className={`${input} !w-44`}
          value={app.status}
          onChange={(e) => patchApp({ status: e.target.value })}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {app.status === "ready" && (
        <Card className="border-emerald-800 bg-emerald-950/30">
          <div className="font-semibold mb-2">Submit this application</div>
          <div className="flex gap-2 flex-wrap items-center">
            {(job.source === "greenhouse" || job.source === "lever") && (
              <button className={btnPrimary} onClick={() => submit("auto")} disabled={submitState.busy}>
                {submitState.busy ? "Submitting…" : "Auto-submit"}
              </button>
            )}
            <a href={applyLink} target="_blank" rel="noreferrer" className={btnSecondary}>
              Open application page ↗
            </a>
            <button className={btnSecondary} onClick={() => submit("manual")} disabled={submitState.busy}>
              I submitted it manually — mark as applied
            </button>
          </div>
          {submitState.assistedReason && (
            <p className="text-sm text-amber-300 mt-2">
              Auto-submit not possible: {submitState.assistedReason}. Use the answers below — every field is ready to
              copy — then mark as applied.
            </p>
          )}
        </Card>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-2">Application answers</h2>
        <div className="space-y-3">
          {answers.map((a) => (
            <AnswerEditor
              key={a.id}
              answer={a}
              saving={saving === a.id}
              copied={copied === a.id}
              onCopy={(text) => copy(text, a.id)}
              onSave={saveAnswer}
            />
          ))}
        </div>
      </section>

      {app.coverLetter && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <h2 className="text-lg font-semibold">Cover letter</h2>
            <button className={btnSecondary} onClick={() => copy(app.coverLetter!, "cover")}>
              {copied === "cover" ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <textarea
            className={`${input} min-h-40 font-sans`}
            defaultValue={app.coverLetter}
            onBlur={(e) => e.target.value !== app.coverLetter && patchApp({ coverLetter: e.target.value })}
          />
        </section>
      )}

      <section className="grid grid-cols-2 gap-4">
        <Card>
          <h3 className="font-semibold mb-2">Next action</h3>
          <input
            type="date"
            className={input}
            defaultValue={app.nextActionAt ? app.nextActionAt.slice(0, 10) : ""}
            onChange={(e) => patchApp({ nextActionAt: e.target.value || null })}
          />
          <input
            className={`${input} mt-2`}
            placeholder="e.g. Follow up if no reply"
            defaultValue={app.nextActionNote || ""}
            onBlur={(e) => patchApp({ nextActionNote: e.target.value })}
          />
        </Card>
        <Card>
          <h3 className="font-semibold mb-2">Notes</h3>
          <textarea
            className={`${input} min-h-24`}
            defaultValue={app.notes || ""}
            onBlur={(e) => patchApp({ notes: e.target.value })}
          />
        </Card>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Timeline</h2>
        <Card>
          <ul className="space-y-1.5 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3">
                <span className="text-zinc-500 shrink-0">{new Date(e.createdAt).toLocaleString()}</span>
                <span>
                  <Badge>{e.type}</Badge> {e.detail}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {job.description && (
        <details className="text-sm text-zinc-400">
          <summary className="cursor-pointer font-medium text-zinc-300">Job description snapshot</summary>
          <div className="whitespace-pre-wrap mt-2 max-h-96 overflow-y-auto border border-zinc-800 rounded-md p-3">
            {job.description}
          </div>
        </details>
      )}
    </div>
  );
}

function AnswerEditor({
  answer: a,
  saving,
  copied,
  onCopy,
  onSave,
}: {
  answer: Answer;
  saving: boolean;
  copied: boolean;
  onCopy: (text: string) => void;
  onSave: (a: Answer, value: string, remember: boolean) => void;
}) {
  const [value, setValue] = useState(a.answer || "");
  const [remember, setRemember] = useState(false);
  const dirty = value !== (a.answer || "");
  const options: string[] = a.options ? JSON.parse(a.options) : [];

  return (
    <Card className={a.confidence === "low" || !a.answer ? "border-amber-800" : ""}>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-sm font-medium">
          {a.label} {a.required && <span className="text-red-400">*</span>}
        </div>
        <div className="flex items-center gap-2">
          <ConfidenceBadge a={a} />
          {value && (
            <button className="text-xs text-zinc-400 hover:text-white" onClick={() => onCopy(value)}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
          )}
        </div>
      </div>
      {a.fieldType === "file" ? (
        <div className="text-sm text-zinc-400">📎 {value || "(default resume)"}</div>
      ) : a.fieldType === "select" && options.length ? (
        <select className={input} value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">— select —</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : a.fieldType === "textarea" || (value && value.length > 80) ? (
        <textarea className={`${input} min-h-28`} value={value} onChange={(e) => setValue(e.target.value)} />
      ) : (
        <input className={input} value={value} onChange={(e) => setValue(e.target.value)} />
      )}
      {dirty && (
        <div className="flex items-center gap-3 mt-2">
          <button className={btnPrimary} onClick={() => onSave(a, value, remember)} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </button>
          <label className="flex items-center gap-1.5 text-sm text-zinc-400">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember this answer for future applications
          </label>
        </div>
      )}
    </Card>
  );
}
