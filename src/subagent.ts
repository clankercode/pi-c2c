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
