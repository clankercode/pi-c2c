import { test } from "node:test";
import assert from "node:assert/strict";
import {
  C2cCli,
  C2cError,
  parseMessages,
  parsePeers,
  parseWhoami,
  parseRoomList,
  parseRelayFingerprint,
  parseRelayIdentity,
  parseRelayMessages,
  parseRelayPeers,
  parseRelayRegister,
  type ExecFn,
  type ExecResultLike,
} from "../src/c2c-cli.ts";

// --- parsers ----------------------------------------------------------------

test("parseMessages: well-formed array", () => {
  const json = JSON.stringify([
    { from_alias: "lyra-quill", to_alias: "pi-test", content: "hi", ts: 1.5 },
    { from_alias: "storm", to_alias: "pi-test", content: "yo", ts: 2 },
  ]);
  const msgs = parseMessages(json);
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { from_alias: "lyra-quill", to_alias: "pi-test", content: "hi", ts: 1.5 });
});

test("parseMessages: empty array and empty string", () => {
  assert.deepEqual(parseMessages("[]"), []);
  assert.deepEqual(parseMessages(""), []);
});

test("parseMessages: malformed JSON and non-array yield []", () => {
  assert.deepEqual(parseMessages("not json"), []);
  assert.deepEqual(parseMessages('{"from_alias":"x"}'), []);
});

test("parseMessages: skips entries missing from_alias/content; tolerates missing ts/to", () => {
  const json = JSON.stringify([
    { from_alias: "a", content: "ok" }, // missing to/ts -> defaulted
    { to_alias: "b", content: "no sender" }, // dropped
    { from_alias: "c" }, // no content -> dropped
    null,
    42,
  ]);
  const msgs = parseMessages(json);
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0], { from_alias: "a", to_alias: "", content: "ok", ts: 0 });
});

test("parsePeers: well-formed, defaults, and alive coercion (real list --json shape)", () => {
  const json = JSON.stringify([
    { alias: "storm", session_id: "s1", alive: true, registered_at: 1700000000 },
    { alias: "ember", session_id: "s2", alive: false },
    { alias: "ghost" }, // missing fields
    { session_id: "s4" }, // no alias -> dropped
  ]);
  const peers = parsePeers(json);
  assert.equal(peers.length, 3);
  assert.deepEqual(peers[0], { alias: "storm", session_id: "s1", alive: true, registered_at: 1700000000 });
  assert.deepEqual(peers[1], { alias: "ember", session_id: "s2", alive: false });
  assert.deepEqual(peers[2], { alias: "ghost", session_id: "", alive: false });
});

test("parsePeers: empty + malformed", () => {
  assert.deepEqual(parsePeers("[]"), []);
  assert.deepEqual(parsePeers("garbage"), []);
  assert.deepEqual(parsePeers('{"alias":"x"}'), []);
});

test("parseWhoami: valid, missing alias, and unusable", () => {
  assert.deepEqual(parseWhoami('{"session_id":"s1","alias":"pi-test"}'), {
    session_id: "s1",
    alias: "pi-test",
  });
  assert.deepEqual(parseWhoami('{"session_id":"s1"}'), { session_id: "s1", alias: "" });
  assert.equal(parseWhoami('{"alias":"x"}'), null);
  assert.equal(parseWhoami('{"session_id":""}'), null);
  assert.equal(parseWhoami("not json"), null);
});

// --- relay parsers ---------------------------------------------------------

test("parseRelayIdentity: real shape", () => {
  const json = JSON.stringify({
    ok: true,
    path: "/home/x/.config/c2c/identity.json",
    public_key: "wXSGDsGE6vh9z6xBJY0int9atsVbYFvlJBwiCVeF60g",
    fingerprint: "SHA256:NEstCw_c5DCM3pJ3CGtl1bN02rPPPd18IVERVF3ciUU",
    alias_hint: "",
    created_at: "2026-04-28T02:11:48Z",
    alg: "ed25519",
    version: 1,
  });
  const id = parseRelayIdentity(json);
  assert.ok(id);
  assert.equal(id!.publicKey, "wXSGDsGE6vh9z6xBJY0int9atsVbYFvlJBwiCVeF60g");
  assert.equal(id!.fingerprint, "SHA256:NEstCw_c5DCM3pJ3CGtl1bN02rPPPd18IVERVF3ciUU");
  assert.equal(id!.aliasHint, "");
});

