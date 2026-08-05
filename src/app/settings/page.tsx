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
  closeAfterDays: number;
  geminiMinIntervalMs: number;
}
interface Company {
  id: number;
  name: string;
  ats: string | null;
  token: string | null;
  active: boolean;
  origin: string;
  country: string | null;
  visaSponsor: boolean | null;
  resolveStatus: string | null;
  resolveNote: string | null;
  careersUrl: string | null;
  lastError: string | null;
}
interface Counts {
  all: number;
  pending: number;
  unresolved: number;
  resolved: number;
  inactive: number;
}

const ATS_OPTIONS = [
  "greenhouse",
  "lever",
  "ashby",
  "recruitee",
  "workable",
  "personio",
  "smartrecruiters",
  "breezy",
  "bamboohr",
];

const PAGE_SIZE = 50;

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [total, setTotal] = useState(0);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [saved, setSaved] = useState(false);
  const [newCo, setNewCo] = useState({ name: "", ats: "greenhouse", token: "" });

  const loadSettings = useCallback(async () => {
    const s = await fetch("/api/settings").then((r) => r.json());
    setSettings(s.settings);
  }, []);

  const loadCompanies = useCallback(async () => {
    const params = new URLSearchParams({
      status: tab,
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
    });
    if (search) params.set("q", search);
    const c = await fetch(`/api/companies?${params}`).then((r) => r.json());
    setCompanies(c.companies || []);
    setCounts(c.counts || null);
    setTotal(c.total || 0);
  }, [tab, search, page]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);
  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  // while an import is resolving, keep the counts moving
  useEffect(() => {
    if (!counts?.pending) return;
    const t = setInterval(loadCompanies, 15000);
    return () => clearInterval(t);
  }, [counts?.pending, loadCompanies]);

  if (!settings) return <div className="text-zinc-500">Loading…</div>;

  const save = async (fields: Partial<Settings>) => {
    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
    loadSettings();
  };

  const patchCompany = async (id: number, fields: Record<string, unknown>) => {
    await fetch("/api/companies", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...fields }),
    });
    loadCompanies();
  };

  const numField = (label: string, key: keyof Settings, hint?: string) => (
    <label className="block">
      <span className="text-sm text-zinc-400">{label}</span>
      <input
        type="number"
        className={`${input} mt-1`}
        defaultValue={settings[key] as number}
        onBlur={(e) => save({ [key]: Number(e.target.value) } as Partial<Settings>)}
      />
      {hint && <span className="text-xs text-zinc-600">{hint}</span>}
    </label>
  );

  return (
    <div className="space-y-6 max-w-4xl">
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
          {numField("Queue threshold (score ≥)", "queueThreshold")}
          {numField("Max queued per company", "maxQueuedPerCompany")}
          {numField("Scrape every (hours)", "scrapeIntervalHours")}
          {numField("Max jobs scored per run", "maxScoringPerRun")}
          {numField("Close unseen jobs after (days)", "closeAfterDays")}
          {numField("Gemini call gap (ms)", "geminiMinIntervalMs", "6500 = free tier · ~500 on paid")}
        </div>
        <p className="text-xs text-zinc-500">
          Free-tier Gemini has daily request caps — if you hit them, unscored jobs simply wait for the next run.
          Scoring prioritizes visa-sponsor companies and newest jobs first.
        </p>
      </Card>

      <ImportCard counts={counts} onImported={loadCompanies} />

      <Card>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="font-semibold">
            Company boards <span className="text-zinc-500 text-sm">({total})</span>
          </h2>
          <input
            className={`${input} !w-56`}
            placeholder="Search name or token…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </div>
        <div className="flex gap-1.5 mb-3 flex-wrap">
          {(
            [
              ["all", `All ${counts?.all ?? ""}`],
              ["resolved", `Resolved ${counts?.resolved ?? ""}`],
              ["pending", `Pending ${counts?.pending ?? ""}`],
              ["unresolved", `Unresolved ${counts?.unresolved ?? ""}`],
              ["inactive", `Inactive ${counts?.inactive ?? ""}`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={`px-2.5 py-1 rounded-md text-sm ${tab === key ? "bg-emerald-700 text-white" : "bg-zinc-800 text-zinc-300"}`}
              onClick={() => {
                setTab(key);
                setPage(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="flex gap-2 mb-4">
          <input
            className={`${input} !w-40`}
            placeholder="Company name"
            value={newCo.name}
            onChange={(e) => setNewCo({ ...newCo, name: e.target.value })}
          />
          <select className={`${input} !w-40`} value={newCo.ats} onChange={(e) => setNewCo({ ...newCo, ats: e.target.value })}>
            {ATS_OPTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
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
              loadCompanies();
            }}
          >
            Add
          </button>
        </div>

        <div className="space-y-1">
          {companies.map((c) => (
            <CompanyRow key={c.id} company={c} onPatch={patchCompany} />
          ))}
          {!companies.length && <div className="text-sm text-zinc-500 py-4">No companies match.</div>}
        </div>

        {total > PAGE_SIZE && (
          <div className="flex items-center gap-3 mt-3 text-sm">
            <button className={btnSecondary} disabled={page === 0} onClick={() => setPage(page - 1)}>
              ← Prev
            </button>
            <span className="text-zinc-400">
              {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
            </span>
            <button className={btnSecondary} disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>
              Next →
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

function ImportCard({ counts, onImported }: { counts: Counts | null; onImported: () => void }) {
  const [text, setText] = useState("");
  const [visaSponsor, setVisaSponsor] = useState(true);
  const [country, setCountry] = useState("NL");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const doImport = async () => {
    setBusy(true);
    setResult(null);
    const res = await fetch("/api/companies/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, defaults: { visaSponsor, country: country || undefined } }),
    });
    const data = await res.json();
    setBusy(false);
    if (data.error) setResult(`Error: ${data.error}`);
    else {
      setResult(
        `Imported: ${data.added} new, ${data.updatedExisting} already known (flags updated), ${data.skipped} skipped. ` +
          `Resolution runs at the start of each pipeline run — trigger one from the Today page or wait for the worker.`
      );
      setText("");
      onImported();
    }
  };

  return (
    <Card className="space-y-3">
      <h2 className="font-semibold">Bulk import companies</h2>
      <p className="text-sm text-zinc-400">
        Paste company names (one per line, e.g. the IND register of recognised sponsors — or CSV lines{" "}
        <code className="text-zinc-500">name,country,visaSponsor</code>). The pipeline then probes 9 ATS platforms and
        the web to find each company&apos;s job board automatically.
      </p>
      <textarea
        className={`${input} min-h-28 font-mono text-xs`}
        placeholder={"Adyen N.V.\nPicnic Technologies B.V.\nSendcloud B.V."}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-1.5 text-sm text-zinc-300">
          <input type="checkbox" checked={visaSponsor} onChange={(e) => setVisaSponsor(e.target.checked)} />
          these companies sponsor visas
        </label>
        <label className="flex items-center gap-1.5 text-sm text-zinc-300">
          Country
          <input className={`${input} !w-16`} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
        </label>
        <button className={btnPrimary} disabled={busy || !text.trim()} onClick={doImport}>
          {busy ? "Importing…" : "Import"}
        </button>
      </div>
      {result && <p className="text-sm text-emerald-300">{result}</p>}
      {counts && (counts.pending > 0 || counts.unresolved > 0) && (
        <p className="text-sm text-zinc-400">
          Resolution: <Badge tone="yellow">{counts.pending} pending</Badge>{" "}
          <Badge tone="green">{counts.resolved} resolved</Badge>{" "}
          <Badge tone="red">{counts.unresolved} unresolved</Badge>
          {counts.pending > 0 && <span className="text-zinc-500"> — refreshing every 15s</span>}
        </p>
      )}
    </Card>
  );
}

function CompanyRow({
  company: c,
  onPatch,
}: {
  company: Company;
  onPatch: (id: number, fields: Record<string, unknown>) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fix, setFix] = useState({ ats: c.ats || "greenhouse", token: c.token || "", careersUrl: c.careersUrl || "" });

  const statusBadge = () => {
    if (!c.active) return <Badge tone="red">{c.lastError ? "error" : "off"}</Badge>;
    switch (c.resolveStatus) {
      case "pending":
      case "probing":
        return <Badge tone="yellow">{c.resolveStatus}</Badge>;
      case "unresolved":
        return <Badge tone="red">unresolved</Badge>;
      default:
        return <Badge tone="green">active</Badge>;
    }
  };

  return (
    <div className="border-t border-zinc-800 py-1.5 text-sm">
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <span className="truncate">{c.name}</span> {c.visaSponsor && <Badge tone="green">visa</Badge>}{" "}
          {c.country && <span className="text-xs text-zinc-500">{c.country}</span>}
        </div>
        <span className="text-zinc-400 w-52 truncate">{c.ats ? `${c.ats}/${c.token}` : "—"}</span>
        <Badge>{c.origin}</Badge>
        {statusBadge()}
        <button className="text-xs text-zinc-400 hover:text-white" onClick={() => setExpanded(!expanded)}>
          {expanded ? "▲" : "▼"}
        </button>
      </div>
      {expanded && (
        <div className="mt-2 ml-1 space-y-2 text-xs text-zinc-400">
          {c.resolveNote && <div>note: {c.resolveNote}</div>}
          {c.lastError && <div className="text-red-400">last error: {c.lastError}</div>}
          {c.careersUrl && (
            <div>
              careers:{" "}
              <a href={c.careersUrl} target="_blank" rel="noreferrer" className="text-emerald-400 underline">
                {c.careersUrl}
              </a>
            </div>
          )}
          <div className="flex gap-2 items-center flex-wrap">
            <select className={`${input} !w-36`} value={fix.ats} onChange={(e) => setFix({ ...fix, ats: e.target.value })}>
              {ATS_OPTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <input
              className={`${input} !w-36`}
              placeholder="token/slug"
              value={fix.token}
              onChange={(e) => setFix({ ...fix, token: e.target.value })}
            />
            <button
              className={btnSecondary}
              disabled={!fix.token}
              onClick={() => onPatch(c.id, { ats: fix.ats, token: fix.token })}
            >
              Set board
            </button>
            <input
              className={`${input} !w-56`}
              placeholder="careers URL"
              value={fix.careersUrl}
              onChange={(e) => setFix({ ...fix, careersUrl: e.target.value })}
            />
            <button className={btnSecondary} onClick={() => onPatch(c.id, { careersUrl: fix.careersUrl })}>
              Save URL
            </button>
            <button className={btnSecondary} onClick={() => onPatch(c.id, { retryResolve: true })}>
              Retry resolve
            </button>
            <button className={btnSecondary} onClick={() => onPatch(c.id, { active: !c.active })}>
              {c.active ? "Disable" : "Enable"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
