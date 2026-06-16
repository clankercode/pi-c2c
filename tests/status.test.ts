/**
 * Unit tests for status-line formatting.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatStatus, renderPatchedStatus, type PiC2cBarState } from "../src/status.ts";

function makeFakeTheme(): Theme {
  return {
    fg: (color: string, text: string) => `[${color}:${text}]`,
  } as unknown as Theme;
}

function makeOriginal(): (color: string, text: string) => string {
  return (color, text) => `[${color}:${text}]`;
}

test("formatStatus: registered shows green dot and text alias", () => {
  const theme = makeFakeTheme();
  const result = formatStatus("pi-abc123", true, theme);
  assert.equal(result, "[success:●][text: pi-abc123]");
});

test("formatStatus: unregistered shows yellow dot and text alias", () => {
  const theme = makeFakeTheme();
  const result = formatStatus("pi-abc123", false, theme);
  assert.equal(result, "[warning:●][text: pi-abc123]");
});

test("formatStatus: unregistered with reason shows dim reason suffix", () => {
  const theme = makeFakeTheme();
  const result = formatStatus("pi-abc123", false, theme, "broker unreachable");
  assert.equal(result, "[warning:●][text: pi-abc123][muted: (broker unreachable)]");
});

test("formatStatus: registered ignores any reason argument", () => {
  const theme = makeFakeTheme();
  const result = formatStatus("pi-abc123", true, theme, "stale reason");
  assert.equal(result, "[success:●][text: pi-abc123]");
});

test("renderPatchedStatus: ignores non-text colors", () => {
  const state: PiC2cBarState = { alias: "pi-abc123", registered: true };
  const result = renderPatchedStatus("success", "c2c:pi-abc123", state, makeOriginal());
  assert.equal(result, undefined);
});

test("renderPatchedStatus: registered c2c status renders one green dot + alias", () => {
  const state: PiC2cBarState = { alias: "pi-abc123", registered: true };
  const result = renderPatchedStatus("text", "c2c:pi-abc123", state, makeOriginal());
  assert.equal(result, "[success:●] [text:pi-abc123]");
});

test("renderPatchedStatus: unregistered c2c status renders one yellow dot + alias", () => {
  const state: PiC2cBarState = { alias: "pi-abc123", registered: false };
  const result = renderPatchedStatus("text", "c2c:pi-abc123", state, makeOriginal());
  assert.equal(result, "[warning:●] [text:pi-abc123]");
});

test("renderPatchedStatus: unregistered with reason appends dim (reason) suffix", () => {
  const state: PiC2cBarState = { alias: "pi-abc123", registered: false, reason: "broker unreachable" };
  const result = renderPatchedStatus("text", "c2c:pi-abc123", state, makeOriginal());
  assert.equal(result, "[warning:●] [text:pi-abc123][muted: (broker unreachable)]");
});

test("renderPatchedStatus: registered ignores any reason", () => {
  const state: PiC2cBarState = { alias: "pi-abc123", registered: true, reason: "should be ignored" };
  const result = renderPatchedStatus("text", "c2c:pi-abc123", state, makeOriginal());
  assert.equal(result, "[success:●] [text:pi-abc123]");
});

test("renderPatchedStatus: strips a leftover bullet from the value", () => {
  const state: PiC2cBarState = { alias: "pi-abc123", registered: true };
  const result = renderPatchedStatus("text", "c2c:● pi-abc123", state, makeOriginal());
  assert.equal(result, "[success:●] [text:pi-abc123]");
});

test("renderPatchedStatus: strips multiple leftover bullets", () => {
  const state: PiC2cBarState = { alias: "pi-abc123", registered: true };
  const result = renderPatchedStatus("text", "c2c:●●● pi-abc123", state, makeOriginal());
  assert.equal(result, "[success:●] [text:pi-abc123]");
});

test("renderPatchedStatus: unknown state defaults to unregistered", () => {
  const result = renderPatchedStatus("text", "c2c:pi-abc123", undefined, makeOriginal());
  assert.equal(result, "[warning:●] [text:pi-abc123]");
});
