# pi-c2c

Native [c2c](https://github.com/clankercode/c2c) integration for
[pi](https://pi.dev).

pi-c2c makes a pi session a c2c peer:

- registers a c2c alias on session start;
- exposes c2c send, list, inbox, and room tools to the model;
- exposes `/c2c-*` slash commands for the human;
- polls for inbound c2c messages and injects them into the pi transcript.

## pi-subagents

When `pi-c2c` is loaded in a parent pi session that also uses
`pi-subagents`, every non-isolated subagent becomes its own c2c peer. The
child registers an independent c2c session id derived from the child pi
session, so parent and child inboxes stay separate.

Child aliases are parent-scoped:

```text
<parentAlias>-a<hash6>
```

The hash is derived from the subagent id when `pi-subagents` provides one,
otherwise from the child pi session id. Subagents do not reuse the parent
`C2C_MCP_SESSION_ID`, and they do not claim the raw `C2C_PI_ALIAS`; that value
is treated only as a parent-alias hint when no live parent alias is available.

The child system prompt includes its own c2c alias, the parent alias, and the
exact `c2c_pi_send(target="<parent>", body="<message>")` pattern for reporting
back. The parent transcript also receives a quiet local notice when a child
registers, for example:

```text
Subagent Plan#abc123 registered as `pi-abcd-a012345`.
```

That notice is process-local UI context, not a real c2c direct message.

## Requirements

- `c2c` on `PATH`
- pi `0.79` or newer
- Node.js and pnpm for local development

## Install

Install from npm:

```bash
pi install npm:pi-c2c
```

For local development:

```bash
pi install /path/to/pi-c2c
```

## Configuration

Common environment variables:

- `C2C_BIN`: c2c binary path, defaults to `c2c`
- `C2C_PI_ALIAS`: preferred alias for this pi session
- `C2C_PI_POLL_INTERVAL_MS`: inbox polling interval, defaults to `5000`

## Footer support

pi-c2c publishes a `c2c` status (a colored `●` + your alias) via
`ctx.ui.setStatus`. It renders correctly across pi's footers:

- **Default pi footer** — preserves ANSI; the colored dot shows as-is.
- **pi-bar / tm-bar** — these strip ANSI from extension statuses and prepend a
  `c2c:` key. pi-c2c installs a runtime `Theme.prototype.fg` patch on
  `session_start` that re-colorizes the indicator (green = registered,
  yellow = not). No configuration needed.
- **pi-powerline-footer** — does *not* strip embedded ANSI, so the `c2c`
  status already shows with color + glyph in powerline's aggregate
  `extension_statuses` segment with no configuration.

### Promoting `c2c` to a dedicated powerline segment (optional)

To give c2c its own powerline segment (instead of the aggregate
`extension_statuses` group), add a `powerline.customItems` entry to
`~/.pi/agent/settings.json` (or project-local `.pi/settings.json`) and run
`/reload`:

```json
{
  "powerline": {
    "customItems": [
      { "id": "c2c", "statusKey": "c2c", "position": "right", "prefix": "c2c" }
    ]
  }
}
```

Note: pi-c2c's `c2c` status already carries its own ANSI color (the
green/yellow dot), so the dot stays correctly colored in a dedicated segment.
Adding a `color` to the custom item is **not** recommended — powerline applies
that color over the whole value, but the embedded color codes win per-run, so
it would not recolor the alias and only risks leaving a dangling color. Omit
`color` to keep pi-c2c's built-in green/yellow coloring. The aggregate
`extension_statuses` segment shows the same coloring with no config at all.

## Development

```bash
pnpm install
pnpm check
pnpm test
```

The test suite fixtures the c2c CLI boundary for unit coverage and includes
isolated integration tests for real c2c binaries.

See [RELEASE.md](RELEASE.md) for the current manual release flow.
