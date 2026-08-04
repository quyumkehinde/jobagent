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
  roleCategory: string | null;
  feedStatus: string;
  postedAt: string | null;
}

const TABS = [
  { key: "queued", label: "Queued" },
  { key: "new", label: "Below threshold" },
  { key: "flagged", label: "Flagged (country-restricted)" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all", label: "All" },
];

export default function JobsPage() {
  const [tab, setTab] = useState("queued");
  const [q, setQ] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [drafting, setDrafting] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const router = useRouter();

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/jobs?tab=${tab}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    const data = await res.json();
    setJobs(data.jobs || []);
    setLoading(false);
  }, [tab, q]);

  useEffect(() => {
    load();
  }, [load]);

  const setStatus = async (id: number, feedStatus: string) => {
    await fetch(`/api/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedStatus }),
    });
    setJobs((js) => js.filter((j) => j.id !== id));
  };

  const draft = async (id: number) => {
    setDrafting(id);
    const res = await fetch(`/api/jobs/${id}/draft`, { method: "POST" });
    const data = await res.json();
    setDrafting(null);
    if (data.applicationId) router.push(`/applications/${data.applicationId}`);
    else alert(`Draft failed: ${data.error || "unknown error"}`);
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Jobs</h1>
      <div className="flex gap-2 flex-wrap items-center">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
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

      {loading && <div className="text-zinc-500">Loading…</div>}
      {!loading && jobs.length === 0 && <Card className="text-zinc-400">Nothing here.</Card>}

      <div className="space-y-2">
        {jobs.map((j) => (
          <Card key={j.id}>
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <ScoreBadge score={j.score} />
                  {eligibilityBadge(j.eligibility)}
                  {j.visaSignal === "yes" && <Badge tone="green">visa: yes</Badge>}
                  {j.visaSignal === "likely" && <Badge tone="blue">visa: likely</Badge>}
                  {j.roleCategory && <Badge>{j.roleCategory}</Badge>}
                  <Badge>{j.source}</Badge>
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
                </div>
                {expanded === j.id && j.scoreReasons && (
                  <ul className="mt-2 text-sm text-zinc-300 list-disc pl-5">
                    {(JSON.parse(j.scoreReasons) as string[]).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <button className={btnPrimary} onClick={() => draft(j.id)} disabled={drafting !== null}>
                  {drafting === j.id ? "Drafting… (~30s)" : "Draft application"}
                </button>
                <div className="flex gap-2">
                  <button
                    className={btnSecondary}
                    onClick={() => setExpanded(expanded === j.id ? null : j.id)}
                  >
                    Why?
                  </button>
                  {j.feedStatus !== "dismissed" ? (
                    <button className={btnDanger} onClick={() => setStatus(j.id, "dismissed")}>
                      Dismiss
                    </button>
                  ) : (
                    <button className={btnSecondary} onClick={() => setStatus(j.id, "queued")}>
                      Restore
                    </button>
                  )}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
