/**
 * Compact TUI message renderer for pi-c2c delivered messages.
 *
 * Collapses one or more inbound c2c envelopes into a single line:
 *   ⧓ c2c.recv · ▼◎ ← lyra-quill · build finished
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
import { parseRelayAlias } from "../relay.ts";
import { parseStatusEnvelope, type StatusEnvelope } from "../status-sync.ts";

/** Structured metadata passed in `sendMessage(...).details`. */
export interface C2cDeliveryDetails {
  /** Number of c2c messages bundled in this delivery. */
  count: number;
  /** Unique sender aliases present in this delivery (first-seen order). */
  senders: string[];
  /** Alias of the receiving session, used to distinguish outgoing/broadcast. */
  selfAlias?: string;
  /** Which broker tier produced this batch. When known, the renderer uses
   *  this instead of guessing the route from the sender alias. */
  source?: "local" | "sessions" | "relay";
}

const KIND = "c2c";

/** Glyph vocabulary for c2c message lines. */
const GLYPHS = {
  incoming: "▼",
  outgoing: "▲",
  broadcast: "✶",
  status: "●",
  arrowLeft: "←",
  arrowRight: "→",
} as const;

/** Route glyphs for the source broker/channel. */
const ROUTES = {
  local: "⌂",
  sessions: "◎",
  relay: "⇄",
  // Route could not be determined from the message alone (e.g. an inbound bare
  // alias with no `@<host>` suffix). Distinct from `sessions` so an optimistic
  // guess is no longer conflated with genuine sessions delivery.
  unknown: "◌",
} as const;

/** ASCII fallbacks when terminal Unicode support is uncertain. */
const ASCII_GLYPHS = {
  incoming: "v",
  outgoing: "^",
  broadcast: "*",
  status: "o",
  arrowLeft: "<-",
  arrowRight: "->",
} as const;

const ASCII_ROUTES = {
  local: "[local]",
  sessions: "[sessions]",
  relay: "[relay]",
  unknown: "[?]",
} as const;

/** Detect whether we should use ASCII fallbacks.
 *  Honours a manual `PI_C2C_ASCII=1` override; otherwise uses Unicode. */
function useAsciiGlyphs(): boolean {
  return process.env.PI_C2C_ASCII === "1";
}

/** Pick a route glyph for a sender alias. When a broker source hint is
 *  available (from the drain path), use it directly — it's more reliable than
 *  guessing from the alias shape. Relay aliases end with `@<hash>`; otherwise
 *  we report `unknown` rather than optimistically claiming sessions delivery. */
function routeForAlias(alias: string, source?: "local" | "sessions" | "relay"): keyof typeof ROUTES {
  if (source === "local") return "local";
  if (source === "sessions") return "sessions";
  if (source === "relay") return "relay";
  if (parseRelayAlias(alias)) return "relay";
  return "unknown";
}

/** Direction arrow for compact message headers. */
function arrowGlyph(direction: "incoming" | "outgoing" | "broadcast" | "status"): string {
  const ascii = useAsciiGlyphs();
  switch (direction) {
    case "incoming":
      return ascii ? ASCII_GLYPHS.arrowLeft : GLYPHS.arrowLeft;
    case "outgoing":
      return ascii ? ASCII_GLYPHS.arrowRight : GLYPHS.arrowRight;
    default:
      return "";
  }
}

/** `c2c.<action>` token for delivered message lines. */
function messageAction(direction: "incoming" | "outgoing" | "broadcast" | "status"): string {
  switch (direction) {
    case "incoming":
      return "recv";
    case "outgoing":
      return "send";
    case "broadcast":
      return "recv-all";
    case "status":
      return "status";
  }
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

  // Route gets a distinct color so ⌂/◎/⇄/◌ are scannable at a glance.
  // local=success (green, "your home broker"),
  // sessions=borderMuted (grey, the in-the-swarm default),
  // relay=accent (cyan, "this is the cross-machine one"),
  // unknown=borderMuted (grey, "couldn't determine the route") — same grey as
  // sessions but a hollow ◌ glyph distinguishes the can't-tell case.
  const routeColor: import("@earendil-works/pi-coding-agent").ThemeColor =
    route === "local" ? "success" :
    route === "relay" ? "accent" :
    "borderMuted";

  return `${theme.fg(dirColor, dirGlyph)}${theme.fg(routeColor, routeGlyph)}`;
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
  const route = routeForAlias(primarySender, details?.source);

  const prefix = buildPrefix(direction, route, theme);
  const arrow = arrowGlyph(direction);
  const arrowSpacer = arrow ? theme.fg("success", ` ${arrow} `) : " ";
  const action = messageAction(direction);
  const header = " " + theme.fg("accent", `⧓ c2c.${action}`) + theme.fg("borderMuted", " · ") + prefix + arrowSpacer;

  const bodyParts: string[] = [];
  if (count <= 1) {
    bodyParts.push(theme.fg("accent", `${primarySender}`));
  } else {
    bodyParts.push(theme.fg("accent", `${count} messages`));
    if (senders.length > 0) {
      bodyParts.push(theme.fg("muted", `from ${senders.join(", ")}`));
    }
  }

  if (snippet.length > 0) {
    // Snippet brightness tracks direction: incoming = gray tool output
    // (matching expanded bodies), outgoing = dim (I know what I sent),
    // status = muted (just state info, not the message body).
    const snippetColor =
      primary?.event === "status"
        ? "muted"
        : direction === "outgoing"
          ? "dim"
          : "toolOutput";
    bodyParts.push(theme.fg(snippetColor, snippet));
  }

  const ellipsis = theme.fg("toolOutput", useAsciiGlyphs() ? "..." : "…");
  return truncateToWidth(header + bodyParts.join(theme.fg("borderMuted", " · ")), width, ellipsis);
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
  const route = routeForAlias(primarySender, details?.source);
  const prefix = buildPrefix(direction, route, theme);
  const arrow = arrowGlyph(direction);
  const arrowSpacer = arrow ? theme.fg("success", ` ${arrow} `) : " ";
  const action = messageAction(direction);
  const headerPrefix = theme.fg("accent", `⧓ c2c.${action}`) + theme.fg("borderMuted", " · ") + prefix + arrowSpacer;
  const header = count <= 1
    ? primary?.event === "status"
      ? headerPrefix + theme.fg("muted", "status from ") + theme.fg("accent", primarySender)
      : headerPrefix + theme.fg("accent", primarySender)
    : headerPrefix + theme.fg("accent", `${count} messages`);

  const container = new Container();
  container.addChild(new Text(header, 1, 0));
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
