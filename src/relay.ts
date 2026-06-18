/**
 * Relay helpers for the pi-c2c extension.
 *
 * The pi-c2c extension is a transparent relay client: on `session_start` it
 * registers with a configured c2c relay (default `https://relay.c2c.im`) so two
 * pi-c2c agents on different machines can find each other and DM.
 *
 * Identity design:
 *
 *   The c2c broker's `canonical_alias` format (`<alias>#<repo-slug>@<host>`)
 *   leaks the project name and the hostname in plaintext. For cross-machine
 *   use we want routing info that is **unique to the host but not reversible**
 *   from the alias string alone.
 *
 *   We compute a `host_hash` from a SINGLE primary source, picked in a
 *   stability-first fallback order:
 *
 *     1. SMBIOS product_uuid (/sys/class/dmi/id/product_uuid) — per-motherboard,
 *        very stable; rare to change; ~128 bits of entropy.
 *     2. systemd machine-id (/etc/machine-id) — per-OS-install; stable across
 *        reboots; regenerated only on reinstall. ~128 bits of entropy.
 *     3. hostname (os.hostname()) — cross-platform fallback; can change if the
 *        user renames the host.
 *
 *   Why one source, not several combined: the routing primitive must be
 *   STABLE — if the hostname changes, the relay alias must NOT change,
 *   because the old alias would orphan. Combining sources amplifies churn:
 *   change any one source and the hash changes. We accept lower entropy in
 *   exchange for stability.
 *
 *   product_uuid alone is ~128 bits (16 random bytes from the SMBIOS spec);
 *   collision probability at 1M hosts is ~10⁻²⁴. Sufficient.
 *
 *   The relay address format becomes `<name>@<host_hash>` — opaque to outsiders
 *   but the extension can reverse it locally (it knows the inputs).
 *
 * Configuration env vars:
 *   C2C_PI_RELAY=1          — opt-out flag (default on)
 *   C2C_PI_RELAY_URL        — override relay URL (default c2c's resolution)
 *   C2C_PI_RELAY_TTL=3600   — reserved for a future heartbeat slice
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";

/** Read a file as UTF-8 string, or undefined if it can't be read. */
function tryReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Minimal fs interface so callers (and tests) can inject a fake. */
export interface FsLike {
  readFile(path: string): string | undefined;
}

/** Minimal net interface so callers (and tests) can inject a fake. */
export interface NetLike {
  hostname(): string;
}

/**
 * Pick the most-stable available host-unique source. Returns the source
 * value (already trimmed) or undefined if nothing is available. Sources are
 * tried in stability order (most stable first):
 *
 *   1. product_uuid (per-motherboard, ~stable)
 *   2. machine-id (per-OS-install, ~stable)
 *   3. hostname (cross-platform fallback, less stable)
 */
export function pickHostSource(
  fs: FsLike = { readFile: tryReadFile },
  net: NetLike = { hostname: () => osHostname() },
): { value: string; kind: "product_uuid" | "machine_id" | "hostname" } | undefined {
  const productUuid = (fs.readFile("/sys/class/dmi/id/product_uuid") ?? "").trim();
  if (productUuid) return { value: productUuid, kind: "product_uuid" };
  const machineId = (fs.readFile("/etc/machine-id") ?? "").trim();
  if (machineId) return { value: machineId, kind: "machine_id" };
  const host = (net.hostname() ?? "").trim();
  if (host) return { value: host, kind: "hostname" };
  return undefined;
}

/**
 * Compute a 12-hex-char host hash from the most-stable available source.
 * Returns the string "000000000000" (an obviously invalid value) when no
 * source is available, so callers can detect "no host identity" without
 * throwing.
 *
 * The hash is NOT reversible from the output alone: an attacker would need
 * to enumerate plausible source values and try them. For a SMBIOS UUID
 * (~128 bits) that's infeasible.
 */
export function computeHostHash(
  fs?: FsLike,
  net?: NetLike,
): string {
  const picked = pickHostSource(fs, net);
  if (!picked) return "000000000000";
  // Salt with the source kind so a 0-byte hostname doesn't collide with a
  // 0-byte machine-id, etc. Trivial disambiguation.
  return createHash("sha256")
    .update(`${picked.kind}=${picked.value}`)
    .digest("hex")
    .slice(0, 12);
}

/**
 * Build the relay-facing address. Format: `<name>@<host_hash>`.
 *
 *   - `name` is the bare alias (e.g. `pi-c01ea5`)
 *   - `host_hash` is the 12-hex hash from `computeHostHash`
 *
 * The host_hash is the routing primitive: it uniquely identifies the host
 * without leaking the hostname or username. Two pi-c2c agents on the same
 * host would share the host_hash; on different hosts, different.
 */
export function deriveRelayAlias(name: string, hostHash: string): string {
  // Reject inputs that could break the alias syntax. The c2c broker
  // requires alias characters from [A-Za-z0-9._-]. A 12-hex host hash
  // is already valid; the bare alias from `resolveAlias` is also valid.
  // Defensive check: anything else would get rejected at register time.
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`deriveRelayAlias: invalid name '${name}' (must match [A-Za-z0-9._-])`);
  }
  if (!/^[0-9a-f]{12}$/.test(hostHash)) {
    throw new Error(`deriveRelayAlias: invalid hostHash '${hostHash}' (must be 12 hex chars)`);
  }
  return `${name}@${hostHash}`;
}

/**
 * Parse a relay-facing alias into its (name, host_hash) parts. Used by the
 * extension to display peer info cleanly and to dedup across the relay vs
 * per-repo views.
 */
export function parseRelayAlias(alias: string): { name: string; hostHash: string } | null {
  const i = alias.indexOf("@");
  if (i < 0) return null;
  const name = alias.slice(0, i);
  const hostHash = alias.slice(i + 1);
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (!/^[0-9a-f]{12}$/.test(hostHash)) return null;
  return { name, hostHash };
}
