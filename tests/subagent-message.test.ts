import { describe, it } from "node:test";
import assert from "node:assert";
import {
  buildRegistrationMessageArgs,
  notifySubagentRegistered,
  observeSubagentRegistrations,
} from "../src/subagent.ts";
import type { SubagentRegistrationDetails } from "../src/subagent.ts";

describe("buildRegistrationMessageArgs", () => {
  it("returns the canonical customType, content, display, and details", () => {
    const args = buildRegistrationMessageArgs(
      "Subagent Plan#abc123 registered as `parent-a123456`.",
      { agentId: "Plan#abc123", alias: "parent-a123456" },
    );
    assert.strictEqual(args.message.customType, "c2c-subagent-registration");
    assert.strictEqual(
      args.message.content,
      "Subagent Plan#abc123 registered as `parent-a123456`.",
    );
    assert.strictEqual(args.message.display, true);
    const expectedDetails: SubagentRegistrationDetails = {
      agentId: "Plan#abc123",
      alias: "parent-a123456",
    };
    assert.deepStrictEqual(args.message.details, expectedDetails);
  });

  it("returns triggerTurn+steer delivery options (urgent)", () => {
    const args = buildRegistrationMessageArgs(
      "Subagent Plan#abc123 registered as `parent-a123456`.",
      { agentId: "Plan#abc123", alias: "parent-a123456" },
    );
    assert.deepStrictEqual(args.options, {
      triggerTurn: true,
      deliverAs: "steer",
    });
  });

  it("preserves undefined agentId in details when missing from registration", () => {
    const args = buildRegistrationMessageArgs(
      "Subagent Subagent registered as `pi-ae17fe-a00a220`.",
      { alias: "pi-ae17fe-a00a220" },
    );
    assert.deepStrictEqual(args.message.details, {
      agentId: undefined,
      alias: "pi-ae17fe-a00a220",
    });
  });
});

describe("observeSubagentRegistrations → buildRegistrationMessageArgs wiring", () => {
  it("observer receives registration so the caller can build the message args", () => {
    const captured: Array<{ notice: string; alias: string; agentId?: string }> = [];
    const stop = observeSubagentRegistrations((notice, registration) => {
      captured.push({
        notice,
        alias: registration.alias,
        agentId: registration.agentId,
      });
    });
    try {
      notifySubagentRegistered({ agentId: "Plan#abc123", alias: "parent-a123456" });
      notifySubagentRegistered({ alias: "pi-ae17fe-a00a220" });
    } finally {
      stop();
    }
    assert.deepStrictEqual(captured, [
      { notice: "Subagent Plan#abc123 registered as `parent-a123456`.", alias: "parent-a123456", agentId: "Plan#abc123" },
      { notice: "Subagent Subagent registered as `pi-ae17fe-a00a220`.", alias: "pi-ae17fe-a00a220", agentId: undefined },
    ]);
  });

  it("end-to-end: registration → observer → buildRegistrationMessageArgs produces the wire shape", () => {
    const captured: ReturnType<typeof buildRegistrationMessageArgs>[] = [];
    const stop = observeSubagentRegistrations((notice, registration) => {
      captured.push(buildRegistrationMessageArgs(notice, registration));
    });
    try {
      notifySubagentRegistered({ agentId: "Explore#def456", alias: "parent-b654321" });
    } finally {
      stop();
    }
    assert.strictEqual(captured.length, 1, "observer should have fired exactly once");
    const args = captured[0];
    assert.strictEqual(args.message.customType, "c2c-subagent-registration");
    assert.strictEqual(args.message.details.agentId, "Explore#def456");
    assert.strictEqual(args.message.details.alias, "parent-b654321");
    assert.deepStrictEqual(args.options, {
      triggerTurn: true,
      deliverAs: "steer",
    });
  });
});