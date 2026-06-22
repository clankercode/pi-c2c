/**
 * Unit tests for the c2c_pi_debug tool data gathering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectDebugProblems,
  collectDebugState,
  rollupStatus,
} from "../src/debug.ts";

const BASE_STATE = {
  version: "0.1.0",
  identity: { alias: "test-alias", sessionId: "session-123" } as const,
  registered: true,
  ctxRef: { cwd: "/mock/cwd", sessionManager: { getSessionId: () => "pi-123" } },
  barState: { alias: "test-alias", registered: true },
  pollIntervalMs: 30000,
  hostSessionEnv: "host-session",
  prevSessionId: undefined,
  autoJoinRooms: ["room1", "room2"],
  piBarPatched: true,
  spoolDir: "/mock/spool",
  pid: 9999,
  cwdFallback: "/fallback",
  env: { C2C_MCP_BROKER_ROOT: "/mock/broker" },
  crossRepoEnabled: false,
  sessionsBrokerRoot: undefined,
  crossRepoSessionsRegistered: false,
  crossRepoSessionsError: undefined,
};

test("collectDebugState formats all fields when registered and healthy", () => {
  const out = collectDebugState(BASE_STATE);
  assert.ok(out.includes("=== c2c pi debug ==="));
  assert.ok(out.includes("status: ok"), `missing status:ok in:\n${out}`);
  assert.ok(out.includes("version: 0.1.0"));
  assert.ok(out.includes("alias: test-alias"));
  assert.ok(out.includes("sessionId: session-123"));
  assert.ok(out.includes("registered: true"));
  assert.ok(out.includes("brokerRoot: see `c2c doctor`"));
  assert.ok(out.includes("cwd: /mock/cwd"));
  assert.ok(out.includes("piSessionId: pi-123"));
  assert.ok(out.includes("pid: 9999"));
  assert.ok(out.includes("hostSessionEnv: host-session"));
  assert.ok(out.includes("prevSessionId: (none)"));
  assert.ok(out.includes("pollIntervalMs: 30000"));
  assert.ok(out.includes("autoJoinRooms: room1,room2"));
  assert.ok(out.includes("piBarPatched: true"));
  assert.ok(out.includes("spoolDir: /mock/spool"));
  assert.ok(out.includes('barState: {"alias":"test-alias","registered":true}'));
  assert.ok(!out.includes("=== problems ==="), "should not include problems section when healthy");
});

test("collectDebugState handles null state correctly", () => {
  const out = collectDebugState({
    ...BASE_STATE,
    identity: null,
    registered: false,
    ctxRef: null,
    barState: {},
    hostSessionEnv: undefined,
    autoJoinRooms: [],
    piBarPatched: false,
    spoolDir: "/mock/spool2",
    pid: 8888,
    env: {},
  });
  assert.ok(out.includes("status: error"), `expected error status, got:\n${out}`);
  assert.ok(out.includes("alias: (none)"));
  assert.ok(out.includes("sessionId: (none)"));
  assert.ok(out.includes("registered: false"));
  assert.ok(out.includes("cwd: /fallback"));
  assert.ok(out.includes("piSessionId: null"));
  assert.ok(out.includes("hostSessionEnv: (none)"));
  assert.ok(out.includes("autoJoinRooms: "));
  assert.ok(out.includes('barState: {}'));
});

test("collectDebugState reports registration failure with remedy", () => {
  const out = collectDebugState({
    ...BASE_STATE,
    registered: false,
    registerError: "broker unreachable",
  });
  assert.ok(out.includes("status: error"));
  assert.ok(out.includes("=== problems ==="));
  assert.ok(out.includes('[error] registered: c2c broker registration failed for alias "test-alias" (broker unreachable)'));
  assert.ok(out.includes("remedy: run `c2c doctor`"));
});

test("collectDebugState reports missing pi-bar patch as warning", () => {
  const out = collectDebugState({
    ...BASE_STATE,
    piBarPatched: false,
  });
  assert.ok(out.includes("status: warning"));
  assert.ok(out.includes("[warning] piBarPatched: theme monkeypatch not installed"));
  assert.ok(out.includes("remedy: reload the extension"));
});

test("collectDebugState reports alias mismatch as warning", () => {
  const out = collectDebugState({
    ...BASE_STATE,
    barState: { alias: "stale-alias", registered: true },
  });
  assert.ok(out.includes("status: warning"));
  assert.ok(out.includes('[warning] barState: barState.alias ("stale-alias") differs from identity.alias ("test-alias")'));
});

test("collectDebugState reports missing C2C_MCP_BROKER_ROOT as info (not a warning)", () => {
  const out = collectDebugState({ ...BASE_STATE, env: {} });
  // Missing broker-root env var is informational only — the c2c CLI
  // auto-detects. Status should still be 'ok' (no warnings), and the
  // problem is tagged [info].
  assert.ok(out.includes("status: ok"));
  assert.ok(out.includes("[info] brokerRootEnv: C2C_MCP_BROKER_ROOT is not set"));
  assert.ok(out.includes("remedy: run `c2c doctor`"));
});

test("rollupStatus: error beats warning beats ok", () => {
  assert.equal(rollupStatus([]), "ok");
  assert.equal(rollupStatus([{ severity: "warning", field: "x", message: "m", remedy: "r" }]), "warning");
  assert.equal(
    rollupStatus([
      { severity: "warning", field: "x", message: "m", remedy: "r" },
      { severity: "error", field: "y", message: "m", remedy: "r" },
    ]),
    "error",
  );
});

test("collectDebugProblems: healthy state has no problems", () => {
  const problems = collectDebugProblems(BASE_STATE);
  assert.equal(problems.length, 0);
});

test("collectDebugProblems: unregistered with identity produces one error", () => {
  const problems = collectDebugProblems({ ...BASE_STATE, registered: false });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].severity, "error");
  assert.equal(problems[0].field, "registered");
  assert.ok(problems[0].message.includes("test-alias"));
  assert.ok(problems[0].remedy.includes("c2c doctor"));
});

test("collectDebugProblems: null identity is an error", () => {
  const problems = collectDebugProblems({ ...BASE_STATE, identity: null });
  assert.ok(problems.some((p) => p.severity === "error" && p.field === "identity"));
});

test("collectDebugState: surfaces cross-repo fields when enabled", () => {
  const out = collectDebugState({
    ...BASE_STATE,
    crossRepoEnabled: true,
    sessionsBrokerRoot: "/home/x/.c2c/sessions/broker",
    crossRepoSessionsRegistered: true,
  });
  assert.ok(out.includes("crossRepoEnabled: true"));
  assert.ok(out.includes("sessionsBrokerRoot: /home/x/.c2c/sessions/broker"));
  assert.ok(out.includes("crossRepoSessionsRegistered: true"));
  assert.ok(out.includes("crossRepoSessionsError: (none)"));
});

test("collectDebugState: surfaces cross-repo error as a warning problem", () => {
  const out = collectDebugState({
    ...BASE_STATE,
    crossRepoEnabled: true,
    sessionsBrokerRoot: "/home/x/.c2c/sessions/broker",
    crossRepoSessionsRegistered: false,
    crossRepoSessionsError: "alias_hijack_conflict",
  });
  assert.ok(out.includes("crossRepoSessionsRegistered: false"));
  assert.ok(out.includes("alias_hijack_conflict"));
  assert.ok(out.includes("[warning] crossRepo:"));
});

test("collectDebugState: cross-repo disabled leaves default fields", () => {
  const out = collectDebugState(BASE_STATE);
  assert.ok(out.includes("crossRepoEnabled: false"));
  assert.ok(out.includes("sessionsBrokerRoot: (disabled)"));
});

test("collectDebugState: surfaces peer status count and sample", () => {
  const out = collectDebugState({
    ...BASE_STATE,
    peerStatusCount: 3,
    peerStatusSample: [
      { alias: "alice", state: "processing", since: 1, ttlMs: 60_000 },
      { alias: "bob", state: "idle", since: 2, ttlMs: 60_000 },
    ],
  });
  assert.ok(out.includes("peerStatusCount: 3"));
  assert.ok(out.includes("peerStatusSample:"));
  assert.ok(out.includes("alice"));
  assert.ok(out.includes("processing"));
});

test("collectDebugState: peer status defaults to zero/empty when absent", () => {
  const out = collectDebugState(BASE_STATE);
  assert.ok(out.includes("peerStatusCount: 0"));
  assert.ok(out.includes("peerStatusSample: []"));
});

// --- Relay identity problem detection ---

test("collectDebugProblems: relay enabled but not registered with missing identity error", () => {
  const problems = collectDebugProblems({
    ...BASE_STATE,
    relayEnabled: true,
    relayRegistered: false,
    relayError: "no relay identity; run `c2c relay identity init` to create one",
  });
  const relayProblem = problems.find((p) => p.field === "relayIdentity");
  assert.ok(relayProblem, "expected relayIdentity problem");
  assert.equal(relayProblem!.severity, "error");
  assert.ok(relayProblem!.message.includes("no relay identity"));
  assert.ok(relayProblem!.remedy.includes("c2c relay identity init"));
});

test("collectDebugProblems: relay enabled but not registered with missing_proof_field error", () => {
  const problems = collectDebugProblems({
    ...BASE_STATE,
    relayEnabled: true,
    relayRegistered: false,
    relayError: "missing_proof_field: identity_pk, signature, nonce, and timestamp are required when C2C_RELAY_POW=1",
  });
  const relayProblem = problems.find((p) => p.field === "relayProof");
  assert.ok(relayProblem, "expected relayProof problem");
  assert.equal(relayProblem!.severity, "error");
  assert.ok(relayProblem!.message.includes("missing_proof_field"));
  assert.ok(relayProblem!.remedy.includes("c2c relay identity init"));
});

test("collectDebugProblems: relay enabled but not registered with generic error", () => {
  const problems = collectDebugProblems({
    ...BASE_STATE,
    relayEnabled: true,
    relayRegistered: false,
    relayError: "connection_error: network unreachable",
  });
  const relayProblem = problems.find((p) => p.field === "relayError");
  assert.ok(relayProblem, "expected relayError problem");
  assert.equal(relayProblem!.severity, "warning");
  assert.ok(relayProblem!.message.includes("connection_error"));
  assert.ok(relayProblem!.remedy.includes("c2c relay doctor"));
});

test("collectDebugProblems: relay disabled does not produce relay problems", () => {
  const problems = collectDebugProblems({
    ...BASE_STATE,
    relayEnabled: false,
    relayRegistered: false,
    relayError: "some error",
  });
  const relayProblems = problems.filter((p) =>
    ["relayIdentity", "relayProof", "relayError"].includes(p.field)
  );
  assert.equal(relayProblems.length, 0, "no relay problems when relay disabled");
});

test("collectDebugProblems: relay registered does not produce relay problems", () => {
  const problems = collectDebugProblems({
    ...BASE_STATE,
    relayEnabled: true,
    relayRegistered: true,
    relayError: undefined,
  });
  const relayProblems = problems.filter((p) =>
    ["relayIdentity", "relayProof", "relayError"].includes(p.field)
  );
  assert.equal(relayProblems.length, 0, "no relay problems when relay registered");
});

test("collectDebugState: surfaces relay identity problem with remedy", () => {
  const out = collectDebugState({
    ...BASE_STATE,
    relayEnabled: true,
    relayRegistered: false,
    relayError: "no relay identity; run `c2c relay identity init` to create one",
  });
  assert.ok(out.includes("[error] relayIdentity:"));
  assert.ok(out.includes("remedy:"));
  assert.ok(out.includes("c2c relay identity init"));
});
