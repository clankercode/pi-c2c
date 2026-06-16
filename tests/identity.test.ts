import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeAlias,
  deriveSessionId,
  resolveAlias,
  computeIdentity,
  establishIdentity,
} from "../src/identity.ts";
import { C2cCli, C2cError, type ExecFn } from "../src/c2c-cli.ts";

test("sanitizeAlias: strips unsafe chars, collapses dashes, trims edges", () => {
  assert.equal(sanitizeAlias("  Pi Test!! "), "Pi-Test");
  assert.equal(sanitizeAlias("lyra/quill@host"), "lyra-quill-host");
  assert.equal(sanitizeAlias("--foo--"), "foo");
  assert.equal(sanitizeAlias("a.b_c-d"), "a.b_c-d");
  assert.equal(sanitizeAlias("!!!"), "");
});

test("sanitizeAlias: caps length at 64", () => {
  assert.equal(sanitizeAlias("x".repeat(100)).length, 64);
});

test("deriveSessionId: namespaces with pi- and is idempotent", () => {
  assert.equal(deriveSessionId("019ecd-abc"), "pi-019ecd-abc");
  assert.equal(deriveSessionId("pi-already"), "pi-already");
});

test("deriveSessionId: empty/undefined falls back deterministically", () => {
  assert.equal(deriveSessionId(undefined, "fb"), "pi-fb");
  assert.equal(deriveSessionId("", "fb"), "pi-fb");
  assert.equal(deriveSessionId(null), "pi-default");
});

test("resolveAlias: configured wins (sanitized)", () => {
  assert.equal(resolveAlias({ configured: "My Bot", sessionId: "pi-x" }), "My-Bot");
});

test("resolveAlias: empty configured falls through to hash", () => {
  const a = resolveAlias({ configured: "  ", sessionId: "pi-x" });
  assert.match(a, /^pi-[0-9a-f]{6}$/);
});

test("resolveAlias: deterministic per session id, differs across sessions", () => {
  const a1 = resolveAlias({ sessionId: "pi-aaa" });
  const a2 = resolveAlias({ sessionId: "pi-aaa" });
  const b = resolveAlias({ sessionId: "pi-bbb" });
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

test("computeIdentity: end-to-end pure derivation", () => {
  const id = computeIdentity({ piSessionId: "sess-123" });
  assert.equal(id.sessionId, "pi-sess-123");
  assert.match(id.alias, /^pi-[0-9a-f]{6}$/);
});

test("computeIdentity: ambient C2C_MCP_SESSION_ID is used verbatim (no pi- prefix)", () => {
  const id = computeIdentity({ piSessionId: "sess-123", sessionIdEnv: "host-session-xyz" });
  assert.equal(id.sessionId, "host-session-xyz");
});

test("computeIdentity: blank ambient session id falls back to derived", () => {
  const id = computeIdentity({ piSessionId: "sess-123", sessionIdEnv: "   " });
  assert.equal(id.sessionId, "pi-sess-123");
});

function fakeExec(result: { stdout?: string; code?: number; stderr?: string }): {
  exec: ExecFn;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.code ?? 0 };
  };
  return { exec, calls };
}

test("establishIdentity: success scopes cli and returns whoami", async () => {
  const { exec, calls } = fakeExec({ stdout: '{"session_id":"pi-sess-123","alias":"pi-abc123"}' });
  const cli = new C2cCli({ exec });
  const res = await establishIdentity(cli, { piSessionId: "sess-123", configuredAlias: "pi-abc123" });
  assert.equal(res.ok, true);
  assert.equal(res.identity.sessionId, "pi-sess-123");
  assert.equal(res.identity.alias, "pi-abc123");
  assert.equal(cli.sessionId, "pi-sess-123");
  // register was called with the derived id + resolved alias
  assert.deepEqual(calls[0].args, [
    "register",
    "--alias",
    "pi-abc123",
    "--session-id",
    "pi-sess-123",
    "--json",
  ]);
});

test("establishIdentity: broker failure degrades to ok:false (no throw)", async () => {
  const { exec } = fakeExec({ code: 123, stderr: "broker unreachable" });
  const cli = new C2cCli({ exec });
  const res = await establishIdentity(cli, { piSessionId: "sess-9" });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /broker unreachable/);
  // identity is still computed so callers can show intended alias
  assert.equal(res.identity.sessionId, "pi-sess-9");
});

test("C2cError shape is preserved through establishIdentity error path", async () => {
  const exec: ExecFn = async () => {
    throw new C2cError("boom", 1, "stderr-text");
  };
  const cli = new C2cCli({ exec });
  const res = await establishIdentity(cli, { piSessionId: "s" });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /boom/);
});
