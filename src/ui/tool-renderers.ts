/**
 * Tool call and result renderers for pi-c2c tools.
 *
 * These draw concise, theme-aware rows for the extension's own AI-callable
 * tools. The extension factory in src/index.ts provides matching `details`
 * objects in tool results and wires the renderers via `renderShell: "self"`,
 * `renderCall`, and `renderResult`.
 *
 * Rendering convention (see ~/.llm-general/ai-coding/pi/extension-development.md):
 * each c2c tool collapses to a SINGLE leading line `⧓ c2c.<action> · …` that
 * names the tool inline — never the raw `c2c_pi_*` tool name. To achieve one
 * line under `renderShell: "self"` (which stacks the call renderer ABOVE the
 * result renderer) the call slot renders nothing (`renderEmptyCall`) and all
 * content lives in the result renderer. If `renderCall` were simply omitted,
 * pi's call fallback would print the bold raw tool name as a separate row.
 */
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { SUBAGENT_PARENT_BASE_MAX } from "../identity.ts";

const INDENT_C2C = " ";
const INDENT_CHILD = "   ";
/** Extra indent before a first-level child's branch glyph (aligns under parent). */
const TREE_INDENT = "  ";

// ── detail types (consumed by the extension for tool execute return) ───────────

/**
 * Mixed into every tool's details. When set, the tool call did NOT succeed
 * (e.g. not registered, or a caught error) and the renderer shows
 * `⧓ c2c.<action> · <error>` instead of a success-looking line. This is
 * needed because a custom tool's `execute` returning normally never sets pi's
 * `context.isError` (only a thrown error does), so the success/failure signal
 * must travel in `details`.
 */
export interface ToolResultStatus {
  /** Short failure note ("not registered", "failed", …); absent on success. */
  error?: string;
  /** Optional detailed failure text rendered after the short note. */
  errorDetail?: string;
}

export interface SendToolDetails extends ToolResultStatus {
  kind: "dm" | "broadcast" | "room";
  target?: string;
  room?: string;
  /** Message body, used to render a truncated preview in the result. */
  body?: string;
  /**
   * Which transport succeeded for a DM send (sessions, per-repo, relay).
   * Used to pick the route glyph in the result renderer.
   */
  via?: "sessions" | "per-repo" | "relay";
  /**
   * When true, the receiver uses followUp delivery (no interrupt, no
   * steer) instead of the default triggerTurn+steer. Set by the sender
   * via the c2c_pi_send tool's `nonurgent` parameter.
   */
  nonurgent?: boolean;
}

export interface ListPeerInfo {
  alias: string;
  alive: boolean;
  tag?: "local" | "cross" | "relay";
  /** Last known runtime state from the peer status store, if recorded. */
  state?: string;
}

export interface ListToolDetails extends ToolResultStatus {
  peers: ListPeerInfo[];
  /**
   * Number of dead/unreachable peers hidden by the live-only default. Shown
   * as a muted "· N dead hidden" note so the count is acknowledged without
   * listing every zombie. 0/undefined when none are hidden (or include_dead).
   */
  hiddenDead?: number;
}

export interface InboxMessageInfo {
  from: string;
  preview: string;
}

export interface InboxToolDetails extends ToolResultStatus {
  messages: InboxMessageInfo[];
}

export interface WhoamiToolDetails extends ToolResultStatus {
  alias: string;
  sessionId: string;
  registered: boolean;
}

export interface RoomToolDetails extends ToolResultStatus {
  room: string;
  joined?: boolean;
}

export interface RoomsToolDetails extends ToolResultStatus {
  rooms: string[];
}

export interface StatusToolDetails extends ToolResultStatus {
  state?: string;
  since?: string;
  ttlMs?: number;
  registered: boolean;
}

