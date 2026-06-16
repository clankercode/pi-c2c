/**
 * pi-c2c — native c2c integration for the pi coding agent.
 *
 * c2c (https://github.com/anomalyco/c2c) is a peer-to-peer messaging broker
 * between AI coding sessions. This extension makes a pi session a first-class
 * c2c peer:
 *
 *   - registers a c2c identity (alias) on `session_start` — self-registered,
 *     no `c2c start` supervisor required;
 *   - exposes c2c send/list/room **tools** the LLM can call;
 *   - exposes `/c2c-*` **slash commands** for the human at the keyboard;
 *   - runs a background **auto-delivery poller** that injects inbound c2c
 *     messages straight into pi's transcript via `pi.sendMessage` — the
 *     native win an MCP polling client can't do.
 *
 * Integration is CLI-based: every broker interaction shells out to the `c2c`
 * binary via `pi.exec` (the same pattern as the c2c OpenCode plugin). No
 * c2c-side changes are required.
 */

import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { C2cCli, type C2cMessage, type ExecFn } from "./c2c-cli.ts";
import { establishIdentity, type Identity } from "./identity.ts";
import {
  DeliveryDedup,
  deliveryOptionsFor,
  filterNovel,
  formatEnvelope,
  markDelivered,
  notifySummary,
} from "./delivery.ts";
import { clearSpool, gcStaleSpools, readSpool, writeSpool } from "./spool.ts";
import { formatStatus, installStatusColorPatch, type PiC2cBarState } from "./status.ts";
import { collectDebugState } from "./debug.ts";

export const PI_C2C_VERSION = "0.1.0";

const STATUS_KEY = "c2c";
const DEFAULT_POLL_INTERVAL_MS = 30_000;

const SESSION_ENV = "C2C_MCP_SESSION_ID";
const SPOOL_DIR = path.join(os.homedir(), ".pi", "c2c");
const SPOOL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // GC spool files older than a week

/**
 * Process-global state that must survive the extension factory being
 * re-invoked on an in-process session switch (reload / new / resume / fork).
 * pi re-evaluates the extension module on each switch, so a fresh closure /
 * fresh `process.env` read cannot tell our own prior `C2C_MCP_SESSION_ID`
 * write apart from a value the host set before launch. We stash the true
 * host-provided value (captured before our first write) and the previous
 * session id (to migrate its spool) on globalThis instead.
 */
interface PiC2cGlobal {
  hostSessionEnvCaptured: boolean;
  hostSessionEnv: string | undefined;
  prevSessionId?: string;
}
function gstate(): PiC2cGlobal {
  const g = globalThis as { __c2cPiState?: PiC2cGlobal };
  if (!g.__c2cPiState) {
    g.__c2cPiState = { hostSessionEnvCaptured: false, hostSessionEnv: undefined };
  }
  return g.__c2cPiState;
}

/** A pi tool/command result is a list of text blocks plus opaque details. */
function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/**
 * Render the raw `collectDebugState` text as a small two-column table.
 * Field rows are aligned with `│`; the problems section gets its own box.
 * Long values are wrapped at `MAX_VALUE_WIDTH` so the table fits in a
 * pi notification without horizontal scroll.
 */
