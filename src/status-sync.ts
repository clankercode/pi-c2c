/**
 * Status synchronization tracker for pi-c2c.
 *
 * Tracks the local session's runtime state from pi SDK lifecycle hooks and
 * broadcasts structured status envelopes to c2c peers. Broadcasts are
 * throttled and coalesced so rapid event flapping does not spam the broker.
 */

export type KnownStatusState = "idle" | "processing" | "tool" | "input";
/** Accept any string so peers with newer state vocabularies still render cleanly. */
export type StatusState = KnownStatusState | (string & {});

export interface StatusEnvelope {
  event: "status";
  from: string;
  state: StatusState;
  since: string;
  ttl_ms: number;
}

export interface StatusRecord {
  state: StatusState;
  since: number;
  ttlMs: number;
}

export interface StatusTrackerOptions {
  alias: string;
  minIntervalMs?: number;
  inputTtlMs?: number;
  toolTtlMs?: number;
  processingTtlMs?: number;
  idleTtlMs?: number;
  now?: () => number;
}

export type BroadcastFn = (envelope: StatusEnvelope) => Promise<void> | void;

const DEFAULT_MIN_INTERVAL_MS = 2_000;
const DEFAULT_INPUT_TTL_MS = 5_000;
const DEFAULT_TOOL_TTL_MS = 30_000;
const DEFAULT_PROCESSING_TTL_MS = 60_000;
const DEFAULT_IDLE_TTL_MS = 60_000;

function ttlFor(state: StatusState, opts: Required<StatusTrackerOptions>): number {
  switch (state) {
    case "input":
      return opts.inputTtlMs;
    case "tool":
      return opts.toolTtlMs;
    case "processing":
      return opts.processingTtlMs;
    case "idle":
      return opts.idleTtlMs;
    default:
      return opts.idleTtlMs;
  }
}

export interface StatusTracker {
  transition(state: StatusState): void;
  getStatus(): StatusRecord;
  setBroadcast(fn: BroadcastFn | undefined): void;
  dispose(): void;
}

/**
 * Create a status tracker.
 *
 * The tracker keeps a current state and schedules broadcasts. It only emits
 * when the effective state changes, and never more often than
 * `minIntervalMs`. If transitions arrive while a broadcast is delayed, the
 * pending state is updated and a single broadcast is sent at the next slot.
 */
