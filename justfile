# pi-c2c — common tasks
# (repo norm: a justfile manages common scripts)

# Run all tests (unit + integration). Integration tests self-skip when the
# `c2c` binary is not on PATH, so this is safe to run anywhere.
test:
    pnpm test

# Typecheck only (no emit).
check:
    pnpm check

# Run ONLY the real-binary integration tests (requires `c2c` on PATH).
test-integration:
    node --import tsx --test tests/integration.test.ts

# Full CI gate: typecheck + all tests.
ci: check test

# Install deps.
install:
    pnpm install
