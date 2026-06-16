/**
 * Compact TUI message renderer for pi-c2c delivered messages.
 *
 * Collapses one or more inbound c2c envelopes into a single line:
 *   ◈ c2c · lyra-quill: build finished
 * Expands to show each message as `from_alias: body` so the full payload is
 * available on demand.
 *
 * The model still receives the raw `<c2c event="message" ...>` envelopes in
 * `content` (cross-client parity with the c2c OpenCode plugin). This renderer
 * only reshapes that content for human display.
 */
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { parseStatusEnvelope, type StatusEnvelope } from "../status-sync.ts";

/** Structured metadata passed in `sendMessage(...).details`. */
export interface C2cDeliveryDetails {
  /** Number of c2c messages bundled in this delivery. */
  count: number;
  /** Unique sender aliases present in this delivery (first-seen order). */
  senders: string[];
  /** Alias of the receiving session, used to distinguish outgoing/broadcast. */
  selfAlias?: string;
}

const KIND = "c2c";

/** Glyph vocabulary for c2c message lines. */
const GLYPHS = {
  incoming: "▼",
  outgoing: "▲",
  broadcast: "✶",
  status: "●",
} as const;

/** Route glyphs for the source broker/channel. */
const ROUTES = {
  local: "⌂",
  sessions: "◎",
  relay: "⇄",
} as const;

/** ASCII fallbacks when terminal Unicode support is uncertain. */
const ASCII_GLYPHS = {
  incoming: "v",
  outgoing: "^",
  broadcast: "*",
  status: "o",
} as const;

const ASCII_ROUTES = {
  local: "[local]",
  sessions: "[sessions]",
  relay: "[relay]",
} as const;

/** Detect whether we should use ASCII fallbacks.
 *  Honours a manual `PI_C2C_ASCII=1` override; otherwise uses Unicode. */
function useAsciiGlyphs(): boolean {
  return process.env.PI_C2C_ASCII === "1";
}

/** Pick a route glyph for a sender alias. Relay aliases end with `#<hash>`;
 *  otherwise we can't know the broker from the message alone, so we default
 *  to the cross-repo sessions route for non-local-looking aliases. */
function routeForAlias(alias: string): keyof typeof ROUTES {
  if (alias.includes("#")) return "relay";
  return "sessions";
}

/** Build the colored prefix for a c2c message line. */
function buildPrefix(
  direction: "incoming" | "outgoing" | "broadcast" | "status",
  route: keyof typeof ROUTES,
  theme: Theme,
): string {
  const ascii = useAsciiGlyphs();
  const dirGlyph = ascii ? ASCII_GLYPHS[direction] : GLYPHS[direction];
  const routeGlyph = ascii ? ASCII_ROUTES[route] : ROUTES[route];

  let dirColor: import("@earendil-works/pi-coding-agent").ThemeColor;
  switch (direction) {
    case "incoming":
      dirColor = "success";
      break;
    case "outgoing":
      dirColor = "accent";
      break;
    case "broadcast":
      dirColor = "warning";
      break;
    case "status":
      dirColor = "borderMuted";
      break;
  }

  // Route gets a distinct color so ⌂/◎/⇄ are scannable at a glance.
  // local=success (green, "your home broker"),
  // sessions=borderMuted (grey, the in-the-swarm default),
  // relay=accent (cyan, "this is the cross-machine one").
  const routeColor: import("@earendil-works/pi-coding-agent").ThemeColor =
    route === "local" ? "success" :
    route === "relay" ? "accent" :
    "borderMuted";

  return `${theme.fg(dirColor, dirGlyph)}${theme.fg(routeColor, routeGlyph)} `;
}

interface MessageLike<T> {
  content: string | unknown[];
  details?: T;
}

/** A single c2c envelope parsed from the model-facing content string. */
export interface ParsedEnvelope {
  from: string;
  body: string;
  event: "message" | "status";
  status?: StatusEnvelope;
}

