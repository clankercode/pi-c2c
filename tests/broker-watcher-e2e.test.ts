/**
 * E2E tests for BrokerWatcher integration with the real c2c binary.
 *
 * Verifies that the watcher actually fires when the c2c binary writes a
 * message to the inbox file (the full chain: c2c send → broker inbox
 * write → fs.watch event → BrokerWatcher onChange callback).
 *
 * GATED: these tests run only when `C2C_PI_E2E=1` is set in the env.
 * Default CI runs should not need to spawn the c2c binary or hit the
 * file system at this granularity. Run explicitly with:
 *
 *   C2C_PI_E2E=1 bun test tests/broker-watcher-e2e.test.ts
 *
 * Self-skips when `c2c` is not on PATH.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { C2cCli, type ExecFn, type ExecResultLike } from "../src/c2c-cli.ts";
import { resolveC2cCommand } from "../src/c2c-bin.ts";
import { BrokerWatcher } from "../src/broker-watcher.ts";

const C2C_BIN = resolveC2cCommand();
const E2E_ENABLED = process.env.C2C_PI_E2E === "1";

function c2cAvailable(): boolean {
  try {
    execFileSync(C2C_BIN, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const haveC2c = c2cAvailable();
const opts = E2E_ENABLED && haveC2c
  ? {}
  : {
      skip: !E2E_ENABLED
        ? "set C2C_PI_E2E=1 to run e2e broker-watcher tests"
        : "c2c binary not available",
    };

let counter = 0;

function makeBroker(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-c2c-watcher-e2e-${++counter}-`));
}

function realExecFor(broker: string, sessionId: string): ExecFn {
  return (command, args) =>
    new Promise<ExecResultLike>((resolve) => {
      const child = spawn(command, args, {
        env: {
          ...process.env,
          C2C_MCP_BROKER_ROOT: broker,
          C2C_MCP_SESSION_ID: sessionId,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
      child.on("error", (e) => resolve({ stdout, stderr: String(e), code: 127 }));
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test(
  "e2e: BrokerWatcher fires onChange when c2c binary writes to the inbox",
  opts,
  async () => {
    const broker = makeBroker();
    const sessionA = `pi-watcher-A-${++counter}-${Date.now()}`;
    const sessionB = `pi-watcher-B-${++counter}-${Date.now()}`;
    const a = new C2cCli({ exec: realExecFor(broker, sessionA), sessionId: sessionA, bin: C2C_BIN });
    const b = new C2cCli({ exec: realExecFor(broker, sessionB), sessionId: sessionB, bin: C2C_BIN });
    await a.register("pi-watcher-sender", sessionA);
    await b.register("pi-watcher-receiver", sessionB);

    let fires = 0;
    const watcher = new BrokerWatcher({
      brokerRoot: broker,
      sessionId: sessionB,
      onChange: () => fires++,
      debounceMs: 20,
    });
    watcher.start();
    try {
      await a.send("pi-watcher-receiver", "e2e-watcher-test");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && fires === 0) {
        await sleep(20);
      }
      if (fires === 0) {
        const inboxPath = path.join(broker, `${sessionB}.inbox.json`);
        const exists = fs.existsSync(inboxPath);
        const size = exists ? fs.statSync(inboxPath).size : -1;
        assert.fail(
          `BrokerWatcher never fired after c2c send (5s wait). ` +
          `Inbox file exists=${exists} size=${size}.`,
        );
      }
    } finally {
      watcher.stop();
      fs.rmSync(broker, { recursive: true, force: true });
    }
  },
);

test(
  "e2e: BrokerWatcher latency from send to onChange is well under 1s",
  opts,
  async () => {
    const broker = makeBroker();
    const sessionA = `pi-watcher-lat-A-${++counter}-${Date.now()}`;
    const sessionB = `pi-watcher-lat-B-${++counter}-${Date.now()}`;
    const a = new C2cCli({ exec: realExecFor(broker, sessionA), sessionId: sessionA, bin: C2C_BIN });
    const b = new C2cCli({ exec: realExecFor(broker, sessionB), sessionId: sessionB, bin: C2C_BIN });
    await a.register("pi-watcher-lat-sender", sessionA);
    await b.register("pi-watcher-lat-receiver", sessionB);

    const samples: number[] = [];
    const watcher = new BrokerWatcher({
      brokerRoot: broker,
      sessionId: sessionB,
      onChange: () => {
        samples.push(Date.now());
      },
      debounceMs: 20,
    });
    watcher.start();
    try {
      for (let i = 0; i < 5; i++) {
        const sentAt = Date.now();
        await a.send("pi-watcher-lat-receiver", `lat-${i}-${Date.now()}`);
        const deadline = sentAt + 3000;
        while (Date.now() < deadline && samples.length <= i) {
          await sleep(10);
        }
        assert.ok(
          samples.length > i,
          `watcher did not fire for sample ${i}`,
        );
        const t = samples[i];
        if (t !== undefined) {
          samples[i] = t - sentAt;
        }
      }
      const valid = samples.filter((s): s is number => typeof s === "number");
      const max = Math.max(...valid);
      const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
      console.log(
        `  e2e broker-watcher latency: mean=${mean.toFixed(0)}ms max=${max}ms (n=${valid.length})`,
      );
      assert.ok(
        max < 1000,
        `max watcher latency ${max}ms exceeded 1s ceiling`,
      );
    } finally {
      watcher.stop();
      fs.rmSync(broker, { recursive: true, force: true });
    }
  },
);

test(
  "e2e: BrokerWatcher does NOT fire for unrelated file changes in the broker dir",
  opts,
  async () => {
    const broker = makeBroker();
    const session = `pi-watcher-iso-${++counter}-${Date.now()}`;
    const a = new C2cCli({ exec: realExecFor(broker, session), sessionId: session, bin: C2C_BIN });
    await a.register("pi-watcher-iso", session);

    let fires = 0;
    const watcher = new BrokerWatcher({
      brokerRoot: broker,
      sessionId: session,
      onChange: () => fires++,
      debounceMs: 20,
    });
    watcher.start();
    try {
      fs.writeFileSync(path.join(broker, "unrelated.txt"), "noise");
      await sleep(300);
      assert.equal(
        fires,
        0,
        `watcher fired for unrelated file (expected 0 calls, got ${fires})`,
      );
    } finally {
      watcher.stop();
      fs.rmSync(broker, { recursive: true, force: true });
    }
  },
);
