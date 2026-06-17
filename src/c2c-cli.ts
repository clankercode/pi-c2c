/**
 * Typed wrapper around the `c2c` CLI.
 *
 * The CLI is the always-available c2c surface; we shell out to it with
 * `--json` and parse the result. The exec boundary is injected (`ExecFn`) so
 * the extension can pass `pi.exec` in production and tests can pass a fake —
 * no real `c2c` process is ever spawned in unit tests.
 *
 * Broker-root override: the c2c CLI reads `C2C_MCP_BROKER_ROOT` from the
 * environment to pick which broker to talk to. The extension can pass a
 * per-call `brokerRoot` to `run()` (and the high-level wrappers) to point a
 * specific call at a non-default broker — the sessions broker for
 * cross-repo rendezvous, the per-repo broker for local-repo coordination.
 *
 * JSON contracts (from ocaml/cli/c2c.ml, verified against the live binary):
 *   whoami --json     → { session_id, alias, ... }
 *   list --json       → [ { alias, session_id, alive, lastSeenAge? }, ... ]
 *   poll-inbox --json → [ { from_alias, to_alias, content, ts }, ... ]
 */

/** Minimal shape of a command execution result (a superset of pi's ExecResult). */
export interface ExecResultLike {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injectable command runner. In production this wraps `pi.exec`. */
export type ExecFn = (
  command: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
) => Promise<ExecResultLike>;

/** A c2c inbox message envelope. */
export interface C2cMessage {
  from_alias: string;
  to_alias: string;
  content: string;
  ts: number;
  /**
   * When true, the receiver should use followUp delivery (no interrupt,
   * no steer) instead of the default triggerTurn+steer. Set by the sender
   * (c2c_pi_send with nonurgent=true). Optional — when absent, default to
   * urgent (c2c messages are high-priority by default).
   */
  nonurgent?: boolean;
}

/** A peer as reported by `c2c list --json`. The base output carries
 * `session_id`, `alias`, `alive`, and `registered_at` (epoch seconds); a
 * formatted `last_seen` string only appears with `--enriched`. */
export interface C2cPeer {
  alias: string;
  session_id: string;
  alive: boolean;
  registered_at?: number;
}

/** Identity as reported by `c2c whoami`. */
export interface C2cWhoami {
  session_id: string;
  alias: string;
}

/** Raised when a `c2c` invocation exits non-zero. */
export class C2cError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "C2cError";
  }
}

/**
 * Resolve the sessions broker root — the cross-repo rendezvous broker used
 * by Claude PostToolUse / kimi notifier, and by pi-c2c's cross-repo mode.
 * Mirrors `C2c_repo_fp.resolve_sessions_broker_root` in
 * `ocaml/c2c_repo_fp.ml` exactly so the extension and the CLI agree.
 *
 *   1. $C2C_SESSIONS_BROKER_ROOT (explicit override)
 *   2. $XDG_STATE_HOME/sessions/broker
 *   3. $HOME/.c2c/sessions/broker
 */
export function resolveSessionsBrokerRoot(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = process.env.HOME ?? "",
  xdgStateHome: string = process.env.XDG_STATE_HOME ?? "",
): string {
  const explicit = (env.C2C_SESSIONS_BROKER_ROOT ?? "").trim();
  if (explicit) return explicit;
  if (xdgStateHome.trim()) return `${xdgStateHome.trim()}/sessions/broker`;
  if (homedir) return `${homedir}/.c2c/sessions/broker`;
  return ".c2c/sessions/broker";
}

/**
 * Set C2C_MCP_BROKER_ROOT for the duration of a single c2c invocation.
 * Returns a restore function. Threading the env var (rather than a CLI flag)
 * is what the c2c CLI actually reads — there's no --broker-root flag.
 */
function setBrokerRootEnv(target: string | undefined): () => void {
  const KEY = "C2C_MCP_BROKER_ROOT";
  if (!target) {
    // No override: leave the process-level env untouched so we don't
    // clobber a value the user exported in their shell.
    return () => {};
  }
  const previous = process.env[KEY];
  process.env[KEY] = target;
  return () => {
    if (previous === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = previous;
    }
  };
}

/**
 * Set or clear C2C_MCP_SESSION_ID for the duration of a single c2c invocation.
 * Returns a restore function.
 *   - `undefined` (or missing): leave the process-level env untouched.
 *   - `null`: delete the env var for this invocation.
 *   - string: set the env var to this value for this invocation.
 */
