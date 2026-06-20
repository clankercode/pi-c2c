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
import { Container, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const INDENT_C2C = " ";
const INDENT_CHILD = "   ";
/** Extra indent before a first-level child's branch glyph (aligns under parent). */
const TREE_INDENT = "  ";

// ── detail types (consumed by the extension for tool execute return) ───────────

export interface SendToolDetails {
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

export interface ListToolDetails {
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

export interface InboxToolDetails {
  messages: InboxMessageInfo[];
}

export interface WhoamiToolDetails {
  alias: string;
  sessionId: string;
  registered: boolean;
}

export interface RoomToolDetails {
  room: string;
  joined?: boolean;
}

export interface RoomsToolDetails {
  rooms: string[];
}

export interface StatusToolDetails {
  state?: string;
  since?: string;
  ttlMs?: number;
  registered: boolean;
}

export interface LocalInfoToolDetails {
  alias: string;
  sessionId: string;
  broker: string;
  crossRepo: string;
  relay: string;
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

/** A concise error row: `⧓ c2c.<action> · error`. */
function c2cActionError(action: string, theme: Theme): Component {
  return new Text(c2cActionLead(action, theme) + theme.fg("error", "error"), 0, 0);
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
  const routeGlyph = via === "relay" ? ROUTES.relay : ROUTES.sessions;
  return `${theme.fg(dirColor, dirGlyph)}${theme.fg("borderMuted", routeGlyph)}`;
}

/** Collapse whitespace and truncate a body to a one-line preview. */
function previewBody(body: string | undefined, maxLen = 60): string {
  if (!body) return "";
  const oneline = body.replace(/\s+/g, " ").trim();
  if (oneline.length <= maxLen) return oneline;
  return `${oneline.slice(0, maxLen - 1)}…`;
}

/**
 * Result shown when a send tool finishes.
 *    ⧓ c2c.send · ▲◎ → lyra-quill · preview…
 *    ⧓ c2c.send-all · ✶◎ · preview…
 *    ⧓ c2c.send-room · ▲◎ → swarm-lounge · preview…
 */
export function renderSendResult(details: SendToolDetails, isError: boolean, theme: Theme): Component {
  const action = sendAction(details.kind);
  if (isError) return c2cActionError(action, theme);

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
  const preview = previewBody(details.body);
  if (preview) {
    parts.push(theme.fg("borderMuted", " · "));
    parts.push(theme.fg("toolOutput", preview));
  }
  return new Text(parts.join(""), 0, 0);
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

/**
 * Parse a c2c subagent alias of the form `<parent>-a<hash6>` (optionally with a
 * relay `@<host>` suffix shared with the parent) and return the parent alias.
 * Returns null when the alias is not a subagent alias. See
 * `deriveSubagentAlias` in src/identity.ts for the alias shape.
 */
export function parseChildAlias(alias: string): { parentAlias: string } | null {
  const at = alias.indexOf("@");
  const base = at >= 0 ? alias.slice(0, at) : alias;
  const host = at >= 0 ? alias.slice(at) : "";
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
 * shows, and a coincidental `*-a<6hex>` alias with no real parent is harmless).
 */
export function buildPeerTree(peers: ListPeerInfo[]): PeerNode[] {
  const nodes = new Map<string, PeerNode>();
  for (const p of peers) nodes.set(p.alias, { ...p, children: [] });
  const roots: PeerNode[] = [];
  for (const node of nodes.values()) {
    const child = parseChildAlias(node.alias);
    const parent = child ? nodes.get(child.parentAlias) : undefined;
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
  if (isError) return c2cActionError("list", theme);

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
export function formatPeerListText(details: ListToolDetails): string {
  const peers = details.peers ?? [];
  const rows = flattenPeerTree(buildPeerTree(peers));
  const hiddenDead = details.hiddenDead ?? 0;
  if (rows.length === 0) {
    return hiddenDead > 0 ? `No live peers (${hiddenDead} dead hidden).` : "No peers registered.";
  }
  const lines = rows.map(({ node, prefix }) => {
    const marker = node.alive ? "●" : "○";
    const tag = node.tag === "cross" ? "  [cross-repo]" : node.tag === "relay" ? "  [relay]" : "";
    const state = node.state ? `  [${node.state}]` : "";
    return `${prefix}${marker} ${node.alias}${tag}${state}`;
  });
  if (hiddenDead > 0) lines.push(`(${hiddenDead} dead hidden — pass include_dead to show)`);
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
  if (isError) return c2cActionError("inbox", theme);

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
  if (isError) return c2cActionError("whoami", theme);

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
  if (isError) return c2cActionError("join", theme);

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
  if (isError) return c2cActionError("rooms", theme);

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
  if (isError) return c2cActionError("status", theme);
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
  if (isError) return c2cActionError("local", theme);

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
  container.addChild(new Text(INDENT_CHILD + theme.fg("text", "broker ") + theme.fg("muted", details.broker), 0, 0));
  container.addChild(new Text(INDENT_CHILD + theme.fg("text", "cross-repo ") + theme.fg("muted", details.crossRepo), 0, 0));
  container.addChild(new Text(INDENT_CHILD + theme.fg("text", "relay ") + theme.fg("muted", details.relay), 0, 0));
  if (details.address) {
    container.addChild(new Text(INDENT_CHILD + theme.fg("text", "address ") + theme.fg("accent", details.address), 0, 0));
  }
  return container;
}
