import * as fs from "node:fs";

export type DebugStatus = "ok" | "warning" | "error";

export interface DebugProblem {
  severity: "info" | "warning" | "error";
  field: string;
  message: string;
  remedy: string;
}

export interface DebugStateInput {
  version: string;
  identity: { alias: string; sessionId: string } | null;
  registered: boolean;
  registerError?: string;
  ctxRef: {
    cwd?: string;
    sessionManager?: {
      getSessionId?: () => string;
    };
  } | null;
  barState: { alias?: string; registered?: boolean; reason?: string };
  pollIntervalMs: number;
  hostSessionEnv: string | undefined;
  crossRepoEnabled?: boolean;
  sessionsBrokerRoot?: string;
  crossRepoSessionsRegistered?: boolean;
  crossRepoSessionsError?: string;
  relayEnabled?: boolean;
  relayRegistered?: boolean;
  relayAddress?: string;
  relayHostId?: string;
  relayHostIdVerified?: boolean;
  relayError?: string;
  relayWsState?: "connected" | "reconnecting" | "stopped";
  peerStatusCount?: number;
  peerStatusSample?: Array<{ alias: string; state: string; since: number; ttlMs: number }>;
  /**
   * When the most recent followUp message was queued (ms since epoch).
   * Undefined when no followUp is in flight. Useful for debugging the
   * delivery delay — "this followUp has been waiting X seconds".
   */
  queuedSinceMs?: number;
  prevSessionId: string | undefined;
  autoJoinRooms: string[];
  piBarPatched: boolean;
  spoolDir: string;
  pid: number;
  cwdFallback: string;
  env: Record<string, string | undefined>;
}

/**
 * Build the list of problems with severity, a short message, and a remedy.
 * Pure function so it can be unit-tested.
 */
export function collectDebugProblems(state: DebugStateInput): DebugProblem[] {
  const problems: DebugProblem[] = [];

  if (!state.identity) {
    problems.push({
      severity: "error",
      field: "identity",
      message: "no c2c identity (session_start has not run yet)",
      remedy: "wait for session_start; if persistent, check that pi-c2c loaded (see Extensions list)",
    });
  }

  if (state.identity && !state.registered) {
    problems.push({
      severity: "error",
      field: "registered",
      message: `c2c broker registration failed for alias "${state.identity.alias}"${
        state.registerError ? ` (${state.registerError})` : ""
      }`,
      remedy: "run `c2c doctor` from this repo to diagnose; tools are still available but DMs won't deliver",
    });
  }

  if (!state.piBarPatched) {
    problems.push({
      severity: "warning",
      field: "piBarPatched",
      message: "theme monkeypatch not installed (pi-bar will not colorize the c2c status)",
      remedy: "reload the extension (`/reload` or restart pi); the patch installs in session_start",
    });
  }

  // Count spool files inside the closure so we can report problems for them.
  let spoolFiles = 0;
  try {
    const files = fs.readdirSync(state.spoolDir);
    spoolFiles = files.filter((f) => f.endsWith(".json")).length;
  } catch {
    // missing dir or unreadable: count as 0; skip the problem.
  }
  if (spoolFiles > 0) {
    problems.push({
      severity: "warning",
      field: "spoolFiles",
      message: `${spoolFiles} spool file(s) pending delivery in ${state.spoolDir}`,
      remedy: "these will be delivered on the next session_start; if they pile up, the broker is rejecting sends",
    });
  }

  if (!state.env.C2C_MCP_BROKER_ROOT) {
    // The c2c CLI computes the broker root from the git remote URL
    // fingerprint and falls back to ~/.c2c/repos/default/broker. The env
    // var is only an explicit override. We surface a *note* (not a warning)
    // so the user knows the override is unset; the resolved path is
    // available via `c2c doctor` (the extension doesn't know it).
    problems.push({
      severity: "info",
      field: "brokerRootEnv",
      message: "C2C_MCP_BROKER_ROOT is not set; c2c CLI auto-detects from git remote fingerprint",
      remedy: "run `c2c doctor` to see the resolved broker root; set the env var only to override",
    });
  }

  if (state.identity && state.barState.alias && state.barState.alias !== state.identity.alias) {
    problems.push({
      severity: "warning",
      field: "barState",
      message: `barState.alias ("${state.barState.alias}") differs from identity.alias ("${state.identity.alias}")`,
      remedy: "session may have switched identities; reload to refresh",
    });
  }

  if (!state.registered && state.barState.reason) {
    problems.push({
      severity: "warning",
      field: "barReason",
      message: `bar carries: ${state.barState.reason}`,
      remedy: "this is the same reason shown in the yellow pi-bar dot",
    });
  }

  if (state.crossRepoEnabled && state.registered && !state.crossRepoSessionsRegistered) {
    problems.push({
      severity: "warning",
      field: "crossRepo",
      message: `cross-repo (sessions broker) registration failed${
        state.crossRepoSessionsError ? `: ${state.crossRepoSessionsError}` : ""
      }`,
      remedy:
        "this session is invisible to pi sessions in other repos. Most common cause: alias_hijack_conflict (another repo's session owns the same alias). Set C2C_PI_CROSS_REPO=0 to disable, or check `c2c list` against the sessions broker for the colliding alias.",
    });
  }

  // Relay problem detection: missing relay identity or missing_proof_field.
  // These are the most common causes of relay registration failure when the
  // relay requires PoW (C2C_RELAY_POW=1) or is in production mode.
  if (state.relayEnabled && !state.relayRegistered && state.relayError) {
    const err = state.relayError;
    // Check for missing identity (no local Ed25519 keypair)
    if (
      err.includes("no relay identity") ||
      err.includes("identity not found") ||
      err.includes("identity.json") ||
      err.includes("No identity file")
    ) {
      problems.push({
        severity: "error",
        field: "relayIdentity",
        message: "no relay identity (local Ed25519 keypair not initialized)",
        remedy: "run `c2c relay identity init` to create one; this is required for authenticated relay registration",
      });
    } else if (err.includes("missing_proof_field")) {
      // The relay requires proof fields but they were missing — almost always
      // because the CLI tried to register without an identity.
      problems.push({
        severity: "error",
        field: "relayProof",
        message: `relay requires proof fields but they were missing: ${err}`,
        remedy: "run `c2c relay identity init` to create an identity; the relay needs it to authenticate registration requests",
      });
    } else {
      // Generic relay error — surface it as a warning so the user knows
      // something went wrong.
      problems.push({
        severity: "warning",
        field: "relayError",
        message: `relay registration failed: ${err}`,
        remedy: "run `c2c relay doctor` to diagnose; check network and relay configuration",
      });
    }
  }

  return problems;
}

