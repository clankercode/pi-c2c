/**
 * Tool call and result renderers for pi-c2c tools.
 *
 * These draw concise, theme-aware rows for the extension's own AI-callable
 * tools. The extension factory in src/index.ts provides matching `details`
 * objects in tool results and wires the renderers via `renderShell: "self"`,
 * `renderCall`, and `renderResult`.
 */
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const INDENT_C2C = "⧓";
const INDENT_CHILD = "   ";

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

// ── helpers ──────────────────────────────────────────────────────────────────

function peerIndicator(alive: boolean, theme: Theme): string {
  return alive ? theme.fg("success", "●") : theme.fg("muted", "○");
}

// ── Send tools (c2c_pi_send, c2c_pi_send_all, c2c_pi_send_room) ───────────────────────

/**
 * One-line preview shown while a send tool is executing.
 *   ⧓ c2c · send → lyra-quill
 *   ⧓ c2c · broadcast
 *   ⧓ c2c · send to room swarm-lounge
 */
export function renderSendCall(args: SendToolDetails, theme: Theme): Component {
  const parts: string[] = [INDENT_C2C, theme.fg("accent", "⧓ c2c")];
  switch (args.kind) {
    case "dm":
      parts.push(theme.fg("text", ` send → ${args.target ?? "unknown"}`));
      break;
    case "broadcast":
      parts.push(theme.fg("text", " broadcast"));
      break;
    case "room":
      parts.push(theme.fg("text", ` send to room ${args.room ?? "unknown"}`));
      break;
  }
  return new Text(parts.join(""), 0, 0);
}

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
 *   ⧓ c2c · ▲◎ → lyra-quill · preview…
 *   ⧓ c2c · ✶◎ broadcast · preview…
 *   ⧓ c2c · ▲◎ → room swarm-lounge · preview…
 */
export function renderSendResult(details: SendToolDetails, isError: boolean, theme: Theme): Component {
  if (isError) {
    return new Text(theme.fg("error", `${INDENT_C2C}⧓ c2c · send error`), 0, 0);
  }

  const parts: string[] = [INDENT_C2C, theme.fg("accent", "⧓ c2c"), theme.fg("borderMuted", " · ")];
  parts.push(sendPrefix(details.kind, details.via, theme));

  switch (details.kind) {
    case "dm":
      parts.push(theme.fg("success", ` → ${details.target ?? "unknown"}`));
      break;
    case "broadcast":
      parts.push(theme.fg("success", " broadcast"));
      break;
    case "room":
      parts.push(theme.fg("success", ` → room ${details.room ?? "unknown"}`));
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

/**
 * Result for c2c_pi_list.
 *   ⧓ c2c · peers (3)
 *      ● alias-one
 *      ● alias-two  [cross-repo]
 *      ○ alias-three
 */
export function renderListResult(details: ListToolDetails, isError: boolean, theme: Theme): Component {
  if (isError) {
    return new Text(theme.fg("error", `${INDENT_C2C}⧓ c2c · peers error`), 0, 0);
  }

  const peers = details.peers ?? [];
  const container = new Container();
  const header = new Text(
    INDENT_C2C +
      theme.fg("accent", "⧓ c2c") +
      theme.fg("borderMuted", " · ") +
      theme.fg("text", "peers") +
      (peers.length > 0 ? theme.fg("muted", ` (${peers.length})`) : ""),
    0, 0,
  );
  container.addChild(header);

  if (peers.length === 0) {
    container.addChild(new Text(INDENT_CHILD + theme.fg("muted", "no peers registered"), 0, 0));
    return container;
  }

  for (const peer of peers) {
    const tag = peer.tag === "cross"
      ? theme.fg("borderMuted", "  [cross-repo]")
      : peer.tag === "relay"
        ? theme.fg("accent", "  [relay]")
        : "";
    const stateSuffix = peer.state
      ? "  " + theme.fg(statusColor(peer.state), `[${peer.state}]`)
      : "";
    const line = `${peerIndicator(peer.alive, theme)} ${theme.fg("text", peer.alias)}${tag}${stateSuffix}`;
    container.addChild(new Text(INDENT_CHILD + line, 0, 0));
  }

  return container;
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

// ── c2c_pi_poll_inbox ───────────────────────────────────────────────────────────

/**
 * Result for c2c_pi_poll_inbox.
 *   ⧓ c2c · inbox (2)
 *      lyra-quill: preview...
 *      other: preview...
 */
export function renderInboxResult(
  details: InboxToolDetails,
  isError: boolean,
  theme: Theme,
): Component {
  if (isError) {
    return new Text(theme.fg("error", `${INDENT_C2C}⧓ c2c · inbox error`), 0, 0);
  }

  const messages = details.messages ?? [];
  const container = new Container();
  const header = new Text(
    INDENT_C2C +
      theme.fg("accent", "⧓ c2c") +
      theme.fg("borderMuted", " · ") +
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
 *   ⧓ c2c · alias (session-id) · registered
 */
export function renderWhoamiResult(
  details: WhoamiToolDetails,
  isError: boolean,
  theme: Theme,
): Component {
  if (isError) {
    return new Text(theme.fg("error", `${INDENT_C2C}⧓ c2c · whoami error`), 0, 0);
  }

  const status = details.registered
    ? theme.fg("success", "registered")
    : theme.fg("warning", "not registered");
  const line =
    INDENT_C2C +
    theme.fg("accent", "⧓ c2c") +
    theme.fg("borderMuted", " · ") +
    theme.fg("text", details.alias) +
    theme.fg("muted", ` (${details.sessionId})`) +
    theme.fg("borderMuted", " · ") +
    status;

  return new Text(line, 0, 0);
}

// ── c2c_pi_join_room ────────────────────────────────────────────────────────────

/**
 * Result for c2c_pi_join_room.
 *   ⧓ c2c · joined room swarm-lounge
 */
export function renderJoinRoomResult(
  details: RoomToolDetails,
  isError: boolean,
  theme: Theme,
): Component {
  if (isError) {
    return new Text(theme.fg("error", `${INDENT_C2C}⧓ c2c · join room error`), 0, 0);
  }

  const line =
    INDENT_C2C +
    theme.fg("accent", "⧓ c2c") +
    theme.fg("success", " joined") +
    theme.fg("borderMuted", " room ") +
    theme.fg("text", details.room);

  return new Text(line, 0, 0);
}

// ── c2c_pi_rooms ────────────────────────────────────────────────────────────────

/**
 * Result for c2c_pi_rooms.
 *   ⧓ c2c · rooms (2)
 *      swarm-lounge
 *      ops
 */
export function renderRoomsResult(
  details: RoomsToolDetails,
  isError: boolean,
  theme: Theme,
): Component {
  if (isError) {
    return new Text(theme.fg("error", `${INDENT_C2C}⧓ c2c · rooms error`), 0, 0);
  }

  const rooms = details.rooms ?? [];
  const container = new Container();
  const header = new Text(
    INDENT_C2C +
      theme.fg("accent", "⧓ c2c") +
      theme.fg("borderMuted", " · ") +
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