test("parseRelayIdentity: ok=false returns null", () => {
  const json = JSON.stringify({ ok: false, error_code: "connection_error", error: "nope" });
  assert.equal(parseRelayIdentity(json), null);
});

test("parseRelayFingerprint: strips SHA256: prefix", () => {
  assert.equal(parseRelayFingerprint("SHA256:abc123\n"), "abc123");
  assert.equal(parseRelayFingerprint("abc123"), "abc123");
});

test("parseRelayRegister: real shape", () => {
  const json = JSON.stringify({
    ok: true,
    result: "ok",
    lease: {
      node_id: "cli-pi-test-relay",
      session_id: "cli-pi-test-relay",
      alias: "pi-test-relay",
      client_type: "cli",
      registered_at: 1781636764.578273,
      last_seen: 1781636764.578273,
      ttl: 86400,
      alive: true,
      identity_pk: "wXSGDsGE6vh9z6xBJY0int9atsVbYFvlJBwiCVeF60g",
    },
    receipt: { sig: "x" },
  });
  const reg = parseRelayRegister(json);
  assert.ok(reg);
  assert.equal(reg!.alias, "pi-test-relay");
  assert.equal(reg!.sessionId, "cli-pi-test-relay");
  assert.equal(reg!.ttl, 86400);
  assert.equal(reg!.alive, true);
});

test("parseRelayPeers: real shape", () => {
  const json = JSON.stringify({
    ok: true,
    peers: [
      {
        node_id: "cli-pi-test-relay",
        session_id: "cli-pi-test-relay",
        alias: "pi-test-relay",
        client_type: "cli",
        registered_at: 1781636764.578273,
        last_seen: 1781636764.578273,
        ttl: 86400,
        alive: true,
        identity_pk: "wXSGDsGE6vh9z6xBJY0int9atsVbYFvlJBwiCVeF60g",
      },
    ],
  });
  const peers = parseRelayPeers(json);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].alias, "pi-test-relay");
  assert.equal(peers[0].alive, true);
});

test("parseRelayMessages: real shape", () => {
  const json = JSON.stringify({
    ok: true,
    messages: [
      {
        message_id: "m1",
        from_alias: "peer-a",
        to_alias: "me",
        content: "hello",
        ts: 1781636764.671067,
      },
    ],
  });
  const msgs = parseRelayMessages(json);
  assert.equal(msgs.length, 1);
  assert.deepEqual(msgs[0], {
    messageId: "m1",
    fromAlias: "peer-a",
    toAlias: "me",
    content: "hello",
    ts: 1781636764.671067,
  });
});

// --- CLI wrapper (fake exec) ------------------------------------------------

/** Build a fake ExecFn that records calls, env snapshots, and returns a scripted result. */
function fakeExec(result: Partial<ExecResultLike> & { onCall?: (cmd: string, args: string[]) => void }): {
  exec: ExecFn;
  calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
} {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args, env: { ...process.env } });
    result.onCall?.(command, args);
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
  };
  return { exec, calls };
}

test("run: non-zero exit throws C2cError with stderr", async () => {
  const { exec } = fakeExec({ code: 123, stderr: "broker unreachable" });
  const cli = new C2cCli({ exec });
  await assert.rejects(() => cli.run(["list"]), (e: unknown) => {
    assert.ok(e instanceof C2cError);
    assert.equal(e.code, 123);
    assert.match(e.message, /broker unreachable/);
    return true;
  });
});

test("whoami: never passes --session-id (CLI rejects it; identity from env)", async () => {
  const { exec, calls } = fakeExec({ stdout: '{"session_id":"sid-9","alias":"pi-test"}' });
  const cli = new C2cCli({ exec, sessionId: "sid-9" });
  const me = await cli.whoami();
  assert.deepEqual(me, { session_id: "sid-9", alias: "pi-test" });
  assert.deepEqual(calls[0].args, ["whoami", "--json"]);
});