export function formatDebugTable(raw: string): string {
  const MAX_KEY_WIDTH = 18;
  const MAX_VALUE_WIDTH = 64;

  const wrap = (s: string, width: number): string[] => {
    if (s.length <= width) return [s];
    const out: string[] = [];
    let i = 0;
    while (i < s.length) {
      out.push(s.slice(i, i + width));
      i += width;
    }
    return out;
  };

  const lines: string[] = [];
  const problems: string[] = [];
  let inProblems = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith("=== c2c pi debug ===")) continue;
    if (line.startsWith("=== problems ===")) {
      inProblems = true;
      continue;
    }
    if (inProblems) {
      problems.push(line);
      continue;
    }
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) {
      lines.push(line);
      continue;
    }
    const [, key, value] = m;
    const k = key.padEnd(MAX_KEY_WIDTH, " ");
    const v = wrap(value, MAX_VALUE_WIDTH);
    lines.push(`│ ${k} │ ${v[0].padEnd(MAX_VALUE_WIDTH, " ")} │`);
    for (let i = 1; i < v.length; i++) {
      lines.push(`│ ${" ".repeat(MAX_KEY_WIDTH)} │ ${v[i].padEnd(MAX_VALUE_WIDTH, " ")} │`);
    }
  }

  // total width = "│ " (2) + key (MAX_KEY_WIDTH) + " │ " (3) + value (MAX_VALUE_WIDTH) + " │" (1) = 2 + 18 + 3 + 64 + 1 = 88
  // border needs (88 - 2) = 86 dashes between corners.
  const innerWidth = MAX_KEY_WIDTH + MAX_VALUE_WIDTH + 6; // 2 + key + 3 + value + 1
  const border = `┌${"─".repeat(innerWidth)}┐`;
  const mid = `├${"─".repeat(innerWidth)}┤`;
  const bottom = `└${"─".repeat(innerWidth)}┘`;

  let out = border + "\n";
  out += lines.join("\n") + "\n";
  out += bottom;

  if (problems.length > 0) {
    out += "\n\n";
    out += border + "\n";
    out += `│ problems${" ".repeat(innerWidth - 9)} │\n`;
    out += mid + "\n";
    for (const p of problems) {
      if (p.startsWith("    remedy: ")) {
        const content = p.slice(4);
        // wrap long remedy text
        for (let i = 0; i < content.length; i += MAX_VALUE_WIDTH) {
          const chunk = content.slice(i, i + MAX_VALUE_WIDTH);
          out += `│   ${chunk.padEnd(innerWidth - 3, " ")} │\n`;
        }
      } else {
        // wrap problem lines
        const wrapWidth = innerWidth - 3; // "│ " + content + " │"
        for (let i = 0; i < p.length; i += wrapWidth) {
          const chunk = p.slice(i, i + wrapWidth);
          out += `│ ${chunk.padEnd(innerWidth - 2, " ")} │\n`;
        }
      }
    }
    out += bottom;
  }

  return out;
}

