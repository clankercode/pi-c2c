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

/** Options handed to `pi.sendMessage`'s second argument. */
export interface DeliveryOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

/**
 * Render a single message as a c2c envelope for injection. Identical shape to
 * the OpenCode plugin's `formatEnvelope` (including `reply_via="c2c_send"`,
 * which is this extension's send-tool name).
 */
export function formatEnvelope(msg: C2cMessage, selfAlias?: string): string {
  const from = msg.from_alias || "unknown";
  const to = msg.to_alias || selfAlias || "me";
  return (
    `<c2c event="message" from="${from}" to="${to}" source="broker" ` +
    `reply_via="c2c_send" action_after="continue">\n${msg.content}\n</c2c>`
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
 * Filter `msgs` to those not yet seen, marking the novel ones as seen. Returns
 * messages in input order. Mutates `dedup`.
 */
export function selectNovel(msgs: C2cMessage[], dedup: DeliveryDedup): C2cMessage[] {
  const out: C2cMessage[] = [];
  for (const m of msgs) {
    const key = messageKey(m);
    if (dedup.has(key)) continue;
    dedup.add(key);
    out.push(m);
  }
  return out;
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
    const preview = m.content.length > 60 ? `${m.content.slice(0, 57)}...` : m.content;
    return `c2c: message from ${m.from_alias || "unknown"} — ${preview}`;
  }
  const senders = [...new Set(msgs.map((m) => m.from_alias || "unknown"))];
  return `c2c: ${msgs.length} messages from ${senders.join(", ")}`;
}
