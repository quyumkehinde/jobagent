"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Badge, ScoreBadge, btnPrimary, btnSecondary } from "@/components/ui";

interface Job {
  id: number;
  title: string;
  companyName: string;
  score: number | null;
}
interface App {
  id: number;
  status: string;
  nextActionAt: string | null;
  nextActionNote: string | null;
  job?: Job;
}
interface Run {
  id: number;
  source: string;
  startedAt: string;
  finishedAt: string | null;
  found: number;
  added: number;
  error: string | null;
}

export default function Today() {
  const [ready, setReady] = useState<App[]>([]);
  const [active, setActive] = useState<App[]>([]);
  const [queued, setQueued] = useState<Job[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [r1, r2, r3, r4] = await Promise.all([
      fetch("/api/applications?status=ready").then((r) => r.json()),
      fetch("/api/applications?status=submitted,screening,interviewing").then((r) => r.json()),
      fetch("/api/jobs?tab=queued").then((r) => r.json()),
      fetch("/api/pipeline").then((r) => r.json()),
    ]);
    setReady(r1.applications || []);
    setActive(r2.applications || []);
    setQueued(r3.jobs || []);
    setRuns(r4.runs || []);
    setRunning(r4.running);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const runNow = async () => {
    setBusy(true);
    await fetch("/api/pipeline", { method: "POST" });
    setRunning(true);
    setBusy(false);
  };

  const dueActions = active.filter((a) => a.nextActionAt && new Date(a.nextActionAt) <= new Date());

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Today</h1>
        <button className={btnPrimary} onClick={runNow} disabled={busy || running}>
          {running ? "Pipeline running…" : "Scrape & score now"}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <div className="text-3xl font-bold text-emerald-400">{ready.length}</div>
          <div className="text-sm text-zinc-400">applications ready for review</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-sky-400">{queued.length}</div>
          <div className="text-sm text-zinc-400">matched jobs in the queue</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-amber-400">{dueActions.length}</div>
          <div className="text-sm text-zinc-400">follow-ups due</div>
        </Card>
      </div>

      {ready.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-2">Review & submit</h2>
          <div className="space-y-2">
            {ready.map((a) => (
              <Card key={a.id} className="flex items-center justify-between">
                <div>
                  <div className="font-medium">{a.job?.title}</div>
                  <div className="text-sm text-zinc-400">{a.job?.companyName}</div>
                </div>
                <Link href={`/applications/${a.id}`} className={btnPrimary}>
                  Review →
                </Link>
              </Card>
            ))}
          </div>
        </section>
      )}

      {dueActions.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold mb-2">Follow-ups due</h2>
          <div className="space-y-2">
            {dueActions.map((a) => (
              <Card key={a.id} className="flex items-center justify-between">
                <div>
                  <div className="font-medium">
                    {a.job?.title} <span className="text-zinc-400">· {a.job?.companyName}</span>
                  </div>
                  <div className="text-sm text-amber-300">{a.nextActionNote || "Follow up"}</div>
                </div>
                <Link href={`/applications/${a.id}`} className={btnSecondary}>
                  Open
                </Link>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="text-lg font-semibold mb-2">Top of the queue</h2>
        <div className="space-y-2">
          {queued.slice(0, 8).map((j) => (
            <Card key={j.id} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <ScoreBadge score={j.score} />
                <div>
                  <div className="font-medium">{j.title}</div>
                  <div className="text-sm text-zinc-400">{j.companyName}</div>
                </div>
              </div>
              <Link href="/jobs" className={btnSecondary}>
                View in feed
              </Link>
            </Card>
          ))}
          {queued.length === 0 && (
            <Card className="text-zinc-400 text-sm">
              No matched jobs yet. Set up your{" "}
              <Link href="/profile" className="text-emerald-400 underline">
                profile
              </Link>
              , add your Gemini key in{" "}
              <Link href="/settings" className="text-emerald-400 underline">
                settings
              </Link>
              , then hit “Scrape & score now”.
            </Card>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">Recent scrape runs</h2>
        <Card>
          <table className="w-full text-sm">
            <thead className="text-zinc-400 text-left">
              <tr>
                <th className="py-1">Source</th>
                <th>Found</th>
                <th>New</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800">
                  <td className="py-1.5">{r.source}</td>
                  <td>{r.found}</td>
                  <td>{r.added}</td>
                  <td>
                    {r.error ? (
                      <Badge tone="red">error</Badge>
                    ) : r.finishedAt ? (
                      <Badge tone="green">ok</Badge>
                    ) : (
                      <Badge tone="yellow">running</Badge>
                    )}
                  </td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-2 text-zinc-500">
                    No runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  );
}
