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

import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

/** Callback fired when a relay DM frame arrives. */
export type OnChange = () => void;

export type RelayWatcherState = "connected" | "reconnecting" | "stopped";

function subscribeRelayUrl(relayUrl: string): string {
  return relayUrl.replace(/^https:\/\//i, "http://");
}

export const RELAY_WATCHER_PID_FILE_ENV = "C2C_PI_RELAY_WATCHER_PID_FILE";

export interface RelayWatcherPidRecord {
  alias: string;
  sessionId: string;
  pid: number;
  ownerPid: number;
  startedAt: number;
}

interface RelayWatcherPidRegistry {
  version: 1;
  records: RelayWatcherPidRecord[];
}

const PID_REGISTRY_VERSION = 1;
const EXIT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
const activeWatchers = new Set<RelayWatcher>();
const signalHandlers = new Map<NodeJS.Signals, () => void>();
let exitHandlerInstalled = false;

function relayWatcherPidFile(): string {
  return process.env[RELAY_WATCHER_PID_FILE_ENV]
    ?? path.join(os.homedir(), ".pi", "c2c", "relay-watcher-pids.json");
}

function isPositivePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

function isProcessAlive(pid: number): boolean {
  if (!isPositivePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function normalizePidRegistry(raw: unknown): RelayWatcherPidRegistry {
  const records = Array.isArray((raw as { records?: unknown })?.records)
    ? (raw as { records: unknown[] }).records
    : [];
  return {
    version: PID_REGISTRY_VERSION,
    records: records.flatMap((r): RelayWatcherPidRecord[] => {
      if (!r || typeof r !== "object") return [];
      const rec = r as Partial<RelayWatcherPidRecord>;
      if (typeof rec.alias !== "string" || typeof rec.sessionId !== "string") return [];
      if (!isPositivePid(rec.pid ?? 0) || !isPositivePid(rec.ownerPid ?? 0)) return [];
      if (typeof rec.startedAt !== "number" || !Number.isFinite(rec.startedAt)) return [];
      return [{
        alias: rec.alias,
        sessionId: rec.sessionId,
        pid: rec.pid!,
        ownerPid: rec.ownerPid!,
        startedAt: rec.startedAt,
      }];
    }),
  };
}

function readPidRegistry(pidFile = relayWatcherPidFile()): RelayWatcherPidRegistry {
  try {
    return normalizePidRegistry(JSON.parse(fs.readFileSync(pidFile, "utf8")));
  } catch {
    return { version: PID_REGISTRY_VERSION, records: [] };
  }
}

function writePidRegistry(registry: RelayWatcherPidRegistry, pidFile = relayWatcherPidFile()): void {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const tmp = `${pidFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
  fs.renameSync(tmp, pidFile);
}

function updatePidRegistry(
  mutator: (records: RelayWatcherPidRecord[]) => RelayWatcherPidRecord[],
  pidFile = relayWatcherPidFile(),
): void {
  const current = readPidRegistry(pidFile);
  const records = mutator(current.records);
  writePidRegistry({ version: PID_REGISTRY_VERSION, records }, pidFile);
}

function registerRelayWatcherPid(record: RelayWatcherPidRecord, pidFile = relayWatcherPidFile()): void {
  updatePidRegistry(
    (records) => [
      ...records.filter((r) => !(r.pid === record.pid && r.sessionId === record.sessionId)),
      record,
    ],
    pidFile,
  );
}

function unregisterRelayWatcherPid(pid: number, sessionId: string, pidFile = relayWatcherPidFile()): void {
  updatePidRegistry(
    (records) => records.filter((r) => !(r.pid === pid && r.sessionId === sessionId)),
    pidFile,
  );
}

function procCmdline(pid: number): string[] | null {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const args = raw.split("\0").filter(Boolean);
    return args.length > 0 ? args : null;
  } catch {
    return null;
  }
}

function commandHasRelaySubscribeAlias(args: string[], alias: string): boolean {
  const relayIndex = args.indexOf("relay");
  const subscribeIndex = args.indexOf("subscribe");
  const aliasFlagIndex = args.indexOf("--alias");
  return relayIndex >= 0
    && subscribeIndex > relayIndex
    && aliasFlagIndex >= 0
    && args[aliasFlagIndex + 1] === alias;
}

function commandLineLooksLikeRecord(pid: number, alias: string): boolean {
  const args = procCmdline(pid);
  return args ? commandHasRelaySubscribeAlias(args, alias) : true;
}

function killProcess(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already dead or not ours to kill; cleanup will still prune the record.
  }
}

function aliasPrefix(alias: string): string {
  return alias.split("@")[0] ?? alias;
}

function parsedAliasMatchesPrefix(processAlias: string, targetAlias: string): boolean {
  if (processAlias === targetAlias) return true;
  const target = aliasPrefix(targetAlias);
  const candidate = aliasPrefix(processAlias);
  return candidate === target || candidate.startsWith(`${target}-a`);
}

function parsePsSubscribeLine(line: string): { pid: number; ppid: number; args: string[] } | null {
  const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
  if (!m) return null;
  const [, pidRaw, ppidRaw, command] = m;
  // c2c relay aliases never contain whitespace, and we only need enough shell
  // splitting to find the fixed flags in `c2c relay subscribe --alias <alias>`.
  const args = command.trim().split(/\s+/);
  return {
    pid: Number.parseInt(pidRaw, 10),
    ppid: Number.parseInt(ppidRaw, 10),
    args,
  };
}

async function cleanupUntrackedOrphanSubscribeProcesses(alias: string, knownPids: Set<number>): Promise<void> {
  let output = "";
  try {
    output = await new Promise<string>((resolve, reject) => {
      execFile("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" }, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  } catch {
    return;
  }
  for (const line of output.split("\n")) {
    const row = parsePsSubscribeLine(line);
    if (!row || row.ppid !== 1 || knownPids.has(row.pid) || row.pid === process.pid) continue;
    const aliasFlagIndex = row.args.indexOf("--alias");
    const processAlias = aliasFlagIndex >= 0 ? row.args[aliasFlagIndex + 1] : undefined;
    if (!processAlias || !parsedAliasMatchesPrefix(processAlias, alias)) continue;
    if (!commandHasRelaySubscribeAlias(row.args, processAlias)) continue;
    killProcess(row.pid);
  }
}

export async function cleanupStaleRelayWatcherProcesses(opts: { alias: string; pidFile?: string }): Promise<void> {
  const pidFile = opts.pidFile ?? relayWatcherPidFile();
  const current = readPidRegistry(pidFile);
  const next: RelayWatcherPidRecord[] = [];
  const knownPids = new Set<number>();

  for (const record of current.records) {
    const childAlive = isProcessAlive(record.pid);
    const ownerAlive = isProcessAlive(record.ownerPid);
    if (!childAlive) continue;
    knownPids.add(record.pid);

    if (parsedAliasMatchesPrefix(record.alias, opts.alias) && !ownerAlive && commandLineLooksLikeRecord(record.pid, record.alias)) {
      killProcess(record.pid);
      continue;
    }

    next.push(record);
  }

  if (next.length !== current.records.length) {
    writePidRegistry({ version: PID_REGISTRY_VERSION, records: next }, pidFile);
  }
  await cleanupUntrackedOrphanSubscribeProcesses(opts.alias, knownPids);
}

function cleanupActiveRelayWatchers(): void {
  for (const watcher of [...activeWatchers]) {
    watcher.stop();
  }
}

function handleExit(): void {
  cleanupActiveRelayWatchers();
}

function handleSignal(signal: NodeJS.Signals): void {
  cleanupActiveRelayWatchers();
  for (const [registeredSignal, handler] of signalHandlers) {
    process.removeListener(registeredSignal, handler);
  }
  signalHandlers.clear();
  const exitCode = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129;
  process.exit(exitCode);
}

function registerActiveWatcher(watcher: RelayWatcher): void {
  activeWatchers.add(watcher);
  if (!exitHandlerInstalled) {
    process.once("exit", handleExit);
    exitHandlerInstalled = true;
  }
  for (const signal of EXIT_SIGNALS) {
    if (signalHandlers.has(signal)) continue;
    const handler = () => handleSignal(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function unregisterActiveWatcher(watcher: RelayWatcher): void {
  activeWatchers.delete(watcher);
  if (activeWatchers.size > 0) return;
  if (exitHandlerInstalled) {
    process.removeListener("exit", handleExit);
    exitHandlerInstalled = false;
  }
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
  signalHandlers.clear();
}

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
  private trackedPid: number | null = null;

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

    // Fire-and-forget: cleanup is best-effort; don't block watcher startup.
    void cleanupStaleRelayWatcherProcesses({ alias: this.opts.alias }).catch(() => {});

    // Check if the binary exists (for non-PATH binaries).
    const binPath = this.bin;
    if (binPath.includes(path.sep)) {
      if (!fs.existsSync(binPath)) {
        // Binary doesn't exist — no-op with a diagnostic.
        // We don't throw because this is a best-effort optimization.
        return;
      }
    }

    registerActiveWatcher(this);
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

  private unregisterTrackedPid(): void {
    if (!this.trackedPid) return;
    try {
      unregisterRelayWatcherPid(this.trackedPid, this.sessionId);
    } catch {
      // Best-effort cleanup; the next watcher start will prune stale records.
    }
    this.trackedPid = null;
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
      // Release our read ends of the child's pipes before killing it. If the
      // child has spawned its own children that inherited the stdout/stderr
      // fds, those grandchildren can keep the write end (and thus our read
      // end) open after the child dies — which keeps the Node event loop
      // alive indefinitely. Destroying the streams drops our handles so the
      // process can exit promptly on stop().
      const pid = this.trackedPid ?? this.child.pid;
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      this.child.kill("SIGTERM");
      this.child = null;
      if (pid && pid !== this.trackedPid) {
        try {
          unregisterRelayWatcherPid(pid, this.sessionId);
        } catch {
          // Best-effort cleanup; the next watcher start will prune stale records.
        }
      }
      this.unregisterTrackedPid();
    }
    unregisterActiveWatcher(this);
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
      subscribeRelayUrl(this.opts.relayUrl),
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

    if (this.child.pid) {
      this.trackedPid = this.child.pid;
      try {
        registerRelayWatcherPid({
          alias: this.opts.alias,
          sessionId: this.sessionId,
          pid: this.child.pid,
          ownerPid: process.pid,
          startedAt: Date.now(),
        });
      } catch {
        // PID tracking is a cleanup aid, not required for relay delivery.
      }
    }

    this.setState("connected");
    this.backoffMs = 1000;

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
      this.unregisterTrackedPid();
      this.child = null;
      this.scheduleReconnect();
    });

    this.child.on("exit", (_code, _signal) => {
      this.unregisterTrackedPid();
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
