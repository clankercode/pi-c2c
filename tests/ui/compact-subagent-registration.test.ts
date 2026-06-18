import { describe, it } from "node:test";
import assert from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  buildCompactLine,
  buildExpandedComponent,
  CompactSubagentRegistration,
  parseRegistrationNotice,
  type SubagentRegistrationDetails,
} from "../../src/ui/compact-subagent-registration.ts";
import { withEnv } from "../helpers/withEnv.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

interface MessageLike {
  content: string;
  details?: SubagentRegistrationDetails;
}

function makeMessage(
  content: string,
  details?: Partial<SubagentRegistrationDetails>,
): MessageLike {
  if (!details) return { content };
  return {
    content,
    details: {
      agentId: details.agentId,
      alias: details.alias ?? "pi-ae17fe-a00a220",
    },
  };
}

describe("buildCompactLine", () => {
  it("uses the c2c compact prefix with a subagent kind slot", () => {
    const line = buildCompactLine(
      makeMessage("Subagent Plan#abc123 registered as `parent-a123456`.", {
        agentId: "Plan#abc123",
        alias: "parent-a123456",
      }),
      plainTheme,
      120,
    );
    assert.match(line, /^ ⧓ c2c · subagent · ↳ Plan#abc123 → parent-a123456$/);
  });

  it("renders agent id, fork glyph, mapping arrow, and alias when agentId is set", () => {
    const line = buildCompactLine(
      makeMessage("Subagent Plan#abc123 registered as `parent-a123456`.", {
        agentId: "Plan#abc123",
        alias: "parent-a123456",
      }),
      plainTheme,
      120,
    );
    assert.match(line, /↳/);
    assert.match(line, /Plan#abc123/);
    assert.match(line, /→/);
    assert.match(line, /parent-a123456/);
  });

  it("falls back to the literal 'Subagent' word when agentId is missing", () => {
    const line = buildCompactLine(
      makeMessage("Subagent Subagent registered as `pi-ae17fe-a00a220`.", {
        alias: "pi-ae17fe-a00a220",
      }),
      plainTheme,
      120,
    );
    assert.match(line, /Subagent/);
    assert.match(line, /pi-ae17fe-a00a220/);
    // No fake id (no Plan# / Explore# / etc.)
    assert.doesNotMatch(line, /#[a-f0-9]+/);
  });

  it("truncates to the requested width", () => {
    const longAlias = "pi-ae17fe-" + "x".repeat(200);
    const line = buildCompactLine(
      makeMessage(`Subagent Plan#abc123 registered as \`${longAlias}\`.`, {
        agentId: "Plan#abc123",
        alias: longAlias,
      }),
      plainTheme,
      40,
    );
    assert.ok(
      visibleWidth(line) <= 40,
      `expected visible width <= 40, got ${visibleWidth(line)} for line: ${line}`,
    );
  });
});

describe("buildExpandedComponent", () => {
  it("renders header, agent id bullet, alias bullet, and model-facing sentence", () => {
    const component = buildExpandedComponent(
      makeMessage("Subagent Plan#abc123 registered as `parent-a123456`.", {
        agentId: "Plan#abc123",
        alias: "parent-a123456",
      }),
      plainTheme,
    );
    const lines = component.render(120);
    const joined = lines.join("\n");
    assert.match(joined, / ⧓ c2c · subagent · ↳ registered/);
    assert.match(joined, /› agent id: Plan#abc123/);
    assert.match(joined, /› alias: +parent-a123456/);
    assert.match(joined, /› Subagent Plan#abc123 registered as `parent-a123456`\./);
  });

  it("omits the agent id bullet when agentId is missing", () => {
    const component = buildExpandedComponent(
      makeMessage("Subagent Subagent registered as `pi-ae17fe-a00a220`.", {
        alias: "pi-ae17fe-a00a220",
      }),
      plainTheme,
    );
    const lines = component.render(120);
    const joined = lines.join("\n");
    assert.doesNotMatch(joined, /agent id:/);
    assert.match(joined, /› alias: +pi-ae17fe-a00a220/);
  });
});

describe("CompactSubagentRegistration", () => {
  it("caches render output for the same width", () => {
    const msg = makeMessage("Subagent Plan#abc123 registered as `parent-a123456`.", {
      agentId: "Plan#abc123",
      alias: "parent-a123456",
    });
    const comp = new CompactSubagentRegistration(msg, false, plainTheme);
    const first = comp.render(80);
    const second = comp.render(80);
    assert.strictEqual(first, second, "same width should return cached render");
  });

  it("re-renders on width change", () => {
    const msg = makeMessage("Subagent Plan#abc123 registered as `parent-a123456`.", {
      agentId: "Plan#abc123",
      alias: "parent-a123456",
    });
    const comp = new CompactSubagentRegistration(msg, false, plainTheme);
    const narrow = comp.render(40);
    const wide = comp.render(160);
    assert.notStrictEqual(narrow, wide, "different widths should re-render");
  });

  it("re-renders after invalidate() (new reference, same content)", () => {
    const msg = makeMessage("Subagent Plan#abc123 registered as `parent-a123456`.", {
      agentId: "Plan#abc123",
      alias: "parent-a123456",
    });
    const comp = new CompactSubagentRegistration(msg, false, plainTheme);
    const first = comp.render(80);
    comp.invalidate();
    const second = comp.render(80);
    assert.notStrictEqual(first, second, "invalidate should produce a fresh array");
    assert.deepStrictEqual(first, second, "content should still match");
  });
});

describe("fallback when details are missing", () => {
  it("parses canonical notice and renders correctly with no details", () => {
    const line = buildCompactLine(
      { content: "Subagent Plan#abc123 registered as `parent-a123456`." },
      plainTheme,
      120,
    );
    assert.match(line, /Plan#abc123/);
    assert.match(line, /parent-a123456/);
    assert.match(line, /^ ⧓ c2c · subagent · ↳ Plan#abc123 → parent-a123456$/);
  });

  it("renders a safe muted fallback for non-canonical content", () => {
    const weird = { content: "[corrupted entry]" };
    const line = buildCompactLine(weird, plainTheme, 120);
    assert.match(line, / ⧓ c2c · subagent · ↳ \[corrupted entry\]/);
    // No throw.
    assert.ok(line.length > 0);
  });

  it("parseRegistrationNotice extracts agent id and alias from canonical format", () => {
    const parsed = parseRegistrationNotice(
      "Subagent Plan#abc123 registered as `parent-a123456`.",
    );
    assert.deepStrictEqual(parsed, {
      agentId: "Plan#abc123",
      alias: "parent-a123456",
    });
  });

  it("parseRegistrationNotice returns null for non-canonical input", () => {
    assert.strictEqual(parseRegistrationNotice("not a notice"), null);
    assert.strictEqual(parseRegistrationNotice(""), null);
  });
});

// ASCII fallback tests live in their own describe block to make the
// env-mutation scope explicit and avoid parallel siblings touching
// process.env.PI_C2C_ASCII.
describe("PI_C2C_ASCII=1 fallback", () => {
  it("collapsed line uses ASCII glyphs only", () => {
    const line = withEnv("PI_C2C_ASCII", "1", () =>
      buildCompactLine(
        makeMessage("Subagent Plan#abc123 registered as `parent-a123456`.", {
          agentId: "Plan#abc123",
          alias: "parent-a123456",
        }),
        plainTheme,
        120,
      ),
    );
    assert.match(line, / o c2c \. subagent \. -> Plan#abc123/);
    // Fork glyph: ->
    assert.match(line, /-> Plan#abc123/);
    // Mapping glyph: => (NOT ->, so it stays distinct from the fork glyph)
    assert.match(line, /=> parent-a123456/);
    // No Unicode arrows, middle dot, asterism, or other fancy glyphs.
    assert.doesNotMatch(line, /[⧓↳→·›※⁂]/);
  });

  it("expanded component uses ASCII glyphs only", () => {
    const component = withEnv("PI_C2C_ASCII", "1", () =>
      buildExpandedComponent(
        makeMessage("Subagent Plan#abc123 registered as `parent-a123456`.", {
          agentId: "Plan#abc123",
          alias: "parent-a123456",
        }),
        plainTheme,
      ),
    );
    const joined = component.render(120).join("\n");
    assert.match(joined, / o c2c \. subagent/);
    assert.doesNotMatch(joined, /[⧓↳→·›]/);
  });
});
