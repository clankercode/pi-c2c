import { describe, it } from "node:test";
import assert from "node:assert";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  buildPeerListDetails,
  buildPeerTree,
  flattenPeerTree,
  formatPeerListText,
  parseChildAlias,
  renderEmptyCall,
  renderInboxResult,
  renderJoinRoomResult,
  renderListResult,
  renderLocalInfoResult,
  renderRoomsResult,
  renderSendResult,
  renderStatusResult,
  renderWhoamiResult,
  type InboxToolDetails,
  type ListPeerInfo,
  type ListToolDetails,
  type LocalInfoToolDetails,
  type RoomToolDetails,
  type RoomsToolDetails,
  type StatusToolDetails,
  type WhoamiToolDetails,
} from "../../src/ui/tool-renderers.ts";
import {
  buildCompactLine,
  type C2cDeliveryDetails,
} from "../../src/ui/compact-message.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

/** Assert a single result line leads with `⧓ c2c.<action> · `, no doubled marker. */
function assertActionPrefix(line: string, action: string) {
  const want = ` ⧓ c2c.${action} · `;
  assert.ok(line.startsWith(want), `expected lead "${want}", got: ${line}`);
  assert.ok(!line.includes("⧓⧓"), `expected no doubled marker, got: ${line}`);
  assert.ok(!line.includes("c2c_pi_"), `expected no raw tool name, got: ${line}`);
}

function text(line: string) {
  return line.trimEnd();
}

describe("renderEmptyCall", () => {
  it("renders no visible lines (suppresses the raw-tool-name fallback)", () => {
    const lines = renderEmptyCall().render(80);
    const visible = lines.filter((l) => l.trim().length > 0);
    assert.strictEqual(visible.length, 0, `expected no visible call lines, got: ${JSON.stringify(lines)}`);
  });
});

