/**
 * Integration tests against the REAL `c2c` binary.
 *
 * The unit tests fixture out `c2c`, so they cannot catch the most dangerous
 * regression: the c2c CLI changing a flag name, argument order, or --json
 * shape out from under this plugin. These tests drive the actual `C2cCli`
 * wrapper through a real `c2c` process on an ISOLATED broker (a temp dir via
 * C2C_MCP_BROKER_ROOT — the shared swarm broker is never touched), asserting
 * the exact contracts the extension depends on.
 *
 * They self-skip when `c2c` is not on PATH, so `pnpm test` stays portable.
 * Run explicitly with `just test-integration` on a machine that has c2c.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { C2cCli, type ExecFn, type ExecResultLike } from "../src/c2c-cli.ts";
import { resolveC2cCommand } from "../src/c2c-bin.ts";

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

let broker: string;
before(() => {
  broker = fs.mkdtempSync(path.join(os.tmpdir(), "pi-c2c-it-"));
});
after(() => {
  try {
    fs.rmSync(broker, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

/** A real ExecFn that runs `c2c` against the isolated broker, with the caller
 * identity supplied via C2C_MCP_SESSION_ID — exactly how the extension scopes
 * the child process at runtime. */
function realExec(sessionId: string): ExecFn {
  return (command, args) =>
    new Promise<ExecResultLike>((resolve) => {
      const child = spawn(command, args, {
        env: { ...process.env, C2C_MCP_BROKER_ROOT: broker, C2C_MCP_SESSION_ID: sessionId },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
      child.on("error", (e) => resolve({ stdout, stderr: String(e), code: 127 }));
    });
}

const cli = (sessionId: string) => new C2cCli({ exec: realExec(sessionId), sessionId, bin: C2C_BIN });

test("register + whoami round-trip (whoami takes NO --session-id)", opts, async () => {
  const c = cli("pi-it-a");
  const reg = await c.register("pi-it-alpha", "pi-it-a");
  assert.equal(reg?.alias, "pi-it-alpha");
  assert.equal(reg?.session_id, "pi-it-a");
  const me = await c.whoami();
  assert.equal(me?.alias, "pi-it-alpha");
  assert.equal(me?.session_id, "pi-it-a");
});

test("list --json parses (alias + boolean alive) for the real shape", opts, async () => {
  const c = cli("pi-it-a");
  await c.register("pi-it-alpha", "pi-it-a");
  const peers = await c.list();
  const me = peers.find((p) => p.alias === "pi-it-alpha");
  assert.ok(me, "self should appear in list");
  assert.equal(me!.alive, true, "resolved c2c binary should register a live pi process, not a short-lived wrapper PID");
});

test("send via env (no --from) is accepted; -- guards a leading-dash body; poll-inbox shape parses", opts, async () => {
  const a = cli("pi-it-a");
  const b = cli("pi-it-b");
  await a.register("pi-it-alpha", "pi-it-a");
  await b.register("pi-it-beta", "pi-it-b");

  // env-resolved caller (the BLOCKER-fix contract) + the `--` separator
  // contract (a leading-dash body must not be parsed as a flag).
  await a.send("pi-it-beta", "hello-integration");
  await a.send("pi-it-beta", "-leading dash body");

  const msgs = await b.pollInbox();
  const contents = msgs.map((m) => m.content);
  assert.ok(contents.includes("hello-integration"), `got: ${JSON.stringify(contents)}`);
  assert.ok(contents.includes("-leading dash body"), `leading-dash body lost: ${JSON.stringify(contents)}`);
  assert.equal(msgs[0].from_alias, "pi-it-alpha");
  assert.equal(typeof msgs[0].ts, "number");
});

test("rooms: join (--alias/--), my-rooms (room_id), send (env), history", opts, async () => {
  const a = cli("pi-it-a");
  await a.register("pi-it-alpha", "pi-it-a");

  await a.joinRoom("pi-it-room", "pi-it-alpha");
  const rooms = await a.myRooms();
  assert.ok(rooms.includes("pi-it-room"), `my-rooms missing room_id: ${JSON.stringify(rooms)}`);

  await a.sendRoom("pi-it-room", "room-msg-integration");
  const hist = await a.roomHistory("pi-it-room", 20);
  assert.ok(
    hist.some((m) => m.content.includes("room-msg-integration")),
    `room history missing message: ${JSON.stringify(hist.map((m) => m.content))}`,
  );
});
