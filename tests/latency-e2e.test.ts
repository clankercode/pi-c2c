/**
 * E2E latency tests against the real `c2c` binary.
 *
 * Measures actual round-trip latency on a single shared broker (isolated
 * to a temp dir via C2C_MCP_BROKER_ROOT — the shared swarm broker is never
 * touched). Both sender and receiver register on the same broker root,
 * which is how the swarm broker works in production (per-repo broker is
 * shared by all agents on that machine).
 *
 * Self-skip when `c2c` is not on PATH. Run explicitly with
 * `bun test tests/latency-e2e.test.ts`.
 *
 * NOTE: these tests measure the broker drain path (sub-second expected).
 * The pollTick interval (now 5s after the 30s→5s reduction in task #35)
 * is the dominant e2e latency source in production. The constant itself
 * is locked in src/index.ts:DEFAULT_POLL_INTERVAL_MS; to measure the
 * full extension latency (including pollTick), drive the extension via
 * a tmux session (scripts/c2c_tmux.py).
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { C2cCli, type ExecFn, type ExecResultLike } from "../src/c2c-cli.ts";

const C2C_BIN = process.env.C2C_BIN ?? "c2c";

function c2cAvailable(): boolean {
  try {
    execFileSync(C2C_BIN, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_C2C = c2cAvailable();
const opts = HAVE_C2C ? {} : { skip: "c2c binary not on PATH" };

let broker: string;
before(() => {
  broker = fs.mkdtempSync(path.join(os.tmpdir(), "pi-c2c-lat-"));
});

after(() => {
  try {
    fs.rmSync(broker, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** Async ExecFn scoped to a session + isolated broker. */
function realExec(sessionId: string): ExecFn {
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

const cli = (sessionId: string) =>
  new C2cCli({ exec: realExec(sessionId), sessionId, bin: C2C_BIN });

/** Wait for the receiver's inbox to contain a message matching `matcher`. */
async function waitForMarker(
  receiver: C2cCli,
  matcher: (m: { from_alias: string; content: string; ts: number }) => boolean,
  timeoutMs = 5000,
): Promise<number> {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await receiver.pollInbox({ peek: true });
    const hit = msgs.find(matcher);
    if (hit) {
      const elapsed = Date.now() - t0;
      // drain so the message doesn't pollute later checks
      await receiver.pollInbox();
      return elapsed;
    }
    await new Promise((res) => setTimeout(res, 25));
  }
  return 0;
}

test(
  "e2e: send + poll round-trip is sub-second on local broker",
  opts,
  async () => {
    const a = cli("pi-latA-" + Date.now());
    const b = cli("pi-latB-" + Date.now());
    await a.register("pi-latA", a.sessionId!);
    await b.register("pi-latB", b.sessionId!);

    const marker = `LAT-MARKER-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const t0 = Date.now();
    await a.send("pi-latB", marker);
    const elapsed = await waitForMarker(
      b,
      (m) => m.content === marker,
    );
    assert.ok(elapsed > 0, `marker "${marker}" did not arrive within 5s`);
    assert.ok(
      elapsed < 2000,
      `broker round-trip took ${elapsed}ms (expected < 2000ms)`,
    );
    console.log(`  e2e broker round-trip: ${elapsed}ms`);
  },
);

test(
  "e2e: burst of 10 messages all arrive on the receiver",
  opts,
  async () => {
    const a = cli("pi-burstA-" + Date.now());
    const b = cli("pi-burstB-" + Date.now());
    await a.register("pi-burstA", a.sessionId!);
    await b.register("pi-burstB", b.sessionId!);

    const markers: string[] = [];
    for (let i = 0; i < 10; i++) {
      const m = `BURST-${i}-${Date.now()}-${i}`;
      markers.push(m);
      await a.send("pi-burstB", m);
    }

    const msgs = await b.pollInbox();
    const contents = msgs.map((m) => m.content);
    for (const m of markers) {
      assert.ok(contents.includes(m), `missing marker "${m}" in burst of 10`);
    }
  },
);

test(
  "e2e: 20 sequential send+polls measure mean+max broker round-trip",
  opts,
  async () => {
    const a = cli("pi-seqA-" + Date.now());
    const b = cli("pi-seqB-" + Date.now());
    await a.register("pi-seqA", a.sessionId!);
    await b.register("pi-seqB", b.sessionId!);

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const marker = `SEQ-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await a.send("pi-seqB", marker);
      const elapsed = await waitForMarker(
        b,
        (m) => m.content === marker,
      );
      assert.ok(elapsed > 0, `sample ${i} (${marker}) did not arrive`);
      samples.push(elapsed);
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
    const p50 = sorted[Math.floor(samples.length / 2)];
    const p95 = sorted[Math.floor(samples.length * 0.95)];
    const max = sorted[sorted.length - 1];
    console.log(
      `  e2e broker samples (n=${samples.length}): mean=${mean.toFixed(0)}ms p50=${p50}ms p95=${p95}ms max=${max}ms`,
    );
    assert.ok(max < 2000, `max sample ${max}ms exceeded 2000ms ceiling`);
  },
);
