/**
 * Unit tests for the relay helpers in src/relay.ts.
 *
 * The host-hash recipe:
 *   sha256(machine-id || product_uuid || hostname || stable_mac) → first-12 hex
 *
 * Tests inject fake filesystem + network inputs so they don't depend on the
 * actual machine the test is running on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeHostHash,
  deriveRelayAlias,
  parseRelayAlias,
  pickHostSource,
  type FsLike,
  type NetLike,
} from "../src/relay.ts";

function fakeFs(files: Record<string, string | undefined>): FsLike {
  return {
    readFile: (p: string): string | undefined => files[p],
  };
}

function fakeNet(opts: { hostname?: string } = {}): NetLike {
  return {
    hostname: () => opts.hostname ?? "",
  };
}

test("pickHostSource: prefers product_uuid when available", () => {
  const fs = fakeFs({
    "/sys/class/dmi/id/product_uuid": "deadbeef-product-uuid",
    "/etc/machine-id": "machine-id-fallback",
  });
  const net = fakeNet({ hostname: "xsm" });
  const picked = pickHostSource(fs, net);
  assert.deepEqual(picked, { value: "deadbeef-product-uuid", kind: "product_uuid" });
});

test("pickHostSource: falls back to machine_id when product_uuid missing", () => {
  const fs = fakeFs({
    "/etc/machine-id": "machine-id-fallback",
  });
  const net = fakeNet({ hostname: "xsm" });
  const picked = pickHostSource(fs, net);
  assert.deepEqual(picked, { value: "machine-id-fallback", kind: "machine_id" });
});

test("pickHostSource: falls back to hostname when both files missing", () => {
  const fs = fakeFs({});
  const net = fakeNet({ hostname: "xsm" });
  const picked = pickHostSource(fs, net);
  assert.deepEqual(picked, { value: "xsm", kind: "hostname" });
});

test("pickHostSource: returns undefined when no source available", () => {
  const fs = fakeFs({});
  const net = fakeNet({});
  assert.equal(pickHostSource(fs, net), undefined);
});

test("pickHostSource: trims whitespace from file contents", () => {
  const fs = fakeFs({
    "/sys/class/dmi/id/product_uuid": "  abc-padded  ",
  });
  const net = fakeNet();
  const picked = pickHostSource(fs, net);
  assert.equal(picked?.value, "abc-padded");
});

test("pickHostSource: treats empty file as missing", () => {
  const fs = fakeFs({
    "/sys/class/dmi/id/product_uuid": "",
    "/etc/machine-id": "  ",
  });
  const net = fakeNet({ hostname: "xsm" });
  const picked = pickHostSource(fs, net);
  assert.deepEqual(picked, { value: "xsm", kind: "hostname" });
});

test("computeHostHash: returns 12 hex chars when product_uuid is available", () => {
  const fs = fakeFs({
    "/sys/class/dmi/id/product_uuid": "deadbeef",
  });
  const h = computeHostHash(fs, fakeNet());
  assert.match(h, /^[0-9a-f]{12}$/);
});

test("computeHostHash: returns the placeholder '000000000000' when no sources are available", () => {
  const h = computeHostHash(fakeFs({}), fakeNet({}));
  assert.equal(h, "000000000000");
});

test("computeHostHash: stable across calls with same inputs", () => {
  const fs = fakeFs({ "/sys/class/dmi/id/product_uuid": "stable" });
  const h1 = computeHostHash(fs, fakeNet());
  const h2 = computeHostHash(fs, fakeNet());
  assert.equal(h1, h2);
});

test("computeHostHash: changes when primary source changes", () => {
  const fs1 = fakeFs({ "/sys/class/dmi/id/product_uuid": "abc" });
  const fs2 = fakeFs({ "/sys/class/dmi/id/product_uuid": "xyz" });
  const h1 = computeHostHash(fs1, fakeNet());
  const h2 = computeHostHash(fs2, fakeNet());
  assert.notEqual(h1, h2);
});

test("computeHostHash: different kinds produce different hashes for same value", () => {
  // Salt with kind means a hostname 'foo' and a machine-id 'foo' don't
  // collide (catastrophic if they did — would alias two different hosts).
  const fs = fakeFs({ "/etc/machine-id": "same-value" });
  const net = fakeNet({ hostname: "same-value" });
  const h1 = computeHostHash(fs, fakeNet()); // picks machine_id
  const h2 = computeHostHash(fakeFs({}), net); // picks hostname
  assert.notEqual(h1, h2);
});

test("computeHostHash: prefers product_uuid over machine_id with same value", () => {
  // If product_uuid is present, it's used (not machine_id). Verify by
  // checking that the hash is the product_uuid-salted hash.
  const fs1 = fakeFs({
    "/sys/class/dmi/id/product_uuid": "value",
    "/etc/machine-id": "value",
  });
  const fs2 = fakeFs({ "/sys/class/dmi/id/product_uuid": "value" });
  const h1 = computeHostHash(fs1, fakeNet());
  const h2 = computeHostHash(fs2, fakeNet());
  assert.equal(h1, h2, "product_uuid should win even when machine_id shares the value");
});

test("computeHostHash: hostname-only fallback when both files missing", () => {
  const net = fakeNet({ hostname: "xsm" });
  const h = computeHostHash(fakeFs({}), net);
  assert.match(h, /^[0-9a-f]{12}$/);
});

test("computeHostHash: 12 hex chars ≈ 48 bits of entropy", () => {
  const h1 = computeHostHash(fakeFs({ "/sys/class/dmi/id/product_uuid": "1" }), fakeNet());
  const h2 = computeHostHash(fakeFs({ "/sys/class/dmi/id/product_uuid": "2" }), fakeNet());
  assert.equal(h1.length, 12);
  assert.equal(h2.length, 12);
  assert.notEqual(h1, h2);
});

test("deriveRelayAlias: produces '<name>#<host_hash>'", () => {
  const alias = deriveRelayAlias("pi-c01ea5", "a1b2c3d4e5f6");
  assert.equal(alias, "pi-c01ea5#a1b2c3d4e5f6");
});

test("deriveRelayAlias: rejects invalid name characters", () => {
  assert.throws(() => deriveRelayAlias("pi/abc", "a1b2c3d4e5f6"), /invalid name/);
  assert.throws(() => deriveRelayAlias("", "a1b2c3d4e5f6"), /invalid name/);
  assert.throws(() => deriveRelayAlias("pi abc", "a1b2c3d4e5f6"), /invalid name/);
});

test("deriveRelayAlias: rejects invalid host_hash", () => {
  assert.throws(() => deriveRelayAlias("pi-abc", "tooshort"), /invalid hostHash/);
  assert.throws(() => deriveRelayAlias("pi-abc", "z".repeat(12)), /invalid hostHash/);
  assert.throws(() => deriveRelayAlias("pi-abc", "z".repeat(13)), /invalid hostHash/);
});

test("parseRelayAlias: round-trips a derived alias", () => {
  const original = "pi-c01ea5#a1b2c3d4e5f6";
  const parsed = parseRelayAlias(original);
  assert.deepEqual(parsed, { name: "pi-c01ea5", hostHash: "a1b2c3d4e5f6" });
});

test("parseRelayAlias: returns null on missing #", () => {
  assert.equal(parseRelayAlias("pi-c01ea5"), null);
  assert.equal(parseRelayAlias(""), null);
});

test("parseRelayAlias: returns null on invalid name", () => {
  assert.equal(parseRelayAlias("pi/abc#a1b2c3d4e5f6"), null);
  assert.equal(parseRelayAlias("#a1b2c3d4e5f6"), null);
});

test("parseRelayAlias: returns null on invalid host_hash", () => {
  assert.equal(parseRelayAlias("pi-c01ea5#tooshort"), null);
  assert.equal(parseRelayAlias("pi-c01ea5#aabbccddeeffXX"), null);
});

test("Integration: deriveRelayAlias -> parseRelayAlias round-trips", () => {
  const cases: Array<[string, string]> = [
    ["pi-c01ea5", "a1b2c3d4e5f6"],
    ["pi-313d8c", "0123456789ab"],
    ["pi-999999", "fedcba987654"],
  ];
  for (const [name, hash] of cases) {
    const alias = deriveRelayAlias(name, hash);
    const parsed = parseRelayAlias(alias);
    assert.ok(parsed, `expected ${alias} to parse`);
    assert.equal(parsed!.name, name);
    assert.equal(parsed!.hostHash, hash);
  }
});

test("Integration: computeHostHash output is valid for deriveRelayAlias", () => {
  const fs = fakeFs({ "/etc/machine-id": "abc" });
  const net = fakeNet({ hostname: "xsm", mac: "aa:bb:cc:dd:ee:ff" });
  const h = computeHostHash(fs, net);
  const alias = deriveRelayAlias("pi-test", h);
  assert.match(alias, /^pi-test#[0-9a-f]{12}$/);
  const parsed = parseRelayAlias(alias);
  assert.equal(parsed!.hostHash, h);
});
