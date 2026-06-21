import { describe, it } from "node:test";
import assert from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { withEnv } from "../helpers/withEnv.ts";
import {
  buildCompactLine,
  buildExpandedComponent,
  CompactC2cMessage,
  parseC2cEnvelopes,
  type C2cDeliveryDetails,
} from "../../src/ui/compact-message.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

interface ColorEvent {
  color: string;
  text: string;
}

function makeRecordingTheme() {
  const events: ColorEvent[] = [];
  const theme = {
    fg: (color: string, text: string) => {
      events.push({ color, text });
      return text;
    },
    bg: (color: string, text: string) => {
      events.push({ color, text });
      return text;
    },
    bold: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
    events,
  } as unknown as Theme & { events: ColorEvent[] };
  return theme;
}

function makeMessage(
  content: string,
  details?: Partial<C2cDeliveryDetails>,
): { content: string; details?: C2cDeliveryDetails } {
  return {
    content,
    details: details
      ? ({
          count: details.count ?? 1,
          senders: details.senders ?? ["c2c"],
          selfAlias: details.selfAlias,
        } as C2cDeliveryDetails)
      : undefined,
  };
}

function envelope(from: string, body: string): string {
  return `<c2c event="message" from="${from}" to="me" source="broker" reply_via="c2c_pi_send" action_after="continue">\n${body}\n</c2c>`;
}

function statusEnvelope(from: string, state: string): string {
  return `<c2c event="status" from="${from}" state="${state}" since="2026-06-17T00:00:00.000Z" ttl_ms="60000" />`;
}

describe("parseC2cEnvelopes", () => {
  it("extracts sender and body from a single envelope", () => {
    const parsed = parseC2cEnvelopes(envelope("lyra-quill", "hello world"));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].from, "lyra-quill");
    assert.strictEqual(parsed[0].body, "hello world");
  });

  it("extracts multiple envelopes", () => {
    const content = [envelope("a", "one"), envelope("b", "two")].join("\n\n");
    const parsed = parseC2cEnvelopes(content);
    assert.strictEqual(parsed.length, 2);
    assert.deepStrictEqual(
      parsed.map((e) => ({ from: e.from, body: e.body, event: e.event })),
      [
        { from: "a", body: "one", event: "message" },
        { from: "b", body: "two", event: "message" },
      ],
    );
  });

  it("extracts status envelopes", () => {
    const parsed = parseC2cEnvelopes(statusEnvelope("lyra-quill", "processing"));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].from, "lyra-quill");
    assert.strictEqual(parsed[0].event, "status");
    assert.strictEqual(parsed[0].status?.state, "processing");
  });

  it("unwraps status envelopes delivered inside message envelopes", () => {
    const wrapped = `<c2c event="message" from="lyra-quill" to="me" source="broker" reply_via="c2c_pi_send" action_after="continue">\n${statusEnvelope("lyra-quill", "processing")}\n</c2c>`;
    const parsed = parseC2cEnvelopes(wrapped);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].event, "status");
    assert.strictEqual(parsed[0].status?.state, "processing");
    assert.strictEqual(parsed[0].from, "lyra-quill");
  });

  it("trims leading/trailing newlines from the body", () => {
    const parsed = parseC2cEnvelopes(envelope("x", "\n\ninner\n\n"));
    assert.strictEqual(parsed[0].body, "inner");
  });

  it("falls back to treating raw content as a single message", () => {
    const parsed = parseC2cEnvelopes("just some text");
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].from, "c2c");
    assert.strictEqual(parsed[0].body, "just some text");
    assert.strictEqual(parsed[0].event, "message");
  });

  it("returns an empty array for empty content", () => {
    assert.deepStrictEqual(parseC2cEnvelopes(""), []);
    assert.deepStrictEqual(parseC2cEnvelopes("   \n  "), []);
  });
});