function setSessionIdEnv(target: string | null | undefined): () => void {
  const KEY = "C2C_MCP_SESSION_ID";
  if (target === undefined) {
    return () => {};
  }
  const previous = process.env[KEY];
  if (target === null) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = target;
  }
  return () => {
    if (previous === undefined) {
      delete process.env[KEY];
    } else {
      process.env[KEY] = previous;
    }
  };
}

// --- Pure parsers (unit-tested in isolation) --------------------------------

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Parse `poll-inbox --json` / `peek-inbox --json` output into messages. */
export function parseMessages(stdout: string): C2cMessage[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: C2cMessage[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    // A valid message must carry sender + content.
    if (typeof r.from_alias !== "string" || typeof r.content !== "string") continue;
    out.push({
      from_alias: r.from_alias,
      to_alias: asString(r.to_alias),
      content: r.content,
      ts: typeof r.ts === "number" ? r.ts : 0,
    });
  }
  return out;
}

/** Parse `list --json` output into peers. */
export function parsePeers(stdout: string): C2cPeer[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: C2cPeer[] = [];
  for (const raw of data) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.alias !== "string") continue;
    const peer: C2cPeer = {
      alias: r.alias,
      session_id: asString(r.session_id),
      alive: r.alive === true,
    };
    if (typeof r.registered_at === "number") peer.registered_at = r.registered_at;
    out.push(peer);
  }
  return out;
}

/** Parse `rooms my-rooms --json` into a list of room ids. Tolerant of either
 * a bare string array or an array of objects keyed `room`/`name`/`id`. */
export function parseRoomList(stdout: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const raw of data) {
    if (typeof raw === "string") {
      if (raw) out.push(raw);
      continue;
    }
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      const id = r.room_id ?? r.room ?? r.name ?? r.id;
      if (typeof id === "string" && id) out.push(id);
    }
  }
  return out;
}

/** Parse `whoami --json` output into an identity, or null if unusable. */
export function parseWhoami(stdout: string): C2cWhoami | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  if (typeof r.session_id !== "string" || r.session_id.length === 0) return null;
  return { session_id: r.session_id, alias: asString(r.alias) };
}

// --- Relay types and parsers ------------------------------------------------

/** Local Ed25519 identity as reported by `c2c relay identity show --json`. */
export interface RelayIdentity {
  path: string;
  publicKey: string;
  fingerprint: string;
  aliasHint: string;
  createdAt: string;
}

/** A peer registered on a c2c relay, from `c2c relay list --json`. */
export interface RelayPeer {
  nodeId: string;
  sessionId: string;
  alias: string;
  clientType: string;
  registeredAt: number;
  lastSeen: number;
  ttl: number;
  alive: boolean;
  identityPk: string;
}

/** Result of `c2c relay register --json`. */
export interface RelayRegisterResult {
  alias: string;
  sessionId: string;
  nodeId: string;
  registeredAt: number;
  ttl: number;
  alive: boolean;
  /** Opaque host id returned by the relay when the alias includes the #<hostid> suffix. */
  opaqueHostId?: string;
}

/** A direct message delivered via a c2c relay, from `c2c relay dm poll --json`. */
export interface RelayMessage {
  messageId: string;
  fromAlias: string;
  toAlias: string;
  content: string;
  ts: number;
}

/** Common relay JSON envelope: `{ ok: true, ... }` or `{ ok: false, error_code, error }`. */
function parseRelayOk(stdout: string): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  if (!data || typeof data !== "object") return { ok: false, error: "not an object" };
  const r = data as Record<string, unknown>;
  if (r.ok !== true) {
    const msg = typeof r.error === "string" ? r.error : "relay command failed";
    return { ok: false, error: msg };
  }
  return { ok: true, data: r };
}

/** Parse `c2c relay identity show --json` output. */
export function parseRelayIdentity(stdout: string): RelayIdentity | null {
  const parsed = parseRelayOk(stdout);
  if (!parsed.ok) return null;
  const r = parsed.data;
  if (typeof r.public_key !== "string" || typeof r.fingerprint !== "string") return null;
  return {
    path: asString(r.path),
    publicKey: r.public_key,
    fingerprint: r.fingerprint,
    aliasHint: asString(r.alias_hint),
    createdAt: asString(r.created_at),
  };
}

