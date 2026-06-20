/**
 * Status-line formatting for pi-c2c.
 *
 * Pure helper that turns the c2c registration state into a short, colored
 * string for `ctx.ui.setStatus()`.
 *
 * Three footers, three rendering contracts:
 *
 *  - **Default pi footer** preserves ANSI colors, so `formatStatus()` emits a
 *    small colored dot (`theme.fg`).
 *
 *  - **pi-bar / tm-bar** strip ANSI from extension status values and prepend a
 *    `c2c:` key, so we monkeypatch the shared theme singleton in `index.ts`
 *    (`installStatusColorPatch`) to re-colorize the c2c status when it sees the
 *    "c2c:" prefix.
 *
 *  - **pi-powerline-footer** does NOT strip embedded ANSI and does NOT prepend
 *    a `key:` prefix — it renders the raw `setStatus` value (stripping only
 *    trailing whitespace/separators). So `formatStatus()` already renders in
 *    color + glyph in powerline's aggregate `extension_statuses` segment — and
 *    in an optional dedicated `powerline.customItems` segment keyed on the
 *    `c2c` status — with no patch needed, and the `c2c:`-keyed fg patch never
 *    fires on it. See README "Footer support".
 */

import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";

/** Liveness glyph used in the c2c status indicator. */
const INDICATOR = "●";

/**
 * Build the colored status text shown in pi's default status bar.
 *
 * Registered peers get a green dot; unregistered/failed registration gets a
 * yellow dot. The alias is shown in the default text color. When unregistered,
 * a short reason (if known) is appended in dim text so the user can see WHY
 * the bar is yellow without opening the tools panel.
 *
 * This output also renders correctly in pi-powerline-footer's aggregate
 * `extension_statuses` segment: powerline preserves the embedded ANSI rather
 * than stripping it (unlike pi-bar), so the color + glyph survive verbatim.
 */
export function formatStatus(
  alias: string,
  registered: boolean,
  theme: Theme,
  reason?: string,
): string {
  const indicator = registered
    ? theme.fg("success", INDICATOR)
    : theme.fg("warning", INDICATOR);
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