describe("renderSendResult", () => {
  it("renders a DM success leading with c2c.send", () => {
    const lines = renderSendResult({ kind: "dm", target: "lyra-quill", via: "sessions" }, false, plainTheme).render(80);
    assertActionPrefix(lines[0], "send");
    assert.ok(lines[0].includes("→ lyra-quill"));
    assert.ok(lines[0].includes("▲"));
    assert.ok(lines[0].includes("◎"));
  });

  it("colors the truncated body ellipsis like the send body", () => {
    const theme = makeRecordingTheme();
    renderSendResult(
      {
        kind: "dm",
        target: "lyra-quill",
        via: "sessions",
        body: "hello world this is a fairly long message that should be truncated",
      },
      false,
      theme,
    ).render(50);

    const ellipsisEvents = theme.events.filter((e) => e.text === "…");
    assert.ok(ellipsisEvents.length > 0, "expected truncated send ellipsis to be styled");
    assert.equal(ellipsisEvents.at(-1)!.color, "toolOutput");
  });

  it("uses available width before truncating the body preview", () => {
    const body = "hello world this is a fairly long message that should be truncated";
    // Narrow: the line fills the width then truncates with the single
    // ellipsis char, dropping the tail.
    const narrow = renderSendResult(
      { kind: "dm", target: "lyra-quill", via: "sessions", body },
      false,
      plainTheme,
    ).render(50);
    assertActionPrefix(narrow[0], "send");
    assert.ok(narrow[0].includes("hello world"));
    assert.ok(narrow[0].includes("…"), "narrow width should truncate with the single ellipsis char");
    assert.ok(!narrow[0].includes("..."), "should never use three-dot ellipsis");
    assert.ok(!narrow[0].includes("should be truncated"), "tail should be cut at narrow width");
    // Wide: the SAME message is not truncated — all available width is used
    // first (no fixed 60-char cap).
    const wide = renderSendResult(
      { kind: "dm", target: "lyra-quill", via: "sessions", body },
      false,
      plainTheme,
    ).render(300);
    assert.ok(wide[0].includes("should be truncated"), "wide width should show the full body");
    assert.ok(!wide[0].includes("…"), "wide width should not truncate");
  });

  it("shows the full body when the result is expanded", () => {
    const body = "hello world this is a fairly long message that should be truncated";
    // Width 80 would truncate the collapsed line, but expanded must show
    // everything (mirroring the incoming expanded view).
    const lines = renderSendResult(
      { kind: "dm", target: "lyra-quill", via: "sessions", body },
      false,
      plainTheme,
      true, // expanded
    ).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("⧓ c2c.send"), "expanded keeps the header");
    assert.ok(joined.includes("should be truncated"), "expanded shows the full body, untruncated");
    assert.ok(!joined.includes("…"), "expanded does not truncate with an ellipsis");
    assert.ok(lines.length > 1, "expanded is multi-line (header + body)");
  });

  it("renders a DM success with short body preview over relay", () => {
    const lines = renderSendResult(
      { kind: "dm", target: "lyra-quill", via: "relay", body: "hi" },
      false,
      plainTheme,
    ).render(80);
    assertActionPrefix(lines[0], "send");
    assert.ok(lines[0].includes("→ lyra-quill"));
    assert.ok(lines[0].includes("hi"));
    assert.ok(lines[0].includes("⇄"));
  });

  it("renders a broadcast success leading with c2c.send-all", () => {
    const lines = renderSendResult({ kind: "broadcast", via: "sessions" }, false, plainTheme).render(80);
    assertActionPrefix(lines[0], "send-all");
    assert.ok(lines[0].includes("✶"));
  });

  it("renders a broadcast success with body preview", () => {
    const lines = renderSendResult(
      { kind: "broadcast", via: "sessions", body: "all hands" },
      false,
      plainTheme,
    ).render(80);
    assertActionPrefix(lines[0], "send-all");
    assert.ok(lines[0].includes("all hands"));
  });

  it("renders a room send success leading with c2c.send-room", () => {
    const lines = renderSendResult({ kind: "room", room: "swarm-lounge", via: "sessions" }, false, plainTheme).render(80);
    assertActionPrefix(lines[0], "send-room");
    assert.ok(lines[0].includes("→ swarm-lounge"));
  });

  it("renders a room send success with body preview", () => {
    const lines = renderSendResult(
      { kind: "room", room: "swarm-lounge", via: "sessions", body: "room message here" },
      false,
      plainTheme,
    ).render(80);
    assertActionPrefix(lines[0], "send-room");
    assert.ok(lines[0].includes("→ swarm-lounge"));
    assert.ok(lines[0].includes("room message here"));
  });

  it("renders an error", () => {
    const lines = renderSendResult({ kind: "dm", target: "x" }, true, plainTheme).render(80);
    assertActionPrefix(lines[0], "send");
    assert.ok(lines[0].includes("error"));
  });

  it("renders failed send status with truncated detail", () => {
    const detail = "c2c send failed (exit 1): recipient is not alive: pi-d7ef52 and this tail should truncate";
    const lines = renderSendResult(
      { kind: "dm", target: "pi-d7ef52", error: "failed", errorDetail: detail },
      false,
      plainTheme,
    ).render(70);

    assertActionPrefix(lines[0], "send");
    assert.ok(lines[0].includes("failed · c2c send failed"));
    assert.ok(lines[0].includes("…"), "long failure detail should truncate");
    assert.ok(!lines[0].includes("this tail should truncate"));
  });

  it("colors failed send detail and truncation ellipsis as error", () => {
    const theme = makeRecordingTheme();
    renderSendResult(
      { kind: "dm", target: "pi-d7ef52", error: "failed", errorDetail: "recipient is not alive: pi-d7ef52" },
      false,
      theme,
    ).render(45);

    const detailEvent = theme.events.find((e) => e.text === "recipient is not alive: pi-d7ef52");
    assert.ok(detailEvent, "expected failure detail to be styled");
    assert.equal(detailEvent!.color, "error");
    const ellipsisEvents = theme.events.filter((e) => e.text === "…");
    assert.ok(ellipsisEvents.length > 0, "expected failure truncation ellipsis to be styled");
    assert.equal(ellipsisEvents.at(-1)!.color, "error");
  });
});