/**
 * Extract `<c2c ...>...</c2c>` envelopes from the raw content.
 * Tolerant: if no envelopes are found, the whole content is treated as a
 * single message from a generic sender so the renderer never renders nothing.
 */
export function parseC2cEnvelopes(content: string): ParsedEnvelope[] {
  const out: ParsedEnvelope[] = [];
  const re = /<c2c\b[^>]*?\sfrom="([^"]*)"[^>]*>([\s\S]*?)<\/c2c>/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(content)) !== null) {
    const eventAttr = match[0].match(/\bevent="([^"]*)"/)?.[1] ?? "message";
    const body = match[2].replace(/^\n+|\n+$/g, "");

    // If a normal message envelope carries a self-contained status envelope
    // as its body (how status broadcasts are delivered from the broker),
    // unwrap it so the renderer treats it as a status update rather than a
    // message containing XML.
    const embeddedStatus = eventAttr === "message" ? parseStatusEnvelope(body) : null;
    if (embeddedStatus) {
      out.push({
        from: embeddedStatus.from,
        body: `status=${embeddedStatus.state}`,
        event: "status",
        status: embeddedStatus,
      });
      continue;
    }

    out.push({ from: match[1], body, event: eventAttr as "message" | "status" });
  }

  if (out.length === 0 && content.trim().length > 0) {
    // Last chance: maybe the content is a bare status envelope (self-closing,
    // so the previous regex did not match it).
    const bareStatus = parseStatusEnvelope(content.trim());
    if (bareStatus) {
      out.push({
        from: bareStatus.from,
        body: `status=${bareStatus.state}`,
        event: "status",
        status: bareStatus,
      });
    } else {
      out.push({ from: "c2c", body: content.trim(), event: "message" });
    }
  }
  return out;
}

/** Pick the first non-empty line and collapse whitespace for a one-line snippet. */
function firstSnippet(body: string): string {
  const firstLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";
  return firstLine.replace(/\s+/g, " ").trim();
}

function buildStatusLine(envelope: ParsedEnvelope): string {
  const state = envelope.status?.state ?? "unknown";
  return `is ${state}`;
}

/** Color for a status state. Scannable: idle=green, processing=yellow,
 *  tool/input=accent (active), unknown=muted. */
function colorForStatusState(
  state: string | undefined,
): import("@earendil-works/pi-coding-agent").ThemeColor {
  switch (state) {
    case "idle":
      return "success";
    case "processing":
      return "warning";
    case "tool":
    case "input":
      return "accent";
    default:
      return "muted";
  }
}

/** Build the single-line collapsed representation. */
export function buildCompactLine(
  message: MessageLike<C2cDeliveryDetails>,
  theme: Theme,
  width: number,
  selfAlias?: string,
): string {
  const content = typeof message.content === "string" ? message.content : "";
  const envelopes = parseC2cEnvelopes(content);
  const details = message.details;

  const count = details?.count ?? envelopes.length;
  const senders = details?.senders ?? envelopes.map((e) => e.from);
  const primarySender = senders[0] ?? "c2c";
  const primary = envelopes[0];
  const snippet = primary?.event === "status"
    ? buildStatusLine(primary)
    : firstSnippet(primary?.body ?? content);

  const me = selfAlias ?? message.details?.selfAlias;
  const direction: "incoming" | "outgoing" | "broadcast" | "status" = primary?.event === "status"
    ? "status"
    : primarySender === me
      ? "outgoing"
      : "incoming";
  const route = routeForAlias(primarySender);

  const parts: string[] = [];
  parts.push(" " + buildPrefix(direction, route, theme));

  if (count <= 1) {
    // Primary sender in accent so it pops; status state carries its own
    // semantic color in the snippet below.
    if (primary?.event === "status") {
      parts.push(theme.fg("accent", `${primarySender}`));
    } else {
      parts.push(theme.fg("accent", `${primarySender}`));
    }
  } else {
    parts.push(theme.fg("accent", `${count} messages`));
    if (senders.length > 0) {
      parts.push(theme.fg("muted", `from ${senders.join(", ")}`));
    }
  }

  if (snippet.length > 0) {
    // Snippet brightness tracks direction: incoming = full brightness
    // (I want to read it), outgoing = dim (I know what I sent),
    // status = muted (just state info, not the message body).
    const snippetColor =
      primary?.event === "status"
        ? "muted"
        : direction === "outgoing"
          ? "dim"
          : "text";
    parts.push(theme.fg(snippetColor, snippet));
  }

  return truncateToWidth(parts.join(theme.fg("borderMuted", " · ")), width);
}

