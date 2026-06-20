/**
 * Tests for pi-powerline-footer support.
 *
 * pi-powerline-footer (https://github.com/nicobailon/pi-powerline-footer) is a
 * config-driven powerline status bar. Unlike pi-bar it does NOT strip embedded
 * ANSI from an extension's status value, and it does NOT prepend a `key:`
 * prefix. It reads the raw `ctx.ui.setStatus(key, value)` text and renders it
 * either in the aggregate `extension_statuses` segment or, when promoted via a
 * `powerline.customItems` entry, in a dedicated segment.
 *
 * Two consequences pi-c2c must hold:
 *
 *  1. The default `formatStatus()` output (colored `●` + alias) already
 *     survives powerline's value normalization with color + glyph intact, so it
 *     renders correctly in the aggregate segment. These tests pin that contract
 *     using a faithful copy of powerline's normalization regex so a future
 *     change to `formatStatus` that breaks powerline rendering is caught here.
 *
 *  2. The pi-bar `Theme.prototype.fg` re-colorization patch must NOT misfire on
 *     a powerline-stored value (which starts with the glyph, not `c2c:`), so the
 *     two footers can coexist.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  formatStatus,
  renderPatchedStatus,
  type PiC2cBarState,
} from "../src/status.ts";

// ── powerline-footer contract (verbatim copies of its public behavior) ──────
//
// Faithful copy of pi-powerline-footer/powerline-config.ts. We copy rather than
// import because the upstream module pulls in `@earendil-works/pi-tui` which is
// not a dependency of this repo's test runner. Keep these in sync with upstream
// (powerline-config.ts: normalizeExtensionStatusValue / normalizeCompactExtensionStatus).

function visibleWidth(s: string): number {
  // ANSI-stripped length; good enough for the single-glyph + ASCII alias case.
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}
function isNotificationExtensionStatus(value: string): boolean {
  return value.trimStart().startsWith("[");
}
function plNormalizeValue(value: string): string | null {
  if (!value || visibleWidth(value) <= 0) return null;
  const stripped = value.replace(/(\x1b\[[0-9;]*m|\s|·|[|])+$/, "");
  return visibleWidth(stripped) > 0 ? stripped : null;
}
function plNormalizeCompact(value: string): string | null {
  if (isNotificationExtensionStatus(value)) return null;
  return plNormalizeValue(value);
}

// A theme whose `fg` emits real ANSI, like the production pi Theme — powerline
// preserves these embedded codes rather than stripping them (the pi-bar case).
function makeAnsiTheme(): Theme {
  const codes: Record<string, string> = {
    success: "32",
    warning: "33",
    text: "37",
    muted: "90",
  };
  return {
    fg: (color: string, txt: string) => `\x1b[${codes[color] ?? "0"}m${txt}\x1b[0m`,
  } as unknown as Theme;
}

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

// ── aggregate segment: formatStatus survives powerline normalization ─────────

test("powerline aggregate: registered formatStatus keeps the green dot through normalization", () => {
  const theme = makeAnsiTheme();
  const value = formatStatus("pi-abc123", true, theme);
  const rendered = plNormalizeCompact(value);
  assert.notEqual(rendered, null, "powerline must keep the status (not treat it as a notification)");
  // The green dot's color code and glyph survive.
  assert.ok(rendered!.includes(`${GREEN}●`), "green dot ANSI + glyph preserved");
  // The alias text survives.
  assert.ok(rendered!.includes("pi-abc123"), "alias preserved");
  // Powerline only strips the trailing reset; the leading color is intact.
  assert.ok(rendered!.startsWith(GREEN), "leading color code intact");
});

test("powerline aggregate: unregistered formatStatus keeps the yellow dot + reason", () => {
  const theme = makeAnsiTheme();
  const value = formatStatus("pi-abc123", false, theme, "broker unreachable");
  const rendered = plNormalizeCompact(value);
  assert.notEqual(rendered, null);
  assert.ok(rendered!.includes(`${YELLOW}●`), "yellow dot ANSI + glyph preserved");
  assert.ok(rendered!.includes("pi-abc123"), "alias preserved");
  assert.ok(rendered!.includes("(broker unreachable)"), "reason preserved");
});

test("powerline aggregate: formatStatus is never classified as a notification status", () => {
  // Powerline hides values that start with '[' from the bar. The c2c status
  // starts with a colored glyph, so it must never be hidden.
  const theme = makeAnsiTheme();
  assert.equal(isNotificationExtensionStatus(formatStatus("a", true, theme)), false);
  assert.equal(isNotificationExtensionStatus(formatStatus("a", false, theme, "x")), false);
});

// ── coexistence: the pi-bar fg patch must not misfire under powerline ────────

test("coexistence: powerline-stored value does not trigger the pi-bar fg patch", () => {
  // Under powerline the stored value is formatStatus() output (starts with the
  // glyph), NOT pi-bar's "c2c:<value>" form. renderPatchedStatus keys on the
  // "c2c:" prefix, so it must return undefined (no re-colorization).
  const original = (c: string, t: string) => `[${c}:${t}]`;
  const state: PiC2cBarState = { alias: "pi-abc123", registered: true };
  const theme = makeAnsiTheme();
  const value = formatStatus("pi-abc123", true, theme);
  assert.equal(renderPatchedStatus("text", value, state, original), undefined);
});
