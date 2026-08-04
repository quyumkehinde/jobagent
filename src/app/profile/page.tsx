"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Badge, btnPrimary, btnSecondary, btnDanger, input } from "@/components/ui";

interface Resume {
  id: number;
  name: string;
  isDefault: boolean;
  parsed: string | null;
  createdAt: string;
}
interface QA {
  id: number;
  question: string;
  answer: string;
  timesUsed: number;
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<Record<string, unknown>>({});
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [qa, setQa] = useState<QA[]>([]);
  const [uploading, setUploading] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [newQ, setNewQ] = useState({ question: "", answer: "" });

  const load = useCallback(async () => {
    const [p, r, q] = await Promise.all([
      fetch("/api/profile").then((x) => x.json()),
      fetch("/api/resumes").then((x) => x.json()),
      fetch("/api/qa").then((x) => x.json()),
    ]);
    setProfile(p.profile || {});
    setResumes(r.resumes || []);
    setQa(q.qa || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (fields: Record<string, unknown>) => {
    await fetch("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1200);
  };

  const upload = async (file: File) => {
    setUploading(true);
    const fd = new FormData();
    fd.append("resume", file);
    const res = await fetch("/api/resumes", { method: "POST", body: fd });
    const data = await res.json();
    setUploading(false);
    if (data.parseError) alert(`Uploaded, but parsing failed: ${data.parseError}\nCheck your Gemini key in Settings, then re-upload.`);
    load();
  };

  const str = (k: string) => (profile[k] as string) || "";
  const links = (profile.links as Record<string, string>) || {};

  const field = (label: string, key: string, placeholder = "", textarea = false) => (
    <label className="block">
      <span className="text-sm text-zinc-400">{label}</span>
      {textarea ? (
        <textarea
          className={`${input} mt-1 min-h-20`}
          defaultValue={str(key)}
          placeholder={placeholder}
          onBlur={(e) => save({ [key]: e.target.value })}
        />
      ) : (
        <input
          className={`${input} mt-1`}
          defaultValue={str(key)}
          placeholder={placeholder}
          onBlur={(e) => save({ [key]: e.target.value })}
        />
      )}
    </label>
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Profile</h1>
        {savedFlash && <Badge tone="green">saved ✓</Badge>}
      </div>
      <p className="text-sm text-zinc-400">
        Everything here grounds your applications. The AI never invents facts — it only uses what&apos;s on this page,
        your resume, and your saved answers.
      </p>

      <Card>
        <h2 className="font-semibold mb-3">Resume</h2>
        {resumes.map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-sm mb-1">
            <span>📄 {r.name}</span>
            {r.isDefault && <Badge tone="green">default</Badge>}
            {r.parsed ? <Badge tone="blue">parsed</Badge> : <Badge tone="yellow">not parsed</Badge>}
          </div>
        ))}
        <label className={`${btnSecondary} mt-2 cursor-pointer`}>
          {uploading ? "Uploading & parsing…" : resumes.length ? "Upload new resume (PDF)" : "Upload resume (PDF)"}
          <input
            type="file"
            accept=".pdf"
            className="hidden"
            disabled={uploading}
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </label>
        <details className="mt-4" open={!str("resumeLatex")}>
          <summary className="cursor-pointer text-sm font-medium">
            LaTeX source (enables per-job tailored resumes){" "}
            {str("resumeLatex") ? <Badge tone="green">set</Badge> : <Badge tone="yellow">not set</Badge>}
          </summary>
          <p className="text-xs text-zinc-500 mt-2 mb-1">
            Paste your one-page resume&apos;s LaTeX source. When drafting an application, the AI makes a per-job copy —
            mainly resurfacing skills the job description asks for — compiles it, and verifies it still fits one page.
            No source, no tailoring: applications just use your default PDF above.
          </p>
          <textarea
            className={`${input} mt-1 min-h-64 font-mono text-xs`}
            defaultValue={str("resumeLatex")}
            placeholder={"\\documentclass{article}\n..."}
            spellCheck={false}
            onBlur={(e) => e.target.value !== str("resumeLatex") && save({ resumeLatex: e.target.value })}
          />
        </details>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Basics</h2>
        <div className="grid grid-cols-2 gap-3">
          {field("Full name", "fullName")}
          {field("Email", "email")}
          {field("Phone (with country code)", "phone")}
          {field("Current location (city, country)", "location")}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="text-sm text-zinc-400">LinkedIn URL</span>
            <input
              className={`${input} mt-1`}
              defaultValue={links.linkedin || ""}
              onBlur={(e) => save({ links: { ...links, linkedin: e.target.value } })}
            />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">GitHub URL</span>
            <input
              className={`${input} mt-1`}
              defaultValue={links.github || ""}
              onBlur={(e) => save({ links: { ...links, github: e.target.value } })}
            />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">Website/Portfolio</span>
            <input
              className={`${input} mt-1`}
              defaultValue={links.website || ""}
              onBlur={(e) => save({ links: { ...links, website: e.target.value } })}
            />
          </label>
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">What applications always ask</h2>
        {field(
          "Work authorization (be precise — citizenships, visas held, where you can work without sponsorship)",
          "workAuthorization",
          "e.g. Nigerian citizen; no EU/UK work authorization — requires visa sponsorship for Europe; can work remotely as a contractor from Nigeria",
          true
        )}
        {field("Salary expectation", "salaryExpectation", "e.g. $90k–120k for remote; £70k–90k London", false)}
        {field("Notice period / availability", "noticePeriod", "e.g. Available immediately")}
        {field("Years of professional experience", "yearsExperience", "e.g. 6")}
        {field(
          "Anything else the AI should know when answering for you",
          "extraContext",
          "Preferences, constraints, standard answers to odd questions…",
          true
        )}
      </Card>

      <Card>
        <h2 className="font-semibold mb-1">Answer bank</h2>
        <p className="text-sm text-zinc-400 mb-3">
          Saved answers are reused verbatim whenever a form asks the same question. Answers you edit during review with
          &ldquo;remember&rdquo; checked land here automatically.
        </p>
        <div className="space-y-2 mb-4">
          {qa.map((item) => (
            <div key={item.id} className="flex items-start gap-2 text-sm border-t border-zinc-800 pt-2">
              <div className="flex-1">
                <div className="font-medium">{item.question}</div>
                <div className="text-zinc-400">{item.answer}</div>
                <div className="text-xs text-zinc-600">used {item.timesUsed}×</div>
              </div>
              <button
                className={btnDanger}
                onClick={async () => {
                  await fetch("/api/qa", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: item.id }),
                  });
                  load();
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
        <div className="space-y-2">
          <input
            className={input}
            placeholder="Question (e.g. Why do you want to work here?)"
            value={newQ.question}
            onChange={(e) => setNewQ({ ...newQ, question: e.target.value })}
          />
          <textarea
            className={`${input} min-h-16`}
            placeholder="Your answer"
            value={newQ.answer}
            onChange={(e) => setNewQ({ ...newQ, answer: e.target.value })}
          />
          <button
            className={btnPrimary}
            disabled={!newQ.question || !newQ.answer}
            onClick={async () => {
              await fetch("/api/qa", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(newQ),
              });
              setNewQ({ question: "", answer: "" });
              load();
            }}
          >
            Add answer
          </button>
        </div>
      </Card>
    </div>
  );
}
