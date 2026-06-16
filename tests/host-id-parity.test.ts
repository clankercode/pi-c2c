/**
 * Cross-check test: c2c host-id vs pi-c2c computeHostHash.
 *
 * Locks in recipe parity from the pi-c2c side. The c2c binary (post
 * slice 1, commit 3d37905c) ships a `c2c host-id` subcommand that
 * implements the same recipe as the extension's
 * `pi-c2c/src/relay.ts:computeHostHash()`. This test shells out to
 * `c2c host-id` and asserts byte-for-byte equality.
 *
 * Self-skips when `c2c` is not on PATH (mirrors the pattern in
 * `tests/integration.test.ts`). The unit-level recipe parity is
 * proven by the c2c-side tests in
 * `ocaml/test/test_relay_opaque_host_id.ml`; this is the cross-
 * implementation test that catches drift in either direction.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { computeHostHash } from "../src/relay.ts";

const C2C_BIN = process.env.C2C_BIN ?? "c2c";

function c2cHostIdAvailable(): boolean {
  try {
    execFileSync(C2C_BIN, ["host-id"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAVE_C2C = c2cHostIdAvailable();
const opts = HAVE_C2C ? {} : { skip: "c2c binary not on PATH" };

test("c2c host-id matches pi-c2c computeHostHash() byte-for-byte", opts, () => {
  // c2c host-id outputs just the 12-hex hash on stdout (plain mode).
  const c2cOutput = execFileSync(C2C_BIN, ["host-id"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

  // The extension's recipe: same sources, same order, same kind-prefixed
  // hashing, same 12-hex truncation.
  const local = computeHostHash();

  assert.equal(c2cOutput, local, "c2c host-id and computeHostHash() must match");
  // Sanity: must be exactly 12 lowercase hex chars (the canonical recipe).
  assert.match(c2cOutput, /^[0-9a-f]{12}$/);
  assert.match(local, /^[0-9a-f]{12}$/);
});

test("c2c host-id --json matches pi-c2c computeHostHash() and reports source", opts, () => {
  const stdout = execFileSync(C2C_BIN, ["host-id", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(stdout) as { host_id: string; kind: string; value: string };

  // The host_id field must match the extension's recipe.
  assert.equal(parsed.host_id, computeHostHash(), "c2c host-id (json) must match computeHostHash()");

  // The kind field must be one of the three source types (recipe fallback chain).
  assert.ok(
    ["product_uuid", "machine_id", "hostname"].includes(parsed.kind),
    `unexpected kind: ${parsed.kind} (expected product_uuid | machine_id | hostname)`,
  );

  // The value field must be non-empty (the actual source value).
  assert.ok(parsed.value.length > 0, "value field is empty");
});
