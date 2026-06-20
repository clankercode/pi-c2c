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

# Cut a release: gate, bump package.json, commit, tag, and push.
# Pushing the vX.Y.Z tag triggers .github/workflows/release.yml, which
# re-runs the gate, publishes to npm (OIDC trusted publishing), and creates
# the GitHub Release. VERSION is an explicit semver (e.g. 0.3.0) or an
# increment npm understands (patch | minor | major).
release VERSION:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "working tree is not clean — commit or stash first" >&2
        exit 1
    fi
    branch="$(git rev-parse --abbrev-ref HEAD)"
    if [ "$branch" != "master" ]; then
        echo "releases are cut from master, not '$branch'" >&2
        exit 1
    fi
    just ci
    tag="$(npm version "{{VERSION}}" -m "chore: release %s")"
    git push origin master
    git push origin "$tag"
    echo "Pushed $tag — CI will publish to npm and create the GitHub Release."
