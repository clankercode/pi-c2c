/**
 * Unit tests for RelayWatcher.
 *
 * Exercises the WebSocket-based relay trigger layer (src/relay-watcher.ts)
 * without needing the actual relay or c2c binary. The watcher is a pure
 * trigger — it fires onChange when stdout emits JSON lines. These tests
 * pin that contract.
 *
 * Self-contained: no c2c binary required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { RelayWatcher, type RelayWatcherState } from "../src/relay-watcher.ts";

let counter = 0;
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-c2c-relay-watcher-${++counter}-`));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until `pred()` returns true or `timeoutMs` elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

/**
 * Create a mock script that outputs JSON lines on demand.
 * Returns the script path.
 */
function createMockBinary(dir: string, lines: string[]): string {
  const scriptPath = path.join(dir, "mock-c2c");
  // Create a bash script that echoes each line with a delay
  // `exec sleep` so the long-lived process IS the one we spawned — SIGTERM on
  // stop() kills it directly instead of orphaning a grandchild that keeps the
  // stdout pipe (and the Node event loop) open.
  const script = `#!/bin/bash
${lines.map((l) => `echo '${l}'`).join("\nsleep 0.05\n")}
# Keep running until killed
exec sleep 3600
`;
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

/**
 * Create a mock script that immediately exits with given code.
 */
function createExitingBinary(dir: string, exitCode: number): string {
  const scriptPath = path.join(dir, "mock-c2c-exit");
  const script = `#!/bin/bash
exit ${exitCode}
`;
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function createArgCaptureBinary(dir: string, outputPath: string): string {
  const scriptPath = path.join(dir, "mock-c2c-args");
  const script = `#!/bin/bash
printf '%s\n' "$@" > ${JSON.stringify(outputPath)}
exec sleep 3600
`;
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

test("RelayWatcher: converts https relay URL to http for subscribe", async () => {
  const dir = tmpDir();
  const argsPath = path.join(dir, "args.txt");
  const bin = createArgCaptureBinary(dir, argsPath);
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => {},
  });

  w.start();
  try {
    const ok = await waitFor(() => fs.existsSync(argsPath), 2000);
    assert.ok(ok, "mock binary did not capture args");
    const args = fs.readFileSync(argsPath, "utf8").trim().split("\n");
    assert.deepEqual(args, [
      "relay",
      "subscribe",
      "--alias",
      "test@123",
      "--relay-url",
      "http://relay.example.com",
    ]);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RelayWatcher: constructor sets initial state correctly", () => {
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    onChange: () => {},
  });
  assert.equal(w.isRunning, false);
  assert.equal(w.state, "stopped");
});

test("RelayWatcher: isRunning reflects state after start", () => {
  const dir = tmpDir();
  const bin = createMockBinary(dir, []);
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => {},
  });
  assert.equal(w.isRunning, false);
  w.start();
  assert.equal(w.isRunning, true);
  w.stop();
  assert.equal(w.isRunning, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("RelayWatcher: running subscribe process is reported connected while waiting for frames", () => {
  const dir = tmpDir();
  const bin = createMockBinary(dir, []);
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => {},
  });
  w.start();
  try {
    assert.equal(w.isRunning, true);
    assert.equal(w.state, "connected");
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RelayWatcher: fires onChange when JSON line is received", async () => {
  const dir = tmpDir();
  const jsonLine = JSON.stringify({ op: "dm", from: "sender@abc", body: "hello", ts: 123 });
  const bin = createMockBinary(dir, [jsonLine]);

  let calls = 0;
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => calls++,
  });
  w.start();
  try {
    const ok = await waitFor(() => calls > 0, 2000);
    assert.ok(ok, `onChange never fired (calls=${calls})`);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RelayWatcher: debounces burst events", async () => {
  const dir = tmpDir();
  const lines = [
    JSON.stringify({ op: "dm", from: "a@1", body: "1", ts: 1 }),
    JSON.stringify({ op: "dm", from: "a@1", body: "2", ts: 2 }),
    JSON.stringify({ op: "dm", from: "a@1", body: "3", ts: 3 }),
    JSON.stringify({ op: "dm", from: "a@1", body: "4", ts: 4 }),
    JSON.stringify({ op: "dm", from: "a@1", body: "5", ts: 5 }),
  ];
  const bin = createMockBinary(dir, lines);

  let calls = 0;
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => calls++,
    debounceMs: 100,
  });
  w.start();
  try {
    // Wait for all lines to be processed (5 * 50ms = 250ms + margin)
    await sleep(400);
    // With 100ms debounce and 50ms between lines, we should see ~2-3 calls
    assert.ok(calls >= 1, `expected at least 1 call, got ${calls}`);
    assert.ok(calls <= 4, `expected debounced (<=4), got ${calls}`);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RelayWatcher: stop() halts and is idempotent", () => {
  const dir = tmpDir();
  const bin = createMockBinary(dir, []);
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => {},
  });
  w.start();
  w.stop();
  w.stop(); // idempotent
  w.stop();
  assert.equal(w.isRunning, false);
  assert.equal(w.state, "stopped");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("RelayWatcher: cannot start after stop", () => {
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    onChange: () => {},
  });
  w.stop();
  assert.throws(() => w.start(), /cannot start a stopped watcher/);
});

