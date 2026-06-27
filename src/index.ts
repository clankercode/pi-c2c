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

import { createRequire } from "node:module";
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
import { HELP_TOPICS, renderC2cPiHelp } from "./help.ts";
import { computeHostHash, deriveRelayAlias } from "./relay.ts";
import { buildSendHops, drainAllSources, executeSend, mergePeerLists } from "./routing.ts";
import { BrokerWatcher, startPerRepoWatcher, startSessionsWatcher } from "./broker-watcher.ts";
import { RelayWatcher, type RelayWatcherState } from "./relay-watcher.ts";
import { PeerStatusStore, extractStatusMessages } from "./peer-status.ts";
import { createStatusTracker, formatStatusEnvelope, type StatusTracker } from "./status-sync.ts";
import { registerC2cMessageRenderer, type C2cDeliveryDetails } from "./ui/compact-message.ts";
import { registerSubagentRegistrationRenderer } from "./ui/compact-subagent-registration.ts";
import { createLiveDebugComponent } from "./ui/live-debug.ts";
import { createLiveTelemetry, type LiveTelemetry, type MessageSource } from "./telemetry.ts";
import {
  appendSubagentPromptContext,
  buildRegistrationMessageArgs,
  getParentAlias,
  notifySubagentRegistered,
  observeSubagentRegistrations,
  observeSubagentRegistrationsFor,
  readSubagentLoadHint,
  setParentAlias,
} from "./subagent.ts";
import {
  buildPeerListDetails,
  formatPeerListText,
  renderEmptyCall,
  renderInboxResult,
  renderJoinRoomResult,
  renderListResult,
  renderLocalInfoResult,
  renderRoomsResult,
  renderSendResult,
  renderStatusResult,
  renderWhoamiResult,
  type InboxToolDetails,
  type ListToolDetails,
  type LocalInfoToolDetails,
  type RoomToolDetails,
  type RoomsToolDetails,
  type SendToolDetails,
  type StatusToolDetails,
  type WhoamiToolDetails,
} from "./ui/tool-renderers.ts";

const requirePackageJson = createRequire(import.meta.url);
export const PI_C2C_VERSION = (requirePackageJson("../package.json") as { version?: string }).version ?? "unknown";

