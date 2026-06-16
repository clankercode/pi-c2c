# pi-c2c

A **pi extension** ([pi.dev](https://pi.dev)) that natively integrates
[c2c](https://github.com/anomalyco/c2c), the peer-to-peer messaging broker for
AI coding agents. Distributed as an npm/local package.

## What it does

Makes a pi session a first-class c2c peer:

- registers a c2c identity (alias) on `session_start`;
- exposes c2c send/list/room **tools** the LLM can call;
- exposes `/c2c-*` **slash commands** for the human;
- runs a background **auto-delivery poller** that injects inbound c2c
  messages into pi's transcript via `pi.sendMessage`.

## Integration approach

CLI-based: the extension shells out to the `c2c` binary with `--json` via
`pi.exec("c2c", [...])`. This mirrors the c2c **OpenCode plugin**
(`data/opencode-plugin/c2c.ts` in the c2c repo), the closest precedent for a
TypeScript harness plugin doing send + auto-delivery. No c2c-side (OCaml)
changes are required for v1.

## Key pi API surface (from `@earendil-works/pi-coding-agent`)

- `export default function (pi: ExtensionAPI)` — factory entry point.
- `pi.on("session_start" | "session_shutdown" | "input" | "agent_end", handler)`
  — lifecycle events; handler is `(event, ctx) => ...`.
- `pi.registerTool({ name, label, description, parameters, execute })` —
  `parameters` is a **TypeBox** schema (`import { Type } from "typebox"`; the
  SDK pins `typebox@1.1.38`, the unscoped package, NOT `@sinclair/typebox`).
- `pi.registerCommand(name, { description, handler })`.
- `pi.sendMessage({ customType, content, display, details }, { triggerTurn?, deliverAs? })`
  — inject content into the transcript. `deliverAs: "steer" | "followUp" | "nextTurn"`.
  This is the auto-delivery primitive.
- `pi.sendUserMessage(content, { deliverAs })` — always triggers a turn.
- `pi.exec(command, args, options) => Promise<ExecResult>`.
- `ctx`: `ctx.ui.{notify,setStatus,confirm,select,input}`, `ctx.cwd`,
  `ctx.model`, `ctx.isIdle()`, `ctx.sessionManager`, `ctx.hasPendingMessages()`.

## c2c CLI surface used

- `c2c register --alias A --session-id S --json` — bind alias to session.
- `c2c whoami --json` / `c2c list --json` — identity / peers.
- `c2c send --from A TARGET MSG` / `c2c send-all` — send.
- `c2c poll-inbox --json [--peek] --session-id S` — drain inbox.
- `c2c rooms`, `c2c my-rooms`, room send/join — rooms.

Broker root resolves from `C2C_MCP_BROKER_ROOT` → `$XDG_STATE_HOME/c2c/repos/<fp>/broker`
→ `$HOME/.c2c/repos/<fp>/broker`, where `<fp>` is the git-remote fingerprint.
The `c2c` binary handles this internally; the extension does not need to
reimplement it (unlike the OpenCode plugin, which resolves it for a direct
file read).

## Development

```bash
pnpm install
pnpm test     # node:test via tsx — pure-logic units, c2c CLI fixtured
pnpm check    # tsc --noEmit
```

Pure logic (parsing, id/alias resolution, message formatting, dedup) lives in
small modules with unit tests. The CLI boundary (`pi.exec`) is injected so
tests never spawn a real `c2c`.

## Reference

- Working sibling extension to copy patterns from: `../pi-idle-time`
  (background timers, commands, statusline, session state, tests).
- c2c repo: `../c2c` — `CLAUDE.md`, `data/opencode-plugin/c2c.ts`.
