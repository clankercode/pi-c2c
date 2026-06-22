/**
 * Integration tests for the relay drain code path.
 *
 * Exercises `drainAllSources` from `src/routing.ts` with realistic stubs of
 * the three delivery sources (per-repo broker, sessions broker, public
 * relay). The relay source is stubbed at the C2cCli boundary (mimicking
 * what a real `c2c relay dm poll` would return); for a full HTTP-level
 * stub see scripts/relay-smoke-test.sh in the c2c repo.
 *
 * Self-skips when `c2c` is not on PATH (mirrors integration.test.ts pattern).
 *
 * Companion to tests/routing.test.ts which covers the unit-level shape of
 * drainAllSources. This file focuses on the *integration* aspects:
 *   - dedup across sources (same message from local + relay)
 *   - failure isolation (one source failing doesn't break the others)
 *   - relayToC2c shape conversion (relay's snake_case to broker's
 *     snake_case from_alias/to_alias)
 *   - empty cases
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { C2cCli, type ExecFn, type ExecResultLike, type C2cMessage, type RelayMessage, type RelayPeer } from "../src/c2c-cli.ts";
import { resolveC2cCommand } from "../src/c2c-bin.ts";
import { drainAllSources, mergePeerLists } from "../src/routing.ts";

const C2C_BIN = resolveC2cCommand();

function c2cAvailable(): boolean {
  try {
    execFileSync(C2C_BIN, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_C2C = c2cAvailable();
const opts = HAVE_C2C ? {} : { skip: "c2c binary not available" };

/** A typed fakeCli with optional overrides per-method. */
function fakeCli(overrides?: {
  send?: (target: string, body: string, opts?: { brokerRoot?: string; from?: string }) => Promise<void>;
  pollInbox?: (opts?: { brokerRoot?: string }) => Promise<C2cMessage[]>;
  relayDmPoll?: (alias: string) => Promise<RelayMessage[]>;
}): C2cCli {
  return {
    send: overrides?.send ?? (async () => {}),
    pollInbox: overrides?.pollInbox ?? (async () => []),
    relayDmPoll: overrides?.relayDmPoll ?? (async () => []),
  } as unknown as C2cCli;
}

// =============================================================================
// drainAllSources — integration scenarios
// =============================================================================

test(
  "drainAllSources: merges messages from all 3 sources in order (per-repo, sessions, relay)",
  opts,
  async () => {
    const cli = fakeCli({
      pollInbox: async (o) => {
        if (o?.brokerRoot === "/sessions") {
          return [
            { from_alias: "B", to_alias: "me", content: "from-sessions", ts: 20 },
          ];
        }
        return [
          { from_alias: "A", to_alias: "me", content: "from-per-repo", ts: 10 },
        ];
      },
      relayDmPoll: async () => [
        { messageId: "r1", fromAlias: "C", toAlias: "me", content: "from-relay", ts: 30 },
      ],
    });

    const msgs = await drainAllSources(cli, {
      sessionsBrokerRoot: "/sessions",
      relayRegistered: true,
      relayAddress: "me@hash",
    });

    assert.equal(msgs.length, 3);
    assert.deepEqual(
      msgs.map((m) => m.from_alias),
      ["A", "B", "C"],
    );
    assert.deepEqual(
      msgs.map((m) => m.content),
      ["from-per-repo", "from-sessions", "from-relay"],
    );
  },
);

test(
  "drainAllSources: same message from local + relay is NOT deduped here (caller's job via filterNovel)",
  opts,
  async () => {
    // drainAllSources merges — dedup is downstream in filterNovel (delivery.ts).
    // This test pins that contract: drainAllSources is a pure merge.
    const sameContent = "duplicated";
    const cli = fakeCli({
      pollInbox: async () => [
        { from_alias: "A", to_alias: "me", content: sameContent, ts: 1 },
      ],
      relayDmPoll: async () => [
        { messageId: "r1", fromAlias: "A", toAlias: "me", content: sameContent, ts: 1 },
      ],
    });

    const msgs = await drainAllSources(cli, {
      sessionsBrokerRoot: undefined,
      relayRegistered: true,
      relayAddress: "me@hash",
    });

    // Both copies are present — dedup happens in the pipeline after drain.
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content, sameContent);
    assert.equal(msgs[1].content, sameContent);
  },
);