describe("buildCompactLine", () => {
  it("stays within the requested width", () => {
    const msg = makeMessage(envelope("lyra-quill", "A".repeat(200)));
    const line = buildCompactLine(msg, plainTheme, 40);
    assert.strictEqual(visibleWidth(line), 40);
  });

  it("shows the sender and a snippet for a single message", () => {
    const msg = makeMessage(envelope("lyra-quill", "ERROR: timeout"));
    const line = buildCompactLine(msg, plainTheme, 80);
    assert.ok(line.includes("lyra-quill"));
    assert.ok(line.includes("ERROR: timeout"));
    assert.ok(line.includes("▼"));
    assert.ok(line.includes("◎"));
  });

  it("prefixes incoming messages with ⧓ c2c · and a left arrow", () => {
    const msg = makeMessage(envelope("lyra-quill", "hello there"));
    const line = buildCompactLine(msg, plainTheme, 80);
    assert.match(line, /⧓ c2c · ▼◎ ← lyra-quill/);
  });

  it("prefixes outgoing messages with ⧓ c2c · and a right arrow", () => {
    const msg = makeMessage(envelope("pi-313d8c", "on it"), {
      senders: ["pi-313d8c"],
      selfAlias: "pi-313d8c",
    });
    const line = buildCompactLine(msg, plainTheme, 80);
    assert.match(line, /⧓ c2c · ▲◎ → pi-313d8c/);
  });

  it("shows outgoing direction when sender matches selfAlias", () => {
    const msg = makeMessage(envelope("pi-313d8c", "on it"), {
      senders: ["pi-313d8c"],
      selfAlias: "pi-313d8c",
    });
    const line = buildCompactLine(msg, plainTheme, 80);
    assert.ok(line.includes("▲"));
    assert.ok(line.includes("pi-313d8c"));
  });

  it("shows relay route for aliases with ", () => {
    const msg = makeMessage(envelope("remote@a3b2c1d4e5f6", "hello"));
    const line = buildCompactLine(msg, plainTheme, 80);
    assert.ok(line.includes("⇄"));
  });

  it("shows the count and senders for multiple messages", () => {
    const content = [envelope("a", "one"), envelope("b", "two")].join("\n\n");
    const msg = makeMessage(content, { count: 2, senders: ["a", "b"] });
    const line = buildCompactLine(msg, plainTheme, 80);
    assert.ok(line.includes("2 messages"));
    assert.ok(line.includes("a"));
    assert.ok(line.includes("b"));
  });

  it("handles non-envelope content gracefully", () => {
    const msg = makeMessage("raw text");
    const line = buildCompactLine(msg, plainTheme, 80);
    assert.ok(line.includes("raw text"));
  });

  it("renders status envelopes compactly", () => {
    const msg = makeMessage(statusEnvelope("lyra-quill", "processing"), {
      count: 1,
      senders: ["lyra-quill"],
    });
    const line = buildCompactLine(msg, plainTheme, 80);
    assert.ok(line.includes("lyra-quill"));
    assert.ok(line.includes("is processing"));
    assert.ok(line.includes("●"));
  });

  it("handles content arrays by treating them as empty", () => {
    const msg = { content: [{ type: "text" }] as unknown[], details: { count: 1, senders: ["x"] } as C2cDeliveryDetails };
    const line = buildCompactLine(msg, plainTheme, 40);
    assert.ok(line.includes("x"));
    assert.ok(visibleWidth(line) <= 40);
  });

  it("colors the incoming truncation ellipsis like the message body", () => {
    const msg = makeMessage(
      envelope("lyra-quill", "this is a long incoming message body that must overflow a narrow compact line and then be truncated"),
      { count: 1, senders: ["lyra-quill"] },
    );
    const theme = makeRecordingTheme();

    buildCompactLine(msg, theme, 40);

    const ellipsisEvents = theme.events.filter((e) => e.text === "…");
    assert.ok(ellipsisEvents.length > 0, "expected incoming truncation ellipsis to be styled");
    assert.equal(ellipsisEvents.at(-1)!.color, "toolOutput");
  });

  it("truncates a long incoming body with the single ellipsis char (not ...)", () => {
    const msg = makeMessage(
      envelope("lyra-quill", "this is a long incoming message body that must overflow a narrow compact line and then be truncated"),
      { count: 1, senders: ["lyra-quill"] },
    );
    const line = buildCompactLine(msg, plainTheme, 40);
    assert.ok(visibleWidth(line) <= 40);
    assert.ok(line.includes("…"), "incoming compact truncation should use the single ellipsis char");
    assert.ok(!line.includes("..."), "incoming compact truncation should not use three dots");
  });

  it("uses ASCII '...' (not …) when PI_C2C_ASCII=1 and the body overflows", () => {
    const msg = makeMessage(
      envelope("lyra-quill", "this is a long incoming message body that must overflow a narrow compact line and then be truncated"),
      { count: 1, senders: ["lyra-quill"] },
    );
    const line = withEnv("PI_C2C_ASCII", "1", () =>
      buildCompactLine(msg, plainTheme, 40),
    );
    assert.ok(visibleWidth(line) <= 40);
    assert.ok(line.includes("..."), "ASCII mode should truncate with three dots");
    assert.ok(!line.includes("…"), "ASCII mode should not use the Unicode ellipsis char");
  });
});

