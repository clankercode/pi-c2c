/**
 * DaemonClient — IPC client for the c2c relay subscribe-daemon.
 *
 * Communicates with the daemon over a Unix socket using a JSON-line protocol.
 * Handles auto-starting the daemon if it's not running.
 *
 * Concurrency safety: a cross-process file lock (<socket>.lock) serializes
 * daemon auto-start so that N concurrent watchers produce at most one daemon.
 * Losers wait for the lock, then find the daemon already running and connect.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface DaemonDmMessage {
  type: "dm";
  to: string;
  from: string;
  body: string;
  ts: number;
}

export interface DaemonStateMessage {
  type: "state";
  alias: string;
  state: string;
}

export type DaemonMessage = DaemonDmMessage | DaemonStateMessage;

export interface RegisterResult {
  ok: boolean;
  id: string;
  alias: string;
  error?: string;
}

export interface DeregisterResult {
  ok: boolean;
  id: string;
  alias: string;
  error?: string;
}

// ── Module-level daemon tracking ─────────────────────────────────────────────

const spawnedDaemons = new Map<string, { pid: number; socketPath: string }>();

function defaultSocketPath(): string {
  const home = os.homedir();
  return path.join(home, ".c2c", "relay-subscribe.sock");
}

// ── Lock + spawn helpers ─────────────────────────────────────────────────────

function lockPath(socketPath: string): string {
  return socketPath + ".lock";
}

/**
 * Read the daemon PID from the pidfile (written by the c2c daemon itself).
 * Returns null if the file is missing, malformed, or the process is dead.
 */
function readDaemonPid(socketPath: string): number | null {
  const pidFile = socketPath + ".pid";
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const pid = parseInt(raw, 10);
    if (isNaN(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * Try connecting to the daemon socket (async). Returns true if the daemon
 * accepts a connection within timeoutMs.
 */
function tryConnect(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(result);
    };
    const sock = net.createConnection(socketPath);
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
    sock.on("close", () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

/**
 * Ensure the daemon is running. Uses connect-first + flock serialization:
 *
 *   1. Fast path: try connecting — if it works, daemon is alive.
 *   2. Acquire cross-process flock (<socket>.lock) to serialize spawn.
 *   3. Under lock: re-check (another process may have spawned while we waited).
 *   4. If still no daemon: clean up stale socket, spawn, wait for "listening".
 *   5. Lock released when flock shell exits.
 *
 * The lock+spawn+wait runs entirely inside `execSync` (flock child), so the
 * flock is held for the full duration. After return, we read the daemon's
 * pidfile to track it for cleanup.
 *
 * Returns the daemon PID if we spawned it, or null if reused an existing one.
 */
export async function ensureDaemon(
  bin: string,
  socketPath: string,
  relayUrl?: string,
): Promise<number | null> {
  // 1. Fast path: try connecting to existing daemon (no lock needed)
  if (await tryConnect(socketPath)) {
    return null;
  }

  const lp = lockPath(socketPath);
  const relayArgs = relayUrl ? `--relay-url ${JSON.stringify(relayUrl)}` : "";

  // 2. Write the lock+spawn script to a temp file to avoid quoting hell.
  const scriptPath = socketPath + ".spawn.sh";
  const script = `#!/bin/bash
set -e
# Re-check under lock: is another daemon already listening?
if python3 -c 'import socket; s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.connect(${JSON.stringify(socketPath)}); s.close()' 2>/dev/null; then
  exit 0
fi
# Clean up stale socket
PIDFILE=${JSON.stringify(socketPath)}.pid
if [ -S ${JSON.stringify(socketPath)} ]; then
  if [ ! -f "$PIDFILE" ] || ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    rm -f ${JSON.stringify(socketPath)}
  fi
fi
# Spawn daemon in background (nohup so it survives shell exit + SIGHUP)
nohup ${JSON.stringify(bin)} relay subscribe-daemon ${relayArgs} --socket ${JSON.stringify(socketPath)} >/dev/null 2>&1 &
# Wait for socket to appear
DEADLINE=$((SECONDS + 10))
while [ $SECONDS -lt $DEADLINE ]; do
  if [ -S ${JSON.stringify(socketPath)} ]; then
    sleep 0.2
    exit 0
  fi
  sleep 0.1
done
exit 1
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });

  try {
    execSync(`flock -x -w 15 ${JSON.stringify(lp)} ${JSON.stringify(scriptPath)}`, {
      stdio: "ignore",
      timeout: 20000,
    });
  } catch (e) {
    // If we can't get the lock or spawn, try connecting anyway
    if (await tryConnect(socketPath)) return null;
    throw new Error(`Failed to ensure daemon: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
  }

  // 3. Read the daemon PID from the pidfile (daemon writes it)
  //    Retry a few times since the daemon may write it slightly after
  //    the socket appears.
  let daemonPid: number | null = null;
  for (let i = 0; i < 10; i++) {
    daemonPid = readDaemonPid(socketPath);
    if (daemonPid !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  if (daemonPid !== null) {
    spawnedDaemons.set(socketPath, { pid: daemonPid, socketPath });
  }
  return daemonPid;
}

/**
 * Send a single request and wait for a single response over a new socket connection.
 */
function sendRequest(socketPath: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(request) + "\n");
    });

    let buffer = "";
    const timeout = setTimeout(() => {
      settle(() => {
        client.destroy();
        reject(new Error("Request timed out"));
      });
    }, 5000);

    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (line) {
          try {
            const response = JSON.parse(line);
            settle(() => {
              clearTimeout(timeout);
              client.end();
              resolve(response);
            });
            return;
          } catch {
            // Not valid JSON, keep reading
          }
        }
      }
      buffer = lines[lines.length - 1] ?? "";
    });

    client.on("error", (err) => {
      settle(() => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    client.on("end", () => {
      if (buffer.trim()) {
        try {
          settle(() => {
            clearTimeout(timeout);
            resolve(JSON.parse(buffer.trim()));
          });
          return;
        } catch { /* ignore */ }
      }
      settle(() => {
        clearTimeout(timeout);
        reject(new Error("Connection ended without valid JSON response"));
      });
    });
  });
}