/** Build the expanded multi-line representation. */
export function buildExpandedComponent(
  message: MessageLike<C2cDeliveryDetails>,
  theme: Theme,
  selfAlias?: string,
): Component {
  const content = typeof message.content === "string" ? message.content : "";
  const envelopes = parseC2cEnvelopes(content);
  const details = message.details;

  const count = details?.count ?? envelopes.length;
  const senders = details?.senders ?? envelopes.map((e) => e.from);

  const me = selfAlias ?? message.details?.selfAlias;
  const primary = envelopes[0];
  const primarySender = senders[0] ?? "c2c";
  const direction: "incoming" | "outgoing" | "broadcast" | "status" = primary?.event === "status"
    ? "status"
    : primarySender === me
      ? "outgoing"
      : "incoming";
  const route = routeForAlias(primarySender);
  const prefix = buildPrefix(direction, route, theme);
  const header = count <= 1
    ? primary?.event === "status"
      ? `${prefix}${KIND} · status from ${primarySender}`
      : `${prefix}${KIND} · message from ${primarySender}`
    : `${prefix}${KIND} · ${count} messages`;

  const container = new Container();
  container.addChild(new Text(theme.fg("accent", header), 1, 0));
  container.addChild(new Spacer(1));

  for (const envelope of envelopes) {
    if (envelope.from) {
      if (envelope.event === "status" && envelope.status) {
        const stateColor = colorForStatusState(envelope.status.state);
        const statusLine = `${envelope.from}: state=${envelope.status.state} since=${envelope.status.since} ttl_ms=${envelope.status.ttl_ms}`;
        // `from:` in accent, state in semantic color so the eye lands on
        // the actionable bit (idle vs processing vs tool).
        container.addChild(
          new Text(`${theme.fg("accent", `${envelope.from}:`)} ${theme.fg(stateColor, `state=${envelope.status.state}`)} ${theme.fg("muted", `since=${envelope.status.since} ttl_ms=${envelope.status.ttl_ms}`)}`, 1, 0),
        );
      } else {
        container.addChild(new Text(theme.fg("accent", `${envelope.from}:`), 1, 0));
        container.addChild(new Text(theme.fg("toolOutput", envelope.body), 1, 0));
      }
    }
    container.addChild(new Spacer(1));
  }

  return container;
}

/** Component wrapper that caches render output per width. */
export class CompactC2cMessage implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly message: MessageLike<C2cDeliveryDetails>,
    private readonly expanded: boolean,
    private readonly theme: Theme,
    private readonly selfAlias?: string,
  ) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    this.cachedLines = this.expanded
      ? buildExpandedComponent(this.message, this.theme, this.selfAlias).render(width)
      : [buildCompactLine(this.message, this.theme, width, this.selfAlias)];
    this.cachedWidth = width;
    return this.cachedLines;
  }

  handleInput(_data: string): void {
    // No interactive input on the collapsed/expanded message.
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/** Register the compact c2c message renderer on an ExtensionAPI. */
export function registerC2cMessageRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<C2cDeliveryDetails>(KIND, (message, { expanded }, theme) => {
    const selfAlias = message.details?.selfAlias;
    return new CompactC2cMessage(message, expanded, theme, selfAlias);
  });
}
