import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";

export type C2cNpmResolver = (opts?: {
  executable?: "c2c";
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}) => string;

export interface ResolveC2cCommandOptions {
  /** Explicit constructor override. Highest priority. */
  explicitBin?: string;
  /** Environment to inspect; defaults to process.env. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Test hook for PATH executable checks. */
  pathExists?: (file: string) => boolean;
  /** Test hook / override for @clanker-code/c2c resolution. */
  npmResolver?: C2cNpmResolver | null;
  /** Platform override for tests. */
  platform?: NodeJS.Platform;
}

const require = createRequire(import.meta.url);

function canExecute(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === "win32"
    ? ["c2c.exe", "c2c.cmd", "c2c.bat", "c2c"]
    : ["c2c"];
}

function isNodeModulesBin(candidate: string): boolean {
  return candidate.split(/[\\/]+/).slice(-3, -1).join("/") === "node_modules/.bin";
}

function findOnPath(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  pathExists: (file: string) => boolean,
  platform: NodeJS.Platform,
): string | null {
  const pathValue = env.PATH ?? "";
  if (!pathValue) return null;

  for (const dir of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of executableNames(platform)) {
      const candidate = join(dir, name);
      // The @clanker-code/c2c package exposes a JS shim in node_modules/.bin.
      // That shim is fine for humans, but c2c registration records process
      // liveness from the native process context; the short-lived Node shim can
      // make freshly registered peers look dead. Skip shims and prefer either a
      // system native binary or the package resolver's native platform binary.
      if (!isNodeModulesBin(candidate) && pathExists(candidate)) return candidate;
    }
  }
  return null;
}

function loadBundledResolver(): C2cNpmResolver | null {
  try {
    const mod = require("@clanker-code/c2c") as { resolveC2cBinary?: unknown };
    return typeof mod.resolveC2cBinary === "function"
      ? (mod.resolveC2cBinary as C2cNpmResolver)
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the c2c command for pi-c2c.
 *
 * Priority deliberately preserves existing local-development behavior:
 * explicit constructor bin -> C2C_BIN -> system PATH c2c -> bundled npm
 * package -> literal "c2c" fallback for an actionable exec error.
 */
export function resolveC2cCommand(opts: ResolveC2cCommandOptions = {}): string {
  const explicit = opts.explicitBin?.trim();
  if (explicit) return explicit;

  const env = opts.env ?? process.env;
  const envBin = env.C2C_BIN?.trim();
  if (envBin) return envBin;

  const pathHit = findOnPath(
    env,
    opts.pathExists ?? canExecute,
    opts.platform ?? process.platform,
  );
  if (pathHit) return pathHit;

  const resolver = opts.npmResolver === undefined
    ? loadBundledResolver()
    : opts.npmResolver;
  if (resolver) {
    try {
      return resolver({ executable: "c2c", env });
    } catch {
      // Fall through to the literal command so pi.exec surfaces the same
      // style of actionable missing-binary error as older pi-c2c versions.
    }
  }

  return "c2c";
}
