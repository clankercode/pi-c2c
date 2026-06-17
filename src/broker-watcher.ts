/**
 * BrokerWatcher — file-system based push for the c2c local broker.
 *
 * Watches the broker root directory for changes to `<session_id>.inbox.json`
 * via Node's `fs.watch` (which uses inotify on Linux, FSEvents on macOS,
 * ReadDirectoryChangesW on Windows). When the file is created or modified,
 * fires the onChange callback which the extension uses to trigger an
 * immediate `pollTick` drain.
 *
 * Why watch the *directory* instead of the file directly?
 *   - `fs.watch` on a non-existent file throws ENOENT synchronously. The
 *     broker inbox file may not exist yet when the extension starts (the
 *     broker creates it on first registration). Watching the directory
 *     lets us catch the `rename` event when the file appears.
 *   - Atomic-write patterns (e.g. `mktemp` + `rename`) replace the file
 *     rather than modifying in place. fs.watch on the directory sees the
 *     `rename` event; fs.watch on the file would see the replacement and
 *     get confused.
 *   - The directory exists for the lifetime of the broker; the file
 *     may come and go. Watching the directory is the stable primitive.
 *
 * The watcher is a *trigger*, not a drainer. It does not parse messages
 * or maintain a queue — `pollTick` does that, with its existing dedup
 * and inject pipeline. This keeps the watcher's surface small.
 *
 * See: .collab/design/2026-06-17T04-14-27Z-pi-c01ea5-push-delivery-design.md
 * (slice 1) for the full design rationale.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Callback fired when the inbox file changes. */
export type OnChange = () => void;

export interface BrokerWatcherOptions {
  /** Absolute path to the broker root (the dir containing `<session_id>.inbox.json`). */
  brokerRoot: string;
  /** The session id whose inbox to watch. */
  sessionId: string;
  /** Called on file change. Should be non-blocking. */
  onChange: OnChange;
  /**
   * Debounce window in ms. Burst events within this window collapse to one
   * onChange call. Default 50ms — long enough to coalesce fs.watch burst,
   * short enough that the user doesn't notice.
   */
  debounceMs?: number;
  /**
   * Filename suffix that identifies the inbox file. Defaults to
   * `<sessionId>.inbox.json`. Exposed for testing.
   * @internal
   */
  filename?: string;
}

export class BrokerWatcher {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly debounceMs: number;
  private readonly filename: string;

  constructor(private readonly opts: BrokerWatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 50;
    this.filename = opts.filename ?? `${opts.sessionId}.inbox.json`;
  }

  /** Path to the inbox file this watcher monitors. */
  get inboxPath(): string {
    return path.join(this.opts.brokerRoot, this.filename);
  }

  /** True if the watcher is currently active. */
  get isRunning(): boolean {
    return this.watcher !== null && !this.stopped;
  }

  /**
   * Start watching. Resolves once the watcher is attached. Safe to call
   * when the broker dir doesn't exist yet — the watcher is a no-op in
   * that case (no fs.watch handle to leak). The safety-net `pollTick`
   * is what catches messages in that window.
   *
   * The watcher monitors the *directory* and filters for our specific
   * file. This avoids the ENOENT that fs.watch on a non-existent file
   * throws, and it survives atomic-rename write patterns.
   */
  start(): void {
    if (this.stopped) {
      throw new Error("BrokerWatcher: cannot start a stopped watcher");
    }
    if (this.watcher) return; // idempotent

    // If the broker dir doesn't exist yet, no-op. Caller (session_start)
    // will retry on the next session.
    if (!fs.existsSync(this.opts.brokerRoot)) return;

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(
        this.opts.brokerRoot,
        { persistent: true },
        (eventType, changedFilename) => {
          // Fire on events that could be our inbox. The c2c binary uses
          // an atomic-rename write pattern (write to .tmp.<pid>, then
          // rename to the final name), so the rename event may report
          // either the .tmp filename or the final filename. Accept both.
          // Ignore events for unrelated files (registry, broker.log, etc.).
          if (eventType !== "change" && eventType !== "rename") return;
          if (changedFilename) {
            const isOurFile = changedFilename === this.filename;
            const isOurTemp = changedFilename.startsWith(`${this.filename}.tmp.`) ||
              changedFilename === `${this.filename}.tmp`;
            if (!isOurFile && !isOurTemp) return;
          }
          this.scheduleFire();
        },
      );
    } catch {
      // fs.watch can throw if the dir disappears between the existsSync
      // check and the watch call. Silently no-op; the next session_start
      // will retry.
      return;
    }

    this.watcher = watcher;

    // Tolerate 'error' events (e.g. dir removed mid-watch). Drop the
    // watcher handle so isRunning() returns false; the next start()
    // will re-attach.
    this.watcher.on("error", () => {
      if (this.watcher) {
        try {
          this.watcher.close();
        } catch {
          // best-effort
        }
        this.watcher = null;
      }
    });
  }

  /** Stop watching and release the fs.watch handle. */
  stop(): void {
    this.stopped = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private scheduleFire(): void {
    if (this.debounceTimer) return; // already scheduled
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.stopped) return;
      try {
        this.opts.onChange();
      } catch {
        // Swallow — caller is responsible for its own error handling.
      }
    }, this.debounceMs);
  }
}

/**
 * Start a BrokerWatcher for the per-repo broker inbox. Returns the watcher
 * (so the caller can stop it on shutdown) or `null` if the broker root
 * doesn't exist (broker not yet registered — no-op until the dir appears).
 */
export function startPerRepoWatcher(
  brokerRoot: string,
  sessionId: string,
  onChange: OnChange,
  debounceMs?: number,
): BrokerWatcher | null {
  const w = new BrokerWatcher({ brokerRoot, sessionId, onChange, debounceMs });
  w.start();
  return w;
}

/** Same as startPerRepoWatcher but for the sessions broker (cross-repo). */
export function startSessionsWatcher(
  sessionsBrokerRoot: string,
  sessionId: string,
  onChange: OnChange,
  debounceMs?: number,
): BrokerWatcher | null {
  return startPerRepoWatcher(sessionsBrokerRoot, sessionId, onChange, debounceMs);
}
