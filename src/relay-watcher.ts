/**
 * RelayWatcher — daemon-based push for the c2c public relay.
 *
 * Registers the alias with the c2c relay subscribe-daemon via IPC.
 * The daemon manages the WebSocket connection; RelayWatcher receives
 * DM notifications through the daemon's IPC socket.
 *
 * Falls back to direct `c2c relay subscribe` child process if the daemon
 * is unavailable and auto-start fails.
 *
 * See: .collab/design/2026-06-28T00-31+1000-relay-subscription-multiplexing.md
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { DaemonClient, type DaemonMessage } from "./daemon-client.ts";

/** Callback fired when a relay DM frame arrives. */
export type OnChange = () => void;

export type RelayWatcherState = "connected" | "reconnecting" | "stopped";

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
  const args = command.trim().split(/\s+/);
  return {
    pid: Number.parseInt(pidRaw, 10),
    ppid: Number.parseInt(ppidRaw, 10),
    args,
  };
}

function cleanupUntrackedOrphanSubscribeProcesses(alias: string, knownPids: Set<number>): void {
  let output = "";
  try {
    output = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
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
  cleanupUntrackedOrphanSubscribeProcesses(opts.alias, knownPids);
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
  /** Debounce window in ms. Default 50ms. */
  debounceMs?: number;
  /** Path to the daemon socket. */
  daemonSocketPath?: string;
  /**
   * Use daemon mode (register with subscribe-daemon) instead of spawning
   * a child process. Default: true. Set to false to fall back to direct
   * `c2c relay subscribe` child process mode.
   */
  useDaemon?: boolean;
}

export class RelayWatcher {
  private debounceTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private _state: RelayWatcherState = "stopped";
  private stopped = false;
  private backoffMs = 1000;
  private readonly debounceMs: number;
  private readonly bin: string;
  private readonly sessionId: string;
  private readonly useDaemon: boolean;
  private daemonClient: DaemonClient | null = null;
  private daemonConnection: { close: () => void; deregister: () => void } | null = null;
  private daemonRegistered = false;
  private daemonFailures = 0;
  private static readonly MAX_DAEMON_FAILURES = 3;

  // Legacy child process mode (fallback)
  private child: ChildProcess | null = null;
  private stderrBuffer = "";
  private lineBuffer = "";
  private trackedPid: number | null = null;

  constructor(private readonly opts: RelayWatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 50;
    this.bin = opts.bin ?? "c2c";
    this.sessionId = `relay-watcher-${crypto.randomBytes(8).toString("hex")}`;
    this.useDaemon = opts.useDaemon ?? true;
  }

  get isRunning(): boolean {
    if (this.useDaemon) {
      return this.daemonRegistered && !this.stopped;
    }
    return this.child !== null && !this.stopped;
  }

  get state(): RelayWatcherState {
    return this._state;
  }

  start(): void {
    if (this.stopped) {
      throw new Error("RelayWatcher: cannot start a stopped watcher");
    }
    if (this.useDaemon) {
      this.startDaemonAsync();
    } else {
      this.startChildProcess();
    }
  }

  stop(): void {
    this.stopped = true;
    this.setState("stopped");
    if (this.useDaemon) {
      this.cleanupDaemon();
    } else {
      this.cleanupChildProcess();
    }
  }

  // === Daemon mode ===

  private startDaemonAsync(): void {
    if (this.daemonRegistered) return;
    registerActiveWatcher(this);

    this.daemonClient = new DaemonClient({
      bin: this.bin,
      socketPath: this.opts.daemonSocketPath,
      relayUrl: subscribeRelayUrl(this.opts.relayUrl),
    });

    void cleanupStaleRelayWatcherProcesses({ alias: this.opts.alias }).catch(() => {});

    // Async: ensure daemon is running, then connect
    void this.daemonClient.ensureDaemon()
      .then(() => {
        if (this.stopped) return;
        this.daemonConnection = this.daemonClient!.connect(
          this.opts.alias,
          this.sessionId,
          // onMessage
          (msg: DaemonMessage) => {
            if (this.stopped) return;
            if (msg.type === "dm") {
              this.scheduleFire();
            } else if (msg.type === "state" && msg.state === "connected") {
              if (this._state !== "connected") {
                this.setState("connected");
                this.backoffMs = 1000;
              }
            }
          },
          // onRegistered — daemon confirmed registration
          () => {
            this.daemonRegistered = true;
            this.daemonFailures = 0;
            this.setState("connected");
            this.backoffMs = 1000;
          },
          // onError
          (err: Error) => {
            if (!this.stopped) {
              this.daemonRegistered = false;
              this.daemonConnection = null;
              this.daemonFailures++;
              if (this.daemonFailures >= RelayWatcher.MAX_DAEMON_FAILURES) {
                // Fall back to child process mode
                this.daemonClient = null;
                this.startChildProcess();
              } else {
                this.scheduleReconnect();
              }
            }
          },
          // onClose — daemon disconnected
          () => {
            if (!this.stopped) {
              this.daemonRegistered = false;
              this.daemonConnection = null;
              this.daemonFailures++;
              if (this.daemonFailures >= RelayWatcher.MAX_DAEMON_FAILURES) {
                this.daemonClient = null;
                this.startChildProcess();
              } else {
                this.scheduleReconnect();
              }
            }
          },
        );
      })
      .catch((err: Error) => {
        // Daemon failed to start — fall back to child process
        if (!this.stopped) {
          this.daemonFailures = RelayWatcher.MAX_DAEMON_FAILURES;
          this.daemonClient = null;
          this.startChildProcess();
        }
      });
  }

  private cleanupDaemon(): void {
    if (this.daemonConnection) {
      this.daemonConnection.deregister();
      this.daemonConnection = null;
    }
    this.daemonRegistered = false;
    unregisterActiveWatcher(this);
  }

  // === Child process mode (fallback) ===

  private startChildProcess(): void {
    if (this.child) return; // idempotent

    void cleanupStaleRelayWatcherProcesses({ alias: this.opts.alias }).catch(() => {});

    const binPath = this.bin;
    if (binPath.includes(path.sep)) {
      if (!fs.existsSync(binPath)) return;
    }

    registerActiveWatcher(this);
    this.spawnChild();
  }

  private cleanupChildProcess(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.child) {
      const pid = this.trackedPid ?? this.child.pid;
      this.child.stdout?.destroy();
      this.child.stderr?.destroy();
      this.child.kill("SIGTERM");
      this.child = null;
      if (pid && pid !== this.trackedPid) {
        try {
          unregisterRelayWatcherPid(pid, this.sessionId);
        } catch { /* best-effort */ }
      }
      this.unregisterTrackedPid();
    }
    unregisterActiveWatcher(this);
    this.lineBuffer = "";
  }

  private unregisterTrackedPid(): void {
    if (!this.trackedPid) return;
    try {
      unregisterRelayWatcherPid(this.trackedPid, this.sessionId);
    } catch { /* best-effort */ }
    this.trackedPid = null;
  }

  private setState(state: RelayWatcherState): void {
    if (this._state === state) return;
    this._state = state;
    try {
      this.opts.onStateChange?.(state);
    } catch { /* swallow */ }
  }

  private spawnChild(): void {
    if (this.stopped) return;

    const args = [
      "relay", "subscribe",
      "--alias", this.opts.alias,
      "--relay-url", subscribeRelayUrl(this.opts.relayUrl),
    ];

    try {
      this.child = spawn(this.bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, C2C_MCP_SESSION_ID: this.sessionId },
      });
    } catch {
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
      } catch { /* best-effort */ }
    }

    this.setState("connected");
    this.backoffMs = 1000;

    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");

    this.child.stdout?.on("data", (chunk: string) => {
      this.onStdoutData(chunk);
    });

    this.child.stderr?.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
      if (this.stderrBuffer.length > 2048) {
        this.stderrBuffer = this.stderrBuffer.slice(-2048);
      }
    });

    this.child.on("error", () => {
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
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        JSON.parse(trimmed);
        if (this._state !== "connected") {
          this.setState("connected");
          this.backoffMs = 1000;
        }
        this.scheduleFire();
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  private scheduleFire(): void {
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.stopped) return;
      try {
        this.opts.onChange();
      } catch { /* swallow */ }
    }, this.debounceMs);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setState("reconnecting");

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      if (this.useDaemon) {
        this.daemonRegistered = false;
        this.daemonConnection = null;
        this.startDaemonAsync();
      } else {
        this.spawnChild();
      }
    }, this.backoffMs);

    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
  }
}

function subscribeRelayUrl(relayUrl: string): string {
  return relayUrl.replace(/^https:\/\//i, "http://");
}