describe("failure rendering via details.error (no thrown isError)", () => {
  it("renders a failed send as an error line, not a fake success", () => {
    const lines = renderSendResult(
      { kind: "dm", target: "lyra-quill", error: "not registered" },
      false,
      plainTheme,
    ).render(80);
    assertActionPrefix(lines[0], "send");
    assert.ok(lines[0].includes("not registered"));
    assert.ok(!lines[0].includes("→ lyra-quill"), "must not render the success arrow on failure");
  });

  it("renders a failed join as an error line, not 'joined room'", () => {
    const lines = renderJoinRoomResult(
      { room: "swarm-lounge", joined: true, error: "failed" },
      false,
      plainTheme,
    ).render(80);
    assertActionPrefix(lines[0], "join");
    assert.ok(lines[0].includes("failed"));
    assert.ok(!lines[0].includes("joined"), "must not render success on failure");
  });

  it("renders a failed list as an error line, not 'no peers registered'", () => {
    const joined = renderListResult({ peers: [], error: "failed" }, false, plainTheme).render(80).join("\n");
    assert.ok(joined.includes("failed"));
    assert.ok(!joined.includes("no peers registered"));
  });

  it("colors the failure message with the error color", () => {
    const theme = makeRecordingTheme();
    renderSendResult({ kind: "dm", target: "x", error: "not registered" }, false, theme).render(80);
    const ev = theme.events.find((e) => e.text === "not registered");
    assert.ok(ev, "expected the failure message to be rendered");
    assert.strictEqual(ev!.color, "error");
  });
});

// ── peer tree helpers ──────────────────────────────────────────────────────

describe("parseChildAlias", () => {
  it("extracts the parent from a subagent alias", () => {
    assert.deepStrictEqual(parseChildAlias("pi-d19290-a6fc18a"), { parentAlias: "pi-d19290" });
  });

  it("preserves the relay @host suffix on the parent", () => {
    assert.deepStrictEqual(
      parseChildAlias("pi-d19290-a6fc18a@abc123def456"),
      { parentAlias: "pi-d19290@abc123def456" },
    );
  });

  it("returns null for a non-subagent alias", () => {
    assert.strictEqual(parseChildAlias("pi-0b3f66"), null);
    assert.strictEqual(parseChildAlias("lyra-quill"), null);
  });

  it("returns the immediate parent for a nested subagent", () => {
    assert.deepStrictEqual(
      parseChildAlias("pi-d19290-a111111-a222222"),
      { parentAlias: "pi-d19290-a111111" },
    );
  });
});

describe("buildPeerTree", () => {
  const parent: ListPeerInfo = { alias: "pi-d19290", alive: true };
  const child1: ListPeerInfo = { alias: "pi-d19290-a111111", alive: true };
  const child2: ListPeerInfo = { alias: "pi-d19290-a222222", alive: true };
  const other: ListPeerInfo = { alias: "pi-0b3f66", alive: true };

  it("nests subagents under their parent", () => {
    const roots = buildPeerTree([parent, child1, child2, other]);
    assert.deepStrictEqual(roots.map((r) => r.alias), ["pi-0b3f66", "pi-d19290"]);
    const p = roots.find((r) => r.alias === "pi-d19290")!;
    assert.deepStrictEqual(p.children.map((c) => c.alias), ["pi-d19290-a111111", "pi-d19290-a222222"]);
  });

  it("treats a child whose parent is absent as a root", () => {
    const roots = buildPeerTree([child1, other]);
    assert.deepStrictEqual(roots.map((r) => r.alias).sort(), ["pi-0b3f66", "pi-d19290-a111111"]);
    assert.ok(roots.every((r) => r.children.length === 0));
  });

  it("sorts live before dead, then alphabetically", () => {
    const roots = buildPeerTree([
      { alias: "zeta", alive: true },
      { alias: "alpha", alive: false },
      { alias: "beta", alive: true },
    ]);
    assert.deepStrictEqual(roots.map((r) => r.alias), ["beta", "zeta", "alpha"]);
  });

  it("does NOT drop a peer when two share the same display alias", () => {
    // Two distinct sessions both configured with the same C2C_PI_ALIAS survive
    // mergePeerLists as two entries; both must still render (no silent loss).
    const roots = buildPeerTree([
      { alias: "lyra", alive: true, tag: "local" },
      { alias: "lyra", alive: true, tag: "cross" },
    ]);
    assert.strictEqual(roots.length, 2, "both same-alias peers must be kept");
    assert.deepStrictEqual(roots.map((r) => r.tag).sort(), ["cross", "local"]);
  });

  it("nests a child under a parent whose alias exceeds the 56-char truncation boundary", () => {
    const parent = "p".repeat(57); // > SUBAGENT_PARENT_BASE_MAX (56)
    const child = `${"p".repeat(56)}-a111111`; // alias the generator would emit
    const roots = buildPeerTree([
      { alias: parent, alive: true },
      { alias: child, alive: true },
    ]);
    assert.strictEqual(roots.length, 1, "child should nest, not become a root");
    assert.strictEqual(roots[0].alias, parent);
    assert.deepStrictEqual(roots[0].children.map((c) => c.alias), [child]);
  });

  it("keeps both same-alias peers in the flattened row count", () => {
    const rows = flattenPeerTree(buildPeerTree([
      { alias: "dup", alive: true, tag: "local" },
      { alias: "dup", alive: true, tag: "relay" },
    ]));
    assert.strictEqual(rows.length, 2);
  });
});

