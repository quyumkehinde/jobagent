import { db, tables } from "@/db";
import { and, eq, lt } from "drizzle-orm";
import { createLogger } from "./log";

const log = createLogger("lock");

// A holder that misses heartbeats for this long is presumed dead; its lock can be stolen.
// Heartbeats fire every minute, so this allows ~5 missed beats before takeover.
const STALE_MS = 5 * 60_000;

// Unique per process lifetime, so release/heartbeat can never touch another process's lock.
const OWNER = `pid:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;

// True if we now hold the lock. SQLite serializes writers, so the insert-or-steal
// pair is atomic across processes: exactly one caller wins.
export async function acquireLock(name: string): Promise<boolean> {
  const now = new Date();
  try {
    await db.insert(tables.locks).values({ name, owner: OWNER, acquiredAt: now, heartbeatAt: now });
    return true;
  } catch {
    // row exists — take it over only if the current holder's heartbeat has gone stale
    const stolen = await db
      .update(tables.locks)
      .set({ owner: OWNER, acquiredAt: now, heartbeatAt: now })
      .where(and(eq(tables.locks.name, name), lt(tables.locks.heartbeatAt, new Date(Date.now() - STALE_MS))))
      .returning({ name: tables.locks.name });
    if (stolen.length) {
      log.warn("took over stale lock (previous holder presumed dead)", { name });
      return true;
    }
    return false;
  }
}

export async function heartbeatLock(name: string): Promise<void> {
  await db
    .update(tables.locks)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(tables.locks.name, name), eq(tables.locks.owner, OWNER)));
}

export async function releaseLock(name: string): Promise<void> {
  await db.delete(tables.locks).where(and(eq(tables.locks.name, name), eq(tables.locks.owner, OWNER)));
}

// Held by ANY live process (fresh heartbeat), including this one.
export async function isLockHeld(name: string): Promise<boolean> {
  const row = await db.query.locks.findFirst({ where: eq(tables.locks.name, name) });
  return !!row && row.heartbeatAt.getTime() > Date.now() - STALE_MS;
}
