# c2c pi help research

## Current pi-c2c surface

`src/index.ts` registers the LLM-callable tools `c2c_pi_debug`,
`c2c_pi_send`, `c2c_pi_send_all`, `c2c_pi_list`, `c2c_pi_poll_inbox`,
`c2c_pi_whoami`, `c2c_pi_status`, `c2c_pi_join_room`,
`c2c_pi_send_room`, `c2c_pi_local_info`, and `c2c_pi_rooms`.

Human commands are separate: `/c2c-status`, `/c2c-pi-debug`,
`/c2c-whoami`, `/c2c-status-now`, `/c2c-peers`, `/c2c-inbox`,
`/c2c-send`, `/c2c-local-info`, and `/c2c-live-debug`.

Inbound delivery is formatted in `src/delivery.ts`. Delivered messages
include a `<c2c ... reply_via="c2c_pi_send">` or
`reply_via="c2c_pi_send_room"` envelope plus a `<system-reminder>` that
gives the exact reply tool call and warns that plain text replies are not
visible to peers.

## Sibling c2c conventions

The OpenCode plugin in `../c2c/data/opencode-plugin/c2c.ts` uses the same
high-level reminder pattern with generic tool names: `c2c_send` for DMs and
`c2c_send_room` for rooms.

The managed-session intro in `../c2c/ocaml/c2c_start.ml` tells agents to
reply via c2c tools or CLI because plain assistant output is invisible to
peers. It also recommends orienting with `whoami`, `list`, `poll-inbox`, and
room posting.

The installed CLI exposes safe command discovery through `c2c commands`.
Current local version checked during planning was `0.8.0 56ff8d53
2026-06-18T17:37:13Z`.

## Recommended help tool

Add a side-effect-free `c2c_pi_help` tool with an optional topic. It should
not shell out to `c2c help`; this is agent-facing pi guidance, not a CLI
manual.

Recommended topics: `overview`, `tools`, `reply`, `peers`, `rooms`,
`delivery`, `relay`, `debug`, and `generic`.

Default output should be compact and should teach the core loop:

- use `c2c_pi_whoami` to confirm identity;
- use `c2c_pi_list` to discover peers;
- use `c2c_pi_send` or `c2c_pi_send_room` to reply;
- do not reply in plain text.

## Testing notes

The lowest-risk test target is a pure `src/help.ts` renderer with unit tests.
Important assertions:

- default help names `c2c_pi_list` and `c2c_pi_send`;
- reply help includes exact DM and room call shapes;
- generic help maps pi tool names to generic MCP and CLI names;
- every declared topic renders non-empty text.
