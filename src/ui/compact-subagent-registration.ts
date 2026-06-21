/**
 * Compact TUI renderer for subagent-registration notices.
 *
 * Collapses a registration into a single line:
 *    ⧓ c2c · subagent · ↳ Plan#abc123 → parent-a123456
 * Expands to a small block with the agent id, alias, and the model-facing
 * sentence so the human can inspect details on demand.
 *
 * Falls back to parsing `message.content` when `message.details` is absent
 * (old session files written before this renderer existed).
 */
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { SubagentRegistrationDetails } from "../subagent.ts";

export type { SubagentRegistrationDetails };

const KIND = "c2c-subagent-registration";

/** Glyph vocabulary. All glyphs have ASCII fallbacks via `PI_C2C_ASCII=1`. */
const GLYPHS = {
  container: "⧓",
  channel: "c2c",
  kind: "subagent",
  separator: " · ",
  fork: "↳",
  mapping: "→",
  bullet: "›",
  registered: "registered",
} as const;

const ASCII_GLYPHS = {
  container: "o",
  channel: "c2c",
  kind: "subagent",
  separator: " . ",
  fork: "->",
  mapping: "=>", // Distinct from `fork` so ASCII stays scannable.
  bullet: ">",
  registered: "registered",
} as const;

function useAsciiGlyphs(): boolean {
  return process.env.PI_C2C_ASCII === "1";
}

function pickGlyphs() {
  return useAsciiGlyphs() ? ASCII_GLYPHS : GLYPHS;
}

/** Build the colored ` ⧓ c2c · subagent · ↳ ` header prefix. */
function buildPrefix(theme: Theme): string {
  const g = pickGlyphs();
  return (
    " " +
    theme.fg("accent", `${g.container} ${g.channel}`) +
    theme.fg("borderMuted", g.separator) +
    theme.fg("muted", g.kind) +
    theme.fg("borderMuted", g.separator) +
    theme.fg("accent", `${g.fork} `)
  );
}

/** Render the body after the header (id → alias mapping or generic label). */
function buildBody(
  agentId: string | undefined,
  alias: string,
  theme: Theme,
): string {
  const g = pickGlyphs();
  const idLabel = agentId ?? "Subagent";
  const idPart = theme.fg("accent", idLabel);
  const arrow = theme.fg("muted", ` ${g.mapping} `);
  const aliasPart = theme.fg("text", alias);
  return `${idPart}${arrow}${aliasPart}`;
}

interface MessageLike {
  content: string | (TextContent | ImageContent)[];
  details?: SubagentRegistrationDetails;
}

/** Extract a plain string from a possibly-array `content`. If `content` is
 *  a content-array (text + image), concatenate text parts. This renderer
 *  never has to render images (registration notices are plain strings). */
function contentString(content: MessageLike["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is TextContent => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Parse the canonical `Subagent X registered as \`Y\`.` notice string. Used
 * as a fallback when `message.details` is missing (old sessions).
 *
 * Returns `null` for non-canonical input; the renderer falls back to a
 * safe muted rendering of the raw content in that case.
 */
export function parseRegistrationNotice(content: string): {
  agentId?: string;
  alias: string;
} | null {
  // `Subagent <id> registered as `<alias>`.` — id may contain '#', letters,
  // digits, dashes, underscores. Alias follows the sanitizeAlias rules.
  const m = content.match(
    /^Subagent\s+(.+?)\s+registered as\s+`([A-Za-z0-9_-]+)`\.\s*$/,
  );
  if (!m) return null;
  const agentId = m[1];
  const alias = m[2];
  // The fallback synthesizes a generic "Subagent" label when the id is the
  // literal word "Subagent" (no real id was supplied).
  return {
    agentId: agentId === "Subagent" ? undefined : agentId,
    alias,
  };
}

function resolveDetails(message: MessageLike): {
  agentId?: string;
  alias: string;
  parsedFromContent: boolean;
} | null {
  if (message.details && typeof message.details.alias === "string") {
    return {
      agentId: message.details.agentId,
      alias: message.details.alias,
      parsedFromContent: false,
    };
  }
  const parsed = parseRegistrationNotice(contentString(message.content));
  if (!parsed) return null;
  return { ...parsed, parsedFromContent: true };
}

/** Build the single-line collapsed representation. */
export function buildCompactLine(
  message: MessageLike,
  theme: Theme,
  width: number,
): string {
  const details = resolveDetails(message);
  const prefix = buildPrefix(theme);

  const ellipsis = useAsciiGlyphs() ? "..." : "…";
  if (!details) {
    // Non-canonical content; render the raw text in muted color, truncated.
    const body = theme.fg("muted", contentString(message.content));
    return truncateToWidth(prefix + body, width, ellipsis);
  }

  return truncateToWidth(prefix + buildBody(details.agentId, details.alias, theme), width, ellipsis);
}

/** Build the expanded multi-line representation. */
export function buildExpandedComponent(
  message: MessageLike,
  theme: Theme,
): Component {
  const details = resolveDetails(message);
  const g = pickGlyphs();
  const container = new Container();
  const header =
    " " +
    theme.fg("accent", `${g.container} ${g.channel}`) +
    theme.fg("borderMuted", g.separator) +
    theme.fg("muted", g.kind) +
    theme.fg("borderMuted", g.separator) +
    theme.fg("accent", `${g.fork} `) +
    theme.fg("accent", g.registered);
  container.addChild(new Text(header, 1, 0));
  container.addChild(new Spacer(1));

  if (!details) {
    container.addChild(
      new Text(theme.fg("muted", contentString(message.content)), 1, 0),
    );
    return container;
  }

  // Two-column label alignment via padEnd on the label.
  const labels = details.agentId
    ? ["agent id:", "alias:"]
    : ["alias:"];
  const labelWidth = Math.max(...labels.map((l) => l.length));

  if (details.agentId) {
    container.addChild(
      new Text(
        theme.fg("muted", `${g.bullet} `) +
          theme.fg("muted", "agent id:".padEnd(labelWidth)) +
          " " +
          theme.fg("accent", details.agentId),
        1,
        0,
      ),
    );
  }
  container.addChild(
    new Text(
      theme.fg("muted", `${g.bullet} `) +
        theme.fg("muted", "alias:".padEnd(labelWidth)) +
        " " +
        theme.fg("accent", details.alias),
      1,
      0,
    ),
  );
  container.addChild(new Spacer(1));
  container.addChild(
    new Text(
      theme.fg("muted", `${g.bullet} `) + theme.fg("muted", contentString(message.content)),
      1,
      0,
    ),
  );

  return container;
}

/** Component wrapper that caches render output per width. */
export class CompactSubagentRegistration implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly message: MessageLike,
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
    // No interactive input.
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/** Register the compact subagent-registration renderer on an ExtensionAPI. */
export function registerSubagentRegistrationRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<SubagentRegistrationDetails>(KIND, (message, { expanded }, theme) => {
    return new CompactSubagentRegistration(message, expanded, theme);
  });
}
