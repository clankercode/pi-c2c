import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendSubagentPromptContext,
  notifySubagentRegistered,
  observeSubagentRegistrations,
  readSubagentLoadHint,
} from "../src/subagent.ts";

const HINT_KEY = Symbol.for("pi-subagents:extension-depth");

test("readSubagentLoadHint: captures depth and agent id from pi-subagents global", () => {
  const g = globalThis as Record<symbol, unknown>;
  const previous = g[HINT_KEY];
  g[HINT_KEY] = { depth: 2, agentId: "Plan#abc123" };
  try {
    assert.deepEqual(readSubagentLoadHint(), { depth: 2, agentId: "Plan#abc123" });
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

test("observeSubagentRegistrations: parent observer sees one notice per child alias", () => {
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