test(
  "drainAllSources: relayToC2c converts relay snake_case (fromAlias) to broker snake_case (from_alias)",
  opts,
  async () => {
    // The default relayToC2c maps:
    //   { fromAlias, toAlias, content, ts } → { from_alias, to_alias, content, ts }
    // Pin the default behavior so a future refactor doesn't silently break it.
    const cli = fakeCli({
      relayDmPoll: async () => [
        { messageId: "m1", fromAlias: "alpha", toAlias: "me", content: "hi", ts: 100 },
        { messageId: "m2", fromAlias: "beta", toAlias: "me", content: "yo", ts: 200 },
      ],
    });

    const msgs = await drainAllSources(cli, {
      sessionsBrokerRoot: undefined,
      relayRegistered: true,
      relayAddress: "me@hash",
    });

    assert.equal(msgs.length, 2);
    // fromAlias → from_alias
    assert.equal(msgs[0].from_alias, "alpha");
    assert.equal(msgs[1].from_alias, "beta");
    // toAlias → to_alias
    assert.equal(msgs[0].to_alias, "me");
    assert.equal(msgs[1].to_alias, "me");
    assert.equal(msgs[0].source, "relay");
    assert.equal(msgs[0].kind, "dm");
  },
);

test(
  "drainAllSources: custom relayToC2c override is honored",
  opts,
  async () => {
    // Callers can pass a custom converter (e.g. to add message_id tracking).
    const cli = fakeCli({
      relayDmPoll: async () => [
        { messageId: "m1", fromAlias: "X", toAlias: "me", content: "c1", ts: 1 },
      ],
    });

    const customConvert = (msgs: RelayMessage[]): C2cMessage[] =>
      msgs.map((m) => ({
        from_alias: `[relay] ${m.fromAlias}`,
        to_alias: m.toAlias,
        content: m.content,
        ts: m.ts,
      }));

    const msgs = await drainAllSources(cli, {
      sessionsBrokerRoot: undefined,
      relayRegistered: true,
      relayAddress: "me@hash",
      relayToC2c: customConvert,
    });

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from_alias, "[relay] X");
  },
);

test(
  "drainAllSources: per-repo broker failure does not lose sessions or relay messages",
  opts,
  async () => {
    const cli = fakeCli({
      pollInbox: async () => {
        throw new Error("per-repo broker offline");
      },
      relayDmPoll: async () => [
        { messageId: "r1", fromAlias: "C", toAlias: "me", content: "from-relay", ts: 30 },
      ],
    });

    const msgs = await drainAllSources(cli, {
      sessionsBrokerRoot: "/sessions",
      relayRegistered: true,
      relayAddress: "me@hash",
    });

    // Per-repo failed → 0 messages from it. Sessions skipped because
    // pollInbox threw on the per-repo call (we share the method).
    // The point: relay still delivered.
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from_alias, "C");
  },
);

test(
  "drainAllSources: sessions broker failure does not lose per-repo or relay messages",
  opts,
  async () => {
    const cli = fakeCli({
      pollInbox: async (o) => {
        if (o?.brokerRoot === "/sessions") {
          throw new Error("sessions broker offline");
        }
        return [
          { from_alias: "A", to_alias: "me", content: "from-per-repo", ts: 10 },
        ];
      },
      relayDmPoll: async () => [
        { messageId: "r1", fromAlias: "C", toAlias: "me", content: "from-relay", ts: 30 },
      ],
    });

    const msgs = await drainAllSources(cli, {
      sessionsBrokerRoot: "/sessions",
      relayRegistered: true,
      relayAddress: "me@hash",
    });

    // Sessions failed (skipped) but per-repo and relay still delivered.
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].from_alias, "A");
    assert.equal(msgs[1].from_alias, "C");
  },
);

test(
  "drainAllSources: relay failure does not lose local messages",
  opts,
  async () => {
    const cli = fakeCli({
      pollInbox: async () => [
        { from_alias: "A", to_alias: "me", content: "from-local", ts: 10 },
      ],
      relayDmPoll: async () => {
        throw new Error("relay unreachable");
      },
    });

    const msgs = await drainAllSources(cli, {
      sessionsBrokerRoot: undefined,
      relayRegistered: true,
      relayAddress: "me@hash",
    });

    // Relay failed → only local. Failure isolation works.
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from_alias, "A");
    assert.equal(msgs[0].content, "from-local");
  },
);

test(
  "drainAllSources: all sources empty returns empty array",
  opts,
  async () => {
    const cli = fakeCli({}); // all defaults → []
    const msgs = await drainAllSources(cli, {
      sessionsBrokerRoot: "/sessions",
      relayRegistered: true,
      relayAddress: "me@hash",
    });
    assert.deepEqual(msgs, []);
  },
);

