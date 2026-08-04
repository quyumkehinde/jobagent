// Tiny console logger shared by the worker and API routes. Lines are logfmt-ish so they
// stay greppable: 2026-08-04T12:00:00.000Z INFO [pipeline] ats sweep done boards=118 found=3402 ms=41250
type Fields = Record<string, unknown>;

function fmtFields(fields?: Fields): string {
  if (!fields) return "";
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => {
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `${k}=${/\s/.test(s) ? JSON.stringify(s) : s}`;
    });
  return parts.length ? " " + parts.join(" ") : "";
}

function line(level: string, scope: string, msg: string, fields?: Fields): string {
  return `${new Date().toISOString()} ${level} [${scope}] ${msg}${fmtFields(fields)}`;
}

export interface Logger {
  info: (msg: string, fields?: Fields) => void;
  warn: (msg: string, fields?: Fields) => void;
  error: (msg: string, fields?: Fields) => void;
}

export function createLogger(scope: string): Logger {
  return {
    info: (msg, fields) => console.log(line("INFO", scope, msg, fields)),
    warn: (msg, fields) => console.warn(line("WARN", scope, msg, fields)),
    error: (msg, fields) => console.error(line("ERROR", scope, msg, fields)),
  };
}

// Shorthand for durations: const t = startTimer(); ... log.info("done", { ms: t() })
export function startTimer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}
