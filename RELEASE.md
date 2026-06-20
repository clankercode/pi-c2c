# Release process

Releases are automated by CI. Pushing a `vX.Y.Z` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which:

1. re-runs the full gate (`pnpm check` + `pnpm test`);
2. verifies the tag matches `package.json`'s `version`;
3. publishes to npm via **OIDC trusted publishing** (no `NPM_TOKEN` secret;
   build provenance is attached automatically);
4. creates a GitHub Release with auto-generated notes.

Every push to `master` and every PR also runs the gate via
[`.github/workflows/ci.yml`](.github/workflows/ci.yml).

## Cutting a release

From a clean `master`:

```bash
just release 0.3.0      # explicit version
# or: just release patch | minor | major
```

`just release` bumps `package.json`, commits `chore: release X.Y.Z`, tags
`vX.Y.Z`, and pushes both the commit and the tag. CI does the rest — watch it
at the repo's **Actions** tab.

Equivalent by hand:

```bash
just ci
npm version 0.3.0 -m "chore: release %s"   # bump + commit + tag
git push origin master
git push origin v0.3.0                      # the tag push is what publishes
```

## One-time setup: npm trusted publisher

Trusted publishing must be configured once on npm so the registry trusts this
repo's release workflow (no token needed):

1. Open <https://www.npmjs.com/package/pi-c2c/access> (Settings → Trusted
   Publishing).
2. Add a **GitHub Actions** publisher:
   - Organization/user: `clankercode`
   - Repository: `pi-c2c`
   - Workflow filename: `release.yml`
   - Environment: *(leave blank)*

After that, the next `vX.Y.Z` tag publishes automatically.

## Notes

- The tag name must equal the `package.json` version (`v0.3.0` ↔ `0.3.0`); CI
  fails the release if they disagree.
- This is a source-only package (`files: ["src", ...]`) — there is no build
  step; `npm publish` ships the TypeScript sources that pi runs via `tsx`.
- If a publish fails because the version already exists on npm, bump to a new
  version and tag again.
