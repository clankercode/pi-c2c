/**
 * Unit tests for BrokerWatcher.
 *
 * Exercises the file-watch trigger layer (src/broker-watcher.ts) without
 * needing the c2c binary or any of the extension's drain pipeline. The
 * watcher is a pure trigger — it fires onChange when the inbox file
 * changes. These tests pin that contract.
 *
 * Self-contained: no c2c binary required.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BrokerWatcher } from "../src/broker-watcher.ts";

let counter = 0;
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-c2c-watcher-${++counter}-`));
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

test("BrokerWatcher: fires onChange when the inbox file is created", async () => {
  const dir = tmpDir();
  const sessionId = "sess-create";
  let calls = 0;
  const w = new BrokerWatcher({ brokerRoot: dir, sessionId, onChange: () => calls++ });
  w.start();
  try {
    // File doesn't exist yet — fs.watch may or may not fire when it appears,
    // but the watcher must tolerate that and not crash.
    fs.writeFileSync(path.join(dir, `${sessionId}.inbox.json`), "[]");
    // Give fs.watch time to deliver the event.
    const ok = await waitFor(() => calls > 0, 2000);
    assert.ok(ok, `onChange never fired after file create (calls=${calls})`);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BrokerWatcher: fires onChange when the inbox file is modified", async () => {
  const dir = tmpDir();
  const sessionId = "sess-modify";
  const path_ = path.join(dir, `${sessionId}.inbox.json`);
  fs.writeFileSync(path_, "[]");

  let calls = 0;
  const w = new BrokerWatcher({ brokerRoot: dir, sessionId, onChange: () => calls++ });
  w.start();
  try {
    // Touch the file to fire change events.
    fs.writeFileSync(path_, "[]"); // same content, but write triggers change
    fs.writeFileSync(path_, "[]");
    fs.writeFileSync(path_, "[]");
    const ok = await waitFor(() => calls > 0, 2000);
    assert.ok(ok, `onChange never fired after file modify (calls=${calls})`);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BrokerWatcher: debounces bursty events into fewer onChange calls", async () => {
  const dir = tmpDir();
  const sessionId = "sess-debounce";
  const path_ = path.join(dir, `${sessionId}.inbox.json`);
  fs.writeFileSync(path_, "[]");

  let calls = 0;
  const w = new BrokerWatcher({
    brokerRoot: dir,
    sessionId,
    onChange: () => calls++,
    debounceMs: 100, // longer than the test write loop
  });
  w.start();
  try {
    // 5 writes within the debounce window should collapse to ≤2 calls
    // (one in the first window, possibly one in the second if the window
    // straddles the writes).
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path_, "[]");
      await sleep(5);
    }
    // Wait for the debounce window to fully elapse.
    await sleep(250);
    // We expect at least 1 call and at most 3 calls (one per debounce
    // window that intersected the writes). 5+ would mean no debouncing.
    assert.ok(calls >= 1, `expected at least 1 onChange call, got ${calls}`);
    assert.ok(calls <= 3, `expected debounced calls (≤3), got ${calls}`);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BrokerWatcher: stop() halts further events", async () => {
  const dir = tmpDir();
  const sessionId = "sess-stop";
  const path_ = path.join(dir, `${sessionId}.inbox.json`);
  fs.writeFileSync(path_, "[]");

  let calls = 0;
  const w = new BrokerWatcher({ brokerRoot: dir, sessionId, onChange: () => calls++ });
  w.start();
  // Confirm the watcher is firing.
  fs.writeFileSync(path_, "[]");
  await waitFor(() => calls > 0, 2000);
  const callsBeforeStop = calls;

  w.stop();

  // More writes should NOT trigger onChange.
  fs.writeFileSync(path_, "[]");
  fs.writeFileSync(path_, "[]");
  await sleep(150);

  assert.equal(
    calls,
    callsBeforeStop,
    `onChange fired after stop() (before=${callsBeforeStop}, after=${calls})`,
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("BrokerWatcher: errors thrown in onChange do not crash the watcher", async () => {
  const dir = tmpDir();
  const sessionId = "sess-err";
  const path_ = path.join(dir, `${sessionId}.inbox.json`);
  fs.writeFileSync(path_, "[]");

  let calls = 0;
  const w = new BrokerWatcher({
    brokerRoot: dir,
    sessionId,
    onChange: () => {
      calls++;
      throw new Error("simulated");
    },
  });
  w.start();
  try {
    fs.writeFileSync(path_, "[]");
    const ok = await waitFor(() => calls > 0, 2000);
    assert.ok(ok, "onChange was never called");
    // Trigger more — each should still fire and the error should be swallowed.
    fs.writeFileSync(path_, "[]");
    await waitFor(() => calls > 1, 2000);
    assert.ok(calls >= 2, `expected at least 2 calls despite errors, got ${calls}`);
  } finally {
    w.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("BrokerWatcher: inboxPath exposes the expected file", () => {
  const w = new BrokerWatcher({
    brokerRoot: "/tmp/broker",
    sessionId: "sess-x",
    onChange: () => {},
  });
  assert.equal(w.inboxPath, path.join("/tmp/broker", "sess-x.inbox.json"));
});

test("BrokerWatcher: start() is idempotent (no error on double-start)", () => {
  const dir = tmpDir();
  const w = new BrokerWatcher({ brokerRoot: dir, sessionId: "s", onChange: () => {} });
  w.start();
  w.start(); // second start should be a no-op, not throw
  w.start();
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("BrokerWatcher: cannot start after stop()", () => {
  const dir = tmpDir();
  const w = new BrokerWatcher({ brokerRoot: dir, sessionId: "s", onChange: () => {} });
  w.stop();
  assert.throws(() => w.start(), /cannot start a stopped watcher/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("BrokerWatcher: isRunning reflects state correctly", () => {
  const dir = tmpDir();
  const w = new BrokerWatcher({ brokerRoot: dir, sessionId: "s", onChange: () => {} });
  assert.equal(w.isRunning, false);
  w.start();
  assert.equal(w.isRunning, true);
  w.stop();
  assert.equal(w.isRunning, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("BrokerWatcher: tolerates missing parent dir (start() does not throw)", () => {
  const dir = path.join(os.tmpdir(), `pi-c2c-watcher-nonexistent-${++counter}`);
  // Do not create `dir`. The watcher should still start; the file will
  // appear later when the broker initializes.
  const w = new BrokerWatcher({ brokerRoot: dir, sessionId: "s", onChange: () => {} });
  assert.doesNotThrow(() => w.start());
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
