/**
 * Live debug dashboard for pi-c2c.
 *
 * Opens as a full-screen custom TUI component via `/c2c-live-debug`. It
 * renders a continuously updating view of runtime telemetry: connection
 * state, poll timing, message traffic, broker/relay health, spool state,
 * and peer status counts.
 */

import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  formatDuration,
  formatTimestamp,
  type LiveTelemetry,
  type LiveTelemetrySnapshot,
} from "../telemetry.ts";

export interface LiveDebugComponentOptions {
  identity?: { alias: string; sessionId: string } | null;
  registered?: boolean;
  relayRegistered?: boolean;
  relayAddress?: string;
  crossRepoEnabled?: boolean;
  crossRepoSessionsRegistered?: boolean;
  pollIntervalMs?: number;
}

const KEY_WIDTH = 18;

function padKey(key: string): string {
  return key.padEnd(KEY_WIDTH, " ");
}

function line(theme: Theme, label: string, value: string, valueColor?: import("@earendil-works/pi-coding-agent").ThemeColor): string {
  const prefix = `${padKey(label)}`;
  const coloredValue = valueColor ? theme.fg(valueColor, value) : value;
  return `${prefix} ${coloredValue}`;
}

function colorForAge(ageMs: number | undefined): import("@earendil-works/pi-coding-agent").ThemeColor {
  if (ageMs === undefined) return "muted";
  if (ageMs < 30_000) return "success";
  if (ageMs < 120_000) return "warning";
  return "error";
}

function colorForBoolean(value: boolean): import("@earendil-works/pi-coding-agent").ThemeColor {
  return value ? "success" : "error";
}

function safeWrap(text: string, width: number): string[] {
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const chunk = truncateToWidth(remaining, width);
    out.push(chunk);
    const consumed = visibleWidth(chunk);
    remaining = remaining.slice(consumed);
    if (consumed === 0) break;
  }
  return out;
}

