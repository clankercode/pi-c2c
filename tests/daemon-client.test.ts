/**
 * Unit tests for DaemonClient — the IPC client for the c2c relay subscribe-daemon.
 *
 * Tests the connect-first + flock-based spawn serialization, zombie reaping,
 * and cleanup logic without needing the real c2c binary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { ensureDaemon, killSpawnedDaemons, DaemonClient } from "../src/daemon-client.ts";

let counter = 0;
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-c2c-daemon-client-${++counter}-`));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

/**
 * Create a mock daemon script that listens on a Unix socket and responds
 * to JSON-line commands. Simulates `c2c relay subscribe-daemon`.
 */
function createMockDaemon(dir: string, socketPath: string): string {
  const scriptPath = path.join(dir, "mock-daemon");
  const script = `#!/usr/bin/env python3
import socket, os, sys, json, signal

socket_path = ${JSON.stringify(socketPath)}
pid_path = socket_path + ".pid"

try:
    os.unlink(socket_path)
except FileNotFoundError:
    pass

# Write PID file FIRST (before bind) so the caller can read it
# while we're setting up the socket.
with open(pid_path, "w") as f:
    f.write(str(os.getpid()) + "\\n")

sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind(socket_path)
sock.listen(5)

sys.stderr.write("listening on " + socket_path + "\\n")
sys.stderr.flush()

def handle_shutdown(signum, frame):
    try: os.unlink(socket_path)
    except: pass
    try: os.unlink(pid_path)
    except: pass
    sys.exit(0)

signal.signal(signal.SIGTERM, handle_shutdown)

while True:
    try:
        conn, _ = sock.accept()
    except OSError:
        break
    data = b""
    while True:
        chunk = conn.recv(4096)
        if not chunk: break
        data += chunk
        if b"\\n" in data: break
    line = data.decode("utf-8").strip()
    if not line:
        conn.close()
        continue
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        conn.close()
        continue

    cmd = req.get("cmd", "")
    if cmd == "register":
        resp = json.dumps({"ok": True, "id": req.get("id", ""), "alias": req.get("alias", "")})
    elif cmd == "deregister":
        resp = json.dumps({"ok": True, "id": req.get("id", ""), "alias": req.get("alias", "")})
    elif cmd == "list":
        resp = json.dumps({"ok": True, "aliases": []})
    elif cmd == "shutdown":
        resp = json.dumps({"ok": True})
        conn.sendall((resp + "\\n").encode())
        conn.close()
        handle_shutdown(None, None)
    else:
        resp = json.dumps({"ok": False, "error": "unknown command"})

    conn.sendall((resp + "\\n").encode())
    conn.close()
`;
  fs.writeFileSync(scriptPath, script);
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

async function connectAndCommand(socketPath: string, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(cmd) + "\n");
    });
    let buffer = "";
    client.on("data", (data) => {
      buffer += data.toString();
      const line = buffer.split("\n")[0]?.trim();
      if (line) {
        try { resolve(JSON.parse(line)); } catch { reject(new Error("Invalid JSON: " + line)); }
        client.destroy();
      }
    });
    client.on("error", reject);
    setTimeout(() => { client.destroy(); reject(new Error("timeout")); }, 3000);
  });
}

function killPid(pid: number): void {
  try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
}

