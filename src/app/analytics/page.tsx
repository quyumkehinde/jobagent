"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui";

interface Analytics {
  stageCounts: { status: string; count: number }[];
  bySource: { source: string; submitted: number; responded: number }[];
  perWeek: { week: string; count: number }[];
  jobStats: { k: string; v: number }[];
}

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  useEffect(() => {
    fetch("/api/analytics").then((r) => r.json()).then(setData);
  }, []);
  if (!data) return <div className="text-zinc-500">Loading…</div>;

  const stat = (k: string) => data.jobStats.find((s) => s.k === k)?.v ?? 0;
  const stage = (s: string) => data.stageCounts.find((x) => x.status === s)?.count ?? 0;
  const submitted = data.stageCounts
    .filter((s) => !["drafting", "ready"].includes(s.status))
    .reduce((sum, s) => sum + s.count, 0);
  const responded = stage("screening") + stage("interviewing") + stage("offer");
  const responseRate = submitted ? Math.round((responded / submitted) * 100) : 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Analytics</h1>

      <div className="grid grid-cols-4 gap-4">
        <Card>
          <div className="text-3xl font-bold">{submitted}</div>
          <div className="text-sm text-zinc-400">applications submitted</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-emerald-400">{responseRate}%</div>
          <div className="text-sm text-zinc-400">response rate</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-sky-400">{stage("interviewing")}</div>
          <div className="text-sm text-zinc-400">interviewing now</div>
        </Card>
        <Card>
          <div className="text-3xl font-bold text-violet-400">{stage("offer")}</div>
          <div className="text-sm text-zinc-400">offers</div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <h2 className="font-semibold mb-3">By source</h2>
          <table className="w-full text-sm">
            <thead className="text-zinc-400 text-left">
              <tr>
                <th className="py-1">Source</th>
                <th>Submitted</th>
                <th>Responses</th>
                <th>Rate</th>
              </tr>
            </thead>
            <tbody>
              {data.bySource.map((s) => (
                <tr key={s.source} className="border-t border-zinc-800">
                  <td className="py-1.5">{s.source}</td>
                  <td>{s.submitted}</td>
                  <td>{s.responded}</td>
                  <td>{s.submitted ? Math.round((s.responded / s.submitted) * 100) : 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <h2 className="font-semibold mb-3">Applications per week</h2>
          <table className="w-full text-sm">
            <tbody>
              {data.perWeek.map((w) => (
                <tr key={w.week} className="border-t border-zinc-800">
                  <td className="py-1.5 text-zinc-400">{w.week}</td>
                  <td className="w-full">
                    <div
                      className="h-3 rounded bg-emerald-600"
                      style={{ width: `${Math.min(100, w.count * 5)}%` }}
                      title={String(w.count)}
                    />
                  </td>
                  <td className="pl-2">{w.count}</td>
                </tr>
              ))}
              {data.perWeek.length === 0 && (
                <tr>
                  <td className="py-2 text-zinc-500">No submissions yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <Card>
          <div className="text-2xl font-bold">{stat("total_jobs")}</div>
          <div className="text-sm text-zinc-400">jobs discovered</div>
        </Card>
        <Card>
          <div className="text-2xl font-bold">{stat("scored")}</div>
          <div className="text-sm text-zinc-400">jobs scored</div>
        </Card>
        <Card>
          <div className="text-2xl font-bold">{stat("flagged_country_restricted")}</div>
          <div className="text-sm text-zinc-400">flagged country-restricted</div>
        </Card>
        <Card>
          <div className="text-2xl font-bold">{stat("active_companies")}</div>
          <div className="text-sm text-zinc-400">company boards polled</div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4">
        <Card>
          <h2 className="font-semibold mb-3">Pipeline stages</h2>
          <div className="flex gap-2 flex-wrap">
            {data.stageCounts.map((s) => (
              <div key={s.status} className="rounded-md bg-zinc-800 px-3 py-2 text-sm">
                <span className="font-bold">{s.count}</span> <span className="text-zinc-400">{s.status}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
