/**
 * RelayWatcher — WebSocket-based push for the c2c public relay.
 *
 * Spawns `c2c relay subscribe --alias <alias> --relay-url <url>` as a child
 * process and watches its stdout for JSON lines. Each line is a DM frame:
 *   { "op": "dm", "from": "sender@hash", "body": "...", "ts": 1234 }
 *
 * On receiving a frame, fires `onChange()` — identical to how BrokerWatcher
 * fires `onChange()` on file changes. The actual draining is done by
 * `pollTick()` which calls `relayDmPoll`; the message is already stored in
 * the relay's outbox before the WebSocket push fires. This preserves symmetry
 * with BrokerWatcher and lets dedup handle any double-delivery.
 *
 * Why this architecture?
 *   - RelayWatcher is a *trigger*, not a drainer. It does not parse message
 *     bodies or maintain a queue — `pollTick` does that.
 *   - Reconnection with exponential backoff handles transient network issues.
 *   - A failing relay subscribe does not break local delivery — the 60s
 *     safety-net `pollTick` catches up.
 *
 * See: .collab/design/2026-06-17T04-14-27Z-pi-c01ea5-push-delivery-design.md
 * (slice 3) for the full design rationale.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** Callback fired when a relay DM frame arrives. */
export type OnChange = () => void;

export type RelayWatcherState = "connected" | "reconnecting" | "stopped";

export interface RelayWatcherOptions {
  /** The relay alias/address (e.g. "pi-abc@3d08761ae3f3"). */
  alias: string;
  /** The relay URL (e.g. "https://relay.c2c.im"). */
  relayUrl: string;
  /** Path to the c2c binary. Defaults to "c2c". */
  bin?: string;
  /** Called on each DM frame. Should be non-blocking. */
  onChange: OnChange;
  /** Called when state changes (for debug tracking). */
  onStateChange?: (state: RelayWatcherState) => void;
  /**
   * Debounce window in ms. Burst events within this window collapse to one
   * onChange call. Default 50ms — same as BrokerWatcher.
   */
  debounceMs?: number;
}

export class RelayWatcher {
  private child: ChildProcess | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private _state: RelayWatcherState = "stopped";
  private stopped = false;
  private backoffMs = 1000;
  private stderrBuffer = "";
  private lineBuffer = "";
  private readonly debounceMs: number;
  private readonly bin: string;
  private readonly sessionId: string;

  constructor(private readonly opts: RelayWatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 50;
    this.bin = opts.bin ?? "c2c";
    // Unique session id for the child process to avoid conflicts with the
    // main c2c MCP session.
    this.sessionId = `relay-watcher-${crypto.randomBytes(8).toString("hex")}`;
  }

  /** True if the watcher is currently active (not stopped). */
  get isRunning(): boolean {
    return this.child !== null && !this.stopped;
  }

  /** Current state of the watcher. */
  get state(): RelayWatcherState {
    return this._state;
  }

  /**
   * Start watching. Spawns the `c2c relay subscribe` process.
   * Safe to call if the binary doesn't exist — logs a warning and no-ops.
   */
  start(): void {
    if (this.stopped) {
      throw new Error("RelayWatcher: cannot start a stopped watcher");
    }
    if (this.child) return; // idempotent

    // Check if the binary exists (for non-PATH binaries).
    const binPath = this.bin;
    if (binPath.includes(path.sep)) {
      if (!fs.existsSync(binPath)) {
        // Binary doesn't exist — no-op with a diagnostic.
        // We don't throw because this is a best-effort optimization.
        return;
      }
    }

    this.spawnChild();
  }

  /** Stop watching and kill the child process. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.setState("stopped");
    this.cleanup();
  }

  private setState(state: RelayWatcherState): void {
    if (this._state === state) return;
    this._state = state;
    try {
      this.opts.onStateChange?.(state);
    } catch {
      // Swallow — caller is responsible for its own error handling.
    }
  }

  private cleanup(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.child) {
      this.child.kill("SIGTERM");
      this.child = null;
    }
    this.lineBuffer = "";
  }

  private spawnChild(): void {
    if (this.stopped) return;

    const args = [
      "relay",
      "subscribe",
      "--alias",
      this.opts.alias,
      "--relay-url",
      this.opts.relayUrl,
    ];

    try {
      this.child = spawn(this.bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          C2C_MCP_SESSION_ID: this.sessionId,
        },
      });
    } catch {
      // Spawn failed (e.g. binary not found in PATH). Schedule reconnect.
      this.scheduleReconnect();
      return;
    }

    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");

    this.child.stdout?.on("data", (chunk: string) => {
      this.onStdoutData(chunk);
    });

    this.child.stderr?.on("data", (chunk: string) => {
      // Capture stderr for diagnostics (last 2KB).
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 2048) {
        this.stderrBuffer = this.stderrBuffer.slice(-2048);
      }
    });

    this.child.on("error", () => {
      // Spawn error — schedule reconnect.
      this.child = null;
      this.scheduleReconnect();
    });

    this.child.on("exit", (_code, _signal) => {
      this.child = null;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  private onStdoutData(chunk: string): void {
    // Buffer partial lines.
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    // Keep the last partial line in the buffer.
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        // Validate it's JSON (we don't need to parse the content — just
        // confirm it's a valid frame). pollTick will do the actual drain.
        JSON.parse(trimmed);

        // First successful line means we're connected. Reset backoff.
        if (this._state !== "connected") {
          this.setState("connected");
          this.backoffMs = 1000;
        }

        // Schedule onChange (debounced).
        this.scheduleFire();
      } catch {
        // Not valid JSON — skip. Could be a startup banner or error.
      }
    }
  }

  private scheduleFire(): void {
    if (this.debounceTimer) return; // already scheduled
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.stopped) return;
      try {
        this.opts.onChange();
      } catch {
        // Swallow — caller is responsible for its own error handling.
      }
    }, this.debounceMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;

    this.setState("reconnecting");

    // Clear any existing reconnect timer.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.spawnChild();
    }, this.backoffMs);

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (cap).
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
  }
}
