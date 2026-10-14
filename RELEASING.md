# Releasing

Releases are published from GitHub Actions (`.github/workflows/release.yml`) when a `v*` tag is
pushed. They use npm **trusted publishing**: the workflow proves its identity to npm with a
short-lived OIDC token, so no npm token is stored anywhere, and every release carries a
[provenance](https://docs.npmjs.com/generating-provenance-statements) attestation linking it
to this repository and commit.

`npm publish` always runs `prepublishOnly` first: typecheck, tests, the long fuzz pass (200k
cases per property), build, runtime smoke tests and package lint. So nothing broken can be
published.

## Each release

1. Update `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`) and add a
   `## <version>` section to `CHANGELOG.md`.
2. Check locally:
   ```bash
   npm run build && npm run release:check
   ```
3. Commit and push, then tag and push the tag:
   ```bash
   git tag -a v0.1.1 -m v0.1.1
   git push origin v0.1.1
   ```
4. The release job runs in the `npm` environment, which has required reviewers: approve it
   under *Review deployments* on the workflow run. It then builds, runs `release:check` (which
   also verifies the tag matches the version), and publishes.

To check a published release: `npm audit signatures` in a project that installs it should report
a verified attestation.

## How it's set up

- **npmjs.com**, in the package settings: a trusted publisher for GitHub Actions with repository
  `NightFighter989/fast-json5`, workflow `release.yml` and environment `npm`.
- **GitHub**, in the repository settings: an environment named `npm` with required reviewers.
  No secrets are needed.
- The workflow has `id-token: write` permission and makes sure npm is at least 11.5.1, the first
  version that supports trusted publishing.

0.1.0 was published with a temporary token, because npm only allows trusted publishing for
packages that already exist. Once a release has gone out through trusted publishing, delete the
`NPM_TOKEN` secret from the `npm` environment and revoke that token on npmjs.com.

Publishing by hand (`npm login`, then `npm publish --access public`) still works as a fallback,
but the result has no provenance.
