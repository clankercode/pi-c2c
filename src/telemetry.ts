/**
 * Live telemetry collector for pi-c2c.
 *
 * Records runtime counters, timestamps, and small previews used by the
 * `/c2c-live-debug` dashboard. All state is stored in a single mutable
 * object so the TUI component can read it on every render.
 */

export type MessageSource = "local" | "sessions" | "relay" | "spool" | "unknown";

export interface LastReceivedMessage {
  from: string;
  preview: string;
  source: MessageSource;
  at: number;
}

export interface LastSentMessage {
  to: string;
  via: string;
  at: number;
}

export interface BrokerHealth {
  lastOkAt: number | undefined;
  lastErrorAt: number | undefined;
  lastError: string | undefined;
}

export interface LiveTelemetryState {
  sessionStartAt: number | undefined;
  pollCount: number;
  lastPollAt: number | undefined;
  lastPollDurationMs: number | undefined;
  messagesReceived: number;
  messagesInjected: number;
  messagesSent: number;
  lastReceived: LastReceivedMessage | undefined;
  lastSent: LastSentMessage | undefined;
  lastInjectAt: number | undefined;
  lastErrorAt: number | undefined;
  lastError: string | undefined;
  brokerHealth: Record<string, BrokerHealth>;
  relayHealth: BrokerHealth;
  spoolCount: number;
  peerStatusCount: number;
}

export interface LiveTelemetrySnapshot extends LiveTelemetryState {
  now: number;
}

/** Mutable telemetry store. Safe to read from the TUI render thread. */
export interface LiveTelemetry {
  startSession(now?: number): void;
  beginPoll(now?: number): void;
  endPoll(now?: number): void;
  recordReceived(msg: { from: string; content: string; source?: MessageSource }, now?: number): void;
  recordInjected(count: number, now?: number): void;
  recordSent(target: string, via: string, now?: number): void;
  recordBrokerOk(source: string, now?: number): void;
  recordBrokerError(source: string, error: unknown, now?: number): void;
  recordRelayOk(now?: number): void;
  recordRelayError(error: unknown, now?: number): void;
  recordSpoolCount(count: number): void;
  recordPeerStatusCount(count: number): void;
  recordError(error: unknown, now?: number): void;
  snapshot(now?: number): LiveTelemetrySnapshot;
  getState(): LiveTelemetryState;
}

function defaultNow(): number {
  return Date.now();
}

function errorString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function previewOf(content: string, maxChars = 120): string {
  const lines = content.split("\n");
  const first = lines[0]?.trim() ?? "";
  const second = lines[1]?.trim() ?? "";
  const joined = second ? `${first} ${second}` : first;
  const collapsed = joined.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, maxChars - 1)}…`;
}

class LiveTelemetryImpl implements LiveTelemetry {
  private state: LiveTelemetryState;
  private pollStartAt: number | undefined;

  constructor(private readonly nowFn: () => number = defaultNow) {
    this.state = {
      sessionStartAt: undefined,
      pollCount: 0,
      lastPollAt: undefined,
      lastPollDurationMs: undefined,
      messagesReceived: 0,
      messagesInjected: 0,
      messagesSent: 0,
      lastReceived: undefined,
      lastSent: undefined,
      lastInjectAt: undefined,
      lastErrorAt: undefined,
      lastError: undefined,
      brokerHealth: {},
      relayHealth: { lastOkAt: undefined, lastErrorAt: undefined, lastError: undefined },
      spoolCount: 0,
      peerStatusCount: 0,
    };
  }

  startSession(now = this.nowFn()): void {
    this.state.sessionStartAt = now;
  }

  beginPoll(now = this.nowFn()): void {
    this.pollStartAt = now;
  }

  endPoll(now = this.nowFn()): void {
    this.state.pollCount += 1;
    this.state.lastPollAt = now;
    if (this.pollStartAt !== undefined) {
      this.state.lastPollDurationMs = now - this.pollStartAt;
    }
    this.pollStartAt = undefined;
  }

  recordReceived(
    msg: { from: string; content: string; source?: MessageSource },
    now = this.nowFn(),
  ): void {
    this.state.messagesReceived += 1;
    this.state.lastReceived = {
      from: msg.from || "unknown",
      preview: previewOf(msg.content),
      source: msg.source ?? "unknown",
      at: now,
    };
  }

  recordInjected(count: number, now = this.nowFn()): void {
    this.state.messagesInjected += count;
    this.state.lastInjectAt = now;
  }

  recordSent(target: string, via: string, now = this.nowFn()): void {
    this.state.messagesSent += 1;
    this.state.lastSent = {
      to: target,
      via,
      at: now,
    };
  }

  private ensureBroker(source: string): BrokerHealth {
    let h = this.state.brokerHealth[source];
    if (!h) {
      h = { lastOkAt: undefined, lastErrorAt: undefined, lastError: undefined };
      this.state.brokerHealth[source] = h;
    }
    return h;
  }

  recordBrokerOk(source: string, now = this.nowFn()): void {
    this.ensureBroker(source).lastOkAt = now;
  }

  recordBrokerError(source: string, error: unknown, now = this.nowFn()): void {
    const h = this.ensureBroker(source);
    h.lastErrorAt = now;
    h.lastError = errorString(error);
    this.recordError(error, now);
  }

  recordRelayOk(now = this.nowFn()): void {
    this.state.relayHealth.lastOkAt = now;
  }

  recordRelayError(error: unknown, now = this.nowFn()): void {
    this.state.relayHealth.lastErrorAt = now;
    this.state.relayHealth.lastError = errorString(error);
    this.recordError(error, now);
  }

  recordSpoolCount(count: number): void {
    this.state.spoolCount = count;
  }

  recordPeerStatusCount(count: number): void {
    this.state.peerStatusCount = count;
  }

  recordError(error: unknown, now = this.nowFn()): void {
    this.state.lastErrorAt = now;
    this.state.lastError = errorString(error);
  }

  snapshot(now = this.nowFn()): LiveTelemetrySnapshot {
    return { ...this.state, now };
  }

  getState(): LiveTelemetryState {
    return { ...this.state };
  }
}

/** Create a new telemetry store. */
export function createLiveTelemetry(now?: () => number): LiveTelemetry {
  return new LiveTelemetryImpl(now);
}

/** Format a timestamp as a compact relative or absolute string. */
export function formatTimestamp(at: number | undefined, now: number): string {
  if (at === undefined) return "never";
  const ageMs = now - at;
  if (ageMs < 0) return "future";
  if (ageMs < 1_000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

/** Format a duration in ms as a compact string. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
