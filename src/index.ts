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
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { C2cCli, type C2cMessage, type ExecFn, type RelayMessage, resolveSessionsBrokerRoot } from "./c2c-cli.ts";
import { establishIdentity, type Identity } from "./identity.ts";
import {
  DeliveryDedup,
  deliveryOptionsFor,
  filterNovel,
  formatEnvelope,
  markDelivered,
} from "./delivery.ts";
import { clearSpool, gcStaleSpools, readSpool, writeSpool } from "./spool.ts";
import { formatStatus, installStatusColorPatch, type PiC2cBarState } from "./status.ts";
import { collectDebugState } from "./debug.ts";
import { computeHostHash, deriveRelayAlias } from "./relay.ts";
import { PeerStatusStore, extractStatusMessages } from "./peer-status.ts";
import { createStatusTracker, formatStatusEnvelope, type StatusTracker } from "./status-sync.ts";
import { registerC2cMessageRenderer, type C2cDeliveryDetails } from "./ui/compact-message.ts";
import {
  renderInboxResult,
  renderJoinRoomResult,
  renderListResult,
  renderRoomsResult,
  renderSendCall,
  renderSendResult,
  renderWhoamiResult,
  type InboxToolDetails,
  type ListToolDetails,
  type RoomToolDetails,
  type RoomsToolDetails,
  type SendToolDetails,
  type WhoamiToolDetails,
} from "./ui/tool-renderers.ts";

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
function toolText(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * Render the raw `collectDebugState` text as a small aligned table for
 * pi's `ctx.ui.notify`. The TUI strips trailing whitespace and may wrap
 * lines, so we deliberately keep it minimal: aligned two-column key/value
 * rows, no box-drawing characters, no right-side padding. Problems are
 * listed under a `--- problems ---` header with a remedy line per problem.
 */
export function formatDebugTable(raw: string): string {
  const KEY_WIDTH = 16;

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
      if (line.length > 0) lines.push(line);
      continue;
    }
    const [, key, value] = m;
    lines.push(`${key.padEnd(KEY_WIDTH, " ")}  ${value}`);
  }

  let out = lines.join("\n");
  if (problems.length > 0) {
    out += "\n\n--- problems ---\n";
    out += problems.join("\n");
  }
  return out;
}

