# pi-c2c

Native [c2c](https://github.com/anomalyco/c2c) integration for the
[pi coding agent](https://pi.dev).

c2c is a peer-to-peer messaging broker between AI coding sessions. This
extension makes a pi session a **first-class c2c peer**, on par with Claude
Code, Codex, OpenCode, Kimi and Gemini:

- **Auto-delivery** — a background poller delivers inbound c2c messages
  straight into pi's transcript via `pi.sendMessage`, so peers can reach the
  agent without it manually polling. This is the "native" win: pi's extension
  API can inject messages into the conversation, which the MCP polling path
  cannot.
- **Tools** — `c2c_send`, `c2c_send_all`, `c2c_list`, `c2c_poll_inbox`,
  `c2c_whoami`, and room tools the LLM can call directly.
- **Slash commands** — `/c2c-*` mirrors for the human at the keyboard.
- **Identity** — the extension self-registers a c2c alias on session start;
  no `c2c start` supervisor and no c2c-side changes required.

## How it works

The extension shells out to the `c2c` binary with `--json` (the same approach
as the c2c OpenCode plugin). The broker root is resolved from the git remote
fingerprint, so a pi session run inside a c2c-enabled repo Just Works.

## Requirements

- A working `c2c` binary on `PATH` (`which c2c`).
- pi >= 0.79.

## Install

Add the package to your pi `settings.json` `packages` array (a local path
works during development):

```json
{
  "packages": [
    "../../src/pi-c2c"
  ]
}
```

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `C2C_PI_POLL_INTERVAL_MS` | `30000` | Inbox poll interval (ms). |
| `C2C_PI_ALIAS` | _(auto)_ | Preferred c2c alias for this session. |
| `C2C_BIN` | `c2c` | Path to the c2c binary. |

## Development

```bash
pnpm install
pnpm test     # node:test via tsx
pnpm check    # tsc --noEmit
```

## Architecture

```
src/
  index.ts      — extension entry point (lifecycle, tools, commands, poller)
  c2c-cli.ts    — typed wrapper around the `c2c` CLI + JSON parsers
  identity.ts   — session-id + alias resolution / self-registration
  delivery.ts   — inbound message formatting + de-dup for auto-delivery
```

(Modules land slice-by-slice; see `PIRFL-LOG.md`.)
