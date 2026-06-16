/**
 * Unit tests for the /c2c-pi-debug table renderer.
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
brokerRoot: /home/xertrov/.c2c
cwd: /home/xertrov/src/c2c

=== problems ===
[warning] brokerRootEnv: C2C_MCP_BROKER_ROOT is not set; using the fingerprint-derived default
    remedy: if multi-repo, set C2C_MCP_BROKER_ROOT in your shell or .c2c/repo.json
`;

test("formatDebugTable: renders a top/bottom border", () => {
  const out = formatDebugTable(SAMPLE);
  assert.ok(out.startsWith("┌"), `expected top border, got: ${out.slice(0, 20)}`);
  assert.ok(out.includes("└"), "expected bottom border");
  assert.ok(out.split("\n")[0].startsWith("┌─"), "top border should be ─");
  assert.ok(out.split("\n")[0].endsWith("┐"), "top border should end with ┐");
});

test("formatDebugTable: every key row has a key/value separator", () => {
  const out = formatDebugTable(SAMPLE);
  // Field rows look like: "│ <key padded to MAX_KEY_WIDTH> │ <value padded> │"
  // The key is a single word (no spaces), padded to a fixed width. We use
  // that to filter out wrapped problem lines (which start with "│ d default"
  // or similar).
  const fieldRows = pickFieldRows(out);
  for (const row of fieldRows) {
    const sep = row.indexOf("│ ", 2);
    assert.ok(sep > 0, `field row missing key/value separator: ${row}`);
  }
});

test("formatDebugTable: pads the key column for alignment", () => {
  const out = formatDebugTable(SAMPLE);
  const fieldRows = pickFieldRows(out);
  assert.ok(fieldRows.length > 1, "need at least 2 field rows to test alignment");
  const first = fieldRows[0].indexOf("│ ", 2);
  for (const row of fieldRows) {
    assert.equal(
      row.indexOf("│ ", 2),
      first,
      `key/value separator offset mismatch: "${row}" (expected ${first})`,
    );
  }
});

/**
 * A "field row" is a line of the debug table whose key is a single word.
 * The key appears right after "│ " (position 2), padded with trailing
 * spaces, and runs up to the next "│ " separator. Wrapped problem lines
 * and the problems header are excluded by checking that the trimmed key
 * contains no spaces.
 */
function pickFieldRows(out: string): string[] {
  return out.split("\n").filter((l) => {
    if (!l.startsWith("│ ")) return false;
    if (l.startsWith("│ problems")) return false;
    const sep = l.indexOf("│ ", 2);
    if (sep < 0) return false;
    const key = l.slice(2, sep).trim();
    if (key.length === 0 || key.includes(" ")) return false;
    return true;
  });
}

test("formatDebugTable: every field row ends with a closing border", () => {
  const out = formatDebugTable(SAMPLE);
  const fieldRows = pickFieldRows(out);
  for (const row of fieldRows) {
    assert.ok(row.endsWith(" │"), `field row should end with " │": ${row}`);
  }
});

test("formatDebugTable: includes problems section when present", () => {
  const out = formatDebugTable(SAMPLE);
  assert.ok(out.includes("│ problems"), "should have a problems header row");
  assert.ok(out.includes("brokerRootEnv"), "should include the problem field");
  assert.ok(out.includes("remedy: if multi-repo"), "should include the remedy text");
});

test("formatDebugTable: omits problems section when none", () => {
  const raw = `=== c2c pi debug ===
version: 0.1.0
alias: pi-cbacea
registered: true
status: ok
`;
  const out = formatDebugTable(raw);
  assert.ok(!out.includes("│ problems"), "should not have problems section when empty");
});

test("formatDebugTable: wraps long values at MAX_VALUE_WIDTH", () => {
  const longPath = "/home/xertrov/very/long/path/to/some/place/" + "x".repeat(80);
  const raw = `=== c2c pi debug ===
spoolDir: ${longPath}
`;
  const out = formatDebugTable(raw);
  const lines = out.split("\n").filter((l) => l.includes("x"));
  assert.ok(lines.length > 1, "long value should wrap to multiple lines");
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
  // status: error appears as a key/value pair in the table
  assert.ok(out.includes("│ status"), "status field row should be present");
  assert.ok(out.includes("error"), "status value should be 'error'");
  // registerError value should be present
  assert.ok(out.includes("broker unreachable"), "registerError should be present");
  // problems section header
  assert.ok(out.includes("│ problems"), "should have problems section");
});