/** Roll up the severities into a single status token. */
export function rollupStatus(problems: DebugProblem[]): DebugStatus {
  if (problems.some((p) => p.severity === "error")) return "error";
  if (problems.some((p) => p.severity === "warning")) return "warning";
  return "ok";
}

export function collectDebugState(state: DebugStateInput): string {
  const alias = state.identity?.alias ?? "(none)";
  const sessionId = state.identity?.sessionId ?? "(none)";

  const cwd = state.ctxRef?.cwd ?? state.cwdFallback;
  const piSessionId = state.ctxRef?.sessionManager?.getSessionId?.() ?? null;

  let spoolFiles = 0;
  try {
    const files = fs.readdirSync(state.spoolDir);
    spoolFiles = files.filter((f) => f.endsWith(".json")).length;
  } catch {
    // missing dir -> 0
  }

  const problems = collectDebugProblems(state);
  const status = rollupStatus(problems);

  const fields: string[] = [
    `version: ${state.version}`,
    `alias: ${alias}`,
    `sessionId: ${sessionId}`,
    `registered: ${state.registered}`,
    `registerError: ${state.registerError ?? "(none)"}`,
    `status: ${status}`,
    `crossRepoEnabled: ${state.crossRepoEnabled ?? false}`,
    `sessionsBrokerRoot: ${state.sessionsBrokerRoot ?? "(disabled)"}`,
    `crossRepoSessionsRegistered: ${state.crossRepoSessionsRegistered ?? false}`,
    `crossRepoSessionsError: ${state.crossRepoSessionsError ?? "(none)"}`,
    `relayEnabled: ${state.relayEnabled ?? true}`,
    `relayRegistered: ${state.relayRegistered ?? false}`,
    `relayAddress: ${state.relayAddress ?? "(none)"}`,
    `relayHostId: ${state.relayHostId ?? "(none)"}`,
    `relayHostIdVerified: ${state.relayHostIdVerified ?? false}`,
    `relayError: ${state.relayError ?? "(none)"}`,
    `relayWsState: ${state.relayWsState ?? "---"}`,
    `peerStatusCount: ${state.peerStatusCount ?? 0}`,
    `peerStatusSample: ${JSON.stringify(state.peerStatusSample ?? [])}`,
    `queuedSinceMs: ${state.queuedSinceMs ?? "(none)"}`,
    `cwd: ${cwd}`,
    `piSessionId: ${piSessionId}`,
    `pid: ${state.pid}`,
    `hostSessionEnv: ${state.hostSessionEnv ?? "(none)"}`,
    `prevSessionId: ${state.prevSessionId ?? "(none)"}`,
    `pollIntervalMs: ${state.pollIntervalMs}`,
    `autoJoinRooms: ${state.autoJoinRooms.join(",")}`,
    `piBarPatched: ${state.piBarPatched}`,
    `spoolDir: ${state.spoolDir}`,
    `spoolFiles: ${spoolFiles}`,
    `barState: ${JSON.stringify({ alias: state.barState.alias, registered: state.barState.registered, reason: state.barState.reason })}`,
    `brokerRoot: see \`c2c doctor\` (auto-detected from git remote fingerprint)`,
  ];

  const lines: string[] = [];
  lines.push("=== c2c pi debug ===");
  lines.push(...fields);
  if (problems.length > 0) {
    lines.push("");
    lines.push("=== problems ===");
    for (const p of problems) {
      lines.push(`[${p.severity}] ${p.field}: ${p.message}`);
      lines.push(`    remedy: ${p.remedy}`);
    }
  }
  return lines.join("\n");
}
