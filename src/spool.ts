/**
 * On-disk spool for at-least-once auto-delivery.
 *
 * `c2c poll-inbox` DRAINS the broker inbox (destructive). If pi.sendMessage
 * then fails — the runtime went stale during a reload, or the process died
 * between drain and inject — the drained messages would be gone from the
 * broker yet never reach the transcript. To avoid that loss the poller writes
 * drained-but-undelivered messages to a spool file, injects, and only clears
 * the spool once injection succeeds. On the next tick / next session start the
 * spool is replayed first. (Mirrors the c2c OpenCode plugin's spool.)
 *
 * Trade-off: across a process restart the in-memory dedup is empty, so a
 * spooled message could be delivered twice. At-least-once is the right bias
 * for a messaging layer — losing a peer's message is worse than a rare repeat.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { C2cMessage } from "./c2c-cli.ts";

/** Sanitize a session id into a safe single-path-segment filename. */
function safeName(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
  return `${cleaned || "default"}.spool.json`;
}

export function spoolPath(dir: string, sessionId: string): string {
  return path.join(dir, safeName(sessionId));
}

/** Read spooled (undelivered) messages. Returns [] on any error/missing file. */
export function readSpool(dir: string, sessionId: string): C2cMessage[] {
  try {
    const raw = fs.readFileSync(spoolPath(dir, sessionId), "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data.filter(
      (m): m is C2cMessage =>
        !!m && typeof m === "object" && typeof m.from_alias === "string" && typeof m.content === "string",
    );
  } catch {
    return [];
  }
}

/** Overwrite the spool with `msgs` (atomic via temp-file rename). Best-effort. */
export function writeSpool(dir: string, sessionId: string, msgs: C2cMessage[]): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = spoolPath(dir, sessionId);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(msgs), "utf-8");
    fs.renameSync(tmp, target);
  } catch {
    // Best-effort: a spool write failure must never crash delivery.
  }
}

/** Remove the spool file (after a confirmed-successful injection). */
export function clearSpool(dir: string, sessionId: string): void {
  try {
    fs.unlinkSync(spoolPath(dir, sessionId));
  } catch {
    // Already absent — fine.
  }
}
