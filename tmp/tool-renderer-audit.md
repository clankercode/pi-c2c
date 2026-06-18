# pi-c2c tool renderer audit

Scope: `src/index.ts`, `src/ui/*.ts`, and renderer-related tests under `tests/`. No source files were edited.

Verification note: after this report was written, `git status` showed unstaged source diffs in `src/index.ts` and `src/ui/tool-renderers.ts` that were not part of this report write. They appear to address some recommendations below, especially the `c2c_pi_send.renderCall` normalization. I left those source diffs untouched.

## Summary

`src/index.ts` registers 11 `c2c_pi_*` tools. Seven use `renderShell: "self"` with a custom `renderResult`; three of those also define a custom `renderCall`. Three tools use `renderShell: "self"` but no custom call/result renderer, so they currently depend on pi's default result formatting. Two tools have no `renderShell`, `renderCall`, or `renderResult` at all.

The most likely cause of the stray standalone `c2c` line for `c2c_pi_send` is its `renderCall` adapter. It passes raw call args `{ target, body, nonurgent }` to `renderSendCall` as `SendToolDetails`, but `renderSendCall` switches on `args.kind`. Because direct-message call args have no `kind: "dm"`, the renderer returns only the prefix row (`⧓⧓ c2c` / visually just `c2c`) instead of `send -> target`. The unit tests cover `renderSendCall({ kind: "dm", ... })`, but not the actual `src/index.ts` adapter shape.

## Registered tools

| Tool | `renderShell:"self"` | `renderCall` | `renderResult` | Current compact/custom lines | Fallback/default risk |
| --- | --- | --- | --- | --- | --- |
| `c2c_pi_help` | No | No | No | None. Returns full help text from `renderC2cPiHelp(topic)`. | Falls back to default tool call/result UI. Likely verbose but acceptable for help. |
| `c2c_pi_debug` | No | No | No | None. Returns a large debug text block from `collectDebugState(...)`. | Falls back to default UI; likely ugly/noisy because output is intentionally large. |
| `c2c_pi_send` | Yes | Yes | Yes | Call should be `⧓ c2c send -> <target>`; result is `⧓ c2c · ▲◎ -> <target> · <preview>` or `▲⇄` for relay; error is `⧓ c2c · send error`. | Bug: current call adapter omits `kind: "dm"`, so call line can collapse to only the c2c prefix. |
| `c2c_pi_send_all` | Yes | Yes | Yes | Call `⧓ c2c broadcast`; result `⧓ c2c · ✶◎ broadcast · <preview>`; error `⧓ c2c · send error`. | Custom path is covered. |
| `c2c_pi_list` | Yes | No | Yes | Result header `⧓ c2c · peers (N)` plus child lines `● alias`, `[cross-repo]`, `[relay]`, and `[state]`. Empty: `no peers registered`. Error: `peers error`. | No custom call line, but result is good. |
| `c2c_pi_poll_inbox` | Yes | No | Yes | Result header `⧓ c2c · inbox (N)` plus child lines `<from>: <preview>`. Empty: `no messages`. Error: `inbox error`. | No custom call line, but result is good. |
| `c2c_pi_whoami` | Yes | No | Yes | Result `⧓ c2c · <alias> (<sessionId>) · registered/not registered`; error `whoami error`. | No custom call line, but result is good. |
| `c2c_pi_status` | Yes | No | No | None. Returns raw multiline `state`, `since`, `ttl_ms`. | Falls back to bare/default result formatting despite `renderShell:"self"`. |
| `c2c_pi_join_room` | Yes | No | Yes | Result `⧓ c2c joined room <room>`; error `join room error`. | No custom call line; result is good. |
| `c2c_pi_send_room` | Yes | Yes | Yes | Call `⧓ c2c send to room <room>`; result `⧓ c2c · ▲◎ -> room <room> · <preview>`; error `send error`. | Custom path is covered. |
| `c2c_pi_local_info` | Yes | No | No | None. Returns raw multiline local info plus relay connection guidance. | Falls back to bare/default result formatting despite `renderShell:"self"`. |
| `c2c_pi_rooms` | Yes | No | Yes | Result header `⧓ c2c · rooms (N)` plus child room lines. Empty: `no rooms joined`. Error: `rooms error`. | No custom call line, but result is good. |

## Renderer implementation notes

- `src/ui/tool-renderers.ts` documents the intended pattern as `renderShell: "self"`, `renderCall`, and `renderResult`, but only send/broadcast/room-send currently have call renderers.
- `renderSendCall` expects a normalized `SendToolDetails` object with `kind: "dm" | "broadcast" | "room"`.
- `renderSendResult` uses `SendToolDetails.body` for the truncated preview and `via` for route glyph selection. It treats any non-relay route as sessions (`◎`), so `per-repo` is currently displayed as `◎`, not the local/home glyph (`⌂`).
- `renderListResult`, `renderInboxResult`, `renderWhoamiResult`, `renderJoinRoomResult`, and `renderRoomsResult` all have unit coverage in `tests/ui/tool-renderers.test.ts`.
- Tests exercise renderer functions directly, but do not exercise the exact `renderCall`/`renderResult` adapter functions registered in `src/index.ts`. That gap allowed the `c2c_pi_send` adapter shape bug.

## Delivered c2c message renderer

`src/ui/compact-message.ts` registers a message renderer for `customType: "c2c"` at extension startup. It is separate from tool result rendering. It collapses delivered c2c messages to lines like:

- `⧓ c2c · ▼◎ <- lyra-quill · hello`
- `⧓ c2c · ▲◎ -> <self> · sent text`
- `⧓ c2c · ●◎ lyra-quill · is processing`

Relevant fallback: `parseC2cEnvelopes("raw text")` intentionally creates a pseudo-envelope from sender `c2c`. Then `buildCompactLine` defaults the primary sender to `c2c` when there are no senders. This can also produce a visible `c2c` sender label for malformed/non-envelope delivered message content, but it does not explain the `c2c_pi_send` call-line issue as well as the missing `kind: "dm"` adapter does.

## Concrete recommendations

1. Fix `c2c_pi_send.renderCall` to normalize raw args:

   ```ts
   renderCall: (args, theme) =>
     renderSendCall(
       { kind: "dm", target: (args as { target?: string }).target },
       theme,
     ),
   ```

   Optionally include `body`/`nonurgent` if the call row should preview those later.

2. Add an adapter-level unit test or lightweight registration test that invokes each registered `renderCall` with real tool args. Specifically assert `c2c_pi_send` renders `send -> lyra-quill`, not just the c2c prefix.

3. Add compact result renderers for `c2c_pi_status` and `c2c_pi_local_info`, since both already use `renderShell:"self"` but currently fall back to default multiline output.

4. Consider adding compact result renderers for `c2c_pi_help` and `c2c_pi_debug`, or intentionally leave them on default rendering and document that choice. `debug` especially is expected to be noisy, so a compact header plus expandable full debug block would fit the rest of the UI.

5. If route glyph precision matters, teach `renderSendResult` to display `via: "per-repo"` as the local/home route (`⌂`) instead of folding it into sessions (`◎`).

6. Harden `parseC2cEnvelopes`/`buildCompactLine` fallback display if the generic `c2c` sender label is confusing. For example, render malformed delivery as `unknown c2c message` or `raw c2c` instead of making `c2c` look like a peer alias.
