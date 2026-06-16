import * as os from "node:os";
import * as fs from "node:fs";

export type DebugStatus = "ok" | "warning" | "error";

export interface DebugProblem {
  severity: "warning" | "error";
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
  barState: { alias?: string; registered?: boolean };
  pollIntervalMs: number;
  hostSessionEnv: string | undefined;
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
    problems.push({
      severity: "warning",
      field: "brokerRootEnv",
      message: "C2C_MCP_BROKER_ROOT is not set; using the fingerprint-derived default",
      remedy: "if multi-repo, set C2C_MCP_BROKER_ROOT in your shell or .c2c/repo.json",
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

  const brokerRootEnv = state.env.C2C_MCP_BROKER_ROOT;
  const brokerRoot = brokerRootEnv ?? (state.env.XDG_STATE_HOME ?? os.homedir() + "/.c2c");

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
    `status: ${status}`,
    `brokerRoot: ${brokerRoot}`,
    `brokerRootEnv: ${brokerRootEnv ?? "(not set)"}`,
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
    `barState: ${JSON.stringify({ alias: state.barState.alias, registered: state.barState.registered })}`,
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