test(
  "drainAllSources: relayRegistered=false skips the relay branch even if relayDmPoll is wired",
  opts,
  async () => {
    // If relayRegistered is false, we MUST NOT call relayDmPoll (would be
    // an unnecessary round-trip and a leak: clients without relay should
    // not be hitting the relay).
    let relayCalled = false;
    const cli = fakeCli({
      pollInbox: async () => [
        { from_alias: "A", to_alias: "me", content: "l", ts: 1 },
      ],
      relayDmPoll: async () => {
        relayCalled = true;
        return [];
      },
    });
    const msgs = await drainAllSources(cli, {
      sessionsBrokerRoot: undefined,
      relayRegistered: false, // ← key
      relayAddress: undefined,
    });
    assert.equal(msgs.length, 1);
    assert.equal(relayCalled, false, "relayDmPoll should not be called when relayRegistered=false");
  },
);

// =============================================================================
// mergePeerLists — integration scenarios
// =============================================================================

test(
  "mergePeerLists: relay peers get a `relay:<alias>` key to avoid colliding with local/sessions peers",
  opts,
  async () => {
    // Relay entries are keyed by `relay:<alias>` (not session_id) because
    // a remote relay has no correlatable session_id with our local broker.
    // This test pins the dedup key so a refactor doesn't accidentally
    // collapse a local and relay peer with the same alias.
    const local = [
      { session_id: "sid-A", alias: "alpha", alive: true },
    ];
    const remote: { session_id: string; alias: string; alive: boolean }[] = [];
    const relay: RelayPeer[] = [
      { nodeId: "n1", sessionId: "s1", alias: "alpha@3d08761ae3f3", clientType: "pi", registeredAt: 1, lastSeen: 1, ttl: 86400, alive: true, identityPk: "pk1" },
      { nodeId: "n2", sessionId: "s2", alias: "beta@abc123def456", clientType: "pi", registeredAt: 1, lastSeen: 1, ttl: 86400, alive: true, identityPk: "pk2" },
    ];
    const merged = mergePeerLists(local, remote, relay);

    // alpha from local + alpha from relay → two distinct entries
    const alphaLocal = merged.find((p) => p.alias === "alpha");
    const alphaRelay = merged.find((p) => p.alias === "alpha@3d08761ae3f3");
    assert.ok(alphaLocal, "local alpha should be in merged list");
    assert.ok(alphaRelay, "relay alpha should be in merged list (distinct from local)");
    assert.equal(alphaLocal!.tag, "local");
    assert.equal(alphaRelay!.tag, "relay");
    // beta only from relay
    const betaRelay = merged.find((p) => p.alias === "beta@abc123def456");
    assert.ok(betaRelay);
    assert.equal(betaRelay!.tag, "relay");
  },
);

// =============================================================================
// Real HTTP server stub for the relay (C2cCli.relayDmPoll hits a local server)
// =============================================================================

test(
  "e2e: c2c binary's `relay dm poll` hits a stubbed HTTP server and the response is parsed",
  opts,
  async () => {
    // Start a local HTTP server that responds to the relay's poll endpoint
    // with canned DMs. This verifies the full chain: c2c binary subprocess
    // → HTTP server → stdout JSON → parseRelayMessages → RelayMessage[].
    const { port, close } = await new Promise<{
      port: number;
      close: () => Promise<void>;
    }>((resolve) => {
      const server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/poll_inbox") {
          // Match the shape the real relay returns for c2c relay dm poll.
          const body = JSON.stringify({
            ok: true,
            messages: [
              {
                message_id: "stub-1",
                from_alias: "alpha",
                to_alias: "me",
                content: "hello from stub",
                ts: 1781668000,
              },
            ],
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(body);
        } else {
          res.writeHead(404);
          res.end("not found");
        }
      });
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        resolve({
          port,
          close: () =>
            new Promise<void>((res) => {
              server.close(() => res());
              // Force-close any keep-alive connections so the test exits.
              server.closeAllConnections?.();
            }),
        });
      });
    });

    try {
      const exec: ExecFn = (command, args) =>
        new Promise<ExecResultLike>((resolve) => {
          const child = spawn(command, args, {
            env: { ...process.env, C2C_MCP_BROKER_ROOT: "/tmp/nonexistent" },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (d) => (stdout += d.toString()));
          child.stderr.on("data", (d) => (stderr += d.toString()));
          child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
          child.on("error", (e) => resolve({ stdout, stderr: String(e), code: 127 }));
        });
      const cli = new C2cCli({ exec, sessionId: "pi-relay-stub", bin: C2C_BIN });

      const relayUrl = `http://127.0.0.1:${port}`;
      const msgs = await cli.relayDmPoll("me", { relayUrl });
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].fromAlias, "alpha");
      assert.equal(msgs[0].toAlias, "me");
      assert.equal(msgs[0].content, "hello from stub");
      assert.equal(msgs[0].messageId, "stub-1");
      assert.equal(msgs[0].ts, 1781668000);
    } finally {
      await close();
    }
  },
);
