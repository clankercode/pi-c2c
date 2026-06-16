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

import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { C2cCli, type C2cMessage, type ExecFn } from "./c2c-cli.ts";
import { establishIdentity, type Identity } from "./identity.ts";
import {
  DeliveryDedup,
  deliveryOptionsFor,
  formatEnvelope,
  notifySummary,
  selectNovel,
} from "./delivery.ts";

export const PI_C2C_VERSION = "0.1.0";

const STATUS_KEY = "c2c";
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** A pi tool/command result is a list of text blocks plus opaque details. */
function toolText(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
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
  let cli: C2cCli | null = null;
  let identity: Identity | null = null;
  let registered = false;
  let ctxRef: ExtensionContext | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
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

  /** Inject novel messages into the transcript. `triggerTurn` when idle. */
  function deliver(msgs: C2cMessage[]): void {
    const novel = selectNovel(msgs, dedup);
    if (novel.length === 0) return;
    const body = novel.map((m) => formatEnvelope(m, identity?.alias)).join("\n\n");
    const idle = ctxRef?.isIdle() ?? true;
    pi.sendMessage({ customType: "c2c", content: body, display: true }, deliveryOptionsFor(idle));
    ctxRef?.ui.notify(notifySummary(novel), "info");
  }

  /** Background poll: drain the inbox and deliver anything new. Best-effort. */
  async function pollTick(): Promise<void> {
    if (!cli || !identity) return;
    await serializeDrain(async () => {
      try {
        const msgs = await cli!.pollInbox();
        if (msgs.length > 0) deliver(msgs);
      } catch {
        // Broker hiccup — try again next tick; do not crash the timer.
      }
    });
  }

  // --- lifecycle ------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    const exec: ExecFn = (command, args, options) =>
      pi.exec(command, args, { ...options, cwd: ctx.cwd });
    cli = new C2cCli({ exec });

    const piSessionId = ctx.sessionManager.getSessionId?.() ?? null;
    const res = await establishIdentity(cli, {
      piSessionId,
      configuredAlias: process.env.C2C_PI_ALIAS,
    });
    identity = res.identity;
    registered = res.ok;

    if (res.ok) {
      ctx.ui.setStatus(STATUS_KEY, identity.alias);
      ctx.ui.notify(`c2c: registered as ${identity.alias}`, "info");
    } else {
      ctx.ui.setStatus(STATUS_KEY, `${identity.alias}?`);
      ctx.ui.notify(
        `c2c: registration failed (${res.error ?? "unknown"}). Tools available; run 'c2c doctor'.`,
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
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  // --- helpers for tools/commands -------------------------------------------

  function ready(): { cli: C2cCli; identity: Identity } | null {
    return cli && identity && registered ? { cli, identity } : null;
  }

  const notReadyText = "c2c: not registered yet (broker unreachable?). Run `/c2c-status` or `c2c doctor`.";

  // --- tools (LLM-callable) -------------------------------------------------

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
        await r.cli.send(target, body, { from: r.identity.alias });
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
        await r.cli.sendAll(body, { from: r.identity.alias, exclude });
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
        const lines = peers.map(
          (p) => `${p.alive ? "●" : "○"} ${p.alias}${p.lastSeenAge != null ? ` (seen ${p.lastSeenAge}s ago)` : ""}`,
        );
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
      try {
        const msgs = await serializeDrain(() => r.cli.pollInbox());
        // Mark delivered so the background poller does not re-inject them.
        const novel = selectNovel(msgs, dedup);
        if (novel.length === 0) return toolText("(no messages)");
        return toolText(novel.map((m) => formatEnvelope(m, r.identity.alias)).join("\n\n"));
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
        await r.cli.sendRoom(room, body, r.identity.alias);
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
      try {
        const msgs = await serializeDrain(() => r.cli.pollInbox());
        const novel = selectNovel(msgs, dedup);
        ctx.ui.notify(
          novel.length ? novel.map((m) => `${m.from_alias}: ${m.content}`).join("\n") : "(no messages)",
          "info",
        );
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
        await r.cli.send(target, body, { from: r.identity.alias });
        ctx.ui.notify(`Sent to ${target}.`, "info");
      } catch (e) {
        ctx.ui.notify(`c2c send failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}
