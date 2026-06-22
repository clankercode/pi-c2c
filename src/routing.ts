/**
 * Shared routing helpers for pi-c2c.
 *
 * The extension routes sends through multiple transports (sessions broker,
 * per-repo broker, public relay) and merges peer lists from the same sources.
 * Keeping that logic in one place prevents drift between the LLM tools and
 * the human-facing slash commands.
 */

import type { C2cCli, C2cMessage, C2cPeer, RelayPeer } from "./c2c-cli.ts";
import { parseRelayAlias } from "./relay.ts";

/** A single send hop. */
export interface SendHop {
  kind: "sessions" | "per-repo" | "relay";
  /** Broker root for sessions hop; undefined for per-repo and relay. */
  root?: string;
}

/** Result of attempting a multi-hop send. */
export interface SendResult {
  ok: true;
  via: SendHop["kind"];
}

export interface SendError {
  ok: false;
  via: SendHop["kind"];
  message: string;
}

/**
 * Build the ordered hop list for a c2c send. Local brokers are tried first
 * because they know more aliases than the relay; the relay is the last resort
 * for cross-machine peers.
 */
export function buildSendHops(opts: {
  sessionsBrokerRoot?: string;
  relayRegistered: boolean;
}): SendHop[] {
  const hops: SendHop[] = [];
  if (opts.sessionsBrokerRoot) hops.push({ kind: "sessions", root: opts.sessionsBrokerRoot });
  hops.push({ kind: "per-repo" });
  if (opts.relayRegistered) hops.push({ kind: "relay" });
  return hops;
}

/** Regex matching broker "not registered" / "unknown alias" errors. */
const NOT_FOUND_RE = /not[_ ]?registered|unknown[_ ]?alias|alias[_ ]?not[_ ]?found/i;

/**
 * Execute a send across an ordered list of hops. Returns `{ok:true, via}` on
 * the first success, or `{ok:false, via, message}` for the first non-
 * not-found error. If all hops report not-found, returns the last hop's error.
 */
export async function executeSend(
  cli: C2cCli,
  hops: SendHop[],
  target: string,
  body: string,
  relayAddress: string | undefined,
  fromAlias?: string,
): Promise<SendResult | SendError> {
  const relayAddressTarget = parseRelayAlias(target) !== null;
  const effectiveHops = relayAddressTarget
    ? hops.filter((hop) => hop.kind === "relay")
    : hops;

  let lastErr: unknown = null;
  for (const hop of effectiveHops) {
    try {
      if (hop.kind === "relay") {
        if (!relayAddress) {
          // Should not happen if buildSendHops is used correctly.
          lastErr = new Error("relay not registered");
          continue;
        }
        await cli.relayDmSend(target, body, relayAddress);
      } else {
        await cli.send(target, body, { brokerRoot: hop.root, from: fromAlias });
      }
      return { ok: true, via: hop.kind };
    } catch (e: unknown) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!NOT_FOUND_RE.test(msg)) {
        return { ok: false, via: hop.kind, message: msg };
      }
    }
  }
  return {
    ok: false,
    via: effectiveHops[effectiveHops.length - 1]?.kind ?? "per-repo",
    message: lastErr instanceof Error ? lastErr.message : String(lastErr),
  };
}

/** Merged peer entry used by both tool and slash-command renderers. */
export interface MergedPeer {
  alias: string;
  alive: boolean;
  tag: "local" | "cross" | "relay";
}

/**
 * Merge peer lists from the per-repo broker, sessions broker, and relay.
 * Local + cross-repo peers are deduped by session_id; relay peers are deduped
 * by their `<alias>@<host_hash>` alias since they have no correlatable
 * session_id. Live entries win over dead ones.
 */
export function mergePeerLists(
  local: C2cPeer[],
  remote: C2cPeer[],
  relay: RelayPeer[],
): MergedPeer[] {
  const bySid = new Map<string, MergedPeer>();
  for (const p of local) {
    bySid.set(p.session_id, { alias: p.alias, alive: p.alive, tag: "local" });
  }
  for (const p of remote) {
    const existing = bySid.get(p.session_id);
    if (!existing) {
      bySid.set(p.session_id, { alias: p.alias, alive: p.alive, tag: "cross" });
    } else if (!existing.alive && p.alive) {
      bySid.set(p.session_id, { alias: p.alias, alive: p.alive, tag: existing.tag });
    }
  }
  for (const p of relay) {
    const key = `relay:${p.alias}`;
    const existing = bySid.get(key);
    if (!existing) {
      bySid.set(key, { alias: p.alias, alive: p.alive, tag: "relay" });
    } else if (!existing.alive && p.alive) {
      bySid.set(key, { alias: p.alias, alive: p.alive, tag: existing.tag });
    }
  }
  return Array.from(bySid.values()).sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    return a.alias.localeCompare(b.alias);
  });
}

/**
 * Drain all three message sources (per-repo, sessions, relay) into a single
 * array of C2cMessage envelopes. Failures are isolated so a hiccup on one
 * source does not lose messages from the others.
 */
export async function drainAllSources(cli: C2cCli, opts: {
  sessionsBrokerRoot?: string;
  relayRegistered: boolean;
  relayAddress?: string;
  relayToC2c?: (msgs: import("./c2c-cli.ts").RelayMessage[]) => C2cMessage[];
}): Promise<C2cMessage[]> {
  const drained: C2cMessage[] = [];
  try {
    drained.push(...(await cli.pollInbox()));
  } catch {
    // local broker hiccup — ignore
  }
  if (opts.sessionsBrokerRoot) {
    try {
      drained.push(...(await cli.pollInbox({ brokerRoot: opts.sessionsBrokerRoot })));
    } catch {
      // sessions broker hiccup — ignore
    }
  }
  if (opts.relayRegistered && opts.relayAddress) {
    try {
      const relayMsgs = await cli.relayDmPoll(opts.relayAddress);
      const convert = opts.relayToC2c ?? ((msgs) =>
        msgs.map((m) => ({
          from_alias: m.fromAlias,
          to_alias: m.toAlias,
          content: m.content,
          ts: m.ts,
          source: "relay" as const,
          kind: "dm" as const,
        })));
      drained.push(...convert(relayMsgs));
    } catch {
      // relay hiccup — ignore
    }
  }
  return drained;
}
