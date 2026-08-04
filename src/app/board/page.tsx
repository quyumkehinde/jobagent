"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui";

interface App {
  id: number;
  status: string;
  method: string;
  submittedAt: string | null;
  nextActionAt: string | null;
  job?: { id: number; title: string; companyName: string; source: string };
}

const COLUMNS: { key: string; label: string }[] = [
  { key: "ready", label: "Ready to review" },
  { key: "submitted", label: "Applied" },
  { key: "screening", label: "Screening" },
  { key: "interviewing", label: "Interviewing" },
  { key: "offer", label: "Offer 🎉" },
  { key: "rejected", label: "Rejected" },
  { key: "ghosted", label: "Ghosted" },
];

export default function Board() {
  const [apps, setApps] = useState<App[]>([]);
  const [dragId, setDragId] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/applications");
    const data = await res.json();
    setApps(data.applications || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const moveTo = async (id: number, status: string) => {
    setApps((as) => as.map((a) => (a.id === id ? { ...a, status } : a)));
    await fetch(`/api/applications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Pipeline</h1>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {COLUMNS.map((col) => {
          const colApps = apps.filter((a) => a.status === col.key);
          return (
            <div
              key={col.key}
              className="w-64 shrink-0"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dragId != null && moveTo(dragId, col.key)}
            >
              <div className="text-sm font-semibold text-zinc-400 mb-2 px-1">
                {col.label} <span className="text-zinc-600">({colApps.length})</span>
              </div>
              <div className="space-y-2 min-h-24 rounded-lg bg-zinc-900/40 p-2">
                {colApps.map((a) => (
                  <div key={a.id} draggable onDragStart={() => setDragId(a.id)} onDragEnd={() => setDragId(null)}>
                    <Card className="!p-3 cursor-grab active:cursor-grabbing hover:border-zinc-600">
                      <Link href={`/applications/${a.id}`} className="block">
                        <div className="text-sm font-medium leading-tight">{a.job?.title}</div>
                        <div className="text-xs text-zinc-400 mt-1">{a.job?.companyName}</div>
                        {a.nextActionAt && new Date(a.nextActionAt) <= new Date() && (
                          <div className="text-xs text-amber-400 mt-1">⏰ follow-up due</div>
                        )}
                      </Link>
                    </Card>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-zinc-500">Drag cards between columns to update status.</p>
    </div>
  );
}