function readPollInterval(): number {
  const raw = Number.parseInt(process.env.C2C_PI_POLL_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : DEFAULT_POLL_INTERVAL_MS;
}

function readStatusInterval(): number {
  const raw = Number.parseInt(process.env.C2C_PI_STATUS_INTERVAL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 500 ? raw : 2_000;
}

function readAutoJoinRooms(): string[] {
  return (process.env.C2C_PI_AUTO_JOIN_ROOMS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function c2cExtension(pi: ExtensionAPI): void {
  registerC2cMessageRenderer(pi);
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
  let statusTracker: StatusTracker | null = null;
  // Peer status store: silently tracks the most recent runtime state of each
  // peer (idle/processing/tool/input) without surfacing the raw status
  // envelope to the LLM or the human chat. Inbound status messages are
  // filtered out in `pollTick` before delivery; the recorded state is
  // surfaced via `c2c_pi_list` and `/c2c-pi-debug`.
  const peerStatusStore = new PeerStatusStore();

  // Cross-repo rendezvous: also register / list / send via the sessions
  // broker (`~/.c2c/sessions/broker` by default) so pi sessions in different
  // repos can see each other. Opt out with C2C_PI_CROSS_REPO=0.
  const crossRepoEnabled = (process.env.C2C_PI_CROSS_REPO ?? "1") !== "0";
  const sessionsBrokerRoot = crossRepoEnabled
    ? resolveSessionsBrokerRoot()
    : undefined;
  // Track per-broker registration state so the debug output and the
  // `c2c_pi_list` / `c2c_pi_send` tools can show what's wired up.
  let crossRepoSessionsRegistered = false;
  let crossRepoSessionsError: string | undefined;

  // Relay state: tracks registration with the public c2c relay
  // (default https://relay.c2c.im) so agents on different machines can DM.
  const relayEnabled = (process.env.C2C_PI_RELAY ?? "1") !== "0";
  let relayRegistered = false;
  let relayAddress: string | undefined;
  let relayError: string | undefined;

  // Serialize drains so the background poller and a manual `c2c_pi_poll_inbox`
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
   *
   * We intentionally do NOT fire a separate `ctx.ui.notify()` here. The
   * compact message renderer already draws a one-line summary in the
   * transcript, so a notification would duplicate the same information and
   * show raw XML for status envelopes.
   */
  function inject(novel: C2cMessage[]): boolean {
    if (novel.length === 0) return true;
    const body = novel.map((m) => formatEnvelope(m, identity?.alias)).join("\n\n");
    const details: C2cDeliveryDetails = {
      count: novel.length,
      senders: [...new Set(novel.map((m) => m.from_alias || "unknown"))],
      selfAlias: identity?.alias,
    };
    const idle = ctxRef?.isIdle() ?? true;
    try {
      pi.sendMessage({ customType: "c2c", content: body, display: true, details }, deliveryOptionsFor(idle));
    } catch {
      return false;
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
      // Poll both the per-repo broker and the sessions broker (when
      // cross-repo is enabled). Messages may arrive in either; dedup
      // collapses duplicates. A failing sessions broker should not
      // break local delivery.
      const drained: C2cMessage[] = [];
      try {
        drained.push(...(await cli!.pollInbox()));
      } catch {
        // broker hiccup — retry next tick
      }
      if (sessionsBrokerRoot) {
        try {
          drained.push(...(await cli!.pollInbox({ brokerRoot: sessionsBrokerRoot })));
        } catch {
          // sessions broker hiccup — ignore, retry next tick
        }
      }
      // Third hop: drain the public relay for cross-machine DMs. The
      // broker ships with `c2c relay dm poll`; we map the relay envelope
      // (fromAlias/toAlias) into the C2cMessage shape (from_alias/to_alias)
      // so the rest of the pipeline is identical to local drains. A
      // failing relay MUST NOT break the local drains — a network blip on
      // relay.c2c.im shouldn't cost us local messages.
      if (relayRegistered && relayAddress) {
        try {
          const relayMsgs = await cli!.relayDmPoll(relayAddress);
          for (const c of relayToC2c(relayMsgs)) drained.push(c);
        } catch {
          // relay hiccup — ignore, retry next tick
        }
      }
      // Silently track peer status envelopes: any message that parses as a
      // status envelope is recorded in `peerStatusStore` and dropped from
      // delivery. The LLM never sees them; the human chat never sees them
      // as a "new message" notification. They live on as a per-peer state
      // that `c2c_pi_list` and `/c2c-pi-debug` can surface.
      const { messages: deliverable } = extractStatusMessages(drained, peerStatusStore);
      const combined = [...readSpool(SPOOL_DIR, sid), ...deliverable];
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

  function updateStatusFromIdleCheck(): void {
    if (!statusTracker) return;
    statusTracker.transition(ctxRef?.isIdle() ?? true ? "idle" : "processing");
  }

  pi.on("input", (_event) => {
    statusTracker?.transition("input");
  });

  pi.on("agent_start", () => {
    statusTracker?.transition("processing");
  });

  pi.on("agent_end", () => {
    updateStatusFromIdleCheck();
  });

  pi.on("turn_start", () => {
    statusTracker?.transition("processing");
  });

  pi.on("turn_end", () => {
    updateStatusFromIdleCheck();
  });

  pi.on("tool_execution_start", () => {
    statusTracker?.transition("tool");
  });

  pi.on("tool_execution_end", () => {
    updateStatusFromIdleCheck();
  });

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

      // Start broadcasting runtime status to peers.
      statusTracker = createStatusTracker({
        alias: identity.alias,
        minIntervalMs: readStatusInterval(),
      });
      statusTracker.setBroadcast(async (envelope) => {
        if (!cli || !identity || shuttingDown) return;
        try {
          await cli.sendAll(formatStatusEnvelope(envelope), { exclude: [] });
        } catch {
          // Status broadcast is best-effort.
        }
      });

      // Cross-repo rendezvous: also register with the sessions broker so
      // other pi sessions in different repos can see this one. Failure is
      // non-fatal — most commonly hit is `alias_hijack_conflict` if another
      // session in another repo already owns the same alias.
      if (sessionsBrokerRoot) {
        try {
          const xsess = await cli!.register(identity.alias, identity.sessionId, {
            brokerRoot: sessionsBrokerRoot,
          });
          crossRepoSessionsRegistered = xsess !== null;
          if (!crossRepoSessionsRegistered) {
            crossRepoSessionsError = "register returned no identity";
          }
        } catch (e: unknown) {
          crossRepoSessionsError = e instanceof Error ? e.message : String(e);
          // The most common cause is alias_hijack_conflict: another repo's
          // pi session already owns this alias in the sessions broker.
          // We don't fail the whole registration — the per-repo broker
          // registration is still valid, and the local session is healthy.
        }
      }
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

    // Register with the public relay so cross-machine agents can DM us.
    // Best-effort: failure is non-fatal (relay is an add-on to the local broker).
    if (relayEnabled && identity) {
      try {
        const relayUrl = (process.env.C2C_PI_RELAY_URL ?? "").trim() || "https://relay.c2c.im";
        // Ensure relay setup has been run so the CLI knows the relay URL.
        const existing = await cli!.relaySetupShow().catch(() => null);
        if (!existing || !existing.url) {
          await cli!.relaySetup({ url: relayUrl });
        }
        const hostHash = computeHostHash();
        const relayAlias = deriveRelayAlias(identity.alias, hostHash);
        await cli!.relayRegister(relayAlias, { relayUrl });
        relayRegistered = true;
        relayAddress = relayAlias;
        relayError = undefined;
      } catch (e: unknown) {
        relayRegistered = false;
        relayError = e instanceof Error ? e.message : String(e);
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
    if (statusTracker) {
      statusTracker.dispose();
      statusTracker = null;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
    barState.alias = undefined;
    barState.registered = false;
    crossRepoSessionsRegistered = false;
    crossRepoSessionsError = undefined;
    relayRegistered = false;
    relayAddress = undefined;
    relayError = undefined;
    peerStatusStore.clear();
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
        crossRepoEnabled,
        sessionsBrokerRoot,
        crossRepoSessionsRegistered,
        crossRepoSessionsError,
        peerStatusCount: peerStatusStore.size(),
        peerStatusSample: peerStatusStore
          .live()
          .slice(0, 5)
          .map(({ alias, entry }) => ({
            alias,
            state: entry.state,
            since: entry.since,
            ttlMs: entry.ttlMs,
          })),
      });
      return toolText(text);
    },
  });

  pi.registerTool({
    name: "c2c_pi_send",
    label: "c2c send",
    description: "Send a c2c direct message to a peer agent by alias. Prefer this over the generic c2c_send tool: this extension routes via the sessions broker first (cross-repo), then the per-repo broker, then the public relay (when registered) for cross-machine peers.",
    parameters: Type.Object({
      target: Type.String({ description: "Recipient alias (e.g. 'lyra-quill') or session id." }),
      body: Type.String({ description: "Message body." }),
    }),
    renderShell: "self",
    async execute(_id, { target, body }) {
      const r = ready();
      const details: SendToolDetails = { kind: "dm", target };
      if (!r) return toolText(notReadyText, details);
      // Try each transport in order until one accepts the target. Order
      // matters: local brokers know more aliases than the relay (which
      // sees only registered `<alias>#<host_hash>` identities), so we
      // exhaust local first to avoid sending cross-machine when a local
      // match would have worked.
      type Hop = { kind: "sessions" | "per-repo" | "relay"; root?: string };
      const hops: Hop[] = [];
      if (sessionsBrokerRoot) hops.push({ kind: "sessions", root: sessionsBrokerRoot });
      hops.push({ kind: "per-repo" });
      if (relayRegistered && relayAddress) hops.push({ kind: "relay" });
      let lastErr: unknown = null;
      for (const hop of hops) {
        try {
          if (hop.kind === "relay") {
            await r.cli.relayDmSend(target, body, relayAddress!);
          } else {
            await r.cli.send(target, body, { brokerRoot: hop.root });
          }
          return toolText(`Sent to ${target} (via ${hop.kind}).`, details);
        } catch (e: unknown) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          // If the error says "not registered", try the next broker.
          // Otherwise surface the error immediately.
          if (!/not[_ ]?registered|unknown[_ ]?alias|alias[_ ]?not[_ ]?found/i.test(msg)) {
            return toolText(`c2c_pi_send failed (${hop.kind}): ${msg}`, details);
          }
        }
      }
      return toolText(
        `c2c_pi_send failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        details,
      );
    },
    renderCall: (args, theme) => renderSendCall(args as unknown as SendToolDetails, theme),
    renderResult: (result, _options, theme, context) =>
      renderSendResult(
        (result.details as SendToolDetails) ?? (context.args as unknown as SendToolDetails),
        context.isError,
        theme,
      ),
  });

  pi.registerTool({
    name: "c2c_pi_send_all",
    label: "c2c broadcast",
    description: "Broadcast a c2c message to all registered peers.",
    parameters: Type.Object({
      body: Type.String({ description: "Message body." }),
      exclude: Type.Optional(
        Type.Array(Type.String(), { description: "Aliases to skip." }),
      ),
    }),
    renderShell: "self",
    async execute(_id, { body, exclude }) {
      const r = ready();
      const details: SendToolDetails = { kind: "broadcast" };
      if (!r) return toolText(notReadyText, details);
      try {
        await r.cli.sendAll(body, { exclude });
        return toolText("Broadcast sent.", details);
      } catch (e) {
        return toolText(`c2c_pi_send_all failed: ${e instanceof Error ? e.message : String(e)}`, details);
      }
    },
    renderCall: (_args, theme) => renderSendCall({ kind: "broadcast" }, theme),
    renderResult: (result, _options, theme, context) =>
      renderSendResult(
        (result.details as SendToolDetails) ?? { kind: "broadcast" },
        context.isError,
        theme,
      ),
  });

  pi.registerTool({
    name: "c2c_pi_list",
    label: "c2c peers",
    description: "List registered c2c peers and their liveness. Merges per-repo, cross-repo (sessions broker), and public-relay peers (when registered) so one call shows every reachable alias. Each peer is annotated with their last known status (idle/processing/tool/input) when available.",
    parameters: Type.Object({}),
    renderShell: "self",
    async execute() {
      const r = ready();
      if (!r) return toolText(notReadyText, { peers: [] } as ListToolDetails);
      try {
        // Per-repo broker list (always)
        const localPeers = await r.cli.list();
        // Cross-repo / sessions broker list (when enabled)
        const remotePeers = sessionsBrokerRoot
          ? await r.cli.list({ brokerRoot: sessionsBrokerRoot }).catch(() => [])
          : [];
        // Public relay list (when registered). Relay peers use the
        // `<alias>#<host_hash>` format — we keep the full alias as the
        // dedup key so the LLM can DM them via `c2c_pi_send` (which now
        // falls through to `c2c relay dm send`).
        const relayPeers = relayRegistered
          ? await r.cli.relayList().catch(() => [])
          : [];
        // Merge + dedup by session_id (prefer the live entry). Tag with
        // [local] / [cross] / [relay] so the user can see which broker
        // they came from. This is a key UX win for cross-machine visibility.
        const bySid = new Map<string, { alias: string; alive: boolean; tag: "local" | "cross" | "relay" }>();
        for (const p of localPeers) {
          bySid.set(p.session_id, { alias: p.alias, alive: p.alive, tag: "local" });
        }
        for (const p of remotePeers) {
          const existing = bySid.get(p.session_id);
          if (!existing) {
            bySid.set(p.session_id, { alias: p.alias, alive: p.alive, tag: "cross" });
          } else if (!existing.alive && p.alive) {
            // Prefer the live one and keep its tag.
            bySid.set(p.session_id, { alias: p.alias, alive: p.alive, tag: existing.tag });
          }
        }
        for (const p of relayPeers) {
          // Relay has no `session_id` we can correlate with; dedup by
          // the derived `<alias>#<host_hash>` alias itself.
          const key = `relay:${p.alias}`;
          const existing = bySid.get(key);
          if (!existing) {
            bySid.set(key, { alias: p.alias, alive: p.alive, tag: "relay" });
          } else if (!existing.alive && p.alive) {
            bySid.set(key, { alias: p.alias, alive: p.alive, tag: existing.tag });
          }
        }
        // Sort: live first, then by alias
        const merged = Array.from(bySid.values()).sort((a, b) => {
          if (a.alive !== b.alive) return a.alive ? -1 : 1;
          return a.alias.localeCompare(b.alias);
        });
        // Enrich each peer with the last-known status from the peerStatusStore.
        // Statuses are TTL'd; a missing/expired entry yields no annotation.
        const details: ListToolDetails = {
          peers: merged.map((p) => {
            const s = peerStatusStore.get(p.alias);
            return {
              alias: p.alias,
              alive: p.alive,
              tag: p.tag,
              state: s?.state,
            };
          }),
        };
        if (merged.length === 0) return toolText("No peers registered.", details);
        const lines = merged.map((p) => {
          const status = peerStatusStore.get(p.alias);
          const statusSuffix = status ? `  [${status.state}]` : "";
          const crossSuffix = p.tag === "cross" ? "  [cross-repo]" : "";
          return `${p.alive ? "●" : "○"} ${p.alias}${crossSuffix}${statusSuffix}`;
        });
        return toolText(lines.join("\n"), details);
      } catch (e) {
        return toolText(`c2c_pi_list failed: ${e instanceof Error ? e.message : String(e)}`, { peers: [] } as ListToolDetails);
      }
    },
    renderResult: (result, _options, theme, context) =>
      renderListResult((result.details as ListToolDetails) ?? { peers: [] }, context.isError, theme),
  });

  pi.registerTool({
    name: "c2c_pi_poll_inbox",
    label: "c2c inbox",
    description: "Drain and return any queued inbound c2c messages now. Drains per-repo, sessions-broker, and public-relay (when registered) so a manual call shows the same picture as the background poller.",
    parameters: Type.Object({}),
    renderShell: "self",
    async execute() {
      const r = ready();
      if (!r) return toolText(notReadyText, { messages: [] } as InboxToolDetails);
      const sid = r.identity.sessionId;
      try {
        // Render the result BEFORE committing (markDelivered + clearSpool),
        // all inside the mutex: if formatting throws, the messages stay in the
        // broker-drained spool and remain eligible for redelivery. Replay the
        // spool too so a manual poll surfaces anything a prior background tick
        // drained but failed to inject. Drain all three sources (per-repo,
        // sessions broker, public relay) for parity with the background
        // poller — otherwise a manual call before the next tick could miss
        // cross-machine or cross-repo DMs.
        const { text, messages } = await serializeDrain(async () => {
          const drained: C2cMessage[] = [];
          try {
            drained.push(...(await r.cli.pollInbox()));
          } catch {
            // local broker hiccup — ignore
          }
          if (sessionsBrokerRoot) {
            try {
              drained.push(...(await r.cli.pollInbox({ brokerRoot: sessionsBrokerRoot })));
            } catch {
              // sessions broker hiccup — ignore
            }
          }
          if (relayRegistered && relayAddress) {
            try {
              const relayMsgs = await r.cli.relayDmPoll(relayAddress);
              for (const c of relayToC2c(relayMsgs)) drained.push(c);
            } catch {
              // relay hiccup — ignore
            }
          }
          const combined = [...readSpool(SPOOL_DIR, sid), ...drained];
          const fresh = filterNovel(combined, dedup);
          const rendered =
            fresh.length === 0
              ? "(no messages)"
              : fresh.map((m) => formatEnvelope(m, r.identity.alias)).join("\n\n");
          const inboxMessages: InboxToolDetails = {
            messages: fresh.map((m) => ({ from: m.from_alias || "unknown", preview: m.content.slice(0, 200) })),
          };
          markDelivered(fresh, dedup);
          clearSpool(SPOOL_DIR, sid);
          return { text: rendered, messages: inboxMessages.messages };
        });
        return toolText(text, { messages } as InboxToolDetails);
      } catch (e) {
        return toolText(`c2c_pi_poll_inbox failed: ${e instanceof Error ? e.message : String(e)}`, { messages: [] } as InboxToolDetails);
      }
    },
    renderResult: (result, _options, theme, context) =>
      renderInboxResult((result.details as InboxToolDetails) ?? { messages: [] }, context.isError, theme),
  });

  pi.registerTool({
    name: "c2c_pi_whoami",
    label: "c2c whoami",
    description: "Show this session's c2c identity (alias + session id).",
    parameters: Type.Object({}),
    renderShell: "self",
    async execute() {
      if (!identity) return toolText(notReadyText, { alias: "", sessionId: "", registered: false } as WhoamiToolDetails);
      const details: WhoamiToolDetails = {
        alias: identity.alias,
        sessionId: identity.sessionId,
        registered,
      };
      return toolText(
        `alias: ${identity.alias}\nsession_id: ${identity.sessionId}\nregistered: ${registered}`,
        details,
      );
    },
    renderResult: (result, _options, theme, context) =>
      renderWhoamiResult((result.details as WhoamiToolDetails) ?? { alias: "", sessionId: "", registered: false }, context.isError, theme),
  });

  pi.registerTool({
    name: "c2c_pi_status",
    label: "c2c status",
    description: "Show this session's current c2c runtime status (idle/processing/tool/input).",
    parameters: Type.Object({}),
    renderShell: "self",
    async execute() {
      const s = statusTracker?.getStatus();
      if (!s) return toolText("c2c: not registered yet (no status tracker).");
      const sinceIso = new Date(s.since).toISOString();
      return toolText(`state: ${s.state}\nsince: ${sinceIso}\nttl_ms: ${s.ttlMs}`);
    },
  });

  pi.registerTool({
    name: "c2c_pi_join_room",
    label: "c2c join room",
    description: "Join a c2c room (N:N channel). Room messages auto-deliver to your transcript.",
    parameters: Type.Object({ room: Type.String({ description: "Room id (e.g. 'swarm-lounge')." }) }),
    renderShell: "self",
    async execute(_id, { room }) {
      const r = ready();
      const details: RoomToolDetails = { room, joined: true };
      if (!r) return toolText(notReadyText, details);
      try {
        await r.cli.joinRoom(room, r.identity.alias);
        return toolText(`Joined room ${room}.`, details);
      } catch (e) {
        return toolText(`c2c_pi_join_room failed: ${e instanceof Error ? e.message : String(e)}`, details);
      }
    },
    renderResult: (result, _options, theme, context) =>
      renderJoinRoomResult(
        (result.details as RoomToolDetails) ?? { room: (context.args as { room: string }).room },
        context.isError,
        theme,
      ),
  });

  pi.registerTool({
    name: "c2c_pi_send_room",
    label: "c2c room send",
    description: "Send a message to a c2c room you have joined.",
    parameters: Type.Object({
      room: Type.String({ description: "Room id." }),
      body: Type.String({ description: "Message body." }),
    }),
    renderShell: "self",
    async execute(_id, { room, body }) {
      const r = ready();
      const details: SendToolDetails = { kind: "room", room };
      if (!r) return toolText(notReadyText, details);
      try {
        await r.cli.sendRoom(room, body);
        return toolText(`Sent to room ${room}.`, details);
      } catch (e) {
        return toolText(`c2c_pi_send_room failed: ${e instanceof Error ? e.message : String(e)}`, details);
      }
    },
    renderCall: (args, theme) => renderSendCall({ kind: "room", room: (args as { room: string }).room }, theme),
    renderResult: (result, _options, theme, context) =>
      renderSendResult(
        (result.details as SendToolDetails) ?? { kind: "room", room: (context.args as { room: string }).room },
        context.isError,
        theme,
      ),
  });

  pi.registerTool({
    name: "c2c_pi_local_info",
    label: "c2c local info",
    description: "Show local c2c node info: alias, session, relay address, broker status. Use when the user asks about their c2c address, identity, or connection status. If not connected to the public relay, advises that connecting enables cross-machine messaging.",
    parameters: Type.Object({}),
    renderShell: "self",
    async execute() {
      const r = ready();
      if (!r) return toolText(notReadyText);

      const info = await buildLocalInfoText();
      const addr = relayRegistered ? relayAddress : undefined;

      const parts = [info];

      if (!addr) {
        parts.push("");
        parts.push(
          "Connect to the public relay to get a persistent address and receive messages over the network. " +
            "Use /c2c-local-info to interactively connect.",
        );
      }

      return toolText(parts.join("\n"));
    },
  });

  pi.registerTool({
    name: "c2c_pi_rooms",
    label: "c2c rooms",
    description: "List the c2c rooms this session is a member of.",
    parameters: Type.Object({}),
    renderShell: "self",
    async execute() {
      const r = ready();
      if (!r) return toolText(notReadyText, { rooms: [] } as RoomsToolDetails);
      try {
        const rooms = await r.cli.myRooms();
        const details: RoomsToolDetails = { rooms };
        return toolText(rooms.length ? rooms.join("\n") : "(no rooms joined)", details);
      } catch (e) {
        return toolText(`c2c_pi_rooms failed: ${e instanceof Error ? e.message : String(e)}`, { rooms: [] } as RoomsToolDetails);
      }
    },
    renderResult: (result, _options, theme, context) =>
      renderRoomsResult((result.details as RoomsToolDetails) ?? { rooms: [] }, context.isError, theme),
  });

  // --- local info helpers ------------------------------------------------

  /**
   * Build a formatted local info screen. Shared by the command and tool.
   * Fetches relay peers when registered so the screen shows who's reachable.
   */
  async function buildLocalInfoText(): Promise<string> {
    const alias = identity?.alias ?? "(not registered)";
    const sessionId = identity?.sessionId ?? "(none)";
    const hostHash = relayEnabled ? computeHostHash() : undefined;
    const addr = relayRegistered ? relayAddress ?? "---" : "---";
    const xrepo = crossRepoEnabled
      ? crossRepoSessionsRegistered
        ? "connected"
        : crossRepoSessionsError
          ? `error: ${crossRepoSessionsError}`
          : "not connected"
      : "disabled";
    const relay = !relayEnabled
      ? "disabled (C2C_PI_RELAY=0)"
      : relayRegistered
        ? "connected"
        : relayError
          ? `error: ${relayError}`
          : "not connected";

    const lines = [
      "c2c local info",
      "─".repeat(36),
      `  alias       ${alias}`,
      `  session     ${sessionId}`,
      `  host_hash   ${hostHash ?? "(n/a)"}`,
      `  address     ${addr}`,
      "",
      `  broker      ${registered ? "connected" : registerError ?? "not connected"}`,
      `  cross-repo  ${xrepo}`,
      `  relay       ${relay}`,
      `  poll        ${pollIntervalMs}ms`,
    ];

    // Show relay peers when registered.
    if (relayRegistered && cli) {
      try {
        const peers = await cli.relayList();
        if (peers.length > 0) {
          lines.push("");
          lines.push("  relay peers");
          for (const p of peers) {
            const status = p.alive ? "●" : "○";
            lines.push(`    ${status} ${p.alias}`);
          }
        }
      } catch {
        // relay list is best-effort
      }
    }

    return lines.join("\n");
  }

  /**
   * Attempt to register with the public relay interactively. Called by
   * `/c2c-local-info` when the session is not yet relay-registered.
   * Returns the relay alias on success, or undefined on failure/cancel.
   */
  async function ensureRelayRegistered(
    ui: ExtensionContext["ui"],
  ): Promise<string | undefined> {
    if (!relayEnabled) {
      ui.notify(
        "Relay is disabled. Set C2C_PI_RELAY=1 and restart to enable.",
        "info",
      );
      return undefined;
    }
    if (!identity || !cli) {
      ui.notify("c2c: not registered yet.", "warning");
      return undefined;
    }

    const choice = await ui.select("Connect to public relay?", [
      "Connect now",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return undefined;

    try {
      const relayUrl = (process.env.C2C_PI_RELAY_URL ?? "").trim() || "https://relay.c2c.im";
      const existing = await cli.relaySetupShow().catch(() => null);
      if (!existing || !existing.url) {
        await cli.relaySetup({ url: relayUrl });
      }
      const hostHash = computeHostHash();
      const relayAlias = deriveRelayAlias(identity.alias, hostHash);
      await cli.relayRegister(relayAlias, { relayUrl });
      relayRegistered = true;
      relayAddress = relayAlias;
      relayError = undefined;
      return relayAlias;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      ui.notify(`Relay registration failed: ${msg}`, "error");
      return undefined;
    }
  }

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
        crossRepoEnabled,
        sessionsBrokerRoot,
        crossRepoSessionsRegistered,
        crossRepoSessionsError,
        peerStatusCount: peerStatusStore.size(),
        peerStatusSample: peerStatusStore
          .live()
          .slice(0, 5)
          .map(({ alias, entry }) => ({
            alias,
            state: entry.state,
            since: entry.since,
            ttlMs: entry.ttlMs,
          })),
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

  pi.registerCommand("c2c-status-now", {
    description: "Show this session's current c2c runtime status",
    handler: async (_args, ctx) => {
      const s = statusTracker?.getStatus();
      if (!s) return ctx.ui.notify("c2c: not registered yet (no status tracker).", "warning");
      ctx.ui.notify(`state: ${s.state}\nsince: ${new Date(s.since).toISOString()}\nttl_ms: ${s.ttlMs}`, "info");
    },
  });

  pi.registerCommand("c2c-peers", {
    description: "List registered c2c peers. Merges per-repo, cross-repo (sessions broker), and public-relay peers (when registered); annotates each with their last-known status.",
    handler: async (_args, ctx) => {
      const r = ready();
      if (!r) return ctx.ui.notify(notReadyText, "warning");
      try {
        // Per-repo broker list (always)
        const localPeers = await r.cli.list();
        // Cross-repo / sessions broker list (when enabled)
        const remotePeers = sessionsBrokerRoot
          ? await r.cli.list({ brokerRoot: sessionsBrokerRoot }).catch(() => [])
          : [];
        // Public relay list (when registered). Relay peers use the
        // `<alias>#<host_hash>` format — we keep the full alias as the
        // dedup key since relay has no session_id we can correlate with.
        const relayPeers = relayRegistered
          ? await r.cli.relayList().catch(() => [])
          : [];
        // Merge + dedup by session_id, prefer the live entry. Local and
        // cross-repo share the session_id keyspace; relay uses a prefixed
        // key to avoid collision (relay identities have no session_id).
        const bySid = new Map<string, { alias: string; alive: boolean; tag: "local" | "cross" | "relay" }>();
        for (const p of localPeers) {
          bySid.set(p.session_id, { alias: p.alias, alive: p.alive, tag: "local" });
        }
        for (const p of remotePeers) {
          const existing = bySid.get(p.session_id);
          if (!existing) {
            bySid.set(p.session_id, { alias: p.alias, alive: p.alive, tag: "cross" });
          } else if (!existing.alive && p.alive) {
            bySid.set(p.session_id, { alias: p.alias, alive: p.alive, tag: existing.tag });
          }
        }
        for (const p of relayPeers) {
          const key = `relay:${p.alias}`;
          const existing = bySid.get(key);
          if (!existing) {
            bySid.set(key, { alias: p.alias, alive: p.alive, tag: "relay" });
          } else if (!existing.alive && p.alive) {
            bySid.set(key, { alias: p.alias, alive: p.alive, tag: existing.tag });
          }
        }
        const merged = Array.from(bySid.values()).sort((a, b) => {
          if (a.alive !== b.alive) return a.alive ? -1 : 1;
          return a.alias.localeCompare(b.alias);
        });
        if (merged.length === 0) return ctx.ui.notify("No peers registered.", "info");
        const lines = merged.map((p) => {
          const status = peerStatusStore.get(p.alias);
          const statusSuffix = status ? `  [${status.state}]` : "";
          const tagSuffix = p.tag === "cross"
            ? "  [cross-repo]"
            : p.tag === "relay"
              ? "  [relay]"
              : "";
          return `${p.alive ? "●" : "○"} ${p.alias}${tagSuffix}${statusSuffix}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
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
    description: "Send a DM: /c2c-send <alias> <message...>. Routes via sessions broker first, then per-repo broker, then public relay (when registered) for cross-machine peers.",
    handler: async (args, ctx) => {
      const r = ready();
      if (!r) return ctx.ui.notify(notReadyText, "warning");
      const m = args.trim().match(/^(\S+)\s+([\s\S]+)$/);
      if (!m) {
        return ctx.ui.notify("usage: /c2c-send <alias> <message...>", "warning");
      }
      const target = m[1];
      const body = m[2];
      // Try each transport in order until one accepts the target. Same
      // routing as the LLM-facing c2c_pi_send tool — exhaust local first
      // (which know more aliases) before falling through to relay.
      const hops: Array<{ kind: "sessions" | "per-repo" | "relay"; root?: string }> = [];
      if (sessionsBrokerRoot) hops.push({ kind: "sessions", root: sessionsBrokerRoot });
      hops.push({ kind: "per-repo" });
      if (relayRegistered && relayAddress) hops.push({ kind: "relay" });
      let lastErr: unknown = null;
      for (const hop of hops) {
        try {
          if (hop.kind === "relay") {
            await r.cli.relayDmSend(target, body, relayAddress!);
          } else {
            await r.cli.send(target, body, { brokerRoot: hop.root });
          }
          return ctx.ui.notify(`Sent to ${target} (via ${hop.kind}).`, "info");
        } catch (e: unknown) {
          lastErr = e;
          const msg = e instanceof Error ? e.message : String(e);
          // If the error says "not registered", try the next broker.
          if (!/not[_ ]?registered|unknown[_ ]?alias|alias[_ ]?not[_ ]?found/i.test(msg)) {
            return ctx.ui.notify(
              `c2c send failed (${hop.kind}): ${msg}`,
              "error",
            );
          }
        }
      }
      ctx.ui.notify(
        `c2c send failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        "error",
      );
    },
  });

  pi.registerCommand("c2c-local-info", {
    description: "Show local c2c info (alias, address, brokers, relay) with option to copy address",
    handler: async (_args, ctx) => {
      // If not relay-connected yet, offer to connect first.
      if (!relayRegistered && relayEnabled) {
        const connected = await ensureRelayRegistered(ctx.ui);
        if (connected) {
          // Refresh the info screen after connecting.
        }
      }

      // Show the info screen with actionable options.
      const info = await buildLocalInfoText();
      const addr = relayRegistered ? relayAddress : undefined;

      const options: string[] = [];
      if (addr) {
        options.push(`📋 Copy address: ${addr}`);
      }
      options.push("Close");

      const choice = await ctx.ui.select(info, options);
      if (choice?.startsWith("📋 Copy address")) {
        try {
          await copyToClipboard(addr!);
          ctx.ui.notify(`Copied: ${addr}`, "info");
        } catch {
          ctx.ui.notify(`Address: ${addr}  (clipboard copy failed)`, "warning");
        }
      }
    },
  });
}

// ── module-level helpers ────────────────────────────────────────────

/**
 * Map a relay DM envelope (`fromAlias`/`toAlias`) into the broker DM shape
 * (`from_alias`/`to_alias`) so the rest of the drain pipeline is identical
 * to local broker messages — status filtering, dedup, spool, inject.
 *
 * Exported as a top-level pure function (not an extension closure) so it's
 * directly unit-testable without spinning up the whole extension.
 */
export function relayToC2c(msgs: RelayMessage[]): C2cMessage[] {
  const out: C2cMessage[] = [];
  for (const m of msgs) {
    out.push({
      from_alias: m.fromAlias,
      to_alias: m.toAlias,
      content: m.content,
      ts: m.ts,
    });
  }
  return out;
}
