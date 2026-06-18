import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSendHops,
  executeSend,
  mergePeerLists,
  drainAllSources,
} from "../src/routing.ts";
import type { C2cCli, C2cMessage, C2cPeer, RelayMessage, RelayPeer } from "../src/c2c-cli.ts";

function fakeCli(overrides?: {
  send?: (target: string, body: string, opts?: { brokerRoot?: string }) => Promise<void>;
  relayDmSend?: (target: string, body: string, alias: string) => Promise<void>;
  pollInbox?: (opts?: { brokerRoot?: string }) => Promise<C2cMessage[]>;
  relayDmPoll?: (alias: string) => Promise<RelayMessage[]>;
}): C2cCli {
  return {
    send: overrides?.send ?? (async () => {}),
    relayDmSend: overrides?.relayDmSend ?? (async () => {}),
    pollInbox: overrides?.pollInbox ?? (async () => []),
    relayDmPoll: overrides?.relayDmPoll ?? (async () => []),
  } as unknown as C2cCli;
}

// --- buildSendHops ----------------------------------------------------------

test("buildSendHops: sessions + per-repo + relay when all enabled", () => {
  const hops = buildSendHops({ sessionsBrokerRoot: "/sessions", relayRegistered: true });
  assert.deepEqual(hops, [
    { kind: "sessions", root: "/sessions" },
    { kind: "per-repo" },
    { kind: "relay" },
  ]);
});

test("buildSendHops: per-repo only when no sessions or relay", () => {
  const hops = buildSendHops({ relayRegistered: false });
  assert.deepEqual(hops, [{ kind: "per-repo" }]);
});

// --- executeSend ------------------------------------------------------------

test("executeSend: succeeds on first hop", async () => {
  const cli = fakeCli({
    send: async (target, body, opts) => {
      assert.equal(opts?.brokerRoot, "/sessions");
    },
  });
  const hops = buildSendHops({ sessionsBrokerRoot: "/sessions", relayRegistered: true });
  const result = await executeSend(cli, hops, "target", "body", undefined);
  assert.equal(result.ok, true);
  assert.equal(result.via, "sessions");
});

test("executeSend: falls through on not-found errors", async () => {
  let calls = 0;
  const cli = fakeCli({
    send: async (_t, _b, opts) => {
      calls++;
      if (opts?.brokerRoot === "/sessions") {
        throw new Error("alias not registered");
      }
      // per-repo also doesn't know the alias
      throw new Error("unknown alias");
    },
    relayDmSend: async () => {
      calls++;
    },
  });
  const hops = buildSendHops({ sessionsBrokerRoot: "/sessions", relayRegistered: true });
  const result = await executeSend(cli, hops, "target", "body", "relay-alias");
  assert.equal(result.ok, true);
  assert.equal(result.via, "relay");
  assert.equal(calls, 3);
});

test("executeSend: stops on non-not-found error", async () => {
  const cli = fakeCli({
    send: async (_t, _b, opts) => {
      if (opts?.brokerRoot === "/sessions") {
        throw new Error("broker unreachable");
      }
    },
  });
  const hops = buildSendHops({ sessionsBrokerRoot: "/sessions", relayRegistered: true });
  const result = await executeSend(cli, hops, "target", "body", undefined);
  assert.equal(result.ok, false);
  assert.equal(result.via, "sessions");
  assert.match(result.message, /broker unreachable/);
});

test("executeSend: returns last error when all hops not-found", async () => {
  const cli = fakeCli({
    send: async () => {
      throw new Error("unknown alias");
    },
    relayDmSend: async () => {
      throw new Error("not registered");
    },
  });
  const hops = buildSendHops({ sessionsBrokerRoot: "/sessions", relayRegistered: true });
  const result = await executeSend(cli, hops, "target", "body", "relay-alias");
  assert.equal(result.ok, false);
  assert.equal(result.via, "relay");
  assert.match(result.message, /not registered/);
});

// --- mergePeerLists ---------------------------------------------------------

test("mergePeerLists: local + cross + relay dedup and sort", () => {
  const local: C2cPeer[] = [{ alias: "alice", session_id: "s1", alive: true }];
  const remote: C2cPeer[] = [{ alias: "bob", session_id: "s2", alive: true }];
  const relay: RelayPeer[] = [
    {
      alias: "carol@abc123",
      nodeId: "n3",
      sessionId: "s3",
      clientType: "pi",
      registeredAt: 1,
      lastSeen: 2,
      ttl: 60,
      alive: true,
      identityPk: "pk",
    },
  ];
  const merged = mergePeerLists(local, remote, relay);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((p) => ({ alias: p.alias, tag: p.tag })),
    [
      { alias: "alice", tag: "local" },
      { alias: "bob", tag: "cross" },
      { alias: "carol@abc123", tag: "relay" },
    ],
  );
});

test("mergePeerLists: live wins over dead for same session_id", () => {
  const local: C2cPeer[] = [{ alias: "alice", session_id: "s1", alive: false }];
  const remote: C2cPeer[] = [{ alias: "alice", session_id: "s1", alive: true }];
  const merged = mergePeerLists(local, remote, []);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].alive, true);
  assert.equal(merged[0].tag, "local");
});

// --- drainAllSources --------------------------------------------------------

test("drainAllSources: combines all sources in order", async () => {
  const cli = fakeCli({
    pollInbox: async (opts) => {
      if (opts?.brokerRoot === "/sessions") return [{ from_alias: "b", to_alias: "me", content: "s", ts: 2 }];
      return [{ from_alias: "a", to_alias: "me", content: "l", ts: 1 }];
    },
    relayDmPoll: async (_alias) => [
      { messageId: "m1", fromAlias: "c", toAlias: "me", content: "r", ts: 3 },
    ],
  });
  const msgs = await drainAllSources(cli, {
    sessionsBrokerRoot: "/sessions",
    relayRegistered: true,
    relayAddress: "me@hash",
  });
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs.map((m) => m.from_alias), ["a", "b", "c"]);
  assert.equal(msgs[2].source, "relay");
  assert.equal(msgs[2].kind, "dm");
});

test("drainAllSources: isolated failures do not lose other sources", async () => {
  const cli = fakeCli({
    pollInbox: async (opts) => {
      if (opts?.brokerRoot === "/sessions") throw new Error("sessions down");
      return [{ from_alias: "a", to_alias: "me", content: "l", ts: 1 }];
    },
    relayDmPoll: async () => {
      throw new Error("relay down");
    },
  });
  const msgs = await drainAllSources(cli, {
    sessionsBrokerRoot: "/sessions",
    relayRegistered: true,
    relayAddress: "me@hash",
  });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].from_alias, "a");
});
