# Release process

This project currently uses a manual release flow. We’ll replace this with CI-based releases later.

## Current steps

1. Ensure `master` is green:
   ```bash
   just ci
   ```
2. Bump `package.json` version.
3. Sanity-check the package:
   ```bash
   npm publish --dry-run
   ```
4. Commit the release bump:
   ```bash
   git commit -am "chore: release X.Y.Z"
   ```
5. Tag the release:
   ```bash
   git tag vX.Y.Z
   ```
6. Merge to `master` and push:
   ```bash
   git push origin master --tags
   ```
7. Publish the package:
   ```bash
   npm publish
   ```

## Notes

- `npm publish` requires a logged-in npm session.
- Keep the tag name aligned with the package version.
- If the publish step fails because the version already exists, bump the version and try again.