function readPollInterval(): number {
  const raw = Number.parseInt(process.env.C2C_PI_POLL_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_POLL_INTERVAL_MS;
}

function readAutoJoinRooms(): string[] {
  return (process.env.C2C_PI_AUTO_JOIN_ROOMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function c2cExtension(pi: ExtensionAPI): void {
  // --- per-session state (single process; closure-scoped) -------------------
  const barState: PiC2cBarState = {};
  let cli: C2cCli | null = null;
  let identity: Identity | null = null;
  let registered = false;
  let registerError: string | undefined;
  let ctxRef: ExtensionContext | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;
  const dedup = new DeliveryDedup();
  const pollIntervalMs = readPollInterval();

  // Serialize drains so the background poller and a manual `c2c_poll_inbox`
  // tool never drain concurrently (which could split a batch).
  let drainChain: Promise<void> = Promise.resolve();
  function serializeDrain<T>(fn: () => Promise<T>): Promise<T> {
    const run = drainChain.then(fn, fn);
    drainChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Inject already-filtered messages into the transcript. Returns true if the
   * injection was enqueued; false if `pi.sendMessage` threw (e.g. the runtime
   * went stale mid-reload) so the caller can keep them spooled for retry.
   */
  function inject(novel: C2cMessage[]): boolean {
    if (novel.length === 0) return true;
    const body = novel.map((m) => formatEnvelope(m, identity?.alias)).join("\n\n");
    const idle = ctxRef?.isIdle() ?? true;
    try {
      pi.sendMessage({ customType: "c2c", content: body, display: true }, deliveryOptionsFor(idle));
    } catch {
      return false;
    }
    try {
      ctxRef?.ui.notify(notifySummary(novel), "info");
    } catch {
      // notification is cosmetic — never let it fail a delivery
    }
    return true;
  }

  /**
   * Background poll: replay the spool + drain the inbox, then deliver anything
   * new. Best-effort and loss-resistant:
   *   - drained messages are spooled to disk BEFORE injection, so a crash or a
   *     stale-runtime sendMessage failure does not lose them (replayed next
   *     tick / next session start);
   *   - dedup is marked only AFTER a successful injection;
   *   - during shutdown we never drain/inject (the spool carries anything
   *     already pulled to the next start).
   */
  async function pollTick(): Promise<void> {
    if (!cli || !identity || shuttingDown) return;
    const sid = identity.sessionId;
    await serializeDrain(async () => {
      if (shuttingDown) return;
      let drained: C2cMessage[] = [];
      try {
        drained = await cli!.pollInbox();
      } catch {
        return; // broker hiccup — retry next tick
      }
      const combined = [...readSpool(SPOOL_DIR, sid), ...drained];
      const novel = filterNovel(combined, dedup);
      if (novel.length === 0) {
        if (combined.length > 0) clearSpool(SPOOL_DIR, sid); // already delivered
        return;
      }
      writeSpool(SPOOL_DIR, sid, novel); // persist before injecting
      if (shuttingDown) return; // teardown started — leave spool for next start
      if (inject(novel)) {
        markDelivered(novel, dedup);
        clearSpool(SPOOL_DIR, sid);
      }
      // else: spool persists, dedup unmarked → retried next tick
    });
  }

  // --- lifecycle ------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    shuttingDown = false;
    const gs = gstate();
    // Capture the host-provided session id ONCE, before our first write can
    // pollute it — otherwise a session switch would read our own prior write
    // and pin identity to the stale session.
    if (!gs.hostSessionEnvCaptured) {
      gs.hostSessionEnv = process.env[SESSION_ENV];
      gs.hostSessionEnvCaptured = true;
    }

    // Patch the shared theme singleton so custom footers (pi-bar) render the
    // c2c status in color even though they strip ANSI from extension values.
    installStatusColorPatch(ctx.ui.theme, () => barState);

    const exec: ExecFn = (command, args, options) =>
      pi.exec(command, args, { ...options, cwd: ctx.cwd });
    cli = new C2cCli({ exec });

    const piSessionId = ctx.sessionManager.getSessionId?.() ?? null;
    const res = await establishIdentity(cli, {
      piSessionId,
      configuredAlias: process.env.C2C_PI_ALIAS,
      sessionIdEnv: gs.hostSessionEnv,
    });
    identity = res.identity;
    registered = res.ok;

    // Export our session id so every child `c2c` invocation resolves THIS
    // session as the caller — the broker's caller-owns-alias check then
    // accepts our sends, and whoami/rooms resolve the right identity.
    // (pi's exec options carry no env field, so we set it on the process.)
    process.env[SESSION_ENV] = identity.sessionId;

    // On an in-process session switch our id changes; carry the previous
    // session's undelivered spool over to the new one (process-local, so we
    // never steal another live pi process's spool), then bound accumulation
    // by GC-ing week-old spool files (safe across concurrent pi processes).
    if (gs.prevSessionId && gs.prevSessionId !== identity.sessionId) {
      const carried = readSpool(SPOOL_DIR, gs.prevSessionId);
      if (carried.length > 0) {
        writeSpool(SPOOL_DIR, identity.sessionId, [
          ...readSpool(SPOOL_DIR, identity.sessionId),
          ...carried,
        ]);
      }
      clearSpool(SPOOL_DIR, gs.prevSessionId);
    }
    gs.prevSessionId = identity.sessionId;
    gcStaleSpools(SPOOL_DIR, SPOOL_TTL_MS, Date.now());

    if (res.ok) {
      barState.alias = identity.alias;
      barState.registered = true;
      barState.reason = undefined;
      registerError = undefined;
      ctx.ui.setStatus(STATUS_KEY, formatStatus(identity.alias, true, ctx.ui.theme));
      ctx.ui.notify(`c2c: registered as ${identity.alias}`, "info");
    } else {
      const reason = res.error ?? "unknown error";
      barState.alias = identity.alias;
      barState.registered = false;
      barState.reason = reason;
      registerError = reason;
      ctx.ui.setStatus(STATUS_KEY, formatStatus(identity.alias, false, ctx.ui.theme, reason));
      ctx.ui.notify(
        `c2c: registration failed (${reason}). Tools available; run 'c2c doctor'.`,
        "warning",
      );
    }

    // Auto-join configured rooms (e.g. C2C_PI_AUTO_JOIN_ROOMS=swarm-lounge).
    if (registered && identity) {
      for (const room of readAutoJoinRooms()) {
        try {
          await cli.joinRoom(room, identity.alias);
        } catch {
          ctx.ui.notify(`c2c: could not join room ${room}`, "warning");
        }
      }
    }

    // Start the auto-delivery poller and do an immediate first drain.
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void pollTick();
      }, pollIntervalMs);
    }
    void pollTick();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Set the flag BEFORE clearing the timer so any in-flight pollTick that is
    // still awaiting a drain bails out before injecting into a stale runtime.
    shuttingDown = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
    barState.alias = undefined;
    barState.registered = false;
  });

  // --- helpers for tools/commands -------------------------------------------

  function ready(): { cli: C2cCli; identity: Identity } | null {
    return cli && identity && registered ? { cli, identity } : null;
  }

  const notReadyText = "c2c: not registered yet (broker unreachable?). Run `/c2c-status` or `c2c doctor`.";

  // --- tools (LLM-callable) -------------------------------------------------

  pi.registerTool({
    name: "c2c_pi_debug",
    label: "c2c pi debug",
    description: "Return useful debugging metadata as a single text block.",
    parameters: Type.Object({}),
    async execute() {
      const text = collectDebugState({
        version: PI_C2C_VERSION,
        identity,
        registered,
        registerError,
        ctxRef,
        barState,
        pollIntervalMs,
        hostSessionEnv: gstate().hostSessionEnv,
        prevSessionId: gstate().prevSessionId,
        autoJoinRooms: readAutoJoinRooms(),
        piBarPatched: Boolean((globalThis as Record<string, unknown>).__piC2cStatusFgPatched),
        spoolDir: SPOOL_DIR,
        pid: process.pid,
        cwdFallback: process.cwd(),
        env: process.env,
      });
      return toolText(text);
    },
  });

  pi.registerTool({
    name: "c2c_send",
    label: "c2c send",
    description: "Send a c2c direct message to a peer agent by alias.",
    parameters: Type.Object({
      target: Type.String({ description: "Recipient alias (e.g. 'lyra-quill') or session id." }),
      body: Type.String({ description: "Message body." }),
    }),
    async execute(_id, { target, body }) {
      const r = ready();
      if (!r) return toolText(notReadyText);
      try {
        await r.cli.send(target, body);
        return toolText(`Sent to ${target}.`);
      } catch (e) {
        return toolText(`c2c_send failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "c2c_send_all",
    label: "c2c broadcast",
    description: "Broadcast a c2c message to all registered peers.",
    parameters: Type.Object({
      body: Type.String({ description: "Message body." }),
      exclude: Type.Optional(
        Type.Array(Type.String(), { description: "Aliases to skip." }),
      ),
    }),
    async execute(_id, { body, exclude }) {
      const r = ready();
      if (!r) return toolText(notReadyText);
      try {
        await r.cli.sendAll(body, { exclude });
        return toolText("Broadcast sent.");
      } catch (e) {
        return toolText(`c2c_send_all failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "c2c_list",
    label: "c2c peers",
    description: "List registered c2c peers and their liveness.",
    parameters: Type.Object({}),
    async execute() {
      const r = ready();
      if (!r) return toolText(notReadyText);
      try {
        const peers = await r.cli.list();
        if (peers.length === 0) return toolText("No peers registered.");
        const lines = peers.map((p) => `${p.alive ? "●" : "○"} ${p.alias}`);
        return toolText(lines.join("\n"));
      } catch (e) {
        return toolText(`c2c_list failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "c2c_poll_inbox",
    label: "c2c inbox",
    description: "Drain and return any queued inbound c2c messages now.",
    parameters: Type.Object({}),
    async execute() {
      const r = ready();
      if (!r) return toolText(notReadyText);
      const sid = r.identity.sessionId;
      try {
        // Render the result BEFORE committing (markDelivered + clearSpool),
        // all inside the mutex: if formatting throws, the messages stay in the
        // broker-drained spool and remain eligible for redelivery. Replay the
        // spool too so a manual poll surfaces anything a prior background tick
        // drained but failed to inject.
        const text = await serializeDrain(async () => {
          const combined = [...readSpool(SPOOL_DIR, sid), ...(await r.cli.pollInbox())];
          const fresh = filterNovel(combined, dedup);
          const rendered =
            fresh.length === 0
              ? "(no messages)"
              : fresh.map((m) => formatEnvelope(m, r.identity.alias)).join("\n\n");
          markDelivered(fresh, dedup);
          clearSpool(SPOOL_DIR, sid);
          return rendered;
        });
        return toolText(text);
      } catch (e) {
        return toolText(`c2c_poll_inbox failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "c2c_whoami",
    label: "c2c whoami",
    description: "Show this session's c2c identity (alias + session id).",
    parameters: Type.Object({}),
    async execute() {
      if (!identity) return toolText(notReadyText);
      return toolText(
        `alias: ${identity.alias}\nsession_id: ${identity.sessionId}\nregistered: ${registered}`,
      );
    },
  });

  pi.registerTool({
    name: "c2c_join_room",
    label: "c2c join room",
    description: "Join a c2c room (N:N channel). Room messages auto-deliver to your transcript.",
    parameters: Type.Object({ room: Type.String({ description: "Room id (e.g. 'swarm-lounge')." }) }),
    async execute(_id, { room }) {
      const r = ready();
      if (!r) return toolText(notReadyText);
      try {
        await r.cli.joinRoom(room, r.identity.alias);
        return toolText(`Joined room ${room}.`);
      } catch (e) {
        return toolText(`c2c_join_room failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "c2c_send_room",
    label: "c2c room send",
    description: "Send a message to a c2c room you have joined.",
    parameters: Type.Object({
      room: Type.String({ description: "Room id." }),
      body: Type.String({ description: "Message body." }),
    }),
    async execute(_id, { room, body }) {
      const r = ready();
      if (!r) return toolText(notReadyText);
      try {
        await r.cli.sendRoom(room, body);
        return toolText(`Sent to room ${room}.`);
      } catch (e) {
        return toolText(`c2c_send_room failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  pi.registerTool({
    name: "c2c_rooms",
    label: "c2c rooms",
    description: "List the c2c rooms this session is a member of.",
    parameters: Type.Object({}),
    async execute() {
      const r = ready();
      if (!r) return toolText(notReadyText);
      try {
        const rooms = await r.cli.myRooms();
        return toolText(rooms.length ? rooms.join("\n") : "(no rooms joined)");
      } catch (e) {
        return toolText(`c2c_rooms failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  });

  // --- slash commands (human) -----------------------------------------------

  pi.registerCommand("c2c-status", {
    description: "Show pi-c2c extension + registration status",
    handler: async (_args, ctx) => {
      const lines = [
        `pi-c2c v${PI_C2C_VERSION}`,
        `alias: ${identity?.alias ?? "(none)"}`,
        `session: ${identity?.sessionId ?? "(none)"}`,
        `registered: ${registered}`,
        `poll interval: ${pollIntervalMs}ms`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("c2c-pi-debug", {
    description: "Show pi-c2c debug state as a table (alias, registration, broker, env)",
    handler: async (_args, ctx) => {
      const raw = collectDebugState({
        version: PI_C2C_VERSION,
        identity,
        registered,
        registerError,
        ctxRef,
        barState,
        pollIntervalMs,
        hostSessionEnv: gstate().hostSessionEnv,
        prevSessionId: gstate().prevSessionId,
        autoJoinRooms: readAutoJoinRooms(),
        piBarPatched: Boolean((globalThis as Record<string, unknown>).__piC2cStatusFgPatched),
        spoolDir: SPOOL_DIR,
        pid: process.pid,
        cwdFallback: process.cwd(),
        env: process.env,
      });
      ctx.ui.notify(formatDebugTable(raw), "info");
    },
  });

  pi.registerCommand("c2c-whoami", {
    description: "Show this session's c2c identity",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        identity ? `${identity.alias} (${identity.sessionId})` : "(not registered)",
        "info",
      );
    },
  });

  pi.registerCommand("c2c-peers", {
    description: "List registered c2c peers",
    handler: async (_args, ctx) => {
      const r = ready();
      if (!r) return ctx.ui.notify(notReadyText, "warning");
      try {
        const peers = await r.cli.list();
        ctx.ui.notify(
          peers.length
            ? peers.map((p) => `${p.alive ? "●" : "○"} ${p.alias}`).join("\n")
            : "No peers registered.",
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`c2c list failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("c2c-inbox", {
    description: "Drain and show queued c2c messages",
    handler: async (_args, ctx) => {
      const r = ready();
      if (!r) return ctx.ui.notify(notReadyText, "warning");
      const sid = r.identity.sessionId;
      try {
        // notify() IS the delivery here, so do it INSIDE the mutex before the
        // commit (markDelivered + clearSpool). If notify throws, we bail before
        // committing and the spool keeps the messages for redelivery.
        await serializeDrain(async () => {
          const combined = [...readSpool(SPOOL_DIR, sid), ...(await r.cli.pollInbox())];
          const fresh = filterNovel(combined, dedup);
          ctx.ui.notify(
            fresh.length ? fresh.map((m) => `${m.from_alias}: ${m.content}`).join("\n") : "(no messages)",
            "info",
          );
          markDelivered(fresh, dedup);
          clearSpool(SPOOL_DIR, sid);
        });
      } catch (e) {
        ctx.ui.notify(`c2c poll-inbox failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("c2c-send", {
    description: "Send a DM: /c2c-send <alias> <message...>",
    handler: async (args, ctx) => {
      const r = ready();
      if (!r) return ctx.ui.notify(notReadyText, "warning");
      const m = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) {
        return ctx.ui.notify("usage: /c2c-send <alias> <message...>", "warning");
      }
      const target = m[1];
      const body = m[2];
      try {
        await r.cli.send(target, body);
        ctx.ui.notify(`Sent to ${target}.`, "info");
      } catch (e) {
        ctx.ui.notify(`c2c send failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
