/**
 * Unit tests for the /c2c-pi-debug table renderer.
 *
 * The table is rendered for pi's TUI notify, which strips trailing
 * whitespace and may wrap. We deliberately keep the output minimal:
 * aligned two-column key/value rows, no box-drawing characters.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDebugTable } from "../src/index.ts";
import { collectDebugState } from "../src/debug.ts";

const SAMPLE = `=== c2c pi debug ===
version: 0.1.0
alias: pi-cbacea
sessionId: pi-019ed079-5596-7044-8018-7f44e6b75625
registered: true
status: warning
cwd: /home/xertrov/src/c2c

=== problems ===
[info] brokerRootEnv: C2C_MCP_BROKER_ROOT is not set; c2c CLI auto-detects from git remote fingerprint
    remedy: run 'c2c doctor' to see the resolved broker root; set the env var only to override
`;

test("formatDebugTable: omits the === c2c pi debug === header", () => {
  const out = formatDebugTable(SAMPLE);
  assert.ok(!out.includes("=== c2c pi debug ==="), "should strip the source header");
});

test("formatDebugTable: each field is on its own line as 'key  value'", () => {
  const out = formatDebugTable(SAMPLE);
  assert.ok(out.includes("version           0.1.0"), "expected aligned 'version' row");
  assert.ok(out.includes("alias             pi-cbacea"));
  assert.ok(out.includes("registered        true"));
});

test("formatDebugTable: key column is aligned (same indent for every row)", () => {
  const out = formatDebugTable(SAMPLE);
  // The key column is KEY_WIDTH (16) chars wide, followed by 2 spaces.
  // The separator is at column 18 (0-based: 16 + 2 = 18). We use a regex
  // to find the actual separator: <key padded to 16> + 2 spaces + value.
  // The simpler check is: the value (the part after the padded key) starts
  // at the same column on every row.
  for (const line of out.split("\n")) {
    if (line.startsWith("--- ") || line.startsWith("[") || line.startsWith("    remedy")) continue;
    if (line.length === 0) continue;
    // The line should be at least 18 chars (16 key + 2 separator), and the
    // char at position 16 and 17 should be spaces.
    if (line.length < 18) continue;
    assert.equal(line[16], " ", `expected space at position 16: ${JSON.stringify(line)}`);
    assert.equal(line[17], " ", `expected space at position 17: ${JSON.stringify(line)}`);
  }
});

test("formatDebugTable: problems section appears after fields", () => {
  const out = formatDebugTable(SAMPLE);
  const fieldsEnd = out.indexOf("\n\n");
  const problemsStart = out.indexOf("--- problems ---");
  assert.ok(problemsStart > 0, "should include '--- problems ---' header");
  assert.ok(problemsStart > fieldsEnd, "problems should follow the fields block");
});

test("formatDebugTable: problems section includes severity, field, message, and remedy", () => {
  const out = formatDebugTable(SAMPLE);
  const problemsBlock = out.slice(out.indexOf("--- problems ---"));
  assert.ok(problemsBlock.includes("[info] brokerRootEnv"), "should include the problem line");
  assert.ok(problemsBlock.includes("remedy: run 'c2c doctor'"), "should include the remedy");
});

test("formatDebugTable: omits problems section when none present", () => {
  const raw = `=== c2c pi debug ===
version: 0.1.0
alias: pi-cbacea
registered: true
status: ok
`;
  const out = formatDebugTable(raw);
  assert.ok(!out.includes("--- problems ---"), "should not have problems section when empty");
});

test("formatDebugTable: output is short (no giant box-drawing borders)", () => {
  const out = formatDebugTable(SAMPLE);
  // No line should be longer than the longest key + 2 spaces + longest value.
  // This guards against accidentally re-introducing box-drawing padding.
  const lines = out.split("\n");
  for (const line of lines) {
    assert.ok(line.length < 200, `line too long (${line.length}): ${line.slice(0, 80)}…`);
  }
});

test("formatDebugTable: integration with collectDebugState output", () => {
  const state = {
    version: "0.1.0",
    identity: { alias: "test", sessionId: "sess" },
    registered: false,
    registerError: "broker unreachable",
    ctxRef: { cwd: "/x", sessionManager: { getSessionId: () => "pi-x" } },
    barState: { alias: "test", registered: false, reason: "broker unreachable" },
    pollIntervalMs: 30000,
    hostSessionEnv: undefined,
    prevSessionId: undefined,
    autoJoinRooms: [],
    piBarPatched: true,
    spoolDir: "/x/spool",
    pid: 1,
    cwdFallback: "/x",
    env: {},
  };
  const raw = collectDebugState(state);
  const out = formatDebugTable(raw);
  // status field is present and has value 'error' (separated by spaces)
  assert.match(out, /^status\s+error$/m, "status field should be 'error'");
  // registerError field is present
  assert.match(out, /^registerError\s+broker unreachable$/m, "registerError should be 'broker unreachable'");
  // problems section exists
  assert.ok(out.includes("--- problems ---"));
  // the brokerRootEnv problem is listed (as info, not warning)
  assert.ok(out.includes("[info] brokerRootEnv"));
});
