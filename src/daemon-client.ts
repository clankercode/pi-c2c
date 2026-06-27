/**
 * DaemonClient — IPC client for the c2c relay subscribe-daemon.
 *
 * Communicates with the daemon over a Unix socket using a JSON-line protocol.
 * Handles auto-starting the daemon if it's not running.
 */

import { spawn } from "node:child_process";
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

function defaultSocketPath(): string {
  const home = os.homedir();
  return path.join(home, ".c2c", "relay-subscribe.sock");
}

/**
 * Check if the daemon socket exists AND the owning process is alive.
 * Stale sockets (from crashes) are cleaned up.
 */
function isDaemonRunning(socketPath: string): boolean {
  const pidFile = socketPath + ".pid";
  try {
    if (!fs.existsSync(socketPath)) return false;
    if (!fs.existsSync(pidFile)) {
      // Socket exists but no PID file — try probing the socket
      return probeSocket(socketPath);
    }
    const pid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
    if (isNaN(pid)) return false;
    try {
      process.kill(pid, 0); // Check if process exists
      return true;
    } catch {
      // Process is dead, clean up stale socket
      try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Probe a socket with a short connection attempt.
 * Returns true if the socket accepts connections.
 */
function probeSocket(socketPath: string): boolean {
  try {
    const sock = require("net").createConnection(socketPath);
    let ok = false;
    sock.on("connect", () => { ok = true; sock.destroy(); });
    sock.on("error", () => { sock.destroy(); });
    // Synchronous wait — this is only called during startup
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && !ok) {
      // Busy wait — acceptable for startup only
      const start = Date.now();
      while (Date.now() - start < 10) { /* spin 10ms */ }
    }
    return ok;
  } catch {
    return false;
  }
}

/**
 * Start the daemon process. Waits for it to print "listening on" before resolving.
 */
function startDaemon(bin: string, socketPath: string, relayUrl?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["relay", "subscribe-daemon"];
    if (relayUrl) {
      args.push("--relay-url", relayUrl);
    }
    // Always pass socket path so daemon uses the same path client expects
    args.push("--socket", socketPath);

    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Daemon startup timed out. stderr: ${stderr.slice(-500)}`));
    }, 10000);

    child.stderr?.on("data", (chunk: string) => {
      if (chunk.includes("listening on")) {
        clearTimeout(timeout);
        child.unref();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.disconnect?.();
        setTimeout(resolve, 200);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Daemon exited with code ${code}. stderr: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Send a single request and wait for a single response over a new socket connection.
 * Properly clears timeout and cleans up on all exit paths.
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
    if (isDaemonRunning(this.socketPath)) {
      return;
    }
    await startDaemon(this.bin, this.socketPath, this.relayUrl);
  }

  /**
   * Register an alias with the daemon. Auto-starts daemon if needed.
   */
  async register(alias: string, id: string): Promise<RegisterResult> {
    await this.ensureDaemon();
    const response = await sendRequest(this.socketPath, {
      cmd: "register",
      alias,
      id,
    }) as unknown as RegisterResult;
    return response;
  }

  /**
   * Deregister an alias from the daemon.
   */
  async deregister(alias: string, id: string): Promise<DeregisterResult> {
    const response = await sendRequest(this.socketPath, {
      cmd: "deregister",
      alias,
      id,
    }) as unknown as DeregisterResult;
    return response;
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
   * The deregister sends the deregister command over the SAME socket so
   * the daemon can properly track which connection owns which aliases.
   */
  connect(
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

    // Registration timeout
    const regTimeout = setTimeout(() => {
      if (!registered) {
        client.destroy();
        onError(new Error("Registration timed out"));
      }
    }, 10000);

    client.on("connect", () => {
      // Send register command
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
            // Registration response
            registered = true;
            clearTimeout(regTimeout);
            onRegistered();
            continue;
          }
          // DM or state message
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
        // Send deregister over the SAME socket connection
        try {
          const request = JSON.stringify({ cmd: "deregister", alias, id }) + "\n";
          client.write(request);
          // Give the daemon a moment to process, then close
          setTimeout(() => client.destroy(), 200);
        } catch {
          client.destroy();
        }
      },
    };
  }

  /**
   * Get the socket path (for debugging).
   */
  getSocketPath(): string {
    return this.socketPath;
  }
}