export interface DaemonClientOptions {
  /** Path to the c2c binary. */
  bin?: string;
  /** Path to the daemon socket. */
  socketPath?: string;
  /** Relay URL for auto-starting the daemon. */
  relayUrl?: string;
}

export class DaemonClient {
  private readonly bin: string;
  private readonly socketPath: string;
  private readonly relayUrl?: string;

  constructor(opts: DaemonClientOptions = {}) {
    this.bin = opts.bin ?? "c2c";
    this.socketPath = opts.socketPath ?? defaultSocketPath();
    this.relayUrl = opts.relayUrl;
  }

  /**
   * Ensure the daemon is running. Auto-starts if needed.
   */
  async ensureDaemon(): Promise<void> {
    await ensureDaemon(this.bin, this.socketPath, this.relayUrl);
  }

  /**
   * Register an alias with the daemon. Auto-starts daemon if needed.
   */
  async register(alias: string, id: string): Promise<RegisterResult> {
    await this.ensureDaemon();
    return sendRequest(this.socketPath, { cmd: "register", alias, id }) as unknown as Promise<RegisterResult>;
  }

  /**
   * Deregister an alias from the daemon.
   */
  async deregister(alias: string, id: string): Promise<DeregisterResult> {
    return sendRequest(this.socketPath, { cmd: "deregister", alias, id }) as unknown as Promise<DeregisterResult>;
  }

  /**
   * List registered aliases.
   */
  async list(): Promise<{ ok: boolean; aliases?: Array<{ alias: string; state: string; started_at: number }> }> {
    await this.ensureDaemon();
    return sendRequest(this.socketPath, { cmd: "list" }) as unknown as Promise<{ ok: boolean; aliases?: Array<{ alias: string; state: string; started_at: number }> }>;
  }

