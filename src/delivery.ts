/**
 * Auto-delivery: turning drained c2c messages into transcript injections.
 *
 * This module is pure — it decides *what* to deliver and *how*, but performs
 * no I/O. The effectful poller in index.ts drains the inbox, calls these
 * helpers, and feeds the result to `pi.sendMessage`.
 *
 * The injected envelope mirrors the c2c OpenCode plugin
 * (`data/opencode-plugin/c2c.ts`) for cross-client parity, so a message looks
 * the same in a pi transcript as in a Claude/OpenCode one and `c2c_verify`
 * counts it identically.
 */

import type { C2cMessage } from "./c2c-cli.ts";
import { parseStatusEnvelope } from "./status-sync.ts";

/** Options handed to `pi.sendMessage`'s second argument. */
export interface DeliveryOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

/**
 * Neutralize peer-controlled content so it cannot forge or escape a c2c
 * envelope (prompt-injection defense). A malicious peer could otherwise embed
 * a literal `</c2c>` to close our frame early, or a `<c2c ...>` to forge a new
 * "from the broker" frame and impersonate another peer / inject instructions.
 * We replace the `<` of any `<c2c`/`</c2c` token with a look-alike (U+2039
 * SINGLE LEFT-POINTING ANGLE QUOTATION MARK) so the text stays human-readable
 * but no longer parses as our envelope tag.
 */
export function sanitizeContent(content: string): string {
  // Match `<c2c` / `</c2c` with optional whitespace around the `<` and slash.
  return content.replace(/<(\s*\/?\s*c2c)/gi, "‹$1");
}

/**
 * Determine whether a c2c inbox message is a direct message or a room
 * message.
 *
 * The OCaml broker (`c2c_broker.fan_out_room_message`,
 * `ocaml/c2c_broker.ml:3426`) tags room-delivered messages with
 * `to_alias = "<recipient-alias>#<room-id>"` so the recipient can
 * recognise them on drain without consulting room state.
 *
 * Cross-machine relay DMs are identified by explicit `source = "relay"` /
 * `kind = "dm"` metadata before they reach formatting. `#` remains the broker
 * room/canonical-alias syntax and is never used as a relay host qualifier.
 */
export function isRoomMessage(msg: C2cMessage): boolean {
  if (msg.kind === "room") return true;
  if (msg.kind === "dm") return false;
  if (msg.source === "relay") return false;
  if (typeof msg.to_alias !== "string") return false;
  return extractRoomId(msg) !== undefined;
}

function extractRoomId(msg: C2cMessage): string | undefined {
  if (msg.kind === "dm") return undefined;
  if (msg.source === "relay") return undefined;
  if (typeof msg.to_alias !== "string") return undefined;
  const hash = msg.to_alias.indexOf("#");
  if (hash < 0) return undefined;
  const suffix = msg.to_alias.slice(hash + 1);
  return suffix.length > 0 ? suffix : undefined;
}

