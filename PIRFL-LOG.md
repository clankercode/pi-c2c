# pi-c2c — PIRFL log

Plan → Implement → Review → Fix → Loop. One section per slice.

## Goal

A native pi extension making a pi session a first-class c2c peer
(send + auto-delivery into the transcript). Standalone repo, mirrors
`../pi-idle-time`. v1 = tools + auto-delivery, identity self-registered.

## Plan (slices)

- **S0** Scaffold repo (package.json, tsconfig, gitignore, AGENTS/README, skeleton). Gate: `tsc --noEmit` clean.
- **S1** `c2c-cli.ts` — typed `runC2c` (injectable exec) + JSON parsers. Unit-tested.
- **S2** `identity.ts` — session-id + alias resolution / self-register. Unit-tested.
- **S3** Tools + `/c2c-*` commands wired to the wrapper + identity.
- **S4** Auto-delivery poller — idle-gated, dedup, inject via `pi.sendMessage`. Unit-tested.
- **S5** Live dogfood — tmux Claude↔pi DM round-trip.

## Log

### S0 — Scaffold

- Implemented: package.json (pi.extensions, peerDeps SDK+tui, devDeps incl. `typebox@1.1.38`),
  tsconfig (mirror idle-time), .gitignore, LICENSE (MIT), README, AGENTS, skeleton `src/index.ts`
  (factory + `/c2c-status` command + session_start/shutdown status hooks).
- Key API facts captured (see AGENTS.md): tool params use `typebox` (unscoped),
  `pi.sendMessage(..., {deliverAs})` is the auto-delivery primitive, `pi.exec` for CLI.
- Gate: `tsc --noEmit` — see below.

### S2 — Identity
- `identity.ts`: `deriveSessionId` (namespace `pi-`), `resolveAlias` (configured | `pi-<sha6>`),
  `computeIdentity`, `establishIdentity` (best-effort register; never throws). 26 tests, tsc clean.

### S4 (core) — Delivery (pure)
- `delivery.ts`: `formatEnvelope` (parity with OpenCode plugin envelope incl. `reply_via="c2c_send"`),
  `messageKey` (NUL-separated), `DeliveryDedup` (bounded LRU), `selectNovel`, `deliveryOptionsFor`
  (idle→triggerTurn, busy→followUp), `notifySummary`. 35 tests total, tsc clean.
- Caught + cleaned stray NUL bytes from a tool-serialization quirk; scanned all files (src clean).

### S3 + S4 (wiring) — index.ts
- Tools: c2c_send, c2c_send_all, c2c_list, c2c_poll_inbox, c2c_whoami, c2c_join_room,
  c2c_send_room, c2c_rooms. Slash: /c2c-status, -whoami, -peers, -inbox, -send.
- Poller: setInterval(pollIntervalMs, default 30s), serialized drains (mutex shared with manual
  poll tool), idle-aware injection via pi.sendMessage. session_shutdown clears timer.
- CLI extended with room methods + parseRoomList. 40 tests total, tsc clean.
- Command handler `args` is a STRING (not array) — fixed /c2c-send to regex-parse.

### Review round 1 (adversarial workflow: 5 lenses + per-finding refutation)
- 16 findings, 13 confirmed, 3 refuted (refuted: followUp-drop, no-session-ready-guard, multi-turn-overlap — all matched design intent).
- Fixes (all 13):
  - **BLOCKER** send-from-refused: pi never set C2C_MCP_SESSION_ID → broker caller-owns-alias check refused all sends.
    Fix: `process.env.C2C_MCP_SESSION_ID = identity.sessionId` after register; dropped `--from` on tool sends (env resolves caller). Respects ambient env if preset.
  - whoami no longer passes `--session-id` (CLI rejects it, exit 124) — resolves from env.
  - `--` end-of-options separator before all positionals (send/sendAll/sendRoom/join/leave/roomHistory) — leading-dash target/body no longer parsed as flags (covers 3 findings incl. 2 security).
  - parseRoomList reads real `room_id`; parsePeers reads `registered_at` not nonexistent `lastSeenAge` (dropped seen-ago UI).
  - Delivery reliability: new `spool.ts` (drained msgs persisted before inject, cleared after success, replayed on tick/start); split `selectNovel`→`filterNovel`(no mutate)+`markDelivered`(after success); `shuttingDown` flag stops in-flight drain during teardown.
  - `sanitizeContent` neutralizes `<c2c`/`</c2c` in peer content → no envelope breakout / forged-frame prompt injection.
- Gate: 54 tests, tsc clean.
