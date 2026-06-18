# pi-c2c

Native [c2c](https://github.com/clankercode/c2c) integration for
[pi](https://pi.dev).

pi-c2c makes a pi session a c2c peer:

- registers a c2c alias on session start;
- exposes c2c send, list, inbox, and room tools to the model;
- exposes `/c2c-*` slash commands for the human;
- polls for inbound c2c messages and injects them into the pi transcript.

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
- `C2C_PI_POLL_INTERVAL_MS`: inbox polling interval, defaults to `30000`

## Development

```bash
pnpm install
pnpm check
pnpm test
```

The test suite fixtures the c2c CLI boundary for unit coverage and includes
isolated integration tests for real c2c binaries.