function escapeInlineCode(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (ch) =>
      `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build the `<system-reminder>…</system-reminder>` block that follows an
 * inbound c2c envelope. The block names the sender, gives the exact tool
 * call shape, and falls back to the generic MCP tool name so the agent
 * doesn't have to infer any of it from the envelope attributes alone.
 *
 * The peer-controlled envelope attribute `from` is interpolated into the
 * reminder, both inside inline code (backticks around it) and as a tool
 * argument. Inline-code text is escaped for display; tool arguments are
 * rendered with JSON.stringify so quotes, backslashes, and control characters
 * cannot break the suggested call.
 *
 * For room messages (`kind = "room"`), the reminder directs the agent to
 * the room send tool. When the room id is available from the broker's
 * `<alias>#<room-id>` delivery tag, the example names it explicitly.
 *
 * Keep this terse. The reminder is shown verbatim inside every injected
 * c2c message — long reminders add noise that makes agents ignore them.
 */
function buildReplyReminder(from: string, kind: "dm" | "room" = "dm", roomId?: string): string {
  const displayFrom = escapeInlineCode(from);
  const fromArg = JSON.stringify(from);
  const roomArg = JSON.stringify(roomId ?? "<room id>");
  const tool = kind === "room" ? "c2c_pi_send_room" : "c2c_pi_send";
  const genericTool = kind === "room" ? "c2c_send_room" : "c2c_send";
  const targetArg = kind === "room"
    ? `room=${roomArg}`
    : `target=${fromArg}`;
  const fallbackTarget = kind === "room"
    ? `room=${roomArg}`
    : `target=${fromArg}`;
  return (
    `<system-reminder>\n` +
    `You received a c2c ${kind === "room" ? "room" : "direct"} message from \`${displayFrom}\`.\n` +
    `To reply, call ${tool}(${targetArg}, body="<your reply>").\n` +
    `If ${tool} is unavailable in this session, the generic MCP tool ${genericTool} works the same way (${fallbackTarget}).\n` +
    `Do NOT reply in plain text — the peer will not see it.\n` +
    `</system-reminder>`
  );
}

/**
 * Render a single message as a c2c envelope for injection. Identical shape to
 * the OpenCode plugin's `formatEnvelope` (including `reply_via="c2c_pi_send"`,
 * which is this extension's send-tool name). Peer content is sanitized so it
 * cannot break out of or forge the envelope.
 *
 * A `<system-reminder>` block follows the envelope. It is the canonical
 * reply hint — see `buildReplyReminder`. We do NOT rely on the
 * `reply_via="…"` envelope attribute alone: an LLM scanning a long
 * transcript can miss it, and the attribute is metadata the model has
 * to actively interpret. The reminder is a separate, visible block.
 *
 * `nonurgent` defaults to `msg.nonurgent` (the structured field on the
 * C2cMessage from the broker), with an explicit override via the parameter.
 * The receiver uses this to pick a delivery mode: nonurgent messages use
 * followUp (no interrupt, no steer), urgent messages use triggerTurn + steer.
 *
 * `kind` switches the reminder between DM (uses `c2c_pi_send`) and room
 * (uses `c2c_pi_send_room`). Default behavior: auto-detect from
 * `msg.to_alias` via `isRoomMessage` — the OCaml broker tags
 * room-delivered messages with `<alias>#<room-id>`. Callers can pass an
 * explicit `kind` to override the auto-detect (useful for tests and for
 * future transports that don't follow the `<alias>#<room-id>` convention).
 */
export function formatEnvelope(
  msg: C2cMessage,
  selfAlias?: string,
  nonurgent?: boolean,
  kind?: "dm" | "room",
): string {
  const from = msg.from_alias || "unknown";
  const to = msg.to_alias || selfAlias || "me";
  const effective = nonurgent ?? msg.nonurgent ?? false;
  const nonurgentAttr = effective ? ' nonurgent="true"' : "";
  // The `reply_via` attribute is set to the pi-specific tool when the
  // extension is loaded (matches the canonical OpenCode plugin shape, just
  // with our tool name). Room replies use the room tool name so a sibling
  // extension reading the attribute knows the right tool without parsing
  // the reminder block.
  const detected: "dm" | "room" = isRoomMessage(msg) ? "room" : "dm";
  const finalKind: "dm" | "room" = kind ?? detected;
  const roomId = finalKind === "room" ? extractRoomId(msg) : undefined;
  const replyVia = finalKind === "room" ? "c2c_pi_send_room" : "c2c_pi_send";
  const source = msg.source ?? "broker";
  return (
    `<c2c event="message" from="${escapeAttr(from)}" to="${escapeAttr(to)}" source="${escapeAttr(source)}"` +
    `${nonurgentAttr} ` +
    `reply_via="${replyVia}" action_after="continue">\n${sanitizeContent(msg.content)}\n</c2c>\n` +
    buildReplyReminder(from, finalKind, roomId)
  );
}

/** Stable dedup key for a message. The CLI omits message ids, so key on the
 * (sender, timestamp, content) triple. */
export function messageKey(msg: C2cMessage): string {
  return `${msg.from_alias}\u0000${msg.ts}\u0000${msg.content}`;
}

/**
 * Bounded set of recently-delivered message keys. Drains are atomic so each
 * message normally surfaces once; this is defense-in-depth against
 * double-delivery (e.g. a manual poll racing the background poller, or a
 * broker redelivery quirk).
 */
export class DeliveryDedup {
  private readonly order: string[] = [];
  private readonly set = new Set<string>();
  constructor(private readonly cap = 500) {}

  has(key: string): boolean {
    return this.set.has(key);
  }

  add(key: string): void {
    if (this.set.has(key)) return;
    this.set.add(key);
    this.order.push(key);
    if (this.order.length > this.cap) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.set.delete(evicted);
    }
  }

  get size(): number {
    return this.set.size;
  }
}

/**
 * Filter `msgs` to those not yet delivered, WITHOUT marking them. Returns
 * messages in input order. Does NOT mutate `dedup` — callers must
 * `markDelivered` only AFTER a successful injection, so a failed inject (or a
 * process death) leaves the messages eligible for retry rather than silently
 * swallowed.
 */
export function filterNovel(msgs: C2cMessage[], dedup: DeliveryDedup): C2cMessage[] {
  const out: C2cMessage[] = [];
  const seenThisBatch = new Set<string>();
  for (const m of msgs) {
    const key = messageKey(m);
    if (dedup.has(key) || seenThisBatch.has(key)) continue;
    seenThisBatch.add(key);
    out.push(m);
  }
  return out;
}

/** Mark messages as delivered so they are not re-injected. */
export function markDelivered(msgs: C2cMessage[], dedup: DeliveryDedup): void {
  for (const m of msgs) dedup.add(messageKey(m));
}

/**
 * How to deliver given the agent's idleness and the message's urgency:
 *   - default (urgent): `{ triggerTurn: true, deliverAs: "steer" }` —
 *     interrupt the current turn and steer the agent to act on the message
 *     immediately. The `steer` mode (vs followUp) injects into the active
 *     turn rather than queuing for after.
 *   - nonurgent: `{ deliverAs: "followUp" }` — queue for after the current
 *     turn. The agent will see it when it finishes whatever it's doing.
 *
 * The previous shape (`{ triggerTurn: true }` when idle, followUp when busy)
 * caused messages to silently wait during long turns (drain-bug followUp
 * delay, see finding 3fe2f266). The new shape always steers urgent messages
 * regardless of idleness, which is what c2c users want — c2c messages are
 * high-priority by default.
 */
export function deliveryOptionsFor(opts: { nonurgent: boolean }): DeliveryOptions {
  return opts.nonurgent
    ? { deliverAs: "followUp" }
    : { triggerTurn: true, deliverAs: "steer" };
}

/** One-line human summary for a TUI notification (not sent to the LLM). */
export function notifySummary(msgs: C2cMessage[]): string {
  if (msgs.length === 1) {
    const m = msgs[0];
    const status = parseStatusEnvelope(m.content);
    if (status) {
      return `c2c: status from ${m.from_alias || "unknown"} — ${status.state}`;
    }
    const preview = m.content.length > 60 ? `${m.content.slice(0, 57)}...` : m.content;
    return `c2c: message from ${m.from_alias || "unknown"} — ${preview}`;
  }
  const senders = [...new Set(msgs.map((m) => m.from_alias || "unknown"))];
  return `c2c: ${msgs.length} messages from ${senders.join(", ")}`;
}