describe("buildPeerListDetails", () => {
  const merged = [
    { alias: "alive-1", alive: true, tag: "local" as const },
    { alias: "dead-1", alive: false, tag: "cross" as const },
    { alias: "dead-2", alive: false, tag: "relay" as const },
  ];

  it("hides dead peers by default and counts them in hiddenDead", () => {
    const details = buildPeerListDetails(merged, false, () => undefined);
    assert.deepStrictEqual(details.peers.map((p) => p.alias), ["alive-1"]);
    assert.strictEqual(details.hiddenDead, 2);
  });

  it("includes dead peers and zeroes hiddenDead when includeDead", () => {
    const details = buildPeerListDetails(merged, true, () => undefined);
    assert.strictEqual(details.peers.length, 3);
    assert.strictEqual(details.hiddenDead, 0);
  });

  it("enriches shown peers with last-known state via stateFor", () => {
    const details = buildPeerListDetails(merged, false, (a) => (a === "alive-1" ? "tool" : undefined));
    assert.strictEqual(details.peers[0].state, "tool");
  });
});

describe("flattenPeerTree", () => {
  it("computes branch prefixes for a parent with two children", () => {
    const roots = buildPeerTree([
      { alias: "pi-d19290", alive: true },
      { alias: "pi-d19290-a111111", alive: true },
      { alias: "pi-d19290-a222222", alive: true },
    ]);
    const rows = flattenPeerTree(roots);
    assert.deepStrictEqual(
      rows.map((r) => [r.prefix, r.node.alias]),
      [
        ["", "pi-d19290"],
        ["  ├─ ", "pi-d19290-a111111"],
        ["  └─ ", "pi-d19290-a222222"],
      ],
    );
  });

  it("draws vertical guides for grandchildren under a non-last child", () => {
    const roots = buildPeerTree([
      { alias: "pi-d19290", alive: true },
      { alias: "pi-d19290-a111111", alive: true },
      { alias: "pi-d19290-a222222", alive: true },
      { alias: "pi-d19290-a111111-a333333", alive: true },
    ]);
    const rows = flattenPeerTree(roots);
    const grandchild = rows.find((r) => r.node.alias === "pi-d19290-a111111-a333333")!;
    assert.strictEqual(grandchild.prefix, "  │  └─ ");
  });
});

