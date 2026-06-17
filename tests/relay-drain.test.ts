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
 * touched.
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

let perRepoBroker: string;
let sessionsBroker: string;
let relayDir: string;
let relayUrl: string;
let relayProc: ReturnType<typeof spawn> | null = null;
let oldRelayUrl: string | undefined;

before(async () => {
  perRepoBroker = fs.mkdtempSync(path.join(os.tmpdir(), "pi-c2c-drain-local-"));
  sessionsBroker = fs.mkdtempSync(path.join(os.tmpdir(), "pi-c2c-drain-sess-"));
  relayDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-c2c-drain-relay-"));

  const port = await findFreePort();
  relayUrl = `http://127.0.0.1:${port}`;
  oldRelayUrl = process.env.C2C_RELAY_URL;
  process.env.C2C_RELAY_URL = relayUrl;

  relayProc = spawn(
    C2C_BIN,
    ["relay", "serve", "--listen", `127.0.0.1:${port}`, "--persist-dir", relayDir],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Wait for the relay to accept requests (5s max).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      execFileSync(C2C_BIN, ["relay", "identity", "fingerprint", "--relay-url", relayUrl], {
        stdio: "ignore",
      });
      break;
    } catch {
      await sleep(50);
    }
  }
});

after(() => {
  if (relayProc && !relayProc.killed) {
    relayProc.kill();
  }
  if (oldRelayUrl === undefined) {
    delete process.env.C2C_RELAY_URL;
  } else {
    process.env.C2C_RELAY_URL = oldRelayUrl;
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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
    srv.on("error", reject);
  });
}

function realExec(_brokerRoot: string, _sessionId: string): ExecFn {
  return (command, args) =>
    new Promise<ExecResultLike>((resolve) => {
      // Let C2cCli.run() set C2C_MCP_BROKER_ROOT / C2C_MCP_SESSION_ID from
      // its own per-call overrides. Explicitly overriding those here would
      // defeat cross-broker pollInbox() calls (e.g. sessions broker drain).
      const child = spawn(command, args, {
        env: { ...process.env, C2C_RELAY_URL: relayUrl },
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

test(
  "drainAllSources collects messages from per-repo, sessions, and relay",
  opts,
  async () => {
    const hostHash = computeHostHash();
    const recvSessionId = "pi-recv-" + Date.now();
    const sendSessionId = "pi-send-" + Date.now();

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