test("register: builds args and scopes the client", async () => {
  const { exec, calls } = fakeExec({ stdout: '{"session_id":"sid-1","alias":"pi-test"}' });
  const cli = new C2cCli({ exec });
  const me = await cli.register("pi-test", "sid-1");
  assert.deepEqual(me, { session_id: "sid-1", alias: "pi-test" });
  assert.deepEqual(calls[0].args, ["register", "--alias", "pi-test", "--session-id", "sid-1", "--json"]);
  assert.equal(cli.sessionId, "sid-1"); // now scoped
});

test("pollInbox: drain vs peek arg shape + parse", async () => {
  const msg = [{ from_alias: "storm", to_alias: "pi", content: "hey", ts: 1 }];
  const drain = fakeExec({ stdout: JSON.stringify(msg) });
  const cli = new C2cCli({ exec: drain.exec, sessionId: "sid-2" });
  const got = await cli.pollInbox();
  assert.equal(got.length, 1);
  assert.deepEqual(drain.calls[0].args, ["poll-inbox", "--json", "--session-id", "sid-2"]);

  const peek = fakeExec({ stdout: "[]" });
  const cli2 = new C2cCli({ exec: peek.exec, sessionId: "sid-2" });
  await cli2.pollInbox({ peek: true });
  assert.deepEqual(peek.calls[0].args, ["poll-inbox", "--json", "--session-id", "sid-2", "--peek"]);
});

test("send: inserts -- before positionals, with and without --from", async () => {
  const a = fakeExec({});
  await new C2cCli({ exec: a.exec }).send("storm", "hello there");
  assert.deepEqual(a.calls[0].args, ["send", "--", "storm", "hello there"]);

  const b = fakeExec({});
  await new C2cCli({ exec: b.exec }).send("storm", "hi", { from: "pi-test" });
  assert.deepEqual(b.calls[0].args, ["send", "--from", "pi-test", "--", "storm", "hi"]);
});

test("send: leading-dash target/body are not parsed as flags", async () => {
  const { exec, calls } = fakeExec({});
  await new C2cCli({ exec }).send("-weird", "-ok body");
  assert.deepEqual(calls[0].args, ["send", "--", "-weird", "-ok body"]);
});

test("sendAll: from + exclude + -- before body", async () => {
  const { exec, calls } = fakeExec({});
  await new C2cCli({ exec }).sendAll("broadcast", { from: "pi-test", exclude: ["a", "b"] });
  assert.deepEqual(calls[0].args, ["send-all", "--from", "pi-test", "--exclude", "a,b", "--", "broadcast"]);
});

test("bin override is honored", async () => {
  const { exec, calls } = fakeExec({ stdout: "[]" });
  await new C2cCli({ exec, bin: "/custom/c2c" }).list();
  assert.equal(calls[0].command, "/custom/c2c");
});

// --- relay methods ---------------------------------------------------------

test("relayRegister: builds register args, optional relay-url and token, parses opaque_host_id", async () => {
  const regJson = JSON.stringify({
    ok: true,
    lease: {
      alias: "pi-c01ea5@a3b2c1d4e5f6",
      session_id: "sid-1",
      node_id: "n1",
      registered_at: 1781638000,
      ttl: 3600,
      alive: true,
      opaque_host_id: "a3b2c1d4e5f6",
    },
  });
  const a = fakeExec({ stdout: regJson });
  const got = await new C2cCli({ exec: a.exec }).relayRegister("pi-c01ea5@a3b2c1d4e5f6");
  assert.equal(got?.alias, "pi-c01ea5@a3b2c1d4e5f6");
  assert.equal(got?.opaqueHostId, "a3b2c1d4e5f6");
  assert.deepEqual(a.calls[0].args, ["relay", "register", "--alias", "pi-c01ea5@a3b2c1d4e5f6"]);

  const b = fakeExec({ stdout: regJson });
  await new C2cCli({ exec: b.exec }).relayRegister("pi-x@h", {
    relayUrl: "https://relay.example.com",
    token: "tok-1",
  });
  assert.deepEqual(b.calls[0].args, [
    "relay", "register",
    "--alias", "pi-x@h",
    "--relay-url", "https://relay.example.com",
    "--token", "tok-1",
  ]);
});

