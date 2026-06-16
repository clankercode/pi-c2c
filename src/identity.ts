/**
 * c2c identity for a pi session.
 *
 * A pi session self-registers with the c2c broker on startup — no `c2c start`
 * supervisor is involved. We need two things:
 *
 *   - a c2c **session id**: an opaque key the broker uses to route the inbox.
 *     We derive it from pi's own session id, namespaced `pi-` so pi sessions
 *     are identifiable in `c2c list`.
 *   - an **alias**: the human-facing peer name. The live swarm uses word-pair
 *     aliases (e.g. `lyra-quill`) assigned by the supervisor with collision
 *     avoidance. Since we self-register, we default to a deterministic
 *     `pi-<hash>` alias which is collision-safe and recognizable. An operator
 *     can override it via `C2C_PI_ALIAS`.
 */

import { createHash } from "node:crypto";
import type { C2cCli, C2cWhoami } from "./c2c-cli.ts";

const SESSION_PREFIX = "pi-";
const ALIAS_PREFIX = "pi-";
const ALIAS_HASH_LEN = 6;

/** Strip an alias to broker-safe characters. Empty if nothing survives. */
export function sanitizeAlias(raw: string): string {
  return raw
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64);
}

/**
 * Derive a stable c2c session id from pi's session id. When pi gives us no
 * session id (rare; non-TUI modes), fall back to a caller-supplied value so
 * the result is deterministic and testable.
 */
export function deriveSessionId(piSessionId: string | null | undefined, fallback = "default"): string {
  const base = (piSessionId ?? "").trim() || fallback;
  return base.startsWith(SESSION_PREFIX) ? base : `${SESSION_PREFIX}${base}`;
}

/**
 * Resolve the alias to register. Priority:
 *   1. an explicitly configured alias (sanitized), if non-empty;
 *   2. a deterministic `pi-<hash>` derived from the session id.
 */
export function resolveAlias(opts: { configured?: string | null; sessionId: string }): string {
  const configured = opts.configured ? sanitizeAlias(opts.configured) : "";
  if (configured) return configured;
  const hash = createHash("sha256").update(opts.sessionId).digest("hex").slice(0, ALIAS_HASH_LEN);
  return `${ALIAS_PREFIX}${hash}`;
}

export interface IdentityInputs {
  /** pi's session id (ctx.sessionManager.getSessionId()). */
  piSessionId: string | null | undefined;
  /** Operator override (C2C_PI_ALIAS). */
  configuredAlias?: string | null;
  /** Fallback session base when pi has no session id. */
  fallbackSessionId?: string;
  /**
   * Ambient C2C_MCP_SESSION_ID, if already set in the environment (e.g. a
   * future `c2c start pi` supervisor). When present and non-empty it is used
   * verbatim as the session id — no `pi-` prefix — so the extension binds to
   * the session the host already established instead of inventing a new one.
   */
  sessionIdEnv?: string | null;
}

export interface Identity {
  alias: string;
  sessionId: string;
}

/** Compute the identity (pure) without touching the broker. */
export function computeIdentity(inputs: IdentityInputs): Identity {
  const ambient = inputs.sessionIdEnv?.trim();
  const sessionId = ambient ? ambient : deriveSessionId(inputs.piSessionId, inputs.fallbackSessionId);
  const alias = resolveAlias({ configured: inputs.configuredAlias, sessionId });
  return { alias, sessionId };
}

export interface EstablishResult {
  ok: boolean;
  identity: Identity;
  /** whoami echo from the broker on success. */
  whoami?: C2cWhoami | null;
  /** Error message on failure (registration is best-effort; never throws). */
  error?: string;
}

/**
 * Register this session's identity with the broker. Best-effort: on failure it
 * returns `ok:false` with the error rather than throwing, so a broker hiccup
 * never crashes pi's `session_start`. On success the `cli` is left scoped to
 * the registered session id.
 */
export async function establishIdentity(cli: C2cCli, inputs: IdentityInputs): Promise<EstablishResult> {
  const identity = computeIdentity(inputs);
  try {
    const whoami = await cli.register(identity.alias, identity.sessionId);
    return { ok: true, identity, whoami };
  } catch (err) {
    return { ok: false, identity, error: err instanceof Error ? err.message : String(err) };
  }
}
