/**
 * Peer status store: tracks the most recent runtime state of each peer
 * (idle / processing / tool / input) without ever surfacing status envelopes
 * to the LLM or the user as messages.
 *
 * Inbound c2c messages are filtered through `extractStatusMessages` before
 * delivery: anything that parses as a status envelope is recorded here and
 * dropped; everything else passes through to the normal delivery path.
 *
 * The store self-prunes expired entries so we never grow unbounded, and
 * entries are keyed by peer alias (mirroring the `from` field of the status
 * envelope).
 */

import { parseStatusEnvelope, type StatusEnvelope, type StatusState } from "./status-sync.ts";

/** A peer's most recent known status. */
export interface PeerStatusEntry {
  state: StatusState;
  since: number; // epoch ms — when the peer entered this state
  lastSeen: number; // epoch ms — when we last received an update
  ttlMs: number; // the envelope's ttl_ms at last update
}

export interface PeerStatusStoreOptions {
  /** How often to prune expired entries, in ms (default 30_000). */
  pruneIntervalMs?: number;
  /** Override the wall clock for tests. */
  now?: () => number;
}

export class PeerStatusStore {
  private readonly entries_ = new Map<string, PeerStatusEntry>();
  private readonly now: () => number;
  private readonly pruneIntervalMs: number;
  private lastPrune = 0;

  constructor(opts: PeerStatusStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.pruneIntervalMs = opts.pruneIntervalMs ?? 30_000;
  }

  /**
   * Record a status update for `alias`. Older entries for the same alias
   * are overwritten. Returns the new entry.
   */
  update(alias: string, envelope: StatusEnvelope): PeerStatusEntry {
    const entry: PeerStatusEntry = {
      state: envelope.state,
      since: Date.parse(envelope.since) || this.now(),
      lastSeen: this.now(),
      ttlMs: envelope.ttl_ms,
    };
    this.entries_.set(alias, entry);
    return entry;
  }

  /**
   * Look up `alias`. Returns `null` if no entry exists, or if the entry's
   * TTL has expired (we treat expired entries as "unknown" — they could
   * simply mean the peer's been quiet).
   */
  get(alias: string): PeerStatusEntry | null {
    this.maybePrune();
    const entry = this.entries_.get(alias);
    if (!entry) return null;
    if (this.now() - entry.lastSeen > entry.ttlMs) return null;
    return entry;
  }

  /** Number of (possibly expired) entries currently stored. */
  size(): number {
    return this.entries_.size;
  }

  /**
   * Snapshot of all non-expired entries, for debug output. Expired entries
   * are filtered out so the debug view shows live state only.
   */
  live(): Array<{ alias: string; entry: PeerStatusEntry }> {
    this.maybePrune();
    const out: Array<{ alias: string; entry: PeerStatusEntry }> = [];
    for (const [alias, entry] of this.entries_) {
      if (this.now() - entry.lastSeen > entry.ttlMs) continue;
      out.push({ alias, entry });
    }
    return out;
  }

  /** Drop all entries. Used on session shutdown. */
  clear(): void {
    this.entries_.clear();
  }

  /**
   * Drop expired entries. Called automatically by `get` / `live` on a
   * throttled cadence (every `pruneIntervalMs`) to avoid hot-path cost.
   */
  private maybePrune(): void {
    const t = this.now();
    if (t - this.lastPrune < this.pruneIntervalMs) return;
    this.lastPrune = t;
    this.prune();
  }

  /** Drop expired entries unconditionally. */
  prune(): number {
    const t = this.now();
    let removed = 0;
    for (const [alias, entry] of this.entries_) {
      if (t - entry.lastSeen > entry.ttlMs) {
        this.entries_.delete(alias);
        removed++;
      }
    }
    return removed;
  }
}

/** A message-like object with a string content field. */
interface StatusFilterableMessageLike {
  content: string;
}

/**
 * Split a list of inbound messages into:
 *   - `messages`: regular messages that should proceed to delivery
 *   - `recorded`: status envelopes that were recorded in `store` and dropped
 *
 * The function is pure w.r.t. the messages (does not mutate them); it only
 * mutates `store` to record observed peer states.
 */
export function extractStatusMessages<T extends StatusFilterableMessageLike>(
  messages: T[],
  store: PeerStatusStore,
): { messages: T[]; recorded: number } {
  const out: T[] = [];
  let recorded = 0;
  for (const m of messages) {
    if (typeof m.content !== "string") {
      out.push(m);
      continue;
    }
    // Some peers sanitize `<` to `‹` for prompt-injection defense; the
    // parser handles that, but try the original content first for our own
    // status broadcasts (which use `<`) before trying a defensive scan.
    const status = parseStatusEnvelope(m.content);
    if (status) {
      store.update(status.from, status);
      recorded++;
      continue;
    }
    out.push(m);
  }
  return { messages: out, recorded };
}
