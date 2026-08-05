import { getSetting, setSetting } from "./settings";
import { createLogger } from "./log";

const log = createLogger("ratelimit");

// Per-host politeness + 429 handling for everything that talks to external APIs.
// - hostGate(host): enforces a minimum spacing between requests to the same host
// - reportRateLimit(host): logs it, records it for the dashboard, and puts the host in
//   a cooldown so we stop hammering a limiter that has already tripped
// - hostCoolingDown(host): callers skip (and defer their work) instead of burning requests

const MIN_HOST_INTERVAL_MS = 400;
const DEFAULT_COOLDOWN_MS = 10 * 60_000;

const lastHit = new Map<string, number>();
const coolUntil = new Map<string, number>();
const lastWarned = new Map<string, number>();

export function hostCoolingDown(host: string): boolean {
  return (coolUntil.get(host) ?? 0) > Date.now();
}

export async function hostGate(host: string): Promise<void> {
  const wait = (lastHit.get(host) ?? 0) + MIN_HOST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

export interface RateLimitEvent {
  host: string;
  context: string;
  at: string; // ISO
}

export async function reportRateLimit(host: string, context: string, cooldownMs = DEFAULT_COOLDOWN_MS): Promise<void> {
  if (cooldownMs > 0) coolUntil.set(host, Date.now() + cooldownMs);
  if (Date.now() - (lastWarned.get(host) ?? 0) > 60_000) {
    lastWarned.set(host, Date.now());
    log.warn("rate limited — backing off", { host, context, cooldownMin: Math.round(cooldownMs / 60_000) });
  }
  try {
    const events = await getSetting<RateLimitEvent[]>("rateLimitEvents", []);
    events.push({ host, context, at: new Date().toISOString() });
    await setSetting("rateLimitEvents", events.slice(-50));
  } catch {
    // observability must never break the pipeline
  }
}

export async function getRateLimitEvents(): Promise<RateLimitEvent[]> {
  return getSetting<RateLimitEvent[]>("rateLimitEvents", []);
}
