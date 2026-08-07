"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, Badge, ScoreBadge, eligibilityBadge, btnPrimary, btnSecondary, btnDanger, input } from "@/components/ui";

interface Job {
  id: number;
  title: string;
  companyName: string;
  location: string | null;
  salary: string | null;
  url: string;
  source: string;
  score: number | null;
  eligibility: string | null;
  visaSignal: string | null;
  scoreReasons: string | null;
  dismissReason: string | null;
  roleCategory: string | null;
  feedStatus: string;
  postedAt: string | null;
}

const smallBtn =
  "flex-1 rounded-md px-2 py-1 text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors";
const smallBtnDanger =
  "flex-1 rounded-md px-2 py-1 text-xs font-medium bg-red-900/60 hover:bg-red-800 text-red-100 transition-colors";

interface DraftStatus {
  status: "pending" | "drafting" | "done" | "failed";
  applicationId?: number;
  error?: string;
}

const TABS = [
  { key: "queued", label: "Queued" },
  { key: "new", label: "Below threshold" },
  { key: "flagged", label: "Flagged", title: "Country-restricted roles" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all", label: "All" },
];

// "3d ago" / "5h ago" — compact age for the card meta line
function ago(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const ms = Date.now() - new Date(dateStr).getTime();
  if (ms < 0 || Number.isNaN(ms)) return null;
  const h = Math.floor(ms / 3600000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d <= 60 ? `${d}d ago` : null; // ancient dates are noise
}

export default function JobsPage() {
  const [tab, setTab] = useState("queued");
  const [q, setQ] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [dq, setDq] = useState<Record<number, DraftStatus>>({});
  const [dqActive, setDqActive] = useState(true); // true → poll; first mount checks for leftovers
  const [expanded, setExpanded] = useState<number | null>(null);
  const [dismissing, setDismissing] = useState<number | null>(null);
  const [dismissReason, setDismissReason] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkReason, setBulkReason] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addUrl, setAddUrl] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addNote, setAddNote] = useState<string | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/jobs?tab=${tab}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const data = await res.json();
    setJobs(data.jobs || []);
    setSelected(new Set()); // stale selections must not survive a tab/search change
    setLoading(false);
  }, [tab, q]);

  const toggleSelect = (id: number) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulkDismiss = async () => {
    setBulkBusy(true);
    await fetch("/api/jobs", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ids: [...selected],
        feedStatus: "dismissed",
        ...(bulkReason.trim() ? { dismissReason: bulkReason.trim() } : {}),
      }),
    });
    setBulkBusy(false);
    setBulkReason("");
    setJobs((js) => js.filter((j) => !selected.has(j.id)));
    setSelected(new Set());
  };

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (id: number, feedStatus: string, reason?: string) => {
    await fetch(`/api/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedStatus, ...(reason?.trim() ? { dismissReason: reason.trim() } : {}) }),
    });
    setDismissing(null);
    setDismissReason("");
    setJobs((js) => js.filter((j) => j.id !== id));
  };

  const pollQueue = useCallback(async (): Promise<boolean> => {
    const res = await fetch("/api/draft-queue");
    const data = await res.json();
    const map: Record<number, DraftStatus> = {};
    for (const it of data.items || []) map[it.jobId] = it;
    setDq(map);
    return (data.items || []).some(
      (it: DraftStatus) => it.status === "pending" || it.status === "drafting"
    );
  }, []);

  // poll while anything is queued/drafting; stops itself when the queue drains
  useEffect(() => {
    if (!dqActive) return;
    let cancelled = false;
    const tick = async () => {
      const active = await pollQueue();
      if (!active && !cancelled) setDqActive(false);
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [dqActive, pollQueue]);

  // Enqueue a background draft — no click-waiting: drafts run one at a time server-side
  // (free-tier Gemini pacing makes parallel drafting pointless) and the card's button
  // shows per-job progress. "Open draft" appears when done.
  const draft = async (id: number) => {
    setDq((m) => ({ ...m, [id]: { status: "pending" } }));
    await fetch("/api/draft-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: id }),
    });
    setDqActive(true);
  };

  const addJob = async () => {
    setAddBusy(true);
    setAddNote(null);
    const res = await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: addUrl.trim() }),
    });
    const data = await res.json();
    setAddBusy(false);
    if (data.error) setAddNote(`Error: ${data.error}`);
    else if (data.existed) setAddNote("Already tracked — it's in your feed.");
    else {
      setAddNote(
        `Added: "${data.extracted.title}" at ${data.extracted.companyName} (${data.extracted.descriptionChars} chars of description). Queued — scoring follows next run.`
      );
      setAddUrl("");
      setTab("queued");
      load();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Jobs</h1>
        <button className={btnSecondary} onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? "Close" : "+ Add job by URL"}
        </button>
      </div>
      {showAdd && (
        <Card className="space-y-2">
          <div className="flex gap-2">
            <input
              autoFocus
              className={`${input} flex-1`}
              placeholder="Paste a job posting URL — any site"
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addUrl.trim() && addJob()}
            />
            <button className={btnPrimary} onClick={addJob} disabled={addBusy || !addUrl.trim()}>
              {addBusy ? "Fetching…" : "Add"}
            </button>
          </div>
          {addNote && <p className="text-sm text-emerald-300">{addNote}</p>}
        </Card>
      )}
      <div className="flex gap-2 flex-wrap items-center">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            title={t.title}
            className={`px-3 py-1.5 rounded-md text-sm ${tab === t.key ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
          >
            {t.label}
          </button>
        ))}
        <input
          className={`${input} !w-64 ml-auto`}
          placeholder="Search title or company…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {!loading && jobs.length > 0 && tab !== "dismissed" && (
        <div className="flex gap-3 items-center flex-wrap">
          <label className="flex items-center gap-1.5 text-sm text-zinc-400">
            <input
              type="checkbox"
              className="accent-emerald-600"
              checked={selected.size === jobs.length && jobs.length > 0}
              onChange={() =>
                setSelected(selected.size === jobs.length ? new Set() : new Set(jobs.map((j) => j.id)))
              }
            />
            Select all ({jobs.length})
          </label>
          {selected.size > 0 && (
            <>
              <span className="text-sm text-zinc-300">{selected.size} selected</span>
              <input
                className={`${input} !w-96`}
                placeholder="Why? (optional, applies to all — e.g. “US-only roles at this company”)"
                value={bulkReason}
                onChange={(e) => setBulkReason(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && bulkDismiss()}
              />
              <button className={btnDanger} onClick={bulkDismiss} disabled={bulkBusy}>
                {bulkBusy ? "Dismissing…" : `Dismiss ${selected.size}`}
              </button>
              <button className={btnSecondary} onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          )}
        </div>
      )}

      {loading && <div className="text-zinc-500">Loading…</div>}
      {!loading && jobs.length === 0 && <Card className="text-zinc-400">Nothing here.</Card>}

      <div className="space-y-2">
        {jobs.map((j) => (
          <Card key={j.id}>
            <div className="flex items-start justify-between gap-4">
              {j.feedStatus !== "dismissed" && (
                <input
                  type="checkbox"
                  className="mt-1.5 accent-emerald-600 shrink-0"
                  checked={selected.has(j.id)}
                  onChange={() => toggleSelect(j.id)}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <ScoreBadge score={j.score} />
                  {eligibilityBadge(j.eligibility)}
                  {j.visaSignal === "yes" && <Badge tone="green">visa: yes</Badge>}
                  {j.visaSignal === "likely" && <Badge tone="blue">visa: likely</Badge>}
                  {j.roleCategory && <Badge>{j.roleCategory}</Badge>}
                  <Badge>{j.source}</Badge>
                  {j.feedStatus === "applied" && <Badge tone="green">applied</Badge>}
                </div>
                <div className="mt-1.5 font-medium">
                  <a href={j.url} target="_blank" rel="noreferrer" className="hover:text-emerald-400">
                    {j.title}
                  </a>
                </div>
                <div className="text-sm text-zinc-400">
                  {j.companyName}
                  {j.location ? ` · ${j.location}` : ""}
                  {j.salary ? ` · ${j.salary}` : ""}
                  {ago(j.postedAt) && <span className="text-zinc-500"> · posted {ago(j.postedAt)}</span>}
                </div>
                {j.feedStatus === "dismissed" && j.dismissReason && (
                  <div className="text-xs text-amber-400/80 mt-1">dismissed: {j.dismissReason}</div>
                )}
                {expanded === j.id && j.scoreReasons && (
                  <ul className="mt-2 text-sm text-zinc-300 list-disc pl-5">
                    {(JSON.parse(j.scoreReasons) as string[]).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-col gap-1.5 shrink-0 w-40">
                {dq[j.id]?.status === "done" ? (
                  <button
                    className={`${btnPrimary} justify-center`}
                    onClick={() => router.push(`/applications/${dq[j.id].applicationId}`)}
                  >
                    Open draft
                  </button>
                ) : (
                  <button
                    className={`${btnPrimary} justify-center`}
                    onClick={() => draft(j.id)}
                    disabled={dq[j.id]?.status === "pending" || dq[j.id]?.status === "drafting"}
                    title={dq[j.id]?.status === "failed" ? dq[j.id].error : undefined}
                  >
                    {dq[j.id]?.status === "pending"
                      ? "Queued…"
                      : dq[j.id]?.status === "drafting"
                        ? "Drafting…"
                        : dq[j.id]?.status === "failed"
                          ? "Retry draft"
                          : "Draft application"}
                  </button>
                )}
                {dq[j.id]?.status === "failed" && (
                  <div className="text-xs text-rose-400">
                    {(dq[j.id].error || "draft failed").slice(0, 120)}
                  </div>
                )}
                <div className="flex gap-1.5">
                  <button
                    className={smallBtn}
                    onClick={() => setExpanded(expanded === j.id ? null : j.id)}
                  >
                    Why?
                  </button>
                  {j.feedStatus === "dismissed" ? (
                    <button className={smallBtn} onClick={() => setStatus(j.id, "queued")}>
                      Restore
                    </button>
                  ) : (
                    <>
                      {j.feedStatus !== "applied" && (
                        <button
                          className={smallBtn}
                          title="I applied to this outside the app — track it, skip drafting"
                          onClick={() => setStatus(j.id, "applied")}
                        >
                          Applied
                        </button>
                      )}
                      <button
                        className={smallBtnDanger}
                        onClick={() => {
                          setDismissing(dismissing === j.id ? null : j.id);
                          setDismissReason("");
                        }}
                      >
                        Dismiss
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
            {dismissing === j.id && (
              <div className="mt-3 flex gap-2 items-center border-t border-zinc-800 pt-3">
                <input
                  autoFocus
                  className={`${input} flex-1`}
                  placeholder="Why? (optional — teaches the scorer, e.g. “managerial role, needs 8+ yrs, I'm mid-level”)"
                  value={dismissReason}
                  onChange={(e) => setDismissReason(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && setStatus(j.id, "dismissed", dismissReason)}
                />
                <button className={btnDanger} onClick={() => setStatus(j.id, "dismissed", dismissReason)}>
                  {dismissReason.trim() ? "Dismiss & remember" : "Dismiss"}
                </button>
                <button className={btnSecondary} onClick={() => setDismissing(null)}>
                  Cancel
                </button>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
