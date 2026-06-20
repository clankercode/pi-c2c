/**
 * Unit tests for cross-repo broker-root resolution and override.
 *
 * The cross-repo feature lets the extension talk to the sessions broker
 * (for cross-repo rendezvous) in addition to the per-repo broker. The
 * resolution logic must mirror `C2c_repo_fp.resolve_sessions_broker_root`
 * in the OCaml source.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  C2cCli,
  C2cError,
  resolveSessionsBrokerRoot,
  type ExecResultLike,
} from "../src/c2c-cli.ts";

test("resolveSessionsBrokerRoot: explicit C2C_SESSIONS_BROKER_ROOT wins", () => {
  const root = resolveSessionsBrokerRoot(
    { C2C_SESSIONS_BROKER_ROOT: "/custom/path" },
    "/home/x",
  );
  assert.equal(root, "/custom/path");
});

test("resolveSessionsBrokerRoot: trims whitespace from explicit override", () => {
  const root = resolveSessionsBrokerRoot(
    { C2C_SESSIONS_BROKER_ROOT: "  /custom/path  " },
    "/home/x",
  );
  assert.equal(root, "/custom/path");
});

test("resolveSessionsBrokerRoot: IGNORES XDG_STATE_HOME (rendezvous is fixed at HOME/.c2c)", () => {
  // The rendezvous must not move with a process's XDG_STATE_HOME, so it is
  // pinned to HOME/.c2c even when XDG_STATE_HOME is set. See c2c finding
  // 2026-06-20-sessions-broker-root-xdg-resolution.md.
  const root = resolveSessionsBrokerRoot({ XDG_STATE_HOME: "/state" }, "/home/x");
  assert.equal(root, "/home/x/.c2c/sessions/broker");
});

test("resolveSessionsBrokerRoot: falls back to HOME/.c2c/sessions/broker", () => {
  const root = resolveSessionsBrokerRoot({}, "/home/x");
  assert.equal(root, "/home/x/.c2c/sessions/broker");
});

test("resolveSessionsBrokerRoot: empty env returns a sane default", () => {
  const root = resolveSessionsBrokerRoot({}, "");
  assert.ok(root.length > 0, "should return some non-empty path");
});

test("resolveSessionsBrokerRoot: empty C2C_SESSIONS_BROKER_ROOT treated as unset", () => {
  const root = resolveSessionsBrokerRoot(
    { C2C_SESSIONS_BROKER_ROOT: "   " },
    "/home/x",
  );
  assert.equal(root, "/home/x/.c2c/sessions/broker");
});

/** A fake exec that records the env it was called with. */
function makeExecRecorder(): {
  calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }>;
  exec: (command: string, args: string[], options?: { timeout?: number; signal?: AbortSignal }) => Promise<ExecResultLike>;
} {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const exec = async (
    command: string,
    args: string[],
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<ExecResultLike> => {
    // The extension doesn't actually pass env; we read it from process.env
    // (which is what `setBrokerRootEnv` mutates).
    calls.push({ command, args, env: { ...process.env } });
    return { stdout: "{}", stderr: "", code: 0 };
  };
  return { calls, exec };
}

test("C2cCli.run: per-call brokerRoot sets C2C_MCP_BROKER_ROOT for the call", async () => {
  const { calls, exec } = makeExecRecorder();
  const cli = new C2cCli({ exec });
  // Make sure no stray env from the test runner leaks in.
  const before = process.env.C2C_MCP_BROKER_ROOT;
  delete process.env.C2C_MCP_BROKER_ROOT;
  try {
    await cli.run(["whoami", "--json"], { brokerRoot: "/sessions/broker" });
    assert.equal(calls.length, 1);
    const env = calls[0].env!;
    assert.equal(env.C2C_MCP_BROKER_ROOT, "/sessions/broker");
  } finally {
    if (before === undefined) delete process.env.C2C_MCP_BROKER_ROOT;
    else process.env.C2C_MCP_BROKER_ROOT = before;
  }
});

test("C2cCli.run: restores previous C2C_MCP_BROKER_ROOT after the call", async () => {
  const { calls, exec } = makeExecRecorder();
  const cli = new C2cCli({ exec });
  const before = process.env.C2C_MCP_BROKER_ROOT;
  process.env.C2C_MCP_BROKER_ROOT = "/preexisting";
  try {
    await cli.run(["whoami", "--json"], { brokerRoot: "/sessions/broker" });
    assert.equal(process.env.C2C_MCP_BROKER_ROOT, "/preexisting", "should restore the pre-call value");
    assert.equal(calls[0].env!.C2C_MCP_BROKER_ROOT, "/sessions/broker", "should be the override during the call");
  } finally {
    if (before === undefined) delete process.env.C2C_MCP_BROKER_ROOT;
    else process.env.C2C_MCP_BROKER_ROOT = before;
  }
});

test("C2cCli.run: restores C2C_MCP_BROKER_ROOT=undefined if it was unset before", async () => {
  const { calls, exec } = makeExecRecorder();
  const cli = new C2cCli({ exec });
  const before = process.env.C2C_MCP_BROKER_ROOT;
  delete process.env.C2C_MCP_BROKER_ROOT;
  try {
    await cli.run(["whoami", "--json"], { brokerRoot: "/sessions/broker" });
    assert.equal(
      process.env.C2C_MCP_BROKER_ROOT,
      undefined,
      "should be undefined after the call (was undefined before)",
    );
    assert.equal(calls[0].env!.C2C_MCP_BROKER_ROOT, "/sessions/broker");
  } finally {
    if (before === undefined) delete process.env.C2C_MCP_BROKER_ROOT;
    else process.env.C2C_MCP_BROKER_ROOT = before;
  }
});

test("C2cCli.run: restores even on error", async () => {
  const cli = new C2cCli({
    exec: async () => ({ stdout: "", stderr: "boom", code: 1 }),
  });
  const before = process.env.C2C_MCP_BROKER_ROOT;
  process.env.C2C_MCP_BROKER_ROOT = "/preexisting";
  try {
    await assert.rejects(
      () => cli.run(["whoami"], { brokerRoot: "/sessions/broker" }),
      (err: unknown) => err instanceof C2cError,
    );
    assert.equal(
      process.env.C2C_MCP_BROKER_ROOT,
      "/preexisting",
      "should restore even on error",
    );
  } finally {
    if (before === undefined) delete process.env.C2C_MCP_BROKER_ROOT;
    else process.env.C2C_MCP_BROKER_ROOT = before;
  }
});

test("C2cCli.run: instance brokerRoot is used when no per-call override", async () => {
  const { calls, exec } = makeExecRecorder();
  const cli = new C2cCli({ exec, brokerRoot: "/instance/broker" });
  const before = process.env.C2C_MCP_BROKER_ROOT;
  delete process.env.C2C_MCP_BROKER_ROOT;
  try {
    await cli.run(["list", "--json"]);
    assert.equal(calls[0].env!.C2C_MCP_BROKER_ROOT, "/instance/broker");
  } finally {
    if (before === undefined) delete process.env.C2C_MCP_BROKER_ROOT;
    else process.env.C2C_MCP_BROKER_ROOT = before;
  }
});

test("C2cCli.run: per-call brokerRoot wins over instance brokerRoot", async () => {
  const { calls, exec } = makeExecRecorder();
  const cli = new C2cCli({ exec, brokerRoot: "/instance/broker" });
  const before = process.env.C2C_MCP_BROKER_ROOT;
  delete process.env.C2C_MCP_BROKER_ROOT;
  try {
    await cli.run(["list", "--json"], { brokerRoot: "/per-call/broker" });
    assert.equal(calls[0].env!.C2C_MCP_BROKER_ROOT, "/per-call/broker");
  } finally {
    if (before === undefined) delete process.env.C2C_MCP_BROKER_ROOT;
    else process.env.C2C_MCP_BROKER_ROOT = before;
  }
});

test("C2cCli.run: no brokerRoot set anywhere leaves process env untouched", async () => {
  const { calls, exec } = makeExecRecorder();
  const cli = new C2cCli({ exec });
  const before = process.env.C2C_MCP_BROKER_ROOT;
  process.env.C2C_MCP_BROKER_ROOT = "/preexisting";
  try {
    await cli.run(["list", "--json"]);
    // Process env still has the pre-existing value; the call shouldn't have
    // touched it.
    assert.equal(process.env.C2C_MCP_BROKER_ROOT, "/preexisting");
    assert.equal(calls[0].env!.C2C_MCP_BROKER_ROOT, "/preexisting");
  } finally {
    if (before === undefined) delete process.env.C2C_MCP_BROKER_ROOT;
    else process.env.C2C_MCP_BROKER_ROOT = before;
  }
});
