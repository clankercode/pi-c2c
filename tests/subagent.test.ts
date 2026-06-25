import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendSubagentPromptContext,
  notifySubagentRegistered,
  observeSubagentRegistrations,
  observeSubagentRegistrationsFor,
  readSubagentLoadHint,
} from "../src/subagent.ts";

const HINT_KEY = Symbol.for("pi-subagents:extension-depth");

test("readSubagentLoadHint: captures depth, agent id, and parent agent id", () => {
  const g = globalThis as Record<symbol, unknown>;
  const previous = g[HINT_KEY];
  g[HINT_KEY] = { depth: 2, agentId: "Plan#abc123", parentAgentId: "coord-id" };
  try {
    assert.deepEqual(readSubagentLoadHint(), { depth: 2, agentId: "Plan#abc123", parentAgentId: "coord-id" });
  } finally {
    if (previous === undefined) delete g[HINT_KEY];
    else g[HINT_KEY] = previous;
  }
});

test("readSubagentLoadHint: parentAgentId is undefined when not in hint", () => {
  const g = globalThis as Record<symbol, unknown>;
  const previous = g[HINT_KEY];
  g[HINT_KEY] = { depth: 1, agentId: "child" };
  try {
    const hint = readSubagentLoadHint();
    assert.deepEqual(hint, { depth: 1, agentId: "child", parentAgentId: undefined });
  } finally {
    if (previous === undefined) delete g[HINT_KEY];
    else g[HINT_KEY] = previous;
  }
});

test("appendSubagentPromptContext: includes self alias, parent alias, and exact send usage", () => {
  const out = appendSubagentPromptContext("base prompt", {
    selfAlias: "parent-a123456",
    parentAlias: "parent",
  });
  assert.match(out, /^base prompt/);
  assert.match(out, /Your c2c alias is `parent-a123456`/);
  assert.match(out, /Your parent c2c alias is `parent`/);
  assert.match(out, /c2c_pi_send\(target="parent"/);
});

test("observeSubagentRegistrations: root observer sees one notice per child alias (no parentAgentId)", () => {
  const notices: string[] = [];
  const stop = observeSubagentRegistrations((notice) => notices.push(notice));
  try {
    notifySubagentRegistered({ agentId: "Plan#abc123", alias: "parent-a123456" });
    notifySubagentRegistered({ agentId: "Plan#abc123", alias: "parent-a123456" });
    notifySubagentRegistered({ agentId: "Explore#def456", alias: "parent-a654321" });
  } finally {
    stop();
  }
  assert.deepEqual(notices, [
    "Subagent Plan#abc123 registered as `parent-a123456`.",
    "Subagent Explore#def456 registered as `parent-a654321`.",
  ]);
});

test("notifySubagentRegistered: routes to parent observer when parentAgentId matches", () => {
  const parentNotices: string[] = [];
  const rootNotices: string[] = [];
  const stopRoot = observeSubagentRegistrations((notice) => rootNotices.push(notice));
  const stopParent = observeSubagentRegistrationsFor("impl-agent", (notice) => parentNotices.push(notice));
  try {
    // This should route to the parent observer, not root
    notifySubagentRegistered({
      agentId: "reviewer-1",
      alias: "impl-a123456",
      parentAgentId: "impl-agent",
    });
  } finally {
    stopParent();
    stopRoot();
  }
  assert.deepEqual(parentNotices, ["Subagent reviewer-1 registered as `impl-a123456`."],
    "parent observer should receive the notification");
  assert.deepEqual(rootNotices, [],
    "root observer should NOT receive the notification when parent observer handles it");
});

test("notifySubagentRegistered: falls back to root observer when parentAgentId has no observer", () => {
  const rootNotices: string[] = [];
  const stopRoot = observeSubagentRegistrations((notice) => rootNotices.push(notice));
  try {
    // parentAgentId points to a non-existent observer — should fall back to root
    notifySubagentRegistered({
      agentId: "reviewer-2",
      alias: "impl-b654321",
      parentAgentId: "nonexistent-agent",
    });
  } finally {
    stopRoot();
  }
  assert.deepEqual(rootNotices, ["Subagent reviewer-2 registered as `impl-b654321`."],
    "root observer should receive the notification as fallback");
});
