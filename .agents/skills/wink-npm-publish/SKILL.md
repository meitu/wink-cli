---
name: wink-npm-publish
description: Prepare, dry-run, or publish this repository's meitu-wink-cli package to npm. Use for Wink CLI npm release requests; do not use for installing the CLI or publishing other packages.
---

# Publish Wink CLI to npm

Work in the repository root. The Git package is `wink-cli` with `private: true`; the public npm package is `meitu-wink-cli`. Keep that distinction. Never run `npm publish` against the repository root or change its package name to publish. Use `scripts/publish_npm.js` through `npm run publish:npm`.

1. Read `package.json`, `package-lock.json`, `git status --short`, and the relevant release diff. Confirm the two version fields match and that the proposed contents are intentional. If the user requests a version bump, update the version and release-facing install examples before building. Do not silently include unrelated working-tree changes.
2. Query `meitu-wink-cli@<version>` at `https://registry.npmjs.org/`. If it already exists, stop: npm versions cannot be republished. If the lookup fails, diagnose the registry connection before assuming the version is free.
3. Run `npm ci` when dependencies are absent or out of sync. Run `npm run publish:npm -- --dry-run`. This runs the tests, builds `dist/meitu-wink-cli-<version>.tgz`, and checks npm's publish command without uploading. Inspect the reported package name, version, and tarball. Keep the root `package.json` private and named `wink-cli`.
4. Run the real publish only when the user has explicitly authorized publishing this version. Use `npm run publish:npm -- --yes --skip-tests --skip-pack` only if the dry-run just passed and neither the version nor release files changed afterward; otherwise use `npm run publish:npm -- --yes` to rebuild and retest. The script uses the caller's npm authentication. Never read, print, or copy npm tokens or `.npmrc` contents. Allow an interactive npm browser or 2FA prompt to complete.
5. After the publish command succeeds, treat the version as submitted even if `npm view` or `npx` temporarily returns `ETARGET`. Recheck the registry with `npm view meitu-wink-cli@<version> version --registry=https://registry.npmjs.org/ --prefer-online`; wait and retry lookup if npm says the package is still processing. Do not republish the same version to fix indexing delay.

Report the version, test and dry-run results, actual publication status, registry verification, and any remaining local Git changes. Creating or invoking this Skill alone does not authorize a live publish. Commit and push only when the user requests them; if requested, push the commit to the current branch.
