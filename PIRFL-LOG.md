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
