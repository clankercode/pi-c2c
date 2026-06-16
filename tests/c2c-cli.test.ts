import { test } from "node:test";
import assert from "node:assert/strict";
import {
  C2cCli,
  C2cError,
  parseMessages,
  parsePeers,
  parseWhoami,
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

test("parsePeers: well-formed, defaults, and alive coercion", () => {
  const json = JSON.stringify([
    { alias: "storm", session_id: "s1", alive: true, lastSeenAge: 3 },
    { alias: "ember", session_id: "s2", alive: false },
    { alias: "ghost" }, // missing fields
    { session_id: "s4" }, // no alias -> dropped
  ]);
  const peers = parsePeers(json);
  assert.equal(peers.length, 3);
  assert.deepEqual(peers[0], { alias: "storm", session_id: "s1", alive: true, lastSeenAge: 3 });
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

// --- CLI wrapper (fake exec) ------------------------------------------------

/** Build a fake ExecFn that records calls and returns a scripted result. */
function fakeExec(result: Partial<ExecResultLike> & { onCall?: (cmd: string, args: string[]) => void }): {
  exec: ExecFn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args });
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

test("whoami: appends --session-id when scoped, parses result", async () => {
  const { exec, calls } = fakeExec({ stdout: '{"session_id":"sid-9","alias":"pi-test"}' });
  const cli = new C2cCli({ exec, sessionId: "sid-9" });
  const me = await cli.whoami();
  assert.deepEqual(me, { session_id: "sid-9", alias: "pi-test" });
  assert.deepEqual(calls[0].args, ["whoami", "--json", "--session-id", "sid-9"]);
});

test("whoami: no session id omits the flag", async () => {
  const { exec, calls } = fakeExec({ stdout: '{"session_id":"x","alias":"y"}' });
  const cli = new C2cCli({ exec });
  await cli.whoami();
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

test("send: with and without --from", async () => {
  const a = fakeExec({});
  await new C2cCli({ exec: a.exec }).send("storm", "hello there");
  assert.deepEqual(a.calls[0].args, ["send", "storm", "hello there"]);

  const b = fakeExec({});
  await new C2cCli({ exec: b.exec }).send("storm", "hi", { from: "pi-test" });
  assert.deepEqual(b.calls[0].args, ["send", "--from", "pi-test", "storm", "hi"]);
});

test("sendAll: from + exclude", async () => {
  const { exec, calls } = fakeExec({});
  await new C2cCli({ exec }).sendAll("broadcast", { from: "pi-test", exclude: ["a", "b"] });
  assert.deepEqual(calls[0].args, ["send-all", "--from", "pi-test", "--exclude", "a,b", "broadcast"]);
});

test("bin override is honored", async () => {
  const { exec, calls } = fakeExec({ stdout: "[]" });
  await new C2cCli({ exec, bin: "/custom/c2c" }).list();
  assert.equal(calls[0].command, "/custom/c2c");
});
