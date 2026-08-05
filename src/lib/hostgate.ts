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

// Politeness is per PLATFORM, not per hostname: {slug}.recruitee.com probes are all
// distinct hosts but one rate limiter. Key on the registrable domain (last two labels).
function gateKey(host: string): string {
  const labels = host.toLowerCase().split(".");
  return labels.slice(-2).join(".");
}

export function hostCoolingDown(host: string): boolean {
  return (coolUntil.get(gateKey(host)) ?? 0) > Date.now();
}

export async function hostGate(host: string): Promise<void> {
  const key = gateKey(host);
  // reserve the next slot BEFORE sleeping, so concurrent callers queue up correctly
  // instead of all sleeping until the same moment and firing together
  const now = Date.now();
  const slot = Math.max(lastHit.get(key) ?? 0, now - MIN_HOST_INTERVAL_MS) + MIN_HOST_INTERVAL_MS;
  lastHit.set(key, slot);
  const wait = slot - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

export interface RateLimitEvent {
  host: string;
  context: string;
  at: string; // ISO
}

export async function reportRateLimit(host: string, context: string, cooldownMs = DEFAULT_COOLDOWN_MS): Promise<void> {
  if (cooldownMs > 0) coolUntil.set(gateKey(host), Date.now() + cooldownMs);
  if (Date.now() - (lastWarned.get(gateKey(host)) ?? 0) > 60_000) {
    lastWarned.set(gateKey(host), Date.now());
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