  /**
   * Shutdown the daemon.
   */
  async shutdown(): Promise<void> {
    try {
      await sendRequest(this.socketPath, { cmd: "shutdown" });
    } catch {
      // Daemon might already be dead
    }
  }

  /**
   * Connect to the daemon and listen for messages (DMs and state changes).
   * Returns a connection handle with close() and deregister() methods.
   *
   * If the initial connection fails with ECONNREFUSED, attempts to restart
   * the daemon and retry once.
   */
  connect(
    alias: string,
    id: string,
    onMessage: (msg: DaemonMessage) => void,
    onRegistered: () => void,
    onError: (err: Error) => void,
    onClose: () => void,
  ): { close: () => void; deregister: () => void } {
    let retried = false;
    const wrappedOnError = (err: Error) => {
      const isConnRefused = err.message.includes("ECONNREFUSED") ||
        (err as NodeJS.ErrnoException).code === "ECONNREFUSED" ||
        err.message.includes("ENOENT") ||
        (err as NodeJS.ErrnoException).code === "ENOENT";
      if (isConnRefused && !retried) {
        retried = true;
        try { fs.unlinkSync(this.socketPath); } catch { /* ignore */ }
        void ensureDaemon(this.bin, this.socketPath, this.relayUrl)
          .then(() => {
            this._connect(alias, id, onMessage, onRegistered, onError, onClose);
          })
          .catch(() => {
            onError(err);
          });
        return;
      }
      onError(err);
    };

    return this._connect(alias, id, onMessage, onRegistered, wrappedOnError, onClose);
  }

  private _connect(
    alias: string,
    id: string,
    onMessage: (msg: DaemonMessage) => void,
    onRegistered: () => void,
    onError: (err: Error) => void,
    onClose: () => void,
  ): { close: () => void; deregister: () => void } {
    const client = net.createConnection(this.socketPath);
    let registered = false;
    let buffer = "";

    const regTimeout = setTimeout(() => {
      if (!registered) {
        client.destroy();
        onError(new Error("Registration timed out"));
      }
    }, 10000);

    client.on("connect", () => {
      const request = JSON.stringify({ cmd: "register", alias, id }) + "\n";
      client.write(request);
    });

    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (!registered && msg.ok === true && msg.alias === alias) {
            registered = true;
            clearTimeout(regTimeout);
            onRegistered();
            continue;
          }
          if (msg.type === "dm" || msg.type === "state") {
            onMessage(msg as DaemonMessage);
          }
        } catch {
          // Not valid JSON, skip
        }
      }
      buffer = lines[lines.length - 1] ?? "";
    });

    client.on("error", (err) => {
      clearTimeout(regTimeout);
      onError(err);
    });

    client.on("end", () => {
      clearTimeout(regTimeout);
      onClose();
    });

    client.on("close", () => {
      clearTimeout(regTimeout);
      onClose();
    });

    return {
      close: () => {
        clearTimeout(regTimeout);
        client.destroy();
      },
      deregister: () => {
        try {
          const request = JSON.stringify({ cmd: "deregister", alias, id }) + "\n";
          client.write(request);
          setTimeout(() => client.destroy(), 200);
        } catch {
          client.destroy();
        }
      },
    };
  }

  getSocketPath(): string {
    return this.socketPath;
  }
}

/**
 * Kill all daemons spawned by this process. Called on process exit to prevent
 * orphaned daemon processes.
 */
export function killSpawnedDaemons(): void {
  for (const [socketPath, entry] of spawnedDaemons) {
    try {
      process.kill(entry.pid, "SIGTERM");
    } catch {
      // Already dead or not ours
    }
    spawnedDaemons.delete(socketPath);
  }
}

let exitHandlerInstalled = false;
function ensureExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  const cleanup = () => { killSpawnedDaemons(); };
  process.once("exit", cleanup);
  process.once("SIGINT", () => { cleanup(); process.exit(130); });
  process.once("SIGTERM", () => { cleanup(); process.exit(143); });
}

/**
 * Public API: install the exit handler. Call once at extension init.
 */
export function installDaemonCleanup(): void {
  ensureExitHandler();
}
