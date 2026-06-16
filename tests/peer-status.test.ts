/**
 * Unit tests for the peer status store and status-message filter.
 *
 * Status envelopes arrive as c2c messages; we want to record them in the
 * store, drop them from delivery, and let `c2c_list` show the recorded state
 * next to each peer. The LLM and the human chat history should never see
 * status envelopes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PeerStatusStore, extractStatusMessages } from "../src/peer-status.ts";
import type { StatusEnvelope } from "../src/status-sync.ts";

const ENVELOPE = (overrides: Partial<StatusEnvelope> = {}): StatusEnvelope => ({
  event: "status",
  from: "pi-c01ea5",
  state: "processing",
  since: "2026-06-17T00:00:00.000Z",
  ttl_ms: 60_000,
  ...overrides,
});

test("PeerStatusStore: update + get returns the recorded entry", () => {
  const store = new PeerStatusStore({ now: () => 1_000_000 });
  const e = ENVELOPE({ from: "alice", state: "idle" });
  store.update("alice", e);
  const got = store.get("alice");
  assert.ok(got);
  assert.equal(got!.state, "idle");
  assert.equal(got!.ttlMs, 60_000);
});

test("PeerStatusStore: get returns null for unknown alias", () => {
  const store = new PeerStatusStore();
  assert.equal(store.get("nobody"), null);
});

test("PeerStatusStore: get returns null for expired entry (now > lastSeen + ttlMs)", () => {
  let now = 1_000_000;
  const store = new PeerStatusStore({ now: () => now });
  store.update("alice", ENVELOPE({ from: "alice", ttl_ms: 30_000 }));
  now = 1_000_000 + 31_000;
  assert.equal(store.get("alice"), null, "should be expired");
});

test("PeerStatusStore: get returns entry if still within TTL", () => {
  let now = 1_000_000;
  const store = new PeerStatusStore({ now: () => now });
  store.update("alice", ENVELOPE({ from: "alice", ttl_ms: 30_000 }));
  now = 1_000_000 + 29_000;
  const got = store.get("alice");
  assert.ok(got, "should still be fresh");
});

test("PeerStatusStore: update overwrites prior entry for same alias", () => {
  let now = 1_000_000;
  const store = new PeerStatusStore({ now: () => now });
  store.update("alice", ENVELOPE({ from: "alice", state: "idle" }));
  now += 1000;
  store.update("alice", ENVELOPE({ from: "alice", state: "processing" }));
  const got = store.get("alice");
  assert.equal(got!.state, "processing");
  assert.equal(got!.lastSeen, 1_001_000);
});

test("PeerStatusStore: size counts both live and expired entries", () => {
  let now = 1_000_000;
  const store = new PeerStatusStore({ now: () => now });
  store.update("alice", ENVELOPE({ from: "alice", ttl_ms: 30_000 }));
  store.update("bob", ENVELOPE({ from: "bob", ttl_ms: 30_000 }));
  now += 31_000;
  store.update("charlie", ENVELOPE({ from: "charlie", ttl_ms: 30_000 }));
  assert.equal(store.size(), 3, "size includes expired entries");
});

test("PeerStatusStore: live() filters out expired entries", () => {
  let now = 1_000_000;
  const store = new PeerStatusStore({ now: () => now });
  store.update("alice", ENVELOPE({ from: "alice", ttl_ms: 30_000 }));
  store.update("bob", ENVELOPE({ from: "bob", ttl_ms: 30_000 }));
  now += 31_000;
  store.update("charlie", ENVELOPE({ from: "charlie", ttl_ms: 30_000 }));
  const live = store.live();
  const aliases = live.map((e) => e.alias).sort();
  assert.deepEqual(aliases, ["charlie"]);
});

test("PeerStatusStore: prune() removes expired entries and returns count", () => {
  let now = 1_000_000;
  const store = new PeerStatusStore({ now: () => now, pruneIntervalMs: 0 });
  store.update("alice", ENVELOPE({ from: "alice", ttl_ms: 30_000 }));
  store.update("bob", ENVELOPE({ from: "bob", ttl_ms: 30_000 }));
  store.update("charlie", ENVELOPE({ from: "charlie", ttl_ms: 30_000 }));
  now += 31_000;
  const removed = store.prune();
  assert.equal(removed, 3);
  assert.equal(store.size(), 0);
});

test("PeerStatusStore: clear() drops all entries", () => {
  const store = new PeerStatusStore();
  store.update("alice", ENVELOPE({ from: "alice" }));
  store.update("bob", ENVELOPE({ from: "bob" }));
  assert.equal(store.size(), 2);
  store.clear();
  assert.equal(store.size(), 0);
});

test("extractStatusMessages: passes through regular messages, drops status envelopes", () => {
  const store = new PeerStatusStore();
  const messages = [
    { content: "hello from a regular DM", from_alias: "alice" },
    {
      content:
        '<c2c event="status" from="bob" state="processing" since="2026-06-17T00:00:00.000Z" ttl_ms="60000" />',
      from_alias: "bob",
    },
    { content: "another regular message", from_alias: "charlie" },
  ];
  const out = extractStatusMessages(messages, store);
  assert.equal(out.recorded, 1, "should record exactly one status");
  assert.equal(out.messages.length, 2, "should pass through two regular messages");
  assert.equal(out.messages[0].from_alias, "alice");
  assert.equal(out.messages[1].from_alias, "charlie");
  // And the status was recorded under the right alias
  const recorded = store.get("bob");
  assert.ok(recorded);
  assert.equal(recorded!.state, "processing");
});

test("extractStatusMessages: updates store even for repeated status from same peer", () => {
  const store = new PeerStatusStore();
  const messages = [
    { content: '<c2c event="status" from="alice" state="idle" since="2026-06-17T00:00:00.000Z" ttl_ms="60000" />' },
    { content: '<c2c event="status" from="alice" state="processing" since="2026-06-17T00:01:00.000Z" ttl_ms="60000" />' },
  ];
  const out = extractStatusMessages(messages, store);
  assert.equal(out.recorded, 2);
  assert.equal(out.messages.length, 0);
  // Latest wins
  assert.equal(store.get("alice")!.state, "processing");
});

test("extractStatusMessages: handles sanitized <c2c form (‹c2c)", () => {
  // The delivery layer sanitizes inbound content for prompt-injection
  // defense, replacing `<` with `‹` in some cases. The parser handles
  // both forms.
  const store = new PeerStatusStore();
  const messages = [
    {
      content:
        '‹c2c event="status" from="alice" state="processing" since="2026-06-17T00:00:00.000Z" ttl_ms="60000" />',
    },
  ];
  const out = extractStatusMessages(messages, store);
  assert.equal(out.recorded, 1);
  assert.equal(out.messages.length, 0);
  assert.equal(store.get("alice")!.state, "processing");
});

test("extractStatusMessages: status envelope wrapped in a message envelope is also caught", () => {
  // A peer might broadcast via `send_all`, which delivers as a normal
  // message whose content happens to BE a status envelope. The current
  // parser extracts the inner status envelope from the wrapping
  // message envelope (the regex is tolerant of leading whitespace and
  // nested tags), so the status is recorded and the wrapping message
  // is dropped.
  const store = new PeerStatusStore();
  const messages = [
    {
      content:
        '<c2c event="message" from="alice" to="all">\n<c2c event="status" from="alice" state="idle" since="2026-06-17T00:00:00.000Z" ttl_ms="60000" />\n</c2c>',
    },
  ];
  const out = extractStatusMessages(messages, store);
  assert.equal(out.recorded, 1, "status extracted from wrapped envelope");
  assert.equal(out.messages.length, 0, "wrapping message dropped");
  assert.equal(store.get("alice")!.state, "idle");
});

test("extractStatusMessages: status envelope only (no message wrap) is the common case", () => {
  const store = new PeerStatusStore();
  const messages = [
    {
      content:
        '<c2c event="status" from="alice" state="processing" since="2026-06-17T00:00:00.000Z" ttl_ms="60000" />',
    },
    { content: "real message body" },
  ];
  const out = extractStatusMessages(messages, store);
  assert.equal(out.recorded, 1);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].content, "real message body");
});