export interface LocalInfoToolDetails extends ToolResultStatus {
  piC2cVersion?: string;
  c2cVersion?: string;
  alias: string;
  sessionId: string;
  broker: string;
  crossRepo: string;
  relay: string;
  relayWsState?: string;
  relayHost?: string;
  relayHostVerified?: boolean;
  address?: string;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function peerIndicator(alive: boolean, theme: Theme): string {
  return alive ? theme.fg("success", "●") : theme.fg("muted", "○");
}

/**
 * Lead for a c2c tool's single result line: `⧓ c2c.<action>`. The whole
 * `c2c.<action>` token is rendered in the accent color so it reads as one
 * unit identifying which tool ran.
 */
function c2cActionPrefix(action: string, theme: Theme): string {
  return INDENT_C2C + theme.fg("accent", `⧓ c2c.${action}`);
}

/** `⧓ c2c.<action> · ` — the prefix followed by a muted separator. */
function c2cActionLead(action: string, theme: Theme): string {
  return c2cActionPrefix(action, theme) + theme.fg("borderMuted", " · ");
}

/** A concise failure row: `⧓ c2c.<action> · <message>`, message in error color. */
function c2cActionError(action: string, theme: Theme, message = "error"): Component {
  return new Text(c2cActionLead(action, theme) + theme.fg("error", message), 0, 0);
}

/**
 * Failure note for a result, or undefined on success. A thrown tool error sets
 * pi's `isError`; a normal return that failed carries `details.error`. Either
 * way the renderer shows the failure instead of a misleading success line.
 */
function resultError(isError: boolean, details: ToolResultStatus | undefined): string | undefined {
  if (isError) return "error";
  return details?.error;
}

/** Width-aware failure row with optional detail: `<lead><status> · <detail>`. */
class ErrorLineComponent implements Component {
  constructor(
    private readonly action: string,
    private readonly message: string,
    private readonly detail: string | undefined,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    const detail = this.detail ? onelineBody(this.detail) : undefined;
    const line = detail
      ? c2cActionLead(this.action, this.theme) + this.theme.fg("error", this.message) + this.theme.fg("borderMuted", " · ") + this.theme.fg("error", detail)
      : c2cActionLead(this.action, this.theme) + this.theme.fg("error", this.message);
    return [truncateToWidth(line, width, this.theme.fg("error", "…"))];
  }

  handleInput(_data: string): void {
    // No interactive input on error rows.
  }

