import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderLiveDebug } from "../../src/ui/live-debug.ts";
import { createLiveTelemetry } from "../../src/telemetry.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

const opts = {
  identity: { alias: "pi-test", sessionId: "pi-sess" },
  registered: true,
  relayRegistered: true,
  relayAddress: "pi-test#abc123",
  crossRepoEnabled: true,
  crossRepoSessionsRegistered: true,
  pollIntervalMs: 5000,
};

test("renderLiveDebug: shows identity and connection state", () => {
  const tel = createLiveTelemetry(() => 1000);
  tel.startSession();
  const lines = renderLiveDebug(tel.snapshot(1000), plainTheme, opts);
  const text = lines.join("\n");
  assert.ok(text.includes("c2c live debug"));
  assert.ok(text.includes("pi-test"));
  assert.ok(text.includes("pi-sess"));
  assert.ok(text.includes("registered"));
  assert.ok(text.includes("cross-repo"));
  assert.ok(text.includes("relay"));
});

test("renderLiveDebug: shows traffic counters", () => {
  const tel = createLiveTelemetry(() => 2000);
  tel.startSession();
  tel.recordReceived({ from: "alice", content: "hello" });
  tel.recordInjected(1);
  tel.recordSent("bob", "per-repo");
  const lines = renderLiveDebug(tel.snapshot(2000), plainTheme, opts);
  const text = lines.join("\n");
  assert.ok(/received\s+1/.test(text), text);
  assert.ok(/injected\s+1/.test(text), text);
  assert.ok(/sent\s+1/.test(text), text);
});

test("renderLiveDebug: shows last received preview", () => {
  const tel = createLiveTelemetry(() => 3000);
  tel.startSession();
  tel.recordReceived({ from: "alice", content: "line one\nline two", source: "local" });
  const lines = renderLiveDebug(tel.snapshot(3000), plainTheme, opts);
  const text = lines.join("\n");
  assert.ok(text.includes("alice (local)"), text);
  assert.ok(text.includes("line one line two"), text);
});

test("renderLiveDebug: shows last sent", () => {
  const tel = createLiveTelemetry(() => 4000);
  tel.startSession();
  tel.recordSent("room:swarm", "room");
  const lines = renderLiveDebug(tel.snapshot(4000), plainTheme, opts);
  const text = lines.join("\n");
  assert.ok(text.includes("room:swarm"), text);
  assert.ok(text.includes("room"), text);
});

test("renderLiveDebug: shows broker and relay health", () => {
  const tel = createLiveTelemetry(() => 5000);
  tel.startSession();
  tel.recordBrokerOk("local");
  tel.recordBrokerError("sessions", new Error("sessions down"));
  tel.recordRelayOk();
  const lines = renderLiveDebug(tel.snapshot(5000), plainTheme, opts);
  const text = lines.join("\n");
  assert.ok(text.includes("broker health"), text);
  assert.ok(text.includes("local"), text);
  assert.ok(text.includes("sessions"), text);
  assert.ok(text.includes("err: sessions down"), text);
  assert.ok(text.includes("relay health"), text);
});

test("renderLiveDebug: shows spool and peer status counts", () => {
  const tel = createLiveTelemetry(() => 6000);
  tel.startSession();
  tel.recordSpoolCount(3);
  tel.recordPeerStatusCount(5);
  const lines = renderLiveDebug(tel.snapshot(6000), plainTheme, opts);
  const text = lines.join("\n");
  assert.ok(/spool\s+3/.test(text), text);
  assert.ok(/peer statuses\s+5/.test(text), text);
});

test("renderLiveDebug: handles empty telemetry gracefully", () => {
  const tel = createLiveTelemetry(() => 0);
  const lines = renderLiveDebug(tel.snapshot(0), plainTheme, {});
  const text = lines.join("\n");
  assert.ok(text.includes("(none)"), text);
  assert.ok(text.includes("last received"), text);
  assert.ok(text.includes("last sent"), text);
});