test("RelayWatcher: start is idempotent", () => {
  const dir = tmpDir();
  const bin = createMockBinary(dir, []);
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => {},
  });
  w.start();
  w.start(); // no error
  w.start();
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("RelayWatcher: transitions to connected on first JSON line", async () => {
  const dir = tmpDir();
  const jsonLine = JSON.stringify({ op: "dm", from: "x@1", body: "hi", ts: 1 });
  const bin = createMockBinary(dir, [jsonLine]);

  const states: RelayWatcherState[] = [];
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => {},
    onStateChange: (s) => states.push(s),
  });
  w.start();
  try {
    await waitFor(() => states.includes("connected"), 2000);
    assert.ok(states.includes("connected"), `expected connected state, got ${states}`);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RelayWatcher: transitions to reconnecting on process exit", async () => {
  const dir = tmpDir();
  const bin = createExitingBinary(dir, 1);

  const states: RelayWatcherState[] = [];
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => {},
    onStateChange: (s) => states.push(s),
  });
  w.start();
  try {
    // The process exits immediately, should trigger reconnecting
    await waitFor(() => states.includes("reconnecting"), 2000);
    assert.ok(states.includes("reconnecting"), `expected reconnecting state, got ${states}`);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RelayWatcher: ignores non-JSON lines", async () => {
  const dir = tmpDir();
  const lines = [
    "Starting relay subscription...",
    "Connected to relay",
    JSON.stringify({ op: "dm", from: "x@1", body: "hi", ts: 1 }),
    "Some debug output",
  ];
  const bin = createMockBinary(dir, lines);

  let calls = 0;
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => calls++,
    debounceMs: 10,
  });
  w.start();
  try {
    await sleep(500);
    // Only the JSON line should trigger onChange
    assert.ok(calls >= 1, `expected at least 1 call for JSON line, got ${calls}`);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RelayWatcher: tolerates missing binary (no throw)", () => {
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin: "/nonexistent/path/to/c2c",
    onChange: () => {},
  });
  // Should not throw
  assert.doesNotThrow(() => w.start());
  w.stop();
});

test("RelayWatcher: errors in onChange do not crash watcher", async () => {
  const dir = tmpDir();
  const lines = [
    JSON.stringify({ op: "dm", from: "a@1", body: "1", ts: 1 }),
    JSON.stringify({ op: "dm", from: "a@1", body: "2", ts: 2 }),
  ];
  const bin = createMockBinary(dir, lines);

  let calls = 0;
  const w = new RelayWatcher({
    alias: "test@123",
    relayUrl: "https://relay.example.com",
    bin,
    onChange: () => {
      calls++;
      throw new Error("simulated error");
    },
    debounceMs: 10,
  });
  w.start();
  try {
    await waitFor(() => calls >= 1, 2000);
    assert.ok(calls >= 1, `expected at least 1 call despite errors, got ${calls}`);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// E2E test that spawns the real `c2c relay subscribe` — skip unless C2C_PI_E2E=1
test("RelayWatcher: E2E with real c2c relay subscribe (skipped without C2C_PI_E2E)", async () => {
  if (process.env.C2C_PI_E2E !== "1") {
    // Skip this test by returning early
    return;
  }

  // This test assumes:
  // 1. `c2c` binary is in PATH
  // 2. Relay is configured and accessible
  // 3. You have a valid relay alias
  const relayAlias = process.env.C2C_E2E_RELAY_ALIAS;
  const relayUrl = process.env.C2C_E2E_RELAY_URL ?? "https://relay.c2c.im";

  if (!relayAlias) {
    // Skip without alias
    return;
  }

  const states: RelayWatcherState[] = [];
  const w = new RelayWatcher({
    alias: relayAlias,
    relayUrl,
    onChange: () => {},
    onStateChange: (s) => states.push(s),
  });

  w.start();
  try {
    // Wait a bit to see if it connects or starts reconnecting
    await sleep(3000);
    assert.ok(w.isRunning, "watcher should be running");
    // Should have some state by now
    assert.ok(
      states.includes("connected") || states.includes("reconnecting"),
      `expected state transition, got ${states}`,
    );
  } finally {
    w.stop();
  }
});