/** Parse `c2c relay list --json` output. */
export function parseRelayPeers(stdout: string): RelayPeer[] {
  const parsed = parseRelayOk(stdout);
  if (!parsed.ok) return [];
  const peers = parsed.data.peers;
  if (!Array.isArray(peers)) return [];
  const out: RelayPeer[] = [];
  for (const raw of peers) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.alias !== "string") continue;
    out.push({
      nodeId: asString(p.node_id),
      sessionId: asString(p.session_id),
      alias: p.alias,
      clientType: asString(p.client_type),
      registeredAt: typeof p.registered_at === "number" ? p.registered_at : 0,
      lastSeen: typeof p.last_seen === "number" ? p.last_seen : 0,
      ttl: typeof p.ttl === "number" ? p.ttl : 0,
      alive: p.alive === true,
      identityPk: asString(p.identity_pk),
    });
  }
  return out;
}

/** Parse `c2c relay register --json` output. */
export function parseRelayRegister(stdout: string): RelayRegisterResult | null {
  const parsed = parseRelayOk(stdout);
  if (!parsed.ok) return null;
  const lease = parsed.data.lease;
  if (!lease || typeof lease !== "object") return null;
  const l = lease as Record<string, unknown>;
  if (typeof l.alias !== "string") return null;
  return {
    alias: l.alias,
    sessionId: asString(l.session_id),
    nodeId: asString(l.node_id),
    registeredAt: typeof l.registered_at === "number" ? l.registered_at : 0,
    ttl: typeof l.ttl === "number" ? l.ttl : 0,
    alive: l.alive === true,
    opaqueHostId: typeof l.opaque_host_id === "string" ? l.opaque_host_id : undefined,
  };
}

/** Parse `c2c relay dm poll --json` output. */
export function parseRelayMessages(stdout: string): RelayMessage[] {
  const parsed = parseRelayOk(stdout);
  if (!parsed.ok) return [];
  const msgs = parsed.data.messages;
  if (!Array.isArray(msgs)) return [];
  const out: RelayMessage[] = [];
  for (const raw of msgs) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.content !== "string" || typeof m.from_alias !== "string") continue;
    out.push({
      messageId: asString(m.message_id),
      fromAlias: m.from_alias,
      toAlias: asString(m.to_alias),
      content: m.content,
      ts: typeof m.ts === "number" ? m.ts : 0,
    });
  }
  return out;
}

/** Strip the `SHA256:` prefix from `c2c relay identity fingerprint` output. */
export function parseRelayFingerprint(stdout: string): string {
  return stdout.trim().replace(/^SHA256:/, "");
}

// --- CLI wrapper ------------------------------------------------------------

export interface C2cCliOptions {
  exec: ExecFn;
  /** Path to the c2c binary (default: $C2C_BIN or "c2c"). */
  bin?: string;
  /** Session id to scope inbox/identity commands to. */
  sessionId?: string;
  /** Per-invocation timeout in ms (default 15000). */
  timeoutMs?: number;
  /**
   * Default broker root (sets C2C_MCP_BROKER_ROOT for every invocation).
   * Use to scope the client to a specific broker — the sessions broker for
   * cross-repo rendezvous, or a custom shared broker. When unset, the
   * process-level C2C_MCP_BROKER_ROOT (or the c2c CLI's default) wins.
   */
  brokerRoot?: string;
}

export class C2cCli {
  private readonly exec: ExecFn;
  private readonly bin: string;
  private readonly timeoutMs: number;
  sessionId?: string;
  /** Default broker root for this client; set per-instance for cross-repo
   *  sessions broker, etc. Cleared between calls if `run()` is given an
   *  explicit `brokerRoot`. */
  brokerRoot?: string;