/** Render the telemetry snapshot into dashboard lines. */
export function renderLiveDebug(
  snapshot: LiveTelemetrySnapshot,
  theme: Theme,
  opts: LiveDebugComponentOptions,
): string[] {
  const { now } = snapshot;
  const lines: string[] = [];

  const alias = opts.identity?.alias ?? "(none)";
  const sessionId = opts.identity?.sessionId ?? "(none)";

  lines.push(theme.fg("accent", "  c2c live debug"));
  lines.push(theme.fg("borderMuted", "  ") + "─".repeat(34));

  lines.push(line(theme, "alias", alias, "accent"));
  lines.push(line(theme, "session", sessionId, "muted"));
  lines.push(
    line(
      theme,
      "registered",
      opts.registered ? "yes" : "no",
      colorForBoolean(opts.registered ?? false),
    ),
  );
  lines.push(
    line(
      theme,
      "cross-repo",
      opts.crossRepoEnabled
        ? opts.crossRepoSessionsRegistered
          ? "connected"
          : "not connected"
        : "disabled",
      opts.crossRepoEnabled
        ? opts.crossRepoSessionsRegistered
          ? "success"
          : "warning"
        : "muted",
    ),
  );
  lines.push(
    line(
      theme,
      "relay",
      opts.relayRegistered ? `connected (${opts.relayAddress ?? ""})` : "not connected",
      opts.relayRegistered ? "success" : "muted",
    ),
  );

  const uptime =
    snapshot.sessionStartAt === undefined
      ? "—"
      : formatDuration(now - snapshot.sessionStartAt);
  lines.push(line(theme, "uptime", uptime));
  lines.push(line(theme, "poll interval", `${opts.pollIntervalMs ?? 5000}ms`));

  lines.push("");
  lines.push(theme.fg("accent", "  poll"));

  lines.push(line(theme, "poll count", String(snapshot.pollCount)));
  const lastPollAge = snapshot.lastPollAt === undefined ? undefined : now - snapshot.lastPollAt;
  lines.push(
    line(
      theme,
      "last poll",
      `${formatTimestamp(snapshot.lastPollAt, now)} (${formatDuration(snapshot.lastPollDurationMs)})`,
      colorForAge(lastPollAge),
    ),
  );

  lines.push("");
  lines.push(theme.fg("accent", "  traffic"));

  lines.push(line(theme, "received", String(snapshot.messagesReceived)));
  lines.push(line(theme, "injected", String(snapshot.messagesInjected)));
  lines.push(line(theme, "sent", String(snapshot.messagesSent)));

  lines.push("");
  lines.push(theme.fg("accent", "  last received"));

  if (snapshot.lastReceived) {
    const age = now - snapshot.lastReceived.at;
    lines.push(
      line(
        theme,
        "from",
        `${snapshot.lastReceived.from} (${snapshot.lastReceived.source})`,
        "accent",
      ),
    );
    lines.push(line(theme, "when", formatTimestamp(snapshot.lastReceived.at, now), colorForAge(age)));
    lines.push(line(theme, "preview", ""));
    for (const wrapped of safeWrap(snapshot.lastReceived.preview, 60)) {
      lines.push(`  ${theme.fg("text", wrapped)}`);
    }
  } else {
    lines.push(line(theme, "from", "—", "muted"));
    lines.push(line(theme, "when", "—", "muted"));
    lines.push(line(theme, "preview", "—", "muted"));
  }

  lines.push("");
  lines.push(theme.fg("accent", "  last sent"));

  if (snapshot.lastSent) {
    const age = now - snapshot.lastSent.at;
    lines.push(line(theme, "to", snapshot.lastSent.to, "accent"));
    lines.push(line(theme, "via", snapshot.lastSent.via, "muted"));
    lines.push(line(theme, "when", formatTimestamp(snapshot.lastSent.at, now), colorForAge(age)));
  } else {
    lines.push(line(theme, "to", "—", "muted"));
    lines.push(line(theme, "via", "—", "muted"));
    lines.push(line(theme, "when", "—", "muted"));
  }

  lines.push("");
  lines.push(theme.fg("accent", "  broker health"));

  const brokerSources = Object.keys(snapshot.brokerHealth).sort();
  if (brokerSources.length === 0) {
    lines.push(line(theme, "(none)", "", "muted"));
  }
  for (const source of brokerSources) {
    const h = snapshot.brokerHealth[source];
    const lastOkAge = h.lastOkAt === undefined ? undefined : now - h.lastOkAt;
    lines.push(
      line(
        theme,
        source,
        h.lastOkAt === undefined ? "never" : `${formatTimestamp(h.lastOkAt, now)}`,
        colorForAge(lastOkAge),
      ),
    );
    if (h.lastError) {
      lines.push(`  ${theme.fg("error", `err: ${h.lastError}`)}`);
    }
  }

  lines.push("");
  lines.push(theme.fg("accent", "  relay health"));

  const relayOkAge =
    snapshot.relayHealth.lastOkAt === undefined ? undefined : now - snapshot.relayHealth.lastOkAt;
  lines.push(
    line(
      theme,
      "last ok",
      formatTimestamp(snapshot.relayHealth.lastOkAt, now),
      colorForAge(relayOkAge),
    ),
  );
  if (snapshot.relayHealth.lastError) {
    lines.push(
      line(
        theme,
        "last error",
        `${formatTimestamp(snapshot.relayHealth.lastErrorAt, now)}: ${snapshot.relayHealth.lastError}`,
        "error",
      ),
    );
  }

  lines.push("");
  lines.push(theme.fg("accent", "  other"));

  lines.push(line(theme, "spool", String(snapshot.spoolCount)));
  lines.push(line(theme, "peer statuses", String(snapshot.peerStatusCount)));
  const injectAge =
    snapshot.lastInjectAt === undefined ? undefined : now - snapshot.lastInjectAt;
  lines.push(
    line(
      theme,
      "last inject",
      formatTimestamp(snapshot.lastInjectAt, now),
      colorForAge(injectAge),
    ),
  );
  if (snapshot.lastError) {
    lines.push(
      line(
        theme,
        "last error",
        `${formatTimestamp(snapshot.lastErrorAt, now)}: ${snapshot.lastError}`,
        "error",
      ),
    );
  }

  return lines.map((l) => truncateToWidth(l, 80));
}

/** TUI component wrapper that re-reads telemetry on every render. */
export class LiveDebugComponent implements Component {
  constructor(
    private readonly telemetry: LiveTelemetry,
    private readonly theme: Theme,
    private readonly opts: LiveDebugComponentOptions,
  ) {}

  render(_width: number): string[] {
    return renderLiveDebug(this.telemetry.snapshot(), this.theme, this.opts);
  }

  handleInput(_data: string): void {
    // No keyboard interaction for the dashboard.
  }

  invalidate(): void {
    // Stateless re-render: telemetry is read fresh each frame.
  }
}

/** Create a live debug component bound to a telemetry store. */
export function createLiveDebugComponent(
  telemetry: LiveTelemetry,
  theme: Theme,
  opts: LiveDebugComponentOptions,
): Component {
  return new LiveDebugComponent(telemetry, theme, opts);
}
