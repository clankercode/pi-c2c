/**
 * Status-line formatting for pi-c2c.
 *
 * Pure helper that turns the c2c registration state into a short, colored
 * string for `ctx.ui.setStatus()`.
 *
 * The default pi footer preserves ANSI colors, so we emit a small colored dot
 * (`theme.fg`). Custom footers such as pi-bar strip ANSI from extension status
 * values before rendering, so we also monkeypatch the shared theme singleton
 * in `index.ts` to colorize the c2c status when it sees the "c2c:" prefix.
 */

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * Build the colored status text shown in pi's default status bar.
 *
 * Registered peers get a green dot; unregistered/failed registration gets a
 * yellow dot. The alias is shown in the default text color. When unregistered,
 * a short reason (if known) is appended in dim text so the user can see WHY
 * the bar is yellow without opening the tools panel.
 */
export function formatStatus(
  alias: string,
  registered: boolean,
  theme: Theme,
  reason?: string,
): string {
  const indicator = registered
    ? theme.fg("success", "●")
    : theme.fg("warning", "●");
  const aliasPart = theme.fg("text", ` ${alias}`);
  const reasonPart = !registered && reason
    ? theme.fg("muted", ` (${reason})`)
    : "";
  return `${indicator}${aliasPart}${reasonPart}`;
}

/** Shared global state read by the theme monkeypatch for custom footers. */
export interface PiC2cBarState {
  alias?: string;
  registered?: boolean;
  /** Short human-readable reason for the current registered state (e.g. "broker unreachable"). */
  reason?: string;
}

/** Colorize a c2c status rendered by a custom footer (e.g. pi-bar). */
export function renderPatchedStatus(
  color: ThemeColor,
  text: string,
  state: PiC2cBarState | undefined,
  original: (color: ThemeColor, text: string) => string,
): string | undefined {
  if (color !== "text") return undefined;

  if (text.startsWith("c2c:")) {
    // pi-bar strips ANSI from the value then renders "c2c:<value>" wrapped in
    // theme.fg("text", ...). Strip any leading bullet the default footer value
    // may have contributed, then render exactly one colored bullet.
    const alias = text.slice(4).trim().replace(/^●+\s*/, "");
    const registered = state?.registered ?? false;
    const reason = !registered && state?.reason ? ` (${state.reason})` : "";
    return `${original(registered ? "success" : "warning", "●")} ${original("text", alias)}${reason ? original("muted", reason) : ""}`;
  }

  return undefined;
}

/**
 * Install a one-time monkeypatch on the shared theme singleton so custom
 * footers (e.g. pi-bar) that strip ANSI from extension status values can still
 * render the c2c indicator in color.
 *
 * pi-bar renders extension statuses as `key:value` then calls
 * `theme.fg("text", ...)`. We intercept that call and colorize it.
 */
export function installStatusColorPatch(theme: Theme, getState: () => PiC2cBarState | undefined): void {
  const patchedKey = "__piC2cStatusFgPatched";
  const g = globalThis as Record<string, unknown>;
  if (g[patchedKey]) return;
  g[patchedKey] = true;

  // Patch the Theme prototype so the interceptor survives even if a custom
  // footer imported the theme singleton before our instance patch ran.
  // CRITICAL: the original method must be called with its original `this`
  // (the Theme instance), not bound to the prototype, because it accesses
  // private fields via `this`.
  const original = Theme.prototype.fg;
  Theme.prototype.fg = function (this: Theme, color: ThemeColor, text: string) {
    const patched = renderPatchedStatus(color, text, getState(), (c, t) => original.call(this, c, t));
    if (patched !== undefined) return patched;
    return original.call(this, color, text);
  };

  // Avoid unused parameter warning.
  void theme;
}