test("relayList: builds list args + parses peers", async () => {
  const json = JSON.stringify({
    ok: true,
    peers: [
      { alias: "pi-x@aaaa", node_id: "n1", session_id: "s1", client_type: "pi", registered_at: 1, last_seen: 2, ttl: 60, alive: true, identity_pk: "pk" },
    ],
  });
  const { exec, calls } = fakeExec({ stdout: json });
  const peers = await new C2cCli({ exec }).relayList();
  assert.equal(peers.length, 1);
  assert.equal(peers[0].alias, "pi-x@aaaa");
  assert.equal(peers[0].alive, true);
  assert.deepEqual(calls[0].args, ["relay", "list"]);
});

test("relayDmPoll: builds poll args with --alias, parses messages", async () => {
  const json = JSON.stringify({
    ok: true,
    messages: [
      { message_id: "m1", from_alias: "peer", to_alias: "me", content: "hi", ts: 1781638000 },
    ],
  });
  const { exec, calls } = fakeExec({ stdout: json });
  const msgs = await new C2cCli({ exec }).relayDmPoll("me@hhhh");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].fromAlias, "peer");
  assert.equal(msgs[0].content, "hi");
  assert.deepEqual(calls[0].args, ["relay", "dm", "poll", "--alias", "me@hhhh"]);
});

test("relayDmSend: builds send args with --alias and -- before positionals", async () => {
  const { exec, calls } = fakeExec({});
  await new C2cCli({ exec }).relayDmSend("peer@hhhh", "hello from relay", "me@hhhh");
  assert.deepEqual(calls[0].args, [
    "relay", "dm", "send",
    "--alias", "me@hhhh",
    "--", "peer@hhhh", "hello from relay",
  ]);
});

test("relayDmSendAll: builds send-all args with --alias and -- before body", async () => {
  const { exec, calls } = fakeExec({});
  await new C2cCli({ exec }).relayDmSendAll("broadcast over relay", "me@hhhh");
  assert.deepEqual(calls[0].args, [
    "relay", "dm", "send-all",
    "--alias", "me@hhhh",
    "--", "broadcast over relay",
  ]);
});

test("relayDmPoll: empty list when ok=false", async () => {
  const { exec, calls } = fakeExec({ stdout: '{"ok":false,"error":"unauthorized"}' });
  const msgs = await new C2cCli({ exec }).relayDmPoll("me@hhhh");
  assert.deepEqual(msgs, []);
  assert.equal(calls[0].args[0], "relay");
});

test("relay methods clear C2C_MCP_SESSION_ID to avoid ghost cli-* leases", async () => {
  process.env.C2C_MCP_SESSION_ID = "stale-session";
  const regJson = JSON.stringify({
    ok: true,
    lease: { alias: "a@123", session_id: "s1", node_id: "n1", registered_at: 1, ttl: 60, alive: true },
  });
  const { exec: regExec, calls: regCalls } = fakeExec({ stdout: regJson });
  await new C2cCli({ exec: regExec }).relayRegister("a@123");
  assert.equal(regCalls[0].env.C2C_MCP_SESSION_ID, undefined);

  const { exec: listExec, calls: listCalls } = fakeExec({
    stdout: JSON.stringify({ ok: true, peers: [] }),
  });
  await new C2cCli({ exec: listExec }).relayList();
  assert.equal(listCalls[0].env.C2C_MCP_SESSION_ID, undefined);

  const { exec: pollExec, calls: pollCalls } = fakeExec({
    stdout: JSON.stringify({ ok: true, messages: [] }),
  });
  await new C2cCli({ exec: pollExec }).relayDmPoll("a@123");
  assert.equal(pollCalls[0].env.C2C_MCP_SESSION_ID, undefined);

  delete process.env.C2C_MCP_SESSION_ID;
});

test("run: per-call sessionId override is restored after invocation", async () => {
  process.env.C2C_MCP_SESSION_ID = "global";
  const { exec, calls } = fakeExec({ stdout: "{}" });
  const cli = new C2cCli({ exec });
  await cli.run(["relay", "list"], { sessionId: "override" });
  assert.equal(calls[0].env.C2C_MCP_SESSION_ID, "override");
  assert.equal(process.env.C2C_MCP_SESSION_ID, "global");

  await cli.run(["list"]);
  assert.equal(calls[1].env.C2C_MCP_SESSION_ID, "global");

  delete process.env.C2C_MCP_SESSION_ID;
});

// --- relayToC2c (module-level helper) ----------------------------------------

import { relayToC2c } from "../src/index.ts";

