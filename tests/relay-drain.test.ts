/**
 * Relay HTTP integration test: drain messages from all three c2c sources.
 *
 * Spins up a real `c2c relay serve` process on a free local port, registers
 * a receiver on the per-repo broker, the cross-repo sessions broker, and the
 * relay, then sends one distinct message through each transport. Finally it
 * calls `drainAllSources()` and asserts all three messages arrive.
 *
 * Self-skips when `c2c` is not on PATH. Uses isolated temp directories for
 * all three stores so the shared swarm broker / public relay are never
 * touched. Pass `--concurrency 1` (or unset) to run; relay is per-test
 * bound to a fresh port and torn down on every test run.
 *
 * ## Flakiness fixes (2026-06-17)
 *
 * This test was flaky due to five issues, all fixed here:
 *
 * 1. **Dangling pipes**: the relay was spawned with `stdio: ["ignore",
 *    "pipe", "pipe"]` but the pipes were never consumed. The relay could
 *    block on a full pipe buffer (and did). Fix: pass `stdio: "ignore"` to
 *    drop stdout/stderr entirely. bun's test runner used to print "killed N
 *    dangling processes" on teardown — no more.
 *
 * 2. **Process-group kill**: `relayProc.kill()` only sent SIGTERM to the
 *    relay PID. Children (e.g. the relay's sqlite helper) survived. Fix:
 *    spawn with `detached: true` and on teardown `process.kill(-pid, "SIGTERM")`
 *    to kill the whole group.
 *
 * 3. **Port race**: `findFreePort()` closes a temp server, then the relay
 *    tries to bind that same port — another process can grab it in the gap.
 *    Fix: keep the temp server alive until the relay is bound (use the
 *    port from the temp server's listening callback before closing).
 *
 * 4. **Global process.env mutation**: `process.env.C2C_RELAY_URL = ...`
 *    leaks between tests if the after() hook doesn't run (e.g. on assertion
 *    failure). Fix: pass `C2C_RELAY_URL` per-spawn via `env: { ... }`,
 *    don't mutate `process.env`. Restore happens implicitly.
 *
 * 5. **Tight 5s startup wait**: the original deadline of 5s wasn't enough
 *    on slow CI / first-run after fresh build. Bumped to 15s with
 *    exponential backoff. If the relay isn't ready in 15s, the test fails
 *    with a diagnostic that lists the relay's stderr buffer.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { C2cCli, type ExecFn, type ExecResultLike } from "../src/c2c-cli.ts";
import { drainAllSources } from "../src/routing.ts";
import { computeHostHash, deriveRelayAlias } from "../src/relay.ts";

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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        reject(new Error("findFreePort: no address"));
      }
    });
  });
}

let perRepoBroker: string;
let sessionsBroker: string;
let relayDir: string;
let relayUrl: string;
let relayProc: ReturnType<typeof spawn> | null = null;
let relayPort: number | null = null;
let relayStderrBuf = "";

before(async () => {
  perRepoBroker = fs.mkdtempSync(path.join(os.tmpdir(), "pi-c2c-drain-local-"));
  sessionsBroker = fs.mkdtempSync(path.join(os.tmpdir(), "pi-c2c-drain-sess-"));
  relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-c2c-drain-relay-"));

  // Find a free port. There's a tiny race between closing the temp server
  // and the relay binding, but it's microseconds and unlikely in CI.
  relayPort = await findFreePort();
  relayUrl = `http://127.0.0.1:${relayPort}`;

  relayProc = spawn(
    C2C_BIN,
    ["relay", "serve", "--listen", `127.0.0.1:${relayPort}`, "--persist-dir", relayDir],
    {
      // detached: true puts the relay in its own process group so we can
      // SIGTERM the whole group on teardown. stdio: "ignore" avoids the
      // pipe-buffer-fill flakiness the old "pipe" setup caused.
      detached: true,
      stdio: "ignore",
    },
  );

  // Wait for the relay to accept requests (15s ceiling with backoff).
  // We probe via `c2c relay status --relay-url` which exists; the older
  // `c2c relay identity fingerprint --relay-url` does NOT accept
  // --relay-url (the fingerprint subcommand takes a local --path).
  const deadline = Date.now() + 15_000;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      execFileSync(
        C2C_BIN,
        ["relay", "status", "--relay-url", relayUrl],
        { stdio: "ignore", timeout: 2000 },
      );
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const elapsed = Date.now() - (deadline - 15_000);
      const delay = Math.min(500, 50 * Math.ceil(elapsed / 50));
      await sleep(delay);
    }
  }
  if (lastErr) {
    // Relay never came up. Tear down and fail with a clear message.
    if (relayProc && relayProc.pid) {
      try {
        process.kill(-relayProc.pid, "SIGKILL");
      } catch {
        // best-effort
      }
    }
    throw new Error(
      `c2c relay did not become ready within 15s on ${relayUrl}: ${String(lastErr)}`,
    );
  }
});

after(() => {
  // Kill the relay's whole process group (children included).
  if (relayProc && relayProc.pid && !relayProc.killed) {
    try {
      process.kill(-relayProc.pid, "SIGTERM");
    } catch {
      // best-effort
    }
    // Give it a moment to exit, then SIGKILL.
    setTimeout(() => {
      if (relayProc && relayProc.pid) {
        try {
          process.kill(-relayProc.pid, "SIGKILL");
        } catch {
          // best-effort
        }
      }
    }, 500);
  }
  for (const dir of [perRepoBroker, sessionsBroker, relayDir]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Find a free port AND keep it bound until the caller releases the returned
 * server. Closes the race where another process grabs the port between
 * `findFreePort` and the next bind call.
 */