async function waitForProcessExit(pid: number, timeoutMs = 3000): Promise<boolean> {
  return waitFor(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, timeoutMs);
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("ensureDaemon: starts daemon when none running", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "test.sock");
  const bin = createMockDaemon(dir, socketPath);

  try {
    const pid = await ensureDaemon(bin, socketPath);
    assert.ok(pid !== null && pid > 0, "should return daemon PID");

    // Verify daemon responds
    const resp = await connectAndCommand(socketPath, { cmd: "list" });
    assert.equal(resp.ok, true);

    killPid(pid!);
    await sleep(100);
    killSpawnedDaemons();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDaemon: reuses existing daemon (connect-first)", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "test.sock");
  const bin = createMockDaemon(dir, socketPath);

  try {
    const pid1 = await ensureDaemon(bin, socketPath);
    assert.ok(pid1 !== null, "first call should spawn");

    const pid2 = await ensureDaemon(bin, socketPath);
    assert.equal(pid2, null, "second call should return null (reused existing)");

    // Verify daemon responds
    const resp = await connectAndCommand(socketPath, { cmd: "list" });
    assert.equal(resp.ok, true);

    killPid(pid1!);
    await sleep(100);
    killSpawnedDaemons();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDaemon: concurrent calls reuse existing daemon", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "test.sock");
  const bin = createMockDaemon(dir, socketPath);

  try {
    // Spawn daemon first
    const pid = await ensureDaemon(bin, socketPath);
    assert.ok(pid !== null, "first call should spawn");

    // Now fire 5 concurrent ensureDaemon calls — all should reuse (return null)
    const results = await Promise.all([
      ensureDaemon(bin, socketPath),
      ensureDaemon(bin, socketPath),
      ensureDaemon(bin, socketPath),
      ensureDaemon(bin, socketPath),
      ensureDaemon(bin, socketPath),
    ]);

    // All should return null (reused existing daemon)
    assert.deepEqual(results, [null, null, null, null, null]);

    // Verify daemon still responds
    const resp = await connectAndCommand(socketPath, { cmd: "list" });
    assert.equal(resp.ok, true);

    killPid(pid!);
    await sleep(100);
    killSpawnedDaemons();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDaemon: cleans up stale socket before spawn", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "test.sock");
  const bin = createMockDaemon(dir, socketPath);

  try {
    // Create a stale socket (no daemon behind it, no pidfile)
    const staleServer = net.createServer();
    staleServer.listen(socketPath);
    await sleep(50);
    staleServer.close();
    await sleep(50);

    // ensureDaemon should clean up and spawn
    const pid = await ensureDaemon(bin, socketPath);
    assert.ok(pid !== null, "should spawn despite stale socket");

    const resp = await connectAndCommand(socketPath, { cmd: "list" });
    assert.equal(resp.ok, true);

    killPid(pid!);
    await sleep(100);
    killSpawnedDaemons();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDaemon: writes pidfile via daemon script", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "test.sock");
  const bin = createMockDaemon(dir, socketPath);

  try {
    const pid = await ensureDaemon(bin, socketPath);
    assert.ok(pid !== null && pid > 0, "should return a valid PID");

    // The mock daemon writes a pidfile
    const pidFile = socketPath + ".pid";
    assert.ok(fs.existsSync(pidFile), "pidfile should exist");

    const filePid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    assert.equal(filePid, pid, "returned PID should match pidfile");

    killPid(pid!);
    await sleep(100);
    killSpawnedDaemons();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("killSpawnedDaemons: kills all tracked daemons", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "test.sock");
  const bin = createMockDaemon(dir, socketPath);

  try {
    const pid = await ensureDaemon(bin, socketPath);
    assert.ok(pid !== null);

    // Verify alive
    try { process.kill(pid!, 0); } catch { assert.fail("daemon should be alive"); }

    killSpawnedDaemons();

    const exited = await waitForProcessExit(pid!, 2000);
    assert.ok(exited, "daemon should be dead after killSpawnedDaemons");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DaemonClient: register and list work end-to-end", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "test.sock");
  const bin = createMockDaemon(dir, socketPath);

  try {
    const client = new DaemonClient({ bin, socketPath });

    const regResult = await client.register("test-alias", "test-session-id");
    assert.equal(regResult.ok, true);
    assert.equal(regResult.alias, "test-alias");

    const listResult = await client.list();
    assert.equal(listResult.ok, true);

    await client.shutdown();
    await sleep(200);
  } finally {
    killSpawnedDaemons();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DaemonClient.connect: connects and receives registration", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "test.sock");
  const bin = createMockDaemon(dir, socketPath);

  try {
    await ensureDaemon(bin, socketPath);

    const client = new DaemonClient({ bin, socketPath });

    const registered = new Promise<boolean>((resolve) => {
      let settled = false;
      const handle = client.connect(
        "test-alias",
        "test-id",
        () => {},
        () => { if (!settled) { settled = true; resolve(true); handle.close(); } },
        () => { if (!settled) { settled = true; resolve(false); } },
        () => {},
      );
      setTimeout(() => { if (!settled) { settled = true; handle.close(); resolve(false); } }, 5000);
    });

    assert.ok(await registered, "should register successfully");
    killSpawnedDaemons();
    await sleep(100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("DaemonClient.connect: retries on ECONNREFUSED", async () => {
  const dir = tmpDir();
  const socketPath = path.join(dir, "test.sock");
  const bin = createMockDaemon(dir, socketPath);

  try {
    // Start daemon
    const pid = await ensureDaemon(bin, socketPath);
    assert.ok(pid !== null);

    const client = new DaemonClient({ bin, socketPath });

    // Connect successfully first
    const firstConnect = new Promise<boolean>((resolve) => {
      let settled = false;
      const handle = client.connect(
        "test-alias", "test-id", () => {},
        () => { if (!settled) { settled = true; resolve(true); handle.close(); } },
        () => { if (!settled) { settled = true; resolve(false); } },
        () => {},
      );
      setTimeout(() => { if (!settled) { settled = true; handle.close(); resolve(false); } }, 5000);
    });
    assert.ok(await firstConnect, "first connect should succeed");

    // Kill daemon and remove stale socket
    killPid(pid!);
    await sleep(200);
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
    try { fs.unlinkSync(socketPath + ".pid"); } catch { /* ignore */ }

    // Connect again — should trigger ECONNREFUSED → restart → reconnect
    const reconnected = new Promise<boolean>((resolve) => {
      let settled = false;
      const handle = client.connect(
        "test-alias", "test-id", () => {},
        () => { if (!settled) { settled = true; resolve(true); handle.close(); } },
        (err) => { if (!settled) { settled = true; console.error("reconnect error:", err.message); resolve(false); } },
        () => {},
      );
      setTimeout(() => { if (!settled) { settled = true; handle.close(); resolve(false); } }, 15000);
    });

    assert.ok(await reconnected, "should reconnect after daemon restart");
    killSpawnedDaemons();
    await sleep(100);
  } finally {
    killSpawnedDaemons();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
