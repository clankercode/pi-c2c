/**
 * Unit tests for the c2c status tracker.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createStatusTracker,
  formatStatusEnvelope,
  parseStatusEnvelope,
  type StatusEnvelope,
  type StatusTracker,
} from "../src/status-sync.ts";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeTracker(
  alias = "pi-abc",
  opts: { now?: () => number; minIntervalMs?: number; inputTtlMs?: number } = {},
): { tracker: StatusTracker; broadcasts: StatusEnvelope[]; tick: (ms: number) => void } {
  let now = 0;
  const broadcasts: StatusEnvelope[] = [];
  const tracker = createStatusTracker({
    alias,
    minIntervalMs: opts.minIntervalMs ?? 10,
    inputTtlMs: opts.inputTtlMs ?? 20,
    now: () => now,
  });
  tracker.setBroadcast(async (envelope) => {
    broadcasts.push(envelope);
  });
  return {
    tracker,
    broadcasts,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

test("initial status is idle", () => {
  const { tracker } = makeTracker();
  assert.equal(tracker.getStatus().state, "idle");
});

test("transition broadcasts state change", async () => {
  const { tracker, broadcasts } = makeTracker();
  tracker.transition("processing");
  await delay(30);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].state, "processing");
  assert.equal(broadcasts[0].from, "pi-abc");
});

test("duplicate transitions are coalesced", async () => {
  const { tracker, broadcasts } = makeTracker();
  tracker.transition("processing");
  tracker.transition("tool");
  tracker.transition("processing");
  await delay(30);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].state, "processing");
});

test("throttle prevents more than one broadcast per interval", async () => {
  const { tracker, broadcasts } = makeTracker("pi-abc", { minIntervalMs: 50 });
  tracker.transition("processing");
  await delay(10);
  tracker.transition("idle");
  await delay(60);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].state, "idle");
});

test("multiple transitions beyond interval emit multiple broadcasts", async () => {
  const { tracker, broadcasts } = makeTracker();
  tracker.transition("processing");
  await delay(30);
  tracker.transition("idle");
  await delay(30);
  assert.equal(broadcasts.length, 2);
  assert.equal(broadcasts[0].state, "processing");
  assert.equal(broadcasts[1].state, "idle");
});

test("input state reverts to previous non-input state after TTL", async () => {
  const { tracker, broadcasts } = makeTracker("pi-abc", { inputTtlMs: 30 });
  tracker.transition("processing");
  await delay(30);
  assert.equal(broadcasts.length, 1);

  tracker.transition("input");
  await delay(30);
  assert.equal(broadcasts.length, 2);
  assert.equal(broadcasts[1].state, "input");

  await delay(60);
  assert.equal(tracker.getStatus().state, "processing");
});

test("input revert does nothing if state already changed", async () => {
  const { tracker, broadcasts } = makeTracker("pi-abc", { inputTtlMs: 100 });
  tracker.transition("processing");
  await delay(30);

  tracker.transition("input");
  await delay(30);

  tracker.transition("tool");
  await delay(30);

  assert.equal(tracker.getStatus().state, "tool");
  // The input revert timeout fires later but should not change state.
  await delay(200);
  assert.equal(tracker.getStatus().state, "tool");
  // processing, input, tool = 3 broadcasts
  assert.equal(broadcasts.length, 3);
});

test("dispose stops broadcasts and timers", async () => {
  const { tracker, broadcasts } = makeTracker();
  tracker.transition("processing");
  tracker.dispose();
  await delay(60);
  assert.equal(broadcasts.length, 0);
});

test("setBroadcast can be changed after creation", async () => {
  const tracker = createStatusTracker({ alias: "pi-abc", minIntervalMs: 10 });
  const first: StatusEnvelope[] = [];
  const second: StatusEnvelope[] = [];
  tracker.setBroadcast((e) => {
    first.push(e);
  });
  tracker.transition("processing");
  tracker.setBroadcast((e) => {
    second.push(e);
  });
  await delay(30);
  assert.equal(first.length, 0);
  assert.equal(second.length, 1);
});

test("formatStatusEnvelope round-trips through parseStatusEnvelope", () => {
  const envelope: StatusEnvelope = {
    event: "status",
    from: "lyra-quill",
    state: "processing",
    since: "2026-06-17T00:00:00.000Z",
    ttl_ms: 60_000,
  };
  const xml = formatStatusEnvelope(envelope);
  assert.ok(xml.includes('event="status"'));
  assert.ok(xml.includes('state="processing"'));
  const parsed = parseStatusEnvelope(xml);
  assert.deepEqual(parsed, envelope);
});

test("parseStatusEnvelope rejects invalid states and bad TTLs", () => {
  assert.equal(parseStatusEnvelope('<c2c event="status" from="x" state="unknown" since="t" ttl_ms="100" />'), null);
  assert.equal(parseStatusEnvelope('<c2c event="status" from="x" state="idle" since="t" ttl_ms="abc" />'), null);
  assert.equal(parseStatusEnvelope("not an envelope"), null);
});

test("formatStatusEnvelope escapes XML special characters", () => {
  const envelope: StatusEnvelope = {
    event: "status",
    from: 'pi-"special"',
    state: "idle",
    since: "t",
    ttl_ms: 1,
  };
  const xml = formatStatusEnvelope(envelope);
  assert.ok(!xml.includes('from="pi-"special""'));
  assert.ok(xml.includes("pi-&quot;special&quot;"));
});

test("parseStatusEnvelope handles sanitized ‹c2c form", () => {
  const sanitized = '<c2c event="message" from="peer" to="me" source="broker">\n‹c2c event="status" from="peer" state="processing" since="2026-06-17T00:00:00.000Z" ttl_ms="60000" />\n</c2c>';
  const parsed = parseStatusEnvelope(sanitized);
  assert.ok(parsed);
  assert.equal(parsed!.from, "peer");
  assert.equal(parsed!.state, "processing");
});

test("parseStatusEnvelope does not accept arbitrary text as status", () => {
  assert.equal(parseStatusEnvelope("just some text"), null);
  assert.equal(parseStatusEnvelope("‹c2c event=\"message\" from=\"x\" /\u003e"), null);
});
