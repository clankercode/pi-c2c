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

/** Structured metadata passed in `sendMessage(...).details`. */
export interface C2cDeliveryDetails {
  /** Number of c2c messages bundled in this delivery. */
  count: number;
  /** Unique sender aliases present in this delivery (first-seen order). */
  senders: string[];
}

const ICON = "◈";
const KIND = "c2c";

interface MessageLike<T> {
  content: string | unknown[];
  details?: T;
}

/** A single c2c envelope parsed from the model-facing content string. */
export interface ParsedEnvelope {
  from: string;
  body: string;
}

/**
 * Extract `<c2c from="...">...</c2c>` envelopes from the raw content.
 * Tolerant: if no envelopes are found, the whole content is treated as a
 * single message from a generic sender so the renderer never renders nothing.
 */
export function parseC2cEnvelopes(content: string): ParsedEnvelope[] {
  const out: ParsedEnvelope[] = [];
  const re = /<c2c\b[^>]*?\sfrom="([^"]*)"[^>]*>([\s\S]*?)<\/c2c>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const body = match[2].replace(/^\n+|\n+$/g, "");
    out.push({ from: match[1], body });
  }
  if (out.length === 0 && content.trim().length > 0) {
    out.push({ from: "c2c", body: content.trim() });
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

/** Build the single-line collapsed representation. */
export function buildCompactLine(
  message: MessageLike<C2cDeliveryDetails>,
  theme: Theme,
  width: number,
): string {
  const content = typeof message.content === "string" ? message.content : "";
  const envelopes = parseC2cEnvelopes(content);
  const details = message.details;

  const count = details?.count ?? envelopes.length;
  const senders = details?.senders ?? envelopes.map((e) => e.from);
  const primarySender = senders[0] ?? "c2c";
  const snippet = firstSnippet(envelopes[0]?.body ?? content);

  const parts: string[] = [];
  parts.push(" " + theme.fg("accent", `${ICON} ${KIND}`));

  if (count <= 1) {
    parts.push(theme.fg("text", `from ${primarySender}`));
  } else {
    parts.push(theme.fg("text", `${count} messages`));
    if (senders.length > 0) {
      parts.push(theme.fg("muted", `from ${senders.join(", ")}`));
    }
  }

  if (snippet.length > 0) {
    parts.push(theme.fg("dim", snippet));
  }

  return truncateToWidth(parts.join(theme.fg("borderMuted", " · ")), width);
}

/** Build the expanded multi-line representation. */
export function buildExpandedComponent(
  message: MessageLike<C2cDeliveryDetails>,
  theme: Theme,
): Component {
  const content = typeof message.content === "string" ? message.content : "";
  const envelopes = parseC2cEnvelopes(content);
  const details = message.details;

  const count = details?.count ?? envelopes.length;
  const senders = details?.senders ?? envelopes.map((e) => e.from);

  const header = count <= 1
    ? `${ICON} ${KIND} · message from ${senders[0] ?? "c2c"}`
    : `${ICON} ${KIND} · ${count} messages`;

  const container = new Container();
  container.addChild(new Text(theme.fg("accent", header), 1, 0));
  container.addChild(new Spacer(1));

  for (const envelope of envelopes) {
    if (envelope.from) {
      container.addChild(new Text(theme.fg("text", `${envelope.from}:`), 1, 0));
    }
    container.addChild(new Text(theme.fg("toolOutput", envelope.body), 1, 0));
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
  ) {}

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    this.cachedLines = this.expanded
      ? buildExpandedComponent(this.message, this.theme).render(width)
      : [buildCompactLine(this.message, this.theme, width)];
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
    return new CompactC2cMessage(message, expanded, theme);
  });
}
