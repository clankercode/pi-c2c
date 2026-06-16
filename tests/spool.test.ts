import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spoolPath, readSpool, writeSpool, clearSpool, gcStaleSpools } from "../src/spool.ts";
import type { C2cMessage } from "../src/c2c-cli.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-c2c-spool-"));
}

const m = (over: Partial<C2cMessage> = {}): C2cMessage => ({
  from_alias: "storm",
  to_alias: "pi-x",
  content: "hi",
  ts: 1,
  ...over,
});

test("writeSpool then readSpool round-trips", () => {
  const dir = tmpDir();
  const msgs = [m({ ts: 1 }), m({ ts: 2, content: "yo" })];
  writeSpool(dir, "pi-sess", msgs);
  assert.deepEqual(readSpool(dir, "pi-sess"), msgs);
});

test("readSpool: missing file -> []", () => {
  const dir = tmpDir();
  assert.deepEqual(readSpool(dir, "never-written"), []);
});

test("readSpool: garbage / non-array -> []", () => {
  const dir = tmpDir();
  fs.writeFileSync(spoolPath(dir, "bad"), "not json", "utf-8");
  assert.deepEqual(readSpool(dir, "bad"), []);
  fs.writeFileSync(spoolPath(dir, "obj"), '{"a":1}', "utf-8");
  assert.deepEqual(readSpool(dir, "obj"), []);
});

test("readSpool: filters malformed entries", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    spoolPath(dir, "mixed"),
    JSON.stringify([m({ ts: 1 }), { nope: true }, null, { from_alias: "a", content: "ok", to_alias: "", ts: 0 }]),
    "utf-8",
  );
  const got = readSpool(dir, "mixed");
  assert.equal(got.length, 2);
});

test("clearSpool removes the file; subsequent read -> []", () => {
  const dir = tmpDir();
  writeSpool(dir, "pi-sess", [m()]);
  assert.equal(readSpool(dir, "pi-sess").length, 1);
  clearSpool(dir, "pi-sess");
  assert.deepEqual(readSpool(dir, "pi-sess"), []);
});

test("clearSpool on absent file does not throw", () => {
  const dir = tmpDir();
  assert.doesNotThrow(() => clearSpool(dir, "absent"));
});

test("writeSpool overwrites (not appends)", () => {
  const dir = tmpDir();
  writeSpool(dir, "s", [m({ ts: 1 })]);
  writeSpool(dir, "s", [m({ ts: 2 }), m({ ts: 3 })]);
  assert.deepEqual(
    readSpool(dir, "s").map((x) => x.ts),
    [2, 3],
  );
});

test("spoolPath: session ids with separators cannot escape the dir", () => {
  const dir = tmpDir();
  const p = spoolPath(dir, "../../etc/passwd");
  // path separators are stripped → single segment inside dir (no traversal),
  // even though benign '.' chars survive in the filename.
  assert.equal(path.dirname(p), dir);
  assert.ok(path.resolve(p).startsWith(path.resolve(dir) + path.sep));
  assert.ok(!path.basename(p).includes("/"));
});

test("gcStaleSpools: removes only files older than maxAge, leaves fresh ones", () => {
  const dir = tmpDir();
  writeSpool(dir, "old", [m()]);
  writeSpool(dir, "fresh", [m()]);
  // backdate the "old" spool's mtime by 10 days
  const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const past = new Date(now - tenDaysMs);
  fs.utimesSync(spoolPath(dir, "old"), past, past);
  const removed = gcStaleSpools(dir, 7 * 24 * 60 * 60 * 1000, now);
  assert.equal(removed, 1);
  assert.deepEqual(readSpool(dir, "old"), []);
  assert.equal(readSpool(dir, "fresh").length, 1);
});

test("gcStaleSpools: missing dir / non-spool files are ignored", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "notes.txt"), "hi", "utf-8");
  assert.equal(gcStaleSpools(dir, 1000, Date.now()), 0);
  assert.equal(gcStaleSpools(path.join(dir, "nope"), 1000, Date.now()), 0);
});

test("distinct session ids -> distinct spool files", () => {
  const dir = tmpDir();
  writeSpool(dir, "pi-a", [m({ content: "A" })]);
  writeSpool(dir, "pi-b", [m({ content: "B" })]);
  assert.equal(readSpool(dir, "pi-a")[0].content, "A");
  assert.equal(readSpool(dir, "pi-b")[0].content, "B");
});