export function createStatusTracker(opts: StatusTrackerOptions): StatusTracker {
  const alias = opts.alias;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const resolved: Required<StatusTrackerOptions> = {
    alias,
    minIntervalMs,
    inputTtlMs: opts.inputTtlMs ?? DEFAULT_INPUT_TTL_MS,
    toolTtlMs: opts.toolTtlMs ?? DEFAULT_TOOL_TTL_MS,
    processingTtlMs: opts.processingTtlMs ?? DEFAULT_PROCESSING_TTL_MS,
    idleTtlMs: opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
    now: opts.now ?? (() => Date.now()),
  };

  let current: StatusRecord = {
    state: "idle",
    since: resolved.now(),
    ttlMs: resolved.idleTtlMs,
  };
  let previousNonInputState: StatusState = "idle";

  let broadcastFn: BroadcastFn | undefined;
  let pendingState: StatusState | undefined;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let inputRevertTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBroadcastAt = 0;
  let disposed = false;

  function buildEnvelope(state: StatusState, since: number): StatusEnvelope {
    return {
      event: "status",
      from: alias,
      state,
      since: new Date(since).toISOString(),
      ttl_ms: ttlFor(state, resolved),
    };
  }

  function clearBroadcastTimer(): void {
    if (broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
  }

  function clearInputTimer(): void {
    if (inputRevertTimer) {
      clearTimeout(inputRevertTimer);
      inputRevertTimer = null;
    }
  }

  function clearTimers(): void {
    clearBroadcastTimer();
    clearInputTimer();
    pendingState = undefined;
  }

  function doBroadcast(state: StatusState, since: number): void {
    if (disposed) return;
    lastBroadcastAt = resolved.now();
    pendingState = undefined;
    broadcastTimer = null;
    if (!broadcastFn) return;
    try {
      const result = broadcastFn(buildEnvelope(state, since));
      if (result && typeof result.catch === "function") {
        result.catch(() => {
          // Broadcast failures are best-effort; the next transition will retry.
        });
      }
    } catch {
      // Synchronous failures are also best-effort.
    }
  }

  function scheduleBroadcast(state: StatusState, since: number): void {
    if (disposed) return;
    pendingState = state;
    const elapsed = resolved.now() - lastBroadcastAt;
    const delay = Math.max(0, minIntervalMs - elapsed);

    if (broadcastTimer) return; // already waiting for a slot; pendingState was updated above

    broadcastTimer = setTimeout(() => {
      if (disposed) return;
      doBroadcast(pendingState ?? current.state, current.since);
    }, delay);
  }

  function maybeBroadcast(state: StatusState, since: number): void {
    if (disposed) return;

    // If the state we last broadcast (or have queued) is already this, skip.
    if (state === pendingState && broadcastTimer) return;
    if (state === current.state && !broadcastTimer && lastBroadcastAt > 0) {
      // Already broadcast this state and no pending change; no-op.
      return;
    }

    scheduleBroadcast(state, since);
  }

  return {
    transition(state: StatusState): void {
      if (disposed) return;

      const now = resolved.now();
      const oldState = current.state;
      current = { state, since: now, ttlMs: ttlFor(state, resolved) };

      if (state !== "input") {
        previousNonInputState = state;
      }

      // Input is transient: revert to the previous non-input state after its
      // TTL unless another transition arrives first.
      if (state === "input") {
        clearInputTimer();
        inputRevertTimer = setTimeout(() => {
          if (disposed) return;
          if (current.state === "input") {
            current = {
              state: previousNonInputState,
              since: resolved.now(),
              ttlMs: ttlFor(previousNonInputState, resolved),
            };
            maybeBroadcast(previousNonInputState, current.since);
          }
        }, resolved.inputTtlMs);
      } else {
        clearInputTimer();
      }

      // If this is a real state change, broadcast it (subject to throttle).
      if (state !== oldState || lastBroadcastAt === 0) {
        maybeBroadcast(state, now);
      }
    },

    getStatus(): StatusRecord {
      return { ...current };
    },

    setBroadcast(fn: BroadcastFn | undefined): void {
      broadcastFn = fn;
    },

    dispose(): void {
      disposed = true;
      clearTimers();
      broadcastFn = undefined;
    },
  };
}

/**
 * Render a status record as the XML envelope used by c2c.
 */
export function formatStatusEnvelope(envelope: StatusEnvelope): string {
  return (
    `<c2c event="status" from="${escapeXml(envelope.from)}" ` +
    `state="${envelope.state}" since="${envelope.since}" ttl_ms="${envelope.ttl_ms}" />`
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Parse a status envelope from raw c2c content. Tolerant: returns `null` for
 * any envelope that is not a well-formed status update.
 *
 * Status envelopes are often delivered as the body of a normal c2c message,
 * and peer content is sanitized so that `<c2c` becomes `‹c2c` (U+2039) to
 * prevent envelope-breakout attacks. We normalize that back before parsing so
 * our own status broadcasts render correctly while still ignoring genuinely
 * malformed peer content.
 */
export function parseStatusEnvelope(content: string): StatusEnvelope | null {
  const normalized = content.replace(/‹c2c/g, "<c2c");
  const match = normalized.match(
    /<c2c\s+event="status"\s+from="([^"]*)"\s+state="([^"]*)"\s+since="([^"]*)"\s+ttl_ms="([^"]*)"\s*\/?>/,
  );
  if (!match) return null;
  const state = match[2] as StatusState;
  if (!isValidState(state)) return null;
  const ttl = Number(match[4]);
  if (!Number.isFinite(ttl) || ttl < 0) return null;
  return {
    event: "status",
    from: match[1],
    state,
    since: match[3],
    ttl_ms: ttl,
  };
}

function isValidState(value: string): value is StatusState {
  return value.length > 0 && value.length <= 64;
}
