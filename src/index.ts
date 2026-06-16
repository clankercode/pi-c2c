/**
 * pi-c2c — native c2c integration for the pi coding agent.
 *
 * c2c (https://github.com/anomalyco/c2c) is a peer-to-peer messaging broker
 * between AI coding sessions. This extension makes a pi session a first-class
 * c2c peer: it registers an identity on startup, exposes c2c send/list/room
 * tools + slash commands, and runs a background poller that delivers inbound
 * messages straight into pi's transcript via `pi.sendMessage` — real
 * auto-delivery, no manual polling.
 *
 * Integration is CLI-based: the extension shells out to the `c2c` binary with
 * `--json` (the same pattern as the c2c OpenCode plugin). No c2c-side changes
 * are required; identity is self-registered per session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PI_C2C_VERSION = "0.1.0";

export default function c2cExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    // Slices S2+ wire identity registration and the delivery poller here.
    ctx.ui.setStatus("c2c", "c2c");
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("c2c", undefined);
  });

  pi.registerCommand("c2c-status", {
    description: "Show pi-c2c extension status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`pi-c2c v${PI_C2C_VERSION} loaded`, "info");
    },
  });
}
