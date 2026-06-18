import { sanitizeAlias } from "./identity.ts";

const SUBAGENT_HINT_KEY = Symbol.for("pi-subagents:extension-depth");
const GLOBAL_KEY = "__piC2cSubagents";

export interface SubagentLoadHint {
  depth: number;
  agentId?: string;
}

export interface SubagentRegistration {
  agentId?: string;
  alias: string;
}

/**
 * Structured metadata passed to the parent via `pi.sendMessage(...).details`
 * when a subagent registers. The renderer reads this rather than parsing the
 * model-facing `content` string. Missing `agentId` means the registration
 * came in without a subagent-id hint (generic "Subagent").
 */
export interface SubagentRegistrationDetails {
  agentId?: string;
  alias: string;
}

/**
 * Wire-shape builder for the subagent-registration injection. Concentrates
 * `customType`, `display`, `details`, and delivery options in one place so
 * the index wiring is a thin wrapper and tests can verify the shape
 * without mocking the pi runtime.
 */
export interface RegistrationMessageArgs {
  message: {
    customType: "c2c-subagent-registration";
    content: string;
    display: true;
    details: SubagentRegistrationDetails;
  };
  options: { triggerTurn: true; deliverAs: "steer" };
}

export function buildRegistrationMessageArgs(
  notice: string,
  registration: SubagentRegistration,
): RegistrationMessageArgs {
  return {
    message: {
      customType: "c2c-subagent-registration",
      content: notice,
      display: true,
      details: {
        agentId: registration.agentId,
        alias: registration.alias,
      },
    },
    options: { triggerTurn: true, deliverAs: "steer" },
  };
}

interface SubagentGlobal {
  observers: Set<(notice: string, registration: SubagentRegistration) => void>;
  seenAliases: Set<string>;
  parentAlias?: string;
}

function state(): SubagentGlobal {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      observers: new Set(),
      seenAliases: new Set(),
    } satisfies SubagentGlobal;
  }
  return g[GLOBAL_KEY] as SubagentGlobal;
}

export function readSubagentLoadHint(): SubagentLoadHint | null {
  const value = (globalThis as Record<symbol, unknown>)[SUBAGENT_HINT_KEY];
  if (!value || typeof value !== "object") return null;
  const rec = value as Record<string, unknown>;
  const depth = rec.depth;
  if (typeof depth !== "number" || !Number.isFinite(depth) || depth <= 0) return null;
  const agentId = typeof rec.agentId === "string" ? rec.agentId : undefined;
  return { depth, agentId };
}

export function setParentAlias(alias: string | undefined): void {
  state().parentAlias = alias ? sanitizeAlias(alias) : undefined;
}

export function getParentAlias(): string | undefined {
  return state().parentAlias;
}

export function appendSubagentPromptContext(
  systemPrompt: string,
  opts: { selfAlias: string; parentAlias: string },
): string {
  return `${systemPrompt}

## c2c parent link

Your c2c alias is \`${opts.selfAlias}\`.
Your parent c2c alias is \`${opts.parentAlias}\`.
To report progress or ask the parent a question, call \`c2c_pi_send(target="${opts.parentAlias}", body="<message>")\`.`;
}

export function observeSubagentRegistrations(
  observer: (notice: string, registration: SubagentRegistration) => void,
): () => void {
  const s = state();
  s.observers.add(observer);
  return () => {
    s.observers.delete(observer);
  };
}

export function notifySubagentRegistered(registration: SubagentRegistration): void {
  const s = state();
  if (s.seenAliases.has(registration.alias)) return;
  s.seenAliases.add(registration.alias);
  const label = registration.agentId?.trim() || "Subagent";
  const notice = `Subagent ${label} registered as \`${registration.alias}\`.`;
  for (const observer of s.observers) {
    observer(notice, registration);
  }
}
