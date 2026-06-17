import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLiveTelemetry,
  formatDuration,
  formatTimestamp,
} from "../src/telemetry.ts";

test("telemetry: starts empty", () => {
  const tel = createLiveTelemetry();
  const s = tel.snapshot(0);
  assert.equal(s.sessionStartAt, undefined);
  assert.equal(s.pollCount, 0);
  assert.equal(s.messagesReceived, 0);
  assert.equal(s.messagesInjected, 0);
  assert.equal(s.messagesSent, 0);
  assert.equal(s.lastReceived, undefined);
  assert.equal(s.lastSent, undefined);
  assert.equal(s.lastError, undefined);
  assert.equal(s.spoolCount, 0);
  assert.equal(s.peerStatusCount, 0);
});

test("telemetry: startSession records start time", () => {
  const tel = createLiveTelemetry(() => 12345);
  tel.startSession();
  assert.equal(tel.snapshot().sessionStartAt, 12345);
});

test("telemetry: poll increments count and records duration", () => {
  let now = 0;
  const tel = createLiveTelemetry(() => now);
  tel.beginPoll();
  now = 42;
  tel.endPoll();
  const s = tel.snapshot(now);
  assert.equal(s.pollCount, 1);
  assert.equal(s.lastPollAt, 42);
  assert.equal(s.lastPollDurationMs, 42);
});

test("telemetry: recordReceived tracks count and preview", () => {
  const tel = createLiveTelemetry(() => 1000);
  tel.recordReceived({ from: "alice", content: "hello\nworld" });
  const s = tel.snapshot(1000);
  assert.equal(s.messagesReceived, 1);
  assert.equal(s.lastReceived?.from, "alice");
  assert.equal(s.lastReceived?.preview, "hello world");
  assert.equal(s.lastReceived?.source, "unknown");
  assert.equal(s.lastReceived?.at, 1000);
});

test("telemetry: recordReceived truncates long preview", () => {
  const tel = createLiveTelemetry();
  const content = "a".repeat(200);
  tel.recordReceived({ from: "bob", content });
  const s = tel.snapshot();
  assert.ok(s.lastReceived!.preview.endsWith("…"));
  assert.equal(s.lastReceived!.preview.length, 120);
});

test("telemetry: recordInjected increments and records time", () => {
  const tel = createLiveTelemetry(() => 5000);
  tel.recordInjected(3);
  const s = tel.snapshot(5000);
  assert.equal(s.messagesInjected, 3);
  assert.equal(s.lastInjectAt, 5000);
});

test("telemetry: recordSent tracks last sent", () => {
  const tel = createLiveTelemetry(() => 2000);
  tel.recordSent("alice", "sessions");
  const s = tel.snapshot(2000);
  assert.equal(s.messagesSent, 1);
  assert.equal(s.lastSent?.to, "alice");
  assert.equal(s.lastSent?.via, "sessions");
  assert.equal(s.lastSent?.at, 2000);
});

test("telemetry: broker ok/error tracked per source", () => {
  const tel = createLiveTelemetry(() => 1000);
  tel.recordBrokerOk("local");
  tel.recordBrokerError("sessions", new Error("sessions down"));
  const s = tel.snapshot(1000);
  assert.equal(s.brokerHealth.local?.lastOkAt, 1000);
  assert.equal(s.brokerHealth.sessions?.lastError, "sessions down");
  assert.equal(s.lastError, "sessions down");
});

test("telemetry: relay ok/error tracked separately", () => {
  const tel = createLiveTelemetry(() => 3000);
  tel.recordRelayOk();
  tel.recordRelayError("timeout");
  const s = tel.snapshot(3000);
  assert.equal(s.relayHealth.lastOkAt, 3000);
  assert.equal(s.relayHealth.lastError, "timeout");
});

test("telemetry: spool and peer status counts", () => {
  const tel = createLiveTelemetry();
  tel.recordSpoolCount(7);
  tel.recordPeerStatusCount(4);
  const s = tel.snapshot();
  assert.equal(s.spoolCount, 7);
  assert.equal(s.peerStatusCount, 4);
});

test("formatDuration: renders ms, seconds, minutes", () => {
  assert.equal(formatDuration(500), "500ms");
  assert.equal(formatDuration(1500), "1.5s");
  assert.equal(formatDuration(90_000), "1.5m");
  assert.equal(formatDuration(undefined), "—");
});

test("formatTimestamp: renders relative ages", () => {
  const now = 100_000;
  assert.equal(formatTimestamp(now, now), "just now");
  assert.equal(formatTimestamp(now - 5_000, now), "5s ago");
  assert.equal(formatTimestamp(now - 120_000, now), "2m ago");
  assert.equal(formatTimestamp(now - 7_200_000, now), "2h ago");
  assert.equal(formatTimestamp(now - 172_800_000, now), "2d ago");
  assert.equal(formatTimestamp(undefined, now), "never");
});