  constructor(opts: C2cCliOptions) {
    this.exec = opts.exec;
    this.bin = opts.bin ?? process.env.C2C_BIN ?? "c2c";
    this.sessionId = opts.sessionId;
    this.brokerRoot = opts.brokerRoot;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  /** Run a raw `c2c` invocation. Throws C2cError on non-zero exit. */
  async run(
    args: string[],
    opts?: { signal?: AbortSignal; brokerRoot?: string; sessionId?: string | null },
  ): Promise<ExecResultLike> {
    const target = opts?.brokerRoot ?? this.brokerRoot;
    const restoreBroker = setBrokerRootEnv(target);
    // Default to the client's session id so send/send-all/send-room and
    // other env-resolved commands work even when process.env was cleared
    // by a prior call or the tool runs in a subprocess. Relay calls pass
    // `sessionId: null` explicitly to clear it.
    const sessionIdTarget = opts?.sessionId === undefined ? this.sessionId : opts.sessionId;
    const restoreSession = setSessionIdEnv(sessionIdTarget);
    try {
      const res = await this.exec(this.bin, args, {
        timeout: this.timeoutMs,
        signal: opts?.signal,
      });
      if (res.code !== 0) {
        const detail = (res.stderr || res.stdout || "").trim();
        throw new C2cError(
          `c2c ${args[0] ?? ""} failed (exit ${res.code}): ${detail}`,
          res.code,
          res.stderr,
        );
      }
      return res;
    } finally {
      restoreSession();
      restoreBroker();
    }
  }

  private withSession(args: string[]): string[] {
    return this.sessionId ? [...args, "--session-id", this.sessionId] : args;
  }

  async whoami(opts?: { brokerRoot?: string }): Promise<C2cWhoami | null> {
    // `whoami` resolves identity from the C2C_MCP_SESSION_ID env var; it does
    // NOT accept --session-id (the CLI rejects it with exit 124).
    const res = await this.run(["whoami", "--json"], { brokerRoot: opts?.brokerRoot });
    return parseWhoami(res.stdout);
  }

  async list(opts?: { brokerRoot?: string }): Promise<C2cPeer[]> {
    const res = await this.run(["list", "--json"], { brokerRoot: opts?.brokerRoot });
    return parsePeers(res.stdout);
  }

  /** Register `alias` against `sessionId`, then scope this client to it. */
  async register(
    alias: string,
    sessionId: string,
    opts?: { brokerRoot?: string },
  ): Promise<C2cWhoami | null> {
    const res = await this.run(
      ["register", "--alias", alias, "--session-id", sessionId, "--json"],
      { brokerRoot: opts?.brokerRoot },
    );
    this.sessionId = sessionId;
    return parseWhoami(res.stdout);
  }

  /** Drain (or peek) the inbox for the configured session. */
  async pollInbox(
    opts?: { peek?: boolean; signal?: AbortSignal; brokerRoot?: string },
  ): Promise<C2cMessage[]> {
    const args = this.withSession(["poll-inbox", "--json"]);
    if (opts?.peek) args.push("--peek");
    const res = await this.run(args, { signal: opts?.signal, brokerRoot: opts?.brokerRoot });
    return parseMessages(res.stdout);
  }

  /** Send a DM to `target`. `from` overrides the sender alias when set
   * (normally identity is resolved from the C2C_MCP_SESSION_ID env). The `--`
   * separator guards against a target/body beginning with `-`. */
  async send(
    target: string,
    body: string,
    opts?: { from?: string; brokerRoot?: string },
  ): Promise<void> {
    const args = ["send"];
    if (opts?.from) args.push("--from", opts.from);
    args.push("--", target, body);
    await this.run(args, { brokerRoot: opts?.brokerRoot });
  }

  /** Broadcast to all peers. `from` overrides the sender alias when set. */
  async sendAll(body: string, opts?: { from?: string; exclude?: string[] }): Promise<void> {
    const args = ["send-all"];
    if (opts?.from) args.push("--from", opts.from);
    if (opts?.exclude?.length) args.push("--exclude", opts.exclude.join(","));
    args.push("--", body);
    await this.run(args);
  }

  // --- rooms ----------------------------------------------------------------

  /** Join a room as `alias`. */
  async joinRoom(room: string, alias: string): Promise<void> {
    await this.run(["rooms", "join", "--alias", alias, "--", room]);
  }

  /** Leave a room as `alias`. */
  async leaveRoom(room: string, alias: string): Promise<void> {
    await this.run(["rooms", "leave", "--alias", alias, "--", room]);
  }

  /** Send a message to a room. `from` overrides the sender alias when set
   * (normally resolved from the C2C_MCP_SESSION_ID env). */
  async sendRoom(room: string, body: string, opts?: { from?: string }): Promise<void> {
    const args = ["rooms", "send"];
    if (opts?.from) args.push("--from", opts.from);
    args.push("--", room, body);
    await this.run(args);
  }

  /** List the rooms this session is a member of. */
  async myRooms(): Promise<string[]> {
    const res = await this.run(["rooms", "my-rooms", "--json"]);
    return parseRoomList(res.stdout);
  }

  /** Fetch recent room history. */
  async roomHistory(room: string, limit = 50): Promise<C2cMessage[]> {
    const res = await this.run(["rooms", "history", "--json", "--limit", String(limit), "--", room]);
    return parseMessages(res.stdout);
  }

  // --- relay ----------------------------------------------------------------

  /** Show the local Ed25519 relay identity. */
  async relayIdentity(opts?: { signal?: AbortSignal }): Promise<RelayIdentity | null> {
    const res = await this.run(["relay", "identity", "show", "--json"], {
      signal: opts?.signal,
      sessionId: null,
    });
    return parseRelayIdentity(res.stdout);
  }

  /** Print just the SHA256 fingerprint of the local relay identity. */
  async relayFingerprint(opts?: { signal?: AbortSignal }): Promise<string> {
    const res = await this.run(["relay", "identity", "fingerprint"], {
      signal: opts?.signal,
      sessionId: null,
    });
    return parseRelayFingerprint(res.stdout);
  }

  /** Configure the relay connection (persists URL/token for future commands). */
  async relaySetup(opts?: { url?: string; token?: string; signal?: AbortSignal }): Promise<void> {
    const args = ["relay", "setup"];
    if (opts?.url) args.push("--url", opts.url);
    if (opts?.token) args.push("--token", opts.token);
    await this.run(args, { signal: opts?.signal, sessionId: null });
  }

  /** Show current relay configuration. Returns the parsed JSON or null. */
  async relaySetupShow(opts?: { signal?: AbortSignal }): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.run(["relay", "setup", "--show"], {
        signal: opts?.signal,
        sessionId: null,
      });
      const parsed = JSON.parse(res.stdout);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  /** Register a derived alias on the configured relay. */
  async relayRegister(
    alias: string,
    opts?: { relayUrl?: string; token?: string; signal?: AbortSignal },
  ): Promise<RelayRegisterResult | null> {
    const args = ["relay", "register", "--alias", alias];
    if (opts?.relayUrl) args.push("--relay-url", opts.relayUrl);
    if (opts?.token) args.push("--token", opts.token);
    const res = await this.run(args, { signal: opts?.signal, sessionId: null });
    return parseRelayRegister(res.stdout);
  }

  /** List peers registered on the relay. */
  async relayList(opts?: { relayUrl?: string; token?: string; signal?: AbortSignal }): Promise<RelayPeer[]> {
    const args = ["relay", "list"];
    if (opts?.relayUrl) args.push("--relay-url", opts.relayUrl);
    if (opts?.token) args.push("--token", opts.token);
    const res = await this.run(args, { signal: opts?.signal, sessionId: null });
    return parseRelayPeers(res.stdout);
  }

  /** Poll the relay inbox for `alias`. */
  async relayDmPoll(
    alias: string,
    opts?: { relayUrl?: string; token?: string; signal?: AbortSignal },
  ): Promise<RelayMessage[]> {
    const args = ["relay", "dm", "poll", "--alias", alias];
    if (opts?.relayUrl) args.push("--relay-url", opts.relayUrl);
    if (opts?.token) args.push("--token", opts.token);
    const res = await this.run(args, { signal: opts?.signal, sessionId: null });
    return parseRelayMessages(res.stdout);
  }

  /** Send a DM to `target` via the relay, from `alias`. */
  async relayDmSend(
    target: string,
    body: string,
    alias: string,
    opts?: { relayUrl?: string; token?: string; signal?: AbortSignal },
  ): Promise<void> {
    const args = ["relay", "dm", "send", "--alias", alias, "--", target, body];
    if (opts?.relayUrl) args.push("--relay-url", opts.relayUrl);
    if (opts?.token) args.push("--token", opts.token);
    await this.run(args, { signal: opts?.signal, sessionId: null });
  }

  /** Broadcast a message to all relay peers, from `alias`. */
  async relayDmSendAll(
    body: string,
    alias: string,
    opts?: { relayUrl?: string; token?: string; signal?: AbortSignal },
  ): Promise<void> {
    const args = ["relay", "dm", "send-all", "--alias", alias, "--", body];
    if (opts?.relayUrl) args.push("--relay-url", opts.relayUrl);
    if (opts?.token) args.push("--token", opts.token);
    await this.run(args, { signal: opts?.signal, sessionId: null });
  }
}