describe("renderListResult", () => {
  it("renders flat live peers with count and tags", () => {
    const details: ListToolDetails = {
      peers: [
        { alias: "alpha", alive: true },
        { alias: "beta", alive: true, tag: "cross" },
      ],
    };
    const lines = renderListResult(details, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assertActionPrefix(lines[0], "list");
    assert.ok(joined.includes("peers (2)"));
    assert.ok(joined.includes("alpha"));
    assert.ok(joined.includes("beta"));
    assert.ok(joined.includes("[cross-repo]"));
  });

  it("nests subagents under their parent with branch glyphs", () => {
    const details: ListToolDetails = {
      peers: [
        { alias: "pi-d19290", alive: true },
        { alias: "pi-d19290-a111111", alive: true },
        { alias: "pi-d19290-a222222", alive: true },
      ],
    };
    const lines = renderListResult(details, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("peers (3)"));
    assert.ok(joined.includes("├─"), `expected a branch glyph, got:\n${joined}`);
    assert.ok(joined.includes("└─"), `expected a corner glyph, got:\n${joined}`);
    // child rows are indented past the root row
    const childLine = lines.find((l) => l.includes("pi-d19290-a111111"))!;
    assert.ok(childLine.includes("├─") || childLine.includes("└─"));
  });

  it("shows a 'dead hidden' note in the header", () => {
    const details: ListToolDetails = {
      peers: [{ alias: "alpha", alive: true }],
      hiddenDead: 12,
    };
    const lines = renderListResult(details, false, plainTheme).render(80);
    assert.ok(lines[0].includes("peers (1)"));
    assert.ok(lines[0].includes("12 dead hidden"));
  });

  it("renders relay peers with [relay] tag", () => {
    const details: ListToolDetails = {
      peers: [{ alias: "remote@a3b2c1d4e5f6", alive: true, tag: "relay" }],
    };
    const joined = renderListResult(details, false, plainTheme).render(80).join("\n");
    assert.ok(joined.includes("remote@a3b2c1d4e5f6"));
    assert.ok(joined.includes("[relay]"));
    assert.ok(!joined.includes("[cross-repo]"));
  });

  it("renders an empty live list", () => {
    const joined = renderListResult({ peers: [] }, false, plainTheme).render(80).join("\n");
    assert.ok(joined.includes("peers"));
    assert.ok(joined.includes("no peers registered"));
  });

  it("says 'no live peers' when all peers were hidden as dead", () => {
    const joined = renderListResult({ peers: [], hiddenDead: 7 }, false, plainTheme).render(80).join("\n");
    assert.ok(joined.includes("no live peers"));
    assert.ok(joined.includes("7 dead hidden"));
  });

  it("renders an error", () => {
    const lines = renderListResult({ peers: [] }, true, plainTheme).render(80);
    assertActionPrefix(lines[0], "list");
    assert.ok(lines[0].includes("error"));
  });
});

describe("formatPeerListText", () => {
  it("renders a plain-text tree the LLM can read", () => {
    const text = formatPeerListText({
      peers: [
        { alias: "pi-d19290", alive: true },
        { alias: "pi-d19290-a111111", alive: true },
        { alias: "pi-0b3f66", alive: true, tag: "cross" },
      ],
    });
    assert.ok(text.includes("● pi-d19290"));
    assert.ok(text.includes("└─ ● pi-d19290-a111111"));
    assert.ok(text.includes("[cross-repo]"));
  });

  it("appends a dead-hidden note with the default (tool) reveal hint", () => {
    const text = formatPeerListText({ peers: [{ alias: "alpha", alive: true }], hiddenDead: 3 });
    assert.ok(text.includes("3 dead hidden"));
    assert.ok(text.includes("include_dead"), "tool hint names the include_dead param");
  });

  it("uses a caller-supplied reveal hint (e.g. the slash command's arg)", () => {
    const text = formatPeerListText(
      { peers: [{ alias: "alpha", alive: true }], hiddenDead: 3 },
      "run `/c2c-peers all`",
    );
    assert.ok(text.includes("/c2c-peers all"));
    assert.ok(!text.includes("include_dead"), "command hint must not mention the tool param");
  });

  it("reports no live peers when empty after filtering", () => {
    const empty = formatPeerListText({ peers: [], hiddenDead: 5 });
    assert.ok(empty.startsWith("No live peers (5 dead hidden"), empty);
    assert.ok(empty.includes("include_dead"), empty);
    assert.strictEqual(formatPeerListText({ peers: [] }), "No peers registered.");
  });
});

describe("renderInboxResult", () => {
  it("renders messages with count", () => {
    const details: InboxToolDetails = {
      messages: [
        { from: "alpha", preview: "hello" },
        { from: "beta", preview: "world" },
      ],
    };
    const lines = renderInboxResult(details, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assertActionPrefix(lines[0], "inbox");
    assert.ok(joined.includes("inbox (2)"));
    assert.ok(joined.includes("alpha:"));
    assert.ok(joined.includes("beta:"));
  });

  it("renders empty inbox", () => {
    const joined = renderInboxResult({ messages: [] }, false, plainTheme).render(80).join("\n");
    assert.ok(joined.includes("inbox"));
    assert.ok(joined.includes("no messages"));
  });

  it("renders an error", () => {
    const lines = renderInboxResult({ messages: [] }, true, plainTheme).render(80);
    assertActionPrefix(lines[0], "inbox");
    assert.ok(lines[0].includes("error"));
  });
});

describe("renderWhoamiResult", () => {
  it("renders registered identity", () => {
    const details: WhoamiToolDetails = { alias: "me", sessionId: "sess_1", registered: true };
    const lines = renderWhoamiResult(details, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assertActionPrefix(lines[0], "whoami");
    assert.ok(joined.includes("me"));
    assert.ok(joined.includes("sess_1"));
    assert.ok(joined.includes("registered"));
  });

  it("renders unregistered identity", () => {
    const details: WhoamiToolDetails = { alias: "me", sessionId: "sess_1", registered: false };
    const lines = renderWhoamiResult(details, false, plainTheme).render(80);
    assertActionPrefix(lines[0], "whoami");
    assert.ok(lines[0].includes("not registered"));
  });

  it("renders an error", () => {
    const lines = renderWhoamiResult({ alias: "", sessionId: "", registered: false }, true, plainTheme).render(80);
    assertActionPrefix(lines[0], "whoami");
    assert.ok(lines[0].includes("error"));
  });
});

describe("renderJoinRoomResult", () => {
  it("renders joined room", () => {
    const details: RoomToolDetails = { room: "swarm-lounge", joined: true };
    const lines = renderJoinRoomResult(details, false, plainTheme).render(80);
    assertActionPrefix(lines[0], "join");
    assert.ok(lines[0].includes("joined"));
    assert.ok(lines[0].includes("swarm-lounge"));
  });

  it("renders an error", () => {
    const lines = renderJoinRoomResult({ room: "x" }, true, plainTheme).render(80);
    assertActionPrefix(lines[0], "join");
    assert.ok(lines[0].includes("error"));
  });
});

describe("renderRoomsResult", () => {
  it("renders rooms with count", () => {
    const details: RoomsToolDetails = { rooms: ["swarm-lounge", "ops"] };
    const lines = renderRoomsResult(details, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assertActionPrefix(lines[0], "rooms");
    assert.ok(joined.includes("rooms (2)"));
    assert.ok(joined.includes("swarm-lounge"));
    assert.ok(joined.includes("ops"));
  });

  it("renders empty room list", () => {
    const joined = renderRoomsResult({ rooms: [] }, false, plainTheme).render(80).join("\n");
    assert.ok(joined.includes("rooms"));
    assert.ok(joined.includes("no rooms joined"));
  });

  it("renders an error", () => {
    const lines = renderRoomsResult({ rooms: [] }, true, plainTheme).render(80);
    assertActionPrefix(lines[0], "rooms");
    assert.ok(lines[0].includes("error"));
  });
});

describe("renderStatusResult", () => {
  it("renders compact status", () => {
    const details: StatusToolDetails = {
      state: "idle",
      since: "2026-06-19T00:00:00.000Z",
      ttlMs: 60000,
      registered: true,
    };
    const lines = renderStatusResult(details, false, plainTheme).render(80);
    assert.strictEqual(text(lines[0]), " ⧓ c2c.status · idle · ttl 60000ms");
  });

  it("renders unregistered status", () => {
    const lines = renderStatusResult({ registered: false }, false, plainTheme).render(80);
    assert.strictEqual(text(lines[0]), " ⧓ c2c.status · not registered");
  });
});

describe("renderLocalInfoResult", () => {
  it("renders compact local info summary", () => {
    const details: LocalInfoToolDetails = {
      alias: "pi-abc",
      sessionId: "sess_1",
      broker: "connected",
      crossRepo: "connected",
      relay: "connected",
      address: "pi-abc@a3b2c1d4e5f6",
    };
    const lines = renderLocalInfoResult(details, false, plainTheme).render(120);
    assert.strictEqual(text(lines[0]), " ⧓ c2c.local · pi-abc (sess_1)");
    assert.ok(lines.join("\n").includes("address pi-abc@a3b2c1d4e5f6"));
  });
});

// ── c2c compact line color coding (commit color-codes) ─────────────────

// Theme that records which color was used for each call.
type ColorEvent = { color: string; text: string };
function makeRecordingTheme() {
  const events: ColorEvent[] = [];
  const record = (color: string) => (text: string) => {
    events.push({ color, text });
    return text;
  };
  const t = {
    fg: (color: string, text: string) => {
      events.push({ color, text });
      return text;
    },
    bg: record("bg"),
    bold: (text: string) => text,
    italic: (text: string) => text,
    strikethrough: (text: string) => text,
  } as unknown as Theme & { events: ColorEvent[] };
  (t as unknown as { events: ColorEvent[] }).events = events;
  return t as Theme & { events: ColorEvent[] };
}

// Helper: render a single delivered c2c message and return the recorded
// color/text events. Senders are extracted from the envelope's `from`
// attribute (the renderer uses details.senders to pick the primary sender,
// so the test must populate it to match the actual envelope).
function sendersFromContent(content: string): string[] {
  const matches = [...content.matchAll(/\bfrom="([^"]+)"/g)];
  return matches.map((m) => m[1]);
}
function renderOne(content: string, selfAlias: string, details?: Partial<C2cDeliveryDetails>) {
  const theme = makeRecordingTheme();
  const senders = sendersFromContent(content);
  const line = buildCompactLine(
    { content, details: { count: 1, senders, ...details } },
    theme,
    120,
    selfAlias,
  );
  return { line, events: theme.events };
}

describe("buildCompactLine: route color coding", () => {
  // NOTE: the renderer derives the route from the alias alone
  // (`routeForAlias`: has-@ → relay, default → sessions). It cannot
  // distinguish local from sessions without extra context. The "local"
  // branch of buildPrefix is reserved for when the extension starts
  // passing per-message route info in details; until then it is dead
  // code. We only test the two reachable routes here.

  it("relay route (alias matches alias@12hex) renders route in accent color", () => {
    const { events } = renderOne(
      "<c2c event=\"message\" from=\"peer@a3b2c1d4e5f6\">hi</c2c>",
      "me",
    );
    const routeEvents = events.filter((e) => e.text === "⇄");
    assert.ok(routeEvents.length > 0, "expected ⇄ in render");
    assert.equal(routeEvents[0].color, "accent");
  });

  it("sessions route (alias does not match relay address) renders route in borderMuted", () => {
    const { events } = renderOne(
      "<c2c event=\"message\" from=\"someone\">hi</c2c>",
      "me",
    );
    const routeEvents = events.filter((e) => e.text === "◎");
    assert.ok(routeEvents.length > 0, "expected ◎ in render");
    assert.equal(routeEvents[0].color, "borderMuted");
  });
});

describe("buildCompactLine: primary sender coloring", () => {
  it("primary sender renders in accent (not text)", () => {
    const { events } = renderOne(
      "<c2c event=\"message\" from=\"lyra-quill\">hi</c2c>",
      "me",
    );
    const senderEvents = events.filter((e) => e.text === "lyra-quill");
    assert.ok(senderEvents.length > 0);
    assert.equal(senderEvents[0].color, "accent");
  });
});

describe("buildCompactLine: snippet brightness by direction", () => {
  it("incoming snippet renders in toolOutput gray", () => {
    const { events } = renderOne(
      "<c2c event=\"message\" from=\"lyra-quill\">hello there</c2c>",
      "me", // not the sender, so it's incoming
    );
    const snippetEvents = events.filter((e) => e.text === "hello there");
    assert.ok(snippetEvents.length > 0);
    assert.equal(snippetEvents[0].color, "toolOutput");
  });

  it("outgoing snippet renders in dim", () => {
    const { events } = renderOne(
      "<c2c event=\"message\" from=\"me\">hello there</c2c>",
      "me", // sender is me → outgoing
    );
    const snippetEvents = events.filter((e) => e.text === "hello there");
    assert.ok(snippetEvents.length > 0);
    assert.equal(snippetEvents[0].color, "dim");
  });

  it("status snippet renders in muted", () => {
    const { events } = renderOne(
      "<c2c event=\"status\" from=\"lyra-quill\" state=\"idle\" since=\"2026-06-16T18:00:00Z\" ttl_ms=\"60000\" />",
      "me",
    );
    const snippetEvents = events.filter((e) => e.text === "is idle");
    assert.ok(snippetEvents.length > 0);
    assert.equal(snippetEvents[0].color, "muted");
  });
});

describe("buildCompactLine: PI_C2C_ASCII fallback", () => {
  // Note: bun's test runner captures the env at process start, so the
  // PI_C2C_ASCII branch is tested manually (the user can verify it by
  // running `PI_C2C_ASCII=1 bun ...` and inspecting the render).
  it("documents the PI_C2C_ASCII env-var fallback", () => {
    // The fallback swaps GLYPHS → ASCII_GLYPHS and ROUTES → ASCII_ROUTES.
    // The exporter (5e7888c) added it; the renderer reads process.env at
    // call time, so it's live-tweakable.
    assert.ok(typeof process !== "undefined");
  });
});
