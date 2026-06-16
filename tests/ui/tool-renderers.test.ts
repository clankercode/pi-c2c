import { describe, it } from "node:test";
import assert from "node:assert";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  renderInboxResult,
  renderJoinRoomResult,
  renderListResult,
  renderRoomsResult,
  renderSendCall,
  renderSendResult,
  renderWhoamiResult,
  type InboxToolDetails,
  type ListToolDetails,
  type RoomToolDetails,
  type RoomsToolDetails,
  type SendToolDetails,
  type WhoamiToolDetails,
} from "../../src/ui/tool-renderers.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

describe("renderSendCall", () => {
  it("renders a DM call", () => {
    const lines = renderSendCall({ kind: "dm", target: "lyra-quill" }, plainTheme).render(80);
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes("send → lyra-quill"));
    assert.ok(lines[0].includes("◈ c2c"));
  });

  it("renders a broadcast call", () => {
    const lines = renderSendCall({ kind: "broadcast" }, plainTheme).render(80);
    assert.ok(lines[0].includes("broadcast"));
  });

  it("renders a room send call", () => {
    const lines = renderSendCall({ kind: "room", room: "swarm-lounge" }, plainTheme).render(80);
    assert.ok(lines[0].includes("send to room swarm-lounge"));
  });
});

describe("renderSendResult", () => {
  it("renders a DM success", () => {
    const lines = renderSendResult({ kind: "dm", target: "lyra-quill" }, false, plainTheme).render(80);
    assert.ok(lines[0].includes("sent to lyra-quill"));
  });

  it("renders a broadcast success", () => {
    const lines = renderSendResult({ kind: "broadcast" }, false, plainTheme).render(80);
    assert.ok(lines[0].includes("broadcast sent"));
  });

  it("renders a room send success", () => {
    const lines = renderSendResult({ kind: "room", room: "swarm-lounge" }, false, plainTheme).render(80);
    assert.ok(lines[0].includes("sent to room swarm-lounge"));
  });

  it("renders an error", () => {
    const lines = renderSendResult({ kind: "dm", target: "x" }, true, plainTheme).render(80);
    assert.ok(lines[0].includes("send error"));
  });
});

describe("renderListResult", () => {
  it("renders peers with count", () => {
    const details: ListToolDetails = {
      peers: [
        { alias: "alpha", alive: true },
        { alias: "beta", alive: false, tag: "cross" },
      ],
    };
    const lines = renderListResult(details, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("peers (2)"));
    assert.ok(joined.includes("alpha"));
    assert.ok(joined.includes("beta"));
    assert.ok(joined.includes("[cross-repo]"));
  });

  it("renders relay peers with [relay] tag", () => {
    const details: ListToolDetails = {
      peers: [
        { alias: "remote#a3b2c1d4e5f6", alive: true, tag: "relay" },
      ],
    };
    const lines = renderListResult(details, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("remote#a3b2c1d4e5f6"));
    assert.ok(joined.includes("[relay]"));
    assert.ok(!joined.includes("[cross-repo]"));
  });

  it("renders empty peer list", () => {
    const lines = renderListResult({ peers: [] }, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("peers"));
    assert.ok(joined.includes("no peers registered"));
  });

  it("renders an error", () => {
    const lines = renderListResult({ peers: [] }, true, plainTheme).render(80);
    assert.ok(lines[0].includes("peers error"));
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
    assert.ok(joined.includes("inbox (2)"));
    assert.ok(joined.includes("alpha:"));
    assert.ok(joined.includes("beta:"));
  });

  it("renders empty inbox", () => {
    const lines = renderInboxResult({ messages: [] }, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("inbox"));
    assert.ok(joined.includes("no messages"));
  });

  it("renders an error", () => {
    const lines = renderInboxResult({ messages: [] }, true, plainTheme).render(80);
    assert.ok(lines[0].includes("inbox error"));
  });
});

describe("renderWhoamiResult", () => {
  it("renders registered identity", () => {
    const details: WhoamiToolDetails = { alias: "me", sessionId: "sess_1", registered: true };
    const lines = renderWhoamiResult(details, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("me"));
    assert.ok(joined.includes("sess_1"));
    assert.ok(joined.includes("registered"));
  });

  it("renders unregistered identity", () => {
    const details: WhoamiToolDetails = { alias: "me", sessionId: "sess_1", registered: false };
    const lines = renderWhoamiResult(details, false, plainTheme).render(80);
    assert.ok(lines[0].includes("not registered"));
  });

  it("renders an error", () => {
    const lines = renderWhoamiResult({ alias: "", sessionId: "", registered: false }, true, plainTheme).render(80);
    assert.ok(lines[0].includes("whoami error"));
  });
});

describe("renderJoinRoomResult", () => {
  it("renders joined room", () => {
    const details: RoomToolDetails = { room: "swarm-lounge", joined: true };
    const lines = renderJoinRoomResult(details, false, plainTheme).render(80);
    assert.ok(lines[0].includes("joined room swarm-lounge"));
  });

  it("renders an error", () => {
    const lines = renderJoinRoomResult({ room: "x" }, true, plainTheme).render(80);
    assert.ok(lines[0].includes("join room error"));
  });
});

describe("renderRoomsResult", () => {
  it("renders rooms with count", () => {
    const details: RoomsToolDetails = { rooms: ["swarm-lounge", "ops"] };
    const lines = renderRoomsResult(details, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("rooms (2)"));
    assert.ok(joined.includes("swarm-lounge"));
    assert.ok(joined.includes("ops"));
  });

  it("renders empty room list", () => {
    const lines = renderRoomsResult({ rooms: [] }, false, plainTheme).render(80);
    const joined = lines.join("\n");
    assert.ok(joined.includes("rooms"));
    assert.ok(joined.includes("no rooms joined"));
  });

  it("renders an error", () => {
    const lines = renderRoomsResult({ rooms: [] }, true, plainTheme).render(80);
    assert.ok(lines[0].includes("rooms error"));
  });
});