describe("CompactC2cMessage", () => {
  it("is one line collapsed and many lines expanded", () => {
    const content = [envelope("a", "line one\nline two"), envelope("b", "line three")].join("\n\n");
    const msg = makeMessage(content, { count: 2, senders: ["a", "b"] });
    assert.strictEqual(new CompactC2cMessage(msg, false, plainTheme).render(80).length, 1);
    assert.ok(new CompactC2cMessage(msg, true, plainTheme).render(80).length > 1);
  });

  it("caches render output for the same width", () => {
    const msg = makeMessage(envelope("x", "hello"));
    const component = new CompactC2cMessage(msg, false, plainTheme);
    const a = component.render(80);
    const b = component.render(80);
    assert.strictEqual(a, b);
    component.invalidate();
    const c = component.render(80);
    assert.notStrictEqual(a, c);
  });
});

describe("buildExpandedComponent", () => {
  it("renders a header and the body", () => {
    const msg = makeMessage(envelope("lyra-quill", "hello\nworld"));
    const lines = buildExpandedComponent(msg, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("lyra-quill"));
    assert.ok(!joined.includes("message from lyra-quill"));
    assert.ok(joined.includes("hello"));
    assert.ok(joined.includes("world"));
  });

  it("renders the expanded incoming sender alias in accent without a message-from label", () => {
    const msg = makeMessage(envelope("lyra-quill", "hello world"), { count: 1, senders: ["lyra-quill"] });
    const theme = makeRecordingTheme();
    const lines = buildExpandedComponent(msg, theme, "me").render(80);
    const joined = lines.join("\n");

    assert.ok(!joined.includes("message from"));
    const senderEvents = theme.events.filter((e) => e.text === "lyra-quill");
    assert.ok(senderEvents.length > 0, "expected expanded sender alias to be styled separately");
    assert.equal(senderEvents.at(-1)!.color, "accent");
  });

  it("renders status envelopes in expanded view", () => {
    const msg = makeMessage(statusEnvelope("lyra-quill", "processing"), {
      count: 1,
      senders: ["lyra-quill"],
    });
    const lines = buildExpandedComponent(msg, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("status from lyra-quill"));
    assert.ok(joined.includes("state=processing"));
  });

  it("renders multiple messages", () => {
    const content = [envelope("a", "one"), envelope("b", "two")].join("\n\n");
    const msg = makeMessage(content, { count: 2, senders: ["a", "b"] });
    const lines = buildExpandedComponent(msg, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("2 messages"));
    assert.ok(joined.includes("a:"));
    assert.ok(joined.includes("b:"));
  });

  it("renders sanitized status envelopes", () => {
    const content =
      '<c2c event="message" from="pi-c1ab3c" to="pi-313d8c" source="broker">\n' +
      '‹c2c event="status" from="pi-c1ab3c" state="processing" since="2026-06-16T17:29:23.881Z" ttl_ms="60000" />\n' +
      "</c2c>";
    const msg = makeMessage(content, { count: 1, senders: ["pi-c1ab3c"] });
    const lines = buildExpandedComponent(msg, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("status from pi-c1ab3c"));
    assert.ok(joined.includes("state=processing"));
  });
});
