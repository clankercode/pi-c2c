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
 * Render a single message as a c2c envelope for injection. Identical shape to
 * the OpenCode plugin's `formatEnvelope` (including `reply_via="c2c_send"`,
 * which is this extension's send-tool name). Peer content is sanitized so it
 * cannot break out of or forge the envelope.
 */
export function formatEnvelope(msg: C2cMessage, selfAlias?: string): string {
  const from = msg.from_alias || "unknown";
  const to = msg.to_alias || selfAlias || "me";
  return (
    `<c2c event="message" from="${from}" to="${to}" source="broker" ` +
    `reply_via="c2c_send" action_after="continue">\n${sanitizeContent(msg.content)}\n</c2c>`
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
 * How to deliver given the agent's idleness:
 *   - idle  → trigger a turn so the agent reads + acts on the message now;
 *   - busy  → queue as a follow-up (do not interrupt the active turn).
 */
export function deliveryOptionsFor(isIdle: boolean): DeliveryOptions {
  return isIdle ? { triggerTurn: true } : { deliverAs: "followUp" };
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