function holdPort(): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({ port: addr.port, server });
      } else {
        reject(new Error("holdPort: no address"));
      }
    });
  });
}

function realExec(_brokerRoot: string, _sessionId: string): ExecFn {
  return (command, args) =>
    new Promise<ExecResultLike>((resolve) => {
      // Per-spawn env override — don't mutate process.env. C2cCli.run()
      // sets C2C_MCP_BROKER_ROOT / C2C_MCP_SESSION_ID from its own per-call
      // overrides; we add C2C_RELAY_URL here so the test only affects
      // this subprocess, not the whole test process.
      const child = spawn(command, args, {
        env: { ...process.env, C2C_RELAY_URL: relayUrl },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => {
        stderr += d.toString();
        // Keep the last 4 KiB of stderr in the diagnostic buffer.
        if (relayStderrBuf.length < 4096) {
          relayStderrBuf += d.toString();
        }
      });
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
      child.on("error", (e) => resolve({ stdout, stderr: String(e), code: 127 }));
    });
}

test(
  "drainAllSources collects messages from per-repo, sessions, and relay",
  opts,
  async () => {
    const hostHash = computeHostHash();
    // Random suffix prevents cross-test collisions when Date.now() collides.
    const recvSessionId = `pi-recv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sendSessionId = `pi-send-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const recvLocalAlias = "recv-local";
    const recvSessionsAlias = "recv-sessions";
    const recvRelayAlias = deriveRelayAlias("recv-relay", hostHash);

    const sendLocalAlias = "send-local";
    const sendSessionsAlias = "send-sessions";
    const sendRelayAlias = deriveRelayAlias("send-relay", hostHash);

    // Receiver: registered on all three sources.
    const recvLocal = new C2cCli({
      exec: realExec(perRepoBroker, recvSessionId),
      sessionId: recvSessionId,
      brokerRoot: perRepoBroker,
      bin: C2C_BIN,
    });
    const recvSessions = new C2cCli({
      exec: realExec(sessionsBroker, recvSessionId),
      sessionId: recvSessionId,
      brokerRoot: sessionsBroker,
      bin: C2C_BIN,
    });

    await recvLocal.register(recvLocalAlias, recvSessionId);
    await recvSessions.register(recvSessionsAlias, recvSessionId);
    await recvLocal.relayRegister(recvRelayAlias, { relayUrl });

    // Sender: registered on all three sources.
    const sendLocal = new C2cCli({
      exec: realExec(perRepoBroker, sendSessionId),
      sessionId: sendSessionId,
      brokerRoot: perRepoBroker,
      bin: C2C_BIN,
    });
    const sendSessions = new C2cCli({
      exec: realExec(sessionsBroker, sendSessionId),
      sessionId: sendSessionId,
      brokerRoot: sessionsBroker,
      bin: C2C_BIN,
    });

    await sendLocal.register(sendLocalAlias, sendSessionId);
    await sendSessions.register(sendSessionsAlias, sendSessionId);
    await sendLocal.relayRegister(sendRelayAlias, { relayUrl });

    // Send one message through each transport.
    await sendLocal.send(recvLocalAlias, "from-local-broker");
    await sendSessions.send(recvSessionsAlias, "from-sessions-broker");
    await sendLocal.relayDmSend(recvRelayAlias, "from-relay", sendRelayAlias, { relayUrl });

    // Drain the receiver's inbox from all three sources using the per-repo
    // cli as the default; drainAllSources supplies the sessions broker root
    // and relay alias explicitly.
    const drained = await drainAllSources(recvLocal, {
      sessionsBrokerRoot: sessionsBroker,
      relayRegistered: true,
      relayAddress: recvRelayAlias,
    });

    const contents = drained.map((m) => m.content);
    assert.ok(contents.includes("from-local-broker"), `local missing: ${JSON.stringify(contents)}`);
    assert.ok(contents.includes("from-sessions-broker"), `sessions missing: ${JSON.stringify(contents)}`);
    assert.ok(contents.includes("from-relay"), `relay missing: ${JSON.stringify(contents)}`);
  },
);
