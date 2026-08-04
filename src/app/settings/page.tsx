"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Badge, btnPrimary, btnSecondary, input } from "@/components/ui";

interface Settings {
  geminiApiKey: string;
  geminiKeyFromEnv: boolean;
  scoringModel: string;
  writerModel: string;
  queueThreshold: number;
  maxQueuedPerCompany: number;
  scrapeIntervalHours: number;
  maxScoringPerRun: number;
}
interface Company {
  id: number;
  name: string;
  ats: string;
  token: string;
  active: boolean;
  origin: string;
  visaSponsor: boolean | null;
  lastError: string | null;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [saved, setSaved] = useState(false);
  const [newCo, setNewCo] = useState({ name: "", ats: "greenhouse", token: "" });
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/companies").then((r) => r.json()),
    ]);
    setSettings(s.settings);
    setCompanies(c.companies || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (!settings) return <div className="text-zinc-500">Loading…</div>;

  const save = async (fields: Partial<Settings>) => {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
    load();
  };

  const patchCompany = async (id: number, fields: Record<string, unknown>) => {
    await fetch("/api/companies", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...fields }),
    });
    load();
  };

  const visible = companies.filter((c) => showInactive || c.active);

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Settings</h1>
        {saved && <Badge tone="green">saved ✓</Badge>}
      </div>

      <Card className="space-y-3">
        <h2 className="font-semibold">Gemini API</h2>
        {settings.geminiKeyFromEnv ? (
          <p className="text-sm text-emerald-400">Using GEMINI_API_KEY from environment (.env.local).</p>
        ) : (
          <label className="block">
            <span className="text-sm text-zinc-400">API key</span>
            <input
              className={`${input} mt-1`}
              type="password"
              defaultValue={settings.geminiApiKey}
              placeholder="AIza…"
              onBlur={(e) => e.target.value && save({ geminiApiKey: e.target.value })}
            />
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-sm text-zinc-400">Scoring model (bulk, cheap)</span>
            <input
              className={`${input} mt-1`}
              defaultValue={settings.scoringModel}
              onBlur={(e) => save({ scoringModel: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">Writer model (answers, cover letters)</span>
            <input
              className={`${input} mt-1`}
              defaultValue={settings.writerModel}
              onBlur={(e) => save({ writerModel: e.target.value })}
            />
          </label>
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Matching & cadence</h2>
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="text-sm text-zinc-400">Queue threshold (score ≥)</span>
            <input
              type="number"
              className={`${input} mt-1`}
              defaultValue={settings.queueThreshold}
              onBlur={(e) => save({ queueThreshold: Number(e.target.value) })}
            />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">Max queued per company</span>
            <input
              type="number"
              className={`${input} mt-1`}
              defaultValue={settings.maxQueuedPerCompany}
              onBlur={(e) => save({ maxQueuedPerCompany: Number(e.target.value) })}
            />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">Scrape every (hours)</span>
            <input
              type="number"
              className={`${input} mt-1`}
              defaultValue={settings.scrapeIntervalHours}
              onBlur={(e) => save({ scrapeIntervalHours: Number(e.target.value) })}
            />
          </label>
          <label className="block">
            <span className="text-sm text-zinc-400">Max jobs scored per run</span>
            <input
              type="number"
              className={`${input} mt-1`}
              defaultValue={settings.maxScoringPerRun}
              onBlur={(e) => save({ maxScoringPerRun: Number(e.target.value) })}
            />
          </label>
        </div>
        <p className="text-xs text-zinc-500">
          Free-tier Gemini has daily request caps — if you hit them, unscored jobs simply wait for the next run.
        </p>
      </Card>

      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">
            Company boards <span className="text-zinc-500 text-sm">({visible.length})</span>
          </h2>
          <label className="text-sm text-zinc-400 flex items-center gap-1.5">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            show inactive
          </label>
        </div>
        <div className="flex gap-2 mb-4">
          <input
            className={`${input} !w-40`}
            placeholder="Company name"
            value={newCo.name}
            onChange={(e) => setNewCo({ ...newCo, name: e.target.value })}
          />
          <select className={`${input} !w-36`} value={newCo.ats} onChange={(e) => setNewCo({ ...newCo, ats: e.target.value })}>
            <option value="greenhouse">Greenhouse</option>
            <option value="lever">Lever</option>
            <option value="ashby">Ashby</option>
          </select>
          <input
            className={`${input} !w-40`}
            placeholder="board token/slug"
            value={newCo.token}
            onChange={(e) => setNewCo({ ...newCo, token: e.target.value })}
          />
          <button
            className={btnPrimary}
            disabled={!newCo.name || !newCo.token}
            onClick={async () => {
              await fetch("/api/companies", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(newCo),
              });
              setNewCo({ name: "", ats: "greenhouse", token: "" });
              load();
            }}
          >
            Add
          </button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-zinc-400 text-left sticky top-0 bg-zinc-900">
              <tr>
                <th className="py-1">Company</th>
                <th>ATS</th>
                <th>Origin</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((c) => (
                <tr key={c.id} className="border-t border-zinc-800">
                  <td className="py-1.5">
                    {c.name} {c.visaSponsor && <Badge tone="green">visa</Badge>}
                  </td>
                  <td className="text-zinc-400">
                    {c.ats}/{c.token}
                  </td>
                  <td>
                    <Badge>{c.origin}</Badge>
                  </td>
                  <td>
                    {c.active ? (
                      <Badge tone="green">active</Badge>
                    ) : (
                      <Badge tone="red" >{c.lastError ? "error" : "off"}</Badge>
                    )}
                  </td>
                  <td className="text-right">
                    <button className={btnSecondary} onClick={() => patchCompany(c.id, { active: !c.active })}>
                      {c.active ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