const STATUS_KEY = "c2c";
// Default to 5s. The pollTick drains 3 sources (per-repo, sessions, relay)
// and dedups + injects. At 5s, worst-case e2e latency is ~5s + ~1s drain =
// ~6s, down from the old 30s default which made relay messages routinely
// take 30-45s. C2C_PI_POLL_INTERVAL_MS overrides (min 1000ms) for power
// users; inotify push delivery is the next step (see task #35).
const DEFAULT_POLL_INTERVAL_MS = 5_000;

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
  prevSessionByScope?: Record<string, string>;
}
function gstate(): PiC2cGlobal {
  const g = globalThis as { __c2cPiState?: PiC2cGlobal };
  if (!g.__c2cPiState) {
    g.__c2cPiState = {
      hostSessionEnvCaptured: false,
      hostSessionEnv: undefined,
      prevSessionByScope: {},
    };
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
  const subagentHint = readSubagentLoadHint();
  const subagentParentAliasAtLoad = getParentAlias();
  registerC2cMessageRenderer(pi);
  registerSubagentRegistrationRenderer(pi);
  // --- per-session state (single process; closure-scoped) -------------------
  const barState: PiC2cBarState = {};
  let cli: C2cCli | null = null;
  let identity: Identity | null = null;
  let registered = false;
  let registerError: string | undefined;
  let ctxRef: ExtensionContext | null = null;
  // Push delivery (slice 1 of push-delivery design): fs.watch-based
  // watchers fire an immediate `pollTick` on broker inbox changes,
  // demoting the setInterval to a long safety net. See src/broker-watcher.ts.
  let perRepoWatcher: BrokerWatcher | null = null;
  let sessionsWatcher: BrokerWatcher | null = null;
  // Push delivery (slice 3 of push-delivery design): WebSocket-based
  // watcher spawns `c2c relay subscribe` and fires `pollTick` on DM frames.
  let relayWatcher: RelayWatcher | null = null;
  let relayWsState: RelayWatcherState | undefined;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  // Safety net: poll every 60s as a fallback if the fs.watch watcher
  // misses an event (e.g. atomic file replace, network mount, etc.).
  const SAFETY_NET_POLL_MS = 60_000;
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
  // Live telemetry for the `/c2c-live-debug` dashboard. Records counters,
  // timestamps, and small previews without affecting the normal message path.
  const telemetry: LiveTelemetry = createLiveTelemetry();

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
  /**
   * The opaque_host_id the relay has on file for us. Computed locally
   * (`computeHostHash()`) and verified against the relay's stored value
   * after registration. If the two disagree, something is wrong
   * upstream (relay API change, env-var drift, recipe mismatch) and
   * `relayError` captures the discrepancy. C2c slice 1 of the
   * opaque_host_id design plumbed the field through the lease
   * (`ocaml/relay.ml:RegistrationLease.opaque_host_id`); this is the
   * extension's consumer side.
   */
  let relayHostId: string | undefined;
  let relayHostIdVerified: boolean = false;

  // Tracks when the most recent followUp message was queued (ms since
  // epoch). Used by the renderer's status line and the debug output to
  // surface "this followUp has been waiting X seconds" — useful for
  // debugging the delivery delay.
  let queuedSinceMs: number | undefined;
  let stopSubagentObserver: (() => void) | null = null;
  let stopSelfObserver: (() => void) | null = null;

  function spoolScopeKey(id: Identity): string {
    if (!subagentHint) return "parent";
    return `subagent:${subagentHint.agentId ?? id.sessionId}`;
  }

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
    // If any message in the batch is nonurgent, the whole batch uses
    // followUp (no interrupt, no steer). Otherwise: triggerTurn+steer
    // (interrupt the current turn and act now). This is the new default
    // — see deliveryOptionsFor in delivery.ts.
    const allNonurgent = novel.every((m) => m.nonurgent === true);
    const body = novel.map((m) => formatEnvelope(m, identity?.alias)).join("\n\n");
    const details: C2cDeliveryDetails = {
      count: novel.length,
      senders: [...new Set(novel.map((m) => m.from_alias || "unknown"))],
      selfAlias: identity?.alias,
      source: novel.every((m) => m.brokerSource === novel[0]?.brokerSource)
        ? novel[0]?.brokerSource
        : undefined,
    };
    // Track queuedSince for followUp messages (used by the renderer's
    // status line and the debug output).
    if (allNonurgent) {
      queuedSinceMs = Date.now();
    }
    try {
      pi.sendMessage(
        { customType: "c2c", content: body, display: true, details },
        deliveryOptionsFor({ nonurgent: allNonurgent }),
      );
    } catch {
      return false;
    }
    telemetry.recordInjected(novel.length);
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
    telemetry.beginPoll();
    await serializeDrain(async () => {
      if (shuttingDown) return;
      // Poll both the per-repo broker and the sessions broker (when
      // cross-repo is enabled). Messages may arrive in either; dedup
      // collapses duplicates. A failing sessions broker should not
      // break local delivery.
      const drained: C2cMessage[] = [];
      try {
        const localMsgs = await cli!.pollInbox();
        for (const m of localMsgs) m.brokerSource = "local";
        drained.push(...localMsgs);
        telemetry.recordBrokerOk("local");
      } catch (e) {
        telemetry.recordBrokerError("local", e);
      }
      if (sessionsBrokerRoot) {
        try {
          const sessionMsgs = await cli!.pollInbox({ brokerRoot: sessionsBrokerRoot });
          for (const m of sessionMsgs) m.brokerSource = "sessions";
          drained.push(...sessionMsgs);
          telemetry.recordBrokerOk("sessions");
        } catch (e) {
          telemetry.recordBrokerError("sessions", e);
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
          telemetry.recordRelayOk();
        } catch (e) {
          telemetry.recordRelayError(e);
        }
      }
      // Record every drained message for the live debug dashboard.
      // Status envelopes are still tracked separately below, but we want
      // the raw arrival count and preview in telemetry.
      for (const m of drained) {
        const source: MessageSource = m.source === "relay" ? "relay" : m.brokerSource ?? "local";
        telemetry.recordReceived({ from: m.from_alias, content: m.content, source });
      }
      // Silently track peer status envelopes: any message that parses as a
      // status envelope is recorded in `peerStatusStore` and dropped from
      // delivery. The LLM never sees them; the human chat never sees them
      // as a "new message" notification. They live on as a per-peer state
      // that `c2c_pi_list` and `/c2c-pi-debug` can surface.
      const { messages: deliverable } = extractStatusMessages(drained, peerStatusStore);
      telemetry.recordPeerStatusCount(peerStatusStore.live().length);
      const spooled = readSpool(SPOOL_DIR, sid);
      telemetry.recordSpoolCount(spooled.length);
      const combined = [...spooled, ...deliverable];
      const novel = filterNovel(combined, dedup);
      if (novel.length === 0) {
        if (combined.length > 0) clearSpool(SPOOL_DIR, sid); // already delivered
        telemetry.endPoll();
        return;
      }
      writeSpool(SPOOL_DIR, sid, novel); // persist before injecting
      telemetry.recordSpoolCount(novel.length);
      if (shuttingDown) {
        telemetry.endPoll();
        return; // teardown started — leave spool for next start
      }
      if (inject(novel)) {
        markDelivered(novel, dedup);
        clearSpool(SPOOL_DIR, sid);
        telemetry.recordSpoolCount(0);
      }
      // else: spool persists, dedup unmarked → retried next tick
      telemetry.endPoll();
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

  pi.on("before_agent_start", async (event) => {
    if (!subagentHint || !identity) return;
    const parentAlias = subagentParentAliasAtLoad ?? getParentAlias();
    if (!parentAlias) return;
    return {
      systemPrompt: appendSubagentPromptContext(event.systemPrompt, {
        selfAlias: identity.alias,
        parentAlias,
      }),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    shuttingDown = false;
    telemetry.startSession();
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
      sessionIdEnv: subagentHint ? undefined : gs.hostSessionEnv,
      subagent: subagentHint
        ? {
            ...subagentHint,
            parentAlias: subagentParentAliasAtLoad ?? getParentAlias() ?? process.env.C2C_PI_ALIAS,
          }
        : undefined,
    });
    identity = res.identity;
    registered = res.ok;

    // On an in-process session switch our id changes; carry the previous
    // session's undelivered spool over to the new one (process-local, so we
    // never steal another live pi process's spool), then bound accumulation
    // by GC-ing week-old spool files (safe across concurrent pi processes).
    const scopeKey = spoolScopeKey(identity);
    const prevSessionId = gs.prevSessionByScope?.[scopeKey];
    if (prevSessionId && prevSessionId !== identity.sessionId) {
      const carried = readSpool(SPOOL_DIR, prevSessionId);
      if (carried.length > 0) {
        writeSpool(SPOOL_DIR, identity.sessionId, [
          ...readSpool(SPOOL_DIR, identity.sessionId),
          ...carried,
        ]);
      }
      clearSpool(SPOOL_DIR, prevSessionId);
    }
    if (!gs.prevSessionByScope) gs.prevSessionByScope = {};
    gs.prevSessionByScope[scopeKey] = identity.sessionId;
    gs.prevSessionId = identity.sessionId;
    gcStaleSpools(SPOOL_DIR, SPOOL_TTL_MS, Date.now());

    if (res.ok) {
      if (!subagentHint) {
        setParentAlias(identity.alias);
        if (!stopSubagentObserver) {
          stopSubagentObserver = observeSubagentRegistrations((notice, registration) => {
            try {
              const args = buildRegistrationMessageArgs(notice, registration);
              pi.sendMessage(args.message, args.options);
            } catch {
              // Best-effort: parent notices are useful but not delivery-critical.
            }
          });
        }
      } else {
        // Register this agent's own observer so it can receive notifications
        // from its own children (nested subagents). The observer is keyed by
        // this agent's ID so notifySubagentRegistered routes grandchild
        // registrations to the correct parent, not the root coordinator.
        const selfAgentId = subagentHint.agentId;
        if (selfAgentId) {
          stopSelfObserver = observeSubagentRegistrationsFor(selfAgentId, (notice, registration) => {
            try {
              const args = buildRegistrationMessageArgs(notice, registration);
              pi.sendMessage(args.message, args.options);
            } catch {
              // Best-effort.
            }
          });
        }
        notifySubagentRegistered({
          agentId: selfAgentId,
          alias: identity.alias,
          parentAgentId: subagentHint.parentAgentId,
        });
      }
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
        
        // Pre-check: relay registration requires a local Ed25519 identity.
        // If missing, skip registration with an actionable error instead of
        // letting a PoW/prod relay fail with a raw `missing_proof_field` error.
        const relayIdentityCheck = await cli!.relayIdentity().catch(() => null);
        if (!relayIdentityCheck) {
          relayRegistered = false;
          relayError = "no relay identity; run `c2c relay identity init` to create one";
          // Skip relay registration entirely — proceed with local broker only.
        } else {
          // Ensure relay setup has been run so the CLI knows the relay URL.
          const existing = await cli!.relaySetupShow().catch(() => null);
          if (!existing || !existing.url) {
            await cli!.relaySetup({ url: relayUrl });
          }
          const hostHash = computeHostHash();
          const relayAlias = deriveRelayAlias(identity.alias, hostHash);
          const reg = await cli!.relayRegister(relayAlias, { relayUrl });
          relayRegistered = true;
          relayAddress = relayAlias;
          relayError = undefined;
          // The relay stores our opaque_host_id in the lease (c2c slice 1 of
          // the opaque_host_id design). Use it if present; otherwise fall back
          // to the address host part.
          relayHostId = reg?.opaqueHostId ?? relayAlias.split("@")[1];
          relayHostIdVerified = relayHostId === hostHash;
          // Sanity-check via relay list that the stored id matches what we
          // sent. This catches env-var drift, relay API changes, and recipe
          // mismatches early.
          try {
            const peers = await cli!.relayList();
            const self = peers.find((p) => p.alias === relayAlias);
            if (self) {
              const suffix = self.opaqueHostId ?? self.alias.split("@")[1];
              if (suffix && suffix !== hostHash) {
                relayHostIdVerified = false;
                relayError = `opaque_host_id mismatch: local=${hostHash} relay=${suffix}`;
              } else if (suffix === hostHash) {
                relayHostIdVerified = true;
              }
            }
          } catch {
            // Verification is best-effort; don't fail the whole registration
            // over a list call that didn't work.
          }

          // Start the relay WebSocket watcher (slice 3 of push-delivery design).
          // Spawns `c2c relay subscribe` and fires pollTick on DM frames.
          if (relayWatcher) relayWatcher.stop();
          relayWatcher = new RelayWatcher({
            alias: relayAlias,
            relayUrl,
            onChange: () => void pollTick(),
            onStateChange: (state) => {
              relayWsState = state;
            },
          });
          relayWatcher.start();
          relayWsState = relayWatcher.state;
        }
      } catch (e: unknown) {
        relayRegistered = false;
        relayError = e instanceof Error ? e.message : String(e);
      }
    }

    // Start the auto-delivery poller and do an immediate first drain.
    //
    // Push path: fs.watch the broker inbox files and fire `pollTick`
    // on any change. The 5s setInterval is replaced with a 60s safety
    // net that catches events the watcher missed (atomic file replace,
    // network mount races, etc.). Latency: 5s → ~50ms on local brokers.
    //
    // Relay path: RelayWatcher spawns `c2c relay subscribe` and fires
    // pollTick on WebSocket DM frames. The safety-net poll is shared.
    if (perRepoWatcher) perRepoWatcher.stop();
    // The per-repo broker root comes from C2C_MCP_BROKER_ROOT (the c2c
    // binary's C2c_repo_fp module resolves it from the git fingerprint).
    // If unset, the broker hasn't been initialized yet — skip the watcher
    // and let the safety-net pollTick catch up.
    const perRepoBrokerRoot = process.env.C2C_MCP_BROKER_ROOT;
    if (perRepoBrokerRoot) {
      perRepoWatcher = startPerRepoWatcher(
        perRepoBrokerRoot,
        identity.sessionId,
        () => void pollTick(),
      );
    }
    if (sessionsBrokerRoot) {
      if (sessionsWatcher) sessionsWatcher.stop();
      sessionsWatcher = startSessionsWatcher(
        sessionsBrokerRoot,
        identity.sessionId,
        () => void pollTick(),
      );
    }
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void pollTick();
      }, SAFETY_NET_POLL_MS);
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
    if (perRepoWatcher) {
      perRepoWatcher.stop();
      perRepoWatcher = null;
    }
    if (sessionsWatcher) {
      sessionsWatcher.stop();
      sessionsWatcher = null;
    }
    if (relayWatcher) {
      relayWatcher.stop();
      relayWatcher = null;
    }
    relayWsState = undefined;
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
    relayHostId = undefined;
    relayHostIdVerified = false;
    peerStatusStore.clear();
    if (!subagentHint) {
      setParentAlias(undefined);
      stopSubagentObserver?.();
      stopSubagentObserver = null;
    }
    stopSelfObserver?.();
    stopSelfObserver = null;
  });

  // --- helpers for tools/commands -------------------------------------------

  function ready(): { cli: C2cCli; identity: Identity } | null {
    return cli && identity && registered ? { cli, identity } : null;
  }

  const notReadyText = "c2c: not registered yet (broker unreachable?). Run `/c2c-status` or `c2c doctor`.";

  /**
   * Fetch and merge every reachable peer (per-repo, sessions broker when
   * cross-repo is enabled, public relay when registered). Shared by the
   * `c2c_pi_list` tool and the `/c2c-peers` command so they never drift.
   */
  async function fetchMergedPeers(r: { cli: C2cCli }) {
    const localPeers = await r.cli.list();
    const remotePeers = sessionsBrokerRoot
      ? await r.cli.list({ brokerRoot: sessionsBrokerRoot }).catch(() => [])
      : [];
    const relayPeers = relayRegistered
      ? await r.cli.relayList().catch(() => [])
      : [];
    return mergePeerLists(localPeers, remotePeers, relayPeers);
  }

  /**
   * Build the list-tool details + LLM/human text from merged peers. Live peers
   * only unless `includeDead`; dead peers are counted into `hiddenDead` so the
   * UI can acknowledge them without listing every zombie. Each shown peer is
   * enriched with its last-known runtime state from the peer status store.
   */
  function buildPeerListResult(
    merged: ReturnType<typeof mergePeerLists>,
    includeDead: boolean,
    revealHint?: string,
  ): { details: ListToolDetails; text: string } {
    const details = buildPeerListDetails(
      merged,
      includeDead,
      (alias) => peerStatusStore.get(alias)?.state,
    );
    return { details, text: formatPeerListText(details, revealHint) };
  }

  // --- tools (LLM-callable) -------------------------------------------------

  pi.registerTool({
    name: "c2c_pi_help",
    label: "c2c help",
    description: "Teach a pi agent how to use pi-c2c tools, reply to inbound c2c messages, and map to generic c2c MCP/CLI concepts.",
    parameters: Type.Object({
      topic: Type.Optional(
        Type.Union(
          HELP_TOPICS.map((topic) => Type.Literal(topic)),
          { description: "Help topic to show. Defaults to overview." },
        ),
      ),
    }),
    async execute(_id, { topic }) {
      return toolText(renderC2cPiHelp(topic));
    },
  });

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
        relayEnabled,
        relayRegistered,
        relayAddress,
        relayHostId,
        relayHostIdVerified,
        relayError,
        relayWsState,
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
        queuedSinceMs,
      });
      return toolText(text);
    },
  });

  pi.registerTool({
    name: "c2c_pi_send",
    label: "c2c send",
    description: "Send a c2c direct message to a peer agent by alias. Prefer this over the generic c2c_send tool: this extension routes via the sessions broker first (cross-repo), then the per-repo broker, then the public relay (when registered) for cross-machine peers. Set `nonurgent` to opt out of interrupt+steer delivery on the receiver side (default is triggerTurn+steer — c2c messages are high-priority by default).",
    parameters: Type.Object({
      target: Type.String({ description: "Recipient alias (e.g. 'lyra-quill') or session id." }),
      body: Type.String({ description: "Message body." }),
      nonurgent: Type.Optional(
        Type.Boolean({ description: "If true, the receiver uses followUp delivery (no interrupt, no steer) instead of the default triggerTurn+steer. Use for non-time-sensitive messages like FYIs or status updates." }),
      ),
    }),
    renderShell: "self",
    async execute(_id, { target, body, nonurgent }) {
      const r = ready();
      const details: SendToolDetails = { kind: "dm", target, body, nonurgent: nonurgent ?? false };
      if (!r) return toolText(notReadyText, { ...details, error: "not registered" });
      // Try each transport in order until one accepts the target.
      const hops = buildSendHops({ sessionsBrokerRoot, relayRegistered: relayRegistered && !!relayAddress });
      const result = await executeSend(r.cli, hops, target, body, relayAddress, r.identity.alias);
      details.via = result.via;
      if (result.ok) {
        telemetry.recordSent(target, result.via);
        const tag = nonurgent ? " (nonurgent)" : "";
        return toolText(`Sent to ${target} (via ${result.via})${tag}.`, details);
      }
      return toolText(`c2c_pi_send failed (${result.via}): ${result.message}`, { ...details, error: "failed", errorDetail: result.message });
    },
    renderCall: () => renderEmptyCall(),
    renderResult: (result, options, theme, context) =>
      renderSendResult(
        (result.details as SendToolDetails) ?? (context.args as unknown as SendToolDetails),
        context.isError,
        theme,
        options.expanded,
      ),
  });

  pi.registerTool({
    name: "c2c_pi_send_all",
    label: "c2c broadcast",
    description: "Broadcast a c2c message to all registered peers. Prefer this over the generic c2c_send_all tool because this extension broadcasts through the extension's registered identity.",
    parameters: Type.Object({
      body: Type.String({ description: "Message body." }),
      exclude: Type.Optional(
        Type.Array(Type.String(), { description: "Aliases to skip." }),
      ),
    }),
    renderShell: "self",
    async execute(_id, { body, exclude }) {
      const r = ready();
      const details: SendToolDetails = { kind: "broadcast", body, via: "sessions" };
      if (!r) return toolText(notReadyText, { ...details, error: "not registered" });
      try {
        await r.cli.sendAll(body, { exclude, from: r.identity.alias });
        telemetry.recordSent("(broadcast)", "broadcast");
        return toolText("Broadcast sent.", details);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return toolText(`c2c_pi_send_all failed: ${message}`, { ...details, error: "failed", errorDetail: message });
      }
    },
    renderCall: () => renderEmptyCall(),
    renderResult: (result, options, theme, context) =>
      renderSendResult(
        (result.details as SendToolDetails) ?? { kind: "broadcast" },
        context.isError,
        theme,
        options.expanded,
      ),
  });

  pi.registerTool({
    name: "c2c_pi_list",
    label: "c2c peers",
    description: "List LIVE registered c2c peers and their liveness. Merges per-repo, cross-repo (sessions broker), and public-relay peers (when registered) so one call shows every reachable alias, annotated with last known status (idle/processing/tool/input) when available. Subagents are nested under their parent. Dead/unreachable peers are hidden by default (their count is shown); pass include_dead=true to list them. Prefer this over the generic c2c_list tool.",
    parameters: Type.Object({
      include_dead: Type.Optional(
        Type.Boolean({ description: "Include dead/unreachable peers. Default false (live peers only)." }),
      ),
    }),
    renderShell: "self",
    async execute(_id, { include_dead }) {
      const r = ready();
      if (!r) return toolText(notReadyText, { peers: [], error: "not registered" } as ListToolDetails);
      try {
        const merged = await fetchMergedPeers(r);
        const { details, text } = buildPeerListResult(merged, include_dead === true);
        return toolText(text, details);
      } catch (e) {
        return toolText(`c2c_pi_list failed: ${e instanceof Error ? e.message : String(e)}`, { peers: [], error: "failed" } as ListToolDetails);
      }
    },
    renderCall: () => renderEmptyCall(),
    renderResult: (result, _options, theme, context) =>
      renderListResult((result.details as ListToolDetails) ?? { peers: [] }, context.isError, theme),
  });

  pi.registerTool({
    name: "c2c_pi_poll_inbox",
    label: "c2c inbox",
    description: "Drain and return any queued inbound c2c messages now. Prefer this over the generic c2c_poll_inbox tool: it drains per-repo, sessions-broker, and public-relay (when registered) so a manual call shows the same picture as the background poller.",
    parameters: Type.Object({}),
    renderShell: "self",
    async execute() {
      const r = ready();
      if (!r) return toolText(notReadyText, { messages: [], error: "not registered" } as InboxToolDetails);
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
          const drained = await drainAllSources(r.cli, {
            sessionsBrokerRoot,
            relayRegistered: relayRegistered && !!relayAddress,
            relayAddress,
            relayToC2c,
          });
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
        return toolText(`c2c_pi_poll_inbox failed: ${e instanceof Error ? e.message : String(e)}`, { messages: [], error: "failed" } as InboxToolDetails);
      }
    },
    renderCall: () => renderEmptyCall(),
    renderResult: (result, _options, theme, context) =>
      renderInboxResult((result.details as InboxToolDetails) ?? { messages: [] }, context.isError, theme),
  });

  pi.registerTool({
    name: "c2c_pi_whoami",
    label: "c2c whoami",
    description: "Show this session's c2c identity (alias + session id). Prefer this over the generic c2c_whoami tool when working inside this pi-c2c extension.",
    parameters: Type.Object({}),
    renderShell: "self",
    async execute() {
      if (!identity) return toolText(notReadyText, { alias: "", sessionId: "", registered: false, error: "not registered" } as WhoamiToolDetails);
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
    renderCall: () => renderEmptyCall(),
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
      if (!s) return toolText("c2c: not registered yet (no status tracker).", { registered: false } as StatusToolDetails);
      const sinceIso = new Date(s.since).toISOString();
      return toolText(
        `state: ${s.state}\nsince: ${sinceIso}\nttl_ms: ${s.ttlMs}`,
        { state: s.state, since: sinceIso, ttlMs: s.ttlMs, registered: true } as StatusToolDetails,
      );
    },
    renderCall: () => renderEmptyCall(),
    renderResult: (result, _options, theme, context) =>
      renderStatusResult((result.details as StatusToolDetails) ?? { registered: false }, context.isError, theme),
  });

  pi.registerTool({
    name: "c2c_pi_join_room",
    label: "c2c join room",
    description: "Join a c2c room (N:N channel). Prefer this over the generic c2c_join_room tool when working inside this pi-c2c extension. Room messages auto-deliver to your transcript.",
    parameters: Type.Object({ room: Type.String({ description: "Room id (e.g. 'swarm-lounge')." }) }),
    renderShell: "self",
    async execute(_id, { room }) {
      const r = ready();
      const details: RoomToolDetails = { room, joined: true };
      if (!r) return toolText(notReadyText, { ...details, error: "not registered" });
      try {
        await r.cli.joinRoom(room, r.identity.alias);
        return toolText(`Joined room ${room}.`, details);
      } catch (e) {
        return toolText(`c2c_pi_join_room failed: ${e instanceof Error ? e.message : String(e)}`, { ...details, error: "failed" });
      }
    },
    renderCall: () => renderEmptyCall(),
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
    description: "Send a message to a c2c room you have joined. Prefer this over the generic c2c_send_room tool when working inside this pi-c2c extension.",
    parameters: Type.Object({
      room: Type.String({ description: "Room id." }),
      body: Type.String({ description: "Message body." }),
    }),
    renderShell: "self",
    async execute(_id, { room, body }) {
      const r = ready();
      const details: SendToolDetails = { kind: "room", room, body, via: "sessions" };
      if (!r) return toolText(notReadyText, { ...details, error: "not registered" });
      try {
        await r.cli.sendRoom(room, body, { from: r.identity.alias });
        telemetry.recordSent(`room:${room}`, "room");
        return toolText(`Sent to room ${room}.`, details);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return toolText(`c2c_pi_send_room failed: ${message}`, { ...details, error: "failed", errorDetail: message });
      }
    },
    renderCall: () => renderEmptyCall(),
    renderResult: (result, options, theme, context) =>
      renderSendResult(
        (result.details as SendToolDetails) ?? { kind: "room", room: (context.args as { room: string }).room },
        context.isError,
        theme,
        options.expanded,
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
      if (!r) {
        return toolText(notReadyText, {
          alias: "(not registered)",
          sessionId: "(none)",
          broker: "not connected",
          crossRepo: "unknown",
          relay: "unknown",
          relayWsState: "---",
          relayHost: "---",
          error: "not registered",
        } as LocalInfoToolDetails);
      }

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

      return toolText(parts.join("\n"), await buildLocalInfoDetails());
    },
    renderCall: () => renderEmptyCall(),
    renderResult: (result, _options, theme, context) =>
      renderLocalInfoResult(
        (result.details as LocalInfoToolDetails) ?? {
          alias: "(unknown)",
          sessionId: "(unknown)",
          broker: "unknown",
          crossRepo: "unknown",
          relay: "unknown",
        },
        context.isError,
        theme,
      ),
  });

  pi.registerTool({
    name: "c2c_pi_rooms",
    label: "c2c rooms",
    description: "List the c2c rooms this session is a member of.",
    parameters: Type.Object({}),
    renderShell: "self",
    async execute() {
      const r = ready();
      if (!r) return toolText(notReadyText, { rooms: [], error: "not registered" } as RoomsToolDetails);
      try {
        const rooms = await r.cli.myRooms();
        const details: RoomsToolDetails = { rooms };
        return toolText(rooms.length ? rooms.join("\n") : "(no rooms joined)", details);
      } catch (e) {
        return toolText(`c2c_pi_rooms failed: ${e instanceof Error ? e.message : String(e)}`, { rooms: [], error: "failed" } as RoomsToolDetails);
      }
    },
    renderCall: () => renderEmptyCall(),
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
    const c2cVersion = cli ? await cli.c2cVersion().catch(() => "unknown") : "unknown";
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
      `  pi-c2c      ${PI_C2C_VERSION}`,
      `  c2c         ${c2cVersion}`,
      `  alias       ${alias}`,
      `  session     ${sessionId}`,
      `  host_hash   ${hostHash ?? "(n/a)"}`,
      `  address     ${addr}`,
      "",
      `  broker      ${registered ? "connected" : registerError ?? "not connected"}`,
      `  cross-repo  ${xrepo}`,
      `  relay       ${relay}`,
      `  relay_ws    ${relayWsState ?? "---"}`,
      // The relay-stored opaque_host_id (verified against our local
      // host_hash after register). Shows `---` when not registered or
      // when the verification hasn't completed yet. The (verified) or
      // (unverified) suffix indicates whether the relay agrees.
      `  relay_host  ${relayHostId ? `${relayHostId}${relayHostIdVerified ? "" : " (unverified)"}` : "---"}`,
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

  async function buildLocalInfoDetails(): Promise<LocalInfoToolDetails> {
    const alias = identity?.alias ?? "(not registered)";
    const c2cVersion = cli ? await cli.c2cVersion().catch(() => "unknown") : "unknown";
    const sessionId = identity?.sessionId ?? "(none)";
    const xrepo = crossRepoEnabled
      ? crossRepoSessionsRegistered
        ? "connected"
        : crossRepoSessionsError
          ? `error: ${crossRepoSessionsError}`
          : "not connected"
      : "disabled";
    const relay = !relayEnabled
      ? "disabled"
      : relayRegistered
        ? "connected"
        : relayError
          ? `error: ${relayError}`
          : "not connected";

    return {
      piC2cVersion: PI_C2C_VERSION,
      c2cVersion,
      alias,
      sessionId,
      broker: registered ? "connected" : registerError ?? "not connected",
      crossRepo: xrepo,
      relay,
      relayWsState: relayWsState ?? "---",
      relayHost: relayHostId ?? "---",
      relayHostVerified: relayHostId ? relayHostIdVerified : undefined,
      address: relayRegistered ? relayAddress : undefined,
    };
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
      await ctx.ui.select(lines.join("\n"), ["Close"]);
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
        relayEnabled,
        relayRegistered,
        relayAddress,
        relayHostId,
        relayHostIdVerified,
        relayError,
        relayWsState,
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
        queuedSinceMs,
      });
      const table = formatDebugTable(raw);
      await ctx.ui.select(table, ["Close"]);
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
      await ctx.ui.select(`state: ${s.state}\nsince: ${new Date(s.since).toISOString()}\nttl_ms: ${s.ttlMs}`, ["Close"]);
    },
  });

  pi.registerCommand("c2c-peers", {
    description: "List LIVE c2c peers (subagents nested under their parent). Merges per-repo, cross-repo (sessions broker), and public-relay peers; annotates each with their last-known status. Pass `all` (or `dead`) to include dead/unreachable peers.",
    handler: async (args, ctx) => {
      const r = ready();
      if (!r) return ctx.ui.notify(notReadyText, "warning");
      const includeDead = /\b(all|dead)\b/i.test(args.trim());
      try {
        const merged = await fetchMergedPeers(r);
        const { details, text } = buildPeerListResult(merged, includeDead, "run `/c2c-peers all`");
        if (details.peers.length === 0) return ctx.ui.notify(text, "info");
        await ctx.ui.select(text, ["Close"]);
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
          const content = fresh.length
            ? fresh.map((m) => `${m.from_alias}: ${m.content}`).join("\n")
            : "(no messages)";
          await ctx.ui.select(content, ["Close"]);
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
      const hops = buildSendHops({ sessionsBrokerRoot, relayRegistered: relayRegistered && !!relayAddress });
      const result = await executeSend(r.cli, hops, target, body, relayAddress, r.identity.alias);
      if (result.ok) {
        telemetry.recordSent(target, result.via);
        return ctx.ui.notify(`Sent to ${target} (via ${result.via}).`, "info");
      }
      ctx.ui.notify(`c2c send failed (${result.via}): ${result.message}`, "error");
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

  pi.registerCommand("c2c-live-debug", {
    description: "Open a live telemetry dashboard for c2c message traffic and broker health",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/c2c-live-debug requires interactive TUI mode", "error");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) =>
        createLiveDebugComponent(
          telemetry,
          theme,
          {
            identity,
            registered,
            relayRegistered,
            relayAddress,
            crossRepoEnabled,
            crossRepoSessionsRegistered,
            pollIntervalMs,
          },
          () => done(),
        ),
      );
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
      source: "relay",
      kind: "dm",
    });
  }
  return out;
}
