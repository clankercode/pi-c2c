# pi-c2c status synchronization — PLAN

## Goal
Broadcast the local pi session's runtime status to c2c peers and render inbound peer status updates in the TUI.

## Status protocol
- Envelope shape (mirrors the existing message envelope so parsers stay simple):
  ```xml
  <c2c event="status" from="alias" state="idle|processing|tool|input" since="ISO-8601" ttl_ms="number" />
  ```
- `state` values:
  - `idle` — agent is idle.
  - `processing` — agent loop / turn is running.
  - `tool` — a tool is executing inside an active turn.
  - `input` — transient: user just submitted input; reverts after `input_ttl_ms`.
- `since` is the ISO timestamp when this state became current.
- `ttl_ms` is a hint for how long the state should be considered fresh (`input` is short; others are longer).
- Transport: broadcast via `c2c_send_all` (existing CLI wrapper). This keeps routing identical to normal messages and reaches every peer.
- Privacy / scope: broadcast only when the extension is registered. Status carries no prompt text; the `input` state reveals only that the user typed, not what they typed.

## Module boundaries
### `src/status-sync.ts` (new)
Pure-ish tracker + broadcast scheduler:
- `StatusState` union and `StatusEnvelope` type.
- `createStatusTracker(opts)` returns an object with:
  - `transition(state, reason?)` — move to a new state.
  - `getStatus()` — current `{ state, since, ttlMs }`.
  - `setBroadcast(fn)` — register the async function that sends via c2c.
  - `dispose()` — clean up timers.
- Throttling:
  - `minIntervalMs` (default 2000, overridable via `C2C_PI_STATUS_INTERVAL_MS`).
  - Only broadcast when the *effective* state changes (ignoring rapid transitions back to the same state).
  - Coalesce flapping: if a transition arrives while a broadcast is pending, update the pending state; do not queue extra sends.
  - Never broadcast before `session_start` registration succeeds.
- TTL defaults:
  - `input`: 5000 ms
  - `tool`: 30000 ms
  - `processing`: 60000 ms
  - `idle`: 60000 ms

### `src/index.ts` changes
- Import `createStatusTracker`.
- After successful registration, instantiate tracker and pass it a broadcast function that calls `r.cli.sendAll(formatStatusEnvelope(...))`.
- Wire SDK hooks:
  - `input` -> `tracker.transition("input")`.
  - `agent_start` -> `tracker.transition("processing")`.
  - `agent_end` -> `tracker.transition(ctx.isIdle() ? "idle" : "processing")`.
  - `tool_execution_start` -> `tracker.transition("tool")`.
  - `tool_execution_end` -> `tracker.transition(ctx.isIdle() ? "idle" : "processing")`.
  - `turn_start` -> `tracker.transition("processing")`.
  - `turn_end` -> `tracker.transition(ctx.isIdle() ? "idle" : "processing")`.
- On `session_shutdown`, call `tracker.dispose()` and clear reference.
- Optional `c2c_status` tool and `/c2c-status-now` command that return `getStatus()` text.

### `src/ui/compact-message.ts` changes
- Extend `ParsedEnvelope` to include optional `event` and `state`.
- `parseC2cEnvelopes` recognizes `event="status"` and extracts `state`, `since`, `ttl_ms`.
- `buildCompactLine` / `buildExpandedComponent` render status updates:
  - collapsed: `◈ c2c · lyra-quill is processing`
  - expanded: header + `lyra-quill: state=processing since=...`
- Keep `content` (the XML envelope) intact for model parity.

### Tests
- `tests/status-sync.test.ts`: state transitions, throttling, coalescing, TTL values, broadcast callback invocation, dispose behavior.
- `tests/ui/compact-message.test.ts`: add cases for status envelope parsing and rendering.
- Ensure all existing tests still pass.

## Acceptance criteria
- `tsc --noEmit` passes.
- `node --import tsx --test tests/*.test.ts tests/**/*.test.ts` passes.
- Status broadcasts only on meaningful transitions and is throttled.
- Inbound status renders compactly.
- Feature degrades gracefully when not registered.
- Existing message envelope shape unchanged.