test("relayToC2c: maps fromAlias/toAlias to snake_case", () => {
  const out = relayToC2c([
    { messageId: "m1", fromAlias: "peer", toAlias: "me", content: "hi", ts: 100 },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].from_alias, "peer");
  assert.equal(out[0].to_alias, "me");
  assert.equal(out[0].content, "hi");
  assert.equal(out[0].ts, 100);
  assert.equal(out[0].source, "relay");
  assert.equal(out[0].kind, "dm");
  // Relay-only fields must NOT leak into the broker shape.
  assert.equal((out[0] as unknown as Record<string, unknown>).messageId, undefined);
});

test("relayToC2c: empty list → empty list", () => {
  assert.deepEqual(relayToC2c([]), []);
});

test("relayToC2c: preserves input order", () => {
  const out = relayToC2c([
    { messageId: "1", fromAlias: "a", toAlias: "me", content: "1", ts: 1 },
    { messageId: "2", fromAlias: "b", toAlias: "me", content: "2", ts: 2 },
    { messageId: "3", fromAlias: "c", toAlias: "me", content: "3", ts: 3 },
  ]);
  assert.deepEqual(out.map((m) => m.from_alias), ["a", "b", "c"]);
  assert.deepEqual(out.map((m) => m.ts), [1, 2, 3]);
});

// --- rooms ------------------------------------------------------------------

test("parseRoomList: real my-rooms shape (room_id), string array, mixed/garbage", () => {
  // real `c2c rooms my-rooms --json`: [{room_id, member_count, alive_count}]
  assert.deepEqual(
    parseRoomList('[{"room_id":"swarm-lounge","member_count":2},{"room_id":"ops"}]'),
    ["swarm-lounge", "ops"],
  );
  assert.deepEqual(parseRoomList('["swarm-lounge","ops"]'), ["swarm-lounge", "ops"]);
  assert.deepEqual(parseRoomList('[{"room":"a"},{"name":"b"},{"id":"c"}]'), ["a", "b", "c"]);
  assert.deepEqual(parseRoomList('[{"room":"a"},null,5,{"nope":"x"}]'), ["a"]);
  assert.deepEqual(parseRoomList("not json"), []);
  assert.deepEqual(parseRoomList("{}"), []);
});

test("joinRoom / leaveRoom build correct args with -- separator", async () => {
  const j = fakeExec({});
  await new C2cCli({ exec: j.exec }).joinRoom("swarm-lounge", "pi-x");
  assert.deepEqual(j.calls[0].args, ["rooms", "join", "--alias", "pi-x", "--", "swarm-lounge"]);

  const l = fakeExec({});
  await new C2cCli({ exec: l.exec }).leaveRoom("swarm-lounge", "pi-x");
  assert.deepEqual(l.calls[0].args, ["rooms", "leave", "--alias", "pi-x", "--", "swarm-lounge"]);
});

test("sendRoom: identity via env by default; --from optional; -- before positionals", async () => {
  const a = fakeExec({});
  await new C2cCli({ exec: a.exec }).sendRoom("ops", "deploy done");
  assert.deepEqual(a.calls[0].args, ["rooms", "send", "--", "ops", "deploy done"]);

  const b = fakeExec({});
  await new C2cCli({ exec: b.exec }).sendRoom("ops", "deploy done", { from: "pi-x" });
  assert.deepEqual(b.calls[0].args, ["rooms", "send", "--from", "pi-x", "--", "ops", "deploy done"]);
});

test("myRooms parses room ids", async () => {
  const { exec, calls } = fakeExec({ stdout: '["swarm-lounge","ops"]' });
  const rooms = await new C2cCli({ exec }).myRooms();
  assert.deepEqual(rooms, ["swarm-lounge", "ops"]);
  assert.deepEqual(calls[0].args, ["rooms", "my-rooms", "--json"]);
});

test("roomHistory builds args (-- before room) + parses messages", async () => {
  const msgs = [{ from_alias: "storm", to_alias: "ops", content: "hi", ts: 1 }];
  const { exec, calls } = fakeExec({ stdout: JSON.stringify(msgs) });
  const got = await new C2cCli({ exec }).roomHistory("ops", 10);
  assert.equal(got.length, 1);
  assert.deepEqual(calls[0].args, ["rooms", "history", "--json", "--limit", "10", "--", "ops"]);
});
