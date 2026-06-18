/**
 * Scoped environment-variable mutation helper for tests.
 *
 * Use this when a test needs to flip `process.env` (e.g. `PI_C2C_ASCII=1`)
 * and restore the prior state on the way out — even if the body throws.
 *
 * Discipline: tests that mutate env via this helper must NOT run in parallel
 * with other env-touching tests. Group them in their own `describe`/`test`
 * block with no siblings that share the same env key.
 *
 * @example
 *   const result = withEnv("PI_C2C_ASCII", "1", () => buildCompactLine(...));
 */
export function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}