  invalidate(): void {
    // Stateless.
  }
}

/**
 * The call slot for every c2c tool. Renders nothing so the result line is the
 * only row (see the module header). Defining this — rather than omitting
 * `renderCall` — suppresses pi's bold raw-tool-name fallback.
 */
export function renderEmptyCall(): Component {
  return new Container();
}

// ── Send tools (c2c_pi_send, c2c_pi_send_all, c2c_pi_send_room) ───────────────────────

/** Glyph vocabulary matching the compact message renderer. */
const GLYPHS = {
  incoming: "▼",
  outgoing: "▲",
  broadcast: "✶",
  status: "●",
} as const;

const ROUTES = {
  local: "⌂",
  sessions: "◎",
  relay: "⇄",
  // Mirrors the compact message renderer's route vocabulary. Not used by the
  // outgoing send path (sends always know their route), but kept so the route
  // union lines up across the two ROUTES consts.
  unknown: "◌",
} as const;

/** `c2c.<action>` token for a send result, keyed by send kind. */
function sendAction(kind: SendToolDetails["kind"]): string {
  switch (kind) {
    case "broadcast":
      return "send-all";
    case "room":
      return "send-room";
    default:
      return "send";
  }
}

/** Direction + route prefix for an outgoing send result. */
function sendPrefix(kind: SendToolDetails["kind"], via: SendToolDetails["via"], theme: Theme): string {
  const dirGlyph = kind === "broadcast" ? GLYPHS.broadcast : GLYPHS.outgoing;
  const dirColor: import("@earendil-works/pi-coding-agent").ThemeColor = kind === "broadcast" ? "warning" : "accent";
  const routeGlyph = via === "relay" ? ROUTES.relay : via === "per-repo" ? ROUTES.local : ROUTES.sessions;
  return `${theme.fg(dirColor, dirGlyph)}${theme.fg("borderMuted", routeGlyph)}`;
}

/** Collapse internal whitespace to a single line (no length cap — the renderer
 *  truncates to the actual terminal width at render time). */
function onelineBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

/**
 * Width-aware, expand-aware send result.
 *
 *  - **Collapsed**: a single line `header · preview` that uses ALL the available
 *    horizontal width before truncating the body preview with `…` (matching the
 *    incoming compact line). No fixed-length cap, so a wide terminal shows more.
 *  - **Expanded**: the header line followed by the FULL body (wrapped to width),
 *    mirroring the incoming message expanded view (`buildExpandedComponent`), so
 *    an expanded outgoing send is no longer truncated.
 */
class SendResultComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly header: string,
    private readonly body: string | undefined,
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }
    this.cachedLines = this.build(width);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private build(width: number): string[] {
    const oneline = this.body ? onelineBody(this.body) : "";

    if (this.expanded && oneline.length > 0) {
      // Full body, wrapped to width — Text wraps rather than truncates.
      const fullBody = this.body!.replace(/^\n+|\n+$/g, "");
      const container = new Container();
      // Header carries its own leading space; the body gets paddingX=1 so it
      // aligns under the header (column 1), mirroring the incoming expanded view.
      container.addChild(new Text(this.header, 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(this.theme.fg("toolOutput", fullBody), 1, 0));
      return container.render(width);
    }

    if (oneline.length === 0) {
      return [truncateToWidth(this.header, width, this.theme.fg("toolOutput", "…"))];
    }
    const line =
      this.header +
      this.theme.fg("borderMuted", " · ") +
      this.theme.fg("toolOutput", oneline);
    return [truncateToWidth(line, width, this.theme.fg("toolOutput", "…"))];
  }

  handleInput(_data: string): void {
    // No interactive input on the send result row.
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/**
 * Result shown when a send tool finishes.
 *    ⧓ c2c.send · ▲◎ → lyra-quill · preview…        (collapsed, fills width)
 *    ⧓ c2c.send-all · ✶◎ · preview…
 *    ⧓ c2c.send-room · ▲◎ → swarm-lounge · preview…
 * When `expanded`, the full body is shown below the header (not truncated).
 */
export function renderSendResult(
  details: SendToolDetails,
  isError: boolean,
  theme: Theme,
  expanded = false,
): Component {
  const action = sendAction(details.kind);
  const err = resultError(isError, details);
  if (err) return new ErrorLineComponent(action, err, details.errorDetail, theme);

  const parts: string[] = [c2cActionLead(action, theme)];
  parts.push(sendPrefix(details.kind, details.via, theme));

  switch (details.kind) {
    case "dm":
      parts.push(theme.fg("success", ` → ${details.target ?? "unknown"}`));
      break;
    case "broadcast":
      // The `c2c.send-all` lead already conveys "broadcast"; no extra word.
      break;
    case "room":
      parts.push(theme.fg("success", ` → ${details.room ?? "unknown"}`));
      break;
  }
  return new SendResultComponent(parts.join(""), details.body, expanded, theme);
}

// ── c2c_pi_list ─────────────────────────────────────────────────────────────────

/** A peer plus its (recursively) nested subagent children. */
export interface PeerNode extends ListPeerInfo {
  children: PeerNode[];
}

/** A flattened tree row: a node plus its rendered tree prefix (guides + branch). */
export interface PeerTreeRow {
  node: ListPeerInfo;
  /** "" for a root; e.g. "  ├─ " / "  │  └─ " for descendants. */
  prefix: string;
}

/** Split a peer alias into its base name and optional relay `@<host>` suffix. */
function splitAliasHost(alias: string): { base: string; host: string } {
  const at = alias.indexOf("@");
  return at >= 0 ? { base: alias.slice(0, at), host: alias.slice(at) } : { base: alias, host: "" };
}

/**
 * Parse a c2c subagent alias of the form `<parent>-a<hash6>` (optionally with a
 * relay `@<host>` suffix shared with the parent) and return the parent alias.
 * Returns null when the alias is not a subagent alias. See
 * `deriveSubagentAlias` in src/identity.ts for the alias shape. Note the
 * returned parent is truncated to `SUBAGENT_PARENT_BASE_MAX` chars when the
 * real parent alias was longer (the alias only stores that prefix).
 */
export function parseChildAlias(alias: string): { parentAlias: string } | null {
  const { base, host } = splitAliasHost(alias);
  const m = base.match(/^(.+)-a[0-9a-f]{6}$/);
  if (!m) return null;
  return { parentAlias: m[1] + host };
}

/** Stable order: live peers first, then alphabetical by alias. */
function comparePeers(a: ListPeerInfo, b: ListPeerInfo): number {
  if (a.alive !== b.alive) return a.alive ? -1 : 1;
  return a.alias.localeCompare(b.alias);
}

/**
 * Build a forest of peers, nesting each subagent under its parent. A peer is
 * only nested when its derived parent alias is itself present in the list;
 * otherwise it is a root (so a live child whose parent is dead/absent still
 * shows).
 *
 * Every input peer becomes exactly one node — duplicate display aliases (e.g.
 * two sessions sharing a configured C2C_PI_ALIAS) are NOT folded, so no
 * reachable peer is silently dropped. Parent matching uses a first-wins alias
 * lookup that tolerates such collisions.
 *
 * The nesting is derived purely from the alias shape (per design), so it is
 * best-effort, not authoritative: a coincidental non-subagent alias of the
 * form `<x>-a<6hex>` WILL nest under a peer named `<x>` if one is present
 * (harmless when absent). It also cannot match a parent whose alias exceeds 56
 * chars, because `deriveSubagentAlias` truncates the parent there before
 * hashing — such a child degrades gracefully to a root.
 */
export function buildPeerTree(peers: ListPeerInfo[]): PeerNode[] {
  const all: PeerNode[] = peers.map((p) => ({ ...p, children: [] }));
  // Exact alias lookup, plus a truncated-base lookup keyed by
  // `<host>\0<base truncated to SUBAGENT_PARENT_BASE_MAX>`. The latter lets a
  // child whose parent alias exceeded the truncation boundary still match the
  // present parent. Both are first-wins so duplicate aliases never overwrite.
  const byAlias = new Map<string, PeerNode>();
  const byTruncBase = new Map<string, PeerNode>();
  const truncKey = (alias: string): string => {
    const { base, host } = splitAliasHost(alias);
    return `${host} ${base.slice(0, SUBAGENT_PARENT_BASE_MAX)}`;
  };
  for (const node of all) {
    if (!byAlias.has(node.alias)) byAlias.set(node.alias, node);
    const k = truncKey(node.alias);
    if (!byTruncBase.has(k)) byTruncBase.set(k, node);
  }
  const resolveParent = (parentAlias: string): PeerNode | undefined =>
    byAlias.get(parentAlias) ?? byTruncBase.get(truncKey(parentAlias));
  const roots: PeerNode[] = [];
  for (const node of all) {
    const child = parseChildAlias(node.alias);
    const parent = child ? resolveParent(child.parentAlias) : undefined;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (arr: PeerNode[]): void => {
    arr.sort(comparePeers);
    for (const n of arr) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/**
 * Flatten a peer forest into ordered rows, computing each node's tree prefix
 * (vertical guides + `├─`/`└─` branch). Roots carry an empty prefix.
 */
export function flattenPeerTree(roots: PeerNode[]): PeerTreeRow[] {
  const rows: PeerTreeRow[] = [];
  const walk = (children: PeerNode[], prefix: string): void => {
    children.forEach((child, i) => {
      const last = i === children.length - 1;
      rows.push({ node: child, prefix: `${prefix}${last ? "└─ " : "├─ "}` });
      walk(child.children, `${prefix}${last ? "   " : "│  "}`);
    });
  };
  for (const root of roots) {
    rows.push({ node: root, prefix: "" });
    walk(root.children, TREE_INDENT);
  }
  return rows;
}

/** Minimal merged-peer shape consumed by `buildPeerListDetails`. */
export interface MergedPeerLike {
  alias: string;
  alive: boolean;
  tag?: "local" | "cross" | "relay";
}

/**
 * Build `ListToolDetails` from merged peers. Live peers only unless
 * `includeDead`; the dead peers filtered out are counted into `hiddenDead`.
 * Each shown peer is enriched with its last-known runtime state via `stateFor`
 * (injected so this stays pure and unit-testable, independent of the store).
 */
export function buildPeerListDetails(
  merged: MergedPeerLike[],
  includeDead: boolean,
  stateFor: (alias: string) => string | undefined,
): ListToolDetails {
  const shown = includeDead ? merged : merged.filter((p) => p.alive);
  const hiddenDead = includeDead ? 0 : merged.length - shown.length;
  const peers: ListPeerInfo[] = shown.map((p) => ({
    alias: p.alias,
    alive: p.alive,
    tag: p.tag,
    state: stateFor(p.alias),
  }));
  return { peers, hiddenDead };
}

/** Pick a theme color for a peer's last-known status. */
function statusColor(state: string): import("@earendil-works/pi-coding-agent").ThemeColor {
  switch (state) {
    case "idle":
      return "muted";
    case "processing":
      return "accent";
    case "tool":
      return "warning";
    case "input":
      return "success";
    default:
      return "borderMuted";
  }
}

/** Tag/state suffixes appended after a peer alias. */
function peerSuffixes(peer: ListPeerInfo, theme: Theme): string {
  const tag = peer.tag === "cross"
    ? theme.fg("borderMuted", "  [cross-repo]")
    : peer.tag === "relay"
      ? theme.fg("accent", "  [relay]")
      : "";
  const stateSuffix = peer.state
    ? "  " + theme.fg(statusColor(peer.state), `[${peer.state}]`)
    : "";
  return tag + stateSuffix;
}

/**
 * Result for c2c_pi_list. Live peers only by default; subagents nested under
 * their parent as a tree.
 *    ⧓ c2c.list · peers (5) · 12 dead hidden
 *      ● pi-d19290
 *        ├─ ● pi-d19290-a6fc18
 *        └─ ● pi-d19290-ab12cd
 *      ● lyra-quill  [cross-repo]
 */
export function renderListResult(details: ListToolDetails, isError: boolean, theme: Theme): Component {
  const err = resultError(isError, details);
  if (err) return c2cActionError("list", theme, err);

  const peers = details.peers ?? [];
  const rows = flattenPeerTree(buildPeerTree(peers));
  const hiddenDead = details.hiddenDead ?? 0;

  const container = new Container();
  const hiddenNote = hiddenDead > 0
    ? theme.fg("borderMuted", " · ") + theme.fg("muted", `${hiddenDead} dead hidden`)
    : "";
  container.addChild(
    new Text(
      c2cActionLead("list", theme) +
        theme.fg("text", "peers") +
        (rows.length > 0 ? theme.fg("muted", ` (${rows.length})`) : "") +
        hiddenNote,
      0, 0,
    ),
  );

  if (rows.length === 0) {
    const msg = hiddenDead > 0 ? "no live peers" : "no peers registered";
    container.addChild(new Text(INDENT_CHILD + theme.fg("muted", msg), 0, 0));
    return container;
  }

  for (const { node, prefix } of rows) {
    const line =
      INDENT_CHILD +
      theme.fg("borderMuted", prefix) +
      `${peerIndicator(node.alive, theme)} ${theme.fg("text", node.alias)}${peerSuffixes(node, theme)}`;
    container.addChild(new Text(line, 0, 0));
  }
  return container;
}

/**
 * Plain-text peer tree for the LLM-facing tool output (and slash command).
 * Mirrors the TUI tree using the same branch glyphs, no color. Appends a
 * "(N dead hidden)" note when relevant.
 */
export function formatPeerListText(
  details: ListToolDetails,
  revealHint = "pass include_dead=true to show",
): string {
  const peers = details.peers ?? [];
  const rows = flattenPeerTree(buildPeerTree(peers));
  const hiddenDead = details.hiddenDead ?? 0;
  if (rows.length === 0) {
    return hiddenDead > 0 ? `No live peers (${hiddenDead} dead hidden, ${revealHint}).` : "No peers registered.";
  }
  const lines = rows.map(({ node, prefix }) => {
    const marker = node.alive ? "●" : "○";
    const tag = node.tag === "cross" ? "  [cross-repo]" : node.tag === "relay" ? "  [relay]" : "";
    const state = node.state ? `  [${node.state}]` : "";
    return `${prefix}${marker} ${node.alias}${tag}${state}`;
  });
  if (hiddenDead > 0) lines.push(`(${hiddenDead} dead hidden — ${revealHint})`);
  return lines.join("\n");
}

// ── c2c_pi_poll_inbox ───────────────────────────────────────────────────────────

/**
 * Result for c2c_pi_poll_inbox.
 *    ⧓ c2c.inbox · inbox (2)
 *      lyra-quill: preview...
 *      other: preview...
 */
export function renderInboxResult(
  details: InboxToolDetails,
  isError: boolean,
  theme: Theme,
): Component {
  const err = resultError(isError, details);
  if (err) return c2cActionError("inbox", theme, err);

  const messages = details.messages ?? [];
  const container = new Container();
  const header = new Text(
    c2cActionLead("inbox", theme) +
      theme.fg("text", "inbox") +
      (messages.length > 0 ? theme.fg("muted", ` (${messages.length})`) : ""),
    0, 0,
  );
  container.addChild(header);

  if (messages.length === 0) {
    container.addChild(new Text(INDENT_CHILD + theme.fg("muted", "no messages"), 0, 0));
    return container;
  }

  for (const message of messages) {
    const line = `${theme.fg("text", `${message.from}:`)} ${theme.fg("toolOutput", message.preview)}`;
    container.addChild(new Text(INDENT_CHILD + line, 0, 0));
  }

  return container;
}

// ── c2c_pi_whoami ───────────────────────────────────────────────────────────────

/**
 * Result for c2c_pi_whoami.
 *    ⧓ c2c.whoami · alias (session-id) · registered
 */
export function renderWhoamiResult(
  details: WhoamiToolDetails,
  isError: boolean,
  theme: Theme,
): Component {
  const err = resultError(isError, details);
  if (err) return c2cActionError("whoami", theme, err);

  const status = details.registered
    ? theme.fg("success", "registered")
    : theme.fg("warning", "not registered");
  const line =
    c2cActionLead("whoami", theme) +
    theme.fg("text", details.alias) +
    theme.fg("muted", ` (${details.sessionId})`) +
    theme.fg("borderMuted", " · ") +
    status;

  return new Text(line, 0, 0);
}

// ── c2c_pi_join_room ────────────────────────────────────────────────────────────

/**
 * Result for c2c_pi_join_room.
 *    ⧓ c2c.join · joined room swarm-lounge
 */
export function renderJoinRoomResult(
  details: RoomToolDetails,
  isError: boolean,
  theme: Theme,
): Component {
  const err = resultError(isError, details);
  if (err) return c2cActionError("join", theme, err);

  const line =
    c2cActionLead("join", theme) +
    theme.fg("success", "joined") +
    theme.fg("borderMuted", " room ") +
    theme.fg("text", details.room);

  return new Text(line, 0, 0);
}

// ── c2c_pi_rooms ────────────────────────────────────────────────────────────────

/**
 * Result for c2c_pi_rooms.
 *    ⧓ c2c.rooms · rooms (2)
 *      swarm-lounge
 *      ops
 */
export function renderRoomsResult(
  details: RoomsToolDetails,
  isError: boolean,
  theme: Theme,
): Component {
  const err = resultError(isError, details);
  if (err) return c2cActionError("rooms", theme, err);

  const rooms = details.rooms ?? [];
  const container = new Container();
  const header = new Text(
    c2cActionLead("rooms", theme) +
      theme.fg("text", "rooms") +
      (rooms.length > 0 ? theme.fg("muted", ` (${rooms.length})`) : ""),
    0, 0,
  );
  container.addChild(header);

  if (rooms.length === 0) {
    container.addChild(new Text(INDENT_CHILD + theme.fg("muted", "no rooms joined"), 0, 0));
    return container;
  }

  for (const room of rooms) {
    container.addChild(new Text(INDENT_CHILD + theme.fg("text", room), 0, 0));
  }

  return container;
}

// ── c2c_pi_status / c2c_pi_local_info ─────────────────────────────────────────

export function renderStatusResult(
  details: StatusToolDetails,
  isError: boolean,
  theme: Theme,
): Component {
  const err = resultError(isError, details);
  if (err) return c2cActionError("status", theme, err);
  if (!details.registered || !details.state) {
    return new Text(c2cActionLead("status", theme) + theme.fg("warning", "not registered"), 0, 0);
  }
  return new Text(
    c2cActionLead("status", theme) +
      theme.fg(statusColor(details.state), details.state) +
      theme.fg("borderMuted", " · ttl ") +
      theme.fg("muted", `${details.ttlMs ?? "?"}ms`),
    0,
    0,
  );
}

export function renderLocalInfoResult(
  details: LocalInfoToolDetails,
  isError: boolean,
  theme: Theme,
): Component {
  const err = resultError(isError, details);
  if (err) return c2cActionError("local", theme, err);

  const container = new Container();
  container.addChild(
    new Text(
      c2cActionLead("local", theme) +
        theme.fg("text", details.alias) +
        theme.fg("muted", ` (${details.sessionId})`),
      0,
      0,
    ),
  );
  if (details.piC2cVersion) {
    container.addChild(new Text(INDENT_CHILD + theme.fg("text", "pi-c2c ") + theme.fg("muted", details.piC2cVersion), 0, 0));
  }
  if (details.c2cVersion) {
    container.addChild(new Text(INDENT_CHILD + theme.fg("text", "c2c ") + theme.fg("muted", details.c2cVersion), 0, 0));
  }
  container.addChild(new Text(INDENT_CHILD + theme.fg("text", "broker ") + theme.fg("muted", details.broker), 0, 0));
  container.addChild(new Text(INDENT_CHILD + theme.fg("text", "cross-repo ") + theme.fg("muted", details.crossRepo), 0, 0));
  container.addChild(new Text(INDENT_CHILD + theme.fg("text", "relay ") + theme.fg("muted", details.relay), 0, 0));
  if (details.relayWsState) {
    container.addChild(new Text(INDENT_CHILD + theme.fg("text", "relay_ws ") + theme.fg("muted", details.relayWsState), 0, 0));
  }
  if (details.relayHost) {
    const suffix = details.relayHostVerified === false ? " (unverified)" : "";
    container.addChild(new Text(INDENT_CHILD + theme.fg("text", "relay_host ") + theme.fg("muted", `${details.relayHost}${suffix}`), 0, 0));
  }
  if (details.address) {
    container.addChild(new Text(INDENT_CHILD + theme.fg("text", "address ") + theme.fg("accent", details.address), 0, 0));
  }
  return container;
}
