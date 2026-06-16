/**
 * Typed wrapper around the `c2c` CLI.
 *
 * The CLI is the always-available c2c surface; we shell out to it with
 * `--json` and parse the result. The exec boundary is injected (`ExecFn`) so
 * the extension can pass `pi.exec` in production and tests can pass a fake —
 * no real `c2c` process is ever spawned in unit tests.
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

// --- CLI wrapper ------------------------------------------------------------

export interface C2cCliOptions {
  exec: ExecFn;
  /** Path to the c2c binary (default: $C2C_BIN or "c2c"). */
  bin?: string;
  /** Session id to scope inbox/identity commands to. */
  sessionId?: string;
  /** Per-invocation timeout in ms (default 15000). */
  timeoutMs?: number;
}

export class C2cCli {
  private readonly exec: ExecFn;
  private readonly bin: string;
  private readonly timeoutMs: number;
  sessionId?: string;

  constructor(opts: C2cCliOptions) {
    this.exec = opts.exec;
    this.bin = opts.bin ?? process.env.C2C_BIN ?? "c2c";
    this.sessionId = opts.sessionId;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  /** Run a raw `c2c` invocation. Throws C2cError on non-zero exit. */
  async run(args: string[], opts?: { signal?: AbortSignal }): Promise<ExecResultLike> {
    const res = await this.exec(this.bin, args, { timeout: this.timeoutMs, signal: opts?.signal });
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout || "").trim();
      throw new C2cError(`c2c ${args[0] ?? ""} failed (exit ${res.code}): ${detail}`, res.code, res.stderr);
    }
    return res;
  }

  private withSession(args: string[]): string[] {
    return this.sessionId ? [...args, "--session-id", this.sessionId] : args;
  }

  async whoami(): Promise<C2cWhoami | null> {
    // `whoami` resolves identity from the C2C_MCP_SESSION_ID env var; it does
    // NOT accept --session-id (the CLI rejects it with exit 124).
    const res = await this.run(["whoami", "--json"]);
    return parseWhoami(res.stdout);
  }

  async list(): Promise<C2cPeer[]> {
    const res = await this.run(["list", "--json"]);
    return parsePeers(res.stdout);
  }

  /** Register `alias` against `sessionId`, then scope this client to it. */
  async register(alias: string, sessionId: string): Promise<C2cWhoami | null> {
    const res = await this.run(["register", "--alias", alias, "--session-id", sessionId, "--json"]);
    this.sessionId = sessionId;
    return parseWhoami(res.stdout);
  }

  /** Drain (or peek) the inbox for the configured session. */
  async pollInbox(opts?: { peek?: boolean; signal?: AbortSignal }): Promise<C2cMessage[]> {
    const args = this.withSession(["poll-inbox", "--json"]);
    if (opts?.peek) args.push("--peek");
    const res = await this.run(args, { signal: opts?.signal });
    return parseMessages(res.stdout);
  }

  /** Send a DM to `target`. `from` overrides the sender alias when set
   * (normally identity is resolved from the C2C_MCP_SESSION_ID env). The `--`
   * separator guards against a target/body beginning with `-`. */
  async send(target: string, body: string, opts?: { from?: string }): Promise<void> {
    const args = ["send"];
    if (opts?.from) args.push("--from", opts.from);
    args.push("--", target, body);
    await this.run(args);
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
}
