import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatEnvelope,
  messageKey,
  DeliveryDedup,
  selectNovel,
  deliveryOptionsFor,
  notifySummary,
} from "../src/delivery.ts";
import type { C2cMessage } from "../src/c2c-cli.ts";

const mk = (over: Partial<C2cMessage> = {}): C2cMessage => ({
  from_alias: "storm",
  to_alias: "pi-abc",
  content: "hello",
  ts: 1,
  ...over,
});

test("formatEnvelope: parity shape with the OpenCode plugin", () => {
  const env = formatEnvelope(mk({ content: "ping" }));
  assert.equal(
    env,
    '<c2c event="message" from="storm" to="pi-abc" source="broker" reply_via="c2c_send" action_after="continue">\nping\n</c2c>',
  );
});

test("formatEnvelope: falls back for empty from/to", () => {
  const env = formatEnvelope(mk({ from_alias: "", to_alias: "" }), "pi-self");
  assert.match(env, /from="unknown"/);
  assert.match(env, /to="pi-self"/);
});

test("messageKey: distinguishes by sender, ts, content", () => {
  // NUL-separated so field boundaries are unambiguous ("a b"+"c" != "a"+"b c").
  assert.equal(messageKey(mk()), "storm\u00001\u0000hello");
  assert.notEqual(messageKey(mk({ ts: 2 })), messageKey(mk({ ts: 1 })));
  assert.notEqual(messageKey(mk({ content: "x" })), messageKey(mk({ content: "y" })));
  assert.notEqual(messageKey(mk({ from_alias: "a" })), messageKey(mk({ from_alias: "b" })));
});

test("DeliveryDedup: add/has + bounded eviction", () => {
  const d = new DeliveryDedup(2);
  d.add("a");
  d.add("b");
  assert.ok(d.has("a") && d.has("b"));
  d.add("c"); // evicts "a"
  assert.equal(d.has("a"), false);
  assert.ok(d.has("b") && d.has("c"));
  assert.equal(d.size, 2);
});

test("DeliveryDedup: re-adding does not grow or reorder", () => {
  const d = new DeliveryDedup(2);
  d.add("a");
  d.add("a");
  assert.equal(d.size, 1);
  d.add("b");
  d.add("c"); // evicts "a" (b was not bumped by re-add semantics; a is oldest)
  assert.equal(d.has("a"), false);
});

test("selectNovel: filters seen, marks new, preserves order", () => {
  const d = new DeliveryDedup();
  const m1 = mk({ ts: 1 });
  const m2 = mk({ ts: 2 });
  const first = selectNovel([m1, m2], d);
  assert.deepEqual(first.map((m) => m.ts), [1, 2]);
  // second drain returns the same two plus a new one -> only the new survives
  const m3 = mk({ ts: 3 });
  const second = selectNovel([m1, m2, m3], d);
  assert.deepEqual(second.map((m) => m.ts), [3]);
});

test("selectNovel: dedups within a single batch", () => {
  const d = new DeliveryDedup();
  const dup = mk({ ts: 5, content: "same" });
  const out = selectNovel([dup, { ...dup }], d);
  assert.equal(out.length, 1);
});

test("deliveryOptionsFor: idle triggers a turn, busy queues followUp", () => {
  assert.deepEqual(deliveryOptionsFor(true), { triggerTurn: true });
  assert.deepEqual(deliveryOptionsFor(false), { deliverAs: "followUp" });
});

test("notifySummary: single vs many, with truncation", () => {
  assert.match(notifySummary([mk({ content: "hi" })]), /from storm — hi/);
  const long = "x".repeat(100);
  assert.match(notifySummary([mk({ content: long })]), /\.\.\.$/);
  const many = notifySummary([mk({ from_alias: "a" }), mk({ from_alias: "b" })]);
  assert.match(many, /2 messages from a, b/);
});
