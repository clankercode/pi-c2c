import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveC2cCommand, type C2cNpmResolver } from "../src/c2c-bin.ts";

function existsOnly(matches: string[]): (file: string) => boolean {
  const allowed = new Set(matches);
  return (file) => allowed.has(file);
}

test("resolveC2cCommand: explicit bin wins", () => {
  const command = resolveC2cCommand({
    explicitBin: "/custom/c2c",
    env: { C2C_BIN: "/env/c2c", PATH: "/usr/bin" },
    pathExists: existsOnly(["/usr/bin/c2c"]),
    npmResolver: () => "/pkg/c2c",
  });

  assert.equal(command, "/custom/c2c");
});

test("resolveC2cCommand: C2C_BIN wins over PATH and bundled npm package", () => {
  const command = resolveC2cCommand({
    env: { C2C_BIN: "/env/c2c", PATH: "/usr/bin" },
    pathExists: existsOnly(["/usr/bin/c2c"]),
    npmResolver: () => "/pkg/c2c",
  });

  assert.equal(command, "/env/c2c");
});

test("resolveC2cCommand: PATH c2c wins over bundled npm package", () => {
  let npmResolverCalled = false;
  const command = resolveC2cCommand({
    env: { PATH: "/bin:/usr/bin" },
    pathExists: existsOnly(["/usr/bin/c2c"]),
    npmResolver: () => {
      npmResolverCalled = true;
      return "/pkg/c2c";
    },
  });

  assert.equal(command, "/usr/bin/c2c");
  assert.equal(npmResolverCalled, false);
});

test("resolveC2cCommand: skips node_modules bin shims on PATH", () => {
  const command = resolveC2cCommand({
    env: { PATH: "/repo/node_modules/.bin:/usr/bin" },
    pathExists: existsOnly(["/repo/node_modules/.bin/c2c"]),
    npmResolver: () => "/pkg/native/c2c",
  });

  assert.equal(command, "/pkg/native/c2c");
});

test("resolveC2cCommand: uses bundled npm package when no PATH c2c exists", () => {
  const calls: unknown[] = [];
  const npmResolver: C2cNpmResolver = (opts) => {
    calls.push(opts);
    return "/pkg/c2c";
  };

  const command = resolveC2cCommand({
    env: { PATH: "/bin:/usr/bin" },
    pathExists: existsOnly([]),
    npmResolver,
  });

  assert.equal(command, "/pkg/c2c");
  assert.deepEqual(calls, [{ executable: "c2c", env: { PATH: "/bin:/usr/bin" } }]);
});

test("resolveC2cCommand: falls back to c2c when bundled resolver is unavailable", () => {
  const command = resolveC2cCommand({
    env: { PATH: "" },
    pathExists: existsOnly([]),
    npmResolver: () => {
      throw new Error("optional dependency missing");
    },
  });

  assert.equal(command, "c2c");
});
